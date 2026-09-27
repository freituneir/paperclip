import fs from "node:fs/promises";
import path from "node:path";
import { parseObject, resolvePaperclipInstanceRootForAdapter } from "@paperclipai/adapter-utils/server-utils";
import { shellQuote } from "@paperclipai/adapter-utils/ssh";
import {
  CLAUDE_REDACTED_VALUE,
  type ClaudeCapabilityOrigin,
  type ClaudeHomeInventory,
  type ClaudeMcpServerSummary,
  type ClaudeNamedItem,
} from "@paperclipai/shared";

// The company Claude Home is a normal CLAUDE_CONFIG_DIR shared by the company's
// claude_local agents: settings.json, CLAUDE.md, .claude.json (user MCP
// servers), plugins/, skills/, agents/, commands/, projects/.

/** Object keys whose values are secrets: settings `env` and MCP `headers`/`env`. */
const SECRET_MAP_KEYS = new Set(["env", "headers"]);

/** Top-level settings keys that supply or refresh credentials outside a managed AI connection. */
const AUTH_CONFLICT_SETTINGS_KEYS = ["apiKeyHelper", "awsCredentialExport", "awsAuthRefresh"] as const;

/**
 * Settings `env` keys that would override a managed AI connection's
 * credential, provider routing, or transport (proxy / TLS).
 */
const AUTH_CONFLICT_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "ANTHROPIC_VERTEX_BASE_URL",
  "AWS_BEARER_TOKEN_BEDROCK",
  "ANTHROPIC_CUSTOM_HEADERS",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NODE_TLS_REJECT_UNAUTHORIZED",
] as const;

function nonEmpty(value: string | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function byName<T extends { name: string }>(a: T, b: T): number {
  return a.name.localeCompare(b.name);
}

export function resolveClaudeHomeDir(env: NodeJS.ProcessEnv, companyId: string): string {
  const id = companyId.trim();
  if (!id || id === "." || id === ".." || /[\\/]/.test(id)) {
    throw new Error(`Invalid company id for Claude Home: ${JSON.stringify(companyId)}`);
  }
  const root = nonEmpty(env.PAPERCLIP_CLAUDE_HOME_ROOT);
  if (root) return path.resolve(root, id);
  const instanceRoot = resolvePaperclipInstanceRootForAdapter({
    homeDir: nonEmpty(env.PAPERCLIP_HOME) ?? undefined,
    instanceId: nonEmpty(env.PAPERCLIP_INSTANCE_ID) ?? undefined,
    env,
  });
  return path.resolve(instanceRoot, "companies", id, "claude-home");
}

/** mkdir -p with mode 0o700. Cheap and idempotent. */
export async function ensureClaudeHomeDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
}

/**
 * Deep copy with secret values replaced by CLAUDE_REDACTED_VALUE: every value
 * of an `env` or `headers` object, at any depth (settings.env, MCP server
 * headers/env).
 */
export function redactClaudeSecrets<T>(value: T): T {
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (!isPlainObject(node)) return node;
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(node)) {
      out[key] = SECRET_MAP_KEYS.has(key) && isPlainObject(child)
        ? Object.fromEntries(Object.keys(child).map((name) => [name, CLAUDE_REDACTED_VALUE]))
        : walk(child);
    }
    return out;
  };
  return walk(value) as T;
}

/**
 * Deep: every CLAUDE_REDACTED_VALUE in `next` is replaced by the value at the
 * same path in `previous`. An object key whose placeholder has no previous
 * value is dropped, so the literal placeholder is never written as a secret.
 */
export function restoreRedactedSecrets(next: unknown, previous: unknown): unknown {
  if (next === CLAUDE_REDACTED_VALUE) return previous;
  if (Array.isArray(next)) {
    const prev = Array.isArray(previous) ? previous : [];
    return next
      .map((item, index) => restoreRedactedSecrets(item, prev[index]))
      .filter((item) => item !== undefined);
  }
  if (!isPlainObject(next)) return next;
  const prev = isPlainObject(previous) ? previous : {};
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(next)) {
    const restored = restoreRedactedSecrets(child, prev[key]);
    if (restored !== undefined) out[key] = restored;
  }
  return out;
}

/** Keys in a settings document that would override a managed AI connection. */
export function findHomeAuthConflicts(settings: Record<string, unknown> | null): string[] {
  if (!settings) return [];
  const conflicts: string[] = [];
  for (const key of AUTH_CONFLICT_SETTINGS_KEYS) {
    const value = settings[key];
    if (value !== undefined && value !== null && value !== "") conflicts.push(key);
  }
  const env = parseObject(settings.env);
  for (const key of AUTH_CONFLICT_ENV_KEYS) {
    const value = env[key];
    if (value !== undefined && value !== null && value !== "") conflicts.push(`env.${key}`);
  }
  return conflicts;
}

function stripUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return raw.split(/[?#]/)[0] ?? "";
  }
}

export function summarizeMcpServer(
  name: string,
  cfg: Record<string, unknown>,
  origin: ClaudeCapabilityOrigin,
): ClaudeMcpServerSummary {
  const type = typeof cfg.type === "string" ? cfg.type : "";
  const command = typeof cfg.command === "string" ? cfg.command : "";
  const url = typeof cfg.url === "string" ? cfg.url : "";
  const transport: ClaudeMcpServerSummary["transport"] =
    type === "http" || type === "sse" || type === "stdio"
      ? type
      : !type && command
        ? "stdio"
        : "unknown";
  let target: string | null = null;
  if (url) {
    target = stripUrl(url);
  } else if (command) {
    const argsCount = Array.isArray(cfg.args) ? cfg.args.length : 0;
    target = `${path.basename(command)} (${argsCount} args)`;
  }
  const summary: ClaudeMcpServerSummary = {
    name,
    origin,
    transport,
    target,
    governed: origin === "paperclip",
  };
  if (isPlainObject(cfg.headers)) summary.headerKeys = Object.keys(cfg.headers).sort();
  if (isPlainObject(cfg.env)) summary.envKeys = Object.keys(cfg.env).sort();
  return summary;
}

type JsonFileResult =
  | { status: "missing" }
  | { status: "ok"; value: Record<string, unknown> }
  | { status: "error"; error: string };

async function readJsonObjectFile(filePath: string): Promise<JsonFileResult> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing" };
    return { status: "error", error: errorMessage(error) };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isPlainObject(parsed)) return { status: "error", error: "Expected a JSON object" };
    return { status: "ok", value: parsed };
  } catch (error) {
    return { status: "error", error: errorMessage(error) };
  }
}

async function readTextFile(filePath: string): Promise<string | null> {
  return fs.readFile(filePath, "utf8").catch(() => null);
}

function summarizeMcpServers(
  servers: unknown,
  origin: ClaudeCapabilityOrigin,
): ClaudeMcpServerSummary[] {
  if (!isPlainObject(servers)) return [];
  return Object.entries(servers)
    .filter((entry): entry is [string, Record<string, unknown>] => isPlainObject(entry[1]))
    .map(([name, cfg]) => summarizeMcpServer(name, cfg, origin))
    .sort(byName);
}

/**
 * Auth conflicts in the project settings Claude loads from the run cwd
 * (`.claude/settings.json`, `.claude/settings.local.json`). Missing or
 * malformed files are skipped. Paperclip's own ACP engine writes only
 * permissions into settings.local.json, which never conflicts.
 */
export async function findProjectSettingsAuthConflicts(
  cwd: string,
): Promise<{ file: string; conflicts: string[] }[]> {
  const found: { file: string; conflicts: string[] }[] = [];
  for (const name of ["settings.json", "settings.local.json"]) {
    const file = path.join(cwd, ".claude", name);
    const result = await readJsonObjectFile(file);
    if (result.status !== "ok") continue;
    const conflicts = findHomeAuthConflicts(result.value);
    if (conflicts.length > 0) found.push({ file, conflicts });
  }
  return found;
}

/** Whether a Claude config dir holds a file-based login (`.credentials.json`). */
export async function claudeConfigDirHasCredentialsFile(dir: string): Promise<boolean> {
  return fs.access(path.join(dir, ".credentials.json")).then(() => true, () => false);
}

/** Servers from `<cwd>/.mcp.json`, origin "project". Missing or malformed files yield []. */
export async function readProjectMcpServers(cwd: string): Promise<ClaudeMcpServerSummary[]> {
  const result = await readJsonObjectFile(path.join(cwd, ".mcp.json"));
  return result.status === "ok" ? summarizeMcpServers(result.value.mcpServers, "project") : [];
}

/** Minimal YAML-ish frontmatter reader for `name` and `description`. */
function parseFrontmatter(contents: string): Record<string, string> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(contents);
  if (!match) return {};
  const fields: Record<string, string> = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const field = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!field) continue;
    fields[field[1]!] = field[2]!.trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  return fields;
}

async function listDir(dir: string) {
  return fs.readdir(dir, { withFileTypes: true }).catch(() => []);
}

async function readSkills(dir: string): Promise<ClaudeNamedItem[]> {
  const items: ClaudeNamedItem[] = [];
  for (const entry of await listDir(dir)) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const contents = await readTextFile(path.join(dir, entry.name, "SKILL.md"));
    if (contents === null) continue;
    const fields = parseFrontmatter(contents);
    items.push({ name: fields.name || entry.name, description: fields.description || null, origin: "claude_home" });
  }
  return items.sort(byName);
}

