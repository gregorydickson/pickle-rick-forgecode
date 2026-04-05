#!/usr/bin/env bash
set -euo pipefail

# measure-metric.sh — Generic metric measurement wrapper.
# Reads metric JSON config, executes the validation command, outputs numeric score.
# Exit 1 if validation output is non-numeric.
#
# Usage:
#   bash measure-metric.sh <metric-json-file>
#   echo '{"validation":"npm test -- --coverage | tail -1"}' | bash measure-metric.sh /dev/stdin

METRIC_FILE="${1:?Usage: measure-metric.sh <metric-json-file>}"

if [ ! -r "$METRIC_FILE" ]; then
  echo "Error: cannot read metric file: $METRIC_FILE" >&2
  exit 1
fi

METRIC_JSON=$(cat "$METRIC_FILE")

# Extract validation command from JSON.
# Use jq if available, fall back to grep/sed for portability.
if command -v jq &>/dev/null; then
  VALIDATION=$(echo "$METRIC_JSON" | jq -r '.validation // empty')
else
  VALIDATION=$(echo "$METRIC_JSON" | grep -o '"validation"\s*:\s*"[^"]*"' | sed 's/.*"\([^"]*\)"$/\1/')
fi

if [ -z "$VALIDATION" ]; then
  echo "Error: no 'validation' field in metric JSON" >&2
  exit 1
fi

# Run the validation command, capture output.
OUTPUT=$(eval "$VALIDATION" 2>/dev/null) || {
  echo "Error: validation command failed: $VALIDATION" >&2
  exit 1
}

# Extract the last numeric value from output (integer or decimal).
SCORE=$(echo "$OUTPUT" | grep -oE '[0-9]+(\.[0-9]+)?' | tail -1 || true)

if [ -z "$SCORE" ]; then
  echo "Error: non-numeric output from validation command" >&2
  echo "Raw output: $OUTPUT" >&2
  exit 1
fi

echo "$SCORE"
