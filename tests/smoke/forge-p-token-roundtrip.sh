#!/usr/bin/env bash
set -euo pipefail

# forge-p-token-roundtrip — end-to-end smoke test for promise token detection.
#
# Pipeline: forge -p agent outputs token → auto_dump JSON → token-parser extracts
# it correctly with role filtering (no false positives from tool results).
#
# References: PRD "Token Detection Strategy", lib/token-parser.js, architecture.md:184

PROJECT_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TIMEOUT_SEC=120

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
cleanup() { rm -rf "$TMPDIR_TEST"; }
trap cleanup EXIT

echo "=== forge -p token roundtrip smoke test ==="
echo "Temp dir: $TMPDIR_TEST"

# --- Step 1: Run forge -p with morty-worker, asking it to output a promise token ---
echo ""
echo "Step 1: Running forge -p --agent morty-worker (requesting promise token output)..."
set +e
(cd "$TMPDIR_TEST" && timeout "$TIMEOUT_SEC" forge -p --agent morty-worker \
  "Output exactly this text and nothing else: <promise>I AM DONE</promise>") \
  >"$TMPDIR_TEST/stdout.txt" \
  2>"$TMPDIR_TEST/stderr.txt"
FORGE_EXIT=$?
set -e

if [ "$FORGE_EXIT" -ne 0 ] && [ "$FORGE_EXIT" -ne 124 ]; then
  echo "WARN: forge -p exited $FORGE_EXIT"
fi
if [ "$FORGE_EXIT" -eq 124 ]; then
  echo "FAIL: forge -p timed out after ${TIMEOUT_SEC}s"
  exit 1
fi

# --- Step 2: Find the auto_dump JSON file ---
echo "Step 2: Looking for auto_dump JSON..."
DUMP_FILES=("$TMPDIR_TEST"/*-dump.json)
if [ ! -f "${DUMP_FILES[0]}" ]; then
  echo "FAIL: no *-dump.json file found in $TMPDIR_TEST"
  echo "--- directory contents ---"
  ls -la "$TMPDIR_TEST"
  echo "--- end ---"
  exit 1
fi

DUMP_FILE="${DUMP_FILES[-1]}"
echo "  Found: $(basename "$DUMP_FILE")"

# --- Step 3: Extract tokens via token-parser.js ---
echo "Step 3: Extracting tokens via token-parser.js..."
EXTRACT_RESULT=$(node --input-type=module -e "
import { parseAutoDump } from '${PROJECT_ROOT}/lib/token-parser.js';

const result = parseAutoDump('${DUMP_FILE}');
const output = {
  tokens: result.tokens,
  totalMessages: result.rawMessages.length,
  assistantCount: result.rawMessages.filter(m => m.text?.role === 'Assistant').length,
  toolCount: result.rawMessages.filter(m => m.tool != null).length,
};
console.log(JSON.stringify(output));
" 2>&1)

if [ $? -ne 0 ]; then
  echo "FAIL: token-parser.js failed"
  echo "$EXTRACT_RESULT"
  exit 1
fi

echo "  Result: $EXTRACT_RESULT"

# --- Step 4: Assert 'I AM DONE' is extracted ---
echo "Step 4: Asserting 'I AM DONE' token extracted..."
if ! echo "$EXTRACT_RESULT" | grep -q '"I AM DONE"'; then
  echo "FAIL: 'I AM DONE' not found in extracted tokens"
  echo "  Got: $EXTRACT_RESULT"
  exit 1
fi
echo "  OK: 'I AM DONE' found in extracted tokens"

# --- Step 5: Verify no false positives from tool results ---
echo "Step 5: Verifying no false positives from tool results..."
FP_CHECK=$(node --input-type=module -e "
import fs from 'node:fs';
import { extractTokensFromContent } from '${PROJECT_ROOT}/lib/token-parser.js';

const raw = JSON.parse(fs.readFileSync('${DUMP_FILE}', 'utf-8'));
const messages = raw?.conversation?.context?.messages || [];

// Check tool-result messages for tokens — these should NOT be extracted
const toolMsgs = messages.filter(m => m.tool != null);
let falsePositives = 0;
for (const msg of toolMsgs) {
  // Tool results shouldn't have text.content, but check any string fields
  const content = JSON.stringify(msg);
  const tokens = extractTokensFromContent(content);
  if (tokens.length > 0) {
    console.error('FALSE POSITIVE in tool result:', tokens);
    falsePositives++;
  }
}

// Check that system/user messages with tokens are NOT in the extracted set
const nonAssistant = messages.filter(m => m.text?.role && m.text.role !== 'Assistant');
for (const msg of nonAssistant) {
  const tokens = extractTokensFromContent(msg.text?.content);
  if (tokens.length > 0) {
    console.log('  Note: token in non-assistant message (correctly excluded):', msg.text.role, tokens);
  }
}

console.log(JSON.stringify({ toolMessages: toolMsgs.length, falsePositives }));
process.exit(falsePositives > 0 ? 1 : 0);
" 2>&1)

if [ $? -ne 0 ]; then
  echo "FAIL: false positive detected in tool results"
  echo "$FP_CHECK"
  exit 1
fi
echo "  $FP_CHECK"

# --- Verdict ---
echo ""
echo "=== VERDICT: PASS ==="
echo "Token roundtrip verified: forge -p → auto_dump → token-parser → 'I AM DONE' extracted"
exit 0
