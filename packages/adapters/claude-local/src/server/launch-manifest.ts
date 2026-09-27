import type {
  ClaudeHomeInventory,
  ClaudeLaunchManifest,
  ClaudeMcpServerSummary,
  ClaudeNamedItem,
} from "@paperclipai/shared";
import { summarizeMcpServer } from "./claude-home.js";
import { settingsOverlayWithPermission, type ClaudeNativeOptions } from "./native-options.js";

export const NATIVE_MCP_DISABLED_WARNING = "Native MCP servers disabled for this agent";

/**
 * Describe what a Claude run gets and where each piece comes from. Pure: the
 * caller supplies the inventory and project servers. Secret values never
 * appear (MCP summaries carry key names only, URLs lose query strings, and the
 * settings overlay contributes only its top-level key names).
 */
export function buildClaudeLaunchManifest(input: {
  engine: "cli" | "acp";
  model: string | null;
  effort: string | null;
  options: ClaudeNativeOptions;
  permission: ClaudeLaunchManifest["permission"];
  homeDir: string | null;
  inventory: ClaudeHomeInventory | null;
  paperclipMcp: { name: string; url: string }[];
  projectMcp: ClaudeMcpServerSummary[];
  paperclipSkills: string[];
  instructionsPath: string | null;
  instructionsDelivery: ClaudeLaunchManifest["instructions"]["delivery"];
  extraArgs: string[];
  settingSources: string[];
  cwd: string | null;
  sessionId?: string | null;
  warnings?: string[];
}): ClaudeLaunchManifest {
  const { options, inventory } = input;
  const warnings = [...(input.warnings ?? [])];
  if (inventory?.settingsParseError) {
    warnings.push(`Claude Home settings.json could not be parsed: ${inventory.settingsParseError}`);
  }
  if (inventory?.mcpParseError) {
    warnings.push(`Claude Home .claude.json could not be parsed: ${inventory.mcpParseError}`);
  }

  // Paperclip servers authenticate with a run token header; it is never passed in.
  const mcpServers: ClaudeMcpServerSummary[] = input.paperclipMcp.map((server) =>
    summarizeMcpServer(server.name, { type: "http", url: server.url }, "paperclip"),
  );
  if (options.nativeMcp === "disabled") {
    warnings.push(NATIVE_MCP_DISABLED_WARNING);
  } else {
    mcpServers.push(...(inventory?.mcpServers ?? []), ...input.projectMcp);
  }

  const paperclipSkills: ClaudeNamedItem[] = input.paperclipSkills.map((name) => ({ name, origin: "paperclip" }));
  const overlay = settingsOverlayWithPermission(options);

  return {
    version: 1,
    engine: input.engine,
    model: input.model || null,
    fallbackModel: options.fallbackModel,
    effort: input.effort || null,
    permission: input.permission,
    claudeHome: { mode: options.claudeHome, dir: input.homeDir },
    settingSources: [...input.settingSources],
    settingsOverlayKeys: overlay ? Object.keys(overlay).sort() : [],
    nativeMcp: options.nativeMcp,
    mcpServers,
    plugins: [...(inventory?.plugins ?? [])],
    skills: [...paperclipSkills, ...(inventory?.skills ?? [])],
    subagents: [...(inventory?.subagents ?? [])],
    commands: [...(inventory?.commands ?? [])],
    hooks: [...(inventory?.hooks ?? [])],
    instructions: { path: input.instructionsPath, delivery: input.instructionsDelivery },
    allowedTools: [...options.allowedTools],
    disallowedTools: [...options.disallowedTools],
    extraArgs: [...input.extraArgs],
    ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
    cwd: input.cwd,
    warnings,
  };
}
