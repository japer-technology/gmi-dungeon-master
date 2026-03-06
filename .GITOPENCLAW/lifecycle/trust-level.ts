/**
 * trust-level.ts — Trust-level resolution for GitOpenClaw.
 *
 * Determines the trust tier for a given GitHub actor based on the
 * repository's `trustPolicy` configuration.  The resolved level controls
 * what the agent is allowed to do during the workflow run:
 *
 *   • `trusted`       — full capabilities (all tools available)
 *   • `semi-trusted`  — read-only tools only (system-prompt restriction)
 *   • `untrusted`     — blocked or read-only response (no agent invocation)
 *
 * This module is intentionally free of side effects so it can be unit-tested
 * in isolation (see `.GITOPENCLAW/tests/trust-level.test.js`).
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export type TrustLevel = "trusted" | "semi-trusted" | "untrusted";

export interface TrustPolicy {
  trustedUsers?: string[];
  semiTrustedRoles?: string[];
  untrustedBehavior?: "read-only-response" | "block";
}

// ─── Resolution ───────────────────────────────────────────────────────────────

/**
 * Resolve the trust level for a given GitHub actor.
 *
 * @param actor           - The `github.actor` username (e.g. "octocat").
 * @param actorPermission - The actor's repository permission level
 *                          (e.g. "admin", "maintain", "write", "read", "none").
 * @param trustPolicy     - The `trustPolicy` section from settings.json.
 *                          When absent or undefined the actor is treated as
 *                          `trusted` for backwards compatibility.
 * @returns The resolved trust level.
 */
export function resolveTrustLevel(
  actor: string,
  actorPermission: string,
  trustPolicy?: TrustPolicy,
): TrustLevel {
  // No policy configured → backwards-compatible: everyone is trusted.
  if (!trustPolicy) return "trusted";

  // 1. Explicit trusted users list takes highest priority.
  if (trustPolicy.trustedUsers?.includes(actor)) return "trusted";

  // 2. Check if the actor's permission matches a semi-trusted role.
  if (trustPolicy.semiTrustedRoles?.includes(actorPermission)) return "semi-trusted";

  // 3. Everything else is untrusted.
  return "untrusted";
}
