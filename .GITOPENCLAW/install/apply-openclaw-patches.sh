#!/usr/bin/env bash
# apply-openclaw-patches.sh — Apply GITOPENCLAW-specific patches to the cloned OpenClaw repo.
#
# These patches correspond to the modifications documented in:
#   .GITOPENCLAW/docs/APPLIED-MASTER-MODIFICATIONS.md
#
# When the execution source for the GitHub Action was moved from the fork itself
# to a fresh clone of openclaw/openclaw, the same CI-awareness and path-isolation
# improvements need to be re-applied after every clone or refresh.
#
# Usage:
#   bash .GITOPENCLAW/install/apply-openclaw-patches.sh [--repo-dir <path>]
#
# Options:
#   --repo-dir <path>  Path to the cloned openclaw repo.
#                       Defaults to .GITOPENCLAW/repo/openclaw/openclaw
#
# Each patch is idempotent: if already applied, it is skipped silently.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
GITOPENCLAW_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# ── Parse arguments ──────────────────────────────────────────────────────────
REPO_DIR="$GITOPENCLAW_DIR/repo/openclaw/openclaw"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo-dir)
      REPO_DIR="$2"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

if [ ! -d "$REPO_DIR/src" ]; then
  echo "::error::OpenClaw repo not found at $REPO_DIR"
  exit 1
fi

echo "=== Applying GITOPENCLAW Patches ==="
echo "Target: $REPO_DIR"
echo ""

applied=0
skipped=0

# ── Helper: report patch status ─────────────────────────────────────────────
patch_applied() {
  echo "  ✅ $1"
  ((applied++)) || true
}
patch_skipped() {
  echo "  ⏭️  $1 (already applied)"
  ((skipped++)) || true
}

# ─────────────────────────────────────────────────────────────────────────────
# Patch 1: src/config/paths.ts — Skip legacy home-dir scanning when
#          OPENCLAW_STATE_DIR is set.
#
# In resolveDefaultConfigCandidates(), add `return candidates;` after the
# openclawStateDir candidate block so stale configs in ~/.openclaw/ are never
# accidentally picked up.
# ─────────────────────────────────────────────────────────────────────────────
FILE="$REPO_DIR/src/config/paths.ts"
PATCH_NAME="paths.ts: skip legacy scanning when OPENCLAW_STATE_DIR set"
if [ -f "$FILE" ]; then
  # Check if the early return is already present inside the openclawStateDir block
  if grep -q '// When OPENCLAW_STATE_DIR is explicitly set' "$FILE" 2>/dev/null; then
    patch_skipped "$PATCH_NAME"
  else
    # Insert `return candidates;` after the LEGACY_CONFIG_FILENAMES push inside
    # the `if (openclawStateDir)` block in resolveDefaultConfigCandidates().
    # We match the unique line that pushes legacy config filenames within that block.
    sed -i '/candidates\.push(\.\.\.LEGACY_CONFIG_FILENAMES\.map.*path\.join(resolved/a\    // When OPENCLAW_STATE_DIR is explicitly set, skip legacy home-dir scanning\n    // so that stale configs in ~/.openclaw/ are never accidentally picked up.\n    return candidates;' "$FILE"
    if grep -q '// When OPENCLAW_STATE_DIR is explicitly set' "$FILE" 2>/dev/null; then
      patch_applied "$PATCH_NAME"
    else
      echo "  ⚠️  $PATCH_NAME — failed to apply (upstream may have changed)"
    fi
  fi
else
  echo "  ⚠️  $FILE not found — skipping"
fi

# ─────────────────────────────────────────────────────────────────────────────
# Patch 2: src/config/paths.ts — Lazy accessors for STATE_DIR and CONFIG_PATH.
#
# Add getStateDir() and getConfigPath() functions that re-evaluate on each
# call, so env vars set after import are respected.
# ─────────────────────────────────────────────────────────────────────────────
PATCH_NAME="paths.ts: lazy accessor getStateDir()"
if [ -f "$FILE" ]; then
  if grep -q 'export function getStateDir' "$FILE" 2>/dev/null; then
    patch_skipped "$PATCH_NAME"
  else
    sed -i '/^export const STATE_DIR = resolveStateDir/i\/** Lazy accessor — evaluated on first read so env vars set after import are respected. */\nexport function getStateDir(): string {\n  return resolveStateDir();\n}\n' "$FILE"
    if grep -q 'export function getStateDir' "$FILE" 2>/dev/null; then
      patch_applied "$PATCH_NAME"
    else
      echo "  ⚠️  $PATCH_NAME — failed to apply"
    fi
  fi
fi

