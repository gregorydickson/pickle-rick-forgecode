/**
 * StateManager — atomic, lock-protected state file operations.
 *
 * ESM module, Node built-in APIs only. Provides read (with schema migration +
 * crash recovery), update (with file-based lock), multi-file transaction (with
 * rollback), and forceWrite (best-effort, no lock — for signal/crash handlers).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Constants (PRD spec)
// ---------------------------------------------------------------------------
export const LOCK_ACQUIRE_TIMEOUT_MS = 5000;
export const STALE_LOCK_THRESHOLD_MS = 30000;
export const LOCK_RETRY_BACKOFF_BASE_MS = 50;

const DEFAULTS = {
  retryBaseMs: LOCK_RETRY_BACKOFF_BASE_MS,
  acquireTimeoutMs: LOCK_ACQUIRE_TIMEOUT_MS,
  staleLockTimeoutMs: STALE_LOCK_THRESHOLD_MS,
  lockJitter: true,
  schemaVersion: 1,
};

// ---------------------------------------------------------------------------
// Error hierarchy
// ---------------------------------------------------------------------------
export class StateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StateError';
    this.code = code;
  }
}

export class LockError extends StateError {
  constructor(message) {
    super('LOCK_FAILED', message);
    this.name = 'LockError';
  }
}

export class TransactionError extends StateError {
  constructor(message, rollbackErrors = []) {
    super('WRITE_FAILED', message);
    this.name = 'TransactionError';
    this.rollbackErrors = rollbackErrors;
  }
}

// ---------------------------------------------------------------------------
// Helpers (inlined — no external deps)
// ---------------------------------------------------------------------------
function lockPath(statePath) {
  return `${statePath}.lock`;
}

const _sleepBuf = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(ms) {
  Atomics.wait(_sleepBuf, 0, 0, ms);
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function safeErrorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}

function writeStateFile(filePath, state) {
  const tmp = `${filePath}.tmp.${process.pid}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* ignore cleanup failure */ }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// StateManager
// ---------------------------------------------------------------------------
export class StateManager {
  constructor(opts = {}) {
    this.opts = { ...DEFAULTS, ...opts };
  }

  // -----------------------------------------------------------------------
  // read — parse, migrate schema, run recovery protocol
  // -----------------------------------------------------------------------
  read(statePath) {
    if (!fs.existsSync(statePath)) {
      throw new StateError('MISSING', `State file not found: ${statePath}`);
    }

    let raw;
    try {
      raw = fs.readFileSync(statePath, 'utf-8');
    } catch (err) {
      throw new StateError('MISSING', `Cannot read state file: ${safeErrorMessage(err)}`);
    }

    let state;
    try {
      state = JSON.parse(raw);
    } catch (err) {
      throw new StateError('CORRUPT', `Invalid JSON in state file: ${safeErrorMessage(err)}`);
    }

    if (state === null || typeof state !== 'object' || Array.isArray(state)) {
      throw new StateError('CORRUPT', 'State file does not contain a JSON object');
    }

    // Schema migration
    if (state.schema_version === undefined) {
      state.schema_version = 1;
      process.stderr.write(`[state-manager] schema_version missing in ${statePath} — migrating to 1\n`);
      try { writeStateFile(statePath, state); } catch { /* migration write failed, non-fatal */ }
    }

    if (state.schema_version > this.opts.schemaVersion) {
      throw new StateError(
        'SCHEMA_MISMATCH',
        `State file schema_version ${state.schema_version} is newer than supported version ${this.opts.schemaVersion}`
      );
    }

    // Recovery protocols
    this._recoverOrphanTmpFiles(statePath, state);
    this._recoverStaleActiveFlag(statePath, state);

    return state;
  }

  // -----------------------------------------------------------------------
  // update — lock → read → mutate → write → unlock
  // -----------------------------------------------------------------------
  update(statePath, mutator) {
    this._acquireLock(statePath);
    try {
      const state = this.read(statePath);
      mutator(state);
      writeStateFile(statePath, state);
      return state;
    } finally {
      this._releaseLock(statePath);
    }
  }

  // -----------------------------------------------------------------------
  // transaction — multi-file atomic with deadlock prevention and rollback
  // -----------------------------------------------------------------------
  transaction(paths, mutator) {
    const sorted = [...paths].sort();
    const lockedPaths = [];

    try {
      for (const p of sorted) {
        this._acquireLock(p);
        lockedPaths.push(p);
      }
    } catch (err) {
      for (const p of lockedPaths) this._releaseLock(p);
      throw err;
    }

    try {
      const sortedStates = sorted.map(p => this.read(p));
      const callerStates = paths.map(p => sortedStates[sorted.indexOf(p)]);
      mutator(callerStates);

      // Backup originals for rollback
      const originals = sorted.map(p => ({ path: p, backup: fs.readFileSync(p, 'utf-8') }));
      const written = [];

      try {
        for (let i = 0; i < sorted.length; i++) {
          writeStateFile(sorted[i], sortedStates[i]);
          written.push(sorted[i]);
        }
      } catch (writeErr) {
        // Rollback previously written files
        const rollbackErrors = [];
        for (const wp of written) {
          const orig = originals.find(o => o.path === wp);
          if (orig) {
            try {
              writeStateFile(wp, JSON.parse(orig.backup));
            } catch (rbErr) {
              rollbackErrors.push(rbErr instanceof Error ? rbErr : new Error(String(rbErr)));
            }
          }
        }
        throw new TransactionError(`Transaction write failed: ${safeErrorMessage(writeErr)}`, rollbackErrors);
      }

      return callerStates;
    } finally {
      for (const p of lockedPaths) this._releaseLock(p);
    }
  }

