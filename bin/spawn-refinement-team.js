#!/usr/bin/env node
/**
 * spawn-refinement-team.js — Parallel analyst spawner for PRD refinement.
 *
 * Spawns three analyst agents (requirements, codebase, risk-scope) per cycle,
 * manages cross-referencing, failure escalation, and produces a manifest.
 * ESM module.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseAutoDump } from '../lib/token-parser.js';

export const WORKER_ROLES = ['requirements', 'codebase', 'risk-scope'];
export const DEFAULT_CYCLES = 3;
export const ROLE_AGENTS = {
  requirements: 'analyst-requirements',
  codebase: 'analyst-codebase',
  'risk-scope': 'analyst-risk-scope',
};

const CRITICAL_ROLES = new Set(['requirements', 'codebase']);

function countFindings(content) {
  const p0 = (content.match(/\[P0\]/g) || []).length;
  const p1 = (content.match(/\[P1\]/g) || []).length;
  const p2 = (content.match(/\[P2\]/g) || []).length;
  return { p0, p1, p2 };
}

function readAgentModel(agentDir, agentName) {
  try {
    const filePath = path.join(agentDir, `${agentName}.md`);
    const content = fs.readFileSync(filePath, 'utf-8');
    const match = content.match(/^model:\s*(.+)$/m);
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

function spawnWorker(deps, role, cycle, prompt) {
  const { spawn, refinementDir, workerTimeoutMs = 300000, killEscalationMs = 30000, agentDir } = deps;

  return new Promise((resolve) => {
    const agentName = ROLE_AGENTS[role];
    const args = ['-p', prompt, '--agent', agentName];
    const child = spawn('forge', args, {});

    let stderrBuf = '';
    let resolved = false;
    let termTimer;
    let killTimer;

    const finish = (result) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(termTimer);
      clearTimeout(killTimer);
      resolve(result);
    };

    termTimer = setTimeout(() => {
      child.kill('SIGTERM');
      killTimer = setTimeout(() => {
        child.kill('SIGKILL');
      }, killEscalationMs);
    }, workerTimeoutMs);

    child.stderr?.on('data', (data) => {
      stderrBuf += data.toString();
    });

    child.on('exit', (code) => {
      clearTimeout(termTimer);
      clearTimeout(killTimer);

      const analysisPath = path.join(refinementDir, `analysis_${role}.md`);
      const dumpPath = path.join(refinementDir, `worker_${role}_c${cycle}_dump.json`);

      let success = code === 0;
      let tokenFound = false;
      let findingsSummary = { p0: 0, p1: 0, p2: 0 };

      if (success) {
        const dumpResult = parseAutoDump(dumpPath);
        tokenFound = dumpResult.tokens.includes('ANALYSIS_DONE');
        success = tokenFound;
      }

      if (fs.existsSync(analysisPath)) {
        const content = fs.readFileSync(analysisPath, 'utf-8');
        findingsSummary = countFindings(content);
      }

      // Write worker log
      const logPath = path.join(refinementDir, `worker_${role}_c${cycle}.log`);
      fs.writeFileSync(logPath, stderrBuf || `[${role}] cycle ${cycle} exit=${code}\n`);

      const model = readAgentModel(agentDir, agentName);

      finish({
        role,
        success,
        token_found: tokenFound,
        agent: agentName,
        model,
        output_file: `analysis_${role}.md`,
        log_file: `worker_${role}_c${cycle}.log`,
        cycle,
        findings_summary: findingsSummary,
      });
    });
  });
}

export async function spawnRefinementTeam(deps) {
  const {
    prdPath,
    refinementDir,
    cycles: requestedCycles,
  } = deps;

  const cycles = requestedCycles ?? DEFAULT_CYCLES;
  const prdContent = fs.readFileSync(prdPath, 'utf-8');
  fs.mkdirSync(refinementDir, { recursive: true });

  let cyclesCompleted = 0;
  let earlyExit = false;
  let exitReason = null;
  let latestWorkers = [];

  for (let cycle = 1; cycle <= cycles; cycle++) {
    let prompt = `Cycle ${cycle}\n\n${prdContent}`;

    if (cycle > 1) {
      const files = fs.readdirSync(refinementDir)
        .filter(f => f.startsWith('analysis_') && f.endsWith('.md'))
        .sort();
      for (const f of files) {
        const content = fs.readFileSync(path.join(refinementDir, f), 'utf-8');
        prompt += `\n\n--- Prior analysis: ${f} ---\n${content}`;
      }
    }

    const results = await Promise.all(
      WORKER_ROLES.map(role => spawnWorker(deps, role, cycle, prompt)),
    );

    cyclesCompleted = cycle;
    latestWorkers = results;

    // Archive analysis files
    for (const w of results) {
      const src = path.join(refinementDir, `analysis_${w.role}.md`);
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, path.join(refinementDir, `analysis_${w.role}_c${cycle}.md`));
      }
    }

    // Check critical failures
    const criticalFailed = results.some(r => !r.success && CRITICAL_ROLES.has(r.role));
    if (criticalFailed) break;

    // Early exit on zero P0+P1
    const totalP0P1 = results.reduce((s, r) => s + r.findings_summary.p0 + r.findings_summary.p1, 0);
    if (totalP0P1 === 0) {
      earlyExit = true;
      exitReason = 'zero_findings';
      break;
    }
  }

  const allSuccess = latestWorkers.every(w => w.success || !CRITICAL_ROLES.has(w.role));

  const manifest = {
    prd_path: prdPath,
    cycles_requested: cycles,
    cycles_completed: cyclesCompleted,
    workers: latestWorkers,
    all_success: allSuccess,
    early_exit: earlyExit,
    exit_reason: exitReason,
    completed_at: new Date().toISOString(),
  };

  fs.writeFileSync(
    path.join(refinementDir, 'refinement_manifest.json'),
    JSON.stringify(manifest, null, 2),
  );

  return {
    manifest,
    workers: latestWorkers,
    cycles_completed: cyclesCompleted,
    all_success: allSuccess,
    early_exit: earlyExit,
    exit_reason: exitReason,
  };
}
