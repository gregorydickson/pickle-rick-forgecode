#!/usr/bin/env bash
set -uo pipefail

# platform-verification — re-runs key Phase 0 checks.
# Exit 0 if all required checks pass, 1 otherwise.

FAILURES=0

check_required() {
  local name="$1"
  shift
  if "$@" &>/dev/null; then
    echo "PASS: $name"
  else
    echo "FAIL: $name"
    FAILURES=$((FAILURES + 1))
  fi
}

check_optional() {
  local name="$1"
  shift
  if "$@" &>/dev/null; then
    echo "PASS: $name"
  else
    echo "SKIP: $name (not required)"
  fi
}

# Node >= 20
NODE_VERSION=$(node --version 2>/dev/null | sed 's/^v//' | cut -d. -f1)
if [ -n "$NODE_VERSION" ] && [ "$NODE_VERSION" -ge 20 ]; then
  echo "PASS: node >= 20 (v$(node --version 2>/dev/null | sed 's/^v//'))"
else
  echo "FAIL: node >= 20 required (got: $(node --version 2>/dev/null || echo 'not found'))"
  FAILURES=$((FAILURES + 1))
fi

# tmux installed
check_required "tmux installed" tmux -V

# git available
check_required "git available" git --version

# forge installed (optional — graceful skip)
check_optional "forge installed" forge --version

if [ "$FAILURES" -gt 0 ]; then
  echo ""
  echo "RESULT: $FAILURES required check(s) failed"
  exit 1
fi

echo ""
echo "RESULT: all required checks passed"
exit 0
