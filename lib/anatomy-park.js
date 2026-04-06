import fs from 'node:fs';
import path from 'node:path';

const SOURCE_EXTENSIONS = new Set(['.js', '.ts', '.mjs', '.cjs', '.jsx', '.tsx']);
const EXCLUDED_DIRS = new Set(['node_modules', 'dist']);

export function isSubsystemConverged(sub) {
  return sub.consecutive_clean >= 2;
}

export function isSubsystemStalled(sub, limit) {
  return sub.stall_count >= limit;
}

export function isFullyConverged(state) {
  return state.subsystems.every(
    s => isSubsystemConverged(s) || isSubsystemStalled(s, state.stall_limit),
  );
}

export function discoverSubsystems(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const results = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (EXCLUDED_DIRS.has(entry.name)) continue;
    const subPath = path.join(dir, entry.name);
    const files = fs.readdirSync(subPath);
    const sourceCount = files.filter(f => SOURCE_EXTENSIONS.has(path.extname(f))).length;
    if (sourceCount >= 3) {
      results.push({
        name: entry.name,
        pass_count: 0,
        consecutive_clean: 0,
        stall_count: 0,
      });
    }
  }
  return results;
}

export function flushTrapDoors(agentsMdPath, trapDoors) {
  let content = fs.readFileSync(agentsMdPath, 'utf-8');
  const sectionRe = /## Trap Doors\n[\s\S]*/;
  const newSection = '## Trap Doors\n' + trapDoors.map(t => `- ${t}`).join('\n') + '\n';
  if (sectionRe.test(content)) {
    content = content.replace(sectionRe, newSection);
  } else {
    content += '\n' + newSection;
  }
  fs.writeFileSync(agentsMdPath, content);
}

export function rollbackPhase3({ git, preSha }) {
  git.stash();
  git.resetToSha(preSha);
}

export function loadState(dir) {
  const filePath = path.join(dir, 'anatomy-park.json');
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

export function saveState(dir, state) {
  const filePath = path.join(dir, 'anatomy-park.json');
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2));
}

export async function runAnatomyPark({ state, forge, git, targetDir, maxIterations }) {
  if (isFullyConverged(state)) {
    state.status = 'converged';
    git.autoCommit('anatomy-park: convergence checkpoint');
    return;
  }

  for (let i = 0; i < maxIterations; i++) {
    const active = selectNextActive(state);
    if (!active) {
      state.status = 'converged';
      git.autoCommit('anatomy-park: convergence checkpoint');
      return;
    }

    const tracerResult = await forge.runAgent('anatomy-tracer', {
      subsystem: active.name,
      targetDir,
    });

    if (!tracerResult.findings || tracerResult.findings.length === 0) {
      active.consecutive_clean++;
      state.rotation_index = (state.rotation_index + 1) % state.subsystems.length;
      if (isFullyConverged(state)) {
        state.status = 'converged';
        git.autoCommit('anatomy-park: convergence checkpoint');
        return;
      }
      continue;
    }

    const preSha = git.getCurrentSha();

    await forge.runAgent('anatomy-surgeon', {
      subsystem: active.name,
      targetDir,
      findings: tracerResult.findings,
    });

    const verifierResult = await forge.runAgent('anatomy-verifier', {
      subsystem: active.name,
      targetDir,
    });

    if (verifierResult.result === 'FAIL') {
      rollbackPhase3({ git, preSha });
      active.stall_count++;
    } else {
      active.pass_count++;
      active.consecutive_clean = 0;
      state.rotation_index = (state.rotation_index + 1) % state.subsystems.length;
    }

    if (isFullyConverged(state)) {
      state.status = 'converged';
      git.autoCommit('anatomy-park: convergence checkpoint');
      return;
    }
  }
}

function selectNextActive(state) {
  const { subsystems, stall_limit } = state;
  const len = subsystems.length;
  for (let i = 0; i < len; i++) {
    const idx = (state.rotation_index + i) % len;
    const sub = subsystems[idx];
    if (!isSubsystemConverged(sub) && !isSubsystemStalled(sub, stall_limit)) {
      state.rotation_index = idx;
      return sub;
    }
  }
  return null;
}
