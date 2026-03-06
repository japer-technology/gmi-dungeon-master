/**
 * GITOPENCLAW-ENABLED.ts — Fail-closed guard for the GITOPENCLAW-ENABLED.md sentinel file.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PURPOSE
 * ─────────────────────────────────────────────────────────────────────────────
 * This script is the very first step executed in every GITOPENCLAW-* workflow.
 * Its sole job is to verify that the operator has deliberately opted-in to
 * GitOpenClaw automation by checking for the presence of the sentinel file
 * `.GITOPENCLAW/GITOPENCLAW-ENABLED.md`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SECURITY MODEL — "FAIL-CLOSED"
 * ─────────────────────────────────────────────────────────────────────────────
 * If the sentinel file is ABSENT the script:
 *   1. Prints a human-readable explanation to stderr.
 *   2. Exits with a non-zero status code (1).
 *   3. Causes GitHub Actions to mark the job as failed, which prevents every
 *      downstream step (dependency install, agent run, git push, etc.) from
 *      executing.
 *
 * This "fail-closed" design means GitOpenClaw is ALWAYS disabled by default on
 * a freshly cloned repository until the operator explicitly creates (or
 * restores) the sentinel file, preventing accidental automation.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * USAGE
 * ─────────────────────────────────────────────────────────────────────────────
 * The workflow invokes this file as the "Guard" step:
 *
 *   - name: Guard
 *     run: bun .GITOPENCLAW/lifecycle/GITOPENCLAW-ENABLED.ts
 *
 * To ENABLE  GitOpenClaw: ensure `.GITOPENCLAW/GITOPENCLAW-ENABLED.md` exists in the repo.
 * To DISABLE GitOpenClaw: delete `.GITOPENCLAW/GITOPENCLAW-ENABLED.md` and commit the removal.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DEPENDENCIES
 * ─────────────────────────────────────────────────────────────────────────────
 * - Node.js built-in `fs` module  (existsSync)
 * - Node.js built-in `path` module (resolve)
 * - Bun runtime (for `import.meta.dir` support)
 *
 * No external packages are required; this file intentionally has zero
 * third-party dependencies so it can run before `bun install`.
 */

import { existsSync } from "fs";
import { resolve } from "path";

// ─── Resolve the absolute path to the sentinel file ───────────────────────────
// `import.meta.dir` resolves to the directory containing THIS script, i.e.
// `.GITOPENCLAW/lifecycle/`.  We step one level up (`..`) to reach `.GITOPENCLAW/`,
// then join with the sentinel filename.
const enabledFile = resolve(import.meta.dir, "..", "GITOPENCLAW-ENABLED.md");

// ─── Guard: fail-closed if the sentinel is missing ────────────────────────────
// Print a clear, actionable error message before exiting so that operators
// immediately understand why the workflow stopped and what to do about it.
if (!existsSync(enabledFile)) {
  console.error(
    "GitOpenClaw disabled — sentinel file `.GITOPENCLAW/GITOPENCLAW-ENABLED.md` is missing.\n" +
    "To enable GitOpenClaw, restore that file and push it to the repository."
  );
  process.exit(1);
}

// ─── Sentinel found: log confirmation and let the workflow continue ───────────
console.log("GitOpenClaw enabled — GITOPENCLAW-ENABLED.md found.");
