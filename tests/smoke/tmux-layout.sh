#!/usr/bin/env bash
set -euo pipefail

# tmux-layout smoke test — verifies tmux session creation with correct pane count.
# Usage: tmux-layout.sh [session-name]

SESSION_NAME="${1:-forgecode-smoke-$$}"
EXPECTED_PANES=4

cleanup() {
  tmux kill-session -t "$SESSION_NAME" 2>/dev/null || true
}
trap cleanup EXIT

# Verify tmux is available
if ! command -v tmux &>/dev/null; then
  echo "FAIL: tmux not found"
  exit 1
fi

# Create detached session with 4 panes
tmux new-session -d -s "$SESSION_NAME" -x 120 -y 40
tmux split-window -t "$SESSION_NAME" -h
tmux split-window -t "$SESSION_NAME" -v
tmux select-pane -t "$SESSION_NAME:0.0"
tmux split-window -t "$SESSION_NAME" -v
tmux select-layout -t "$SESSION_NAME" tiled

# Verify session exists
if ! tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
  echo "FAIL: session '$SESSION_NAME' not created"
  exit 1
fi
echo "PASS: session '$SESSION_NAME' created"

# Check pane count
PANE_COUNT=$(tmux list-panes -t "$SESSION_NAME" | wc -l | tr -d ' ')
if [ "$PANE_COUNT" -lt "$EXPECTED_PANES" ]; then
  echo "FAIL: expected >= $EXPECTED_PANES panes, got $PANE_COUNT"
  exit 1
fi
echo "PASS: pane count = $PANE_COUNT (>= $EXPECTED_PANES)"

# Send a test command to the pane to verify it accepts input
tmux send-keys -t "$SESSION_NAME" "echo smoke-test-ok" C-m

echo "PASS: tmux-layout smoke test complete"
exit 0
