import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  buildHandoff,
  buildMicroverseHandoff,
  buildAnatomyParkHandoff,
  writeHandoff,
} from '../lib/handoff.js';

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const BASE_OPTS = {
  iteration: 7,
  step: 'implement',
  currentTicket: 'PROJ-42',
  workingDir: '/home/user/project',
  sessionRoot: '/sessions/2026-04-05-abc',
  ticketsDone: ['PROJ-10', 'PROJ-20'],
  ticketsPending: ['PROJ-42', 'PROJ-50', 'PROJ-60'],
  startTime: Date.now() - 3600000, // 1 hour ago
  instructions: 'Focus on test coverage improvements',
};

// ---------------------------------------------------------------------------
// buildHandoff — base
// ---------------------------------------------------------------------------
describe('buildHandoff', () => {
  it('base-handoff-content', () => {
    const md = buildHandoff(BASE_OPTS);
    assert(md.includes('7'), 'should contain iteration number');
    assert(md.includes('implement'), 'should contain phase/step');
    assert(md.includes('PROJ-42'), 'should contain current ticket');
    assert(md.includes('/home/user/project'), 'should contain working dir');
    assert(md.includes('/sessions/2026-04-05-abc'), 'should contain session root');
  });

  it('ticket-lists', () => {
    const md = buildHandoff(BASE_OPTS);
    assert(md.includes('PROJ-10'), 'should list done ticket PROJ-10');
    assert(md.includes('PROJ-20'), 'should list done ticket PROJ-20');
    assert(md.includes('PROJ-50'), 'should list pending ticket PROJ-50');
    assert(md.includes('PROJ-60'), 'should list pending ticket PROJ-60');
  });

  it('elapsed-time', () => {
    const md = buildHandoff(BASE_OPTS);
    // startTime is 1 hour ago, so elapsed should contain something like "1h" or "60m"
    assert(md.match(/elapsed/i), 'should contain elapsed label');
    // Should have some time representation
    assert(md.match(/\d+/), 'should contain numeric time value');
  });

  it('handles empty options gracefully', () => {
    const md = buildHandoff({});
    assert(typeof md === 'string');
    assert(md.includes('# Handoff'));
  });

  it('includes instructions when provided', () => {
    const md = buildHandoff(BASE_OPTS);
    assert(md.includes('Focus on test coverage improvements'));
  });

  it('omits empty done/pending lists cleanly', () => {
    const md = buildHandoff({ ...BASE_OPTS, ticketsDone: [], ticketsPending: [] });
    assert(typeof md === 'string');
    assert(md.includes('# Handoff'));
  });
});

