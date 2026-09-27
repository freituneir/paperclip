/**
 * Terminal-parity management of Claude Code MCP servers and plugins. The server
 * drives the real `claude` CLI against the company Claude Home; these are the
 * API shapes. See doc/plans/2026-09-27-claude-cli-parity.md.
 */

export type ClaudeCliMcpOrigin = "claude_home" | "plugin" | "claude_ai" | "project";

export type ClaudeCliMcpStatus = "connected" | "failed" | "needs_auth" | "pending_approval" | "unknown";

export interface ClaudeCliMcpServer {
  name: string;
  origin: ClaudeCliMcpOrigin;
  /** URL without query string, or the stdio command line (secrets redacted). */
  target: string;
  /** Upper-case transport as the CLI prints it (HTTP, SSE, STDIO, ...), or null. */
  transport: string | null;
  status: ClaudeCliMcpStatus;
  /** The CLI's status text, e.g. "Failed to connect — ECONNREFUSED". */
  statusText: string;
  /** Plugin id for origin "plugin" (e.g. "linear@claude-plugins-official"). */
  pluginId?: string | null;
  /** Whether Paperclip can remove it (false for plugin / claude.ai servers). */
  removable: boolean;
  /** Whether OAuth sign-in applies (http/sse and claude.ai connectors). */
  supportsLogin: boolean;
}

export interface ClaudeCliMcpListResponse {
  servers: ClaudeCliMcpServer[];
  cliAvailable: boolean;
  error?: string | null;
}

export interface ClaudeCliLoginStartResponse {
  sessionId: string;
  authUrl: string;
}

export interface ClaudeCliMarketplace {
  name: string;
  /** e.g. "github", "git", "url". */
  source: string;
  /** Repo ("owner/repo"), URL, or path as the CLI reports it. */
  location: string | null;
  pluginCount: number | null;
}

export interface ClaudeCliMarketplacesResponse {
  marketplaces: ClaudeCliMarketplace[];
  cliAvailable: boolean;
}

export interface ClaudeCliInstalledPlugin {
  /** "name@marketplace". */
  id: string;
  version: string | null;
  scope: string | null;
  enabled: boolean;
  installedAt: string | null;
  lastUpdated: string | null;
}

export interface ClaudeCliAvailablePlugin {
  /** "name@marketplace". */
  id: string;
  name: string;
  marketplace: string;
  displayName: string | null;
  description: string | null;
  category: string | null;
  tags: string[];
  author: string | null;
  homepage: string | null;
  version: string | null;
  installed: boolean;
}

export interface ClaudeCliPluginsResponse {
  installed: ClaudeCliInstalledPlugin[];
  available: ClaudeCliAvailablePlugin[];
  cliAvailable: boolean;
}

export interface ClaudeCliPluginDetailsResponse {
  text: string;
}
