import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Db } from "@paperclipai/db";
import {
  buildClaudeLaunchManifest,
  CLAUDE_HOME_SETTING_SOURCES,
  ensureClaudeHomeDir,
  parseClaudeNativeOptions,
  readClaudeHomeInventory,
  readProjectMcpServers,
  resolveClaudeExecutionEngine,
  resolveClaudeHomeDir,
  restoreRedactedSecrets,
} from "@paperclipai/adapter-claude-local/server";
import { readPaperclipSkillSyncPreference } from "@paperclipai/adapter-utils/server-utils";
import {
  CLAUDE_HOME_MCP_SERVER_NAME_PATTERN,
  isToolConnectionAttentionHealth,
  type ClaudeHomeInventory,
  type ClaudeLaunchManifest,
} from "@paperclipai/shared";
import { badRequest, notFound, unprocessable } from "../errors.js";
import { agentService } from "./agents.js";
import { toolAccessService } from "./tool-access.js";

// Company Claude Home: inventory and editing. Parsing, redaction and the
// manifest shape come from the claude_local adapter so there is one source of
// truth; this service only adds safe writes and the agent lookup.

const SETTINGS_FILE = "settings.json";
const CLAUDE_MD_FILE = "CLAUDE.md";
const USER_CONFIG_FILE = ".claude.json";
const MCP_TRANSPORTS = new Set(["http", "sse", "stdio"]);
const MCP_GATEWAY_TRANSPORTS = new Set(["mcp_remote", "local_stdio"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

type JsonObjectRead =
  | { status: "missing" }
  | { status: "ok"; value: Record<string, unknown> }
  | { status: "error"; error: string };

async function readJsonObject(filePath: string): Promise<JsonObjectRead> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing" };
    return { status: "error", error: error instanceof Error ? error.message : String(error) };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return isPlainObject(parsed) ? { status: "ok", value: parsed } : { status: "error", error: "Expected a JSON object" };
  } catch (error) {
    return { status: "error", error: error instanceof Error ? error.message : String(error) };
  }
}

/** Read a JSON object file for a write; a missing file is `{}`, a broken one is a 422 (never clobbered). */
async function readJsonObjectForWrite(filePath: string, label: string): Promise<Record<string, unknown>> {
  const result = await readJsonObject(filePath);
  if (result.status === "missing") return {};
  if (result.status === "error") {
    throw unprocessable(`${label} could not be parsed; fix or remove it before saving: ${result.error}`);
  }
  return result.value;
}