  // -----------------------------------------------------------------------
  // forceWrite — best-effort, no lock, never throws
  // -----------------------------------------------------------------------
  forceWrite(statePath, state) {
    try {
      writeStateFile(statePath, state);
    } catch {
      // Best-effort — swallow all errors
    }
  }

  // -----------------------------------------------------------------------
  // Lock acquisition with exponential backoff + jitter
  // -----------------------------------------------------------------------
  _acquireLock(statePath) {
    const lp = lockPath(statePath);
    const deadline = Date.now() + this.opts.acquireTimeoutMs;
    let steals = 0;
    const maxSteals = 3;
    let attempt = 0;

    while (true) {
      try {
        const fd = fs.openSync(lp, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY);
        fs.writeSync(fd, JSON.stringify({ pid: process.pid, ts: Date.now() }));
        fs.closeSync(fd);
        return;
      } catch {
        if (steals < maxSteals && this._tryStealStaleLock(lp)) {
          steals++;
          continue;
        }

        if (Date.now() >= deadline) break;

        const base = this.opts.retryBaseMs * Math.pow(2, attempt);
        const jitter = this.opts.lockJitter ? Math.random() * this.opts.retryBaseMs : 0;
        const delay = Math.min(base + jitter, this.opts.acquireTimeoutMs);
        sleepSync(delay);
        attempt++;
      }
    }

    throw new LockError(`Failed to acquire lock: ${lp}`);
  }

  _releaseLock(statePath) {
    try { fs.unlinkSync(lockPath(statePath)); } catch { /* already gone */ }
  }

  _tryStealStaleLock(lp) {
    let raw;
    try { raw = fs.readFileSync(lp, 'utf-8'); } catch { return false; }

    if (!this._isLockStale(raw)) return false;

    // Atomic steal: rename to tombstone to prevent TOCTOU race
    const tombstone = `${lp}.tomb.${process.pid}.${Date.now()}`;
    try {
      fs.renameSync(lp, tombstone);
      try { fs.unlinkSync(tombstone); } catch { /* best-effort */ }
      return true;
    } catch {
      try { fs.unlinkSync(tombstone); } catch { /* might not exist */ }
      return false;
    }
  }

  _isLockStale(raw) {
    try {
      const lock = JSON.parse(raw);
      const lockPid = Number(lock.pid);
      const lockTs = Number(lock.ts);
      if (!Number.isFinite(lockPid) || !Number.isFinite(lockTs)) return true;
      return !isProcessAlive(lockPid) || (Date.now() - lockTs > this.opts.staleLockTimeoutMs);
    } catch {
      return true; // Corrupt JSON — safe to steal
    }
  }

  // -----------------------------------------------------------------------
  // Recovery: orphan tmp files
  // -----------------------------------------------------------------------
  _recoverOrphanTmpFiles(statePath, state) {
    const dir = path.dirname(statePath);
    const base = path.basename(statePath);

    let entries;
    try { entries = fs.readdirSync(dir); } catch { return; }

    const tmpPattern = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.tmp\\.(\\d+)$`);

    for (const entry of entries) {
      const match = entry.match(tmpPattern);
      if (!match) continue;

      const tmpPath = path.join(dir, entry);
      const tmpPid = Number(match[1]);

      if (Number.isFinite(tmpPid) && isProcessAlive(tmpPid)) continue;

      try {
        const raw = fs.readFileSync(tmpPath, 'utf-8');
        const tmpState = JSON.parse(raw);
        const tmpIter = Number(tmpState.iteration);
        const curIter = Number(state.iteration);

        if (Number.isFinite(tmpIter) && Number.isFinite(curIter) && tmpIter > curIter) {
          fs.renameSync(tmpPath, statePath);
          Object.assign(state, JSON.parse(fs.readFileSync(statePath, 'utf-8')));
        } else {
          fs.unlinkSync(tmpPath);
        }
      } catch {
        try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      }
    }
  }

  // -----------------------------------------------------------------------
  // Recovery: stale active flag
  // -----------------------------------------------------------------------
  _recoverStaleActiveFlag(statePath, state) {
    if (state.active !== true) return;
    if (state.pid === undefined || state.pid === null) return;

    const pid = Number(state.pid);
    if (!Number.isFinite(pid) || pid <= 0) return;

    if (!isProcessAlive(pid)) {
      state.active = false;
      try { writeStateFile(statePath, state); } catch { /* best-effort */ }
    }
  }
}
