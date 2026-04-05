import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRunner, PHASE_AGENTS, DEFAULT_CONFIG } from '../bin/tmux-runner.js';

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function fakeChild(exitCode = 0, { stderr = '' } = {}) {
  const child = new EventEmitter();
  child.pid = 12345;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = mock.fn(() => { child.killed = true; });
  child.killed = false;
  process.nextTick(() => {
    if (stderr) child.stderr.emit('data', Buffer.from(stderr));
    child.emit('exit', exitCode, null);
  });
  return child;
}

function hangingChild() {
  const child = new EventEmitter();
  child.pid = 99999;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = mock.fn((sig) => {
    if (sig === 'SIGKILL') {
      child.killed = true;
      process.nextTick(() => child.emit('exit', null, 'SIGKILL'));
    }
  });
  return child;
}

/**
 * Create deps with a shared mutable state object.
 * read() returns a copy, update() mutates the shared state —
 * so iteration advances correctly across loop iterations.
 */
function makeDeps(stateOverrides = {}, depsOverrides = {}) {
  const shared = {
    schema_version: 1,
    active: true,
    pid: process.pid,
    iteration: 0,
    max_iterations: 10,
    step: 'implement',
    working_dir: '/tmp/test-project',
    current_ticket: 'TEST-1',
    start_time_epoch: Date.now(),
    max_time_minutes: 60,
    history: [],
    auto_dump_path: '/tmp/auto_dump.json',
    session_dir: '/tmp/session',
    ...stateOverrides,
  };

  const stateManager = {
    read: mock.fn(() => ({ ...shared })),
    update: mock.fn((_path, mutator) => {
      mutator(shared);
      return { ...shared };
    }),
    forceWrite: mock.fn(),
  };

  return {
    stateManager,
    circuitBreaker: {
      canExecute: mock.fn(() => true),
      recordIteration: mock.fn(),
      reset: mock.fn(),
      getState: mock.fn(() => ({ state: 'CLOSED' })),
    },
    spawn: mock.fn(() => fakeChild()),
    parseAutoDump: mock.fn(() => ({ tokens: [], rawMessages: [] })),
    writeHandoff: mock.fn(),
    getCurrentSha: mock.fn(() => 'abc123'),
    isDirty: mock.fn(() => false),
    getDiffStat: mock.fn(() => ''),
    statePath: '/tmp/state.json',
    _shared: shared, // expose for assertions
    ...depsOverrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Context clearing
// ---------------------------------------------------------------------------
describe('context clearing', () => {
  it('spawns a new forge -p process for each iteration', async () => {
    const deps = makeDeps({ max_iterations: 3 });
    const runner = createRunner(deps);
    await runner.run();
    assert.equal(deps.spawn.mock.callCount(), 3);
  });

  it('passes -p flag to forge spawn', async () => {
    const deps = makeDeps({ max_iterations: 1 });
    const runner = createRunner(deps);
    await runner.run();
    const call = deps.spawn.mock.calls[0];
    assert.equal(call.arguments[0], 'forge');
    assert(call.arguments[1].includes('-p'));
  });
});

// ---------------------------------------------------------------------------
// 2. Agent selection
// ---------------------------------------------------------------------------
describe('agent selection', () => {
  it('maps research phase to research agent', async () => {
    const deps = makeDeps({ step: 'research', max_iterations: 1 });
    const runner = createRunner(deps);
    await runner.run();
    const args = deps.spawn.mock.calls[0].arguments[1];
    assert(args.some(a => a.includes(PHASE_AGENTS.research)));
  });

  it('maps implement phase to implement agent', async () => {
    const deps = makeDeps({ step: 'implement', max_iterations: 1 });
    const runner = createRunner(deps);
    await runner.run();
    const args = deps.spawn.mock.calls[0].arguments[1];
    assert(args.some(a => a.includes(PHASE_AGENTS.implement)));
  });

  it('exports PHASE_AGENTS mapping for all phases', () => {
    assert(PHASE_AGENTS.research);
    assert(PHASE_AGENTS.plan);
    assert(PHASE_AGENTS.implement);
    assert(PHASE_AGENTS.refactor);
  });
});

// ---------------------------------------------------------------------------
// 3. Promise token detection
// ---------------------------------------------------------------------------
describe('promise token detection', () => {
  it('calls parseAutoDump after process exits', async () => {
    const deps = makeDeps({ max_iterations: 1 });
    const runner = createRunner(deps);
    await runner.run();
    assert(deps.parseAutoDump.mock.callCount() >= 1);
  });

  it('detects I AM DONE token and stops loop', async () => {
    const deps = makeDeps({ max_iterations: 10 });
    deps.parseAutoDump = mock.fn(() => ({ tokens: ['I AM DONE'], rawMessages: [] }));
    deps.isDirty = mock.fn(() => true);
    deps.getDiffStat = mock.fn(() => '1 file changed');
    const runner = createRunner(deps);
    await runner.run();
    assert.equal(deps.spawn.mock.callCount(), 1);
  });

  it('detects EPIC_COMPLETED token and stops loop', async () => {
    const deps = makeDeps({ max_iterations: 10 });
    deps.parseAutoDump = mock.fn(() => ({ tokens: ['EPIC_COMPLETED'], rawMessages: [] }));
    deps.isDirty = mock.fn(() => true);
    deps.getDiffStat = mock.fn(() => '1 file changed');
    const runner = createRunner(deps);
    await runner.run();
    assert.equal(deps.spawn.mock.callCount(), 1);
  });
});

// ---------------------------------------------------------------------------
// 4. State updates
// ---------------------------------------------------------------------------
describe('state updates', () => {
  it('increments iteration after each spawn', async () => {
    const deps = makeDeps({ max_iterations: 2 });
    const runner = createRunner(deps);
    await runner.run();
    assert.equal(deps._shared.iteration, 2);
  });

  it('updates state via StateManager.update (not direct write)', async () => {
    const deps = makeDeps({ max_iterations: 1 });
    const runner = createRunner(deps);
    await runner.run();
    assert(deps.stateManager.update.mock.callCount() >= 1);
  });
});

// ---------------------------------------------------------------------------
// 5. Handoff file
// ---------------------------------------------------------------------------
describe('handoff file', () => {
  it('calls writeHandoff before spawn', async () => {
    const callOrder = [];
    const deps = makeDeps({ max_iterations: 1 });
    deps.writeHandoff = mock.fn(() => callOrder.push('handoff'));
    deps.spawn = mock.fn(() => {
      callOrder.push('spawn');
      return fakeChild();
    });
    const runner = createRunner(deps);
    await runner.run();
    assert(callOrder.indexOf('handoff') < callOrder.indexOf('spawn'));
  });

  it('passes ticket and sha to writeHandoff', async () => {
    const deps = makeDeps({ max_iterations: 1, current_ticket: 'TIX-42' });
    deps.getCurrentSha = mock.fn(() => 'deadbeef');
    const runner = createRunner(deps);
    await runner.run();
    const opts = deps.writeHandoff.mock.calls[0].arguments[1];
    assert.equal(opts.currentTicket, 'TIX-42');
    assert.equal(opts.sha, 'deadbeef');
  });
});

// ---------------------------------------------------------------------------
// 6. Rate-limit detection
// ---------------------------------------------------------------------------
describe('rate-limit detection', () => {
  it('detects 429 in stderr and continues with backoff', async () => {
    const deps = makeDeps({ max_iterations: 2 });
    deps.spawn = mock.fn(() => fakeChild(1, { stderr: 'Error: 429 Too Many Requests' }));
    const runner = createRunner(deps, { rateLimitBackoffMs: 10 }); // fast for tests
    await runner.run();
    // Should have spawned twice (didn't crash on 429)
    assert.equal(deps.spawn.mock.callCount(), 2);
  });
});

// ---------------------------------------------------------------------------
// 7. Circuit breaker
// ---------------------------------------------------------------------------
describe('circuit breaker', () => {
  it('calls recordIteration after each spawn completes', async () => {
    const deps = makeDeps({ max_iterations: 2 });
    const runner = createRunner(deps);
    await runner.run();
    assert(deps.circuitBreaker.recordIteration.mock.callCount() >= 2);
  });

  it('stops loop when circuit breaker is OPEN', async () => {
    const deps = makeDeps({ max_iterations: 10 });
    let callNum = 0;
    deps.circuitBreaker.canExecute = mock.fn(() => {
      callNum++;
      return callNum <= 1; // allow first check, block second
    });
    const runner = createRunner(deps);
    await runner.run();
    assert.equal(deps.spawn.mock.callCount(), 1);
  });
});

// ---------------------------------------------------------------------------
// 8. Max iteration gate
// ---------------------------------------------------------------------------
describe('max iteration gate', () => {
  it('stops when iteration reaches max_iterations', async () => {
    const deps = makeDeps({ max_iterations: 3 });
    const runner = createRunner(deps);
    await runner.run();
    assert.equal(deps.spawn.mock.callCount(), 3);
  });

  it('does not spawn if already at max iterations', async () => {
    const deps = makeDeps({ max_iterations: 5, iteration: 5 });
    const runner = createRunner(deps);
    await runner.run();
    assert.equal(deps.spawn.mock.callCount(), 0);
  });
});

// ---------------------------------------------------------------------------
// 9. Wall-clock time gate
// ---------------------------------------------------------------------------
describe('wall-clock time gate', () => {
  it('stops when wall-clock time exceeds max_time_minutes', async () => {
    const deps = makeDeps({
      max_iterations: 100,
      start_time_epoch: Date.now() - (61 * 60 * 1000),
      max_time_minutes: 60,
    });
    const runner = createRunner(deps);
    await runner.run();
    assert.equal(deps.spawn.mock.callCount(), 0);
  });
});

// ---------------------------------------------------------------------------
// 10. Signal handling
// ---------------------------------------------------------------------------
describe('signal handling', () => {
  it('exposes shutdown method', () => {
    const deps = makeDeps();
    const runner = createRunner(deps);
    assert.equal(typeof runner.shutdown, 'function');
  });

  it('shutdown stops the loop and saves state', async () => {
    const deps = makeDeps({ max_iterations: 100 });
    const runner = createRunner(deps);
    deps.spawn = mock.fn(() => {
      setTimeout(() => runner.shutdown(), 0);
      return fakeChild();
    });
    await runner.run();
    assert(deps.spawn.mock.callCount() < 100);
    assert(
      deps.stateManager.update.mock.callCount() >= 1 ||
      deps.stateManager.forceWrite.mock.callCount() >= 1
    );
  });
});

// ---------------------------------------------------------------------------
// 11. Worker timeout
// ---------------------------------------------------------------------------
describe('worker timeout', () => {
  it('sends SIGTERM then SIGKILL to a hanging child', async () => {
    const deps = makeDeps({ max_iterations: 1 });
    const child = hangingChild();
    deps.spawn = mock.fn(() => child);
    const runner = createRunner(deps, { workerTimeoutMs: 50, killEscalationMs: 30 });
    await runner.run();
    const signals = child.kill.mock.calls.map(c => c.arguments[0]);
    assert(signals.includes('SIGTERM'), 'Should send SIGTERM');
    assert(signals.includes('SIGKILL'), 'Should escalate to SIGKILL');
  });
});

// ---------------------------------------------------------------------------
// 12. Ticket double-check
// ---------------------------------------------------------------------------
describe('ticket double-check', () => {
  it('continues loop if token found but no git diff', async () => {
    const deps = makeDeps({ max_iterations: 2 });
    deps.parseAutoDump = mock.fn(() => ({ tokens: ['I AM DONE'], rawMessages: [] }));
    deps.isDirty = mock.fn(() => false);
    deps.getDiffStat = mock.fn(() => '');
    const runner = createRunner(deps);
    await runner.run();
    assert(deps.spawn.mock.callCount() >= 2, `Expected >= 2 spawns but got ${deps.spawn.mock.callCount()}`);
  });

  it('stops when token found AND diff is non-empty', async () => {
    const deps = makeDeps({ max_iterations: 10 });
    deps.parseAutoDump = mock.fn(() => ({ tokens: ['I AM DONE'], rawMessages: [] }));
    deps.isDirty = mock.fn(() => true);
    deps.getDiffStat = mock.fn(() => '3 files changed, 42 insertions(+)');
    const runner = createRunner(deps);
    await runner.run();
    assert.equal(deps.spawn.mock.callCount(), 1);
  });
});

// ---------------------------------------------------------------------------
// 13. EXISTENCE_IS_PAIN and ANALYSIS_DONE tokens
// ---------------------------------------------------------------------------
describe('completion tokens — extended', () => {
  it('existence-is-pain', async () => {
    const deps = makeDeps({ max_iterations: 10 });
    deps.parseAutoDump = mock.fn(() => ({ tokens: ['EXISTENCE_IS_PAIN'], rawMessages: [] }));
    deps.isDirty = mock.fn(() => true);
    deps.getDiffStat = mock.fn(() => '1 file changed');
    const runner = createRunner(deps);
    await runner.run();
    assert.equal(deps.spawn.mock.callCount(), 1, 'EXISTENCE_IS_PAIN should trigger clean exit');
  });

  it('analysis-done', async () => {
    const deps = makeDeps({ max_iterations: 10 });
    deps.parseAutoDump = mock.fn(() => ({ tokens: ['ANALYSIS_DONE'], rawMessages: [] }));
    deps.isDirty = mock.fn(() => true);
    deps.getDiffStat = mock.fn(() => '1 file changed');
    const runner = createRunner(deps);
    await runner.run();
    assert.equal(deps.spawn.mock.callCount(), 1, 'ANALYSIS_DONE should trigger clean exit');
  });
});

// ---------------------------------------------------------------------------
// 14. Phase routing — pickle-manager for non-implement phases
// ---------------------------------------------------------------------------
describe('phase routing', () => {
  it('phase-prd', async () => {
    const deps = makeDeps({ step: 'prd', max_iterations: 1 });
    const runner = createRunner(deps);
    await runner.run();
    const args = deps.spawn.mock.calls[0].arguments[1];
    assert(args.some(a => a.includes('pickle-manager')), 'prd should route to pickle-manager');
  });

  it('phase-breakdown', async () => {
    const deps = makeDeps({ step: 'breakdown', max_iterations: 1 });
    const runner = createRunner(deps);
    await runner.run();
    const args = deps.spawn.mock.calls[0].arguments[1];
    assert(args.some(a => a.includes('pickle-manager')), 'breakdown should route to pickle-manager');
  });

  it('phase-review', async () => {
    const deps = makeDeps({ step: 'review', max_iterations: 1 });
    const runner = createRunner(deps);
    await runner.run();
    const args = deps.spawn.mock.calls[0].arguments[1];
    assert(args.some(a => a.includes('pickle-manager')), 'review should route to pickle-manager');
  });

  it('unknown-phase', async () => {
    const deps = makeDeps({ step: 'xyzzy-unknown', max_iterations: 1 });
    const runner = createRunner(deps);
    await runner.run();
    const args = deps.spawn.mock.calls[0].arguments[1];
    assert(args.some(a => a.includes('pickle-manager')), 'unknown phase should default to pickle-manager');
  });
});

// ---------------------------------------------------------------------------
// 15. Signal handler — kill child + deactivate state
// ---------------------------------------------------------------------------
describe('signal handler — enhanced', () => {
  it('signal-deactivate', async () => {
    const deps = makeDeps({ max_iterations: 100 });
    // Use a delayed child so setTimeout(0) for shutdown fires before child exits
    deps.spawn = mock.fn(() => {
      const child = new EventEmitter();
      child.pid = 77777;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.killed = false;
      child.kill = mock.fn(() => {
        child.killed = true;
        setTimeout(() => child.emit('exit', null, 'SIGTERM'), 0);
      });
      // Child exits after 20ms — gives shutdown(10ms) time to fire first
      setTimeout(() => {
        if (!child.killed) child.emit('exit', 0, null);
      }, 20);
      return child;
    });
    const runner = createRunner(deps, { workerTimeoutMs: 60000 });
    setTimeout(() => runner.shutdown(), 10);
    await runner.run();
    // Check that stateManager.update was called with active=false
    const updateCalls = deps.stateManager.update.mock.calls;
    const setActiveFalse = updateCalls.some(call => {
      const testState = { active: true };
      call.arguments[1](testState);
      return testState.active === false;
    });
    assert(setActiveFalse, 'shutdown should set active=false via stateManager.update');
  });

  it('signal-kill-child', async () => {
    const deps = makeDeps({ max_iterations: 100 });
    let capturedChild;
    deps.spawn = mock.fn(() => {
      const child = new EventEmitter();
      child.pid = 55555;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.killed = false;
      child.kill = mock.fn(() => {
        child.killed = true;
        setTimeout(() => child.emit('exit', null, 'SIGTERM'), 0);
      });
      capturedChild = child;
      // Child exits after 50ms — shutdown(10ms) fires first
      setTimeout(() => {
        if (!child.killed) child.emit('exit', 0, null);
      }, 50);
      return child;
    });
    const runner = createRunner(deps, { workerTimeoutMs: 60000 });
    setTimeout(() => runner.shutdown(), 10);
    await runner.run();
    assert(capturedChild.kill.mock.callCount() >= 1, 'shutdown should kill the current child process');
  });
});

// ---------------------------------------------------------------------------
// 16. Rich handoff content
// ---------------------------------------------------------------------------
describe('rich handoff', () => {
  it('rich-handoff', async () => {
    const deps = makeDeps({
      max_iterations: 4,
      iteration: 3,
      step: 'implement',
      current_ticket: 'RICH-1',
      working_dir: '/projects/test',
      session_dir: '/sessions/test',
      start_time_epoch: Date.now(),
      history: [
        { ticket: 'DONE-1', status: 'done' },
        { ticket: 'DONE-2', status: 'done' },
      ],
      tickets: ['DONE-1', 'DONE-2', 'RICH-1', 'PEND-1'],
    });
    const runner = createRunner(deps);
    await runner.run();
    const opts = deps.writeHandoff.mock.calls[0].arguments[1];
    assert.equal(opts.step || opts.status, 'implement', 'should include phase/step');
    assert.equal(opts.currentTicket || opts.ticket, 'RICH-1', 'should include current ticket');
    assert(opts.iteration !== undefined, 'should include iteration');
    assert(opts.workingDir || opts.working_dir, 'should include working dir');
    assert(opts.sessionRoot || opts.session_dir, 'should include session root');
    assert(opts.startTime || opts.start_time_epoch, 'should include start time');
  });
});

// ---------------------------------------------------------------------------
// 17. Parallel workers in worktrees
// ---------------------------------------------------------------------------
describe('parallel workers', () => {
  it('parallel-worktrees', async () => {
    const deps = makeDeps({ max_iterations: 1 });
    deps.createWorktree = mock.fn();
    deps.removeWorktree = mock.fn();
    deps.cherryPick = mock.fn();
    deps.getCurrentSha = mock.fn(() => 'abc123');
    // Each spawn in a worktree should produce a child that exits successfully
    deps.spawn = mock.fn(() => fakeChild(0));
    const runner = createRunner(deps);
    const tickets = ['T-1', 'T-2', 'T-3'];
    const results = await runner.spawnParallelWorkers(tickets, '/base/dir');
    assert.equal(results.length, 3, 'should return results for all tickets');
    assert(deps.createWorktree.mock.callCount() >= 3, 'should create worktree per ticket');
  });

  it('parallel-cleanup', async () => {
    const deps = makeDeps({ max_iterations: 1 });
    deps.createWorktree = mock.fn();
    deps.removeWorktree = mock.fn();
    deps.cherryPick = mock.fn();
    deps.getCurrentSha = mock.fn(() => 'abc123');
    let callCount = 0;
    deps.spawn = mock.fn(() => {
      callCount++;
      // Second ticket fails
      return fakeChild(callCount === 2 ? 1 : 0);
    });
    const runner = createRunner(deps);
    const results = await runner.spawnParallelWorkers(['T-1', 'T-2', 'T-3'], '/base/dir');
    // All worktrees should be cleaned up regardless of success/failure
    assert(deps.removeWorktree.mock.callCount() >= 3, 'should cleanup all worktrees including failed');
    const failed = results.filter(r => r.code !== 0);
    assert(failed.length >= 1, 'should report failed worker');
  });

  it('parallel-cherrypick', async () => {
    const deps = makeDeps({ max_iterations: 1 });
    deps.createWorktree = mock.fn();
    deps.removeWorktree = mock.fn();
    deps.cherryPick = mock.fn();
    deps.getCurrentSha = mock.fn(() => 'def456');
    deps.spawn = mock.fn(() => fakeChild(0));
    const runner = createRunner(deps);
    await runner.spawnParallelWorkers(['T-1', 'T-2'], '/base/dir');
    assert(deps.cherryPick.mock.callCount() >= 2, 'should cherry-pick commits from successful workers');
  });
});
