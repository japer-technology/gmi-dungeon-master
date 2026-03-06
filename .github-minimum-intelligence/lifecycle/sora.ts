import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { extname, relative, resolve } from "path";

export interface HandleSoraCommandArgs {
  commandText: string;
  issueNumber: number;
  repo: string;
  defaultBranch: string;
  minimumIntelligenceDir: string;
  openaiApiKey: string;
}

interface SoraCommandContext {
  issueNumber: number;
  repo: string;
  defaultBranch: string;
  minimumIntelligenceDir: string;
  openaiApiKey: string;
}

interface SoraJobRecord {
  id: string;
  issueNumber: number;
  createdAt: string;
  updatedAt: string;
  status: string;
  commandText: string;
  requestPayload?: any;
  createResponse?: any;
  statusResponse?: any;
  cancelResponse?: any;
  localAssets?: string[];
  notes?: string[];
}

interface ParseCreateResult {
  payload: Record<string, any>;
  localOptions: {
    wait: boolean;
    fetch: boolean;
    pollMs: number;
    timeoutS: number;
  };
}

const SORA_HELP = [
  "## 🎬 /sora command",
  "",
  "Run OpenAI Sora video jobs directly from issue comments.",
  "",
  "### Commands",
  "- `/sora create key=value key=value ...`",
  "- `/sora status <job_id>`",
  "- `/sora cancel <job_id>`",
  "- `/sora fetch <job_id>`",
  "- `/sora help`",
  "",
  "### Common create flags",
  "- `prompt=\"...\"`",
  "- `model=sora-1`",
  "- `duration=8s`",
  "- `resolution=1080p`",
  "- `aspect_ratio=16:9`",
  "- `fps=24`",
  "- `seed=42`",
  "",
  "### Full API options (passthrough)",
  "Use `--json` as the final argument to pass any Sora request payload fields:",
  "",
  "```",
  "/sora create prompt=\"Ancient city at dusk\" --json {",
  "  \"camera\": {\"move\": \"dolly_in\"},",
  "  \"style\": \"cinematic\"",
  "}",
  "```",
  "",
  "### Local (agent-only) options",
  "- `wait=true|false` (default: false)",
  "- `fetch=true|false` (default: false)",
  "- `poll_ms=5000`",
  "- `timeout_s=300`",
].join("\n");

export function isSoraCommand(text: string): boolean {
  return text.trimStart().startsWith("/sora");
}

