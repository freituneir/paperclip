import type {
  ClaudeCliLoginStartResponse,
  ClaudeCliMarketplace,
  ClaudeCliMarketplacesResponse,
  ClaudeCliMcpListResponse,
  ClaudeCliMcpServer,
  ClaudeCliPluginDetailsResponse,
  ClaudeCliPluginsResponse,
  ClaudeHomeInventory,
} from "@paperclipai/shared";
import { api } from "./client";

const base = (companyId: string) => `/companies/${companyId}/claude-home`;
const seg = (value: string) => encodeURIComponent(value);

/** Board-only editing API for the company's shared Claude Code config (CLAUDE_CONFIG_DIR). */
export const claudeHomeApi = {
  get: (companyId: string) =>
    api.get<ClaudeHomeInventory>(base(companyId)),
  updateSettings: (companyId: string, settings: Record<string, unknown>) =>
    api.put<ClaudeHomeInventory>(`${base(companyId)}/settings`, { settings }),
  updateClaudeMd: (companyId: string, content: string) =>
    api.put<ClaudeHomeInventory>(`${base(companyId)}/claude-md`, { content }),
  upsertMcpServer: (companyId: string, name: string, config: Record<string, unknown>) =>
    api.put<ClaudeHomeInventory>(`${base(companyId)}/mcp-servers/${seg(name)}`, { config }),
  deleteMcpServer: (companyId: string, name: string) =>
    api.delete<ClaudeHomeInventory>(`${base(companyId)}/mcp-servers/${seg(name)}`),

  // --- Terminal parity: the server runs the real `claude` CLI against this home. ---
  // See doc/plans/2026-09-27-claude-cli-parity.md.

  /** `claude mcp list`, including health checks (can take a few seconds). */
  listMcp: (companyId: string) =>
    api.get<ClaudeCliMcpListResponse>(`${base(companyId)}/mcp`),
  addMcp: (companyId: string, name: string, config: Record<string, unknown>) =>
    api.post<{ servers: ClaudeCliMcpServer[] }>(`${base(companyId)}/mcp`, { name, config }),
  removeMcp: (companyId: string, name: string) =>
    api.delete<{ servers: ClaudeCliMcpServer[] }>(`${base(companyId)}/mcp/${seg(name)}`),
  startMcpLogin: (companyId: string, name: string) =>
    api.post<ClaudeCliLoginStartResponse>(`${base(companyId)}/mcp/${seg(name)}/login`, {}),
  completeMcpLogin: (companyId: string, sessionId: string, redirectUrl: string) =>
    api.post<{ servers: ClaudeCliMcpServer[] }>(
      `${base(companyId)}/mcp/login/${seg(sessionId)}/complete`,
      { redirectUrl },
    ),
  cancelMcpLogin: (companyId: string, sessionId: string) =>
    api.delete<void>(`${base(companyId)}/mcp/login/${seg(sessionId)}`),
  logoutMcp: (companyId: string, name: string) =>
    api.post<{ servers: ClaudeCliMcpServer[] }>(`${base(companyId)}/mcp/${seg(name)}/logout`, {}),

  listMarketplaces: (companyId: string) =>
    api.get<ClaudeCliMarketplacesResponse>(`${base(companyId)}/marketplaces`),
  addMarketplace: (companyId: string, source: string) =>
    api.post<{ marketplaces: ClaudeCliMarketplace[] }>(`${base(companyId)}/marketplaces`, { source }),
  removeMarketplace: (companyId: string, name: string) =>
    api.delete<{ marketplaces: ClaudeCliMarketplace[] }>(`${base(companyId)}/marketplaces/${seg(name)}`),
  /** Updates one marketplace, or all of them when `name` is omitted. */
  updateMarketplaces: (companyId: string, name?: string) =>
    api.post<{ marketplaces: ClaudeCliMarketplace[] }>(
      `${base(companyId)}/marketplaces/update`,
      name ? { name } : {},
    ),

  listPlugins: (companyId: string) =>
    api.get<ClaudeCliPluginsResponse>(`${base(companyId)}/plugins`),
  installPlugin: (companyId: string, id: string) =>
    api.post<ClaudeCliPluginsResponse>(`${base(companyId)}/plugins/install`, { id }),
  setPluginEnabled: (companyId: string, id: string, enabled: boolean) =>
    api.post<ClaudeCliPluginsResponse>(
      `${base(companyId)}/plugins/${seg(id)}/${enabled ? "enable" : "disable"}`,
      {},
    ),
  updatePlugin: (companyId: string, id: string) =>
    api.post<ClaudeCliPluginsResponse>(`${base(companyId)}/plugins/${seg(id)}/update`, {}),
  uninstallPlugin: (companyId: string, id: string) =>
    api.delete<ClaudeCliPluginsResponse>(`${base(companyId)}/plugins/${seg(id)}`),
  pluginDetails: (companyId: string, id: string) =>
    api.get<ClaudeCliPluginDetailsResponse>(`${base(companyId)}/plugins/${seg(id)}/details`),
};
