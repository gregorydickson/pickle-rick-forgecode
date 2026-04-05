/**
 * GitUtils — thin wrappers around git CLI commands via execSync.
 *
 * Used by tmux-runner and microverse-runner for SHA tracking,
 * rollback, worktree management, and diff stats.
 * ESM module, zero dependencies.
 */
import { execSync as _defaultExec } from 'node:child_process';

const RUN_OPTS = { encoding: 'utf-8' };

let _exec = _defaultExec;

/** Replace the exec function (for testing). Returns a restore function. */
export function _setExec(fn) {
  const prev = _exec;
  _exec = fn;
  return () => { _exec = prev; };
}

export function getCurrentSha() {
  return _exec('git rev-parse HEAD', RUN_OPTS).trim();
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
  _exec('git add -u', RUN_OPTS);
  _exec(`git commit -m ${JSON.stringify(message)}`, RUN_OPTS);
  return _exec('git rev-parse HEAD', RUN_OPTS).trim();
}

export function resetToSha(sha) {
  _exec('git stash', RUN_OPTS);
  _exec(`git reset --hard ${sha}`, RUN_OPTS);
  _exec('git clean -fd', RUN_OPTS);
}

export function getDiffStat() {
  return _exec('git diff --stat', RUN_OPTS).trim();
}

export function getStagedDiffStat() {
  return _exec('git diff --cached --stat', RUN_OPTS).trim();
}

export function createWorktree(worktreePath, branch) {
  _exec(`git worktree add ${worktreePath} ${branch}`, RUN_OPTS);
}

export function removeWorktree(worktreePath) {
  _exec(`git worktree remove ${worktreePath}`, RUN_OPTS);
}

export function cherryPick(sha) {
  _exec(`git cherry-pick ${sha}`, RUN_OPTS);
}

export function stash() {
  _exec('git stash', RUN_OPTS);
}

export function stashPop() {
  _exec('git stash pop', RUN_OPTS);
}