export async function handleSoraCommand(args: HandleSoraCommandArgs): Promise<string> {
  const ctx: SoraCommandContext = {
    issueNumber: args.issueNumber,
    repo: args.repo,
    defaultBranch: args.defaultBranch,
    minimumIntelligenceDir: args.minimumIntelligenceDir,
    openaiApiKey: args.openaiApiKey,
  };

  const raw = args.commandText.trim();
  const withoutPrefix = raw.replace(/^\/sora\b/i, "").trim();
  if (!withoutPrefix || /^help\b/i.test(withoutPrefix)) {
    return SORA_HELP;
  }

  const commandWord = withoutPrefix.split(/\s+/, 1)[0].toLowerCase();
  const hasExplicitSubcommand = new Set(["create", "status", "cancel", "fetch", "help"]).has(commandWord);
  const subcommand = hasExplicitSubcommand ? commandWord : "create";
  const subcommandArgs = hasExplicitSubcommand
    ? withoutPrefix.slice(commandWord.length).trim()
    : withoutPrefix;

  const client = new OpenAISoraClient(ctx.openaiApiKey);

  switch (subcommand) {
    case "help":
      return SORA_HELP;

    case "create": {
      const parsed = parseCreateArgs(subcommandArgs);
      const createResponse = await client.create(parsed.payload);
      const jobId = inferJobId(createResponse) ?? `local-${Date.now()}`;
      const status = inferStatus(createResponse) ?? "submitted";

      const job: SoraJobRecord = {
        id: jobId,
        issueNumber: ctx.issueNumber,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        status,
        commandText: args.commandText,
        requestPayload: parsed.payload,
        createResponse,
      };
      saveJob(ctx.minimumIntelligenceDir, job);

      let statusPayload = createResponse;
      if (parsed.localOptions.wait) {
        statusPayload = await waitForTerminalState({
          client,
          jobId,
          pollMs: parsed.localOptions.pollMs,
          timeoutS: parsed.localOptions.timeoutS,
        });
        job.status = inferStatus(statusPayload) ?? job.status;
        job.statusResponse = statusPayload;
        job.updatedAt = new Date().toISOString();
        saveJob(ctx.minimumIntelligenceDir, job);
      }

      const terminal = isTerminalStatus(inferStatus(statusPayload) ?? status);
      if (terminal && parsed.localOptions.fetch) {
        const fetched = await fetchAndStoreAssets({
          ctx,
          client,
          job,
          statusPayload,
        });
        return formatFetchReply(job.id, inferStatus(statusPayload) ?? status, fetched.localAssets, ctx);
      }

      return [
        "## 🎬 Sora job submitted",
        "",
        `- **Job ID:** \`${job.id}\``,
        `- **Status:** \`${inferStatus(statusPayload) ?? status}\``,
        `- **Issue:** #${ctx.issueNumber}`,
        "",
        "### Next steps",
        `- Check status: \`/sora status ${job.id}\``,
        `- Fetch outputs: \`/sora fetch ${job.id}\``,
        "",
        "Use `/sora help` for full syntax.",
      ].join("\n");
    }

    case "status": {
      const jobId = subcommandArgs.trim() || latestJobIdForIssue(ctx.minimumIntelligenceDir, ctx.issueNumber);
      if (!jobId) {
        return "❌ No job id provided, and no prior /sora jobs were found for this issue.";
      }

      const statusPayload = await client.status(jobId);
      const status = inferStatus(statusPayload) ?? "unknown";
      const job = getOrCreateJobShell(ctx.minimumIntelligenceDir, ctx.issueNumber, jobId, args.commandText);
      job.status = status;
      job.statusResponse = statusPayload;
      job.updatedAt = new Date().toISOString();
      saveJob(ctx.minimumIntelligenceDir, job);

      return [
        "## 🎬 Sora job status",
        "",
        `- **Job ID:** \`${jobId}\``,
        `- **Status:** \`${status}\``,
        "",
        "### Next steps",
        `- Fetch outputs: \`/sora fetch ${jobId}\``,
        `- Cancel job: \`/sora cancel ${jobId}\``,
      ].join("\n");
    }

    case "cancel": {
      const jobId = subcommandArgs.trim() || latestJobIdForIssue(ctx.minimumIntelligenceDir, ctx.issueNumber);
      if (!jobId) {
        return "❌ No job id provided, and no prior /sora jobs were found for this issue.";
      }

      const cancelPayload = await client.cancel(jobId);
      const status = inferStatus(cancelPayload) ?? "cancelled";
      const job = getOrCreateJobShell(ctx.minimumIntelligenceDir, ctx.issueNumber, jobId, args.commandText);
      job.status = status;
      job.cancelResponse = cancelPayload;
      job.updatedAt = new Date().toISOString();
      saveJob(ctx.minimumIntelligenceDir, job);

      return [
        "## 🛑 Sora job cancelled",
        "",
        `- **Job ID:** \`${jobId}\``,
        `- **Status:** \`${status}\``,
      ].join("\n");
    }

    case "fetch": {
      const jobId = subcommandArgs.trim() || latestJobIdForIssue(ctx.minimumIntelligenceDir, ctx.issueNumber);
      if (!jobId) {
        return "❌ No job id provided, and no prior /sora jobs were found for this issue.";
      }

      const existingJob = loadJob(ctx.minimumIntelligenceDir, jobId);
      const statusPayload = await client.status(jobId);
      const job = existingJob ?? getOrCreateJobShell(ctx.minimumIntelligenceDir, ctx.issueNumber, jobId, args.commandText);
      job.status = inferStatus(statusPayload) ?? job.status;
      job.statusResponse = statusPayload;
      job.updatedAt = new Date().toISOString();

      const fetched = await fetchAndStoreAssets({
        ctx,
        client,
        job,
        statusPayload,
      });

      return formatFetchReply(jobId, job.status, fetched.localAssets, ctx);
    }

    default:
      return SORA_HELP;
  }
}

