import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ensureClaudeHomeDir,
  readClaudeHomeInventory,
  resolveClaudeHomeDir,
} from "@paperclipai/adapter-claude-local/server";
import {
  CLAUDE_REDACTED_VALUE,
  type ClaudeCliAvailablePlugin,
  type ClaudeCliInstalledPlugin,
  type ClaudeCliLoginStartResponse,
  type ClaudeCliMarketplace,
  type ClaudeCliMarketplacesResponse,
  type ClaudeCliMcpListResponse,
  type ClaudeCliMcpOrigin,
  type ClaudeCliMcpServer,
  type ClaudeCliMcpStatus,
  type ClaudeCliPluginDetailsResponse,
  type ClaudeCliPluginsResponse,
} from "@paperclipai/shared";
import { badRequest, HttpError, notFound, unprocessable } from "../errors.js";
import { stripSecretBearingUrlParts } from "../middleware/redact-sensitive.js";
import { REDACTED_EVENT_VALUE, redactSensitiveText } from "../redaction.js";
import { assertValidMcpServerConfig, withCompanyLock } from "./claude-home.js";

// Terminal parity: drive the real `claude` CLI against the company Claude Home
// (CLAUDE_CONFIG_DIR) so behaviour and file formats match the terminal. The
// binary always runs from an argument array (never a shell) with a minimal
// env that never carries Anthropic credentials. File parsing is the fallback
// when the binary is unavailable. See doc/plans/2026-09-27-claude-cli-parity.md.

export const CLAUDE_CLI_DEFAULT_TIMEOUT_MS = 60_000;
export const CLAUDE_CLI_LONG_TIMEOUT_MS = 180_000;
export const CLAUDE_CLI_OUTPUT_CAP_BYTES = 1024 * 1024;
export const CLAUDE_CLI_LOGIN_TTL_MS = 10 * 60_000;
const LOGIN_URL_WAIT_MS = 20_000;
const LOGIN_COMPLETE_WAIT_MS = 60_000;

// Leading "-" is refused everywhere so a value can never be read as a CLI flag.
export const CLAUDE_CLI_MCP_NAME_PATTERN = /^(?!-)[A-Za-z0-9_.:-]{1,80}$/;
/** claude.ai connectors are listed as "claude.ai <Name>"; accepted for sign-in / sign-out only. */
const CLAUDE_AI_CONNECTOR_NAME_PATTERN = /^claude\.ai [A-Za-z0-9_. -]{1,80}$/;
export const CLAUDE_CLI_PLUGIN_ID_PATTERN = /^(?!-)[A-Za-z0-9_.-]+(@[A-Za-z0-9_.-]+)?$/;
const MARKETPLACE_NAME_PATTERN = /^(?!-)[A-Za-z0-9_.-]{1,100}$/;
const MARKETPLACE_REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const MARKETPLACE_SSH_PATTERN = /^git@github\.com:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

const PASSTHROUGH_ENV_KEYS = [
  "DISABLE_TELEMETRY",
  "DISABLE_ERROR_REPORTING",
  "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
] as const;

// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;
const MCP_LINE_PATTERN = /^(?<name>.+?): (?<target>.+?)(?: \((?<type>[A-Z]+)\))? - (?<status>.+)$/;
const SECRET_FLAG_PATTERN = /^--?[A-Za-z0-9_-]*(token|key|secret|password|passwd|auth|credential|bearer)[A-Za-z0-9_-]*$/i;
const ENV_ASSIGNMENT_PATTERN = /^([A-Za-z_][A-Za-z0-9_]*)=(.+)$/;
const REDACTED = REDACTED_EVENT_VALUE;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

// ---------------------------------------------------------------------------
// Validation (400 before anything is spawned)

export function assertValidCliMcpName(name: string, opts: { allowClaudeAi?: boolean } = {}): void {
  if (typeof name !== "string") throw badRequest("MCP server name is required");
  if (CLAUDE_CLI_MCP_NAME_PATTERN.test(name)) return;
  if (opts.allowClaudeAi && CLAUDE_AI_CONNECTOR_NAME_PATTERN.test(name)) return;
  throw badRequest("MCP server name must be 1-80 characters of letters, numbers, '_', '.', ':' or '-'");
}

