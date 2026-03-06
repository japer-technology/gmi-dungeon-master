/**
 * GITOPENCLAW-AGENT.ts — Core agent orchestrator for GitOpenClaw.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PURPOSE
 * ─────────────────────────────────────────────────────────────────────────────
 * This is the main entry point for the GitOpenClaw AI agent.  It receives
 * a GitHub issue (or issue comment) event, runs the OpenClaw agent against the
 * user's prompt, and posts the result back as an issue comment.  It also
 * manages all session state so that multi-turn conversations across multiple
 * workflow runs are seamlessly resumed.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LIFECYCLE POSITION
 * ─────────────────────────────────────────────────────────────────────────────
 * Workflow step order:
 *   1. Guard       (GITOPENCLAW-ENABLED.ts)   — verify opt-in sentinel exists
 *   2. Preinstall  (GITOPENCLAW-INDICATOR.ts) — add 👀 reaction indicator
 *   3. Install     (bun install)               — install npm/bun dependencies
 *   4. Run         (GITOPENCLAW-AGENT.ts)     ← YOU ARE HERE
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * AGENT EXECUTION PIPELINE
 * ─────────────────────────────────────────────────────────────────────────────
 *   1. Fetch issue title/body from GitHub via the `gh` CLI.
 *   2. Resolve (or create) a conversation session for this issue number.
 *      - New issue  → create a fresh session; record the mapping in state/.
 *      - Follow-up  → load the existing session file for conversation context.
 *   3. Build a prompt string from the event payload.
 *   4. Run the `openclaw agent` CLI command with the prompt (using --local for
 *      embedded execution, --json for structured output).
 *   5. Extract the assistant's final text reply from the JSON output.
 *   6. Persist the issue → session mapping so the next run can resume.
 *   7. Stage, commit, and push all changes (session log, mapping, repo edits)
 *      back to the default branch with an automatic retry-on-conflict loop.
 *   8. Post the extracted reply as a new comment on the originating issue.
 *   9. [finally] Remove the 👀 reaction that `GITOPENCLAW-INDICATOR.ts` added,
 *      guaranteeing cleanup even if the agent threw an unhandled error.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SESSION CONTINUITY
 * ─────────────────────────────────────────────────────────────────────────────
 * GitOpenClaw maintains per-issue session state in:
 *   .GITOPENCLAW/state/issues/<number>.json   — maps issue # → session ID + path
 *   .GITOPENCLAW/state/sessions/<id>.jsonl    — the session transcript (git-tracked)
 *
 * The OpenClaw runtime writes session transcripts to its internal directory
 * (`state/agents/main/sessions/`), which is ephemeral on CI runners (gitignored).
 * To preserve state across workflow runs, the orchestrator:
 *   1. BEFORE the run: copies any archived transcript from `state/sessions/`
 *      into the runtime directory so OpenClaw can locate it by session-id.
 *   2. AFTER the run: copies the updated transcript back to `state/sessions/`
 *      where it is committed to git and survives runner teardown.
 *
 * This copy-archive-restore cycle ensures multi-turn conversation continuity
 * even though the CI runner is ephemeral.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PUSH CONFLICT RESOLUTION
 * ─────────────────────────────────────────────────────────────────────────────
 * Multiple agents may race to push to the same branch.  To handle this gracefully
 * the script retries a failed `git push` up to 10 times with increasing backoff
 * delays, pulling with `--rebase -X theirs` between attempts.  If a rebase
 * produces a non-auto-resolvable conflict, the rebase is aborted and the error
 * is surfaced immediately.  After exhausting all attempts the script throws with
 * the attempt count and total retry window.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * GITHUB COMMENT SIZE LIMIT
 * ─────────────────────────────────────────────────────────────────────────────
 * GitHub enforces a ~65 535 character limit on issue comments.  The agent reply
 * is capped at 60 000 characters to leave a comfortable safety margin.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DEPENDENCIES
 * ─────────────────────────────────────────────────────────────────────────────
 * - Node.js built-in `fs` module  (existsSync, readFileSync, writeFileSync, mkdirSync)
 * - Node.js built-in `path` module (resolve)
 * - GitHub CLI (`gh`)             — must be authenticated via GITHUB_TOKEN
 * - `openclaw` binary             — built from .GITOPENCLAW/repo/openclaw/openclaw
 * - System tools: `git`, `bash`
 * - Bun runtime                   — for Bun.spawn and top-level await
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  copyFileSync,
  unlinkSync,
  appendFileSync,
} from "fs";
import { resolve } from "path";
import { parseCommand, SUPPORTED_COMMANDS, isMutationInvocation } from "./command-parser.ts";
import { resolveTrustLevel } from "./trust-level.ts";
import type { TrustPolicy } from "./trust-level.ts";

// ─── Paths and event context ───────────────────────────────────────────────────
// `import.meta.dir` resolves to `.GITOPENCLAW/lifecycle/`; stepping up one level
// gives us the `.GITOPENCLAW/` directory which contains `state/` and `repo/`.
const gitopenclawDir = resolve(import.meta.dir, "..");
const repoRoot = resolve(gitopenclawDir, "..");
const stateDir = resolve(gitopenclawDir, "state");

// OpenClaw source is cloned into .GITOPENCLAW/repo/openclaw/openclaw and built
// locally; the entry point is the `openclaw.mjs` file in that clone.
const openclawRepoDir = resolve(gitopenclawDir, "repo", "openclaw", "openclaw");
const issuesDir = resolve(stateDir, "issues");
const sessionsDir = resolve(stateDir, "sessions");
const usageLogPath = resolve(stateDir, "usage.log");
const settingsPath = resolve(gitopenclawDir, "config", "settings.json");

// The sessions directory as a relative path from repo root.
const sessionsDirRelative = ".GITOPENCLAW/state/sessions";

// OpenClaw writes session transcripts to its internal agents directory, which
// is ephemeral on CI runners (gitignored).  We need to copy transcripts
// between the git-tracked `state/sessions/` and the runtime directory.
const agentSessionsDir = resolve(stateDir, "agents", "main", "sessions");

// GitHub enforces a ~65 535 character limit on issue comments; cap at 60 000
// characters to leave a comfortable safety margin and avoid API rejections.
const MAX_COMMENT_LENGTH = 60000;

// Maximum time (in ms) to wait for the agent process to produce output.
// If the agent does not close stdout within this window, both the agent and
// the `tee` helper are forcefully killed.  5 minutes is generous enough to
// cover large prompts while still surfacing hangs quickly.
const AGENT_TIMEOUT_MS = 5 * 60 * 1000;

// After the agent's stdout closes (output fully captured), we give the
// process a short grace period to exit on its own before killing it.
// This prevents the script from hanging when the agent keeps running after
// writing its response (the exact symptom reported in the issue).
const AGENT_EXIT_GRACE_MS = 10_000;

// Parse the full GitHub Actions event payload (contains issue/comment details).
const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH!, "utf-8"));

// "issues" for new issues, "issue_comment" for replies on existing issues.
const eventName = process.env.GITHUB_EVENT_NAME!;

// "owner/repo" format — used when calling the GitHub REST API via `gh api`.
const repo = process.env.GITHUB_REPOSITORY!;

// Fall back to "main" if the repository's default branch is not set in the event.
const defaultBranch = event.repository?.default_branch ?? "main";

// The issue number is present on both the `issues` and `issue_comment` payloads.
const issueNumber: number = event.issue.number;

// Read the committed config defaults and pass them explicitly to the runtime.
// This prevents provider/model drift from host-level config.
const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
const configuredProvider: string = settings.defaultProvider;
const configuredModel: string = settings.defaultModel;
const configuredThinkingLevel: string = settings.defaultThinkingLevel ?? "high";
const configuredTrustPolicy: TrustPolicy | undefined = settings.trustPolicy;
const configuredLimits:
  | { maxTokensPerRun?: number; maxToolCallsPerRun?: number; workflowTimeoutMinutes?: number }
  | undefined = settings.limits;

if (!configuredProvider || !configuredModel) {
  throw new Error(`Invalid settings at ${settingsPath}: expected defaultProvider and defaultModel`);
}

// ─── Trust-level resolution ───────────────────────────────────────────────────
// Resolve the trust tier for the current actor *before* invoking the agent.
// The actor and their permission level come from the workflow environment:
//   GITHUB_ACTOR   — set by GitHub Actions (the user who triggered the workflow)
//   ACTOR_PERMISSION — set by the Authorize step (admin/maintain/write/read/none)
const actor = process.env.GITHUB_ACTOR ?? "";
const actorPermission = process.env.ACTOR_PERMISSION ?? "none";

if (!actor) {
  throw new Error("GITHUB_ACTOR is not set — cannot resolve trust level outside GitHub Actions");
}

const trustLevel = resolveTrustLevel(actor, actorPermission, configuredTrustPolicy);
console.log(`Trust resolution: actor=${actor}, permission=${actorPermission}, level=${trustLevel}`);

// Path for the tool-policy override file (written for semi-trusted actors, cleaned up in finally).
const toolPolicyOverridePath = resolve(stateDir, "tool-policy-override.json");

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Spawn an arbitrary subprocess, capture its stdout, and return both the
 * trimmed output and the process exit code.
 *
 * @param cmd  - Command and arguments array (e.g. ["git", "push", "origin", "main"]).
 * @param opts - Optional options; `stdin` can be piped from another process.
 * @returns    - `{ exitCode, stdout }` after the process has exited.
 */