class OpenAISoraClient {
  private apiKey: string;
  private baseUrl: string;
  private createPath: string;
  private statusPath: string;
  private cancelPath: string;
  private contentPath: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
    this.baseUrl = (process.env.OPENAI_API_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
    this.createPath = process.env.SORA_CREATE_PATH || "/videos";
    this.statusPath = process.env.SORA_STATUS_PATH || "/videos/{id}";
    this.cancelPath = process.env.SORA_CANCEL_PATH || "/videos/{id}/cancel";
    this.contentPath = process.env.SORA_CONTENT_PATH || "/videos/{id}/content";
  }

  async create(payload: Record<string, any>): Promise<any> {
    return this.requestJson(this.createPath, "POST", payload);
  }

  async status(jobId: string): Promise<any> {
    return this.requestJson(this.fillPath(this.statusPath, jobId), "GET");
  }

  async cancel(jobId: string): Promise<any> {
    return this.requestJson(this.fillPath(this.cancelPath, jobId), "POST");
  }

  async content(jobId: string): Promise<{ bytes: Uint8Array; contentType: string | null }> {
    const url = `${this.baseUrl}${this.fillPath(this.contentPath, jobId)}`;
    const res = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
      },
    });
    if (!res.ok) {
      const body = await safeReadText(res);
      throw new Error(`Sora content request failed (${res.status}): ${body}`);
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    return {
      bytes,
      contentType: res.headers.get("content-type"),
    };
  }

  async download(url: string): Promise<{ bytes: Uint8Array; contentType: string | null }> {
    const isOpenAIAsset = /(^https:\/\/api\.openai\.com\/|\.openai\.com\/)/i.test(url);
    const headers: Record<string, string> = {};
    if (isOpenAIAsset) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }

    const res = await fetch(url, { method: "GET", headers });
    if (!res.ok) {
      const body = await safeReadText(res);
      throw new Error(`Asset download failed (${res.status}) for ${url}: ${body}`);
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    return {
      bytes,
      contentType: res.headers.get("content-type"),
    };
  }

  private fillPath(template: string, jobId: string): string {
    const encoded = encodeURIComponent(jobId);
    return template.replace("{id}", encoded);
  }

  private async requestJson(path: string, method: string, payload?: any): Promise<any> {
    const url = `${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
    };

    let body: string | undefined;
    if (payload !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(payload);
    }

    const res = await fetch(url, { method, headers, body });
    if (!res.ok) {
      const text = await safeReadText(res);
      throw new Error(`Sora request failed (${res.status}) ${method} ${path}: ${text}`);
    }

    const text = await res.text();
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      return { raw: text };
    }
  }
}

function parseCreateArgs(rawArgs: string): ParseCreateResult {
  const defaults: Record<string, any> = {
    model: process.env.SORA_MODEL || "sora-1",
  };

  const jsonMatch = rawArgs.match(/(?:^|\s)--json(?:=|\s+)([\s\S]+)$/);
  let jsonPayload: Record<string, any> = {};
  let flagsRegion = rawArgs;
  if (jsonMatch) {
    const jsonText = jsonMatch[1].trim();
    if (!jsonText) {
      throw new Error("`--json` was provided without JSON payload.");
    }
    try {
      const parsed = JSON.parse(jsonText);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("JSON payload must be an object.");
      }
      jsonPayload = parsed;
    } catch (e: any) {
      throw new Error(`Failed to parse --json payload: ${e?.message ?? String(e)}`);
    }
    flagsRegion = rawArgs.slice(0, jsonMatch.index).trim();
  }

  const tokens = tokenize(flagsRegion);
  const kvPayload: Record<string, any> = {};
  const promptWords: string[] = [];

  for (const token of tokens) {
    if (!token) continue;

    if (token === "--wait") {
      kvPayload.wait = true;
      continue;
    }
    if (token === "--no-wait") {
      kvPayload.wait = false;
      continue;
    }
    if (token === "--fetch") {
      kvPayload.fetch = true;
      continue;
    }
    if (token === "--no-fetch") {
      kvPayload.fetch = false;
      continue;
    }

    const cleaned = token.replace(/^--/, "");
    const eq = cleaned.indexOf("=");
    if (eq >= 0) {
      const key = normalizeKey(cleaned.slice(0, eq));
      const rawValue = cleaned.slice(eq + 1);
      kvPayload[key] = parseLooseValue(rawValue);
    } else {
      promptWords.push(token);
    }
  }

  const combined = {
    ...defaults,
    ...kvPayload,
    ...jsonPayload,
  };

  if (promptWords.length > 0 && combined.prompt === undefined) {
    combined.prompt = promptWords.join(" ");
  }

  const localOptions = {
    wait: toBoolean(combined.wait, false),
    fetch: toBoolean(combined.fetch, false),
    pollMs: clampNumber(Number(combined.poll_ms ?? combined.pollMs ?? 5000), 250, 60000),
    timeoutS: clampNumber(Number(combined.timeout_s ?? combined.timeoutS ?? 300), 5, 3600),
  };

  delete combined.wait;
  delete combined.fetch;
  delete combined.poll_ms;
  delete combined.pollMs;
  delete combined.timeout_s;
  delete combined.timeoutS;

  if (!combined.prompt && !combined.input_image && !combined.input_video && !combined.input) {
    throw new Error("Missing Sora input. Provide `prompt=...` or pass fields via `--json`.");
  }

  return {
    payload: combined,
    localOptions,
  };
}

async function waitForTerminalState(args: {
  client: OpenAISoraClient;
  jobId: string;
  pollMs: number;
  timeoutS: number;
}): Promise<any> {
  const started = Date.now();
  const timeoutMs = args.timeoutS * 1000;

  while (true) {
    const statusPayload = await args.client.status(args.jobId);
    const status = inferStatus(statusPayload) ?? "unknown";
    if (isTerminalStatus(status)) {
      return statusPayload;
    }

    if (Date.now() - started >= timeoutMs) {
      return {
        status,
        note: `Timed out waiting after ${args.timeoutS}s`,
      };
    }

    await sleep(args.pollMs);
  }
}

async function fetchAndStoreAssets(args: {
  ctx: SoraCommandContext;
  client: OpenAISoraClient;
  job: SoraJobRecord;
  statusPayload: any;
}): Promise<{ localAssets: string[] }> {
  const { ctx, client, job } = args;

  const status = inferStatus(args.statusPayload) ?? job.status;
  if (!isSuccessfulStatus(status)) {
    throw new Error(`Job ${job.id} is not complete yet (status: ${status}). Try /sora status ${job.id}.`);
  }

  const outputDir = resolve(process.cwd(), "assets", "sora", `issue-${ctx.issueNumber}`, job.id);
  mkdirSync(outputDir, { recursive: true });

  const urls = dedupeStrings([
    ...extractCandidateUrls(args.statusPayload),
    ...extractCandidateUrls(job.createResponse),
    ...extractCandidateUrls(job.statusResponse),
  ]);

  const localAssets: string[] = [];

  if (urls.length > 0) {
    for (let i = 0; i < urls.length; i++) {
      const url = urls[i];
      const downloaded = await client.download(url);
      const extension = inferExtension(url, downloaded.contentType, "mp4");
      const filename = `asset-${String(i + 1).padStart(2, "0")}.${extension}`;
      const absolute = resolve(outputDir, filename);
      writeFileSync(absolute, downloaded.bytes);
      localAssets.push(toRepoRelative(absolute));
    }
  } else {
    // Fallback to direct content endpoint when status payload does not include URLs.
    const content = await client.content(job.id);
    const extension = inferExtension(job.id, content.contentType, "mp4");
    const absolute = resolve(outputDir, `output.${extension}`);
    writeFileSync(absolute, content.bytes);
    localAssets.push(toRepoRelative(absolute));
  }

  const manifestPath = resolve(outputDir, "manifest.json");
  writeFileSync(manifestPath, JSON.stringify({
    jobId: job.id,
    issueNumber: ctx.issueNumber,
    status,
    downloadedAt: new Date().toISOString(),
    assets: localAssets,
  }, null, 2) + "\n");

  localAssets.push(toRepoRelative(manifestPath));

  job.localAssets = localAssets;
  job.status = status;
  job.statusResponse = args.statusPayload;
  job.updatedAt = new Date().toISOString();
  saveJob(ctx.minimumIntelligenceDir, job);

  return { localAssets };
}

function formatFetchReply(jobId: string, status: string, localAssets: string[], ctx: SoraCommandContext): string {
  const links = localAssets
    .filter((p) => p.startsWith("assets/"))
    .map((p) => `- [${p}](https://github.com/${ctx.repo}/blob/${ctx.defaultBranch}/${p})`);

  const rawLinks = localAssets
    .filter((p) => p.startsWith("assets/"))
    .map((p) => `- https://raw.githubusercontent.com/${ctx.repo}/${ctx.defaultBranch}/${p}`);

  return [
    "## 📦 Sora outputs fetched",
    "",
    `- **Job ID:** \`${jobId}\``,
    `- **Status:** \`${status}\``,
    "",
    "### Saved files",
    ...(links.length > 0 ? links : ["- _(none)_"]),
    "",
    "### Raw URLs",
    ...(rawLinks.length > 0 ? rawLinks : ["- _(none)_"]),
  ].join("\n");
}

function getOrCreateJobShell(minimumIntelligenceDir: string, issueNumber: number, jobId: string, commandText: string): SoraJobRecord {
  return loadJob(minimumIntelligenceDir, jobId) ?? {
    id: jobId,
    issueNumber,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: "unknown",
    commandText,
  };
}

function saveJob(minimumIntelligenceDir: string, job: SoraJobRecord): void {
  const paths = ensureSoraState(minimumIntelligenceDir);
  const jobPath = resolve(paths.jobsDir, `${safeFileId(job.id)}.json`);
  writeFileSync(jobPath, JSON.stringify(job, null, 2) + "\n");

  const index = loadIndex(paths.indexPath);
  if (!index.byIssue[job.issueNumber]) index.byIssue[job.issueNumber] = [];
  if (!index.byIssue[job.issueNumber].includes(job.id)) {
    index.byIssue[job.issueNumber].push(job.id);
  }
  index.lastByIssue[job.issueNumber] = job.id;
  index.updatedAt = new Date().toISOString();
  writeFileSync(paths.indexPath, JSON.stringify(index, null, 2) + "\n");
}

function loadJob(minimumIntelligenceDir: string, jobId: string): SoraJobRecord | null {
  const paths = ensureSoraState(minimumIntelligenceDir);
  const jobPath = resolve(paths.jobsDir, `${safeFileId(jobId)}.json`);
  if (!existsSync(jobPath)) return null;
  return JSON.parse(readFileSync(jobPath, "utf-8"));
}

function latestJobIdForIssue(minimumIntelligenceDir: string, issueNumber: number): string | "" {
  const paths = ensureSoraState(minimumIntelligenceDir);
  if (!existsSync(paths.indexPath)) return "";

  const index = loadIndex(paths.indexPath);
  return index.lastByIssue[issueNumber] || "";
}

function ensureSoraState(minimumIntelligenceDir: string): {
  stateDir: string;
  jobsDir: string;
  indexPath: string;
} {
  const stateDir = resolve(minimumIntelligenceDir, "state", "sora");
  const jobsDir = resolve(stateDir, "jobs");
  const indexPath = resolve(stateDir, "index.json");
  mkdirSync(jobsDir, { recursive: true });

  if (!existsSync(indexPath)) {
    writeFileSync(indexPath, JSON.stringify({ byIssue: {}, lastByIssue: {}, updatedAt: new Date().toISOString() }, null, 2) + "\n");
  }

  return { stateDir, jobsDir, indexPath };
}

function loadIndex(indexPath: string): { byIssue: Record<string, string[]>; lastByIssue: Record<string, string>; updatedAt: string } {
  const parsed = JSON.parse(readFileSync(indexPath, "utf-8"));
  if (!parsed.byIssue) parsed.byIssue = {};
  if (!parsed.lastByIssue) parsed.lastByIssue = {};
  return parsed;
}

function normalizeKey(key: string): string {
  return key.trim().replace(/^-+/, "").replace(/-/g, "_");
}

function parseLooseValue(value: string): any {
  const trimmed = value.trim();
  if (trimmed === "") return "";

  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null") return null;

  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    return Number(trimmed);
  }

  if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed;
    }
  }

  return trimmed;
}

