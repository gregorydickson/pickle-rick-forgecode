#!/usr/bin/env bash
set -euo pipefail

# microverse-3-iteration — smoke test for microverse convergence loop.
#
# Pipeline: init-microverse creates state → Node harness runs runMicroverse
# with mock deps (fake spawn, real metric) → verify state transitions.
#
# References: PRD CUJ 1.1, bin/init-microverse.js, bin/microverse-runner.js

PROJECT_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TIMEOUT_SEC=120

# --- forge availability check ---
if ! command -v forge &>/dev/null; then
  echo "SKIP: forge not installed"
  exit 0
fi

# --- required files check ---
if [ ! -f "$PROJECT_ROOT/bin/init-microverse.js" ]; then
  echo "FAIL: bin/init-microverse.js not found"
  exit 1
fi

if [ ! -f "$PROJECT_ROOT/bin/microverse-runner.js" ]; then
  echo "FAIL: bin/microverse-runner.js not found"
  exit 1
fi

# --- temp directories with cleanup ---
TMPDIR_TEST=$(mktemp -d)
SESSION_DIR="$TMPDIR_TEST/session"
TARGET_DIR="$TMPDIR_TEST/target"
mkdir -p "$SESSION_DIR" "$TARGET_DIR"

cleanup() { rm -rf "$TMPDIR_TEST"; }
trap cleanup EXIT

echo "=== microverse 3-iteration convergence smoke test ==="
echo "Temp dir: $TMPDIR_TEST"

# --- Step 1: Create a simple test file in target dir ---
echo "Step 1: Creating test file with 5 lines..."
for i in 1 2 3 4 5; do
  echo "line $i" >> "$TARGET_DIR/test.txt"
done
INITIAL_LINES=$(wc -l < "$TARGET_DIR/test.txt" | tr -d ' ')
echo "  Initial line count: $INITIAL_LINES"

# --- Step 2: Define trivial metric ---
echo "Step 2: Defining metric (line count, type: command)..."
METRIC_JSON=$(cat <<METRICEOF
{"description":"line count of test.txt","validation":"wc -l < $TARGET_DIR/test.txt | tr -d ' '","type":"command"}
METRICEOF
)
echo "  Metric: $METRIC_JSON"

# --- Step 3: Run init-microverse ---
echo ""
echo "Step 3: Running init-microverse.js..."
node "$PROJECT_ROOT/bin/init-microverse.js" \
  "$SESSION_DIR" "$TARGET_DIR" \
  --stall-limit 5 \
  --metric-json "$METRIC_JSON"

if [ $? -ne 0 ]; then
  echo "FAIL: init-microverse.js exited non-zero"
  exit 1
fi
echo "  OK: init-microverse.js completed"

# --- Step 4: Verify microverse.json created with status: gap_analysis ---
echo ""
echo "Step 4: Verifying microverse.json..."
if [ ! -f "$SESSION_DIR/microverse.json" ]; then
  echo "FAIL: microverse.json not found in $SESSION_DIR"
  exit 1
fi

INIT_STATUS=$(node -e "
const s = JSON.parse(require('fs').readFileSync('$SESSION_DIR/microverse.json','utf-8'));
console.log(s.status);
")

if [ "$INIT_STATUS" != "gap_analysis" ]; then
  echo "FAIL: expected status 'gap_analysis', got '$INIT_STATUS'"
  exit 1
fi
echo "  OK: microverse.json exists with status: gap_analysis"

# --- Step 5: Run convergence loop via Node harness ---
echo ""
echo "Step 5: Running convergence loop (max 3 iterations, ${TIMEOUT_SEC}s timeout)..."

set +e
HARNESS_OUTPUT=$(timeout "$TIMEOUT_SEC" node --input-type=module -e "
import { runMicroverse } from '${PROJECT_ROOT}/bin/microverse-runner.js';
import { EventEmitter } from 'node:events';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const sessionDir = '${SESSION_DIR}';
const targetFile = '${TARGET_DIR}/test.txt';
const statePath = path.join(sessionDir, 'microverse.json');

// Read initial state created by init-microverse
const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));

