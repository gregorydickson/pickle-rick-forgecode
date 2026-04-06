#!/usr/bin/env node
/**
 * tmux-runner — Core orchestration loop for ForgeCode.
 *
 * Main loop: read state → check gates → select agent → write handoff →
 * spawn forge -p → parse auto_dump → update state → next iteration.
 *
 * ESM module, zero external deps.
 */
import { spawn as defaultSpawn } from 'node:child_process';
import { StateManager } from '../lib/state-manager.js';
import { CircuitBreaker } from '../lib/circuit-breaker.js';
import { parseAutoDump as defaultParseAutoDump } from '../lib/token-parser.js';
import { getCurrentSha as defaultGetCurrentSha, isDirty as defaultIsDirty, getDiffStat as defaultGetDiffStat, createWorktree as defaultCreateWorktree, removeWorktree as defaultRemoveWorktree, cherryPick as defaultCherryPick } from '../lib/git-utils.js';
import { writeHandoff as defaultWriteHandoff } from '../lib/handoff.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
export const PHASE_AGENTS = {
  prd: 'pickle-manager',
  breakdown: 'pickle-manager',
  research: 'pickle-manager',
  plan: 'pickle-manager',
  implement: 'morty-worker',
  refactor: 'pickle-manager',
  review: 'pickle-manager',
};

export const DEFAULT_AGENT = 'pickle-manager';

export const DEFAULT_CONFIG = {
  workerTimeoutMs: 10 * 60 * 1000,
  killEscalationMs: 5000,
  hangGuardMs: 30000,
  rateLimitBackoffMs: 100,
};

const COMPLETION_TOKENS = ['I AM DONE', 'EPIC_COMPLETED', 'EXISTENCE_IS_PAIN', 'ANALYSIS_DONE'];