export function assertValidPluginId(id: string): void {
  if (typeof id !== "string" || id.length > 200 || !CLAUDE_CLI_PLUGIN_ID_PATTERN.test(id)) {
    throw badRequest("Plugin id must look like name or name@marketplace");
  }
}

export function assertValidMarketplaceName(name: string): void {
  if (typeof name !== "string" || !MARKETPLACE_NAME_PATTERN.test(name) || name === "." || name === "..") {
    throw badRequest("Marketplace name must be letters, numbers, '_', '.' or '-'");
  }
}

/** Allow `owner/repo`, an https:// URL, or `git@github.com:owner/repo(.git)`. Local paths are rejected. */
export function assertValidMarketplaceSource(source: unknown): string {
  const value = typeof source === "string" ? source.trim() : "";
  if (!value || value.length > 500 || /\s/.test(value) || value.startsWith("-")) {
    throw badRequest("Marketplace source must be owner/repo, an https:// URL, or a git@github.com: URL");
  }
  if (MARKETPLACE_REPO_PATTERN.test(value) && !value.startsWith(".")) return value;
  if (MARKETPLACE_SSH_PATTERN.test(value)) return value;
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && url.hostname && !url.username && !url.password) return value;
  } catch {
    // fall through
  }
  throw badRequest("Marketplace source must be owner/repo, an https:// URL, or a git@github.com: URL");
}

export function assertValidRedirectUrl(value: unknown): string {
  const raw = typeof value === "string" ? value.trim() : "";
  try {
    const url = new URL(raw);
    if ((url.protocol === "http:" || url.protocol === "https:") && raw.length <= 8192) return raw;
  } catch {
    // fall through
  }
  throw badRequest("redirectUrl must be the http(s) URL your browser was redirected to");
}

function containsRedactedValue(value: unknown): boolean {
  if (value === CLAUDE_REDACTED_VALUE) return true;
  if (Array.isArray(value)) return value.some(containsRedactedValue);
  if (isPlainObject(value)) return Object.values(value).some(containsRedactedValue);
  return false;
}