async function run(
  cmd: string[],
  opts?: { stdin?: Bun.SpawnOptions.OptionsObject["stdin"] },
): Promise<{ exitCode: number; stdout: string }> {
  const proc = Bun.spawn(cmd, {
    stdout: "pipe",
    stderr: "inherit", // surface errors directly in the Actions log
    stdin: opts?.stdin,
  });
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  return { exitCode, stdout: stdout.trim() };
}

/**
 * Convenience wrapper: run `gh <args>` and return trimmed stdout.
 * Uses the `run` helper above so that `gh` errors appear in the Actions log.
 * Throws on non-zero exit codes to fail fast on API errors.
 */
async function gh(...args: string[]): Promise<string> {
  const { exitCode, stdout } = await run(["gh", ...args]);
  if (exitCode !== 0) {
    throw new Error(`gh ${args[0]} failed with exit code ${exitCode}`);
  }
  return stdout;
}

// ─── Restore reaction state from GITOPENCLAW-INDICATOR.ts ────────────────────
// `GITOPENCLAW-INDICATOR.ts` runs before dependency installation and writes the 👀
// reaction metadata to `/tmp/reaction-state.json`.  We read it here so the
// `finally` block can delete the reaction when the agent finishes (or errors).
// If the file is absent (e.g., indicator step was skipped), we default to null.
const reactionState = existsSync("/tmp/reaction-state.json")
  ? JSON.parse(readFileSync("/tmp/reaction-state.json", "utf-8"))
  : null;

