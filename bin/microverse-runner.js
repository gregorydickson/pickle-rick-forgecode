#!/usr/bin/env node
/**
 * microverse-runner — Metric-driven convergence loop orchestrator.
 *
 * Loop: gap_analysis → baseline → iterate (handoff → spawn → measure →
 * compare → rollback/keep → update → convergence check).
 *
 * ESM module, zero external deps.
 */
import { spawn as defaultSpawn, execSync as defaultExecSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Agent definitions
// ---------------------------------------------------------------------------
export const AGENT_DEFS = [
  { id: 'microverse-worker', model: 'sonnet', tools: ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob'] },
  { id: 'microverse-analyst', model: 'sonnet', tools: ['Read', 'Grep', 'Glob', 'Bash'] },
  { id: 'szechuan-reviewer', model: 'sonnet', tools: ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob'] },
  { id: 'microverse-judge', model: 'haiku', tools: ['Read', 'Grep', 'Glob'] },
];

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export function isConverged(state) {
  if (state.exit_reason) return true;
  const c = state.convergence || {};
  return (c.stall_counter || 0) >= (c.stall_limit || Infinity);
}

export function writeHandoffContent(filePath, state, opts = {}) {
  const c = state.convergence || {};
  const history = c.history || [];
  const lines = [
    `# Microverse Handoff`,
    ``,
    `**Iteration:** ${state.iteration ?? 'N/A'}`,
    `**Baseline:** ${state.baseline_score ?? 'N/A'}`,
    `**Target:** ${state.convergence_target ?? 'N/A'}`,
    `**Stall:** ${c.stall_counter ?? 0} / ${c.stall_limit ?? 'N/A'}`,
    ``,
    `## Metric`,
    `${state.key_metric?.description || 'N/A'}`,
    ``,
    `## History`,
    ...history.map((v, i) => `- ${i}: ${v}`),
    ``,
    `## Failed Approaches`,
    ...(state.failed_approaches || []).map(f => `- ${f}`),
  ];
  if (opts.diffFiles && opts.diffFiles.length > 0) {
    lines.push(``, `## Diff Scope`, ...opts.diffFiles.map(f => `- ${f}`));
  }
  fs.writeFileSync(filePath, lines.join('\n'));
}

export function preflight({ workingDir, deps }) {
  const exec = deps?.execSync || defaultExecSync;
  const status = exec('git status --porcelain', { cwd: workingDir });
  const output = Buffer.isBuffer(status) ? status.toString() : String(status);
  if (output.trim().length > 0) {
    exec('git add -A', { cwd: workingDir });
    exec('git commit -m "microverse: auto-commit dirty tree"', { cwd: workingDir });
  }
}

export function measureMetric(metric, deps) {
  const exec = deps?.execSync || defaultExecSync;
  if (!metric || !metric.validation) return 0;
  const result = exec(metric.validation);
  const output = Buffer.isBuffer(result) ? result.toString() : String(result);
  const num = parseFloat(output.trim());
  return Number.isFinite(num) ? num : 0;
}

export function getDiffFiles(startSha, deps) {
  const exec = deps?.execSync || defaultExecSync;
  let sha = startSha;
  if (!sha) {
    process.stderr.write('Warning: missing start_sha, falling back to HEAD~1\n');
    sha = 'HEAD~1';
  }
  const result = exec(`git diff --name-only ${sha}...HEAD`);
  const output = Buffer.isBuffer(result) ? result.toString() : String(result);
  return output.trim().split('\n').filter(Boolean);
}

export function measureLlmMetric(metric, deps) {
  const exec = deps?.execSync || defaultExecSync;
  if (!metric || metric.type !== 'llm') return 0;

  for (let attempt = 0; attempt < 2; attempt++) {
    const result = exec(metric.validation);
    const output = Buffer.isBuffer(result) ? result.toString() : String(result);
    const lines = output.trim().split('\n');
    const lastLine = lines[lines.length - 1];
    const num = parseFloat(lastLine);
    if (Number.isFinite(num)) return num;
    if (attempt === 0) {
      process.stderr.write('Warning: LLM judge returned non-numeric output, retrying\n');
    }
  }
  process.stderr.write('Warning: LLM judge failed after 2 attempts, skipping measurement\n');
  return null;
}

export function compareAndRollback(current, previous, preSha, deps) {
  if (current < previous) {
    const exec = deps?.execSync || defaultExecSync;
    exec(`git reset --hard ${preSha}`);
    return { rolled_back: true, reason: 'regression' };
  }
  return { rolled_back: false };
}

export function spawnWorker(agentId, sessionDir, deps) {
  const spawnFn = deps?.spawn || defaultSpawn;
  const child = spawnFn('forge', '-p', agentId, {
    cwd: sessionDir,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return child;
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------
export async function runMicroverse({ sessionDir, deps, maxIterations }) {
  const state = deps.state;
  const sm = deps.stateManager;
  const spawnFn = deps.spawn || defaultSpawn;
  const exec = deps.execSync || defaultExecSync;
  const measure = deps.measureMetric || ((metric) => measureMetric(metric, deps));
  const timeoutMs = deps.timeoutMs ?? 10 * 60 * 1000;
  const maxIter = maxIterations ?? state.max_iterations ?? 10;

  let shuttingDown = false;

  const sigHandler = () => {
    shuttingDown = true;
    sm.forceWrite();
  };
  process.on('SIGTERM', sigHandler);

  try {
    // Gap analysis phase — spawn analyst first
    if (state.status === 'gap_analysis') {
      const analystDef = AGENT_DEFS.find(a => a.id === 'microverse-analyst');
      const child = spawnFn('forge', '-p', analystDef.id, {
        cwd: sessionDir,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      await waitForChild(child, timeoutMs);
      sm.update(null, (s) => { s.status = 'running'; });
    }

    // Capture pre-SHA
    let preSha;
    try {
      const result = exec('git rev-parse HEAD');
      preSha = (Buffer.isBuffer(result) ? result.toString() : String(result)).trim();
    } catch { preSha = null; }

    let bestScore = state.baseline_score ?? 0;

    // Main iteration loop
    for (let i = 0; i < maxIter; i++) {
      if (shuttingDown) break;

      // Check worker-managed convergence
      if (state.convergence_mode === 'worker' && state.convergence_file) {
        try {
          const raw = fs.readFileSync(state.convergence_file, 'utf-8');
          const data = JSON.parse(raw);
          if (data.converged) {
            sm.update(null, (s) => { s.exit_reason = 'worker_converged'; });
            break;
          }
        } catch { /* file not ready yet */ }
      }

      const isSzechuan = state.convergence_mode === 'szechuan';
      const direction = state.key_metric?.direction || 'higher';

      // Write handoff (with diff-scope for szechuan)
      const handoffPath = path.join(sessionDir, 'handoff.txt');
      const handoffOpts = {};
      if (isSzechuan) {
        handoffOpts.diffFiles = getDiffFiles(state.start_sha, { execSync: exec });
      }
      writeHandoffContent(handoffPath, state, handoffOpts);

      // Spawn worker — szechuan uses szechuan-reviewer
      const workerId = isSzechuan ? 'szechuan-reviewer' : 'microverse-worker';
      const workerDef = AGENT_DEFS.find(a => a.id === workerId);
      const child = spawnFn('forge', '-p', workerDef.id, {
        cwd: sessionDir,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      await waitForChild(child, timeoutMs);

      if (shuttingDown) break;

      // Measure metric — szechuan uses LLM judge
      let score;
      if (isSzechuan && state.key_metric?.type === 'llm') {
        const measureLlm = deps.measureLlmMetric || ((m) => measureLlmMetric(m, { execSync: exec }));
        score = measureLlm(state.key_metric);
        if (score === null) continue; // LLM judge failed, skip iteration
      } else {
        score = measure(state.key_metric);
      }

      // Record in history
      const convergence = state.convergence || {};
      if (!convergence.history) convergence.history = [];
      convergence.history.push(score);
      state.convergence = convergence;

      // Compare and rollback — direction-aware
      const isRegression = direction === 'lower'
        ? score > bestScore
        : score < bestScore;

      if (isRegression) {
        // Regression — rollback
        if (preSha) {
          exec(`git reset --hard ${preSha}`);
        }
        // Record failed approach
        if (!state.failed_approaches) state.failed_approaches = [];
        state.failed_approaches.push(`iteration-${i}-score-${score}`);
        if (state.failed_approaches.length > 100) {
          state.failed_approaches = state.failed_approaches.slice(-100);
        }
        // Increment stall counter
        convergence.stall_counter = (convergence.stall_counter || 0) + 1;
      } else if (score === bestScore) {
        // Stall
        convergence.stall_counter = (convergence.stall_counter || 0) + 1;
      } else {
        // Improvement
        bestScore = score;
        convergence.stall_counter = 0;
        // Update pre-SHA to current
        try {
          const result = exec('git rev-parse HEAD');
          preSha = (Buffer.isBuffer(result) ? result.toString() : String(result)).trim();
        } catch { /* keep old preSha */ }
      }

      // Update state
      sm.update(null, (s) => { s.iteration = i + 1; });

      // Check convergence target — direction-aware
      const targetReached = direction === 'lower'
        ? (state.convergence_target != null && score <= state.convergence_target)
        : (state.convergence_target != null && score >= state.convergence_target);
      if (targetReached) {
        sm.update(null, (s) => { s.exit_reason = 'target_reached'; });
        break;
      }

      // Check stall convergence
      if (isConverged(state)) break;
    }

    // If we exhausted iterations without other exit reason, set max_iterations
    if (!state.exit_reason) {
      sm.update(null, (s) => { s.exit_reason = 'max_iterations'; });
    }
  } finally {
    process.removeListener('SIGTERM', sigHandler);
  }
}

// ---------------------------------------------------------------------------
// Wait for child process with timeout
// ---------------------------------------------------------------------------
function waitForChild(child, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;

    const timeoutTimer = setTimeout(() => {
      if (!done && !child.killed) {
        child.kill('SIGTERM');
        setTimeout(() => {
          if (!done && !child.killed) {
            child.kill('SIGKILL');
          }
        }, 2000);
      }
    }, timeoutMs);

    child.on('exit', () => {
      done = true;
      clearTimeout(timeoutTimer);
      resolve();
    });
  });
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------
if (process.argv[1]?.endsWith('microverse-runner.js')) {
  const sessionDir = process.argv[2];
  if (!sessionDir) {
    process.stderr.write('Usage: microverse-runner.js <session-dir>\n');
    process.exit(1);
  }
  runMicroverse({ sessionDir }).catch((err) => {
    process.stderr.write(`Fatal: ${err.message}\n`);
    process.exit(1);
  });
}