PATCH_NAME="paths.ts: lazy accessor getConfigPath()"
if [ -f "$FILE" ]; then
  if grep -q 'export function getConfigPath' "$FILE" 2>/dev/null; then
    patch_skipped "$PATCH_NAME"
  else
    sed -i '/^export const CONFIG_PATH = resolveConfigPathCandidate/i\/** Lazy accessor — evaluated on first read so env vars set after import are respected. */\nexport function getConfigPath(): string {\n  return resolveConfigPathCandidate();\n}\n' "$FILE"
    if grep -q 'export function getConfigPath' "$FILE" 2>/dev/null; then
      patch_applied "$PATCH_NAME"
    else
      echo "  ⚠️  $PATCH_NAME — failed to apply"
    fi
  fi
fi

# ─────────────────────────────────────────────────────────────────────────────
# Patch 3: src/gateway/probe.ts — Structured ECONNREFUSED error.
#
# Change the timeout settle error from a generic "connect failed: ..." to
# return "not running" specifically for ECONNREFUSED, which means no process
# is listening on the port (expected in CI).
# ─────────────────────────────────────────────────────────────────────────────
FILE="$REPO_DIR/src/gateway/probe.ts"
PATCH_NAME="probe.ts: ECONNREFUSED → 'not running'"
if [ -f "$FILE" ]; then
  if grep -q '"not running"' "$FILE" 2>/dev/null; then
    patch_skipped "$PATCH_NAME"
  else
    # Replace the single-line error ternary with the three-way check
    sed -i 's|error: connectError ? `connect failed: ${connectError}` : "timeout",|error: connectError\n            ? connectError.includes("ECONNREFUSED")\n              ? "not running"\n              : `connect failed: ${connectError}`\n            : "timeout",|' "$FILE"
    if grep -q '"not running"' "$FILE" 2>/dev/null; then
      patch_applied "$PATCH_NAME"
    else
      echo "  ⚠️  $PATCH_NAME — failed to apply (upstream may have changed)"
    fi
  fi
else
  echo "  ⚠️  $FILE not found — skipping"
fi

# ─────────────────────────────────────────────────────────────────────────────
# Patch 4: src/agents/agent-paths.ts — Documentation comment.
#
# Add a comment explaining the subprocess model constraint on
# ensureOpenClawAgentEnv().
# ─────────────────────────────────────────────────────────────────────────────
FILE="$REPO_DIR/src/agents/agent-paths.ts"
PATCH_NAME="agent-paths.ts: subprocess model documentation comment"
if [ -f "$FILE" ]; then
  if grep -q 'OPENCLAW_STATE_DIR is set before this code runs' "$FILE" 2>/dev/null; then
    patch_skipped "$PATCH_NAME"
  else
    sed -i '/const dir = resolveOpenClawAgentDir();/a\  // NB: When using the subprocess model (e.g. .GITOPENCLAW orchestrator),\n  // OPENCLAW_STATE_DIR is set before this code runs so the resolved dir is correct.\n  // For in-process usage, ensure OPENCLAW_STATE_DIR is set before calling this.' "$FILE"
    if grep -q 'OPENCLAW_STATE_DIR is set before this code runs' "$FILE" 2>/dev/null; then
      patch_applied "$PATCH_NAME"
    else
      echo "  ⚠️  $PATCH_NAME — failed to apply"
    fi
  fi
else
  echo "  ⚠️  $FILE not found — skipping"
fi

# ─────────────────────────────────────────────────────────────────────────────
# Patch 5: src/commands/status-all.ts — CI-aware display.
#
# Detect CI environment and show friendly messages instead of alarming
# "unreachable" / "systemd not installed" output.
# ─────────────────────────────────────────────────────────────────────────────
FILE="$REPO_DIR/src/commands/status-all.ts"
PATCH_NAME="status-all.ts: CI-aware gateway status"
if [ -f "$FILE" ]; then
  if grep -q 'n/a (CI.*commands run inline)' "$FILE" 2>/dev/null; then
    patch_skipped "$PATCH_NAME"
  else
    # Add isCI constant at the start of statusAllCommand
    sed -i '/await withProgress.*Scanning status --all/a\    const isCI = process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true";' "$FILE"

    # Patch the gatewayStatus ternary: insert CI check before the unreachable branch
    sed -i 's|: gatewayProbe?.error$|: isCI\n      ? "n/a (CI — commands run inline)"\n      : gatewayProbe?.error|' "$FILE"

    if grep -q 'n/a (CI.*commands run inline)' "$FILE" 2>/dev/null; then
      patch_applied "$PATCH_NAME"
    else
      echo "  ⚠️  $PATCH_NAME — failed to apply (upstream may have changed)"
    fi
  fi

  PATCH_NAME="status-all.ts: CI-aware service rows"
  if grep -q 'n/a (CI environment)' "$FILE" 2>/dev/null; then
    patch_skipped "$PATCH_NAME"
  else
    # Add isCI check to the fallback "unknown" values for Gateway and Node service rows.
    sed -i 's|: { Item: "Gateway service", Value: "unknown" }|: { Item: "Gateway service", Value: isCI ? "n/a (CI environment)" : "unknown" }|' "$FILE"
    sed -i 's|: { Item: "Node service", Value: "unknown" }|: { Item: "Node service", Value: isCI ? "n/a (CI environment)" : "unknown" }|' "$FILE"

    if grep -q 'n/a (CI environment)' "$FILE" 2>/dev/null; then
      patch_applied "$PATCH_NAME"
    else
      echo "  ⚠️  $PATCH_NAME — failed to apply (upstream may have changed)"
    fi
  fi
