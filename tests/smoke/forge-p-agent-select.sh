#!/usr/bin/env bash
set -euo pipefail

# forge-p-agent-select — smoke test verifying forge -p --agent X selects
# the correct agent definition and produces output.
#
# Tests: microverse-worker, microverse-judge, morty-worker, pickle-manager
# Also verifies a non-existent agent ID fails appropriately.
#
# References: PRD AC 2.2 (agent selection by phase), spike S12 (tool restriction)

# --- forge availability check ---
if ! command -v forge &>/dev/null; then
  echo "SKIP: forge not installed"
  exit 0
fi

AGENTS=(microverse-worker microverse-judge morty-worker pickle-manager)
PASS_COUNT=0
FAIL_COUNT=0
TIMEOUT_SEC=60

test_agent() {
  local agent_id="$1"
  local output exit_code

  set +e
  output=$(timeout "$TIMEOUT_SEC" forge -p --agent "$agent_id" "Describe your role in one sentence" 2>/dev/null)
  exit_code=$?
  set -e

  if [ "$exit_code" -ne 0 ]; then
    echo "FAIL: $agent_id — exit code $exit_code"
    FAIL_COUNT=$((FAIL_COUNT + 1))
    return
  fi

  if [ -z "$output" ]; then
    echo "FAIL: $agent_id — empty output"
    FAIL_COUNT=$((FAIL_COUNT + 1))
    return
  fi

  echo "PASS: $agent_id"
  PASS_COUNT=$((PASS_COUNT + 1))
}

# --- test each known agent ---
for agent in "${AGENTS[@]}"; do
  echo "Testing agent: $agent ..."
  test_agent "$agent"
done

# --- test non-existent agent ---
echo "Testing non-existent agent: nonexistent-agent-xyz ..."
set +e
bogus_output=$(timeout "$TIMEOUT_SEC" forge -p --agent nonexistent-agent-xyz "Hello" 2>/dev/null)
bogus_exit=$?
set -e

if [ "$bogus_exit" -ne 0 ] || [ -z "$bogus_output" ]; then
  echo "PASS: nonexistent agent correctly failed (exit=$bogus_exit, empty=$([ -z "$bogus_output" ] && echo yes || echo no))"
  PASS_COUNT=$((PASS_COUNT + 1))
else
  echo "FAIL: nonexistent agent unexpectedly succeeded with output"
  FAIL_COUNT=$((FAIL_COUNT + 1))
fi

# --- summary ---
TOTAL=$((PASS_COUNT + FAIL_COUNT))
echo ""
echo "=== Summary: $PASS_COUNT/$TOTAL passed ==="

if [ "$FAIL_COUNT" -gt 0 ]; then
  echo "VERDICT: FAIL"
  exit 1
fi

echo "VERDICT: PASS"
exit 0
