/**
 * GITOPENCLAW-PREFLIGHT.ts — Pre-flight validation for the GitOpenClaw agent.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PURPOSE
 * ─────────────────────────────────────────────────────────────────────────────
 * This script runs between the Guard and Preinstall workflow steps.  It
 * validates the repository's GitOpenClaw configuration and structural
 * integrity before any dependencies are installed or the agent is invoked.
 *
 * Catching configuration errors here prevents silent failures from
 * compounding in downstream steps.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LIFECYCLE POSITION
 * ─────────────────────────────────────────────────────────────────────────────
 * Workflow step order:
 *   1. Guard       (GITOPENCLAW-ENABLED.ts)   — verify opt-in sentinel exists
 *   2. Preflight   (GITOPENCLAW-PREFLIGHT.ts) ← YOU ARE HERE
 *   3. Preinstall  (GITOPENCLAW-INDICATOR.ts) — add 👀 reaction indicator
 *   4. Install     (bun install)               — install npm/bun dependencies
 *   5. Run         (GITOPENCLAW-AGENT.ts)     — execute the AI agent
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CHECKS PERFORMED
 * ─────────────────────────────────────────────────────────────────────────────
 *   1. All required files exist (sentinel, config, lifecycle scripts, state).
 *   2. config/settings.json conforms to config/settings.schema.json.
 *   3. state/.gitignore contains entries that prevent accidental secret commits.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DEPENDENCIES
 * ─────────────────────────────────────────────────────────────────────────────
 * - Node.js built-in `fs` module  (existsSync, readFileSync)
 * - Node.js built-in `path` module (resolve)
 * - Bun runtime (for `import.meta.dir` support)
 *
 * No external packages are required; validation is performed with a
 * lightweight inline validator to keep this step dependency-free (it runs
 * before `bun install`).
 */

import { existsSync, readFileSync } from "fs";
import { resolve } from "path";

// ─── Paths ────────────────────────────────────────────────────────────────────
const gitopenclawDir = resolve(import.meta.dir, "..");
const configDir = resolve(gitopenclawDir, "config");
const settingsPath = resolve(configDir, "settings.json");
const schemaPath = resolve(configDir, "settings.schema.json");
const stateGitignorePath = resolve(gitopenclawDir, "state", ".gitignore");

// ─── Required files ───────────────────────────────────────────────────────────
// Every file that must be present for the agent to function correctly.
const requiredFiles: { path: string; label: string }[] = [
  { path: resolve(gitopenclawDir, "GITOPENCLAW-ENABLED.md"), label: "GITOPENCLAW-ENABLED.md" },
  { path: settingsPath, label: "config/settings.json" },
  { path: resolve(gitopenclawDir, "lifecycle", "GITOPENCLAW-AGENT.ts"), label: "lifecycle/GITOPENCLAW-AGENT.ts" },
  { path: resolve(gitopenclawDir, "lifecycle", "GITOPENCLAW-ENABLED.ts"), label: "lifecycle/GITOPENCLAW-ENABLED.ts" },
  { path: resolve(gitopenclawDir, "lifecycle", "GITOPENCLAW-INDICATOR.ts"), label: "lifecycle/GITOPENCLAW-INDICATOR.ts" },
  { path: stateGitignorePath, label: "state/.gitignore" },
];

// ─── Secret-prevention entries that state/.gitignore must contain ─────────────
const requiredGitignoreEntries = ["credentials/", "*.db"];

// ─── Collect errors ───────────────────────────────────────────────────────────
const errors: string[] = [];

// ── 1. Check required files ─────────────────────────────────────────────────
for (const { path: filePath, label } of requiredFiles) {
  if (!existsSync(filePath)) {
    errors.push(`Missing required file: ${label}`);
  }
}