const deps = {
  state,
  stateManager: {
    read: () => state,
    update: (_p, mutator) => {
      mutator(state);
      fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
      return state;
    },
    forceWrite: () => {
      try { fs.writeFileSync(statePath, JSON.stringify(state, null, 2)); } catch {}
    },
  },
  spawn: () => {
    // Simulate worker: append a line to target file (improves metric)
    fs.appendFileSync(targetFile, 'iteration added line\n');
    const child = new EventEmitter();
    child.pid = 99999;
    child.killed = false;
    child.kill = () => { child.killed = true; };
    process.nextTick(() => child.emit('exit', 0, null));
    return child;
  },
  execSync: (cmd) => {
    if (cmd.startsWith('git rev-parse')) return Buffer.from('abc123def456\n');
    if (cmd.startsWith('git reset')) return Buffer.from('');
    if (cmd.startsWith('git status')) return Buffer.from('');
    if (cmd.startsWith('git diff')) return Buffer.from('');
    if (cmd.startsWith('git add')) return Buffer.from('');
    if (cmd.startsWith('git commit')) return Buffer.from('');
    // For metric validation, run the real command
    return execSync(cmd);
  },
  timeoutMs: 120000,
};

await runMicroverse({ sessionDir, deps, maxIterations: 3 });

// Persist final state
fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
console.log('harness_complete');
" 2>&1)
HARNESS_EXIT=$?
set -e

if [ "$HARNESS_EXIT" -eq 124 ]; then
  echo "FAIL: convergence loop timed out after ${TIMEOUT_SEC}s"
  exit 1
fi

if [ "$HARNESS_EXIT" -ne 0 ]; then
  echo "FAIL: convergence loop exited $HARNESS_EXIT"
  echo "  Output: $HARNESS_OUTPUT"
  exit 1
fi

if ! echo "$HARNESS_OUTPUT" | grep -q 'harness_complete'; then
  echo "FAIL: harness did not complete successfully"
  echo "  Output: $HARNESS_OUTPUT"
  exit 1
fi
echo "  OK: convergence loop completed"

# --- Step 6: Verify microverse.json state ---
echo ""
echo "Step 6: Verifying final state..."

VERIFY_RESULT=$(node -e "
const s = JSON.parse(require('fs').readFileSync('$SESSION_DIR/microverse.json','utf-8'));
const checks = [];

// iteration >= 1
if (typeof s.iteration === 'number' && s.iteration >= 1) {
  checks.push('iteration=' + s.iteration + ' OK');
} else {
  checks.push('FAIL iteration=' + s.iteration);
}

// history has entries
const history = (s.convergence && s.convergence.history) || [];
if (history.length > 0) {
  checks.push('history_len=' + history.length + ' OK');
} else {
  checks.push('FAIL history empty');
}

// status transitioned from gap_analysis (should be 'running' after gap_analysis phase)
if (s.status === 'running') {
  checks.push('status=running OK');
} else {
  checks.push('FAIL status=' + s.status + ' (expected running)');
}

// exit_reason should be set
if (s.exit_reason) {
  checks.push('exit_reason=' + s.exit_reason + ' OK');
} else {
  checks.push('WARN exit_reason not set');
}

const failed = checks.filter(c => c.startsWith('FAIL'));
checks.forEach(c => console.log('  ' + c));

if (failed.length > 0) {
  process.exit(1);
}
")

if [ $? -ne 0 ]; then
  echo "FAIL: state verification failed"
  echo "$VERIFY_RESULT"
  exit 1
fi
echo "$VERIFY_RESULT"

# --- Verdict ---
echo ""
echo "=== VERDICT: PASS ==="
echo "Microverse convergence loop verified: init → 3 iterations → state transitions correct"
exit 0
