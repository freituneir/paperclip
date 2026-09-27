import { z } from "zod";

// Request bodies for the board-only Claude Home editing API. Deeper checks
// (MCP transport, url/command presence) live in the server service so the
// error messages can name the offending server.

export const CLAUDE_HOME_MCP_SERVER_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;

export const claudeHomeSettingsUpdateSchema = z.object({
  settings: z.record(z.string(), z.unknown()),
});

export const claudeHomeClaudeMdUpdateSchema = z.object({
  content: z.string().max(1_000_000),
});

export const claudeHomeMcpServerUpsertSchema = z.object({
  config: z.record(z.string(), z.unknown()),
});

export type ClaudeHomeSettingsUpdate = z.infer<typeof claudeHomeSettingsUpdateSchema>;
export type ClaudeHomeClaudeMdUpdate = z.infer<typeof claudeHomeClaudeMdUpdateSchema>;
export type ClaudeHomeMcpServerUpsert = z.infer<typeof claudeHomeMcpServerUpsertSchema>;
