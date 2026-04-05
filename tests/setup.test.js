import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseSetupArgs, createSession, resumeSession, resetSession } from '../bin/setup.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
let tmpDir;

function freshTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'setup-test-'));
}

function readJSON(fp) {
  return JSON.parse(fs.readFileSync(fp, 'utf-8'));
}

// ---------------------------------------------------------------------------
// parseSetupArgs
// ---------------------------------------------------------------------------
describe('parseSetupArgs', () => {
  it('returns defaults when no flags given', () => {
    const args = parseSetupArgs([]);
    assert.equal(args.task, undefined);
    assert.equal(args.tmux, false);
    assert.equal(args.maxIterations, 100);
    assert.equal(args.maxTime, 720);
    assert.equal(args.workerTimeout, 1200);
    assert.equal(args.resume, undefined);
    assert.equal(args.reset, false);
  });

  it('parses --task with value', () => {
    const args = parseSetupArgs(['--task', 'implement feature X']);
    assert.equal(args.task, 'implement feature X');
  });

  it('parses --tmux as boolean', () => {
    const args = parseSetupArgs(['--tmux']);
    assert.equal(args.tmux, true);
  });

  it('parses --max-iterations', () => {
    const args = parseSetupArgs(['--max-iterations', '50']);
    assert.equal(args.maxIterations, 50);
  });

  it('parses --max-time', () => {
    const args = parseSetupArgs(['--max-time', '360']);
    assert.equal(args.maxTime, 360);
  });

  it('parses --worker-timeout', () => {
    const args = parseSetupArgs(['--worker-timeout', '600']);
    assert.equal(args.workerTimeout, 600);
  });

  it('parses --resume with path', () => {
    const args = parseSetupArgs(['--resume', '/tmp/sessions/2026-01-01-abc']);
    assert.equal(args.resume, '/tmp/sessions/2026-01-01-abc');
  });

  it('parses --reset as boolean', () => {
    const args = parseSetupArgs(['--reset']);
    assert.equal(args.reset, true);
  });

  it('parses combined flags', () => {
    const args = parseSetupArgs([
      '--task', 'build widget',
      '--tmux',
      '--max-iterations', '25',
      '--max-time', '120',
      '--worker-timeout', '300',
    ]);
    assert.equal(args.task, 'build widget');
    assert.equal(args.tmux, true);
    assert.equal(args.maxIterations, 25);
    assert.equal(args.maxTime, 120);
    assert.equal(args.workerTimeout, 300);
  });
});

