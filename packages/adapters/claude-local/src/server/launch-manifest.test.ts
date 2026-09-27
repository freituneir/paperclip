import { describe, expect, it } from "vitest";
import type { ClaudeHomeInventory } from "@paperclipai/shared";
import { buildClaudeLaunchManifest } from "./launch-manifest.js";
import { parseClaudeNativeOptions } from "./native-options.js";

function inventory(): ClaudeHomeInventory {
  return {
    dir: "/homes/c1",
    exists: true,
    settings: { hooks: {} },
    settingsParseError: null,
    claudeMd: null,
    mcpServers: [
      {
        name: "linear",
        origin: "claude_home",
        transport: "http",
        target: "https://mcp.linear.app/mcp",
        governed: false,
        headerKeys: ["Authorization"],
      },
    ],
    mcpServerConfigs: {},
    mcpParseError: null,
    plugins: [{ name: "alpha@market", description: "enabled", origin: "plugin" }],
    skills: [{ name: "native-skill", description: null, origin: "claude_home" }],
    subagents: [{ name: "researcher", description: null, origin: "claude_home" }],
    commands: [{ name: "deploy", description: null, origin: "claude_home" }],
    hooks: [{ event: "Stop", count: 1 }],
    cliCommand: "CLAUDE_CONFIG_DIR='/homes/c1' claude",
  };
}

function build(config: Record<string, unknown>, overrides: Partial<Parameters<typeof buildClaudeLaunchManifest>[0]> = {}) {
  return buildClaudeLaunchManifest({
    engine: "cli",
    model: "claude-opus-5-5",
    effort: "high",
    options: parseClaudeNativeOptions(config),
    permission: { mode: "bypassPermissions", source: "dangerouslySkipPermissions" },
    homeDir: "/homes/c1",
    inventory: inventory(),
    paperclipMcp: [{ name: "paperclip-github", url: "https://paperclip.local/mcp/abc?token=supersecret" }],
    projectMcp: [
      { name: "db", origin: "project", transport: "stdio", target: "db-mcp (0 args)", governed: false, envKeys: ["DB_PASSWORD"] },
    ],
    paperclipSkills: ["paperclip"],
    instructionsPath: "/agents/a/AGENTS.md",
    instructionsDelivery: "system_prompt_append",
    extraArgs: [],
    settingSources: ["user", "project", "local"],
    cwd: "/work",
    ...overrides,
  });
}

describe("buildClaudeLaunchManifest", () => {
  it("marks Paperclip servers governed and native servers ungoverned", () => {
    const manifest = build({});
    expect(manifest.version).toBe(1);
    expect(manifest.mcpServers).toEqual([
      {
        name: "paperclip-github",
        origin: "paperclip",
        transport: "http",
        target: "https://paperclip.local/mcp/abc",
        governed: true,
      },
      expect.objectContaining({ name: "linear", origin: "claude_home", governed: false }),
      expect.objectContaining({ name: "db", origin: "project", governed: false }),
    ]);
    expect(manifest.skills).toEqual([
      { name: "paperclip", origin: "paperclip" },
      { name: "native-skill", description: null, origin: "claude_home" },
    ]);
    expect(manifest.plugins).toHaveLength(1);
    expect(manifest.subagents).toHaveLength(1);
    expect(manifest.commands).toHaveLength(1);
    expect(manifest.hooks).toEqual([{ event: "Stop", count: 1 }]);
    expect(manifest.claudeHome).toEqual({ mode: "company", dir: "/homes/c1" });
    expect(manifest.nativeMcp).toBe("enabled");
    expect(manifest.warnings).toEqual([]);
  });

  it("never includes secret values or URL query strings", () => {
    const serialized = JSON.stringify(build({ settingsOverlay: { env: { SECRET: "hunter2" } } }));
    expect(serialized).not.toContain("supersecret");
    expect(serialized).not.toContain("token=");
    expect(serialized).not.toContain("hunter2");
    expect(serialized).not.toContain("Bearer");
  });

  it("excludes native MCP servers when nativeMcp is disabled", () => {
    const manifest = build({ nativeMcp: "disabled" });
    expect(manifest.mcpServers.map((server) => server.origin)).toEqual(["paperclip"]);
    expect(manifest.warnings).toContain("Native MCP servers disabled for this agent");
  });

  it("carries overlay keys, permission mode, and inventory parse warnings", () => {
    const inv = inventory();
    inv.settingsParseError = "Unexpected token";
    const manifest = build(
      { claudePermissionMode: "plan", settingsOverlay: { model: "opus" }, fallbackModel: "claude-sonnet-5" },
      { inventory: inv, permission: { mode: "plan", source: "claudePermissionMode" }, warnings: ["custom"] },
    );
    expect(manifest.settingsOverlayKeys).toEqual(["model", "permissions"]);
    expect(manifest.fallbackModel).toBe("claude-sonnet-5");
    expect(manifest.permission).toEqual({ mode: "plan", source: "claudePermissionMode" });
    expect(manifest.warnings).toEqual(["custom", "Claude Home settings.json could not be parsed: Unexpected token"]);
  });

  it("describes an isolated run without a home", () => {
    const manifest = build({ claudeHome: "isolated" }, { homeDir: null, inventory: null, projectMcp: [] });
    expect(manifest.claudeHome).toEqual({ mode: "isolated", dir: null });
    expect(manifest.mcpServers.map((server) => server.origin)).toEqual(["paperclip"]);
    expect(manifest.plugins).toEqual([]);
  });
});