// ---------------------------------------------------------------------------
// buildMicroverseHandoff
// ---------------------------------------------------------------------------
describe('buildMicroverseHandoff', () => {
  const METRIC = {
    description: 'test coverage',
    validation: 'npm test -- --coverage | tail -1',
    direction: 'higher',
    baseline: 62.5,
    current: 78.3,
    target: 95,
  };

  const MICRO_OPTS = {
    ...BASE_OPTS,
    metric: METRIC,
    stallCounter: 2,
    stallLimit: 3,
    recentHistory: [
      { iteration: 3, score: 70.1, result: 'improved' },
      { iteration: 4, score: 72.5, result: 'improved' },
      { iteration: 5, score: 72.5, result: 'held' },
      { iteration: 6, score: 74.0, result: 'improved' },
      { iteration: 7, score: 78.3, result: 'improved' },
    ],
    failedApproaches: [
      'Adding mock-heavy tests inflated coverage without real assertions',
      'Refactoring parser broke 3 existing tests',
    ],
  };

  it('microverse-context', () => {
    const md = buildMicroverseHandoff(MICRO_OPTS);
    assert(md.includes('test coverage'), 'should include metric description');
    assert(md.includes('higher'), 'should include direction');
    assert(md.includes('62.5'), 'should include baseline score');
    assert(md.includes('78.3'), 'should include current score');
    assert(md.includes('95'), 'should include target score');
    assert(md.includes('2'), 'should include stall counter');
    assert(md.includes('3'), 'should include stall limit');
  });

  it('microverse-history', () => {
    // Provide 7 entries, assert only last 5 appear
    const history = [
      { iteration: 1, score: 65.0, result: 'improved' },
      { iteration: 2, score: 68.0, result: 'improved' },
      { iteration: 3, score: 70.1, result: 'improved' },
      { iteration: 4, score: 72.5, result: 'improved' },
      { iteration: 5, score: 72.5, result: 'held' },
      { iteration: 6, score: 74.0, result: 'improved' },
      { iteration: 7, score: 78.3, result: 'improved' },
    ];
    const md = buildMicroverseHandoff({ ...MICRO_OPTS, recentHistory: history });
    // Last 5 should be present (iterations 3-7)
    assert(md.includes('70.1'), 'should include iteration 3 score');
    assert(md.includes('78.3'), 'should include iteration 7 score');
    // First 2 should NOT be present (iterations 1-2 scores only)
    // 65.0 and 68.0 are unique enough to check
    assert(!md.includes('65.0'), 'should NOT include iteration 1 score (truncated)');
    assert(!md.includes('68.0'), 'should NOT include iteration 2 score (truncated)');
  });

  it('failed-approaches', () => {
    const md = buildMicroverseHandoff(MICRO_OPTS);
    assert(md.includes('Adding mock-heavy tests'), 'should include first failed approach');
    assert(md.includes('Refactoring parser broke'), 'should include second failed approach');
  });

  it('includes base handoff content', () => {
    const md = buildMicroverseHandoff(MICRO_OPTS);
    assert(md.includes('# Handoff'), 'should have handoff header');
    assert(md.includes('PROJ-42'), 'should include current ticket from base');
    assert(md.includes('implement'), 'should include step from base');
  });
});

// ---------------------------------------------------------------------------
// buildAnatomyParkHandoff
// ---------------------------------------------------------------------------
describe('buildAnatomyParkHandoff', () => {
  const ANATOMY_OPTS = {
    ...BASE_OPTS,
    subsystem: 'auth-middleware',
    subsystemIndex: 3,
    subsystemTotal: 8,
    passCount: 2,
    consecutiveClean: 1,
    previousFindings: 'Found unvalidated JWT expiry in auth/verify.js:42',
  };

  it('anatomy-context', () => {
    const md = buildAnatomyParkHandoff(ANATOMY_OPTS);
    assert(md.includes('auth-middleware'), 'should include subsystem name');
    assert(md.includes('3'), 'should include subsystem index');
    assert(md.includes('8'), 'should include subsystem total');
    assert(md.includes('2'), 'should include pass count');
    assert(md.includes('1'), 'should include consecutive clean');
    assert(md.includes('unvalidated JWT expiry'), 'should include previous findings');
  });

  it('includes base handoff content', () => {
    const md = buildAnatomyParkHandoff(ANATOMY_OPTS);
    assert(md.includes('# Handoff'), 'should have handoff header');
    assert(md.includes('PROJ-42'), 'should include current ticket from base');
  });
});

// ---------------------------------------------------------------------------
// writeHandoff
// ---------------------------------------------------------------------------
describe('writeHandoff', () => {
  it('write-handoff', () => {
    writeHandoff(tmpDir, BASE_OPTS);
    const filePath = path.join(tmpDir, 'handoff.txt');
    assert(fs.existsSync(filePath), 'handoff.txt should exist');
    const content = fs.readFileSync(filePath, 'utf-8');
    assert(content.includes('# Handoff'), 'should contain handoff header');
    assert(content.includes('PROJ-42'), 'should contain ticket');
    assert(content.includes('implement'), 'should contain step');
  });

  it('overwrites existing handoff.txt', () => {
    fs.writeFileSync(path.join(tmpDir, 'handoff.txt'), 'old content');
    writeHandoff(tmpDir, { ...BASE_OPTS, currentTicket: 'NEW-1' });
    const content = fs.readFileSync(path.join(tmpDir, 'handoff.txt'), 'utf-8');
    assert(!content.includes('old content'), 'should not contain old content');
    assert(content.includes('NEW-1'), 'should contain new ticket');
  });

  it('throws when directory does not exist', () => {
    assert.throws(
      () => writeHandoff('/nonexistent/path/xyz', BASE_OPTS),
    );
  });
});
