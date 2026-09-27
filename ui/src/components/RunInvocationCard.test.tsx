// @vitest-environment node

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ThemeProvider } from "../context/ThemeContext";
import { RunInvocationCard } from "../pages/AgentDetail";

describe("RunInvocationCard", () => {
  it("keeps verbose invocation details collapsed by default", () => {
    const html = renderToStaticMarkup(
      <ThemeProvider>
        <RunInvocationCard
          payload={{
            adapterType: "claude_local",
            cwd: "/tmp/workspace",
            command: "claude",
            commandArgs: ["--dangerously-skip-permissions"],
            commandNotes: ["Prompt is piped to claude via stdin."],
            prompt: "very long prompt body",
            context: { triggeredBy: "board" },
            env: { ANTHROPIC_API_KEY: "***REDACTED***" },
          }}
          censorUsernameInLogs={false}
        />
      </ThemeProvider>,
    );

    expect(html).toContain("Invocation");
    expect(html).toContain("Adapter:");
    expect(html).toContain("Working dir:");
    expect(html).toContain("Details");
    expect(html).not.toContain("Command:");
    expect(html).not.toContain("Prompt is piped to claude via stdin.");
    expect(html).not.toContain("very long prompt body");
    expect(html).not.toContain("ANTHROPIC_API_KEY");
    expect(html).not.toContain("triggeredBy");
  });
  it("renders the launch manifest with the run session takeover command", () => {
    const html = renderToStaticMarkup(
      <ThemeProvider>
        <RunInvocationCard
          payload={{
            adapterType: "claude_local",
            launchManifest: {
              version: 1,
              engine: "cli",
              model: "opus",
              fallbackModel: null,
              effort: null,
              permission: { mode: "auto", source: "claudePermissionMode" },
              claudeHome: { mode: "company", dir: "/data/claude-home" },
              settingSources: ["user"],
              settingsOverlayKeys: [],
              nativeMcp: "enabled",
              mcpServers: [],
              plugins: [],
              skills: [],
              subagents: [],
              commands: [],
              hooks: [],
              instructions: { path: null, delivery: "none" },
              allowedTools: [],
              disallowedTools: [],
              extraArgs: [],
              cwd: "/tmp/workspace",
              warnings: [],
            },
          }}
          censorUsernameInLogs={false}
          sessionId="sess-9"
        />
      </ThemeProvider>,
    );

    expect(html).toContain("Launch manifest");
    expect(html).toContain("claude --resume sess-9");
  });
});
