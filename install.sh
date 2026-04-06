#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GLOBAL_DIR="$HOME/forge"
MODE=""
TARGET_DIR=""

# ---------------------------------------------------------------------------
# Usage
# ---------------------------------------------------------------------------
usage() {
  cat <<HELP
🥒 Pickle Rick for ForgeCode — Installer

Usage:
  bash install.sh --global              Install globally (~/.forge agents/skills available to all projects)
  bash install.sh --project [path]      Install into a specific project (default: current directory)
  bash install.sh                       Interactive — prompts for mode

Options:
  --global          Install agents, skills, and persona to ~/forge/ (available everywhere)
  --project [path]  Install agents, skills, persona, bin/, lib/ to a project directory
  -h, --help        Show this help

Global install:
  Agents and skills are available to ALL forge sessions without per-project setup.
  Orchestration scripts (bin/, lib/) are NOT copied — run them from the pickle-rick-forgecode repo.

Project install:
  Everything copied into the project. Self-contained — no dependency on this repo.
  Orchestration scripts included. Agents/skills can be customized per-project.
HELP
  exit 0
}

# ---------------------------------------------------------------------------
# Parse args
# ---------------------------------------------------------------------------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --global)   MODE="global"; shift ;;
    --project)  MODE="project"; shift; TARGET_DIR="${1:-$(pwd)}"; shift 2>/dev/null || true ;;
    -h|--help)  usage ;;
    *)          TARGET_DIR="$1"; MODE="project"; shift ;;
  esac
done

# Interactive mode selection if no flag
if [ -z "$MODE" ]; then
  echo "🥒 Pickle Rick for ForgeCode — Installer"
  echo ""
  echo "  1) Global install  — agents & skills available to all projects"
  echo "  2) Project install — self-contained copy in a project directory"
  echo ""
  read -rp "Choose [1/2]: " choice
  case "$choice" in
    1) MODE="global" ;;
    2) MODE="project"; read -rp "Project path [$(pwd)]: " p; TARGET_DIR="${p:-$(pwd)}" ;;
    *) echo "Invalid choice"; exit 1 ;;
  esac
fi

# Verify forge is installed
if ! command -v forge &>/dev/null; then
  echo "❌ ForgeCode CLI not found. Install from: https://forgecode.dev"
  exit 1
fi

echo ""
echo "🥒 Installing Pickle Rick for ForgeCode (${MODE})..."
echo ""

# ---------------------------------------------------------------------------
# Global install
# ---------------------------------------------------------------------------
if [ "$MODE" = "global" ]; then
  # Agents → ~/forge/agents/
  echo "📦 Installing agents to $GLOBAL_DIR/agents/..."
  mkdir -p "$GLOBAL_DIR/agents"
  cp "$SCRIPT_DIR/.forge/agents/"*.md "$GLOBAL_DIR/agents/" 2>/dev/null || true
  rm -f "$GLOBAL_DIR/agents/spike-"*.md 2>/dev/null || true

  # Skills → ~/forge/skills/
  echo "📦 Installing skills to $GLOBAL_DIR/skills/..."
  mkdir -p "$GLOBAL_DIR/skills"
  cp -r "$SCRIPT_DIR/.forge/skills/"* "$GLOBAL_DIR/skills/"

  # AGENTS.md → ~/forge/AGENTS.md
  echo "📦 Installing persona to $GLOBAL_DIR/AGENTS.md..."
  cp "$SCRIPT_DIR/.forge/AGENTS.md" "$GLOBAL_DIR/AGENTS.md"

  echo ""
  echo "ℹ️  Orchestration scripts (bin/, lib/) NOT installed globally."
  echo "    Run them from: $SCRIPT_DIR"
  echo "    Example: node $SCRIPT_DIR/bin/setup.js --tmux --task \"your task\""

# ---------------------------------------------------------------------------
# Project install
# ---------------------------------------------------------------------------
elif [ "$MODE" = "project" ]; then
  TARGET_DIR="${TARGET_DIR:-$(pwd)}"

  # Self-install guard
  if [ "$SCRIPT_DIR" = "$TARGET_DIR" ]; then
    echo "ℹ️  Source = target — skipping file copy (self-install)"
  else
    echo "📦 Installing agents to $TARGET_DIR/.forge/agents/..."
    mkdir -p "$TARGET_DIR/.forge/agents"
    cp "$SCRIPT_DIR/.forge/agents/"*.md "$TARGET_DIR/.forge/agents/" 2>/dev/null || true
    rm -f "$TARGET_DIR/.forge/agents/spike-"*.md 2>/dev/null || true

    echo "📦 Installing skills to $TARGET_DIR/.forge/skills/..."
    mkdir -p "$TARGET_DIR/.forge/skills"
    cp -r "$SCRIPT_DIR/.forge/skills/"* "$TARGET_DIR/.forge/skills/"

    echo "📦 Installing persona to $TARGET_DIR/.forge/AGENTS.md..."
    cp "$SCRIPT_DIR/.forge/AGENTS.md" "$TARGET_DIR/.forge/AGENTS.md"

    echo "📦 Installing orchestration scripts to $TARGET_DIR/bin/..."
    mkdir -p "$TARGET_DIR/bin"
    cp "$SCRIPT_DIR/bin/"*.js "$TARGET_DIR/bin/"

    echo "📦 Installing lib modules to $TARGET_DIR/lib/..."
    mkdir -p "$TARGET_DIR/lib"
    cp "$SCRIPT_DIR/lib/"*.js "$TARGET_DIR/lib/"
  fi
fi

# ---------------------------------------------------------------------------
# Configure auto_dump (both modes)
# ---------------------------------------------------------------------------
FORGE_CONFIG="$HOME/forge/.forge.toml"
if [ -f "$FORGE_CONFIG" ]; then
  if ! grep -q 'auto_dump' "$FORGE_CONFIG"; then
    echo 'auto_dump = "json"' >> "$FORGE_CONFIG"
    echo "✅ Enabled auto_dump in $FORGE_CONFIG"
  else
    echo "ℹ️  auto_dump already configured in $FORGE_CONFIG"
  fi
else
  echo "⚠️  ForgeCode config not found at $FORGE_CONFIG"
  echo "    Run 'forge' once to initialize, then re-run install.sh"
fi

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------
echo ""
echo "✅ Pickle Rick for ForgeCode installed! (${MODE})"
echo ""
if [ "$MODE" = "global" ]; then
  echo "Agents and skills are now available in all forge sessions."
  echo "Run orchestration from: $SCRIPT_DIR"
  echo ""
  echo "  cd /your/project"
  echo "  node $SCRIPT_DIR/bin/setup.js --tmux --task \"your task\""
  echo "  node $SCRIPT_DIR/bin/tmux-runner.js <SESSION_ROOT>"
else
  echo "Get started in $TARGET_DIR:"
  echo ""
  echo "  cd $TARGET_DIR"
  echo "  node bin/setup.js --tmux --task \"your task\""
  echo "  node bin/tmux-runner.js <SESSION_ROOT>"
fi
