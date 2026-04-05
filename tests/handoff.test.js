import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { buildHandoff, writeHandoff } from '../lib/handoff.js';

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const FULL_OPTIONS = {
  ticket: 'PROJ-42',
  sha: 'abc123def456',
  diffStat: '3 files changed, 42 insertions(+), 7 deletions(-)',
  status: 'completed',
  timestamp: '2026-04-05T12:00:00Z',
};

// ---------------------------------------------------------------------------
// buildHandoff
// ---------------------------------------------------------------------------
describe('buildHandoff', () => {
  it('returns a markdown string with all sections', () => {
    const md = buildHandoff(FULL_OPTIONS);
    assert(md.includes('# Handoff'));
    assert(md.includes('PROJ-42'));
    assert(md.includes('abc123def456'));
    assert(md.includes('3 files changed'));
    assert(md.includes('completed'));
    assert(md.includes('2026-04-05T12:00:00Z'));
  });

  it('includes ticket ID in output', () => {
    const md = buildHandoff({ ticket: 'TEST-1' });
    assert(md.includes('TEST-1'));
  });

  it('handles missing optional fields gracefully', () => {
    const md = buildHandoff({});
    assert(typeof md === 'string');
    assert(md.includes('# Handoff'));
  });

  it('handles empty options', () => {
    const md = buildHandoff({});
    assert(typeof md === 'string');
    assert(md.length > 0);
  });

  it('includes sha when provided', () => {
    const md = buildHandoff({ sha: 'deadbeef' });
    assert(md.includes('deadbeef'));
  });

  it('includes diffStat when provided', () => {
    const md = buildHandoff({ diffStat: '1 file changed' });
    assert(md.includes('1 file changed'));
  });

  it('uses current ISO timestamp when timestamp not provided', () => {
    const before = new Date().toISOString().slice(0, 10);
    const md = buildHandoff({ ticket: 'X' });
    assert(md.includes(before));
  });
});

// ---------------------------------------------------------------------------
// writeHandoff
// ---------------------------------------------------------------------------
describe('writeHandoff', () => {
  it('writes handoff.txt to the specified directory', () => {
    writeHandoff(tmpDir, FULL_OPTIONS);
    const filePath = path.join(tmpDir, 'handoff.txt');
    assert(fs.existsSync(filePath));
    const content = fs.readFileSync(filePath, 'utf-8');
    assert(content.includes('PROJ-42'));
    assert(content.includes('abc123def456'));
  });

  it('creates file with markdown content from buildHandoff', () => {
    writeHandoff(tmpDir, { ticket: 'WR-1', sha: 'fff000' });
    const content = fs.readFileSync(path.join(tmpDir, 'handoff.txt'), 'utf-8');
    assert(content.includes('WR-1'));
    assert(content.includes('fff000'));
    assert(content.includes('# Handoff'));
  });

  it('overwrites existing handoff.txt', () => {
    fs.writeFileSync(path.join(tmpDir, 'handoff.txt'), 'old content');
    writeHandoff(tmpDir, { ticket: 'NEW-1' });
    const content = fs.readFileSync(path.join(tmpDir, 'handoff.txt'), 'utf-8');
    assert(!content.includes('old content'));
    assert(content.includes('NEW-1'));
  });

  it('throws when directory does not exist', () => {
    assert.throws(
      () => writeHandoff('/nonexistent/path/xyz', { ticket: 'X' }),
    );
  });
});
