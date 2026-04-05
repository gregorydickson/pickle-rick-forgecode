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
  validateSha,
  shellQuote,
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
      if (cmd === 'git status --porcelain') return ' M file.js\n';
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
      if (cmd === 'git status --porcelain') return ' M file.js\n';
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
    execFn.mock.mockImplementation((cmd) => {
      if (cmd === 'git stash') return 'Saved working directory and index state WIP on main: abc1234 msg\n';
      return '';
    });
    const result = resetToSha('abc123');
    const cmds = execFn.mock.calls.map(c => c.arguments[0]);
    assert(cmds.some(c => c === 'git stash'));
    assert(cmds.some(c => c === 'git reset --hard abc123'));
    assert(cmds.some(c => c === 'git clean -fd'));
    assert.deepEqual(result, { stashRef: 'stash@{0}' });
  });

  it('throws when reset fails', () => {
    execFn.mock.mockImplementation((cmd) => {
      if (cmd === 'git stash') return 'No local changes to save\n';
      if (cmd.includes('reset')) throw new Error('reset failed');
      return '';
    });
    assert.throws(() => resetToSha('abc123'), /reset failed/);
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
  it('calls git worktree add with quoted path and branch', () => {
    execFn.mock.mockImplementation(() => '');
    createWorktree('/tmp/wt', 'feature-branch');
    assert.equal(execFn.mock.calls[0].arguments[0], "git worktree add '/tmp/wt' 'feature-branch'");
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
  it('calls git worktree remove with quoted path', () => {
    execFn.mock.mockImplementation(() => '');
    removeWorktree('/tmp/wt');
    assert.equal(execFn.mock.calls[0].arguments[0], "git worktree remove '/tmp/wt'");
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

  it('throws on error', () => {
    execFn.mock.mockImplementation(() => { throw new Error('cherry-pick failed'); });
    assert.throws(() => cherryPick('abcd1234'), /cherry-pick failed/);
  });
});

// ---------------------------------------------------------------------------
// stash / stashPop
// ---------------------------------------------------------------------------
describe('stash', () => {
  it('calls git stash', () => {
    execFn.mock.mockImplementation(() => 'No local changes to save\n');
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

// ---------------------------------------------------------------------------
// SHA validation (sha-validation)
// ---------------------------------------------------------------------------
describe('validateSha', () => {
  it('accepts valid short SHA', () => {
    assert.doesNotThrow(() => validateSha('abcd'));
  });

  it('accepts valid 40-char SHA', () => {
    assert.doesNotThrow(() => validateSha('abc123def456789012345678901234abcdef1234'));
  });

  it('accepts uppercase hex', () => {
    assert.doesNotThrow(() => validateSha('ABCDEF0123'));
  });

  it('rejects non-hex characters', () => {
    assert.throws(() => validateSha('abc123; rm -rf /'), /Invalid SHA/);
  });

  it('rejects empty string', () => {
    assert.throws(() => validateSha(''), /Invalid SHA/);
  });

  it('rejects SHA longer than 40 chars', () => {
    assert.throws(() => validateSha('a'.repeat(41)), /Invalid SHA/);
  });

  it('rejects SHA shorter than 4 chars', () => {
    assert.throws(() => validateSha('abc'), /Invalid SHA/);
  });

  it('rejects SHA with shell metacharacters', () => {
    assert.throws(() => validateSha('abc$(whoami)'), /Invalid SHA/);
  });
});

describe('resetToSha — SHA validation', () => {
  it('rejects non-hex SHA input', () => {
    execFn.mock.mockImplementation(() => '');
    assert.throws(() => resetToSha('; rm -rf /'), /Invalid SHA/);
    assert.equal(execFn.mock.calls.length, 0);
  });
});

describe('cherryPick — SHA validation', () => {
  it('rejects non-hex SHA input', () => {
    execFn.mock.mockImplementation(() => '');
    assert.throws(() => cherryPick('$(malicious)'), /Invalid SHA/);
    assert.equal(execFn.mock.calls.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Path quoting (path-quoting)
// ---------------------------------------------------------------------------
describe('shellQuote', () => {
  it('wraps path in single quotes', () => {
    assert.equal(shellQuote('/tmp/my path'), "'/tmp/my path'");
  });

  it('escapes internal single quotes', () => {
    assert.equal(shellQuote("it's"), "'it'\\''s'");
  });

  it('handles empty string', () => {
    assert.equal(shellQuote(''), "''");
  });
});

describe('createWorktree — path quoting', () => {
  it('quotes path and branch with spaces', () => {
    execFn.mock.mockImplementation(() => '');
    createWorktree('/tmp/my worktree', 'feature branch');
    assert.equal(
      execFn.mock.calls[0].arguments[0],
      "git worktree add '/tmp/my worktree' 'feature branch'"
    );
  });
});

describe('removeWorktree — path quoting', () => {
  it('quotes path with spaces', () => {
    execFn.mock.mockImplementation(() => '');
    removeWorktree('/tmp/my worktree');
    assert.equal(
      execFn.mock.calls[0].arguments[0],
      "git worktree remove '/tmp/my worktree'"
    );
  });
});

// ---------------------------------------------------------------------------
// stash returns ref (stash-returns-ref)
// ---------------------------------------------------------------------------
describe('stash — returns ref', () => {
  it('returns stash ref string from git output', () => {
    execFn.mock.mockImplementation(() => 'Saved working directory and index state WIP on main: abc1234 msg\n');
    const ref = stash();
    assert.equal(ref, 'stash@{0}');
  });

  it('returns null when nothing to stash', () => {
    execFn.mock.mockImplementation(() => 'No local changes to save\n');
    const ref = stash();
    assert.equal(ref, null);
  });
});

// ---------------------------------------------------------------------------
// resetToSha returns stashRef (reset-returns-stash)
// ---------------------------------------------------------------------------
describe('resetToSha — returns stashRef', () => {
  it('returns object with stashRef from stash', () => {
    execFn.mock.mockImplementation((cmd) => {
      if (cmd === 'git stash') return 'Saved working directory and index state WIP on main: abc1234 msg\n';
      return '';
    });
    const result = resetToSha('abc123');
    assert.deepEqual(result, { stashRef: 'stash@{0}' });
  });

  it('returns null stashRef when tree was clean', () => {
    execFn.mock.mockImplementation((cmd) => {
      if (cmd === 'git stash') return 'No local changes to save\n';
      return '';
    });
    const result = resetToSha('abc123');
    assert.deepEqual(result, { stashRef: null });
  });
});

// ---------------------------------------------------------------------------
// autoCommit clean tree (autocommit-clean-tree)
// ---------------------------------------------------------------------------
describe('autoCommit — clean tree', () => {
  it('returns null without committing when tree is clean', () => {
    execFn.mock.mockImplementation((cmd) => {
      if (cmd === 'git status --porcelain') return '';
      throw new Error('should not be called');
    });
    const result = autoCommit('test');
    assert.equal(result, null);
    const cmds = execFn.mock.calls.map(c => c.arguments[0]);
    assert(!cmds.some(c => c.includes('git commit')));
  });
});

// ---------------------------------------------------------------------------
// cherryPick conflict distinction (cherrypick-conflict)
// ---------------------------------------------------------------------------
describe('cherryPick — conflict distinction', () => {
  it('throws CherryPickConflictError on merge conflict', () => {
    const err = new Error('CONFLICT (content): Merge conflict in file.js');
    err.status = 1;
    execFn.mock.mockImplementation(() => { throw err; });
    try {
      cherryPick('abc123');
      assert.fail('should have thrown');
    } catch (e) {
      assert.equal(e.isConflict, true);
      assert.match(e.message, /conflict/i);
    }
  });

  it('re-throws non-conflict errors without isConflict flag', () => {
    execFn.mock.mockImplementation(() => { throw new Error('fatal: bad object abc123'); });
    try {
      cherryPick('abc123');
      assert.fail('should have thrown');
    } catch (e) {
      assert.equal(e.isConflict, undefined);
      assert.match(e.message, /bad object/);
    }
  });
});
