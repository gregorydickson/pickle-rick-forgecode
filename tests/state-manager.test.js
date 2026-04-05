import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { StateManager, StateError, LockError, TransactionError,
  LOCK_ACQUIRE_TIMEOUT_MS, STALE_LOCK_THRESHOLD_MS, LOCK_RETRY_BACKOFF_BASE_MS
} from '../lib/state-manager.js';

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeJSON(filePath, obj) {
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2));
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
describe('constants', () => {
  it('exports PRD lock constants', () => {
    assert.equal(LOCK_ACQUIRE_TIMEOUT_MS, 5000);
    assert.equal(STALE_LOCK_THRESHOLD_MS, 30000);
    assert.equal(LOCK_RETRY_BACKOFF_BASE_MS, 50);
  });
});

// ---------------------------------------------------------------------------
// Error hierarchy
// ---------------------------------------------------------------------------
describe('error hierarchy', () => {
  it('StateError has code property', () => {
    const err = new StateError('MISSING', 'not found');
    assert.equal(err.code, 'MISSING');
    assert.equal(err.name, 'StateError');
    assert(err instanceof Error);
  });

  it('LockError extends StateError with LOCK_FAILED code', () => {
    const err = new LockError('timeout');
    assert.equal(err.code, 'LOCK_FAILED');
    assert.equal(err.name, 'LockError');
    assert(err instanceof StateError);
    assert(err instanceof Error);
  });

  it('TransactionError extends StateError with rollbackErrors', () => {
    const rbErrs = [new Error('rb1')];
    const err = new TransactionError('write failed', rbErrs);
    assert.equal(err.code, 'WRITE_FAILED');
    assert.equal(err.name, 'TransactionError');
    assert.deepEqual(err.rollbackErrors, rbErrs);
    assert(err instanceof StateError);
  });
});

// ---------------------------------------------------------------------------
// read()
// ---------------------------------------------------------------------------
describe('read', () => {
  it('reads valid JSON state file', () => {
    const fp = path.join(tmpDir, 'state.json');
    writeJSON(fp, { iteration: 1, schema_version: 1 });
    const sm = new StateManager();
    const state = sm.read(fp);
    assert.equal(state.iteration, 1);
    assert.equal(state.schema_version, 1);
  });

  it('throws MISSING for nonexistent file', () => {
    const sm = new StateManager();
    assert.throws(() => sm.read(path.join(tmpDir, 'nope.json')), (err) => {
      assert(err instanceof StateError);
      assert.equal(err.code, 'MISSING');
      return true;
    });
  });

  it('throws CORRUPT for invalid JSON', () => {
    const fp = path.join(tmpDir, 'bad.json');
    fs.writeFileSync(fp, '{broken');
    const sm = new StateManager();
    assert.throws(() => sm.read(fp), (err) => {
      assert(err instanceof StateError);
      assert.equal(err.code, 'CORRUPT');
      return true;
    });
  });

  it('throws CORRUPT for non-object JSON (array)', () => {
    const fp = path.join(tmpDir, 'arr.json');
    writeJSON(fp, [1, 2, 3]);
    const sm = new StateManager();
    assert.throws(() => sm.read(fp), (err) => {
      assert.equal(err.code, 'CORRUPT');
      return true;
    });
  });

  it('throws CORRUPT for null JSON', () => {
    const fp = path.join(tmpDir, 'null.json');
    fs.writeFileSync(fp, 'null');
    const sm = new StateManager();
    assert.throws(() => sm.read(fp), (err) => {
      assert.equal(err.code, 'CORRUPT');
      return true;
    });
  });
});

// ---------------------------------------------------------------------------
// Schema migration
// ---------------------------------------------------------------------------
describe('schema migration', () => {
  it('adds schema_version=1 if missing', () => {
    const fp = path.join(tmpDir, 'state.json');
    writeJSON(fp, { iteration: 3 });
    const sm = new StateManager();
    const state = sm.read(fp);
    assert.equal(state.schema_version, 1);
    // Verify persisted
    const ondisk = JSON.parse(fs.readFileSync(fp, 'utf-8'));
    assert.equal(ondisk.schema_version, 1);
  });

  it('rejects future schema version', () => {
    const fp = path.join(tmpDir, 'state.json');
    writeJSON(fp, { schema_version: 999 });
    const sm = new StateManager();
    assert.throws(() => sm.read(fp), (err) => {
      assert(err instanceof StateError);
      assert.equal(err.code, 'SCHEMA_MISMATCH');
      return true;
    });
  });

  it('accepts current schema version', () => {
    const fp = path.join(tmpDir, 'state.json');
    writeJSON(fp, { schema_version: 1, data: 'ok' });
    const sm = new StateManager();
    const state = sm.read(fp);
    assert.equal(state.data, 'ok');
  });

  it('accepts past schema versions', () => {
    const fp = path.join(tmpDir, 'state.json');
    writeJSON(fp, { schema_version: 1, data: 'ok' });
    const sm = new StateManager({ schemaVersion: 2 });
    const state = sm.read(fp);
    assert.equal(state.schema_version, 1);
  });
});

