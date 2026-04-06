#!/usr/bin/env bash
set -euo pipefail

echo "🥒 Installing Pickle Rick for ForgeCode..."

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET_DIR="${1:-$(pwd)}"

# Skip copy if source = target (self-install)
if [ "$SCRIPT_DIR" = "$TARGET_DIR" ]; then
  SELF_INSTALL=true
else
  SELF_INSTALL=false
fi

# Verify forge is installed
if ! command -v forge &>/dev/null; then
  echo "❌ ForgeCode CLI not found. Install from: https://forgecode.dev"
  exit 1
fi

if [ "$SELF_INSTALL" = false ]; then
  # Copy agent definitions
  echo "📦 Installing agent definitions..."
  mkdir -p "$TARGET_DIR/.forge/agents"
  cp -r "$SCRIPT_DIR/.forge/agents/"*.md "$TARGET_DIR/.forge/agents/" 2>/dev/null || true
  rm -f "$TARGET_DIR/.forge/agents/spike-"*.md 2>/dev/null || true

  # Copy skills
  echo "📦 Installing skills..."
  mkdir -p "$TARGET_DIR/.forge/skills"
  cp -r "$SCRIPT_DIR/.forge/skills/"* "$TARGET_DIR/.forge/skills/"

  # Copy AGENTS.md (persona)
  echo "📦 Installing persona..."
  cp "$SCRIPT_DIR/.forge/AGENTS.md" "$TARGET_DIR/.forge/AGENTS.md"

  # Copy bin scripts
  echo "📦 Installing orchestration scripts..."
  mkdir -p "$TARGET_DIR/bin"
  cp "$SCRIPT_DIR/bin/"*.js "$TARGET_DIR/bin/"

  # Copy lib modules
  echo "📦 Installing lib modules..."
  mkdir -p "$TARGET_DIR/lib"
  cp "$SCRIPT_DIR/lib/"*.js "$TARGET_DIR/lib/"
else
  echo "ℹ️  Source = target — skipping file copy (self-install)"
fi

# Enable auto_dump in forge config
FORGE_CONFIG="$HOME/forge/.forge.toml"
if [ -f "$FORGE_CONFIG" ]; then
  if ! grep -q 'auto_dump' "$FORGE_CONFIG"; then
    echo 'auto_dump = "json"' >> "$FORGE_CONFIG"
    echo "✅ Enabled auto_dump in $FORGE_CONFIG"
  else
    echo "ℹ️  auto_dump already configured in $FORGE_CONFIG"
  fi
else
  echo "⚠️  ForgeCode config not found at $FORGE_CONFIG — run 'forge' once to initialize, then re-run install.sh"
fi

echo ""
echo "✅ Pickle Rick for ForgeCode installed!"
echo ""
echo "Get started:"
echo "  node bin/setup.js --tmux --task \"your task here\""
echo "  node bin/tmux-runner.js <SESSION_ROOT>"
