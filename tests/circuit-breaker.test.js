import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  CircuitBreaker,
  DEFAULT_CONFIG,
  normalizeErrorSignature,
} from '../lib/circuit-breaker.js';

let tmpDir;
let cbPath;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-test-'));
  cbPath = path.join(tmpDir, 'circuit_breaker.json');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Helper: create a CircuitBreaker with optional config overrides */
function makeCB(configOverrides = {}) {
  return new CircuitBreaker(cbPath, configOverrides);
}

/** Helper: no-progress signal set (everything unchanged from defaults) */
function noProgressSignals(overrides = {}) {
  return {
    headSha: 'abc123',
    step: 'implement',
    ticket: 'T-1',
    hasUncommittedChanges: false,
    hasStagedChanges: false,
    error: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// closed-to-halfopen
// ---------------------------------------------------------------------------
describe('closed-to-halfopen', () => {
  it('transitions CLOSED -> HALF_OPEN after halfOpenAfter no-progress iterations', () => {
    const cb = makeCB({ halfOpenAfter: 2, noProgressThreshold: 5 });
    const signals = noProgressSignals();

    cb.recordIteration(signals);
    assert.equal(cb.getState().state, 'CLOSED');

    cb.recordIteration(signals);
    assert.equal(cb.getState().state, 'HALF_OPEN');
  });

  it('stays CLOSED while progress is detected', () => {
    const cb = makeCB({ halfOpenAfter: 2 });

    cb.recordIteration(noProgressSignals({ headSha: 'sha1' }));
    assert.equal(cb.getState().state, 'CLOSED');

    // Different HEAD = progress
    cb.recordIteration(noProgressSignals({ headSha: 'sha2' }));
    assert.equal(cb.getState().state, 'CLOSED');

    // Same HEAD again = no progress iteration 1
    cb.recordIteration(noProgressSignals({ headSha: 'sha2' }));
    assert.equal(cb.getState().state, 'CLOSED');

    // Same HEAD = no progress iteration 2 -> HALF_OPEN
    cb.recordIteration(noProgressSignals({ headSha: 'sha2' }));
    assert.equal(cb.getState().state, 'HALF_OPEN');
  });

  it('resets no-progress counter on progress', () => {
    const cb = makeCB({ halfOpenAfter: 3 });

    // 2 no-progress iterations
    cb.recordIteration(noProgressSignals());
    cb.recordIteration(noProgressSignals());
    assert.equal(cb.getState().consecutive_no_progress, 2);

    // Progress via HEAD change
    cb.recordIteration(noProgressSignals({ headSha: 'new-sha' }));
    assert.equal(cb.getState().consecutive_no_progress, 0);
    assert.equal(cb.getState().state, 'CLOSED');
  });
});

// ---------------------------------------------------------------------------
// halfopen-to-open
// ---------------------------------------------------------------------------
describe('halfopen-to-open', () => {
  it('transitions HALF_OPEN -> OPEN after noProgressThreshold reached', () => {
    const cb = makeCB({ halfOpenAfter: 2, noProgressThreshold: 4 });
    const signals = noProgressSignals();

    // Get to HALF_OPEN (2 no-progress)
    cb.recordIteration(signals);
    cb.recordIteration(signals);
    assert.equal(cb.getState().state, 'HALF_OPEN');

    // 2 more no-progress (total 4 = noProgressThreshold)
    cb.recordIteration(signals);
    assert.equal(cb.getState().state, 'HALF_OPEN');

    cb.recordIteration(signals);
    assert.equal(cb.getState().state, 'OPEN');
  });

  it('transitions HALF_OPEN -> OPEN when sameErrorThreshold reached', () => {
    const cb = makeCB({ halfOpenAfter: 2, noProgressThreshold: 10, sameErrorThreshold: 3 });
    const sameError = 'TypeError: cannot read property x';

    // Get to HALF_OPEN
    cb.recordIteration(noProgressSignals({ error: sameError }));
    cb.recordIteration(noProgressSignals({ error: sameError }));
    assert.equal(cb.getState().state, 'HALF_OPEN');

    // Same error again -> sameErrorThreshold hit (3 consecutive same error)
    cb.recordIteration(noProgressSignals({ error: sameError }));
    assert.equal(cb.getState().state, 'OPEN');
  });

  it('increments total_opens on each OPEN transition', () => {
    const cb = makeCB({ halfOpenAfter: 2, noProgressThreshold: 3 });
    const signals = noProgressSignals();

    // First open
    cb.recordIteration(signals);
    cb.recordIteration(signals);
    cb.recordIteration(signals);
    assert.equal(cb.getState().state, 'OPEN');
    assert.equal(cb.getState().total_opens, 1);

    // Reset and trigger again
    cb.reset();
    cb.recordIteration(signals);
    cb.recordIteration(signals);
    cb.recordIteration(signals);
    assert.equal(cb.getState().total_opens, 2);
  });
});

// ---------------------------------------------------------------------------
// recovery
// ---------------------------------------------------------------------------
describe('recovery', () => {
  function getToHalfOpen(cb) {
    cb.recordIteration(noProgressSignals());
    cb.recordIteration(noProgressSignals());
    assert.equal(cb.getState().state, 'HALF_OPEN');
  }

  it('HALF_OPEN -> CLOSED on HEAD SHA change', () => {
    const cb = makeCB({ halfOpenAfter: 2 });
    getToHalfOpen(cb);

    cb.recordIteration(noProgressSignals({ headSha: 'new-sha' }));
    assert.equal(cb.getState().state, 'CLOSED');
  });

  it('HALF_OPEN -> CLOSED on step change', () => {
    const cb = makeCB({ halfOpenAfter: 2 });
    getToHalfOpen(cb);

    cb.recordIteration(noProgressSignals({ step: 'review' }));
    assert.equal(cb.getState().state, 'CLOSED');
  });

  it('HALF_OPEN -> CLOSED on ticket change', () => {
    const cb = makeCB({ halfOpenAfter: 2 });
    getToHalfOpen(cb);

    cb.recordIteration(noProgressSignals({ ticket: 'T-2' }));
    assert.equal(cb.getState().state, 'CLOSED');
  });

  it('HALF_OPEN -> CLOSED on uncommitted changes', () => {
    const cb = makeCB({ halfOpenAfter: 2 });
    getToHalfOpen(cb);

    cb.recordIteration(noProgressSignals({ hasUncommittedChanges: true }));
    assert.equal(cb.getState().state, 'CLOSED');
  });

  it('HALF_OPEN -> CLOSED on staged changes', () => {
    const cb = makeCB({ halfOpenAfter: 2 });
    getToHalfOpen(cb);

    cb.recordIteration(noProgressSignals({ hasStagedChanges: true }));
    assert.equal(cb.getState().state, 'CLOSED');
  });

  it('resets consecutive counters on recovery', () => {
    const cb = makeCB({ halfOpenAfter: 2 });
    getToHalfOpen(cb);

    cb.recordIteration(noProgressSignals({ headSha: 'new-sha' }));
    const state = cb.getState();
    assert.equal(state.state, 'CLOSED');
    assert.equal(state.consecutive_no_progress, 0);
    assert.equal(state.consecutive_same_error, 0);
  });
});

// ---------------------------------------------------------------------------
// open-blocks
// ---------------------------------------------------------------------------
describe('open-blocks', () => {
  it('canExecute() returns false in OPEN state', () => {
    const cb = makeCB({ halfOpenAfter: 2, noProgressThreshold: 3 });
    const signals = noProgressSignals();

    assert.equal(cb.canExecute(), true);

    cb.recordIteration(signals);
    cb.recordIteration(signals);
    cb.recordIteration(signals);
    assert.equal(cb.getState().state, 'OPEN');
    assert.equal(cb.canExecute(), false);
  });

  it('canExecute() returns true in CLOSED state', () => {
    const cb = makeCB();
    assert.equal(cb.canExecute(), true);
  });

  it('canExecute() returns true in HALF_OPEN state', () => {
    const cb = makeCB({ halfOpenAfter: 2 });
    cb.recordIteration(noProgressSignals());
    cb.recordIteration(noProgressSignals());
    assert.equal(cb.getState().state, 'HALF_OPEN');
    assert.equal(cb.canExecute(), true);
  });
});

// ---------------------------------------------------------------------------
// 5-signal progress detection
// ---------------------------------------------------------------------------
describe('5-signal progress detection', () => {
  it('signal 1: uncommitted changes = progress', () => {
    const cb = makeCB({ halfOpenAfter: 2 });
    cb.recordIteration(noProgressSignals());
    assert.equal(cb.getState().consecutive_no_progress, 1);

    cb.recordIteration(noProgressSignals({ hasUncommittedChanges: true }));
    assert.equal(cb.getState().consecutive_no_progress, 0);
  });

  it('signal 2: staged changes = progress', () => {
    const cb = makeCB({ halfOpenAfter: 2 });
    cb.recordIteration(noProgressSignals());
    cb.recordIteration(noProgressSignals({ hasStagedChanges: true }));
    assert.equal(cb.getState().consecutive_no_progress, 0);
  });

  it('signal 3: HEAD SHA changed = progress', () => {
    const cb = makeCB({ halfOpenAfter: 2 });
    cb.recordIteration(noProgressSignals({ headSha: 'sha1' }));
    cb.recordIteration(noProgressSignals({ headSha: 'sha2' }));
    assert.equal(cb.getState().consecutive_no_progress, 0);
  });

  it('signal 4: step changed = progress', () => {
    const cb = makeCB({ halfOpenAfter: 2 });
    cb.recordIteration(noProgressSignals({ step: 'research' }));
    cb.recordIteration(noProgressSignals({ step: 'implement' }));
    assert.equal(cb.getState().consecutive_no_progress, 0);
  });

  it('signal 5: ticket changed = progress', () => {
    const cb = makeCB({ halfOpenAfter: 2 });
    cb.recordIteration(noProgressSignals({ ticket: 'T-1' }));
    cb.recordIteration(noProgressSignals({ ticket: 'T-2' }));
    assert.equal(cb.getState().consecutive_no_progress, 0);
  });

  it('no signals changed = no progress', () => {
    const cb = makeCB({ halfOpenAfter: 5, noProgressThreshold: 10 });
    cb.recordIteration(noProgressSignals());
    cb.recordIteration(noProgressSignals());
    cb.recordIteration(noProgressSignals());
    assert.equal(cb.getState().consecutive_no_progress, 3);
  });
});

// ---------------------------------------------------------------------------
// error-signature-normalization
// ---------------------------------------------------------------------------
describe('error-signature-normalization', () => {
  it('normalizes absolute paths to <PATH>', () => {
    const result = normalizeErrorSignature('Error in /Users/rick/morty/file.js at line 42');
    assert(result.includes('<PATH>'));
    assert(!result.includes('/Users/rick'));
  });

  it('normalizes ISO timestamps to <TS>', () => {
    const result = normalizeErrorSignature('Error at 2026-04-05T14:30:00.000Z in module');
    assert(result.includes('<TS>'));
    assert(!result.includes('2026-04-05'));
  });

  it('normalizes Unix epoch timestamps to <TS>', () => {
    const result = normalizeErrorSignature('Timeout at 1712345678901ms');
    assert(result.includes('<TS>'));
  });

  it('truncates to 200 characters', () => {
    const longMsg = 'E'.repeat(300);
    const result = normalizeErrorSignature(longMsg);
    assert.equal(result.length, 200);
  });

  it('handles null/undefined gracefully', () => {
    assert.equal(normalizeErrorSignature(null), null);
    assert.equal(normalizeErrorSignature(undefined), null);
  });

  it('consecutive_same_error increments when normalized signatures match', () => {
    const cb = makeCB({ halfOpenAfter: 10, noProgressThreshold: 20, sameErrorThreshold: 10 });
    const error1 = 'Error in /Users/rick/a.js at line 1';
    const error2 = 'Error in /Users/morty/b.js at line 1';
    // Both normalize to same: "Error in <PATH> at line 1"
    cb.recordIteration(noProgressSignals({ error: error1 }));
    cb.recordIteration(noProgressSignals({ error: error2 }));
    assert.equal(cb.getState().consecutive_same_error, 2);
  });

  it('consecutive_same_error resets on different normalized signature', () => {
    const cb = makeCB({ halfOpenAfter: 10, noProgressThreshold: 20, sameErrorThreshold: 10 });
    cb.recordIteration(noProgressSignals({ error: 'Error A' }));
    cb.recordIteration(noProgressSignals({ error: 'Error B' }));
    assert.equal(cb.getState().consecutive_same_error, 1);
  });

  it('consecutive_same_error resets when no error', () => {
    const cb = makeCB({ halfOpenAfter: 10, noProgressThreshold: 20 });
    cb.recordIteration(noProgressSignals({ error: 'some error' }));
    assert.equal(cb.getState().consecutive_same_error, 1);
    cb.recordIteration(noProgressSignals({ error: null }));
    assert.equal(cb.getState().consecutive_same_error, 0);
  });
});

// ---------------------------------------------------------------------------
// configurable-thresholds
// ---------------------------------------------------------------------------
describe('configurable-thresholds', () => {
  it('respects custom noProgressThreshold', () => {
    const cb = makeCB({ halfOpenAfter: 2, noProgressThreshold: 3 });
    const signals = noProgressSignals();
    cb.recordIteration(signals);
    cb.recordIteration(signals);
    cb.recordIteration(signals);
    assert.equal(cb.getState().state, 'OPEN');
  });

  it('respects custom sameErrorThreshold', () => {
    const cb = makeCB({ halfOpenAfter: 2, noProgressThreshold: 20, sameErrorThreshold: 3 });
    const signals = noProgressSignals({ error: 'same error' });
    // 2 iterations -> HALF_OPEN (halfOpenAfter=2), same error count=2
    cb.recordIteration(signals);
    cb.recordIteration(signals);
    assert.equal(cb.getState().state, 'HALF_OPEN');
    // 3rd same error in HALF_OPEN -> OPEN (sameErrorThreshold=3)
    cb.recordIteration(signals);
    assert.equal(cb.getState().state, 'OPEN');
  });

  it('respects custom halfOpenAfter', () => {
    const cb = makeCB({ halfOpenAfter: 4, noProgressThreshold: 10 });
    const signals = noProgressSignals();
    cb.recordIteration(signals);
    cb.recordIteration(signals);
    cb.recordIteration(signals);
    assert.equal(cb.getState().state, 'CLOSED');

    cb.recordIteration(signals);
    assert.equal(cb.getState().state, 'HALF_OPEN');
  });

  it('uses defaults when no config provided', () => {
    const cb = makeCB();
    assert.equal(cb.config.noProgressThreshold, DEFAULT_CONFIG.noProgressThreshold);
    assert.equal(cb.config.sameErrorThreshold, DEFAULT_CONFIG.sameErrorThreshold);
    assert.equal(cb.config.halfOpenAfter, DEFAULT_CONFIG.halfOpenAfter);
    assert.equal(cb.config.enabled, DEFAULT_CONFIG.enabled);
  });
});

// ---------------------------------------------------------------------------
// config-validation
// ---------------------------------------------------------------------------
describe('config-validation', () => {
  it('rejects noProgressThreshold < 2', () => {
    assert.throws(() => makeCB({ noProgressThreshold: 1 }), /noProgressThreshold/);
  });

  it('rejects sameErrorThreshold < 2', () => {
    assert.throws(() => makeCB({ sameErrorThreshold: 1 }), /sameErrorThreshold/);
  });

  it('rejects halfOpenAfter >= noProgressThreshold', () => {
    assert.throws(() => makeCB({ halfOpenAfter: 5, noProgressThreshold: 5 }), /halfOpenAfter/);
  });

  it('rejects halfOpenAfter < 1', () => {
    assert.throws(() => makeCB({ halfOpenAfter: 0 }), /halfOpenAfter/);
  });

  it('accepts valid edge-case config', () => {
    assert.doesNotThrow(() => makeCB({ halfOpenAfter: 2, noProgressThreshold: 3, sameErrorThreshold: 2 }));
  });
});

// ---------------------------------------------------------------------------
// history-audit-trail
// ---------------------------------------------------------------------------
describe('history-audit-trail', () => {
  it('records transition in history', () => {
    const cb = makeCB({ halfOpenAfter: 2 });
    cb.recordIteration(noProgressSignals());
    cb.recordIteration(noProgressSignals());

    const state = cb.getState();
    assert.equal(state.state, 'HALF_OPEN');
    assert(state.history.length > 0);

    const transition = state.history.find(h => h.to === 'HALF_OPEN');
    assert(transition);
    assert.equal(transition.from, 'CLOSED');
    assert.equal(transition.to, 'HALF_OPEN');
    assert(typeof transition.timestamp === 'number');
  });

  it('caps history at 1000 entries', () => {
    const cb = makeCB({ halfOpenAfter: 2, noProgressThreshold: 3 });

    // Rapidly cycle through states to generate history entries
    for (let i = 0; i < 600; i++) {
      // Trigger open
      cb.recordIteration(noProgressSignals());
      cb.recordIteration(noProgressSignals());
      cb.recordIteration(noProgressSignals());
      // Reset to do it again
      cb.reset();
    }

    const state = cb.getState();
    assert(state.history.length <= 1000, `History length ${state.history.length} exceeds 1000`);
  });

  it('drops oldest entries when capped', () => {
    const cb = makeCB({ halfOpenAfter: 2, noProgressThreshold: 3 });

    for (let i = 0; i < 600; i++) {
      cb.recordIteration(noProgressSignals());
      cb.recordIteration(noProgressSignals());
      cb.recordIteration(noProgressSignals());
      cb.reset();
    }

    const state = cb.getState();
    // Most recent entries should be present
    const lastEntry = state.history[state.history.length - 1];
    assert(lastEntry);
    assert(typeof lastEntry.timestamp === 'number');
  });
});

// ---------------------------------------------------------------------------
// corrupt-state
// ---------------------------------------------------------------------------
describe('corrupt-state', () => {
  it('treats corrupt state file as CLOSED (fail-open)', () => {
    fs.writeFileSync(cbPath, '{corrupt json!!!');
    const cb = makeCB();
    assert.equal(cb.canExecute(), true);
    assert.equal(cb.getState().state, 'CLOSED');
  });

  it('treats missing state file as CLOSED', () => {
    const cb = makeCB();
    assert.equal(cb.canExecute(), true);
    assert.equal(cb.getState().state, 'CLOSED');
  });
});

// ---------------------------------------------------------------------------
// reset
// ---------------------------------------------------------------------------
describe('reset', () => {
  it('resets to initial CLOSED state', () => {
    const cb = makeCB({ halfOpenAfter: 2, noProgressThreshold: 3 });
    cb.recordIteration(noProgressSignals());
    cb.recordIteration(noProgressSignals());
    cb.recordIteration(noProgressSignals());
    assert.equal(cb.getState().state, 'OPEN');

    cb.reset();
    const state = cb.getState();
    assert.equal(state.state, 'CLOSED');
    assert.equal(state.consecutive_no_progress, 0);
    assert.equal(state.consecutive_same_error, 0);
    assert.equal(state.last_error_signature, null);
  });

  it('preserves total_opens and history after reset', () => {
    const cb = makeCB({ halfOpenAfter: 2, noProgressThreshold: 3 });
    cb.recordIteration(noProgressSignals());
    cb.recordIteration(noProgressSignals());
    cb.recordIteration(noProgressSignals());
    assert.equal(cb.getState().total_opens, 1);

    cb.reset();
    assert.equal(cb.getState().total_opens, 1);
    assert(cb.getState().history.length > 0);
  });
});

// ---------------------------------------------------------------------------
// getState
// ---------------------------------------------------------------------------
describe('getState', () => {
  it('returns a snapshot of current state', () => {
    const cb = makeCB();
    const state = cb.getState();
    assert.equal(state.state, 'CLOSED');
    assert.equal(state.consecutive_no_progress, 0);
    assert.equal(state.consecutive_same_error, 0);
    assert.equal(state.last_error_signature, null);
    assert.equal(state.total_opens, 0);
    assert(Array.isArray(state.history));
  });

  it('returns a copy, not a reference', () => {
    const cb = makeCB();
    const state1 = cb.getState();
    state1.state = 'OPEN';
    const state2 = cb.getState();
    assert.equal(state2.state, 'CLOSED');
  });
});

// ---------------------------------------------------------------------------
// disabled
// ---------------------------------------------------------------------------
describe('disabled', () => {
  it('canExecute() always returns true when disabled', () => {
    const cb = makeCB({ enabled: false, halfOpenAfter: 2, noProgressThreshold: 3 });
    cb.recordIteration(noProgressSignals());
    cb.recordIteration(noProgressSignals());
    cb.recordIteration(noProgressSignals());
    // State internally transitions to OPEN, but canExecute still returns true
    assert.equal(cb.getState().state, 'OPEN');
    assert.equal(cb.canExecute(), true);
  });
});

// ---------------------------------------------------------------------------
// persistence
// ---------------------------------------------------------------------------
describe('persistence', () => {
  it('persists state across instances', () => {
    const cb1 = makeCB({ halfOpenAfter: 2 });
    cb1.recordIteration(noProgressSignals(), 1);
    cb1.recordIteration(noProgressSignals(), 2);
    assert.equal(cb1.getState().state, 'HALF_OPEN');

    // New instance reading same file
    const cb2 = makeCB({ halfOpenAfter: 2 });
    assert.equal(cb2.getState().state, 'HALF_OPEN');
    assert.equal(cb2.getState().consecutive_no_progress, 2);
  });
});

// ---------------------------------------------------------------------------
// iteration-tracking
// ---------------------------------------------------------------------------
describe('iteration-tracking', () => {
  it('recordIteration(signals, iteration) stores actual iteration number', () => {
    const cb = makeCB({ halfOpenAfter: 5, noProgressThreshold: 10 });

    // First call sets last_known_head but no progress (head was empty)
    cb.recordIteration(noProgressSignals({ headSha: 'sha1' }), 1);
    assert.equal(cb.getState().last_progress_iteration, 0);

    // HEAD change = progress at iteration 2
    cb.recordIteration(noProgressSignals({ headSha: 'sha2' }), 2);
    assert.equal(cb.getState().last_progress_iteration, 2);

    // No progress on iteration 3 — last_progress_iteration stays 2
    cb.recordIteration(noProgressSignals({ headSha: 'sha2' }), 3);
    assert.equal(cb.getState().last_progress_iteration, 2);

    // Progress again on iteration 5 (skipped 4)
    cb.recordIteration(noProgressSignals({ headSha: 'sha3' }), 5);
    assert.equal(cb.getState().last_progress_iteration, 5);
  });

  it('does not increment last_progress_iteration as counter', () => {
    const cb = makeCB({ halfOpenAfter: 5, noProgressThreshold: 10 });

    // Seed head sha
    cb.recordIteration(noProgressSignals({ headSha: 'sha0' }), 1);

    // Progress at iteration 10
    cb.recordIteration(noProgressSignals({ headSha: 'sha1' }), 10);
    assert.equal(cb.getState().last_progress_iteration, 10);

    // Progress at iteration 20 — should be 20, not 11
    cb.recordIteration(noProgressSignals({ headSha: 'sha2' }), 20);
    assert.equal(cb.getState().last_progress_iteration, 20);
  });
});

// ---------------------------------------------------------------------------
// history-iteration
// ---------------------------------------------------------------------------
describe('history-iteration', () => {
  it('history entries record the actual iteration number, not consecutive_no_progress', () => {
    const cb = makeCB({ halfOpenAfter: 2, noProgressThreshold: 5 });

    // Iterations 10 and 11: no progress -> HALF_OPEN at iteration 11
    cb.recordIteration(noProgressSignals(), 10);
    cb.recordIteration(noProgressSignals(), 11);
    assert.equal(cb.getState().state, 'HALF_OPEN');

    const history = cb.getState().history;
    const transition = history.find(h => h.to === 'HALF_OPEN');
    assert(transition);
    // Should be 11 (the actual iteration), not 2 (consecutive_no_progress)
    assert.equal(transition.iteration, 11);
  });

  it('HALF_OPEN -> CLOSED history records correct iteration', () => {
    const cb = makeCB({ halfOpenAfter: 2 });
    cb.recordIteration(noProgressSignals(), 1);
    cb.recordIteration(noProgressSignals(), 2);
    assert.equal(cb.getState().state, 'HALF_OPEN');

    // Recovery at iteration 7
    cb.recordIteration(noProgressSignals({ headSha: 'new-sha' }), 7);
    assert.equal(cb.getState().state, 'CLOSED');

    const recovery = cb.getState().history.find(h => h.to === 'CLOSED');
    assert.equal(recovery.iteration, 7);
  });

  it('HALF_OPEN -> OPEN history records correct iteration', () => {
    const cb = makeCB({ halfOpenAfter: 2, noProgressThreshold: 4 });
    cb.recordIteration(noProgressSignals(), 3);
    cb.recordIteration(noProgressSignals(), 4);
    cb.recordIteration(noProgressSignals(), 5);
    cb.recordIteration(noProgressSignals(), 6);
    assert.equal(cb.getState().state, 'OPEN');

    const openTransition = cb.getState().history.find(h => h.to === 'OPEN');
    assert.equal(openTransition.iteration, 6);
  });
});

// ---------------------------------------------------------------------------
// progress-iteration
// ---------------------------------------------------------------------------
describe('progress-iteration', () => {
  it('last_progress_iteration reflects the last iteration with progress', () => {
    const cb = makeCB({ halfOpenAfter: 10, noProgressThreshold: 20 });

    // Seed head sha — no progress (head was empty)
    cb.recordIteration(noProgressSignals({ headSha: 'sha0' }), 0);
    assert.equal(cb.getState().last_progress_iteration, 0);

    // Progress at iteration 1 (head changed)
    cb.recordIteration(noProgressSignals({ headSha: 'sha1' }), 1);
    assert.equal(cb.getState().last_progress_iteration, 1);

    // No progress iterations 2-4
    cb.recordIteration(noProgressSignals({ headSha: 'sha1' }), 2);
    cb.recordIteration(noProgressSignals({ headSha: 'sha1' }), 3);
    cb.recordIteration(noProgressSignals({ headSha: 'sha1' }), 4);
    assert.equal(cb.getState().last_progress_iteration, 1);

    // Progress again at iteration 5
    cb.recordIteration(noProgressSignals({ headSha: 'sha2' }), 5);
    assert.equal(cb.getState().last_progress_iteration, 5);

    // No progress 6-8
    cb.recordIteration(noProgressSignals({ headSha: 'sha2' }), 6);
    cb.recordIteration(noProgressSignals({ headSha: 'sha2' }), 7);
    cb.recordIteration(noProgressSignals({ headSha: 'sha2' }), 8);
    assert.equal(cb.getState().last_progress_iteration, 5);
  });

  it('last_progress_iteration stays 0 when no progress ever occurs', () => {
    const cb = makeCB({ halfOpenAfter: 3, noProgressThreshold: 5 });
    cb.recordIteration(noProgressSignals(), 1);
    cb.recordIteration(noProgressSignals(), 2);
    assert.equal(cb.getState().last_progress_iteration, 0);
  });
});