// ---------------------------------------------------------------------------
// Lock acquisition and release
// ---------------------------------------------------------------------------
describe('lock acquisition and release', () => {
  it('creates lock file on update and removes it after', () => {
    const fp = path.join(tmpDir, 'state.json');
    writeJSON(fp, { schema_version: 1, count: 0 });
    const sm = new StateManager();
    sm.update(fp, (s) => { s.count = 1; });
    // Lock should be released
    assert.equal(fs.existsSync(`${fp}.lock`), false);
    // State should be updated
    const state = JSON.parse(fs.readFileSync(fp, 'utf-8'));
    assert.equal(state.count, 1);
  });

  it('releases lock even if mutator throws', () => {
    const fp = path.join(tmpDir, 'state.json');
    writeJSON(fp, { schema_version: 1, v: 1 });
    const sm = new StateManager();
    assert.throws(() => {
      sm.update(fp, () => { throw new Error('boom'); });
    });
    assert.equal(fs.existsSync(`${fp}.lock`), false);
  });
});

// ---------------------------------------------------------------------------
// Concurrent update detection (lock contention)
// ---------------------------------------------------------------------------
describe('concurrent update detection', () => {
  it('blocks when lock is held by another live process', () => {
    const fp = path.join(tmpDir, 'state.json');
    writeJSON(fp, { schema_version: 1, v: 0 });
    const lockFp = `${fp}.lock`;
    // Create a lock held by current process (alive PID) with fresh timestamp
    fs.writeFileSync(lockFp, JSON.stringify({ pid: process.pid, ts: Date.now() }),
      { flag: fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY });
    // With very short timeout, should fail to acquire
    const sm = new StateManager({ acquireTimeoutMs: 200, retryBaseMs: 50, lockJitter: false });
    assert.throws(() => {
      sm.update(fp, (s) => { s.v = 1; });
    }, (err) => {
      assert(err instanceof LockError);
      return true;
    });
    // Clean up
    fs.unlinkSync(lockFp);
  });
});

// ---------------------------------------------------------------------------
// Orphan .tmp promotion (crash recovery)
// ---------------------------------------------------------------------------
describe('orphan .tmp promotion', () => {
  it('promotes orphan tmp with higher iteration from dead PID', () => {
    const fp = path.join(tmpDir, 'state.json');
    writeJSON(fp, { schema_version: 1, iteration: 5 });
    // Simulate crashed write: tmp file from dead PID with higher iteration
    const deadPid = 99999;
    const tmpFile = `${path.basename(fp)}.tmp.${deadPid}`;
    writeJSON(path.join(tmpDir, tmpFile), { schema_version: 1, iteration: 7, recovered: true });
    const sm = new StateManager();
    const state = sm.read(fp);
    assert.equal(state.iteration, 7);
    assert.equal(state.recovered, true);
    // Tmp file should be gone (promoted via rename)
    assert.equal(fs.existsSync(path.join(tmpDir, tmpFile)), false);
  });

  it('deletes orphan tmp with lower iteration', () => {
    const fp = path.join(tmpDir, 'state.json');
    writeJSON(fp, { schema_version: 1, iteration: 10 });
    const deadPid = 99999;
    const tmpFile = `${path.basename(fp)}.tmp.${deadPid}`;
    writeJSON(path.join(tmpDir, tmpFile), { schema_version: 1, iteration: 3 });
    const sm = new StateManager();
    sm.read(fp);
    assert.equal(fs.existsSync(path.join(tmpDir, tmpFile)), false);
  });

  it('leaves tmp from alive PID alone', () => {
    const fp = path.join(tmpDir, 'state.json');
    writeJSON(fp, { schema_version: 1, iteration: 5 });
    // Tmp file from current process (alive)
    const tmpFile = `${path.basename(fp)}.tmp.${process.pid}`;
    const tmpPath = path.join(tmpDir, tmpFile);
    writeJSON(tmpPath, { schema_version: 1, iteration: 8 });
    const sm = new StateManager();
    sm.read(fp);
    // Should still exist — PID is alive
    assert.equal(fs.existsSync(tmpPath), true);
  });

  it('deletes orphan tmp with invalid JSON', () => {
    const fp = path.join(tmpDir, 'state.json');
    writeJSON(fp, { schema_version: 1, iteration: 5 });
    const deadPid = 99999;
    const tmpFile = `${path.basename(fp)}.tmp.${deadPid}`;
    fs.writeFileSync(path.join(tmpDir, tmpFile), '{corrupt');
    const sm = new StateManager();
    sm.read(fp);
    assert.equal(fs.existsSync(path.join(tmpDir, tmpFile)), false);
  });
});

