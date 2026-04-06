#!/usr/bin/env bash
set -euo pipefail

# forge-spawn-contract — validates the forge CLI arg format used by
# tmux-runner.js and spawn-refinement-team.js.
#
# Verifies:
#   1. -p OR --prompt-file is present (prompt delivery)
#   2. --agent is present (agent selection)
#   3. -C is present (working directory)
#
# Usage: forge-spawn-contract.sh
# Exit 0 = all contract checks pass, 1 = violation detected.

PROJECT_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

PASS_COUNT=0
FAIL_COUNT=0

pass() { echo "PASS: $1"; PASS_COUNT=$((PASS_COUNT + 1)); }
fail() { echo "FAIL: $1"; FAIL_COUNT=$((FAIL_COUNT + 1)); }

# --- Extract forge spawn arg arrays from source files ---

# tmux-runner.js: spawn('forge', ['-p', ..., '--agent', ..., '-C', ...])
TMUX_SPAWN_LINE=$(grep -n "spawnFn('forge'" "$PROJECT_ROOT/bin/tmux-runner.js" || true)
if [ -z "$TMUX_SPAWN_LINE" ]; then
  fail "tmux-runner.js: no forge spawn call found"
else
  LINE_CONTENT=$(echo "$TMUX_SPAWN_LINE" | head -1)
  # Check required flags in the spawn args
  if echo "$LINE_CONTENT" | grep -qE "'-p'|'--prompt-file'"; then
    pass "tmux-runner.js: has prompt flag (-p or --prompt-file)"
  else
    fail "tmux-runner.js: missing prompt flag (-p or --prompt-file)"
  fi

  if echo "$LINE_CONTENT" | grep -q "'--agent'"; then
    pass "tmux-runner.js: has --agent flag"
  else
    fail "tmux-runner.js: missing --agent flag"
  fi

  if echo "$LINE_CONTENT" | grep -q "'-C'"; then
    pass "tmux-runner.js: has -C flag"
  else
    fail "tmux-runner.js: missing -C flag"
  fi
fi

# spawn-refinement-team.js: spawn('forge', args, {})
# Two patterns: -p (inline) and --prompt-file
REFINE_LINES=$(grep -n "args = \[" "$PROJECT_ROOT/bin/spawn-refinement-team.js" || true)
if [ -z "$REFINE_LINES" ]; then
  fail "spawn-refinement-team.js: no args array found"
else
  HAS_PROMPT=false
  HAS_AGENT=false
  HAS_CWD=false

  while IFS= read -r line; do
    echo "$line" | grep -qE "'-p'|'--prompt-file'" && HAS_PROMPT=true
    echo "$line" | grep -q "'--agent'" && HAS_AGENT=true
    echo "$line" | grep -q "'-C'" && HAS_CWD=true
  done <<< "$REFINE_LINES"

  if $HAS_PROMPT; then
    pass "spawn-refinement-team.js: has prompt flag (-p or --prompt-file)"
  else
    fail "spawn-refinement-team.js: missing prompt flag"
  fi

  if $HAS_AGENT; then
    pass "spawn-refinement-team.js: has --agent flag"
  else
    fail "spawn-refinement-team.js: missing --agent flag"
  fi

  if $HAS_CWD; then
    pass "spawn-refinement-team.js: has -C flag"
  else
    fail "spawn-refinement-team.js: missing -C flag"
  fi
fi

# --- Summary ---
TOTAL=$((PASS_COUNT + FAIL_COUNT))
echo ""
echo "=== Summary: $PASS_COUNT/$TOTAL passed ==="

if [ "$FAIL_COUNT" -gt 0 ]; then
  echo "VERDICT: FAIL"
  exit 1
fi

echo "VERDICT: PASS"
exit 0
