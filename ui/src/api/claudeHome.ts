import type { ClaudeHomeInventory } from "@paperclipai/shared";
import { api } from "./client";

/** Board-only editing API for the company's shared Claude Code config (CLAUDE_CONFIG_DIR). */
export const claudeHomeApi = {
  get: (companyId: string) =>
    api.get<ClaudeHomeInventory>(`/companies/${companyId}/claude-home`),
  updateSettings: (companyId: string, settings: Record<string, unknown>) =>
    api.put<ClaudeHomeInventory>(`/companies/${companyId}/claude-home/settings`, { settings }),
  updateClaudeMd: (companyId: string, content: string) =>
    api.put<ClaudeHomeInventory>(`/companies/${companyId}/claude-home/claude-md`, { content }),
  upsertMcpServer: (companyId: string, name: string, config: Record<string, unknown>) =>
    api.put<ClaudeHomeInventory>(
      `/companies/${companyId}/claude-home/mcp-servers/${encodeURIComponent(name)}`,
      { config },
    ),
  deleteMcpServer: (companyId: string, name: string) =>
    api.delete<ClaudeHomeInventory>(
      `/companies/${companyId}/claude-home/mcp-servers/${encodeURIComponent(name)}`,
    ),
};