/** `*.md` files; nested directories are namespaced with ":" (as Claude Code does for commands). */
async function readMarkdownItems(dir: string, prefix = "", depth = 0): Promise<ClaudeNamedItem[]> {
  const items: ClaudeNamedItem[] = [];
  for (const entry of await listDir(dir)) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory() && depth < 3) {
      items.push(...(await readMarkdownItems(fullPath, `${prefix}${entry.name}:`, depth + 1)));
      continue;
    }
    if (!entry.name.endsWith(".md")) continue;
    const contents = await readTextFile(fullPath);
    if (contents === null) continue;
    const fields = parseFrontmatter(contents);
    const baseName = entry.name.slice(0, -".md".length);
    items.push({
      name: prefix ? `${prefix}${baseName}` : fields.name || baseName,
      description: fields.description || null,
      origin: "claude_home",
    });
  }
  return items.sort(byName);
}

/**
 * Hook counts per event. `count` is the number of inner hook entries across
 * all matcher groups (a group without a `hooks` array counts as zero).
 */
function summarizeHooks(settings: Record<string, unknown> | null): { event: string; count: number }[] {
  const hooks = parseObject(settings?.hooks);
  return Object.entries(hooks)
    .filter((entry): entry is [string, unknown[]] => Array.isArray(entry[1]))
    .map(([event, groups]) => ({
      event,
      count: groups.reduce<number>(
        (total, group) => total + (isPlainObject(group) && Array.isArray(group.hooks) ? group.hooks.length : 0),
        0,
      ),
    }))
    .sort((a, b) => a.event.localeCompare(b.event));
}

async function readPlugins(dir: string, settings: Record<string, unknown> | null): Promise<ClaudeNamedItem[]> {
  const enabled = parseObject(settings?.enabledPlugins);
  const names = new Set<string>(Object.keys(enabled));
  const installed = await readJsonObjectFile(path.join(dir, "plugins", "installed_plugins.json"));
  if (installed.status === "ok") {
    // Tolerate both `{ plugins: { "name@mkt": [...] } }` and `{ "name@mkt": ... }`.
    const source = isPlainObject(installed.value.plugins) ? installed.value.plugins : installed.value;
    for (const [name, value] of Object.entries(source)) {
      if (typeof value === "object" && value !== null) names.add(name);
    }
  }
  return [...names]
    .map((name) => ({
      name,
      description: enabled[name] === true ? "enabled" : "disabled",
      origin: "plugin" as const,
    }))
    .sort(byName);
}

/** Inventory of a Claude Home. Never throws: parse problems are reported per file. */
export async function readClaudeHomeInventory(dir: string): Promise<ClaudeHomeInventory> {
  const inventory: ClaudeHomeInventory = {
    dir,
    exists: false,
    settings: null,
    settingsParseError: null,
    claudeMd: null,
    mcpServers: [],
    mcpServerConfigs: {},
    mcpParseError: null,
    plugins: [],
    skills: [],
    subagents: [],
    commands: [],
    hooks: [],
    cliCommand: `CLAUDE_CONFIG_DIR=${shellQuote(dir)} claude`,
  };
  const stat = await fs.stat(dir).catch(() => null);
  if (!stat?.isDirectory()) return inventory;
  inventory.exists = true;

  const settingsFile = await readJsonObjectFile(path.join(dir, "settings.json"));
  const rawSettings = settingsFile.status === "ok" ? settingsFile.value : null;
  if (settingsFile.status === "error") inventory.settingsParseError = settingsFile.error;
  inventory.settings = rawSettings ? redactClaudeSecrets(rawSettings) : null;
  inventory.hooks = summarizeHooks(rawSettings);

  inventory.claudeMd = await readTextFile(path.join(dir, "CLAUDE.md"));

  const userConfig = await readJsonObjectFile(path.join(dir, ".claude.json"));
  if (userConfig.status === "error") inventory.mcpParseError = userConfig.error;
  if (userConfig.status === "ok") {
    const servers = parseObject(userConfig.value.mcpServers);
    inventory.mcpServers = summarizeMcpServers(servers, "claude_home");
    for (const [name, cfg] of Object.entries(servers)) {
      if (isPlainObject(cfg)) inventory.mcpServerConfigs[name] = redactClaudeSecrets(cfg);
    }
  }

  inventory.plugins = await readPlugins(dir, rawSettings);
  inventory.skills = await readSkills(path.join(dir, "skills"));
  inventory.subagents = await readMarkdownItems(path.join(dir, "agents"));
  inventory.commands = await readMarkdownItems(path.join(dir, "commands"));
  return inventory;
}
