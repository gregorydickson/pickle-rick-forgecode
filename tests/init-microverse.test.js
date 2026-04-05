import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// These imports will fail until implementation exists
import {
  parseInitArgs,
  validateArgs,
  buildMicroverseState,
  initMicroverse,
} from '../bin/init-microverse.js';

import { StateManager } from '../lib/state-manager.js';

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'init-mv-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const VALID_METRIC = JSON.stringify({
  description: 'test coverage',
  validation: 'npm test -- --coverage | tail -1',
  type: 'command',
});

// ---------------------------------------------------------------------------
// parseInitArgs
// ---------------------------------------------------------------------------
describe('parseInitArgs', () => {
  it('extracts session-dir and target-path from positionals', () => {
    const args = parseInitArgs(['./session', './src']);
    assert.equal(args.sessionDir, './session');
    assert.equal(args.targetPath, './src');
  });

  it('parses --stall-limit with default 3', () => {
    const args = parseInitArgs(['./s', './t']);
    assert.equal(args.stallLimit, 3);
  });

  it('parses --stall-limit override', () => {
    const args = parseInitArgs(['./s', './t', '--stall-limit', '7']);
    assert.equal(args.stallLimit, 7);
  });

  it('parses --convergence-target with default null', () => {
    const args = parseInitArgs(['./s', './t']);
    assert.equal(args.convergenceTarget, null);
  });

  it('parses --convergence-target override', () => {
    const args = parseInitArgs(['./s', './t', '--convergence-target', '95']);
    assert.equal(args.convergenceTarget, 95);
  });

  it('parses --convergence-mode with default metric', () => {
    const args = parseInitArgs(['./s', './t']);
    assert.equal(args.convergenceMode, 'metric');
  });

  it('parses --convergence-mode override', () => {
    const args = parseInitArgs(['./s', './t', '--convergence-mode', 'worker']);
    assert.equal(args.convergenceMode, 'worker');
  });

  it('parses --convergence-file with default null', () => {
    const args = parseInitArgs(['./s', './t']);
    assert.equal(args.convergenceFile, null);
  });

  it('parses --convergence-file override', () => {
    const args = parseInitArgs(['./s', './t', '--convergence-file', 'anatomy-park.json']);
    assert.equal(args.convergenceFile, 'anatomy-park.json');
  });

  it('parses --metric-json as string', () => {
    const args = parseInitArgs(['./s', './t', '--metric-json', VALID_METRIC]);
    assert.equal(args.metricJson, VALID_METRIC);
  });
});

// ---------------------------------------------------------------------------
// validateArgs
// ---------------------------------------------------------------------------
describe('validateArgs', () => {
  it('rejects missing session-dir', () => {
    const result = validateArgs({ targetPath: './t', convergenceMode: 'worker' });
    assert.equal(result.valid, false);
    assert.match(result.error, /session.dir/i);
  });

  it('rejects missing target-path', () => {
    const result = validateArgs({ sessionDir: './s', convergenceMode: 'worker' });
    assert.equal(result.valid, false);
    assert.match(result.error, /target.path/i);
  });

  it('rejects invalid convergence-mode', () => {
    const result = validateArgs({
      sessionDir: './s', targetPath: './t',
      convergenceMode: 'invalid', stallLimit: 3,
    });
    assert.equal(result.valid, false);
    assert.match(result.error, /convergence.mode/i);
  });

  it('rejects metric mode without --metric-json', () => {
    const result = validateArgs({
      sessionDir: './s', targetPath: './t',
      convergenceMode: 'metric', stallLimit: 3,
    });
    assert.equal(result.valid, false);
    assert.match(result.error, /metric.json/i);
  });

  it('rejects invalid metric-json (not valid JSON)', () => {
    const result = validateArgs({
      sessionDir: './s', targetPath: './t',
      convergenceMode: 'metric', stallLimit: 3,
      metricJson: '{broken',
    });
    assert.equal(result.valid, false);
    assert.match(result.error, /json/i);
  });

  it('rejects metric-json missing description', () => {
    const result = validateArgs({
      sessionDir: './s', targetPath: './t',
      convergenceMode: 'metric', stallLimit: 3,
      metricJson: JSON.stringify({ validation: 'x', type: 'command' }),
    });
    assert.equal(result.valid, false);
    assert.match(result.error, /description/i);
  });

  it('rejects metric-json missing validation', () => {
    const result = validateArgs({
      sessionDir: './s', targetPath: './t',
      convergenceMode: 'metric', stallLimit: 3,
      metricJson: JSON.stringify({ description: 'x', type: 'command' }),
    });
    assert.equal(result.valid, false);
    assert.match(result.error, /validation/i);
  });

  it('rejects metric-json missing type', () => {
    const result = validateArgs({
      sessionDir: './s', targetPath: './t',
      convergenceMode: 'metric', stallLimit: 3,
      metricJson: JSON.stringify({ description: 'x', validation: 'x' }),
    });
    assert.equal(result.valid, false);
    assert.match(result.error, /type/i);
  });

  it('rejects invalid metric type', () => {
    const result = validateArgs({
      sessionDir: './s', targetPath: './t',
      convergenceMode: 'metric', stallLimit: 3,
      metricJson: JSON.stringify({ description: 'x', validation: 'x', type: 'bogus' }),
    });
    assert.equal(result.valid, false);
    assert.match(result.error, /type/i);
  });

  it('rejects non-positive stall-limit', () => {
    const result = validateArgs({
      sessionDir: './s', targetPath: './t',
      convergenceMode: 'worker', stallLimit: 0,
    });
    assert.equal(result.valid, false);
    assert.match(result.error, /stall.limit/i);
  });

  it('rejects negative stall-limit', () => {
    const result = validateArgs({
      sessionDir: './s', targetPath: './t',
      convergenceMode: 'worker', stallLimit: -1,
    });
    assert.equal(result.valid, false);
    assert.match(result.error, /stall.limit/i);
  });

  it('accepts worker mode without metric-json', () => {
    const result = validateArgs({
      sessionDir: './s', targetPath: './t',
      convergenceMode: 'worker', stallLimit: 3,
    });
    assert.equal(result.valid, true);
  });

  it('accepts valid metric mode args', () => {
    const result = validateArgs({
      sessionDir: './s', targetPath: './t',
      convergenceMode: 'metric', stallLimit: 3,
      metricJson: VALID_METRIC,
    });
    assert.equal(result.valid, true);
  });
});