function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let escape = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (escape) {
      current += ch;
      escape = false;
      continue;
    }

    if (ch === "\\") {
      escape = true;
      continue;
    }

    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }

    if (/\s/.test(ch)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += ch;
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  return tokens;
}

function inferJobId(payload: any): string | null {
  if (!payload || typeof payload !== "object") return null;

  const candidates = [
    payload.id,
    payload.job_id,
    payload.video_id,
    payload?.data?.id,
  ];

  for (const candidate of candidates) {
    if (candidate && typeof candidate === "string") return candidate;
  }

  return null;
}

function inferStatus(payload: any): string | null {
  if (!payload || typeof payload !== "object") return null;
  const candidates = [
    payload.status,
    payload.state,
    payload.phase,
    payload?.data?.status,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim().toLowerCase();
    }
  }
  return null;
}

function isTerminalStatus(status: string): boolean {
  const s = status.toLowerCase();
  return ["completed", "succeeded", "success", "failed", "error", "cancelled", "canceled"].includes(s);
}

function isSuccessfulStatus(status: string): boolean {
  const s = status.toLowerCase();
  return ["completed", "succeeded", "success"].includes(s);
}

function extractCandidateUrls(input: any): string[] {
  const urls: string[] = [];
  const seen = new Set<any>();

  function walk(value: any, keyHint = "") {
    if (value === null || value === undefined) return;
    if (typeof value === "string") {
      if (/^https?:\/\//i.test(value) && looksLikeAssetUrl(value, keyHint)) {
        urls.push(value);
      }
      return;
    }

    if (typeof value !== "object") return;
    if (seen.has(value)) return;
    seen.add(value);

    if (Array.isArray(value)) {
      for (const entry of value) walk(entry, keyHint);
      return;
    }

    for (const [k, v] of Object.entries(value)) {
      walk(v, k);
    }
  }

  walk(input);
  return dedupeStrings(urls);
}

