import { describe, it, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// This import will fail until lib/anatomy-park.js is implemented — TDD red
import {
  runAnatomyPark,
  discoverSubsystems,
  isSubsystemConverged,
  isSubsystemStalled,
  isFullyConverged,
  flushTrapDoors,
  rollbackPhase3,
  loadState,
  saveState,
} from '../lib/anatomy-park.js';

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anatomy-park-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function makeSubsystem(name, overrides = {}) {
  return {
    name,
    pass_count: 0,
    consecutive_clean: 0,
    stall_count: 0,
    ...overrides,
  };
}

function makeAnatomyState(overrides = {}) {
  return {
    status: 'running',
    subsystems: [
      makeSubsystem('lib'),
      makeSubsystem('bin'),
      makeSubsystem('tests'),
    ],
    rotation_index: 0,
    trap_doors: [],
    stall_limit: 3,
    ...overrides,
  };
}

function makeMockForge(phaseResults = {}) {
  return {
    runAgent: mock.fn(async (agentId, _opts) => {
      if (agentId === 'anatomy-tracer') {
        return phaseResults.tracer ?? { findings: [{ severity: 'high', description: 'bug' }] };
      }
      if (agentId === 'anatomy-surgeon') {
        return phaseResults.surgeon ?? { fixed: true, trap_door: '## Trap: check null path' };
      }
      if (agentId === 'anatomy-verifier') {
        return phaseResults.verifier ?? { result: 'PASS' };
      }
      return {};
    }),
  };
}

function makeMockGit() {
  return {
    stash: mock.fn(),
    resetHard: mock.fn(),
    commit: mock.fn(),
    getHeadSha: mock.fn(() => 'abc1234'),
  };
}

function makeMockFs(existingDirs = {}) {
  return {
    readdir: mock.fn((dir) => existingDirs[dir] ?? []),
    countSourceFiles: mock.fn((dir) => existingDirs[dir]?.length ?? 0),
    readFile: mock.fn(() => ''),
    writeFile: mock.fn(),
  };
}

// ---------------------------------------------------------------------------
// 1. three-phase — sequential tracer → surgeon → verifier
// ---------------------------------------------------------------------------
describe('three-phase sequential', () => {
  it('runs tracer, then surgeon, then verifier in order for each subsystem', async () => {
    const forge = makeMockForge();
    const git = makeMockGit();
    const state = makeAnatomyState({ subsystems: [makeSubsystem('src')] });

    await runAnatomyPark({
      state,
      forge,
      git,
      targetDir: tmpDir,
      maxIterations: 1,
    });

    const calls = forge.runAgent.mock.calls.map(c => c.arguments[0]);
    assert.equal(calls[0], 'anatomy-tracer', 'phase 1 should be tracer');
    assert.equal(calls[1], 'anatomy-surgeon', 'phase 2 should be surgeon');
    assert.equal(calls[2], 'anatomy-verifier', 'phase 3 should be verifier');
  });
});

// ---------------------------------------------------------------------------
// 2. discovery — subdirs with 3+ source files, exclude node_modules/dist
// ---------------------------------------------------------------------------
describe('discovery', () => {
  it('qualifies subdirs with 3+ source files and excludes node_modules/dist', () => {
    // Create directory structure
    const dirs = ['src', 'lib', 'node_modules', 'dist', 'docs'];
    for (const d of dirs) {
      fs.mkdirSync(path.join(tmpDir, d), { recursive: true });
    }
    // src: 4 source files (qualifies)
    for (let i = 0; i < 4; i++) {
      fs.writeFileSync(path.join(tmpDir, 'src', `file${i}.js`), '// src');
    }
    // lib: 3 source files (qualifies)
    for (let i = 0; i < 3; i++) {
      fs.writeFileSync(path.join(tmpDir, 'lib', `mod${i}.js`), '// lib');
    }
    // node_modules: 10 files (excluded)
    for (let i = 0; i < 10; i++) {
      fs.writeFileSync(path.join(tmpDir, 'node_modules', `pkg${i}.js`), '// nm');
    }
    // dist: 5 files (excluded)
    for (let i = 0; i < 5; i++) {
      fs.writeFileSync(path.join(tmpDir, 'dist', `bundle${i}.js`), '// dist');
    }
    // docs: 1 file (too few)
    fs.writeFileSync(path.join(tmpDir, 'docs', 'readme.md'), '# docs');

    const result = discoverSubsystems(tmpDir);

    const names = result.map(s => s.name).sort();
    assert.deepEqual(names, ['lib', 'src'], 'should include src and lib only');
    assert.ok(!names.includes('node_modules'), 'should exclude node_modules');
    assert.ok(!names.includes('dist'), 'should exclude dist');
    assert.ok(!names.includes('docs'), 'should exclude docs (too few files)');
  });
});

// ---------------------------------------------------------------------------
// 3. rotation-skip — skip converged (consecutive_clean >= 2)
// ---------------------------------------------------------------------------
describe('rotation-skip', () => {
  it('skips subsystems with consecutive_clean >= 2', async () => {
    const convergedSub = makeSubsystem('lib', { consecutive_clean: 2 });
    const activeSub = makeSubsystem('src', { consecutive_clean: 0 });
    const forge = makeMockForge();
    const git = makeMockGit();
    const state = makeAnatomyState({
      subsystems: [convergedSub, activeSub],
      rotation_index: 0,
    });

    await runAnatomyPark({
      state,
      forge,
      git,
      targetDir: tmpDir,
      maxIterations: 1,
    });

    // Tracer should only be called for 'src', not 'lib'
    const tracerCalls = forge.runAgent.mock.calls.filter(
      c => c.arguments[0] === 'anatomy-tracer'
    );
    assert.equal(tracerCalls.length, 1, 'tracer called once (skipped converged)');

    // The subsystem context should reference 'src' not 'lib'
    const tracerOpts = tracerCalls[0].arguments[1];
    assert.equal(
      tracerOpts.subsystem, 'src',
      'should run tracer on active subsystem, not converged one'
    );
  });

  it('isSubsystemConverged returns true when consecutive_clean >= 2', () => {
    assert.equal(isSubsystemConverged(makeSubsystem('x', { consecutive_clean: 2 })), true);
    assert.equal(isSubsystemConverged(makeSubsystem('x', { consecutive_clean: 1 })), false);
    assert.equal(isSubsystemConverged(makeSubsystem('x', { consecutive_clean: 3 })), true);
  });
});

// ---------------------------------------------------------------------------
// 4. stall-skip — skip stalled (stall_count >= limit)
// ---------------------------------------------------------------------------
describe('stall-skip', () => {
  it('skips subsystems with stall_count >= stall_limit', async () => {
    const stalledSub = makeSubsystem('lib', { stall_count: 3 });
    const activeSub = makeSubsystem('src', { stall_count: 0 });
    const forge = makeMockForge();
    const git = makeMockGit();
    const state = makeAnatomyState({
      subsystems: [stalledSub, activeSub],
      stall_limit: 3,
      rotation_index: 0,
    });

    await runAnatomyPark({
      state,
      forge,
      git,
      targetDir: tmpDir,
      maxIterations: 1,
    });

    const tracerCalls = forge.runAgent.mock.calls.filter(
      c => c.arguments[0] === 'anatomy-tracer'
    );
    assert.equal(tracerCalls.length, 1, 'tracer called once (skipped stalled)');
    assert.equal(
      tracerCalls[0].arguments[1].subsystem, 'src',
      'should run on active subsystem, not stalled one'
    );
  });

  it('isSubsystemStalled returns true when stall_count >= limit', () => {
    assert.equal(isSubsystemStalled(makeSubsystem('x', { stall_count: 3 }), 3), true);
    assert.equal(isSubsystemStalled(makeSubsystem('x', { stall_count: 2 }), 3), false);
    assert.equal(isSubsystemStalled(makeSubsystem('x', { stall_count: 5 }), 3), true);
  });
});

// ---------------------------------------------------------------------------
// 5. trap-door-flush — AGENTS.md cleaned on convergence
// ---------------------------------------------------------------------------
describe('trap-door-flush', () => {
  it('flushes trap doors to AGENTS.md on full convergence', async () => {
    const agentsMdPath = path.join(tmpDir, 'AGENTS.md');
    fs.writeFileSync(agentsMdPath, '# Agents\n\n## Trap Doors\n- old entry\n');

    const trapDoors = [
      '## Trap: null check in parser',
      '## Trap: race condition in loader',
    ];

    flushTrapDoors(agentsMdPath, trapDoors);

    const content = fs.readFileSync(agentsMdPath, 'utf-8');
    assert.ok(content.includes('null check in parser'), 'should contain first trap door');
    assert.ok(content.includes('race condition in loader'), 'should contain second trap door');
    assert.ok(!content.includes('old entry'), 'should clean old trap door entries');
  });
});

// ---------------------------------------------------------------------------
// 6. phase3-rollback — stash + reset on verifier fail
// ---------------------------------------------------------------------------
describe('phase3-rollback', () => {
  it('calls git stash and git reset --hard on verifier FAIL', async () => {
    const forge = makeMockForge({
      verifier: { result: 'FAIL' },
    });
    const git = makeMockGit();
    const state = makeAnatomyState({ subsystems: [makeSubsystem('src')] });

    await runAnatomyPark({
      state,
      forge,
      git,
      targetDir: tmpDir,
      maxIterations: 1,
    });

    assert.ok(git.stash.mock.callCount() > 0, 'should call git stash on FAIL');
    assert.ok(git.resetHard.mock.callCount() > 0, 'should call git reset --hard on FAIL');
  });

  it('rollbackPhase3 performs stash then reset to pre-SHA', () => {
    const git = makeMockGit();
    const preSha = 'deadbeef';

    rollbackPhase3({ git, preSha });

    assert.ok(git.stash.mock.callCount() === 1, 'stash called once');
    assert.ok(git.resetHard.mock.callCount() === 1, 'resetHard called once');
    assert.equal(
      git.resetHard.mock.calls[0].arguments[0], preSha,
      'resetHard should target pre-SHA'
    );
  });

  it('increments stall_count on verifier FAIL', async () => {
    const forge = makeMockForge({ verifier: { result: 'FAIL' } });
    const git = makeMockGit();
    const sub = makeSubsystem('src', { stall_count: 1 });
    const state = makeAnatomyState({ subsystems: [sub] });

    await runAnatomyPark({
      state,
      forge,
      git,
      targetDir: tmpDir,
      maxIterations: 1,
    });

    assert.equal(state.subsystems[0].stall_count, 2, 'stall_count should increment on FAIL');
  });
});

// ---------------------------------------------------------------------------
// 7. state-persistence — anatomy-park.json with counts
// ---------------------------------------------------------------------------
describe('state-persistence', () => {
  it('loadState reads anatomy-park.json from session dir', () => {
    const stateFile = path.join(tmpDir, 'anatomy-park.json');
    const expected = makeAnatomyState({ status: 'running' });
    fs.writeFileSync(stateFile, JSON.stringify(expected));

    const loaded = loadState(tmpDir);

    assert.equal(loaded.status, 'running');
    assert.equal(loaded.subsystems.length, 3);
  });

  it('saveState writes anatomy-park.json with updated counts', () => {
    const state = makeAnatomyState();
    state.subsystems[0].pass_count = 5;
    state.subsystems[0].consecutive_clean = 2;

    saveState(tmpDir, state);

    const stateFile = path.join(tmpDir, 'anatomy-park.json');
    const written = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
    assert.equal(written.subsystems[0].pass_count, 5);
    assert.equal(written.subsystems[0].consecutive_clean, 2);
  });

  it('saveState preserves all subsystem counters', () => {
    const state = makeAnatomyState({
      subsystems: [
        makeSubsystem('a', { pass_count: 3, consecutive_clean: 1, stall_count: 0 }),
        makeSubsystem('b', { pass_count: 0, consecutive_clean: 0, stall_count: 2 }),
      ],
    });

    saveState(tmpDir, state);

    const written = JSON.parse(fs.readFileSync(path.join(tmpDir, 'anatomy-park.json'), 'utf-8'));
    assert.equal(written.subsystems[0].pass_count, 3);
    assert.equal(written.subsystems[1].stall_count, 2);
  });
});

// ---------------------------------------------------------------------------
// 8. full-convergence — all converged → exit + commit
// ---------------------------------------------------------------------------
describe('full-convergence', () => {
  it('exits and commits when all subsystems converge', async () => {
    const forge = makeMockForge();
    const git = makeMockGit();
    const state = makeAnatomyState({
      subsystems: [
        makeSubsystem('lib', { consecutive_clean: 2 }),
        makeSubsystem('src', { consecutive_clean: 2 }),
        makeSubsystem('tests', { consecutive_clean: 2 }),
      ],
    });

    await runAnatomyPark({
      state,
      forge,
      git,
      targetDir: tmpDir,
      maxIterations: 10,
    });

    assert.equal(state.status, 'converged', 'status should be converged');
    assert.ok(git.commit.mock.callCount() > 0, 'should commit on full convergence');
  });

  it('isFullyConverged returns true when all subsystems are converged or stalled', () => {
    const state = makeAnatomyState({
      subsystems: [
        makeSubsystem('a', { consecutive_clean: 2 }),
        makeSubsystem('b', { stall_count: 3 }),
        makeSubsystem('c', { consecutive_clean: 5 }),
      ],
      stall_limit: 3,
    });

    assert.equal(isFullyConverged(state), true);
  });

  it('isFullyConverged returns false when any subsystem is active', () => {
    const state = makeAnatomyState({
      subsystems: [
        makeSubsystem('a', { consecutive_clean: 2 }),
        makeSubsystem('b', { consecutive_clean: 0, stall_count: 1 }),
      ],
      stall_limit: 3,
    });

    assert.equal(isFullyConverged(state), false);
  });
});

// ---------------------------------------------------------------------------
// 9. zero-findings — clean pass, rotate
// ---------------------------------------------------------------------------
describe('zero-findings', () => {
  it('increments consecutive_clean and rotates on zero tracer findings', async () => {
    const forge = makeMockForge({
      tracer: { findings: [] },
    });
    const git = makeMockGit();
    const sub = makeSubsystem('src', { consecutive_clean: 0 });
    const state = makeAnatomyState({
      subsystems: [sub, makeSubsystem('lib')],
      rotation_index: 0,
    });

    await runAnatomyPark({
      state,
      forge,
      git,
      targetDir: tmpDir,
      maxIterations: 1,
    });

    assert.equal(
      state.subsystems[0].consecutive_clean, 1,
      'consecutive_clean should increment on zero findings'
    );
    // Should NOT call surgeon or verifier when zero findings
    const surgeonCalls = forge.runAgent.mock.calls.filter(
      c => c.arguments[0] === 'anatomy-surgeon'
    );
    assert.equal(surgeonCalls.length, 0, 'surgeon should not run on zero findings');
  });

  it('rotates to next subsystem after clean pass', async () => {
    const forge = makeMockForge({
      tracer: { findings: [] },
    });
    const git = makeMockGit();
    const state = makeAnatomyState({
      subsystems: [makeSubsystem('src'), makeSubsystem('lib')],
      rotation_index: 0,
    });

    await runAnatomyPark({
      state,
      forge,
      git,
      targetDir: tmpDir,
      maxIterations: 1,
    });

    assert.equal(state.rotation_index, 1, 'rotation_index should advance after clean pass');
  });
});
