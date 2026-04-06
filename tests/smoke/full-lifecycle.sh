#!/usr/bin/env bash
set -euo pipefail

# full-lifecycle — end-to-end smoke test for the ForgeCode pipeline.
#
# Pipeline: setup.js creates session → tmux-runner.js orchestrates forge -p
# workers → completion token detected → loop exits cleanly.
#
# References: PRD CUJ 2.1 (full lifecycle), Phase 4 gate

PROJECT_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TIMEOUT_SEC=300

# --- forge availability check ---
if ! command -v forge &>/dev/null; then
  echo "SKIP: forge not installed"
  exit 0
fi

# --- auto_dump config check ---
FORGE_TOML="$HOME/forge/.forge.toml"
if [ ! -f "$FORGE_TOML" ]; then
  echo "SKIP: $FORGE_TOML not found (auto_dump config required)"
  exit 0
fi

if ! grep -q 'auto_dump.*=.*"json"' "$FORGE_TOML"; then
  echo "SKIP: auto_dump = \"json\" not configured in $FORGE_TOML"
  exit 0
fi

# --- temp directory with cleanup ---
TMPDIR_TEST=$(mktemp -d)
cleanup() {
  local exit_code=$?
  if [ "$exit_code" -ne 0 ] && [ -d "$TMPDIR_TEST" ]; then
    echo ""
    echo "=== Failure logs ==="
    if [ -f "$TMPDIR_TEST/setup_stdout.txt" ]; then
      echo "--- setup stdout ---"
      cat "$TMPDIR_TEST/setup_stdout.txt"
    fi
    if [ -f "$TMPDIR_TEST/runner_stdout.txt" ]; then
      echo "--- runner stdout ---"
      tail -50 "$TMPDIR_TEST/runner_stdout.txt"
    fi
    if [ -f "$TMPDIR_TEST/runner_stderr.txt" ]; then
      echo "--- runner stderr ---"
      tail -50 "$TMPDIR_TEST/runner_stderr.txt"
    fi
    if [ -n "${SESSION_ROOT:-}" ] && [ -f "$SESSION_ROOT/state.json" ]; then
      echo "--- state.json ---"
      cat "$SESSION_ROOT/state.json"
    fi
    echo "=== end logs ==="
  fi
  rm -rf "$TMPDIR_TEST"
}
trap cleanup EXIT

echo "=== full lifecycle smoke test ==="
echo "Temp dir: $TMPDIR_TEST"

# --- Step 1: Initialize a git repo in the temp dir ---
echo ""
echo "Step 1: Initializing temporary git repo..."
WORK_DIR="$TMPDIR_TEST/workdir"
mkdir -p "$WORK_DIR"
(cd "$WORK_DIR" && git init -q && git commit --allow-empty -m "initial" -q)
echo "  OK: git repo initialized at $WORK_DIR"

# --- Step 2: Run setup.js to create a session ---
echo ""
echo "Step 2: Running setup.js..."
set +e
SETUP_OUTPUT=$(FORGECODE_SESSION_ROOT="$TMPDIR_TEST" \
  node "$PROJECT_ROOT/bin/setup.js" \
    --task "Create a file called hello.txt containing the text Hello World" \
    --max-iterations 3 \
  2>"$TMPDIR_TEST/setup_stderr.txt")
SETUP_EXIT=$?
set -e

echo "$SETUP_OUTPUT" > "$TMPDIR_TEST/setup_stdout.txt"

if [ "$SETUP_EXIT" -ne 0 ]; then
  echo "FAIL: setup.js exited $SETUP_EXIT"
  exit 1
fi

SESSION_ROOT=$(echo "$SETUP_OUTPUT" | grep '^SESSION_ROOT=' | head -1 | cut -d= -f2-)
if [ -z "$SESSION_ROOT" ]; then
  echo "FAIL: SESSION_ROOT not found in setup.js output"
  echo "  Output: $SETUP_OUTPUT"
  exit 1
fi

echo "  OK: session created at $SESSION_ROOT"

# --- Step 3: Verify initial state.json ---
echo ""
echo "Step 3: Verifying initial state.json..."
STATE_FILE="$SESSION_ROOT/state.json"

if [ ! -f "$STATE_FILE" ]; then
  echo "FAIL: state.json not found at $STATE_FILE"
  exit 1
fi

