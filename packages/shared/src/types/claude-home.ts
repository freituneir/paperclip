// Claude Code transparency contract. A company-scoped "Claude Home" is a
// normal CLAUDE_CONFIG_DIR shared by the company's claude_local agents. These
// types describe its inventory and the per-run launch manifest, and each item
// carries an origin so the UI can tell native Claude Code capabilities
// (ungoverned) apart from Paperclip ones (gateway-governed).

export type ClaudeHomeMode = "company" | "isolated";
export type ClaudeNativeMcpMode = "enabled" | "disabled";
export const CLAUDE_PERMISSION_MODES = ["bypassPermissions", "auto", "acceptEdits", "dontAsk", "plan", "manual"] as const;
export type ClaudePermissionMode = (typeof CLAUDE_PERMISSION_MODES)[number];
export const CLAUDE_PERMISSION_BRIDGE_MODES = ["task_chat", "off"] as const;
export type ClaudePermissionBridgeMode = (typeof CLAUDE_PERMISSION_BRIDGE_MODES)[number];
export type ClaudePermissionBridgeState = ClaudePermissionBridgeMode | "unavailable";
export const CLAUDE_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export const CLAUDE_REDACTED_VALUE = "__redacted__";

export type ClaudeCapabilityOrigin = "paperclip" | "claude_home" | "project" | "plugin";

export interface ClaudeMcpServerSummary {
  name: string;
  origin: ClaudeCapabilityOrigin;
  transport: "http" | "sse" | "stdio" | "unknown";
  /** URL without query string, or command basename plus args count. */
  target: string | null;
  /** True only for origin "paperclip". */
  governed: boolean;
  headerKeys?: string[];
  envKeys?: string[];
}

export interface ClaudeNamedItem {
  name: string;
  description?: string | null;
  origin: ClaudeCapabilityOrigin;
}

export interface ClaudeHomeInventory {
  dir: string;
  exists: boolean;
  /** Redacted settings.json contents. */
  settings: Record<string, unknown> | null;
  settingsParseError: string | null;
  claudeMd: string | null;
  /** Servers from .claude.json, origin "claude_home". */
  mcpServers: ClaudeMcpServerSummary[];
  /** Redacted raw server configs, for editing. */
  mcpServerConfigs: Record<string, Record<string, unknown>>;
  mcpParseError: string | null;
  /** Origin "plugin"; description is "enabled" or "disabled". */
  plugins: ClaudeNamedItem[];
  skills: ClaudeNamedItem[];
  subagents: ClaudeNamedItem[];
  commands: ClaudeNamedItem[];
  hooks: { event: string; count: number }[];
  /** For example `CLAUDE_CONFIG_DIR='<dir>' claude`. */
  cliCommand: string;
}

export interface ClaudeLaunchManifest {
  version: 1;
  engine: "cli" | "acp";
  model: string | null;
  fallbackModel: string | null;
  effort: string | null;
  permission: {
    mode: string;
    source: "claudePermissionMode" | "dangerouslySkipPermissions" | "acp_default" | "remote_allowlist" | "permission_bridge";
    /**
     * Whether Claude Code `ask` rules become Paperclip approval cards.
     * "task_chat": bridged (ACP, local). "off": disabled by config, or the
     * engine/target cannot bridge (CLI engine, remote ACP). "unavailable": the
     * bridge needs bypassPermissions, which root outside a sandbox cannot use.
     */
    bridge?: ClaudePermissionBridgeState;
  };
  claudeHome: { mode: ClaudeHomeMode; dir: string | null };
  settingSources: string[];
  settingsOverlayKeys: string[];
  nativeMcp: ClaudeNativeMcpMode;
  mcpServers: ClaudeMcpServerSummary[];
  plugins: ClaudeNamedItem[];
  /** Paperclip-mounted (origin paperclip) plus native (claude_home). */
  skills: ClaudeNamedItem[];
  subagents: ClaudeNamedItem[];
  commands: ClaudeNamedItem[];
  hooks: { event: string; count: number }[];
  instructions: { path: string | null; delivery: "system_prompt_append" | "user_prompt_prefix" | "none" };
  allowedTools: string[];
  disallowedTools: string[];
  extraArgs: string[];
  /** Filled when known (takeover). */
  sessionId?: string | null;
  cwd?: string | null;
  warnings: string[];
}
