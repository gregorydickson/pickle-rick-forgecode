#!/usr/bin/env bash
set -euo pipefail

# phase1-gate — runs all unit tests and smoke tests.
# Exit 0 = Phase 1 complete.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$PROJECT_ROOT"

echo "=== Phase 1 Gate ==="
echo ""

# --- Unit Tests ---
echo "--- Unit Tests ---"

UNIT_TESTS=(
  tests/state-manager.test.js
  tests/circuit-breaker.test.js
  tests/token-parser.test.js
  tests/persona.test.js
  tests/git-utils.test.js
  tests/handoff.test.js
  tests/tmux-runner.test.js
  tests/setup.test.js
)

for test_file in "${UNIT_TESTS[@]}"; do
  echo "Running: $test_file"
  node --test "$test_file"
done

echo ""
echo "--- Smoke Tests ---"

# Platform verification
echo "Running: tests/smoke/platform-verification.sh"
bash tests/smoke/platform-verification.sh

# tmux layout
echo "Running: tests/smoke/tmux-layout.sh"
bash tests/smoke/tmux-layout.sh "phase1-gate-$$"

# smoke.test.js (script existence checks)
echo "Running: tests/smoke.test.js"
node --test tests/smoke.test.js

echo ""
echo "=== Phase 1 Gate: PASSED ==="
exit 0