// ---------------------------------------------------------------------------
// Stale PID detection (active=true but PID dead)
// ---------------------------------------------------------------------------
describe('stale PID detection', () => {
  it('clears active flag when PID is dead', () => {
    const fp = path.join(tmpDir, 'state.json');
    writeJSON(fp, { schema_version: 1, active: true, pid: 99999 });
    const sm = new StateManager();
    const state = sm.read(fp);
    assert.equal(state.active, false);
    // Verify persisted
    const ondisk = JSON.parse(fs.readFileSync(fp, 'utf-8'));
    assert.equal(ondisk.active, false);
  });

  it('keeps active flag when PID is alive', () => {
    const fp = path.join(tmpDir, 'state.json');
    writeJSON(fp, { schema_version: 1, active: true, pid: process.pid });
    const sm = new StateManager();
    const state = sm.read(fp);
    assert.equal(state.active, true);
  });

  it('ignores active flag when no PID', () => {
    const fp = path.join(tmpDir, 'state.json');
    writeJSON(fp, { schema_version: 1, active: true });
    const sm = new StateManager();
    const state = sm.read(fp);
    assert.equal(state.active, true);
  });
});

// ---------------------------------------------------------------------------
// Transaction rollback on error
// ---------------------------------------------------------------------------
describe('transaction', () => {
  it('atomically updates multiple files', () => {
    const fp1 = path.join(tmpDir, 'a.json');
    const fp2 = path.join(tmpDir, 'b.json');
    writeJSON(fp1, { schema_version: 1, v: 1 });
    writeJSON(fp2, { schema_version: 1, v: 2 });
    const sm = new StateManager();
    const [s1, s2] = sm.transaction([fp1, fp2], ([a, b]) => {
      a.v = 10;
      b.v = 20;
    });
    assert.equal(s1.v, 10);
    assert.equal(s2.v, 20);
    // Verify on disk
    assert.equal(JSON.parse(fs.readFileSync(fp1, 'utf-8')).v, 10);
    assert.equal(JSON.parse(fs.readFileSync(fp2, 'utf-8')).v, 20);
    // Locks released
    assert.equal(fs.existsSync(`${fp1}.lock`), false);
    assert.equal(fs.existsSync(`${fp2}.lock`), false);
  });

  it('returns states in original path order (not sorted)', () => {
    const fpA = path.join(tmpDir, 'z.json');
    const fpB = path.join(tmpDir, 'a.json');
    writeJSON(fpA, { schema_version: 1, name: 'z' });
    writeJSON(fpB, { schema_version: 1, name: 'a' });
    const sm = new StateManager();
    const [s1, s2] = sm.transaction([fpA, fpB], ([z, a]) => {
      z.touched = true;
      a.touched = true;
    });
    // Despite internal sort, return order matches input
    assert.equal(s1.name, 'z');
    assert.equal(s2.name, 'a');
  });

  it('passes states to mutator in caller-specified order, not sorted (transaction-ordering)', () => {
    // z.json sorts AFTER a.json, so if mutator gets sorted order,
    // the first arg would be a-state, not z-state
    const fpZ = path.join(tmpDir, 'z.json');
    const fpA = path.join(tmpDir, 'a.json');
    writeJSON(fpZ, { schema_version: 1, name: 'z', val: 0 });
    writeJSON(fpA, { schema_version: 1, name: 'a', val: 0 });
    const sm = new StateManager();
    sm.transaction([fpZ, fpA], ([first, second]) => {
      // Asymmetric mutation: first should be z-state, second should be a-state
      first.val = 'set_by_first';
      second.val = 'set_by_second';
    });
    // Verify on disk: z.json should have val from first, a.json from second
    const zDisk = JSON.parse(fs.readFileSync(fpZ, 'utf-8'));
    const aDisk = JSON.parse(fs.readFileSync(fpA, 'utf-8'));
    assert.equal(zDisk.val, 'set_by_first', 'z.json should be mutated by first arg');
    assert.equal(aDisk.val, 'set_by_second', 'a.json should be mutated by second arg');
  });

  it('acquires locks in sorted order for deadlock prevention (transaction-lock-order)', () => {
    const fpZ = path.join(tmpDir, 'z.json');
    const fpA = path.join(tmpDir, 'a.json');
    writeJSON(fpZ, { schema_version: 1, name: 'z' });
    writeJSON(fpA, { schema_version: 1, name: 'a' });
    const sm = new StateManager();
    const lockOrder = [];
    const origAcquire = sm._acquireLock.bind(sm);
    sm._acquireLock = (p) => { lockOrder.push(p); return origAcquire(p); };
    sm.transaction([fpZ, fpA], () => {});
    // Locks must be acquired in sorted (alphabetical) order regardless of caller order
    assert.deepEqual(lockOrder, [fpA, fpZ], 'locks should be acquired in sorted path order');
  });

  it('rolls back on write failure and throws TransactionError', () => {
    const fp1 = path.join(tmpDir, 'a.json');
    const fp2 = path.join(tmpDir, 'b.json');
    writeJSON(fp1, { schema_version: 1, v: 'original_a' });
    writeJSON(fp2, { schema_version: 1, v: 'original_b' });
    const sm = new StateManager();
    // Make fp2's directory read-only AFTER read but we need a different approach
    // Instead, we test rollback by using a mutator that produces a circular ref for the second file
    // Actually, let's make the second write path a directory to force EISDIR
    const fpBad = path.join(tmpDir, 'c.json');
    writeJSON(fp1, { schema_version: 1, v: 'before' });
    writeJSON(fpBad, { schema_version: 1, v: 'before_bad' });
    // Replace fpBad with a directory to force write failure
    fs.unlinkSync(fpBad);
    fs.mkdirSync(fpBad);
    // But read needs it to be a file... let's use a different approach
    fs.rmdirSync(fpBad);
    // Use circular reference to force JSON.stringify failure
    writeJSON(fp1, { schema_version: 1, v: 'before' });
    writeJSON(fp2, { schema_version: 1, v: 'before_b' });

    assert.throws(() => {
      sm.transaction([fp1, fp2], ([a, b]) => {
        a.v = 'changed_a';
        // Create circular reference — JSON.stringify will throw
        const circ = {};
        circ.self = circ;
        b.circular = circ;
      });
    }, (err) => {
      assert(err instanceof TransactionError);
      return true;
    });

    // fp1 should be rolled back to original
    const a = JSON.parse(fs.readFileSync(fp1, 'utf-8'));
    assert.equal(a.v, 'before');
  });

  it('releases all locks on mutator error', () => {
    const fp1 = path.join(tmpDir, 'a.json');
    const fp2 = path.join(tmpDir, 'b.json');
    writeJSON(fp1, { schema_version: 1 });
    writeJSON(fp2, { schema_version: 1 });
    const sm = new StateManager();
    assert.throws(() => {
      sm.transaction([fp1, fp2], () => { throw new Error('mutator exploded'); });
    });
    assert.equal(fs.existsSync(`${fp1}.lock`), false);
    assert.equal(fs.existsSync(`${fp2}.lock`), false);
  });
});