/** Normalise and validate an add-json config (same rules as the file-based upsert). */
export function buildMcpAddJsonConfig(config: unknown): Record<string, unknown> {
  if (!isPlainObject(config)) throw badRequest("config must be a JSON object");
  if (containsRedactedValue(config)) throw badRequest("Enter secret values; redacted placeholders cannot be added");
  assertValidMcpServerConfig(config);
  const type = asString(config.type) ?? "stdio";
  const out: Record<string, unknown> = { type };
  if (type === "stdio") {
    out.command = asString(config.command);
    if (Array.isArray(config.args)) out.args = config.args;
    if (isPlainObject(config.env)) out.env = config.env;
  } else {
    out.url = asString(config.url);
    if (isPlainObject(config.headers)) out.headers = config.headers;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Redaction and parsing

function redactUrl(value: string): string {
  return stripSecretBearingUrlParts(value);
}

/** Redact query strings / userinfo from URLs and secret-looking stdio args. */
export function redactCliTarget(target: string): string {
  const trimmed = target.trim();
  if (/^https?:\/\//i.test(trimmed) && !/\s/.test(trimmed)) return redactUrl(trimmed);
  const tokens = trimmed.split(/\s+/);
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (i > 0 && SECRET_FLAG_PATTERN.test(tokens[i - 1]!) && !token.startsWith("-")) {
      out.push(REDACTED);
      continue;
    }
    const flagAssign = /^(--?[A-Za-z0-9_-]+)=(.*)$/.exec(token);
    if (flagAssign && SECRET_FLAG_PATTERN.test(flagAssign[1]!)) {
      out.push(`${flagAssign[1]}=${REDACTED}`);
      continue;
    }
    const envAssign = ENV_ASSIGNMENT_PATTERN.exec(token);
    if (envAssign && !token.startsWith("-")) {
      out.push(`${envAssign[1]}=${REDACTED}`);
      continue;
    }
    out.push(/^https?:\/\//i.test(token) ? redactUrl(token) : token);
  }
  return redactSensitiveText(out.join(" "));
}

/** Redact CLI output for display: secret text plus URL query strings / userinfo. */
export function redactCliText(text: string): string {
  return redactSensitiveText(text).replace(/https?:\/\/[^\s"'<>)]+/gi, (url) => redactUrl(url));
}

function parseStatus(raw: string): { status: ClaudeCliMcpStatus; statusText: string } {
  const statusText = raw.replace(/^[\s✓✔✘✗×⏸⚠!·•-]+/u, "").trim();
  let status: ClaudeCliMcpStatus = "unknown";
  if (raw.includes("⏸") || /pending|approval/i.test(raw)) status = "pending_approval";
  else if (/auth/i.test(raw)) status = "needs_auth";
  else if (/[✓✔]/u.test(raw) || /^connected/i.test(statusText)) status = "connected";
  else if (/[✘✗×]/u.test(raw) || /fail|error/i.test(raw)) status = "failed";
  return { status, statusText: redactCliText(statusText) };
}

/** Parse `claude mcp list` output. `installedPluginIds` maps plugin-provided servers to plugin ids. */
export function parseMcpList(output: string, installedPluginIds: string[] = []): ClaudeCliMcpServer[] {
  const servers: ClaudeCliMcpServer[] = [];
  const seen = new Set<string>();
  for (const rawLine of stripAnsi(output).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || /^no mcp servers configured/i.test(line) || /^checking mcp server health/i.test(line)) continue;
    const match = MCP_LINE_PATTERN.exec(line);
    if (!match?.groups) continue;
    const name = match.groups.name!.trim();
    const rawTarget = match.groups.target!.trim();
    const transport = match.groups.type ?? null;
    let origin: ClaudeCliMcpOrigin = "claude_home";
    let pluginId: string | null = null;
    if (name.startsWith("plugin:")) {
      origin = "plugin";
      const pluginName = name.split(":")[1] ?? "";
      pluginId =
        installedPluginIds.find((id) => id === pluginName || id.startsWith(`${pluginName}@`)) ?? (pluginName || null);
    } else if (name.startsWith("claude.ai ") || /claude\.ai/i.test(transport ?? "")) {
      origin = "claude_ai";
    }
    if (seen.has(name)) continue;
    seen.add(name);
    const { status, statusText } = parseStatus(match.groups.status!);
    servers.push({
      name,
      origin,
      target: redactCliTarget(rawTarget),
      transport,
      status,
      statusText,
      pluginId,
      removable: origin === "claude_home",
      supportsLogin: origin === "claude_ai" || transport === "HTTP" || transport === "SSE",
    });
  }
  return servers;
}

function firstMeaningfulLine(...texts: string[]): string | null {
  for (const text of texts) {
    for (const rawLine of stripAnsi(text).split(/\r?\n/)) {
      const line = rawLine.trim();
      if (line && /[A-Za-z0-9]/.test(line)) return line;
    }
  }
  return null;
}

function cliErrorMessage(result: ClaudeCliResult, fallback: string): string {
  const line = firstMeaningfulLine(result.stderr, result.stdout);
  const message = line ? redactCliText(line) : fallback;
  return message.length > 500 ? `${message.slice(0, 500)}…` : message;
}

function parseJsonArray(text: string): unknown[] | null {
  const trimmed = stripAnsi(text).trim();
  const start = trimmed.indexOf("[");
  if (start === -1) return null;
  try {
    const parsed = JSON.parse(trimmed.slice(start));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function readJsonOrNull(filePath: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Runner

export interface ClaudeCliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ClaudeCliRunOptions {
  stdin?: string;
  timeoutMs?: number;
}

export interface ClaudeCliServiceDeps {
  env?: NodeJS.ProcessEnv;
  loginTtlMs?: number;
  loginUrlWaitMs?: number;
}

export function cliUnavailable(): HttpError {
  return new HttpError(503, "The claude CLI is not installed on the Paperclip host", {
    code: "claude_cli_unavailable",
  });
}

function isUnavailable(error: unknown): boolean {
  return error instanceof HttpError && error.status === 503;
}

let privateHomePromise: Promise<string> | null = null;

/** A private, empty HOME so the CLI never reads the server user's ~/.claude or credentials. */
function privateHome(): Promise<string> {
  privateHomePromise ??= fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-cli-home-")).then(async (dir) => {
    await fs.chmod(dir, 0o700);
    return dir;
  });
  return privateHomePromise;
}

class OutputCollector {
  private chunks: Buffer[] = [];
  private size = 0;
  add(chunk: Buffer) {
    if (this.size >= CLAUDE_CLI_OUTPUT_CAP_BYTES) return;
    const room = CLAUDE_CLI_OUTPUT_CAP_BYTES - this.size;
    const piece = chunk.length > room ? chunk.subarray(0, room) : chunk;
    this.chunks.push(piece);
    this.size += piece.length;
  }
  text() {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

interface LoginSession {
  id: string;
  companyId: string;
  name: string;
  child: ChildProcessWithoutNullStreams;
  exit: Promise<number>;
  stdout: OutputCollector;
  stderr: OutputCollector;
  timer: NodeJS.Timeout;
}

// In-process login sessions: one per company + server name.
const loginSessions = new Map<string, LoginSession>();

function killChild(child: ChildProcessWithoutNullStreams) {
  if (child.exitCode === null && child.signalCode === null) {
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
  }
}

function dropSession(session: LoginSession) {
  clearTimeout(session.timer);
  killChild(session.child);
  if (loginSessions.get(session.id) === session) loginSessions.delete(session.id);
}

/** Test helper: number of live login sessions. */
export function activeClaudeCliLoginSessions(): number {
  return loginSessions.size;
}

export function claudeCliService(deps: ClaudeCliServiceDeps = {}) {
  const env = () => deps.env ?? process.env;
  const loginTtlMs = deps.loginTtlMs ?? CLAUDE_CLI_LOGIN_TTL_MS;
  const loginUrlWaitMs = deps.loginUrlWaitMs ?? LOGIN_URL_WAIT_MS;

  function homeDirFor(companyId: string): string {
    try {
      return resolveClaudeHomeDir(env(), companyId);
    } catch (error) {
      throw badRequest(error instanceof Error ? error.message : "Invalid company id");
    }
  }

  async function ensureHome(companyId: string): Promise<string> {
    const dir = homeDirFor(companyId);
    await ensureClaudeHomeDir(dir);
    return dir;
  }

  async function childEnv(home: string): Promise<NodeJS.ProcessEnv> {
    const source = env();
    const out: NodeJS.ProcessEnv = {
      PATH: source.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      HOME: await privateHome(),
      CLAUDE_CONFIG_DIR: home,
      NO_COLOR: "1",
    };
    for (const key of PASSTHROUGH_ENV_KEYS) {
      if (source[key] !== undefined) out[key] = source[key];
    }
    return out;
  }

  function binary(): string {
    return asString(env().PAPERCLIP_CLAUDE_BIN) ?? "claude";
  }

  async function spawnCli(home: string, args: string[]): Promise<ChildProcessWithoutNullStreams> {
    const child = spawn(binary(), args, {
      cwd: home,
      env: await childEnv(home),
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    // Surface ENOENT synchronously-ish: wait for either "spawn" or "error".
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", () => resolve());
      child.once("error", (error: NodeJS.ErrnoException) => {
        reject(error.code === "ENOENT" || error.code === "EACCES" ? cliUnavailable() : error);
      });
    });
    child.on("error", () => undefined);
    child.stdin.on("error", () => undefined);
    return child;
  }

  /** Run the CLI once; resolves with the exit code (non-zero is not thrown). */
  async function run(companyId: string, args: string[], opts: ClaudeCliRunOptions = {}): Promise<ClaudeCliResult> {
    const home = await ensureHome(companyId);
    const child = await spawnCli(home, args);
    const stdout = new OutputCollector();
    const stderr = new OutputCollector();
    child.stdout.on("data", (chunk: Buffer) => stdout.add(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.add(chunk));
    if (opts.stdin !== undefined) child.stdin.write(opts.stdin);
    child.stdin.end();
    const timeoutMs = opts.timeoutMs ?? CLAUDE_CLI_DEFAULT_TIMEOUT_MS;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killChild(child);
    }, timeoutMs);
    const exitCode = await new Promise<number>((resolve) => {
      child.once("close", (code) => resolve(code ?? 1));
    });
    clearTimeout(timer);
    if (timedOut) throw unprocessable(`claude ${args[0] ?? ""} timed out after ${Math.round(timeoutMs / 1000)}s`);
    return { exitCode, stdout: stdout.text(), stderr: stderr.text() };
  }

  /** Run and throw 422 on a non-zero exit. */
  async function runOk(companyId: string, args: string[], opts: ClaudeCliRunOptions = {}): Promise<ClaudeCliResult> {
    const result = await run(companyId, args, opts);
    if (result.exitCode !== 0) {
      throw unprocessable(cliErrorMessage(result, `claude ${args.slice(0, 2).join(" ")} failed`));
    }
    return result;
  }

  /** Mutations share the Claude Home per-company lock. */
  function runLocked(companyId: string, args: string[], opts: ClaudeCliRunOptions = {}) {
    return withCompanyLock(companyId, () => runOk(companyId, args, opts));
  }

  // ---- plugins (file fallback helpers) ------------------------------------

  async function readInstalledFromFiles(home: string): Promise<ClaudeCliInstalledPlugin[]> {
    const installed = await readJsonOrNull(path.join(home, "plugins", "installed_plugins.json"));
    const settings = await readJsonOrNull(path.join(home, "settings.json"));
    const enabledMap = isPlainObject(settings) && isPlainObject(settings.enabledPlugins) ? settings.enabledPlugins : {};
    const plugins = isPlainObject(installed) && isPlainObject(installed.plugins) ? installed.plugins : {};
    const out: ClaudeCliInstalledPlugin[] = [];
    for (const [id, value] of Object.entries(plugins)) {
      const entry = Array.isArray(value) ? value[0] : value;
      const record = isPlainObject(entry) ? entry : {};
      out.push({
        id,
        version: asString(record.version),
        scope: asString(record.scope) ?? "user",
        enabled: typeof enabledMap[id] === "boolean" ? (enabledMap[id] as boolean) : true,
        installedAt: asString(record.installedAt),
        lastUpdated: asString(record.lastUpdated),
      });
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
  }

  function normalizeInstalled(entries: unknown[]): ClaudeCliInstalledPlugin[] {
    return entries
      .filter(isPlainObject)
      .map((entry) => ({
        id: asString(entry.id) ?? "",
        version: asString(entry.version),
        scope: asString(entry.scope),
        enabled: entry.enabled !== false,
        installedAt: asString(entry.installedAt),
        lastUpdated: asString(entry.lastUpdated),
      }))
      .filter((entry) => entry.id);
  }

  async function listInstalled(
    companyId: string,
    home: string,
  ): Promise<{ installed: ClaudeCliInstalledPlugin[]; cliAvailable: boolean }> {
    try {
      const result = await run(companyId, ["plugin", "list", "--json"]);
      const parsed = parseJsonArray(result.stdout);
      if (result.exitCode === 0 && parsed) return { installed: normalizeInstalled(parsed), cliAvailable: true };
      const text = `${result.stdout}\n${result.stderr}`;
      if (/not logged in/i.test(text) || result.exitCode === 0) {
        // With nothing installed the CLI prints "Not logged in"; the files are authoritative then.
        return { installed: await readInstalledFromFiles(home), cliAvailable: true };
      }
      throw unprocessable(cliErrorMessage(result, "claude plugin list failed"));
    } catch (error) {
      if (!isUnavailable(error)) throw error;
      return { installed: await readInstalledFromFiles(home), cliAvailable: false };
    }
  }

  function catalogPath(home: string, marketplace: string) {
    return path.join(home, "plugins", "marketplaces", marketplace, ".claude-plugin", "marketplace.json");
  }

  async function readCatalog(home: string, marketplace: string): Promise<Record<string, unknown>[] | null> {
    const parsed = await readJsonOrNull(catalogPath(home, marketplace));
    if (!isPlainObject(parsed) || !Array.isArray(parsed.plugins)) return null;
    return parsed.plugins.filter(isPlainObject);
  }

  async function marketplaceDirs(home: string): Promise<string[]> {
    try {
      const entries = await fs.readdir(path.join(home, "plugins", "marketplaces"), { withFileTypes: true });
      return entries
        .filter((entry) => entry.isDirectory() && MARKETPLACE_NAME_PATTERN.test(entry.name))
        .map((entry) => entry.name)
        .sort((a, b) => a.localeCompare(b));
    } catch {
      return [];
    }
  }

  function stringList(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && !!item.trim()) : [];
  }

  async function listAvailable(home: string, installedIds: Set<string>): Promise<ClaudeCliAvailablePlugin[]> {
    const out: ClaudeCliAvailablePlugin[] = [];
    for (const marketplace of await marketplaceDirs(home)) {
      for (const plugin of (await readCatalog(home, marketplace)) ?? []) {
        const name = asString(plugin.name);
        if (!name || !CLAUDE_CLI_PLUGIN_ID_PATTERN.test(name) || name.includes("@")) continue;
        const id = `${name}@${marketplace}`;
        const author = isPlainObject(plugin.author) ? asString(plugin.author.name) : asString(plugin.author);
        const homepage = asString(plugin.homepage);
        out.push({
          id,
          name,
          marketplace,
          displayName: asString(plugin.displayName),
          description: asString(plugin.description),
          category: asString(plugin.category),
          tags: [...new Set([...stringList(plugin.tags), ...stringList(plugin.keywords)])],
          author,
          homepage: homepage && /^https?:\/\//i.test(homepage) ? redactUrl(homepage) : null,
          version: asString(plugin.version),
          installed: installedIds.has(id),
        });
      }
    }
    return out;
  }

  async function getPlugins(companyId: string): Promise<ClaudeCliPluginsResponse> {
    const home = await ensureHome(companyId);
    const { installed, cliAvailable } = await listInstalled(companyId, home);
    const available = await listAvailable(home, new Set(installed.map((plugin) => plugin.id)));
    return { installed, available, cliAvailable };
  }

  // ---- MCP ----------------------------------------------------------------

  async function fallbackMcpServers(home: string): Promise<ClaudeCliMcpServer[]> {
    const inventory = await readClaudeHomeInventory(home);
    return inventory.mcpServers.map((server) => {
      const transport = server.transport === "unknown" ? null : server.transport.toUpperCase();
      const origin: ClaudeCliMcpOrigin = server.origin === "plugin" ? "plugin" : server.origin === "project" ? "project" : "claude_home";
      return {
        name: server.name,
        origin,
        target: server.target ? redactCliTarget(server.target) : "",
        transport,
        status: "unknown" as const,
        statusText: "",
        pluginId: null,
        removable: origin === "claude_home",
        supportsLogin: transport === "HTTP" || transport === "SSE",
      };
    });
  }

  async function listMcp(companyId: string): Promise<ClaudeCliMcpListResponse> {
    const home = await ensureHome(companyId);
    try {
      const result = await run(companyId, ["mcp", "list"]);
      if (result.exitCode !== 0) {
        return {
          servers: await fallbackMcpServers(home),
          cliAvailable: true,
          error: cliErrorMessage(result, "claude mcp list failed"),
        };
      }
      const installedIds = (await readInstalledFromFiles(home)).map((plugin) => plugin.id);
      return { servers: parseMcpList(result.stdout, installedIds), cliAvailable: true, error: null };
    } catch (error) {
      if (!isUnavailable(error)) throw error;
      return {
        servers: await fallbackMcpServers(home),
        cliAvailable: false,
        error: (error as HttpError).message,
      };
    }
  }

  async function addMcp(companyId: string, name: string, config: unknown): Promise<ClaudeCliMcpListResponse> {
    assertValidCliMcpName(name);
    if (name.startsWith("plugin:")) throw badRequest("Names starting with plugin: are reserved for plugin servers");
    const json = JSON.stringify(buildMcpAddJsonConfig(config));
    await runLocked(companyId, ["mcp", "add-json", name, json, "--scope", "user"]);
    return listMcp(companyId);
  }

  async function removeMcp(companyId: string, name: string): Promise<ClaudeCliMcpListResponse> {
    assertValidCliMcpName(name);
    if (name.startsWith("plugin:")) throw badRequest("This server is managed by a plugin; uninstall or disable the plugin");
    await runLocked(companyId, ["mcp", "remove", name, "--scope", "user"]);
    return listMcp(companyId);
  }

  async function logoutMcp(companyId: string, name: string): Promise<ClaudeCliMcpListResponse> {
    assertValidCliMcpName(name, { allowClaudeAi: true });
    await runLocked(companyId, ["mcp", "logout", name]);
    return listMcp(companyId);
  }

  // ---- login sessions ------------------------------------------------------

  const completing = new Set<string>();

  function sessionKey(companyId: string, name: string) {
    return `${companyId}\u0000${name}`;
  }

  async function startLogin(companyId: string, name: string): Promise<ClaudeCliLoginStartResponse> {
    assertValidCliMcpName(name, { allowClaudeAi: true });
    for (const session of [...loginSessions.values()]) {
      if (sessionKey(session.companyId, session.name) === sessionKey(companyId, name)) dropSession(session);
    }
    const home = await ensureHome(companyId);
    const child = await spawnCli(home, ["mcp", "login", name, "--no-browser"]);
    const stdout = new OutputCollector();
    const stderr = new OutputCollector();
    const exit = new Promise<number>((resolve) => child.once("close", (code) => resolve(code ?? 1)));
    const authUrl = await new Promise<string | null>((resolve) => {
      let done = false;
      const finish = (value: string | null) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(value);
      };
      const inspect = () => {
        const match = /https:\/\/[^\s"'<>]+/.exec(stripAnsi(`${stdout.text()}\n${stderr.text()}`));
        if (match) finish(match[0].replace(/[.,;)\]]+$/, ""));
      };
      child.stdout.on("data", (chunk: Buffer) => {
        stdout.add(chunk);
        inspect();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr.add(chunk);
        inspect();
      });
      const timer = setTimeout(() => finish(null), loginUrlWaitMs);
      void exit.then(() => {
        inspect();
        finish(null);
      });
    });
    if (!authUrl) {
      killChild(child);
      const code = child.exitCode;
      throw unprocessable(
        cliErrorMessage(
          { exitCode: code ?? 1, stdout: stdout.text(), stderr: stderr.text() },
          "claude mcp login did not print a sign-in URL",
        ),
      );
    }
    const session: LoginSession = {
      id: randomUUID(),
      companyId,
      name,
      child,
      exit,
      stdout,
      stderr,
      timer: setTimeout(() => dropSession(session), loginTtlMs),
    };
    session.timer.unref?.();
    loginSessions.set(session.id, session);
    void exit.then(() => {
      // A login that exits on its own (e.g. already authorised) is no longer completable.
      if (loginSessions.get(session.id) === session && !completing.has(session.id)) dropSession(session);
    });
    return { sessionId: session.id, authUrl };
  }

  function sessionFor(companyId: string, sessionId: string): LoginSession {
    const session = loginSessions.get(sessionId);
    if (!session || session.companyId !== companyId) throw notFound("Sign-in session not found or expired");
    return session;
  }

  async function completeLogin(
    companyId: string,
    sessionId: string,
    redirectUrl: unknown,
  ): Promise<{ name: string; response: ClaudeCliMcpListResponse }> {
    const url = assertValidRedirectUrl(redirectUrl);
    const session = sessionFor(companyId, sessionId);
    completing.add(session.id);
    try {
      const exitCode = await withCompanyLock(companyId, async () => {
        session.child.stdin.write(`${url}\n`);
        let timer: NodeJS.Timeout | undefined;
        const timeout = new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), LOGIN_COMPLETE_WAIT_MS);
        });
        const code = await Promise.race([session.exit, timeout]);
        clearTimeout(timer);
        return code;
      });
      if (exitCode === null) throw unprocessable("claude mcp login did not finish within 60s");
      if (exitCode !== 0) {
        throw unprocessable(
          cliErrorMessage(
            { exitCode, stdout: session.stdout.text(), stderr: session.stderr.text() },
            "claude mcp login failed",
          ),
        );
      }
    } finally {
      completing.delete(session.id);
      dropSession(session);
    }
    return { name: session.name, response: await listMcp(companyId) };
  }

  function cancelLogin(companyId: string, sessionId: string): string | null {
    const session = loginSessions.get(sessionId);
    if (!session || session.companyId !== companyId) return null;
    dropSession(session);
    return session.name;
  }

  // ---- marketplaces --------------------------------------------------------

  async function marketplacesFromFiles(home: string): Promise<ClaudeCliMarketplace[]> {
    const known = await readJsonOrNull(path.join(home, "plugins", "known_marketplaces.json"));
    const names = new Set<string>(await marketplaceDirs(home));
    const records = isPlainObject(known) ? known : {};
    for (const name of Object.keys(records)) if (MARKETPLACE_NAME_PATTERN.test(name)) names.add(name);
    const out: ClaudeCliMarketplace[] = [];
    for (const name of [...names].sort((a, b) => a.localeCompare(b))) {
      const record = isPlainObject(records[name]) ? (records[name] as Record<string, unknown>) : {};
      const source = isPlainObject(record.source) ? record.source : {};
      out.push(await toMarketplace(home, { name, source: source.source, repo: source.repo, url: source.url, path: source.path }));
    }
    return out;
  }

  async function toMarketplace(home: string, entry: Record<string, unknown>): Promise<ClaudeCliMarketplace> {
    const name = asString(entry.name) ?? "";
    const location = asString(entry.repo) ?? asString(entry.url) ?? asString(entry.path) ?? null;
    const catalog = MARKETPLACE_NAME_PATTERN.test(name) ? await readCatalog(home, name) : null;
    return {
      name,
      source: asString(entry.source) ?? "unknown",
      location: location ? (/^https?:\/\//i.test(location) ? redactUrl(location) : location) : null,
      pluginCount: catalog ? catalog.filter((plugin) => asString(plugin.name)).length : null,
    };
  }

  async function listMarketplaces(companyId: string): Promise<ClaudeCliMarketplacesResponse> {
    const home = await ensureHome(companyId);
    try {
      const result = await runOk(companyId, ["plugin", "marketplace", "list", "--json"]);
      const parsed = parseJsonArray(result.stdout) ?? [];
      const marketplaces = await Promise.all(parsed.filter(isPlainObject).map((entry) => toMarketplace(home, entry)));
      return { marketplaces: marketplaces.filter((entry) => entry.name), cliAvailable: true };
    } catch (error) {
      if (!isUnavailable(error)) throw error;
      return { marketplaces: await marketplacesFromFiles(home), cliAvailable: false };
    }
  }

  async function addMarketplace(companyId: string, source: unknown): Promise<{ source: string; response: ClaudeCliMarketplacesResponse }> {
    const value = assertValidMarketplaceSource(source);
    await runLocked(companyId, ["plugin", "marketplace", "add", value], { timeoutMs: CLAUDE_CLI_LONG_TIMEOUT_MS });
    return { source: value, response: await listMarketplaces(companyId) };
  }

  async function removeMarketplace(companyId: string, name: string): Promise<ClaudeCliMarketplacesResponse> {
    assertValidMarketplaceName(name);
    await runLocked(companyId, ["plugin", "marketplace", "remove", name]);
    return listMarketplaces(companyId);
  }

  async function updateMarketplaces(companyId: string, name?: unknown): Promise<ClaudeCliMarketplacesResponse> {
    const args = ["plugin", "marketplace", "update"];
    if (name !== undefined && name !== null && name !== "") {
      assertValidMarketplaceName(name as string);
      args.push(name as string);
    }
    await runLocked(companyId, args, { timeoutMs: CLAUDE_CLI_LONG_TIMEOUT_MS });
    return listMarketplaces(companyId);
  }

  // ---- plugins -------------------------------------------------------------

  async function pluginAction(
    companyId: string,
    action: "install" | "uninstall" | "enable" | "disable" | "update",
    id: string,
  ): Promise<ClaudeCliPluginsResponse> {
    assertValidPluginId(id);
    const timeoutMs = action === "install" || action === "update" ? CLAUDE_CLI_LONG_TIMEOUT_MS : CLAUDE_CLI_DEFAULT_TIMEOUT_MS;
    await runLocked(companyId, ["plugin", action, id], { timeoutMs });
    return getPlugins(companyId);
  }

  async function pluginDetails(companyId: string, id: string): Promise<ClaudeCliPluginDetailsResponse> {
    assertValidPluginId(id);
    const result = await runOk(companyId, ["plugin", "details", id]);
    return { text: redactCliText(stripAnsi(result.stdout).trim()) };
  }

  return {
    homeDirFor,
    run,
    listMcp,
    addMcp,
    removeMcp,
    logoutMcp,
    startLogin,
    completeLogin,
    cancelLogin,
    listMarketplaces,
    addMarketplace,
    removeMarketplace,
    updateMarketplaces,
    getPlugins,
    pluginAction,
    pluginDetails,
  };
}