else
  echo "  ⚠️  $FILE not found — skipping"
fi

# ─────────────────────────────────────────────────────────────────────────────
# Patch 6: src/commands/status.command.ts — CI-aware display.
#
# Same CI-awareness as status-all.ts for the non-`--all` status command.
# ─────────────────────────────────────────────────────────────────────────────
FILE="$REPO_DIR/src/commands/status.command.ts"
PATCH_NAME="status.command.ts: CI-aware display"
if [ -f "$FILE" ]; then
  if grep -q 'const isCI.*process\.env\.CI' "$FILE" 2>/dev/null; then
    patch_skipped "$PATCH_NAME"
  else
    # These are the same pattern of CI-detection changes. Since the status.command.ts
    # structure is similar but not identical to status-all.ts, we apply a targeted
    # insertion if the file has the expected patterns.
    if grep -q 'gatewayReachable' "$FILE" 2>/dev/null; then
      # Add isCI detection. Find a good anchor point — look for the scan destructuring
      # or the beginning of the status command function.
      if grep -q 'const.*gatewayReachable\|gatewayProbe?.ok' "$FILE" 2>/dev/null; then
        # Insert isCI after the first occurrence of gatewayReachable assignment or near top
        sed -i '0,/const gatewayReachable/s/const gatewayReachable/const isCI = process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true";\n  const gatewayReachable/' "$FILE"
      fi

      if grep -q 'const isCI' "$FILE" 2>/dev/null; then
        patch_applied "$PATCH_NAME"
      else
        echo "  ⚠️  $PATCH_NAME — could not insert isCI detection"
      fi
    else
      echo "  ⚠️  $PATCH_NAME — expected patterns not found"
    fi
  fi
else
  echo "  ⚠️  $FILE not found — skipping"
fi

# ─────────────────────────────────────────────────────────────────────────────
# Patch 7: Disable upstream .github/ files in the clone.
#
# Move upstream development workflows, issue templates, and funding config
# to .github/workflows-disabled/ so they don't interfere.
# (In the clone, these don't affect our repo, but we disable them for
# consistency with the documented modifications.)
# ─────────────────────────────────────────────────────────────────────────────
CLONE_GITHUB="$REPO_DIR/.github"
PATCH_NAME=".github/: disable upstream dev files"
if [ -d "$CLONE_GITHUB" ]; then
  moved_count=0
  mkdir -p "$CLONE_GITHUB/workflows-disabled"

  DISABLE_FILES=(
    ".github/FUNDING.yml"
    ".github/pull_request_template.md"
    ".github/ISSUE_TEMPLATE/bug_report.yml"
    ".github/ISSUE_TEMPLATE/feature_request.yml"
    ".github/ISSUE_TEMPLATE/regression_bug_report.yml"
    ".github/ISSUE_TEMPLATE/config.yml"
  )

  # Also disable upstream workflows that conflict with GITOPENCLAW
  if [ -d "$CLONE_GITHUB/workflows" ]; then
    for wf in "$CLONE_GITHUB/workflows/"*.yml "$CLONE_GITHUB/workflows/"*.yaml; do
      [ -f "$wf" ] || continue
      BASENAME=$(basename "$wf")
      # Skip GITOPENCLAW workflows
      case "$BASENAME" in GITOPENCLAW*) continue ;; esac
      if [ -f "$wf" ]; then
        mv "$wf" "$CLONE_GITHUB/workflows-disabled/$BASENAME"
        ((moved_count++)) || true
      fi
    done
  fi

  for file_rel in "${DISABLE_FILES[@]}"; do
    full_path="$REPO_DIR/$file_rel"
    if [ -f "$full_path" ]; then
      BASENAME=$(basename "$full_path")
      mv "$full_path" "$CLONE_GITHUB/workflows-disabled/$BASENAME"
      ((moved_count++)) || true
    fi
  done

  if [ "$moved_count" -gt 0 ]; then
    patch_applied "$PATCH_NAME ($moved_count files moved)"
  else
    patch_skipped "$PATCH_NAME"
  fi
else
  echo "  ⚠️  $CLONE_GITHUB not found — skipping"
fi

# ── Summary ──────────────────────────────────────────────────────────────────
echo ""
echo "Patches applied: $applied, skipped (already present): $skipped"
echo "✅ GITOPENCLAW patches complete."