/** Write via a temp file in the same directory, then rename. */
async function writeFileAtomic(filePath: string, contents: string, mode: number): Promise<void> {
  const tmpPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(tmpPath, contents, { mode });
    await fs.chmod(tmpPath, mode);
    await fs.rename(tmpPath, filePath);
  } catch (error) {
    await fs.rm(tmpPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function writeJsonAtomic(filePath: string, value: Record<string, unknown>): Promise<void> {
  return writeFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`, 0o600);
}

export function assertValidMcpServerName(name: string): void {
  if (!CLAUDE_HOME_MCP_SERVER_NAME_PATTERN.test(name)) {
    throw badRequest("MCP server name must be 1-64 characters of letters, numbers, '_', '.' or '-'");
  }
}

/** Validate an MCP server config (after redacted values are restored). */
export function assertValidMcpServerConfig(config: Record<string, unknown>): void {
  const type = asTrimmedString(config.type);
  const command = asTrimmedString(config.command);
  const transport = type || (command ? "stdio" : "");
  if (!MCP_TRANSPORTS.has(transport)) {
    throw badRequest("MCP server type must be one of http, sse or stdio (or provide a command for stdio)");
  }
  if (transport === "stdio") {
    if (!command) throw badRequest("A stdio MCP server requires a command");
    if (config.args !== undefined && (!Array.isArray(config.args) || config.args.some((arg) => typeof arg !== "string"))) {
      throw badRequest("MCP server args must be an array of strings");
    }
  } else {
    const url = asTrimmedString(config.url);
    if (!url) throw badRequest(`An ${transport} MCP server requires a url`);
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("bad protocol");
    } catch {
      throw badRequest("MCP server url must be an http(s) URL");
    }
  }
  for (const key of ["headers", "env"] as const) {
    const value = config[key];
    if (value === undefined) continue;
    if (!isPlainObject(value) || Object.values(value).some((entry) => typeof entry !== "string")) {
      throw badRequest(`MCP server ${key} must be an object of string values`);
    }
  }
}

export interface ClaudeHomeServiceDeps {
  env?: NodeJS.ProcessEnv;
}

export function claudeHomeService(db: Db, deps: ClaudeHomeServiceDeps = {}) {
  const agents = agentService(db);
  const toolAccess = toolAccessService(db);
  const env = () => deps.env ?? process.env;

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

  async function getInventory(companyId: string): Promise<ClaudeHomeInventory> {
    return readClaudeHomeInventory(await ensureHome(companyId));
  }

  async function saveSettings(companyId: string, next: unknown): Promise<ClaudeHomeInventory> {
    if (!isPlainObject(next)) throw badRequest("settings must be a JSON object");
    const dir = await ensureHome(companyId);
    const filePath = path.join(dir, SETTINGS_FILE);
    const previous = await readJsonObjectForWrite(filePath, SETTINGS_FILE);
    const restored = restoreRedactedSecrets(next, previous);
    if (!isPlainObject(restored)) throw badRequest("settings must be a JSON object");
    await writeJsonAtomic(filePath, restored);
    return readClaudeHomeInventory(dir);
  }

  async function saveClaudeMd(companyId: string, text: string): Promise<ClaudeHomeInventory> {
    if (typeof text !== "string") throw badRequest("content must be a string");
    const dir = await ensureHome(companyId);
    await writeFileAtomic(path.join(dir, CLAUDE_MD_FILE), text, 0o644);
    return readClaudeHomeInventory(dir);
  }

  async function upsertMcpServer(
    companyId: string,
    name: string,
    config: unknown,
  ): Promise<{ inventory: ClaudeHomeInventory; created: boolean }> {
    assertValidMcpServerName(name);
    if (!isPlainObject(config)) throw badRequest("config must be a JSON object");
    const dir = await ensureHome(companyId);
    const filePath = path.join(dir, USER_CONFIG_FILE);
    const userConfig = await readJsonObjectForWrite(filePath, USER_CONFIG_FILE);
    const servers = isPlainObject(userConfig.mcpServers) ? userConfig.mcpServers : {};
    const previous = servers[name];
    const restored = restoreRedactedSecrets(config, previous);
    if (!isPlainObject(restored)) throw badRequest("config must be a JSON object");
    assertValidMcpServerConfig(restored);
    await writeJsonAtomic(filePath, { ...userConfig, mcpServers: { ...servers, [name]: restored } });
    return { inventory: await readClaudeHomeInventory(dir), created: previous === undefined };
  }

  async function deleteMcpServer(companyId: string, name: string): Promise<ClaudeHomeInventory> {
    assertValidMcpServerName(name);
    const dir = await ensureHome(companyId);
    const filePath = path.join(dir, USER_CONFIG_FILE);
    const userConfig = await readJsonObjectForWrite(filePath, USER_CONFIG_FILE);
    const servers = isPlainObject(userConfig.mcpServers) ? userConfig.mcpServers : {};
    if (!Object.prototype.hasOwnProperty.call(servers, name)) {
      throw notFound(`MCP server "${name}" not found in Claude Home`);
    }
    const { [name]: _removed, ...rest } = servers;
    await writeJsonAtomic(filePath, { ...userConfig, mcpServers: rest });
    return readClaudeHomeInventory(dir);
  }

  /** Names of the Paperclip-governed MCP entries the agent would get (read-only approximation of the run path). */
  async function paperclipMcpFor(companyId: string, agentId: string): Promise<{ name: string; url: string }[]> {
    const effective = await toolAccess.getEffectiveProfilesForAgent(companyId, agentId);
    const permitted = new Set<string>([
      ...effective.entries
        .filter((entry) => entry.effect === "include" && entry.connectionId)
        .map((entry) => entry.connectionId!),
      ...effective.allowedTools.map((tool) => tool.connectionId),
    ]);
    const assigned = effective.installedConnections
      .filter(
        (connection) =>
          permitted.has(connection.id) &&
          connection.status === "active" &&
          connection.enabled &&
          MCP_GATEWAY_TRANSPORTS.has(connection.transport) &&
          !isToolConnectionAttentionHealth(connection.healthStatus),
      )
      .map((connection) => connection.name)
      .sort((a, b) => a.localeCompare(b));
    // Run-time entries: "Paperclip projects" on task runs, "Paperclip
    // connections" when the run has a responsible user (claude_local delivers
    // runtime tools as native MCP), and one "paperclip-assigned" gateway that
    // carries every assigned connection.
    const servers = [
      { name: "Paperclip projects", url: "" },
      { name: "Paperclip connections", url: "" },
    ];
    if (assigned.length > 0) {
      servers.push({ name: "paperclip-assigned", url: "" });
      servers.push(...assigned.map((name) => ({ name, url: "" })));
    }
    return servers;
  }

  async function getAgentEffectiveSetup(companyId: string, agentId: string): Promise<ClaudeLaunchManifest> {
    const agent = await agents.getById(agentId);
    if (!agent || agent.companyId !== companyId) throw notFound("Agent not found");
    if (agent.adapterType !== "claude_local") {
      throw unprocessable("Effective Claude setup is only available for claude_local agents");
    }
    const config = isPlainObject(agent.adapterConfig) ? agent.adapterConfig : {};
    const options = parseClaudeNativeOptions(config);
    const engine = resolveClaudeExecutionEngine(config).engine;
    const homeActive = options.claudeHome === "company";

    let homeDir: string | null = null;
    let inventory: ClaudeHomeInventory | null = null;
    if (homeActive) {
      homeDir = homeDirFor(companyId);
      inventory = await readClaudeHomeInventory(homeDir);
    }

    const cwd = asTrimmedString(config.cwd) || null;
    const projectMcp = cwd && options.nativeMcp !== "disabled" ? await readProjectMcpServers(cwd) : [];

    const dangerouslySkipPermissions = config.dangerouslySkipPermissions !== false;
    const permission: ClaudeLaunchManifest["permission"] = options.permissionMode
      ? { mode: options.permissionMode, source: "claudePermissionMode" }
      : engine === "acp"
        ? { mode: dangerouslySkipPermissions ? "bypassPermissions" : "default", source: "acp_default" }
        : { mode: dangerouslySkipPermissions ? "bypassPermissions" : "default", source: "dangerouslySkipPermissions" };

    const instructionsPath = asTrimmedString(config.instructionsFilePath) || null;
    const instructionsDelivery: ClaudeLaunchManifest["instructions"]["delivery"] = !instructionsPath
      ? "none"
      : engine === "cli"
        ? "system_prompt_append"
        : "user_prompt_prefix";

    const extraArgs = Array.isArray(config.extraArgs)
      ? config.extraArgs.filter((arg): arg is string => typeof arg === "string")
      : [];
    const warnings: string[] = [];
    if (!homeActive) warnings.push("Claude Home is isolated for this agent; native Claude Code config is not loaded.");

    return buildClaudeLaunchManifest({
      engine,
      model: asTrimmedString(config.model) || null,
      effort: asTrimmedString(config.effort) || null,
      options,
      permission,
      homeDir,
      inventory,
      paperclipMcp: await paperclipMcpFor(companyId, agentId),
      projectMcp,
      paperclipSkills: readPaperclipSkillSyncPreference(config).desiredSkills,
      instructionsPath,
      instructionsDelivery,
      extraArgs,
      settingSources: [...CLAUDE_HOME_SETTING_SOURCES],
      cwd,
      warnings,
    });
  }

  return {
    homeDirFor,
    getInventory,
    saveSettings,
    saveClaudeMd,
    upsertMcpServer,
    deleteMcpServer,
    getAgentEffectiveSetup,
  };
}
