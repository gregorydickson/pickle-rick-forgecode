/**
 * GitUtils — thin wrappers around git CLI commands via execSync.
 *
 * Used by tmux-runner and microverse-runner for SHA tracking,
 * rollback, worktree management, and diff stats.
 * ESM module, zero dependencies.
 */
import { execSync as _defaultExec } from 'node:child_process';

const RUN_OPTS = { encoding: 'utf-8' };
const SHA_RE = /^[0-9a-f]{4,40}$/i;

let _exec = _defaultExec;

/** Replace the exec function (for testing). Returns a restore function. */
export function _setExec(fn) {
  const prev = _exec;
  _exec = fn;
  return () => { _exec = prev; };
}

/** Validate a git SHA (hex only, 4-40 chars). Throws on invalid input. */
export function validateSha(sha) {
  if (!SHA_RE.test(sha)) {
    throw new Error(`Invalid SHA: ${sha}`);
  }
}

/** Shell-quote a string using single quotes. */
export function shellQuote(s) {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

export function getCurrentSha(opts) {
  const execOpts = opts?.cwd ? { ...RUN_OPTS, cwd: opts.cwd } : RUN_OPTS;
  return _exec('git rev-parse HEAD', execOpts).trim();
}

export function isDirty() {
  try {
    const out = _exec('git status --porcelain', RUN_OPTS);
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

export function autoCommit(message) {
  if (!isDirty()) return null;
  _exec('git add -u', RUN_OPTS);
  _exec(`git commit -m ${JSON.stringify(message)}`, RUN_OPTS);
  return _exec('git rev-parse HEAD', RUN_OPTS).trim();
}

export function stash() {
  const out = _exec('git stash', RUN_OPTS).trim();
  if (out.startsWith('No local changes') || out === '') return null;
  return 'stash@{0}';
}

export function resetToSha(sha) {
  validateSha(sha);
  const stashRef = stash();
  _exec(`git reset --hard ${sha}`, RUN_OPTS);
  _exec('git clean -fd', RUN_OPTS);
  return { stashRef };
}

export function getDiffStat() {
  return _exec('git diff --stat', RUN_OPTS).trim();
}

export function getStagedDiffStat() {
  return _exec('git diff --cached --stat', RUN_OPTS).trim();
}

export function createWorktree(worktreePath, branch) {
  _exec(`git worktree add ${shellQuote(worktreePath)} ${shellQuote(branch)}`, RUN_OPTS);
}

export function removeWorktree(worktreePath) {
  _exec(`git worktree remove ${shellQuote(worktreePath)}`, RUN_OPTS);
}

export function cherryPick(sha) {
  validateSha(sha);
  try {
    _exec(`git cherry-pick ${sha}`, RUN_OPTS);
  } catch (err) {
    if (/conflict/i.test(err.message) || /could not apply/i.test(err.message)) {
      const conflictErr = new Error(`Cherry-pick conflict: ${err.message}`);
      conflictErr.isConflict = true;
      throw conflictErr;
    }
    throw err;
  }
}

export function stashPop() {
  _exec('git stash pop', RUN_OPTS);
}