// ---------------------------------------------------------------------------
// buildMicroverseState
// ---------------------------------------------------------------------------
describe('buildMicroverseState', () => {
  it('returns status=gap_analysis', () => {
    const state = buildMicroverseState({
      sessionDir: './s', targetPath: './t',
      convergenceMode: 'metric', stallLimit: 3,
      metricJson: VALID_METRIC,
    });
    assert.equal(state.status, 'gap_analysis');
  });

  it('includes schema_version=1', () => {
    const state = buildMicroverseState({
      sessionDir: './s', targetPath: './t',
      convergenceMode: 'metric', stallLimit: 3,
      metricJson: VALID_METRIC,
    });
    assert.equal(state.schema_version, 1);
  });

  it('includes empty history', () => {
    const state = buildMicroverseState({
      sessionDir: './s', targetPath: './t',
      convergenceMode: 'metric', stallLimit: 3,
      metricJson: VALID_METRIC,
    });
    assert.deepEqual(state.convergence.history, []);
  });

  it('includes empty failed_approaches', () => {
    const state = buildMicroverseState({
      sessionDir: './s', targetPath: './t',
      convergenceMode: 'metric', stallLimit: 3,
      metricJson: VALID_METRIC,
    });
    assert.deepEqual(state.failed_approaches, []);
  });

  it('sets convergence.stall_limit from args', () => {
    const state = buildMicroverseState({
      sessionDir: './s', targetPath: './t',
      convergenceMode: 'metric', stallLimit: 7,
      metricJson: VALID_METRIC,
    });
    assert.equal(state.convergence.stall_limit, 7);
  });

  it('sets convergence.stall_counter to 0', () => {
    const state = buildMicroverseState({
      sessionDir: './s', targetPath: './t',
      convergenceMode: 'metric', stallLimit: 3,
      metricJson: VALID_METRIC,
    });
    assert.equal(state.convergence.stall_counter, 0);
  });

  it('parses metric config into key_metric', () => {
    const state = buildMicroverseState({
      sessionDir: './s', targetPath: './t',
      convergenceMode: 'metric', stallLimit: 3,
      metricJson: VALID_METRIC,
    });
    assert.equal(state.key_metric.description, 'test coverage');
    assert.equal(state.key_metric.type, 'command');
    assert.equal(state.key_metric.validation, 'npm test -- --coverage | tail -1');
  });

  it('sets convergence_target from args', () => {
    const state = buildMicroverseState({
      sessionDir: './s', targetPath: './t',
      convergenceMode: 'metric', stallLimit: 3,
      convergenceTarget: 95,
      metricJson: VALID_METRIC,
    });
    assert.equal(state.convergence_target, 95);
  });

  it('sets convergence_target null when not provided', () => {
    const state = buildMicroverseState({
      sessionDir: './s', targetPath: './t',
      convergenceMode: 'metric', stallLimit: 3,
      metricJson: VALID_METRIC,
    });
    assert.equal(state.convergence_target, null);
  });

  it('sets convergence_mode from args', () => {
    const state = buildMicroverseState({
      sessionDir: './s', targetPath: './t',
      convergenceMode: 'worker', stallLimit: 3,
    });
    assert.equal(state.convergence_mode, 'worker');
  });

  it('sets convergence_file from args', () => {
    const state = buildMicroverseState({
      sessionDir: './s', targetPath: './t',
      convergenceMode: 'worker', stallLimit: 3,
      convergenceFile: 'anatomy-park.json',
    });
    assert.equal(state.convergence_file, 'anatomy-park.json');
  });

  it('sets baseline_score=0 and exit_reason=null', () => {
    const state = buildMicroverseState({
      sessionDir: './s', targetPath: './t',
      convergenceMode: 'metric', stallLimit: 3,
      metricJson: VALID_METRIC,
    });
    assert.equal(state.baseline_score, 0);
    assert.equal(state.exit_reason, null);
  });

  it('sets prd_path=null and gap_analysis_path=null', () => {
    const state = buildMicroverseState({
      sessionDir: './s', targetPath: './t',
      convergenceMode: 'metric', stallLimit: 3,
      metricJson: VALID_METRIC,
    });
    assert.equal(state.prd_path, null);
    assert.equal(state.gap_analysis_path, null);
  });

  it('stores target_path in state', () => {
    const state = buildMicroverseState({
      sessionDir: './s', targetPath: './src',
      convergenceMode: 'metric', stallLimit: 3,
      metricJson: VALID_METRIC,
    });
    assert.equal(state.target_path, './src');
  });

  it('sets key_metric=null for worker mode without metric-json', () => {
    const state = buildMicroverseState({
      sessionDir: './s', targetPath: './t',
      convergenceMode: 'worker', stallLimit: 3,
    });
    assert.equal(state.key_metric, null);
  });
});

