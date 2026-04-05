import { describe, it, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// This import will fail until bin/microverse-runner.js is implemented — TDD red
import {
  runMicroverse,
  measureMetric,
  compareAndRollback,
  isConverged,
  writeHandoffContent,
  preflight,
  spawnWorker,
  AGENT_DEFS,
} from '../bin/microverse-runner.js';

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-runner-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Mock helpers (same pattern as tmux-runner.test.js)
// ---------------------------------------------------------------------------

function fakeChild(exitCode = 0) {
  const child = new EventEmitter();
  child.pid = 12345;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = mock.fn(() => { child.killed = true; });
  child.killed = false;
  process.nextTick(() => child.emit('exit', exitCode, null));
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

function makeMockState(overrides = {}) {
  return {
    schema_version: 1,
    status: 'running',
    iteration: 0,
    max_iterations: 10,
    target_path: '/tmp/test-project',
    convergence: {
      stall_limit: 3,
      stall_counter: 0,
      history: [],
    },
    convergence_target: 95,
    convergence_mode: 'metric',
    convergence_file: null,
    failed_approaches: [],
    baseline_score: 50,
    exit_reason: null,
    key_metric: {
      description: 'test coverage',
      validation: 'npm test -- --coverage | tail -1',
      type: 'command',
    },
    ...overrides,
  };
}

function makeMockDeps(stateOverrides = {}) {
  const state = makeMockState(stateOverrides);
  return {
    state,
    stateManager: {
      read: mock.fn(() => ({ ...state })),
      update: mock.fn((_p, mutator) => { mutator(state); return { ...state }; }),
      forceWrite: mock.fn(),
    },
    spawn: mock.fn(() => fakeChild()),
    execSync: mock.fn(() => Buffer.from('75')),
  };
}

// ---------------------------------------------------------------------------
// 1. agent-definitions — .md files exist with id/model/tools
// ---------------------------------------------------------------------------
describe('agent-definitions', () => {
  it('AGENT_DEFS includes microverse-worker with required fields', () => {
    const worker = AGENT_DEFS.find(a => a.id === 'microverse-worker');
    assert.ok(worker, 'microverse-worker agent def should exist');
    assert.ok(worker.model, 'should have model field');
    assert.ok(worker.tools, 'should have tools field');
  });

  it('AGENT_DEFS includes microverse-analyst with required fields', () => {
    const analyst = AGENT_DEFS.find(a => a.id === 'microverse-analyst');
    assert.ok(analyst, 'microverse-analyst agent def should exist');
    assert.ok(analyst.model, 'should have model field');
    assert.ok(analyst.tools, 'should have tools field');
  });

  it('all AGENT_DEFS have id, model, and tools', () => {
    for (const def of AGENT_DEFS) {
      assert.ok(def.id, `agent def missing id`);
      assert.ok(def.model, `${def.id} missing model`);
      assert.ok(def.tools, `${def.id} missing tools`);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. gap-analysis — status=gap_analysis triggers analyst spawn first
// ---------------------------------------------------------------------------
describe('gap-analysis', () => {
  it('spawns analyst agent when status is gap_analysis', async () => {
    const deps = makeMockDeps({ status: 'gap_analysis' });
    await runMicroverse({ sessionDir: tmpDir, deps });
    const firstSpawnArgs = deps.spawn.mock.calls[0].arguments;
    assert.ok(
      firstSpawnArgs.some(a => typeof a === 'string' && a.includes('microverse-analyst')),
      'first spawn should reference microverse-analyst agent'
    );
  });
});

// ---------------------------------------------------------------------------
// 3. context-clearing — each iteration = new forge -p (no --cid)
// ---------------------------------------------------------------------------
describe('context-clearing', () => {
  it('each iteration spawns forge without --cid flag', async () => {
    const deps = makeMockDeps({ max_iterations: 2 });
    await runMicroverse({ sessionDir: tmpDir, deps });
    for (const call of deps.spawn.mock.calls) {
      const args = call.arguments.flat().join(' ');
      assert.ok(!args.includes('--cid'), `spawn should not contain --cid: ${args}`);
    }
  });

  it('each iteration includes -p flag', async () => {
    const deps = makeMockDeps({ max_iterations: 2 });
    await runMicroverse({ sessionDir: tmpDir, deps });
    for (const call of deps.spawn.mock.calls) {
      const args = call.arguments.flat().join(' ');
      assert.ok(args.includes('-p'), `spawn should contain -p flag: ${args}`);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. orchestrator-loop — measure/compare/rollback cycle with mocks
// ---------------------------------------------------------------------------
describe('orchestrator-loop', () => {
  it('calls measureMetric after each iteration', async () => {
    const measure = mock.fn(() => 60);
    const deps = makeMockDeps({ max_iterations: 3 });
    deps.measureMetric = measure;
    await runMicroverse({ sessionDir: tmpDir, deps });
    assert.ok(measure.mock.callCount() >= 2, 'measureMetric should be called each iteration');
  });

  it('compares new score against previous best', async () => {
    const scores = [60, 55, 70];
    let callIdx = 0;
    const deps = makeMockDeps({ max_iterations: 3 });
    deps.measureMetric = mock.fn(() => scores[callIdx++]);
    await runMicroverse({ sessionDir: tmpDir, deps });
    const finalState = deps.stateManager.read();
    assert.ok(finalState.convergence.history.length > 0, 'should record history');
  });
});

// ---------------------------------------------------------------------------
// 5. rollback — HEAD matches pre-SHA after regression
// ---------------------------------------------------------------------------
describe('rollback', () => {
  it('resets to pre-SHA when metric regresses', async () => {
    const deps = makeMockDeps();
    const preSha = 'abc1234';
    deps.execSync = mock.fn((cmd) => {
      if (typeof cmd === 'string' && cmd.includes('rev-parse')) return Buffer.from(preSha);
      return Buffer.from('');
    });
    deps.measureMetric = mock.fn(() => 40); // worse than baseline 50
    await runMicroverse({ sessionDir: tmpDir, deps, maxIterations: 1 });
    const resetCalls = deps.execSync.mock.calls.filter(
      c => typeof c.arguments[0] === 'string' && c.arguments[0].includes('git reset --hard')
    );
    assert.ok(resetCalls.length > 0, 'should call git reset --hard on regression');
    assert.ok(
      resetCalls[0].arguments[0].includes(preSha),
      'reset should target pre-SHA'
    );
  });
});

// ---------------------------------------------------------------------------
// 6. stall-detection — counter increments, isConverged() at limit
// ---------------------------------------------------------------------------
describe('stall-detection', () => {
  it('increments stall_counter when score does not improve', () => {
    const state = makeMockState({ convergence: { stall_limit: 3, stall_counter: 1, history: [50, 50] } });
    // isConverged should check stall_counter >= stall_limit
    assert.equal(isConverged(state), false, 'not converged yet at counter=1');
  });

  it('isConverged returns true when stall_counter reaches stall_limit', () => {
    const state = makeMockState({ convergence: { stall_limit: 3, stall_counter: 3, history: [50, 50, 50, 50] } });
    assert.equal(isConverged(state), true, 'should be converged at limit');
  });
});

// ---------------------------------------------------------------------------
// 7. convergence-target — early exit when metric meets threshold
// ---------------------------------------------------------------------------
describe('convergence-target', () => {
  it('exits early when metric meets convergence_target', async () => {
    const deps = makeMockDeps({ convergence_target: 80, max_iterations: 10 });
    deps.measureMetric = mock.fn(() => 85); // exceeds target
    await runMicroverse({ sessionDir: tmpDir, deps });
    const finalState = deps.stateManager.read();
    assert.equal(finalState.exit_reason, 'target_reached');
  });
});

// ---------------------------------------------------------------------------
// 8. failed-approaches — circular buffer max 100
// ---------------------------------------------------------------------------
describe('failed-approaches', () => {
  it('failed_approaches does not exceed 100 entries', async () => {
    const existingFailures = Array.from({ length: 100 }, (_, i) => `approach-${i}`);
    const deps = makeMockDeps({ failed_approaches: existingFailures });
    deps.measureMetric = mock.fn(() => 40); // regression = new failed approach
    await runMicroverse({ sessionDir: tmpDir, deps, maxIterations: 1 });
    const finalState = deps.stateManager.read();
    assert.ok(finalState.failed_approaches.length <= 100, 'buffer should cap at 100');
  });
});

// ---------------------------------------------------------------------------
// 9. handoff-content — handoff.txt with iteration/metric/history
// ---------------------------------------------------------------------------
describe('handoff-content', () => {
  it('writeHandoffContent produces file with iteration number', () => {
    const handoffPath = path.join(tmpDir, 'handoff.txt');
    const state = makeMockState({ iteration: 5, convergence: { stall_limit: 3, stall_counter: 0, history: [50, 55, 60] } });
    writeHandoffContent(handoffPath, state);
    const content = fs.readFileSync(handoffPath, 'utf-8');
    assert.ok(content.includes('5'), 'should contain iteration number');
    assert.ok(content.includes('history') || content.includes('50'), 'should contain metric history');
  });
});

// ---------------------------------------------------------------------------
// 10. signal-handling — SIGTERM persists state via forceWrite
// ---------------------------------------------------------------------------
describe('signal-handling', () => {
  it('SIGTERM triggers forceWrite to persist state', async () => {
    const deps = makeMockDeps({ max_iterations: 100 });
    // Start runner, then simulate SIGTERM
    const runPromise = runMicroverse({ sessionDir: tmpDir, deps });
    process.nextTick(() => process.emit('SIGTERM'));
    await runPromise;
    assert.ok(
      deps.stateManager.forceWrite.mock.callCount() > 0,
      'forceWrite should be called on SIGTERM'
    );
  });
});

// ---------------------------------------------------------------------------
// 11. worker-managed — polls convergence_file
// ---------------------------------------------------------------------------
describe('worker-managed', () => {
  it('polls convergence_file when convergence_mode is worker', async () => {
    const convergenceFile = path.join(tmpDir, 'convergence.json');
    fs.writeFileSync(convergenceFile, JSON.stringify({ converged: true, score: 90 }));
    const deps = makeMockDeps({
      convergence_mode: 'worker',
      convergence_file: convergenceFile,
      max_iterations: 10,
    });
    await runMicroverse({ sessionDir: tmpDir, deps });
    const finalState = deps.stateManager.read();
    assert.equal(finalState.exit_reason, 'worker_converged');
  });
});

// ---------------------------------------------------------------------------
// 12. timeout — SIGTERM at timeout, SIGKILL +2s
// ---------------------------------------------------------------------------
describe('timeout', () => {
  it('sends SIGTERM to worker at timeout then SIGKILL after 2s', async () => {
    const child = hangingChild();
    const deps = makeMockDeps({ max_iterations: 1 });
    deps.spawn = mock.fn(() => child);
    deps.timeoutMs = 100; // 100ms timeout for testing

    const runPromise = runMicroverse({ sessionDir: tmpDir, deps });

    // Wait for timeout to fire
    await new Promise(r => setTimeout(r, 200));
    child.kill('SIGKILL'); // simulate escalation
    child.emit('exit', null, 'SIGKILL');
    await runPromise;

    const killCalls = child.kill.mock.calls;
    assert.ok(killCalls.length >= 1, 'should send at least SIGTERM');
  });
});

// ---------------------------------------------------------------------------
// 13. preflight — auto-commit dirty tree before pre-SHA
// ---------------------------------------------------------------------------
describe('preflight', () => {
  it('auto-commits dirty working tree before capturing pre-SHA', () => {
    const deps = makeMockDeps();
    deps.execSync = mock.fn((cmd) => {
      if (typeof cmd === 'string' && cmd.includes('status --porcelain')) return Buffer.from('M file.js\n');
      return Buffer.from('');
    });
    preflight({ workingDir: tmpDir, deps });
    const commitCalls = deps.execSync.mock.calls.filter(
      c => typeof c.arguments[0] === 'string' && c.arguments[0].includes('git commit')
    );
    assert.ok(commitCalls.length > 0, 'should auto-commit dirty tree');
  });
});

// ---------------------------------------------------------------------------
// 14. max-iterations — exits after max
// ---------------------------------------------------------------------------
describe('max-iterations', () => {
  it('exits with max_iterations exit_reason after reaching limit', async () => {
    const deps = makeMockDeps({ max_iterations: 2, iteration: 0 });
    deps.measureMetric = mock.fn(() => 55); // slight improvement each time, no convergence
    await runMicroverse({ sessionDir: tmpDir, deps });
    const finalState = deps.stateManager.read();
    assert.equal(finalState.exit_reason, 'max_iterations');
  });
});
