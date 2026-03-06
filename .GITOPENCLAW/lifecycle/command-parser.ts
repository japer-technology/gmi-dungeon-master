/**
 * command-parser.ts — Slash command parser for GitOpenClaw.
 *
 * Parses issue comment text to detect slash commands (e.g., `/status`,
 * `/config set provider openai`) and returns a structured result.
 * When no slash command is detected, the comment is treated as natural
 * language input for the agent (the existing default behavior).
 *
 * This module is intentionally free of side effects so it can be
 * unit-tested in isolation.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ParsedCommand {
  /** The resolved command name (e.g. "config", "status", "agent"). */
  command: string;
  /** Parsed arguments after the command name. */
  args: string[];
  /** The original full text of the comment. */
  rawText: string;
}

export interface CommandDescriptor {
  /** Short description of what the command does. */
  description: string;
  /**
   * Whether the top-level command is generally mutation-oriented.
   * Subcommand-level checks still apply (for example: `config get` is read-only,
   * while `config set` mutates state).
   */
  mutation: boolean;
}

// ─── Supported Commands ───────────────────────────────────────────────────────
// Each entry maps a slash command name to its description and whether it is a
// mutation command.  The list is derived from the openclaw CLI command registry
// (core commands in `src/cli/program/command-registry.ts` and sub-CLIs in
// `src/cli/program/register.subclis.ts`).

export const SUPPORTED_COMMANDS: Record<string, CommandDescriptor> = {
  // ── Agent ───────────────────────────────────────────────────────────────────
  agent: { description: "Run one agent turn via Gateway", mutation: false },
  agents: { description: "Manage isolated agents", mutation: false },

  // ── Configuration ───────────────────────────────────────────────────────────
  setup: { description: "Initialize local config and agent workspace", mutation: true },
  onboard: { description: "Interactive onboarding wizard", mutation: true },
  configure: {
    description: "Interactive setup wizard for credentials/channels/gateway",
    mutation: true,
  },
  config: {
    description: "Non-interactive config helpers (e.g. `/config set provider openai`)",
    mutation: true,
  },
  reset: { description: "Reset local config/state", mutation: true },
  uninstall: { description: "Uninstall gateway service and local data", mutation: true },

  // ── Health & Status ─────────────────────────────────────────────────────────
  doctor: { description: "Run health checks and quick fixes", mutation: false },
  status: { description: "Show channel health", mutation: false },
  health: { description: "Fetch health from running gateway", mutation: false },

  // ── Channels ────────────────────────────────────────────────────────────────
  channels: { description: "Manage connected chat channels", mutation: false },

  // ── Sessions ────────────────────────────────────────────────────────────────
  sessions: { description: "List stored conversation sessions", mutation: false },

  // ── Memory ──────────────────────────────────────────────────────────────────
  memory: { description: "Search and reindex memory files", mutation: false },

  // ── Models ──────────────────────────────────────────────────────────────────
  models: { description: "Discover, scan, and configure models", mutation: false },

  // ── Messages ────────────────────────────────────────────────────────────────
  message: { description: "Send, read, and manage messages", mutation: true },

  // ── Cron ────────────────────────────────────────────────────────────────────
  cron: { description: "Manage cron jobs via Gateway scheduler", mutation: true },

  // ── Plugins ─────────────────────────────────────────────────────────────────
  plugins: { description: "Manage OpenClaw plugins and extensions", mutation: true },

  // ── Skills ──────────────────────────────────────────────────────────────────
  skills: { description: "List and inspect available skills", mutation: false },

  // ── Update ──────────────────────────────────────────────────────────────────
  update: { description: "Update OpenClaw and inspect update channel status", mutation: true },

  // ── Dashboard ───────────────────────────────────────────────────────────────
  dashboard: { description: "Open the Control UI", mutation: false },

  // ── Browser ─────────────────────────────────────────────────────────────────
  browser: { description: "Manage OpenClaw's dedicated browser", mutation: false },

  // ── Sub-CLIs (read-only / informational) ────────────────────────────────────
  acp: { description: "Agent Control Protocol tools", mutation: false },
  logs: { description: "Tail gateway file logs via RPC", mutation: false },
  system: { description: "System events, heartbeat, and presence", mutation: false },
  approvals: { description: "Manage exec approvals", mutation: false },
  nodes: { description: "Manage gateway-owned node pairing", mutation: false },
  devices: { description: "Device pairing and token management", mutation: false },
  node: { description: "Run and manage the headless node host service", mutation: true },
  dns: { description: "DNS helpers for wide-area discovery", mutation: false },
  docs: { description: "Search the live OpenClaw docs", mutation: false },
  directory: { description: "Lookup contact and group IDs", mutation: false },
  security: { description: "Security tools and local config audits", mutation: false },
  secrets: { description: "Secrets runtime reload controls", mutation: false },
  completion: { description: "Generate shell completion script", mutation: false },
  daemon: { description: "Gateway service (legacy alias)", mutation: true },
  tui: { description: "Open a terminal UI connected to the Gateway", mutation: false },
  qr: { description: "Generate iOS pairing QR/setup code", mutation: false },
  clawbot: { description: "Legacy clawbot command aliases", mutation: false },

  // ── Sub-CLIs (mutation) ─────────────────────────────────────────────────────
  gateway: { description: "Run, inspect, and query WebSocket Gateway", mutation: true },
  sandbox: { description: "Manage sandbox containers", mutation: true },
  hooks: { description: "Manage internal agent hooks", mutation: true },
  webhooks: { description: "Webhook helpers and integrations", mutation: true },
  pairing: { description: "Secure DM pairing", mutation: true },

  // ── Help ─────────────────────────────────────────────────────────────────────
  help: { description: "Show available commands and usage", mutation: false },
};