function looksLikeAssetUrl(url: string, keyHint: string): boolean {
  const key = keyHint.toLowerCase();
  if (key.includes("url") || key.includes("video") || key.includes("download") || key.includes("content") || key.includes("asset")) {
    return true;
  }

  return /\.(mp4|mov|webm|gif|png|jpg|jpeg)(\?|$)/i.test(url);
}

function inferExtension(source: string, contentType: string | null, fallback: string): string {
  const byType: Record<string, string> = {
    "video/mp4": "mp4",
    "video/quicktime": "mov",
    "video/webm": "webm",
    "image/gif": "gif",
    "image/png": "png",
    "image/jpeg": "jpg",
    "application/json": "json",
  };

  if (contentType && byType[contentType.toLowerCase()]) {
    return byType[contentType.toLowerCase()];
  }

  const ext = extname(source).replace(/^\./, "");
  if (ext) return ext;

  return fallback;
}

function toRepoRelative(absolutePath: string): string {
  return relative(process.cwd(), absolutePath).replace(/\\/g, "/");
}

function safeFileId(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function toBoolean(value: any, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const v = value.toLowerCase();
    if (v === "true" || v === "1" || v === "yes") return true;
    if (v === "false" || v === "0" || v === "no") return false;
  }
  return fallback;
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

async function safeReadText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "<no response body>";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
