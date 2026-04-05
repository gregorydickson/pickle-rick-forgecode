import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SMOKE_DIR = path.join(ROOT, 'tests', 'smoke');

function isExecutable(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

describe('smoke scripts', () => {
  it('tests/smoke/tmux-layout.sh exists and is executable', () => {
    const p = path.join(SMOKE_DIR, 'tmux-layout.sh');
    assert.ok(fs.existsSync(p), 'tmux-layout.sh must exist');
    assert.ok(isExecutable(p), 'tmux-layout.sh must be executable');
  });

  it('tests/smoke/platform-verification.sh exists and is executable', () => {
    const p = path.join(SMOKE_DIR, 'platform-verification.sh');
    assert.ok(fs.existsSync(p), 'platform-verification.sh must exist');
    assert.ok(isExecutable(p), 'platform-verification.sh must be executable');
  });

  it('tests/phase1-gate.sh exists and is executable', () => {
    const p = path.join(ROOT, 'tests', 'phase1-gate.sh');
    assert.ok(fs.existsSync(p), 'phase1-gate.sh must exist');
    assert.ok(isExecutable(p), 'phase1-gate.sh must be executable');
  });
});