// ---------------------------------------------------------------------------
// forceWrite (no lock, never throws)
// ---------------------------------------------------------------------------
describe('forceWrite', () => {
  it('writes state without lock', () => {
    const fp = path.join(tmpDir, 'force.json');
    const sm = new StateManager();
    sm.forceWrite(fp, { schema_version: 1, forced: true });
    const state = JSON.parse(fs.readFileSync(fp, 'utf-8'));
    assert.equal(state.forced, true);
    assert.equal(fs.existsSync(`${fp}.lock`), false);
  });

  it('never throws even on write failure', () => {
    const sm = new StateManager();
    // Write to a path that can't exist (directory as file)
    assert.doesNotThrow(() => {
      sm.forceWrite('/dev/null/impossible/path.json', { v: 1 });
    });
  });

  it('overwrites existing file', () => {
    const fp = path.join(tmpDir, 'force.json');
    writeJSON(fp, { schema_version: 1, v: 1 });
    const sm = new StateManager();
    sm.forceWrite(fp, { schema_version: 1, v: 2 });
    const state = JSON.parse(fs.readFileSync(fp, 'utf-8'));
    assert.equal(state.v, 2);
  });
});

// ---------------------------------------------------------------------------
// Lock timeout with exponential backoff + jitter
// ---------------------------------------------------------------------------
describe('lock timeout with backoff', () => {
  it('times out when lock cannot be acquired', () => {
    const fp = path.join(tmpDir, 'state.json');
    writeJSON(fp, { schema_version: 1 });
    const lockFp = `${fp}.lock`;
    // Hold lock with alive PID and fresh timestamp
    fs.writeFileSync(lockFp, JSON.stringify({ pid: process.pid, ts: Date.now() }),
      { flag: fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY });
    const sm = new StateManager({ acquireTimeoutMs: 300, retryBaseMs: 50, lockJitter: false });
    const start = Date.now();
    assert.throws(() => {
      sm.update(fp, (s) => { s.v = 1; });
    }, (err) => {
      assert(err instanceof LockError);
      return true;
    });
    const elapsed = Date.now() - start;
    // Should have spent some time retrying (at least a few attempts)
    assert(elapsed >= 100, `Expected at least 100ms of retries, got ${elapsed}ms`);
    fs.unlinkSync(lockFp);
  });
});

