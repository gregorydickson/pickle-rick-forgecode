import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

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

/** Validate shell script syntax via bash -n (no execution). */
function assertShellSyntax(filePath) {
  assert.ok(fs.existsSync(filePath), `${path.basename(filePath)} must exist`);
  assert.ok(isExecutable(filePath), `${path.basename(filePath)} must be executable`);
  try {
    execFileSync('bash', ['-n', filePath], { stdio: 'pipe' });
  } catch (err) {
    assert.fail(`bash -n failed for ${path.basename(filePath)}: ${err.stderr?.toString() || err.message}`);
  }
}

/** Validate Node ESM script syntax via node --check (no execution). */
function assertNodeSyntax(filePath) {
  assert.ok(fs.existsSync(filePath), `${path.basename(filePath)} must exist`);
  try {
    execFileSync('node', ['--check', filePath], { stdio: 'pipe' });
  } catch (err) {
    assert.fail(`node --check failed for ${path.basename(filePath)}: ${err.stderr?.toString() || err.message}`);
  }
}

// --- Shell scripts: existence + executable + bash -n syntax ---

describe('shell script syntax (bash -n)', () => {
  const shellScripts = [
    path.join(SMOKE_DIR, 'tmux-layout.sh'),
    path.join(SMOKE_DIR, 'platform-verification.sh'),
    path.join(SMOKE_DIR, 'forge-p-context-clear.sh'),
    path.join(SMOKE_DIR, 'forge-p-agent-select.sh'),
    path.join(SMOKE_DIR, 'forge-p-token-roundtrip.sh'),
    path.join(SMOKE_DIR, 'microverse-3-iteration.sh'),
    path.join(SMOKE_DIR, 'full-lifecycle.sh'),
    path.join(ROOT, 'tests', 'phase1-gate.sh'),
    path.join(ROOT, '.forge', 'skills', 'microverse', 'scripts', 'measure-metric.sh'),
  ];

  for (const script of shellScripts) {
    const name = path.relative(ROOT, script);
    it(`${name} — valid bash syntax`, () => {
      assertShellSyntax(script);
    });
  }
});

// --- JS bin scripts: existence + node --check syntax ---

describe('bin script syntax (node --check)', () => {
  const binScripts = [
    path.join(ROOT, 'bin', 'init-microverse.js'),
    path.join(ROOT, 'bin', 'setup.js'),
    path.join(ROOT, 'bin', 'microverse-runner.js'),
    path.join(ROOT, 'bin', 'tmux-runner.js'),
    path.join(ROOT, 'bin', 'spawn-refinement-team.js'),
  ];

  for (const script of binScripts) {
    const name = path.relative(ROOT, script);
    it(`${name} — valid Node syntax`, () => {
      assertNodeSyntax(script);
    });
  }
});

// --- forge-spawn-contract.sh: exists, executable, valid syntax ---

describe('forge-spawn-contract', () => {
  const contractScript = path.join(SMOKE_DIR, 'forge-spawn-contract.sh');

  it('forge-spawn-contract.sh — exists and valid bash syntax', () => {
    assertShellSyntax(contractScript);
  });
});