// ── 2. Validate settings.json against the schema ────────────────────────────
if (existsSync(settingsPath) && existsSync(schemaPath)) {
  try {
    const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    const schema = JSON.parse(readFileSync(schemaPath, "utf-8"));

    // Validate required fields
    if (schema.required) {
      for (const field of schema.required) {
        if (!(field in settings)) {
          errors.push(`settings.json: missing required field "${field}"`);
        }
      }
    }

    // Validate each property against schema constraints
    const props = schema.properties ?? {};
    for (const [key, def] of Object.entries(props) as [string, any][]) {
      if (!(key in settings)) continue;
      const value = settings[key];

      // Type check
      if (def.type === "string" && typeof value !== "string") {
        errors.push(`settings.json: "${key}" must be a string, got ${typeof value}`);
        continue;
      }

      // Enum check
      if (def.enum && !def.enum.includes(value)) {
        errors.push(
          `settings.json: "${key}" must be one of [${def.enum.join(", ")}], got "${value}"`
        );
      }

      // minLength check
      if (typeof def.minLength === "number" && typeof value === "string" && value.length < def.minLength) {
        errors.push(`settings.json: "${key}" must be at least ${def.minLength} character(s) long`);
      }
    }

    // ── Validate trustPolicy (Task 0.2) ─────────────────────────────────────
    if (settings.trustPolicy != null) {
      const tp = settings.trustPolicy;
      if (tp === null || typeof tp !== "object" || Array.isArray(tp)) {
        errors.push('settings.json: "trustPolicy" must be an object');
      } else {
        if (tp.trustedUsers != null) {
          if (!Array.isArray(tp.trustedUsers)) {
            errors.push('settings.json: "trustPolicy.trustedUsers" must be an array of strings');
          } else if (tp.trustedUsers.some((u: unknown) => typeof u !== "string")) {
            errors.push('settings.json: "trustPolicy.trustedUsers" entries must be strings');
          }
        }
        if (tp.semiTrustedRoles != null) {
          const validRoles = ["admin", "maintain", "write"];
          if (!Array.isArray(tp.semiTrustedRoles)) {
            errors.push('settings.json: "trustPolicy.semiTrustedRoles" must be an array');
          } else {
            for (const role of tp.semiTrustedRoles) {
              if (!validRoles.includes(role)) {
                errors.push(
                  `settings.json: "trustPolicy.semiTrustedRoles" contains invalid value "${role}" (must be one of [${validRoles.join(", ")}])`
                );
              }
            }
          }
        }
        if (tp.untrustedBehavior != null) {
          const validBehaviors = ["read-only-response", "block"];
          if (!validBehaviors.includes(tp.untrustedBehavior)) {
            errors.push(
              `settings.json: "trustPolicy.untrustedBehavior" must be one of [${validBehaviors.join(", ")}], got "${tp.untrustedBehavior}"`
            );
          }
        }
      }
    }

    // ── Validate limits (Task 0.3) ───────────────────────────────────────────
    if (settings.limits != null) {
      const lim = settings.limits;
      if (lim === null || typeof lim !== "object" || Array.isArray(lim)) {
        errors.push('settings.json: "limits" must be an object');
      } else {
        if (lim.maxTokensPerRun != null) {
          if (typeof lim.maxTokensPerRun !== "number" || !Number.isInteger(lim.maxTokensPerRun)) {
            errors.push('settings.json: "limits.maxTokensPerRun" must be an integer');
          } else if (lim.maxTokensPerRun < 1000) {
            errors.push('settings.json: "limits.maxTokensPerRun" must be at least 1000');
          }
        }
        if (lim.maxToolCallsPerRun != null) {
          if (typeof lim.maxToolCallsPerRun !== "number" || !Number.isInteger(lim.maxToolCallsPerRun)) {
            errors.push('settings.json: "limits.maxToolCallsPerRun" must be an integer');
          } else if (lim.maxToolCallsPerRun < 1) {
            errors.push('settings.json: "limits.maxToolCallsPerRun" must be at least 1');
          }
        }
        if (lim.workflowTimeoutMinutes != null) {
          if (typeof lim.workflowTimeoutMinutes !== "number" || !Number.isInteger(lim.workflowTimeoutMinutes)) {
            errors.push('settings.json: "limits.workflowTimeoutMinutes" must be an integer');
          } else if (lim.workflowTimeoutMinutes < 1) {
            errors.push('settings.json: "limits.workflowTimeoutMinutes" must be at least 1');
          } else if (lim.workflowTimeoutMinutes > 360) {
            errors.push('settings.json: "limits.workflowTimeoutMinutes" must be at most 360');
          }
        }
      }
    }
  } catch (e) {
    errors.push(`settings.json: failed to parse — ${(e as Error).message}`);
  }
} else if (!existsSync(schemaPath)) {
  errors.push("Missing schema file: config/settings.schema.json");
}

// ── 3. Verify state/.gitignore contains secret-prevention entries ───────────
if (existsSync(stateGitignorePath)) {
  const gitignoreContent = readFileSync(stateGitignorePath, "utf-8");
  for (const entry of requiredGitignoreEntries) {
    if (!gitignoreContent.includes(entry)) {
      errors.push(`state/.gitignore: missing required entry "${entry}" to prevent accidental secret commits`);
    }
  }
}

// ── Report and exit ─────────────────────────────────────────────────────────
if (errors.length > 0) {
  console.error("Preflight failed with the following errors:\n");
  for (const err of errors) {
    console.error(`  ✗ ${err}`);
  }
  console.error(`\n${errors.length} error(s) found. Fix the above issues and try again.`);
  process.exit(1);
}

console.log("Preflight passed — all checks OK.");