// ---------------------------------------------------------------------------
// Stale lock threshold auto-cleanup
// ---------------------------------------------------------------------------
describe('stale lock auto-cleanup', () => {
  it('steals lock from dead PID', () => {
    const fp = path.join(tmpDir, 'state.json');
    writeJSON(fp, { schema_version: 1, v: 0 });
    const lockFp = `${fp}.lock`;
    // Lock held by dead PID
    fs.writeFileSync(lockFp, JSON.stringify({ pid: 99999, ts: Date.now() }),
      { flag: fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY });
    const sm = new StateManager();
    // Should steal the stale lock and succeed
    sm.update(fp, (s) => { s.v = 42; });
    const state = JSON.parse(fs.readFileSync(fp, 'utf-8'));
    assert.equal(state.v, 42);
    assert.equal(fs.existsSync(lockFp), false);
  });

  it('steals lock older than stale threshold', () => {
    const fp = path.join(tmpDir, 'state.json');
    writeJSON(fp, { schema_version: 1, v: 0 });
    const lockFp = `${fp}.lock`;
    // Lock from alive PID but very old timestamp
    fs.writeFileSync(lockFp,
      JSON.stringify({ pid: process.pid, ts: Date.now() - 60_000 }),
      { flag: fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY });
    const sm = new StateManager({ staleLockTimeoutMs: 30_000 });
    sm.update(fp, (s) => { s.v = 99; });
    const state = JSON.parse(fs.readFileSync(fp, 'utf-8'));
    assert.equal(state.v, 99);
  });

  it('steals lock with corrupt JSON', () => {
    const fp = path.join(tmpDir, 'state.json');
    writeJSON(fp, { schema_version: 1, v: 0 });
    const lockFp = `${fp}.lock`;
    fs.writeFileSync(lockFp, '{garbage',
      { flag: fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY });
    const sm = new StateManager();
    sm.update(fp, (s) => { s.v = 7; });
    assert.equal(JSON.parse(fs.readFileSync(fp, 'utf-8')).v, 7);
  });
});

// ---------------------------------------------------------------------------
// update() returns updated state
// ---------------------------------------------------------------------------
describe('update', () => {
  it('returns the mutated state', () => {
    const fp = path.join(tmpDir, 'state.json');
    writeJSON(fp, { schema_version: 1, count: 0 });
    const sm = new StateManager();
    const result = sm.update(fp, (s) => { s.count = 5; });
    assert.equal(result.count, 5);
  });
});

// ---------------------------------------------------------------------------
// Atomic write verification
// ---------------------------------------------------------------------------
describe('atomic writes', () => {
  it('writes atomically via tmp+rename (no partial writes on disk)', () => {
    const fp = path.join(tmpDir, 'state.json');
    writeJSON(fp, { schema_version: 1, v: 'original' });
    const sm = new StateManager();
    sm.update(fp, (s) => { s.v = 'updated'; });
    // After update, no tmp files should remain
    const files = fs.readdirSync(tmpDir);
    const tmps = files.filter(f => f.includes('.tmp.'));
    assert.equal(tmps.length, 0, `Unexpected tmp files: ${tmps.join(', ')}`);
    // State should be valid JSON
    const state = JSON.parse(fs.readFileSync(fp, 'utf-8'));
    assert.equal(state.v, 'updated');
  });
});