// ---------------------------------------------------------------------------
// Runner factory
// ---------------------------------------------------------------------------
export function createRunner(deps, configOverrides = {}) {
  const config = { ...DEFAULT_CONFIG, ...configOverrides };
  const {
    stateManager,
    circuitBreaker,
    spawn: spawnFn,
    parseAutoDump,
    writeHandoff,
    getCurrentSha,
    isDirty,
    getDiffStat,
    statePath,
    createWorktree: createWorktreeFn,
    removeWorktree: removeWorktreeFn,
    cherryPick: cherryPickFn,
  } = deps;

  let _shuttingDown = false;
  let _currentChild = null;

  function shutdown() {
    _shuttingDown = true;
    if (_currentChild && !_currentChild.killed) {
      _currentChild.kill('SIGTERM');
    }
    stateManager.update(statePath, (s) => { s.active = false; });
  }

  async function spawnWorker(state) {
    const phase = state.step || 'implement';
    const agentFile = PHASE_AGENTS[phase] || DEFAULT_AGENT;

    // Write handoff before spawn
    const sha = getCurrentSha();
    const doneTickets = (state.history || []).filter(h => h.status === 'done').map(h => h.ticket);
    const allTickets = state.tickets || [];
    const pendingTickets = allTickets.filter(t => !doneTickets.includes(t));
    const handoffContent = writeHandoff(state.session_dir || '/tmp', {
      iteration: state.iteration,
      step: phase,
      currentTicket: state.current_ticket,
      workingDir: state.working_dir,
      sessionRoot: state.session_dir,
      ticketsDone: doneTickets,
      ticketsPending: pendingTickets,
      startTime: state.start_time_epoch,
      sha,
    });

    // Spawn forge -p with agent
    const child = spawnFn('forge', ['-p', handoffContent, '--agent', agentFile, '-C', state.working_dir], {
      cwd: state.working_dir,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    _currentChild = child;

    return new Promise((resolve) => {
      let stderrData = '';
      let resolved = false;
      let hangGuardTimer = null;

      child.stderr.on('data', (chunk) => {
        stderrData += chunk.toString();
      });

      // Worker timeout: SIGTERM → SIGKILL escalation
      const timeoutTimer = setTimeout(() => {
        if (!child.killed) {
          child.kill('SIGTERM');

          // Escalate to SIGKILL after grace period
          setTimeout(() => {
            if (!child.killed) {
              child.kill('SIGKILL');
            }
            // Hang guard: if SIGKILL doesn't terminate, force-resolve
            hangGuardTimer = setTimeout(() => {
              if (!resolved) {
                resolved = true;
                _currentChild = null;
                resolve({ code: null, signal: 'SIGKILL', stderrData: stderrData + '\n[hang-guard] process did not exit after SIGKILL' });
              }
            }, config.hangGuardMs);
            hangGuardTimer.unref();
          }, config.killEscalationMs);
        }
      }, config.workerTimeoutMs);

      child.on('exit', (code, signal) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timeoutTimer);
        if (hangGuardTimer) clearTimeout(hangGuardTimer);
        _currentChild = null;
        resolve({ code, signal, stderrData });
      });
    });
  }

  async function run() {
    while (!_shuttingDown) {
      // Read current state
      const state = stateManager.read(statePath);

      // Gate: max iterations
      if (state.iteration >= state.max_iterations) break;

      // Gate: wall-clock time
      if (state.max_time_minutes && state.start_time_epoch) {
        const elapsed = Date.now() - state.start_time_epoch;
        if (elapsed > state.max_time_minutes * 60 * 1000) break;
      }

      // Gate: circuit breaker
      if (!circuitBreaker.canExecute()) break;

      // Spawn worker
      const result = await spawnWorker(state);

      if (_shuttingDown) {
        stateManager.update(statePath, (s) => { s.iteration = (s.iteration || 0) + 1; });
        break;
      }

      // Parse auto_dump for tokens
      const dumpPath = state.auto_dump_path || '/tmp/auto_dump.json';
      const { tokens } = parseAutoDump(dumpPath);

      // Check for completion tokens
      const hasCompletionToken = tokens.some(t => COMPLETION_TOKENS.includes(t));

      // Ticket double-check: token AND non-empty git diff
      if (hasCompletionToken) {
        const dirty = isDirty();
        const diffStat = getDiffStat();
        if (dirty && diffStat.length > 0) {
          stateManager.update(statePath, (s) => { s.iteration = (s.iteration || 0) + 1; });
          break;
        }
        // Token without diff — keep going
      }

      // Rate-limit detection
      const hasRateLimit = result.stderrData.includes('429');
      if (hasRateLimit) {
        await new Promise(r => setTimeout(r, config.rateLimitBackoffMs));
      }

      // Record iteration with circuit breaker
      const sha = getCurrentSha();
      circuitBreaker.recordIteration({
        headSha: sha,
        step: state.step,
        ticket: state.current_ticket,
        hasUncommittedChanges: isDirty(),
        hasStagedChanges: false,
        error: result.code !== 0 ? `exit code ${result.code}` : null,
      }, state.iteration || 0);

      const updated = stateManager.update(statePath, (s) => {
        s.iteration = (s.iteration || 0) + 1;
      });
      if (updated && updated.iteration >= state.max_iterations) break;
    }
  }

  async function spawnParallelWorkers(tickets, baseDir) {
    const workerPromises = tickets.map(async (ticket) => {
      const worktreePath = `${baseDir}/.worktree-${ticket}`;
      const branch = `worktree/${ticket}`;
      try {
        createWorktreeFn(worktreePath, branch);
        const child = spawnFn('forge', ['-p', `Parallel worker for ticket ${ticket}`, '--agent', PHASE_AGENTS.implement, '-C', worktreePath], {
          cwd: worktreePath,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        const result = await new Promise((resolve) => {
          let stderrData = '';
          let resolved = false;
          let hangGuardTimer = null;

          child.stderr.on('data', (chunk) => { stderrData += chunk.toString(); });

          // Timeout: SIGTERM → SIGKILL escalation (same pattern as serial worker)
          const timeoutTimer = setTimeout(() => {
            if (!child.killed) {
              child.kill('SIGTERM');
              setTimeout(() => {
                if (!child.killed) {
                  child.kill('SIGKILL');
                }
                hangGuardTimer = setTimeout(() => {
                  if (!resolved) {
                    resolved = true;
                    resolve({ ticket, code: null, signal: 'SIGKILL', stderrData: stderrData + '\n[hang-guard] process did not exit after SIGKILL', worktreePath });
                  }
                }, config.hangGuardMs);
                hangGuardTimer.unref();
              }, config.killEscalationMs);
            }
          }, config.workerTimeoutMs);

          child.on('exit', (code, signal) => {
            if (resolved) return;
            resolved = true;
            clearTimeout(timeoutTimer);
            if (hangGuardTimer) clearTimeout(hangGuardTimer);
            resolve({ ticket, code, signal, stderrData, worktreePath });
          });
        });
        // Bug 1 fix: read SHA from worktree, not main HEAD
        if (result.code === 0) {
          const sha = getCurrentSha({ cwd: worktreePath });
          cherryPickFn(sha);
        }
        return result;
      } finally {
        // Bug 4 fix: robust cleanup — don't let removeWorktree throw mask the result
        try {
          removeWorktreeFn(worktreePath);
        } catch {
          // Worktree cleanup failed — log but don't propagate
        }
      }
    });
    const settled = await Promise.allSettled(workerPromises);
    return settled.map(s =>
      s.status === 'fulfilled' ? s.value : { ticket: 'unknown', code: 1, error: s.reason?.message }
    );
  }

  return { run, shutdown, spawnParallelWorkers };
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------
async function main() {
  const statePath = process.argv[2];
  if (!statePath) {
    process.stderr.write('Usage: tmux-runner.js <state-path>\n');
    process.exit(1);
  }

  const sm = new StateManager();
  const cbPath = statePath.replace('state.json', 'circuit_breaker.json');
  const cb = new CircuitBreaker(cbPath, {}, sm);

  const runner = createRunner({
    stateManager: sm,
    circuitBreaker: cb,
    spawn: defaultSpawn,
    parseAutoDump: defaultParseAutoDump,
    writeHandoff: defaultWriteHandoff,
    getCurrentSha: defaultGetCurrentSha,
    isDirty: defaultIsDirty,
    getDiffStat: defaultGetDiffStat,
    createWorktree: defaultCreateWorktree,
    removeWorktree: defaultRemoveWorktree,
    cherryPick: defaultCherryPick,
    statePath,
  }, {
    rateLimitBackoffMs: 30000,
  });

  process.on('SIGTERM', () => runner.shutdown());
  process.on('SIGINT', () => runner.shutdown());

  await runner.run();
}

// Only run main when executed directly (not imported)
if (process.argv[1]?.endsWith('tmux-runner.js')) {
  main().catch((err) => {
    process.stderr.write(`Fatal: ${err.message}\n`);
    process.exit(1);
  });
}
