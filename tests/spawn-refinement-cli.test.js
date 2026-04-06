import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  parseRefinementArgs,
  validateRefinementArgs,
  writePromptFile,
  cleanupTempFiles,
} from '../bin/spawn-refinement-team.js';

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'refcli-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// parseRefinementArgs
// ---------------------------------------------------------------------------
describe('parseRefinementArgs', () => {
  it('parses --prd and --session-dir', () => {
    const args = parseRefinementArgs(['--prd', '/tmp/prd.md', '--session-dir', '/tmp/session']);
    assert.equal(args.prd, '/tmp/prd.md');
    assert.equal(args.sessionDir, '/tmp/session');
  });

  it('parses --timeout with default 300000', () => {
    const args = parseRefinementArgs(['--prd', 'x', '--session-dir', 'y']);
    assert.equal(args.timeout, 300000);
  });

  it('parses --timeout override', () => {
    const args = parseRefinementArgs(['--prd', 'x', '--session-dir', 'y', '--timeout', '60000']);
    assert.equal(args.timeout, 60000);
  });

  it('parses --cycles with default 3', () => {
    const args = parseRefinementArgs(['--prd', 'x', '--session-dir', 'y']);
    assert.equal(args.cycles, 3);
  });

  it('parses --cycles override', () => {
    const args = parseRefinementArgs(['--prd', 'x', '--session-dir', 'y', '--cycles', '5']);
    assert.equal(args.cycles, 5);
  });

  it('parses --max-turns as undefined by default', () => {
    const args = parseRefinementArgs(['--prd', 'x', '--session-dir', 'y']);
    assert.equal(args.maxTurns, undefined);
  });

  it('parses --max-turns override', () => {
    const args = parseRefinementArgs(['--prd', 'x', '--session-dir', 'y', '--max-turns', '10']);
    assert.equal(args.maxTurns, 10);
  });
});

// ---------------------------------------------------------------------------
// validateRefinementArgs
// ---------------------------------------------------------------------------
describe('validateRefinementArgs', () => {
  it('returns error when --prd is missing', () => {
    const err = validateRefinementArgs({ sessionDir: '/tmp/s' });
    assert.match(err, /--prd/);
  });

  it('returns error when --session-dir is missing', () => {
    const err = validateRefinementArgs({ prd: '/tmp/prd.md' });
    assert.match(err, /--session-dir/);
  });

  it('returns null when args are valid', () => {
    const prdPath = path.join(tmpDir, 'prd.md');
    fs.writeFileSync(prdPath, '# PRD');
    const err = validateRefinementArgs({ prd: prdPath, sessionDir: tmpDir });
    assert.equal(err, null);
  });

  it('returns error when PRD file does not exist', () => {
    const err = validateRefinementArgs({ prd: '/nonexistent/prd.md', sessionDir: tmpDir });
    assert.match(err, /not found|does not exist/i);
  });
});

// ---------------------------------------------------------------------------
// writePromptFile
// ---------------------------------------------------------------------------
describe('writePromptFile', () => {
  it('writes content to a temp file and returns the path', () => {
    const content = 'Cycle 1\n\n# Test PRD content';
    const filePath = writePromptFile(content, tmpDir);
    assert.ok(fs.existsSync(filePath));
    assert.equal(fs.readFileSync(filePath, 'utf-8'), content);
  });

  it('creates file inside the specified directory', () => {
    const content = 'test prompt';
    const filePath = writePromptFile(content, tmpDir);
    assert.ok(filePath.startsWith(tmpDir));
  });

  it('creates unique files for different calls', () => {
    const p1 = writePromptFile('a', tmpDir);
    const p2 = writePromptFile('b', tmpDir);
    assert.notEqual(p1, p2);
  });
});

// ---------------------------------------------------------------------------
// cleanupTempFiles
// ---------------------------------------------------------------------------
describe('cleanupTempFiles', () => {
  it('removes existing temp files', () => {
    const f1 = path.join(tmpDir, 'tmp1.txt');
    const f2 = path.join(tmpDir, 'tmp2.txt');
    fs.writeFileSync(f1, 'a');
    fs.writeFileSync(f2, 'b');
    cleanupTempFiles([f1, f2]);
    assert.ok(!fs.existsSync(f1));
    assert.ok(!fs.existsSync(f2));
  });

  it('ignores already-deleted files without throwing', () => {
    assert.doesNotThrow(() => {
      cleanupTempFiles(['/nonexistent/file.txt']);
    });
  });

  it('handles empty array', () => {
    assert.doesNotThrow(() => {
      cleanupTempFiles([]);
    });
  });
});

// ---------------------------------------------------------------------------
// spawnWorker temp file integration
// ---------------------------------------------------------------------------
describe('spawnWorker temp file usage', () => {
  it('passes --prompt-file instead of -p when promptFile is used', async () => {
    // Import spawnRefinementTeam to test the integration
    const { spawnRefinementTeam, WORKER_ROLES } = await import('../bin/spawn-refinement-team.js');

    const prdPath = path.join(tmpDir, 'prd.md');
    fs.writeFileSync(prdPath, '# Test PRD');

    const refinementDir = path.join(tmpDir, 'refinement');
    fs.mkdirSync(refinementDir, { recursive: true });

    const spawnCalls = [];
    const mockSpawn = (cmd, args, opts) => {
      spawnCalls.push({ cmd, args, opts });
      const child = new EventEmitter();
      child.pid = 99999;
      child.stderr = new EventEmitter();
      child.kill = mock.fn();

      // Simulate quick exit with no analysis
      process.nextTick(() => child.emit('exit', 0, null));
      return child;
    };

    const agentDir = path.join(tmpDir, '.forge', 'agents');
    fs.mkdirSync(agentDir, { recursive: true });

    await spawnRefinementTeam({
      spawn: mockSpawn,
      prdPath,
      refinementDir,
      cycles: 1,
      workerTimeoutMs: 5000,
      killEscalationMs: 1000,
      agentDir,
      usePromptFile: true,
    });

    // Each worker should have been spawned with --prompt-file, not -p
    for (const call of spawnCalls) {
      assert.ok(
        call.args.includes('--prompt-file'),
        `Expected --prompt-file in args: ${JSON.stringify(call.args)}`,
      );
      assert.ok(
        !call.args.includes('-p'),
        `Expected no -p in args: ${JSON.stringify(call.args)}`,
      );
    }
  });
});
