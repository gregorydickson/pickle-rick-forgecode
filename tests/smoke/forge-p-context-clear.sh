#!/usr/bin/env bash
set -euo pipefail

# forge-p-context-clear — smoke test verifying sequential forge -p calls
# don't share context. Validates the invariant that tmux-runner relies on:
# each forge -p invocation (without --cid) gets a fresh conversation.
#
# References: PRD AC 2.1 (context clearing), Spike S10 (--cid confirmation)
#
# Each forge call runs in its own empty temp directory so forge can't find
# the code word via filesystem search (forge has tool access to grep/read).

# --- forge availability check ---
if ! command -v forge &>/dev/null; then
  echo "SKIP: forge not installed"
  exit 0
fi

# --- generate unique code word that can't exist in any file ---
CODE_WORD="ZQXJ$(od -An -tx8 -N8 /dev/urandom | tr -d ' ')"

# --- temp dirs for isolation ---
TMPDIR_PLANT=$(mktemp -d)
TMPDIR_ASK=$(mktemp -d)
cleanup() { rm -rf "$TMPDIR_PLANT" "$TMPDIR_ASK"; }
trap cleanup EXIT

# --- Step 1: Plant the code word (isolated dir) ---
echo "Running: forge -p (plant code word)..."
set +e
(cd "$TMPDIR_PLANT" && forge -p "Remember the code word ${CODE_WORD}. Respond only with: Acknowledged.") \
  >"$TMPDIR_PLANT/stdout.txt" \
  2>"$TMPDIR_PLANT/stderr.txt"
PLANT_EXIT=$?
set -e

if [ "$PLANT_EXIT" -ne 0 ]; then
  echo "WARN: first forge -p exited $PLANT_EXIT (stderr below)"
  cat "$TMPDIR_PLANT/stderr.txt" >&2
fi

# --- Step 2: Ask for code word in a NEW conversation (isolated dir, no --cid) ---
echo "Running: forge -p (ask for code word, no --cid)..."
set +e
(cd "$TMPDIR_ASK" && forge -p "What is the code word? If you don't know a code word, respond only with the single word UNKNOWN.") \
  >"$TMPDIR_ASK/stdout.txt" \
  2>"$TMPDIR_ASK/stderr.txt"
ASK_EXIT=$?
set -e

if [ "$ASK_EXIT" -ne 0 ]; then
  echo "WARN: second forge -p exited $ASK_EXIT (stderr below)"
  cat "$TMPDIR_ASK/stderr.txt" >&2
fi

# --- Step 3: Assert no context bleed ---
ASK_OUTPUT=$(cat "$TMPDIR_ASK/stdout.txt")

if echo "$ASK_OUTPUT" | grep -qF "$CODE_WORD"; then
  echo ""
  echo "FAIL: context bleed detected — second forge -p returned code word"
  echo "Code word: $CODE_WORD"
  echo "--- second call stdout ---"
  echo "$ASK_OUTPUT"
  echo "--- end ---"
  exit 1
fi

echo "PASS: forge -p context isolation verified (code word not in second call)"
exit 0