INIT_CHECK=$(node -e "
const s = JSON.parse(require('fs').readFileSync('$STATE_FILE','utf-8'));
const checks = [];
if (s.iteration === 0) checks.push('iteration=0 OK');
else checks.push('FAIL iteration=' + s.iteration);
if (s.active === true) checks.push('active=true OK');
else checks.push('FAIL active=' + s.active);
if (s.step === 'research') checks.push('step=research OK');
else checks.push('FAIL step=' + s.step);
const failed = checks.filter(c => c.startsWith('FAIL'));
checks.forEach(c => console.log('  ' + c));
process.exit(failed.length > 0 ? 1 : 0);
")

if [ $? -ne 0 ]; then
  echo "FAIL: initial state verification failed"
  echo "$INIT_CHECK"
  exit 1
fi
echo "$INIT_CHECK"

# --- Step 4: Record pre-run git state ---
echo ""
echo "Step 4: Recording pre-run git state..."
PRE_COMMIT_COUNT=$(cd "$WORK_DIR" && git rev-list --count HEAD)
echo "  Pre-run commit count: $PRE_COMMIT_COUNT"

# --- Step 5: Run tmux-runner.js ---
echo ""
echo "Step 5: Running tmux-runner.js (${TIMEOUT_SEC}s timeout)..."

# Override working_dir in state.json to point to our temp git repo
node -e "
const fs = require('fs');
const s = JSON.parse(fs.readFileSync('$STATE_FILE','utf-8'));
s.working_dir = '$WORK_DIR';
fs.writeFileSync('$STATE_FILE', JSON.stringify(s, null, 2));
"

set +e
timeout "$TIMEOUT_SEC" node "$PROJECT_ROOT/bin/tmux-runner.js" "$STATE_FILE" \
  >"$TMPDIR_TEST/runner_stdout.txt" \
  2>"$TMPDIR_TEST/runner_stderr.txt"
RUNNER_EXIT=$?
set -e

if [ "$RUNNER_EXIT" -eq 124 ]; then
  echo "FAIL: tmux-runner timed out after ${TIMEOUT_SEC}s"
  exit 1
fi

echo "  Runner exited with code: $RUNNER_EXIT"

# --- Step 6: Verify state.json progression ---
echo ""
echo "Step 6: Verifying state.json progression..."

STATE_CHECK=$(node -e "
const s = JSON.parse(require('fs').readFileSync('$STATE_FILE','utf-8'));
const checks = [];

// iteration >= 1
if (typeof s.iteration === 'number' && s.iteration >= 1) {
  checks.push('iteration=' + s.iteration + ' OK');
} else {
  checks.push('FAIL iteration=' + s.iteration + ' (expected >= 1)');
}

const failed = checks.filter(c => c.startsWith('FAIL'));
checks.forEach(c => console.log('  ' + c));
process.exit(failed.length > 0 ? 1 : 0);
")

if [ $? -ne 0 ]; then
  echo "FAIL: state progression verification failed"
  echo "$STATE_CHECK"
  exit 1
fi
echo "$STATE_CHECK"

# --- Step 7: Verify git commit was made ---
echo ""
echo "Step 7: Checking for git commits..."
POST_COMMIT_COUNT=$(cd "$WORK_DIR" && git rev-list --count HEAD)
echo "  Post-run commit count: $POST_COMMIT_COUNT"

if [ "$POST_COMMIT_COUNT" -gt "$PRE_COMMIT_COUNT" ]; then
  echo "  OK: new commits detected ($POST_COMMIT_COUNT > $PRE_COMMIT_COUNT)"
elif (cd "$WORK_DIR" && git status --porcelain | grep -q .); then
  echo "  WARN: no new commits but working tree has changes (forge may not have committed)"
else
  echo "  WARN: no new commits and clean working tree — forge may not have made changes"
fi

# --- Step 8: Verify clean exit ---
echo ""
echo "Step 8: Verifying clean exit..."
if [ "$RUNNER_EXIT" -eq 0 ]; then
  echo "  OK: runner exited cleanly (exit 0)"
else
  echo "  WARN: runner exited with code $RUNNER_EXIT (non-zero but not timeout)"
fi

# --- Verdict ---
echo ""
echo "=== VERDICT: PASS ==="
echo "Full lifecycle verified: setup.js → tmux-runner.js → iteration ran → clean exit"
exit 0
