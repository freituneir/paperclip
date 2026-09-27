import {
  CLAUDE_HOME_MCP_SERVER_NAME_PATTERN,
  CLAUDE_REDACTED_VALUE,
  type ClaudeMcpServerSummary,
} from "@paperclipai/shared";

// Form model for a native Claude Code MCP server entry in the company Claude
// Home `.claude.json`. The server returns configs with secret header/env
// values replaced by CLAUDE_REDACTED_VALUE and restores them on write, so a
// row the operator leaves untouched must be sent back as the placeholder.

export type McpServerFormType = "http" | "sse" | "stdio";

export interface KeyValueRow {
  key: string;
  value: string;
  /** The stored value is a secret the server redacted; empty `value` keeps it. */
  redacted: boolean;
}

export interface McpServerForm {
  name: string;
  type: McpServerFormType;
  url: string;
  command: string;
  /** One argument per line. */
  args: string;
  headers: KeyValueRow[];
  env: KeyValueRow[];
}

export function emptyMcpServerForm(): McpServerForm {
  return { name: "", type: "http", url: "", command: "", args: "", headers: [], env: [] };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function rowsFrom(value: unknown): KeyValueRow[] {
  return Object.entries(asRecord(value)).map(([key, raw]) => {
    const redacted = raw === CLAUDE_REDACTED_VALUE;
    return { key, value: redacted ? "" : typeof raw === "string" ? raw : String(raw ?? ""), redacted };
  });
}

export function inferMcpServerType(config: Record<string, unknown>): McpServerFormType {
  const type = config.type;
  if (type === "http" || type === "sse" || type === "stdio") return type;
  if (typeof config.command === "string") return "stdio";
  return "http";
}

export function mcpServerFormFromConfig(name: string, config: Record<string, unknown>): McpServerForm {
  const args = Array.isArray(config.args) ? config.args.map((arg) => String(arg)) : [];
  return {
    name,
    type: inferMcpServerType(config),
    url: typeof config.url === "string" ? config.url : "",
    command: typeof config.command === "string" ? config.command : "",
    args: args.join("\n"),
    headers: rowsFrom(config.headers),
    env: rowsFrom(config.env),
  };
}

function rowsToRecord(rows: KeyValueRow[]): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const row of rows) {
    const key = row.key.trim();
    if (!key) continue;
    out[key] = row.redacted && row.value === "" ? CLAUDE_REDACTED_VALUE : row.value;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Build the config sent to `PUT .../mcp-servers/:name`. Keys the form doesn't
 * model (for example `oauth` or `timeout`) are carried over from `original`.
 */
export function mcpServerConfigFromForm(
  form: McpServerForm,
  original: Record<string, unknown> = {},
): Record<string, unknown> {
  const config: Record<string, unknown> = { ...original };
  delete config.url;
  delete config.command;
  delete config.args;
  delete config.headers;
  delete config.env;
  config.type = form.type;
  if (form.type === "stdio") {
    config.command = form.command.trim();
    const args = form.args.split("\n").map((arg) => arg.trim()).filter(Boolean);
    if (args.length > 0) config.args = args;
    const env = rowsToRecord(form.env);
    if (env) config.env = env;
  } else {
    config.url = form.url.trim();
    const headers = rowsToRecord(form.headers);
    if (headers) config.headers = headers;
  }
  return config;
}

/** Returns a user-facing problem with the form, or null when it can be saved. */
export function validateMcpServerForm(form: McpServerForm): string | null {
  if (!CLAUDE_HOME_MCP_SERVER_NAME_PATTERN.test(form.name.trim())) {
    return "Name must be 1-64 characters: letters, numbers, dots, dashes, or underscores.";
  }
  if (form.type === "stdio") {
    if (!form.command.trim()) return "A stdio server needs a command.";
    return null;
  }
  try {
    const url = new URL(form.url.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("protocol");
  } catch {
    return "Enter an http(s) URL for the server.";
  }
  return null;
}

/** Only remote servers can be adopted; Paperclip keeps imported stdio commands as drafts. */
export function isAdoptableMcpServer(server: Pick<ClaudeMcpServerSummary, "transport">): boolean {
  return server.transport === "http" || server.transport === "sse";
}

/** True when the redacted config hides a secret the adopt flow cannot copy. */
export function hasRedactedSecrets(config: Record<string, unknown>): boolean {
  return [asRecord(config.headers), asRecord(config.env)].some((record) =>
    Object.values(record).some((value) => value === CLAUDE_REDACTED_VALUE),
  );
}

/** Body for the existing `POST /tools/mcp/import-json` preview endpoint. */
export function adoptImportJson(name: string, config: Record<string, unknown>): string {
  return JSON.stringify({ mcpServers: { [name]: config } });
}

/** Header values known to the browser (not redacted), keyed by import config path. */
export function knownHeaderCredentialValues(config: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(asRecord(config.headers))) {
    if (typeof value === "string" && value && value !== CLAUDE_REDACTED_VALUE) out[`headers.${key}`] = value;
  }
  return out;
}
