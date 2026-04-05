import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import {
  getCurrentSha,
  isDirty,
  autoCommit,
  resetToSha,
  getDiffStat,
  getStagedDiffStat,
  createWorktree,
  removeWorktree,
  cherryPick,
  stash,
  stashPop,
  _setExec,
} from '../lib/git-utils.js';

let execFn;
let restore;

beforeEach(() => {
  execFn = mock.fn();
  restore = _setExec(execFn);
});

afterEach(() => {
  restore();
});

// ---------------------------------------------------------------------------
// getCurrentSha
// ---------------------------------------------------------------------------
describe('getCurrentSha', () => {
  it('returns trimmed SHA from git rev-parse HEAD', () => {
    execFn.mock.mockImplementation(() => 'abc123def\n');
    const sha = getCurrentSha();
    assert.equal(sha, 'abc123def');
    assert.equal(execFn.mock.calls[0].arguments[0], 'git rev-parse HEAD');
  });

  it('throws when git command fails', () => {
    execFn.mock.mockImplementation(() => { throw new Error('not a git repo'); });
    assert.throws(() => getCurrentSha(), /not a git repo/);
  });
});

// ---------------------------------------------------------------------------
// isDirty
// ---------------------------------------------------------------------------
describe('isDirty', () => {
  it('returns true when there are uncommitted changes', () => {
    execFn.mock.mockImplementation(() => ' M src/index.js\n');
    assert.equal(isDirty(), true);
    assert.equal(execFn.mock.calls[0].arguments[0], 'git status --porcelain');
  });

  it('returns false when working tree is clean', () => {
    execFn.mock.mockImplementation(() => '');
    assert.equal(isDirty(), false);
  });

  it('returns false when command fails', () => {
    execFn.mock.mockImplementation(() => { throw new Error('fail'); });
    assert.equal(isDirty(), false);
  });
});

// ---------------------------------------------------------------------------
// autoCommit
// ---------------------------------------------------------------------------
describe('autoCommit', () => {
  it('stages and commits, returns new SHA', () => {
    execFn.mock.mockImplementation((cmd) => {
      if (cmd.startsWith('git rev-parse')) return 'newsha456\n';
      return '';
    });
    const sha = autoCommit('test commit');
    assert.equal(sha, 'newsha456');
    const cmds = execFn.mock.calls.map(c => c.arguments[0]);
    assert(cmds.some(c => c === 'git add -u'));
    assert(cmds.some(c => c.includes('git commit -m')));
    assert(cmds.some(c => c === 'git rev-parse HEAD'));
  });

  it('throws when commit fails', () => {
    execFn.mock.mockImplementation((cmd) => {
      if (cmd.startsWith('git commit')) throw new Error('nothing to commit');
      return '';
    });
    assert.throws(() => autoCommit('empty'), /nothing to commit/);
  });
});

// ---------------------------------------------------------------------------
// resetToSha
// ---------------------------------------------------------------------------
describe('resetToSha', () => {
  it('runs stash, reset --hard, and clean -fd', () => {
    execFn.mock.mockImplementation(() => '');
    resetToSha('abc123');
    const cmds = execFn.mock.calls.map(c => c.arguments[0]);
    assert(cmds.some(c => c === 'git stash'));
    assert(cmds.some(c => c === 'git reset --hard abc123'));
    assert(cmds.some(c => c === 'git clean -fd'));
  });

  it('throws when reset fails', () => {
    execFn.mock.mockImplementation((cmd) => {
      if (cmd.includes('reset')) throw new Error('reset failed');
      return '';
    });
    assert.throws(() => resetToSha('bad'), /reset failed/);
  });
});

// ---------------------------------------------------------------------------
// getDiffStat
// ---------------------------------------------------------------------------
describe('getDiffStat', () => {
  it('returns trimmed diff stat output', () => {
    execFn.mock.mockImplementation(() => ' 2 files changed, 10 insertions(+)\n');
    const stat = getDiffStat();
    assert.equal(stat, '2 files changed, 10 insertions(+)');
    assert.equal(execFn.mock.calls[0].arguments[0], 'git diff --stat');
  });

  it('returns empty string when no diff', () => {
    execFn.mock.mockImplementation(() => '');
    assert.equal(getDiffStat(), '');
  });
});

// ---------------------------------------------------------------------------
// getStagedDiffStat
// ---------------------------------------------------------------------------
describe('getStagedDiffStat', () => {
  it('returns trimmed staged diff stat output', () => {
    execFn.mock.mockImplementation(() => ' 1 file changed, 5 deletions(-)\n');
    const stat = getStagedDiffStat();
    assert.equal(stat, '1 file changed, 5 deletions(-)');
    assert.equal(execFn.mock.calls[0].arguments[0], 'git diff --cached --stat');
  });
});

// ---------------------------------------------------------------------------
// createWorktree
// ---------------------------------------------------------------------------
describe('createWorktree', () => {
  it('calls git worktree add with path and branch', () => {
    execFn.mock.mockImplementation(() => '');
    createWorktree('/tmp/wt', 'feature-branch');
    assert.equal(execFn.mock.calls[0].arguments[0], 'git worktree add /tmp/wt feature-branch');
  });

  it('throws when worktree creation fails', () => {
    execFn.mock.mockImplementation(() => { throw new Error('already exists'); });
    assert.throws(() => createWorktree('/tmp/wt', 'main'), /already exists/);
  });
});

// ---------------------------------------------------------------------------
// removeWorktree
// ---------------------------------------------------------------------------
describe('removeWorktree', () => {
  it('calls git worktree remove with path', () => {
    execFn.mock.mockImplementation(() => '');
    removeWorktree('/tmp/wt');
    assert.equal(execFn.mock.calls[0].arguments[0], 'git worktree remove /tmp/wt');
  });

  it('throws when removal fails', () => {
    execFn.mock.mockImplementation(() => { throw new Error('not a worktree'); });
    assert.throws(() => removeWorktree('/tmp/wt'), /not a worktree/);
  });
});

// ---------------------------------------------------------------------------
// cherryPick
// ---------------------------------------------------------------------------
describe('cherryPick', () => {
  it('calls git cherry-pick with SHA', () => {
    execFn.mock.mockImplementation(() => '');
    cherryPick('abc123');
    assert.equal(execFn.mock.calls[0].arguments[0], 'git cherry-pick abc123');
  });

  it('throws on conflict', () => {
    execFn.mock.mockImplementation(() => { throw new Error('conflict'); });
    assert.throws(() => cherryPick('bad'), /conflict/);
  });
});

// ---------------------------------------------------------------------------
// stash / stashPop
// ---------------------------------------------------------------------------
describe('stash', () => {
  it('calls git stash', () => {
    execFn.mock.mockImplementation(() => '');
    stash();
    assert.equal(execFn.mock.calls[0].arguments[0], 'git stash');
  });
});

describe('stashPop', () => {
  it('calls git stash pop', () => {
    execFn.mock.mockImplementation(() => '');
    stashPop();
    assert.equal(execFn.mock.calls[0].arguments[0], 'git stash pop');
  });

  it('throws when no stash entries', () => {
    execFn.mock.mockImplementation(() => { throw new Error('No stash entries'); });
    assert.throws(() => stashPop(), /No stash entries/);
  });
});