// ─── Mutation commands set (for trust-level gating) ───────────────────────────

export const MUTATION_COMMANDS = new Set(
  Object.entries(SUPPORTED_COMMANDS)
    .filter(([, desc]) => desc.mutation)
    .map(([name]) => name),
);

const SUBCOMMAND_MUTATION_RULES: Record<string, Set<string>> = {
  // Config reads are allowed for semi-trusted users, writes are not.
  config: new Set(["set", "unset", "reset", "import"]),
  // Plugin installs/removals mutate local/runtime state.
  plugins: new Set(["install", "remove", "uninstall", "update", "enable", "disable"]),
  // Cron create/update/delete mutate scheduler state.
  cron: new Set(["create", "update", "delete", "remove", "enable", "disable", "run"]),
  // Messaging sends mutate external state; reads are fine.
  message: new Set(["send", "reply", "react", "delete"]),
};

export function isMutationInvocation(command: string, args: string[]): boolean {
  if (!MUTATION_COMMANDS.has(command)) {
    return false;
  }

  const rule = SUBCOMMAND_MUTATION_RULES[command];
  if (!rule) {
    return true;
  }

  const action = (args[0] ?? "").toLowerCase();
  if (!action) {
    return true;
  }
  return rule.has(action);
}

// ─── Parser ───────────────────────────────────────────────────────────────────

/**
 * Parse an issue comment to detect slash commands.
 *
 * @param text - The raw text of the issue comment.
 * @returns A structured `ParsedCommand` object.
 *
 * If the first line starts with `/`, the text after the `/` is split into
 * a command name and arguments.  Otherwise the entire text is treated as
 * natural language input for the agent (`command: "agent"`).
 */
export function parseCommand(text: string): ParsedCommand {
  const rawText = text;
  const trimmed = text.trim();
  const firstLine = trimmed.split("\n")[0].trim();

  if (firstLine.startsWith("/")) {
    const withoutSlash = firstLine.slice(1);
    const parts = withoutSlash.split(/\s+/).filter(Boolean);
    const command = (parts[0] ?? "").toLowerCase();
    const args = parts.slice(1);

    if (command && command in SUPPORTED_COMMANDS) {
      return { command, args, rawText };
    }

    // Unknown slash command — return it as-is so the caller can handle it.
    return { command: command || "unknown", args, rawText };
  }

  // No slash prefix → natural language mode (existing behavior).
  return { command: "agent", args: [], rawText };
}