// ---------------------------------------------------------------------------
// createSession
// ---------------------------------------------------------------------------
describe('createSession', () => {
  beforeEach(() => { tmpDir = freshTmp(); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('creates session directory under root', () => {
    const args = { task: 'test task', tmux: false, maxIterations: 100, maxTime: 720, workerTimeout: 1200 };
    const sessionRoot = createSession(args, tmpDir);
    assert.ok(fs.existsSync(sessionRoot));
    assert.ok(fs.statSync(sessionRoot).isDirectory());
  });

  it('session dir matches date-hash pattern', () => {
    const args = { task: 'test task', tmux: false, maxIterations: 100, maxTime: 720, workerTimeout: 1200 };
    const sessionRoot = createSession(args, tmpDir);
    const dirName = path.basename(sessionRoot);
    // Pattern: YYYY-MM-DD-<8hex>
    assert.match(dirName, /^\d{4}-\d{2}-\d{2}-[a-f0-9]{8}$/);
  });

  it('writes state.json with correct schema fields', () => {
    const args = { task: 'test task', tmux: true, maxIterations: 50, maxTime: 360, workerTimeout: 600 };
    const sessionRoot = createSession(args, tmpDir);
    const state = readJSON(path.join(sessionRoot, 'state.json'));

    assert.equal(state.schema_version, 1);
    assert.equal(state.active, true);
    assert.equal(typeof state.pid, 'number');
    assert.equal(state.iteration, 0);
    assert.equal(state.max_iterations, 50);
    assert.equal(state.step, 'research');
    assert.equal(state.working_dir, process.cwd());
    assert.equal(state.start_time_epoch > 0, true);
    assert.equal(state.max_time_minutes, 360);
    assert.deepEqual(state.history, []);
    assert.equal(state.session_dir, sessionRoot);
    assert.equal(state.tmux_mode, true);
    assert.equal(state.worker_timeout_sec, 600);
    assert.equal(state.task, 'test task');
  });

  it('returns the session root path', () => {
    const args = { task: 'hi', tmux: false, maxIterations: 100, maxTime: 720, workerTimeout: 1200 };
    const sessionRoot = createSession(args, tmpDir);
    assert.equal(typeof sessionRoot, 'string');
    assert.ok(sessionRoot.startsWith(tmpDir));
  });

  it('creates sessions subdir if root has no sessions folder', () => {
    const args = { task: 'test', tmux: false, maxIterations: 100, maxTime: 720, workerTimeout: 1200 };
    const sessionRoot = createSession(args, tmpDir);
    // Session root should be under tmpDir/sessions/
    const rel = path.relative(tmpDir, sessionRoot);
    assert.ok(rel.startsWith('sessions'));
  });
});

// ---------------------------------------------------------------------------
// resumeSession
// ---------------------------------------------------------------------------
describe('resumeSession', () => {
  beforeEach(() => { tmpDir = freshTmp(); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('reads existing session state.json', () => {
    const sessionDir = path.join(tmpDir, 'sessions', '2026-01-01-aabbccdd');
    fs.mkdirSync(sessionDir, { recursive: true });
    const state = { schema_version: 1, active: false, iteration: 5 };
    fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify(state));

    const result = resumeSession(sessionDir);
    assert.equal(result.iteration, 5);
  });

  it('throws on missing state.json', () => {
    const sessionDir = path.join(tmpDir, 'sessions', '2026-01-01-aabbccdd');
    fs.mkdirSync(sessionDir, { recursive: true });

    assert.throws(() => resumeSession(sessionDir), /state\.json not found/);
  });

  it('throws on non-existent directory', () => {
    assert.throws(() => resumeSession('/tmp/nonexistent-session-xyz'), /not found|does not exist/i);
  });
});

// ---------------------------------------------------------------------------
// resetSession
// ---------------------------------------------------------------------------
describe('resetSession', () => {
  beforeEach(() => { tmpDir = freshTmp(); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('resets iteration, active, and step fields', () => {
    const sessionDir = path.join(tmpDir, 'sessions', '2026-01-01-aabbccdd');
    fs.mkdirSync(sessionDir, { recursive: true });
    const state = {
      schema_version: 1,
      active: false,
      iteration: 15,
      step: 'refactor',
      max_iterations: 100,
      task: 'original task',
    };
    fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify(state));

    const result = resetSession(sessionDir);
    assert.equal(result.iteration, 0);
    assert.equal(result.active, true);
    assert.equal(result.step, 'research');
    // Preserves non-reset fields
    assert.equal(result.max_iterations, 100);
    assert.equal(result.task, 'original task');
  });

  it('updates start_time_epoch on reset', () => {
    const sessionDir = path.join(tmpDir, 'sessions', '2026-01-01-aabbccdd');
    fs.mkdirSync(sessionDir, { recursive: true });
    const oldEpoch = Date.now() - 100000;
    const state = { schema_version: 1, active: false, iteration: 5, start_time_epoch: oldEpoch };
    fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify(state));

    const result = resetSession(sessionDir);
    assert.ok(result.start_time_epoch > oldEpoch);
  });

  it('writes reset state back to disk', () => {
    const sessionDir = path.join(tmpDir, 'sessions', '2026-01-01-aabbccdd');
    fs.mkdirSync(sessionDir, { recursive: true });
    const state = { schema_version: 1, active: false, iteration: 10, step: 'implement' };
    fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify(state));

    resetSession(sessionDir);
    const ondisk = readJSON(path.join(sessionDir, 'state.json'));
    assert.equal(ondisk.iteration, 0);
    assert.equal(ondisk.active, true);
    assert.equal(ondisk.step, 'research');
  });
});
