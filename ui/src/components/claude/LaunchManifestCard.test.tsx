import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ClaudeLaunchManifest } from "@paperclipai/shared";
import {
  LaunchManifestCard,
  UNGOVERNED_MCP_LEGEND,
  buildTakeoverCommand,
  shellQuote,
} from "./LaunchManifestCard";

function makeManifest(overrides: Partial<ClaudeLaunchManifest> = {}): ClaudeLaunchManifest {
  return {
    version: 1,
    engine: "cli",
    model: "claude-opus-5-5",
    fallbackModel: "claude-sonnet-5",
    effort: "high",
    permission: { mode: "bypassPermissions", source: "dangerouslySkipPermissions" },
    claudeHome: { mode: "company", dir: "/paperclip/instances/default/claude-home/company-1" },
    settingSources: ["user", "project"],
    settingsOverlayKeys: [],
    nativeMcp: "enabled",
    mcpServers: [
      { name: "paperclip", origin: "paperclip", transport: "http", target: "http://localhost:3100/mcp", governed: true },
      { name: "linear", origin: "claude_home", transport: "http", target: "https://mcp.linear.app/mcp", governed: false },
    ],
    plugins: [{ name: "superpowers", description: "enabled", origin: "plugin" }],
    skills: [{ name: "paperclip", origin: "paperclip" }],
    subagents: [],
    commands: [],
    hooks: [{ event: "PreToolUse", count: 2 }],
    instructions: { path: null, delivery: "none" },
    allowedTools: [],
    disallowedTools: [],
    extraArgs: [],
    cwd: "/workspace/project",
    warnings: [],
    ...overrides,
  };
}

describe("LaunchManifestCard", () => {
  it("shows chips, governed and ungoverned MCP badges, and the native legend", () => {
    const html = renderToStaticMarkup(<LaunchManifestCard manifest={makeManifest()} />);
    expect(html).toContain("claude-opus-5-5");
    expect(html).toContain("fallback: claude-sonnet-5");
    expect(html).toContain("bypassPermissions");
    expect(html).toContain('data-origin="paperclip"');
    expect(html).toContain('data-origin="claude_home"');
    expect(html).toContain("Paperclip · governed");
    expect(html).toContain(UNGOVERNED_MCP_LEGEND);
    expect(html).toContain("Plugins");
    expect(html).toContain("Hooks");
    expect(html).toContain("user, project");
  });

  it("omits the native legend when every server is governed", () => {
    const manifest = makeManifest({
      mcpServers: [{ name: "paperclip", origin: "paperclip", transport: "http", target: null, governed: true }],
    });
    const html = renderToStaticMarkup(<LaunchManifestCard manifest={manifest} />);
    expect(html).not.toContain(UNGOVERNED_MCP_LEGEND);
  });

  it("renders warnings", () => {
    const html = renderToStaticMarkup(
      <LaunchManifestCard manifest={makeManifest({ warnings: ["Native MCP server x has no target"] })} />,
    );
    expect(html).toContain("Warnings");
    expect(html).toContain("Native MCP server x has no target");
  });

  it("shows the takeover command only with session, cwd, company mode and dir", () => {
    const withAll = renderToStaticMarkup(<LaunchManifestCard manifest={makeManifest()} sessionId="sess-123" />);
    expect(withAll).toContain("claude --resume sess-123");
    expect(withAll).toContain("Continue this session in real Claude Code on the Paperclip host");

    const cases: Array<[ClaudeLaunchManifest, string | null]> = [
      [makeManifest(), null],
      [makeManifest({ cwd: null }), "sess-123"],
      [makeManifest({ claudeHome: { mode: "isolated", dir: "/tmp/x" } }), "sess-123"],
      [makeManifest({ claudeHome: { mode: "company", dir: null } }), "sess-123"],
    ];
    for (const [manifest, sessionId] of cases) {
      const html = renderToStaticMarkup(<LaunchManifestCard manifest={manifest} sessionId={sessionId} />);
      expect(html).not.toContain("claude --resume");
      expect(html).not.toContain("Continue this session");
    }
  });

  it("falls back to the manifest session id", () => {
    expect(buildTakeoverCommand(makeManifest({ sessionId: "from-manifest" }))).toContain("--resume from-manifest");
  });

  it("escapes single quotes in paths", () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
    const command = buildTakeoverCommand(
      makeManifest({ cwd: "/work/o'brien", claudeHome: { mode: "company", dir: "/home/it's" } }),
      "sess-1",
    );
    expect(command).toBe(`cd '/work/o'\\''brien' && CLAUDE_CONFIG_DIR='/home/it'\\''s' claude --resume sess-1`);
  });
});