try {
  // ── Fetch issue title and body ───────────────────────────────────────────────
  // We always fetch the issue content from the API rather than relying solely on
  // the event payload, because the payload body can be truncated for very long issues.
  const title = await gh("issue", "view", String(issueNumber), "--json", "title", "--jq", ".title");
  const body = await gh("issue", "view", String(issueNumber), "--json", "body", "--jq", ".body");

  // ── Resolve or create session mapping ───────────────────────────────────────
  // Each issue maps to exactly one session via `state/issues/<n>.json`.
  // If a mapping exists AND the referenced session file is still present, we resume
  // the conversation by passing `--session-id <id>` to OpenClaw.  Otherwise we start fresh.
  mkdirSync(issuesDir, { recursive: true });
  mkdirSync(sessionsDir, { recursive: true });

  let mode = "new";
  let sessionId = "";
  const mappingFile = resolve(issuesDir, `${issueNumber}.json`);

  if (existsSync(mappingFile)) {
    const mapping = JSON.parse(readFileSync(mappingFile, "utf-8"));
    if (mapping.sessionId) {
      // A prior session exists — resume it to preserve conversation context.
      mode = "resume";
      sessionId = mapping.sessionId;
      console.log(`Found existing session: ${sessionId}`);
    } else if (mapping.sessionPath && existsSync(mapping.sessionPath)) {
      // Backward compatibility: check for file-based session paths.
      mode = "resume";
      sessionId = mapping.sessionId || mapping.sessionPath;
      console.log(`Found existing session (path): ${sessionId}`);
    } else {
      // The mapping points to a session that no longer exists (e.g., cleaned up).
      console.log("Mapped session missing, starting fresh");
    }
  } else {
    console.log("No session mapping found, starting fresh");
  }

  // ── Restore session transcript for the OpenClaw runtime ──────────────────
  // On a fresh CI runner the `agents/` directory is ephemeral (gitignored).
  // The git-tracked archive lives in `state/sessions/`.  Before invoking the
  // agent, copy the prior transcript into the runtime directory so OpenClaw
  // can locate it by session-id and resume the conversation.
  mkdirSync(agentSessionsDir, { recursive: true });
  if (mode === "resume" && sessionId) {
    const archivedTranscript = resolve(sessionsDir, `${sessionId}.jsonl`);
    const runtimeTranscript = resolve(agentSessionsDir, `${sessionId}.jsonl`);
    if (existsSync(archivedTranscript) && !existsSync(runtimeTranscript)) {
      copyFileSync(archivedTranscript, runtimeTranscript);
      console.log(`Restored session transcript: ${archivedTranscript} → ${runtimeTranscript}`);
    }
  }

  // ── Configure git identity ───────────────────────────────────────────────────
  // Set the bot identity for all git commits made during this run.
  await run(["git", "config", "user.name", "gitopenclaw[bot]"]);
  await run(["git", "config", "user.email", "gitopenclaw[bot]@users.noreply.github.com"]);

  // ── Build prompt from event context ─────────────────────────────────────────
  // For `issue_comment` events, use the new comment body as the full prompt so
  // that follow-up instructions reach the agent verbatim.
  // For `issues` (opened) events, combine the title and body for full context.
  let prompt: string;
  if (eventName === "issue_comment") {
    prompt = event.comment.body;
  } else {
    prompt = `${title}\n\n${body}`;
  }

  // ── Validate provider API key ────────────────────────────────────────────────
  // This check is inside the try block so that the finally clause always runs
  // (removing the 👀 reaction) and a helpful comment can be posted to the issue.
  // ── Slash command parsing (Task 1.1) ───────────────────────────────────────
  // Parse the original event text before any trust-mode prompt injection so
  // slash commands still work for semi-trusted users in read-only mode.
  const parsedCmd = parseCommand(prompt);
  console.log(`Command parse: command=${parsedCmd.command}, args=[${parsedCmd.args.join(", ")}]`);

  const providerKeyMap: Record<string, string> = {
    anthropic: "ANTHROPIC_API_KEY",
    openai: "OPENAI_API_KEY",
  };
  const requiredKeyName = providerKeyMap[configuredProvider];
  if (requiredKeyName && !process.env[requiredKeyName]) {
    await gh(
      "issue",
      "comment",
      String(issueNumber),
      "--body",
      `## ⚠️ Missing API Key: \`${requiredKeyName}\`\n\n` +
        `The configured provider is \`${configuredProvider}\`, but the \`${requiredKeyName}\` secret is not available to this workflow run.\n\n` +
        `### How to fix\n\n` +
        `**Option A — Repository secret** _(simplest)_\n` +
        `1. Go to **Settings → Secrets and variables → Actions → New repository secret**\n` +
        `2. Name: \`${requiredKeyName}\`, Value: your API key\n\n` +
        `**Option B — Organization secret** _(already have one?)_\n` +
        `Organization secrets are only available to workflows if the secret has been explicitly granted to this repository:\n` +
        `1. Go to your **Organization Settings → Secrets and variables → Actions**\n` +
        `2. Click the \`${requiredKeyName}\` secret → **Repository access**\n` +
        `3. Add **this repository** to the selected repositories list\n\n` +
        `Once the secret is accessible, re-trigger this workflow by posting a new comment on this issue.`,
    );
    throw new Error(
      `${requiredKeyName} is not available to this workflow run. ` +
        `If you have set it as a repository secret, verify the secret name matches exactly. ` +
        `If you have set it as an organization secret, ensure this repository has been granted access ` +
        `(Organization Settings → Secrets and variables → Actions → ${requiredKeyName} → Repository access).`,
    );
  }

  // ── Trust-level gating ──────────────────────────────────────────────────────
  // Enforce trust policy before allowing the agent to run.  Untrusted actors
  // are blocked (or given a read-only explanation) without invoking the agent.
  if (trustLevel === "untrusted") {
    const behavior = configuredTrustPolicy?.untrustedBehavior ?? "read-only-response";
    if (behavior === "block") {
      await gh(
        "issue",
        "comment",
        String(issueNumber),
        "--body",
        `⛔ **Access Denied**\n\nYour account (\`${actor}\`) does not have sufficient permissions to interact with the GitOpenClaw agent on this repository.`,
      );
      throw new Error(
        `Untrusted actor "${actor}" blocked by trust policy (untrustedBehavior=block)`,
      );
    }
    // "read-only-response" — post an explanation and exit gracefully.
    await gh(
      "issue",
      "comment",
      String(issueNumber),
      "--body",
      `ℹ️ **Read-Only Mode**\n\nYour account (\`${actor}\`) has \`${actorPermission}\` permission, which is below the trust threshold configured for this repository. The agent cannot perform actions on your behalf.\n\nIf you believe this is an error, ask a repository administrator to add your username to \`trustedUsers\` in \`.GITOPENCLAW/config/settings.json\`.`,
    );
    // Exit without error — the user was informed.
    process.exit(0);
  }

  // ── Semi-trusted: restrict agent to read-only tools ─────────────────────────
  // For semi-trusted actors, inject a system-prompt-level restriction into the
  // agent's message and write a tool-policy override for audit purposes.
  if (trustLevel === "semi-trusted") {
    const readOnlyDirective =
      "You are operating in read-only mode. Do not use bash, edit, or create tools. " +
      "Only answer questions and provide information based on the repository contents.\n\n";
    prompt = readOnlyDirective + prompt;

    // Write a tool-policy override for audit purposes.  The format mirrors
    // OpenClaw's internal tool-profile structure (profile name + deny list).
    // This file is NOT consumed by the agent subprocess (which uses system-prompt
    // restriction); it exists solely for post-run audit and is deleted in the
    // finally block to avoid stale permissions on subsequent runs.
    writeFileSync(
      toolPolicyOverridePath,
      JSON.stringify({ profile: "minimal", deny: ["bash", "edit", "create"] }, null, 2) + "\n",
    );
    console.log(
      `Semi-trusted actor "${actor}" — wrote tool-policy override and injected read-only directive`,
    );
  }

  // Block mutation commands for semi-trusted actors.
  if (trustLevel === "semi-trusted" && isMutationInvocation(parsedCmd.command, parsedCmd.args)) {
    await gh(
      "issue",
      "comment",
      String(issueNumber),
      "--body",
      `⛔ **Permission Denied**\n\n` +
        `The \`/${parsedCmd.command}\` command modifies configuration or state and requires **trusted** access.\n\n` +
        `Your account (\`${actor}\`) has \`${actorPermission}\` permission (semi-trusted). ` +
        `Ask a repository administrator to add your username to \`trustedUsers\` in \`.GITOPENCLAW/config/settings.json\` to use this command.`,
    );
    process.exit(0);
  }

  // For structured slash commands (anything other than natural language "agent"),
  // build and run the corresponding `openclaw <command> <args>` CLI invocation
  // and post the output directly — no agent session needed.
  //
  // The `/help` command is handled locally (no openclaw binary needed) by
  // generating a formatted list of all supported slash commands from the
  // SUPPORTED_COMMANDS registry.
  if (parsedCmd.command === "help") {
    const lines = ["## 📖 Available Slash Commands\n"];
    const readOnly: string[] = [];
    const mutation: string[] = [];
    for (const [name, desc] of Object.entries(SUPPORTED_COMMANDS)) {
      if (name === "agent") {
        continue;
      } // agent is the natural-language default, not a slash command
      const entry = `| \`/${name}\` | ${desc.description} |`;
      if (desc.mutation) {
        mutation.push(entry);
      } else {
        readOnly.push(entry);
      }
    }
    lines.push("### Read-only commands\n");
    lines.push("| Command | Description |");
    lines.push("|---------|-------------|");
    lines.push(...readOnly);
    lines.push("\n### Mutation commands *(trusted users only)*\n");
    lines.push("| Command | Description |");
    lines.push("|---------|-------------|");
    lines.push(...mutation);
    lines.push(
      "\n---\n" +
        "💡 **Tip:** Try `/status` or `/doctor` as an easy first command.\n\n" +
        "Any comment without a `/` prefix is sent to the AI agent as natural language.",
    );
    await gh("issue", "comment", String(issueNumber), "--body", lines.join("\n"));
    process.exit(0);
  }

  if (parsedCmd.command !== "agent" && parsedCmd.command in SUPPORTED_COMMANDS) {
    const openclawBin = resolve(openclawRepoDir, "openclaw.mjs");
    const slashArgs = [openclawBin, parsedCmd.command, ...parsedCmd.args];
    console.log(`Executing slash command: ${slashArgs.join(" ")}`);

    const slashResult = await run(slashArgs);
    const slashOutput = slashResult.stdout || "(no output)";
    const slashComment =
      `### \`/${parsedCmd.command}${parsedCmd.args.length ? " " + parsedCmd.args.join(" ") : ""}\`\n\n` +
      "```\n" +
      slashOutput.slice(0, MAX_COMMENT_LENGTH - 200) +
      "\n```" +
      (slashResult.exitCode !== 0 ? `\n\n⚠️ Command exited with code ${slashResult.exitCode}` : "");
    await gh("issue", "comment", String(issueNumber), "--body", slashComment);
    process.exit(0);
  }

  // ── Run the OpenClaw agent (Approach A: CLI invocation) ─────────────────────
  // Use `openclaw agent --local` for embedded execution without a Gateway.
  // The --json flag provides structured output for response extraction.
  const openclawBin = resolve(openclawRepoDir, "openclaw.mjs");
  const openclawArgs = [
    openclawBin,
    "agent",
    "--local",
    "--json",
    "--message",
    prompt,
    "--thinking",
    configuredThinkingLevel,
  ];
  // Always pass a session ID so the agent can route the conversation.
  // For resumed sessions use the prior ID; for new issues use a stable
  // identifier derived from the issue number.
  const resolvedSessionId = sessionId || `issue-${issueNumber}`;
  openclawArgs.push("--session-id", resolvedSessionId);

  // ── Apply workflowTimeoutMinutes as --timeout (Task 0.3) ──────────────────
  // The --timeout flag expects seconds; convert from the minutes value in settings.
  if (configuredLimits?.workflowTimeoutMinutes) {
    openclawArgs.push("--timeout", String(configuredLimits.workflowTimeoutMinutes * 60));
  }

  // ── Runtime isolation: source stays raw, runtime goes in .GITOPENCLAW ──────
  // Write a temporary config that points the agent's workspace at the repo root
  // so it can read the raw source code.  All mutable state (sessions, memory,
  // sqlite, caches) is kept inside .GITOPENCLAW/state/ via OPENCLAW_STATE_DIR.
  // Also set timeoutSeconds so the embedded runner has a reasonable default
  // even when the --timeout flag is not passed or is overridden.
  const runtimeConfig = {
    agents: {
      defaults: {
        workspace: repoRoot,
        timeoutSeconds: configuredLimits?.workflowTimeoutMinutes
          ? configuredLimits.workflowTimeoutMinutes * 60
          : 600,
      },
    },
  };
  const runtimeConfigPath = "/tmp/openclaw-runtime.json";
  writeFileSync(runtimeConfigPath, JSON.stringify(runtimeConfig, null, 2));

  const agentEnv = {
    ...process.env,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: runtimeConfigPath,
    OPENCLAW_OAUTH_DIR: resolve(stateDir, "credentials"),
    OPENCLAW_HOME: repoRoot,
  };

  // Pipe agent output through `tee` so we get:
  //   • a live stream to stdout (visible in the Actions log in real time), and
  //   • a persisted copy at `/tmp/agent-raw.json` for post-processing below.
  const agent = Bun.spawn(openclawArgs, {
    stdout: "pipe",
    stderr: "inherit",
    env: agentEnv,
    cwd: repoRoot,
  });
  const tee = Bun.spawn(["tee", "/tmp/agent-raw.json"], { stdin: agent.stdout, stdout: "inherit" });

  // ── Timeout-aware wait for output capture ──────────────────────────────────
  // `tee` exits when the agent's stdout closes (EOF).  If the agent never
  // closes stdout the race timeout fires, and we kill both processes.
  let agentTimedOut = false;
  let agentTimerId: ReturnType<typeof setTimeout> | undefined;

  const teeResult = await Promise.race([
    tee.exited.then(() => "done" as const),
    new Promise<"timeout">((resolve) => {
      agentTimerId = setTimeout(() => resolve("timeout"), AGENT_TIMEOUT_MS);
    }),
  ]);
  clearTimeout(agentTimerId);

  if (teeResult === "timeout") {
    agentTimedOut = true;
    console.error(`Agent timed out after ${AGENT_TIMEOUT_MS / 1000}s — killing processes`);
    agent.kill();
    tee.kill();
    await Promise.allSettled([agent.exited, tee.exited]);
  }

  // ── Grace period: wait for the agent process to exit ───────────────────────
  // After `tee` exits the output has been fully captured to disk.  Give the
  // agent a short window to exit on its own; if it doesn't, kill it so the
  // script can continue with posting the reply and pushing state.
  if (!agentTimedOut) {
    let graceTimerId: ReturnType<typeof setTimeout> | undefined;
    const graceResult = await Promise.race([
      agent.exited.then(() => "exited" as const),
      new Promise<"timeout">((resolve) => {
        graceTimerId = setTimeout(() => resolve("timeout"), AGENT_EXIT_GRACE_MS);
      }),
    ]);
    clearTimeout(graceTimerId);

    if (graceResult === "timeout") {
      console.log("Agent process did not exit after output was captured — killing it");
      agent.kill();
      await agent.exited;
    }
  }

  // Check the exit code.  SIGTERM (143 = 128 + 15) is expected when we
  // killed the process ourselves after the grace period — treat it as success.
  const agentExitCode = await agent.exited;
  if (agentExitCode !== 0 && agentExitCode !== 143) {
    throw new Error(
      `openclaw agent exited with code ${agentExitCode}. Check the workflow logs above for details.`,
    );
  }

  // ── Extract final assistant text ─────────────────────────────────────────────
  // The `openclaw agent --json` command outputs a JSON envelope with a `payloads`
  // array containing the response text. Extract the text from the first payload.
  let agentText = "";
  let parsedAgentOutput: unknown = null;
  try {
    const rawOutput = readFileSync("/tmp/agent-raw.json", "utf-8").trim();
    if (rawOutput) {
      const output = JSON.parse(rawOutput);
      parsedAgentOutput = output;
      if (output.payloads && Array.isArray(output.payloads)) {
        agentText = output.payloads
          .map((p: { text?: string }) => p.text || "")
          .filter((t: string) => t.length > 0)
          .join("\n\n");
      } else if (typeof output.text === "string") {
        agentText = output.text;
      } else if (typeof output === "string") {
        agentText = output;
      }
    }
  } catch {
    // If JSON parsing fails, try reading the raw output as plain text.
    const rawOutput = readFileSync("/tmp/agent-raw.json", "utf-8").trim();
    agentText = rawOutput;
  }

  // ── Semi-trusted audit: block disallowed tool activity ────────────────────
  // The subprocess interface does not expose direct tool-profile flags. For
  // semi-trusted users we enforce read-only mode via prompt directives and then
  // audit reported tool calls to catch policy violations.
  if (trustLevel === "semi-trusted") {
    const deniedTools = new Set(["bash", "edit", "create"]);
    const pendingToolCalls = Array.isArray(
      (parsedAgentOutput as { meta?: { pendingToolCalls?: unknown[] } } | null)?.meta
        ?.pendingToolCalls,
    )
      ? ((parsedAgentOutput as { meta?: { pendingToolCalls?: unknown[] } }).meta
          ?.pendingToolCalls as unknown[])
      : [];
    const violations = pendingToolCalls.filter((call: unknown) => {
      const toolName =
        typeof call === "object" && call !== null && "name" in call
          ? (call as { name?: unknown }).name
          : undefined;
      return typeof toolName === "string" && deniedTools.has(toolName);
    });

    if (violations.length > 0) {
      const toolList = [...new Set(violations.map((call) => (call as { name: string }).name))].join(
        ", ",
      );
      await gh(
        "issue",
        "comment",
        String(issueNumber),
        "--body",
        `⚠️ **Trust Policy Violation Detected**\n\n` +
          `Your request ran in semi-trusted mode, but the agent attempted restricted tool(s): ${toolList}.\n\n` +
          `The workflow blocked this run to enforce read-only constraints. Please contact a maintainer if you need elevated access.`,
      );
      throw new Error(`Semi-trusted run attempted denied tool(s): ${toolList}`);
    }
  }

  // ── Post-run usage logging and budget enforcement (Task 0.3) ──────────────
  // Extract usage metadata from the agent's JSON output and append a one-line
  // JSON entry to state/usage.log.  Also check token/tool-call limits.
  const meta = (parsedAgentOutput as { meta?: Record<string, unknown> } | null)?.meta;
  const agentMeta = meta?.agentMeta as { usage?: Record<string, unknown> } | undefined;
  const usage = agentMeta?.usage as Record<string, number> | undefined;

  const tokensUsed = typeof usage?.total === "number" ? usage.total : 0;
  const tokensInput = typeof usage?.input === "number" ? usage.input : 0;
  const tokensOutput = typeof usage?.output === "number" ? usage.output : 0;
  const cacheRead = typeof usage?.cacheRead === "number" ? usage.cacheRead : 0;
  const cacheWrite = typeof usage?.cacheWrite === "number" ? usage.cacheWrite : 0;
  const durationMs = typeof meta?.durationMs === "number" ? meta.durationMs : 0;
  const stopReason = typeof meta?.stopReason === "string" ? meta.stopReason : "";

  // Count tool calls from the session transcript JSONL for accurate enforcement.
  let toolCallCount = 0;
  const transcriptPath = resolve(agentSessionsDir, `${resolvedSessionId}.jsonl`);
  if (existsSync(transcriptPath)) {
    try {
      const lines = readFileSync(transcriptPath, "utf-8").split("\n").filter(Boolean);
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          // Check multiple JSONL format variants: OpenClaw transcripts may use
          // different schemas depending on version (role-based or type-based).
          if (
            entry.role === "tool" ||
            entry.type === "tool_call" ||
            entry.type === "tool-call" ||
            entry.type === "tool_use"
          ) {
            toolCallCount++;
          }
        } catch {
          // Skip malformed lines
        }
      }
    } catch {
      console.log("Could not parse session transcript for tool-call counting");
    }
  }

  // Append usage entry to state/usage.log
  const usageEntry = JSON.stringify({
    timestamp: new Date().toISOString(),
    issueNumber,
    actor,
    tokensUsed,
    tokensInput,
    tokensOutput,
    cacheRead,
    cacheWrite,
    toolCallCount,
    durationMs,
    stopReason,
  });
  appendFileSync(usageLogPath, usageEntry + "\n");
  console.log(`Usage logged: ${tokensUsed} tokens, ${toolCallCount} tool calls, ${durationMs}ms`);

  // Check token budget violation
  if (configuredLimits?.maxTokensPerRun && tokensUsed > configuredLimits.maxTokensPerRun) {
    console.log(`⚠️ Token budget exceeded: ${tokensUsed} > ${configuredLimits.maxTokensPerRun}`);
    await gh(
      "issue",
      "comment",
      String(issueNumber),
      "--body",
      `⚠️ **Token Budget Exceeded**\n\n` +
        `This agent run consumed **${tokensUsed.toLocaleString("en-US")}** tokens, ` +
        `which exceeds the configured limit of **${configuredLimits.maxTokensPerRun.toLocaleString("en-US")}** tokens.\n\n` +
        `The run completed, but future runs may be restricted. ` +
        `Adjust \`limits.maxTokensPerRun\` in \`.GITOPENCLAW/config/settings.json\` if needed.`,
    );
  }

  // Check tool-call limit violation
  if (configuredLimits?.maxToolCallsPerRun && toolCallCount > configuredLimits.maxToolCallsPerRun) {
    console.log(
      `⚠️ Tool-call limit exceeded: ${toolCallCount} > ${configuredLimits.maxToolCallsPerRun}`,
    );
    await gh(
      "issue",
      "comment",
      String(issueNumber),
      "--body",
      `⚠️ **Tool-Call Limit Exceeded**\n\n` +
        `This agent run made **${toolCallCount}** tool calls, ` +
        `which exceeds the configured limit of **${configuredLimits.maxToolCallsPerRun}**.\n\n` +
        `The run completed, but future runs may be restricted. ` +
        `Adjust \`limits.maxToolCallsPerRun\` in \`.GITOPENCLAW/config/settings.json\` if needed.`,
    );
  }

  // ── Archive session transcript to git-tracked state/sessions/ ──────────────
  // The OpenClaw runtime writes session transcripts to the ephemeral `agents/`
  // directory (gitignored).  Copy the transcript to `state/sessions/` so it
  // survives across workflow runs — this is how .GITOPENCLAW holds state.
  let sessionPath = "";
  const runtimeTranscript = resolve(agentSessionsDir, `${resolvedSessionId}.jsonl`);
  const archivedTranscript = resolve(sessionsDir, `${resolvedSessionId}.jsonl`);
  if (existsSync(runtimeTranscript)) {
    copyFileSync(runtimeTranscript, archivedTranscript);
    sessionPath = `${sessionsDirRelative}/${resolvedSessionId}.jsonl`;
    console.log(`Archived session transcript: ${runtimeTranscript} → ${archivedTranscript}`);
  } else {
    // If the runtime didn't write a transcript (e.g., the agent errored early),
    // check if we already have one from a prior run.
    if (existsSync(archivedTranscript)) {
      sessionPath = `${sessionsDirRelative}/${resolvedSessionId}.jsonl`;
    }
    console.log("No new session transcript found in runtime directory");
  }

  // ── Persist issue → session mapping ─────────────────────────────────────────
  // Write (or overwrite) the mapping file so that the next run for this issue
  // can locate the correct session and resume the conversation.
  writeFileSync(
    mappingFile,
    JSON.stringify(
      {
        issueNumber,
        sessionId: resolvedSessionId,
        sessionPath,
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    ) + "\n",
  );
  console.log(`Saved mapping: issue #${issueNumber} -> ${resolvedSessionId}`);

  // ── Commit and push state changes ───────────────────────────────────────────
  // Stage only .GITOPENCLAW/ changes (runtime state, session mappings, memory).
  // Source code outside .GITOPENCLAW/ is never modified — the agent reads it
  // as raw context but all mutable state stays inside the .GITOPENCLAW/ tree.
  await run(["git", "add", ".GITOPENCLAW/"]);
  const { exitCode } = await run(["git", "diff", "--cached", "--quiet"]);
  if (exitCode !== 0) {
    // exitCode !== 0 means there are staged changes to commit.
    await run(["git", "commit", "-m", `gitopenclaw: work on issue #${issueNumber}`]);
  }

  // Retry push up to 10 times with backoff, rebasing with -X theirs on each conflict.
  const pushBackoffDelays = [1000, 2000, 3000, 5000, 7000, 8000, 10000, 12000, 12000, 15000];
  const MAX_PUSH_ATTEMPTS = pushBackoffDelays.length; // 10
  let pushed = false;
  for (let i = 0; i < MAX_PUSH_ATTEMPTS; i++) {
    const push = await run(["git", "push", "origin", `HEAD:${defaultBranch}`]);
    if (push.exitCode === 0) {
      pushed = true;
      break;
    }
    console.log(`Push failed, rebasing and retrying (${i + 1}/${MAX_PUSH_ATTEMPTS})...`);
    await new Promise((r) => setTimeout(r, pushBackoffDelays[i]));
    const rebase = await run(["git", "pull", "--rebase", "-X", "theirs", "origin", defaultBranch]);
    if (rebase.exitCode !== 0) {
      // Rebase failed — abort and surface a clear error
      await run(["git", "rebase", "--abort"]).catch(() => {});
      throw new Error("non-auto-resolvable rebase conflict");
    }
  }
  if (!pushed) {
    const totalWindow = pushBackoffDelays.reduce((a, b) => a + b, 0);
    throw new Error(
      `git push failed after ${MAX_PUSH_ATTEMPTS} attempts over ${totalWindow}ms total retry window`,
    );
  }

  // ── Post reply as issue comment ──────────────────────────────────────────────
  // Guard against empty/null responses — post an error message instead of silence.
  const trimmedText = agentText.trim();
  const commentBody =
    trimmedText.length > 0
      ? trimmedText.slice(0, MAX_COMMENT_LENGTH)
      : `✅ The agent ran successfully but did not produce a text response. Check the repository for any file changes that were made.\n\nFor full details, see the [workflow run logs](https://github.com/${repo}/actions).`;
  await gh("issue", "comment", String(issueNumber), "--body", commentBody);
} finally {
  // ── Guaranteed cleanup: remove tool-policy override ─────────────────────────
  // Delete the tool-policy-override.json written for semi-trusted actors so
  // stale policy files don't persist across subsequent runs.
  try {
    if (existsSync(toolPolicyOverridePath)) {
      unlinkSync(toolPolicyOverridePath);
      console.log("Cleaned up tool-policy-override.json");
    }
  } catch (e) {
    console.error("Failed to clean up tool-policy-override.json:", e);
  }

  // ── Guaranteed cleanup: remove 👀 reaction ───────────────────────────────────
  // This block always executes — even when the try block throws — ensuring the
  // 👀 activity indicator is always removed so users know the agent has stopped.
  if (reactionState?.reactionId) {
    try {
      const { reactionId, reactionTarget, commentId } = reactionState;
      if (reactionTarget === "comment" && commentId) {
        // Delete the reaction from the triggering comment.
        await gh(
          "api",
          `repos/${repo}/issues/comments/${commentId}/reactions/${reactionId}`,
          "-X",
          "DELETE",
        );
      } else {
        // Delete the reaction from the issue itself.
        await gh(
          "api",
          `repos/${repo}/issues/${issueNumber}/reactions/${reactionId}`,
          "-X",
          "DELETE",
        );
      }
    } catch (e) {
      // Log but do not re-throw — a failed cleanup should not mask the original error.
      console.error("Failed to remove reaction:", e);
    }
  }
}