// ---------------------------------------------------------------------------
// initMicroverse (integration)
// ---------------------------------------------------------------------------
describe('initMicroverse', () => {
  it('creates microverse.json in session-dir', () => {
    const sessionDir = path.join(tmpDir, 'session');
    initMicroverse({
      sessionDir, targetPath: './src',
      convergenceMode: 'worker', stallLimit: 3,
    });
    assert.equal(fs.existsSync(path.join(sessionDir, 'microverse.json')), true);
  });

  it('written file is valid JSON readable by StateManager', () => {
    const sessionDir = path.join(tmpDir, 'session');
    initMicroverse({
      sessionDir, targetPath: './src',
      convergenceMode: 'metric', stallLimit: 5,
      metricJson: VALID_METRIC,
    });
    const sm = new StateManager();
    const state = sm.read(path.join(sessionDir, 'microverse.json'));
    assert.equal(state.schema_version, 1);
    assert.equal(state.status, 'gap_analysis');
  });

  it('all expected fields present in written file', () => {
    const sessionDir = path.join(tmpDir, 'session');
    initMicroverse({
      sessionDir, targetPath: './src',
      convergenceMode: 'metric', stallLimit: 3,
      convergenceTarget: 95,
      metricJson: VALID_METRIC,
    });
    const raw = JSON.parse(fs.readFileSync(path.join(sessionDir, 'microverse.json'), 'utf-8'));
    assert.equal(raw.status, 'gap_analysis');
    assert.equal(raw.schema_version, 1);
    assert.equal(raw.convergence_target, 95);
    assert.equal(raw.convergence_mode, 'metric');
    assert.equal(raw.baseline_score, 0);
    assert.equal(raw.exit_reason, null);
    assert.equal(raw.target_path, './src');
    assert.deepEqual(raw.convergence.history, []);
    assert.deepEqual(raw.failed_approaches, []);
    assert.equal(raw.convergence.stall_limit, 3);
    assert.equal(raw.convergence.stall_counter, 0);
    assert.equal(raw.key_metric.description, 'test coverage');
  });

  it('creates session-dir if it does not exist', () => {
    const sessionDir = path.join(tmpDir, 'deep', 'nested', 'session');
    initMicroverse({
      sessionDir, targetPath: './src',
      convergenceMode: 'worker', stallLimit: 3,
    });
    assert.equal(fs.existsSync(path.join(sessionDir, 'microverse.json')), true);
  });
});
