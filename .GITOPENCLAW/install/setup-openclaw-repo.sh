#!/usr/bin/env bash
# setup-openclaw-repo.sh — Clone and build OpenClaw from source.
#
# Clones openclaw/openclaw into .GITOPENCLAW/repo/openclaw/openclaw and
# builds it so the agent lifecycle scripts can use the local binary.
#
# Usage:
#   bash .GITOPENCLAW/install/setup-openclaw-repo.sh [--ref <git-ref>]
#
# Options:
#   --ref <git-ref>   Git ref to checkout (tag, branch, or commit SHA).
#                     Defaults to "main".
#
# The script is idempotent: if the repo is already cloned at the expected
# ref, it skips the clone and only rebuilds if dist/ is missing.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
GITOPENCLAW_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_DIR="$GITOPENCLAW_DIR/repo/openclaw/openclaw"
OPENCLAW_REMOTE="https://github.com/openclaw/openclaw.git"

# ── Parse arguments ──────────────────────────────────────────────────────────
REF="main"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --ref)
      REF="$2"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

echo "=== OpenClaw Source Setup ==="
echo "Target: $REPO_DIR"
echo "Ref:    $REF"
echo ""

# ── Clone if missing ─────────────────────────────────────────────────────────
if [ ! -d "$REPO_DIR/.git" ]; then
  echo "Cloning openclaw/openclaw..."
  mkdir -p "$(dirname "$REPO_DIR")"
  # Try cloning with --branch first (works for branches and tags).
  # If the ref is a commit SHA, --branch won't work, so fall back to a
  # plain clone and then fetch + checkout the specific ref.
  if git clone --depth 1 --branch "$REF" "$OPENCLAW_REMOTE" "$REPO_DIR" 2>&1; then
    echo "Cloned at ref: $REF"
  else
    echo "Could not clone with --branch $REF; trying default branch + fetch..."
    git clone --depth 1 "$OPENCLAW_REMOTE" "$REPO_DIR"
    cd "$REPO_DIR"
    if ! git fetch --depth 1 origin "$REF"; then
      echo "::error::Failed to fetch ref '$REF' from $OPENCLAW_REMOTE"
      exit 1
    fi
    git checkout FETCH_HEAD
  fi
  echo "Clone complete."
else
  echo "Repository already cloned."
  cd "$REPO_DIR"
  # For moving refs (e.g. "main"), pull latest to avoid stale cache
  echo "Updating to latest $REF..."
  git fetch --depth 1 origin "$REF" 2>&1 && git checkout FETCH_HEAD 2>&1 || \
    echo "::warning::Could not update to latest $REF; using cached version"
  CURRENT_REF=$(git rev-parse HEAD 2>/dev/null || echo "unknown")
  echo "Current HEAD: $CURRENT_REF"
fi

cd "$REPO_DIR"

# ── Apply GITOPENCLAW patches ────────────────────────────────────────────────
# Source code modifications for CI-awareness and path isolation.
# See .GITOPENCLAW/docs/APPLIED-MASTER-MODIFICATIONS.md for full details.
PATCH_SCRIPT="$GITOPENCLAW_DIR/install/apply-openclaw-patches.sh"
NEEDS_REBUILD=false
if [ -f "$PATCH_SCRIPT" ]; then
  echo ""
  PATCH_OUTPUT=$(bash "$PATCH_SCRIPT" --repo-dir "$REPO_DIR" 2>&1)
  echo "$PATCH_OUTPUT"
  # If any patches were applied (not just skipped), we need to rebuild
  if echo "$PATCH_OUTPUT" | grep -q 'Patches applied: [1-9]'; then
    NEEDS_REBUILD=true
  fi
  echo ""
else
  echo "::warning::Patch script not found at $PATCH_SCRIPT — skipping patches"
fi

# ── Install dependencies ─────────────────────────────────────────────────────
# Use pnpm if available, fall back to npm
if command -v pnpm &>/dev/null; then
  echo "Installing dependencies with pnpm..."
  pnpm install --frozen-lockfile 2>/dev/null || pnpm install
else
  echo "Installing dependencies with npm..."
  npm install
fi

# ── Build ─────────────────────────────────────────────────────────────────────
# Rebuild if dist/ is missing or if patches were applied (source files changed).
if [ "$NEEDS_REBUILD" = true ]; then
  echo "Patches applied — rebuilding to incorporate source changes..."
  rm -rf "$REPO_DIR/dist"
fi

if [ ! -d "$REPO_DIR/dist" ] || { [ ! -f "$REPO_DIR/dist/entry.js" ] && [ ! -f "$REPO_DIR/dist/entry.mjs" ]; }; then
  echo "Building OpenClaw..."
  if command -v pnpm &>/dev/null; then
    pnpm build
  else
    npm run build
  fi
  echo "Build complete."
else
  echo "Build output already exists, skipping build."
fi

echo ""
echo "✅ OpenClaw source ready at: $REPO_DIR"
echo "   Entry point: $REPO_DIR/openclaw.mjs"
