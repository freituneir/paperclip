import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AdapterExecutionContext, AdapterInvocationMeta } from "@paperclipai/adapter-utils";
import type { ClaudeLaunchManifest } from "@paperclipai/shared";
import { buildClaudeAcpConfig, createClaudeAcpExecutor } from "./acp.js";

const ENV_KEYS = ["PAPERCLIP_HOME", "PAPERCLIP_INSTANCE_ID", "PAPERCLIP_CLAUDE_HOME_ROOT", "CLAUDE_CONFIG_DIR"] as const;
const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
const tempRoots: string[] = [];

async function makeTempRoot(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

let paperclipHome = "";

beforeEach(async () => {
  paperclipHome = await makeTempRoot("paperclip-claude-acp-native-home-");
  delete process.env.PAPERCLIP_CLAUDE_HOME_ROOT;
  delete process.env.PAPERCLIP_INSTANCE_ID;
  process.env.PAPERCLIP_HOME = paperclipHome;
  // Keep credential seeding away from the developer's real ~/.claude.
  process.env.CLAUDE_CONFIG_DIR = path.join(paperclipHome, "host-claude");
});

afterEach(async () => {
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

function envOf(config: Record<string, unknown>): Record<string, unknown> {
  return (config.env ?? {}) as Record<string, unknown>;
}

describe("buildClaudeAcpConfig Claude Home + SDK options", () => {
  it("points ACP at the company Claude Home and carries native SDK options", () => {
    const built = buildClaudeAcpConfig(
      {
        claudeHome: "company",
        nativeMcp: "disabled",
        fallbackModel: "claude-sonnet-5",
        extraArgs: ["--foo", "1"],
      },
      {},
      { companyId: "c1", hasPaperclipMcp: true },
    );
    const env = envOf(built);
    expect(String(env.CLAUDE_CONFIG_DIR)).toMatch(/[\\/]c1[\\/]claude-home$/);
    expect(String(env.CLAUDE_CONFIG_DIR).startsWith(paperclipHome)).toBe(true);
    const sdk = JSON.parse(String(env.PAPERCLIP_CLAUDE_SDK_OPTIONS_JSON));
    expect(sdk).toMatchObject({
      strictMcpConfig: true,
      fallbackModel: "claude-sonnet-5",
      extraArgs: { foo: "1" },
      settingSources: ["user", "project", "local"],
    });
  });

  it("defaults to the company home and puts claudePermissionMode into settings.permissions.defaultMode", () => {
    const built = buildClaudeAcpConfig(
      { claudePermissionMode: "acceptEdits", settingsOverlay: { permissions: { allow: ["Bash(ls)"] } } },
      {},
      { companyId: "c1" },
    );
    const sdk = JSON.parse(String(envOf(built).PAPERCLIP_CLAUDE_SDK_OPTIONS_JSON));
    expect(sdk.settings).toEqual({ permissions: { allow: ["Bash(ls)"], defaultMode: "acceptEdits" } });
    expect(sdk.strictMcpConfig).toBeUndefined();
  });

  it("leaves isolated agents untouched", () => {
    const built = buildClaudeAcpConfig({ claudeHome: "isolated" }, {}, { companyId: "c1", hasPaperclipMcp: true });
    const env = envOf(built);
    expect(env).not.toHaveProperty("CLAUDE_CONFIG_DIR");
    expect(env).not.toHaveProperty("PAPERCLIP_CLAUDE_SDK_OPTIONS_JSON");
  });

  it("leaves remote targets untouched", () => {
    const built = buildClaudeAcpConfig(
      { claudeHome: "company", fallbackModel: "claude-sonnet-5" },
      {},
      { companyId: "c1", remote: true, hasPaperclipMcp: true },
    );
    const env = envOf(built);
    expect(env).not.toHaveProperty("CLAUDE_CONFIG_DIR");
    expect(env).not.toHaveProperty("PAPERCLIP_CLAUDE_SDK_OPTIONS_JSON");
  });

  it("does nothing without a company id (legacy callers)", () => {
    const env = envOf(buildClaudeAcpConfig({ claudeHome: "company" }, {}));
    expect(env).not.toHaveProperty("CLAUDE_CONFIG_DIR");
    expect(env).not.toHaveProperty("PAPERCLIP_CLAUDE_SDK_OPTIONS_JSON");
  });

  it("respects an operator CLAUDE_CONFIG_DIR unless the agent uses a managed AI connection", () => {
    const operator = buildClaudeAcpConfig(
      { env: { CLAUDE_CONFIG_DIR: "/operator/claude" } },
      {},
      { companyId: "c1" },
    );
    expect(envOf(operator).CLAUDE_CONFIG_DIR).toBe("/operator/claude");
    expect(envOf(operator)).not.toHaveProperty("PAPERCLIP_CLAUDE_SDK_OPTIONS_JSON");

    const managed = buildClaudeAcpConfig(
      { managedAiConnection: true, env: { CLAUDE_CONFIG_DIR: "/tmp/managed-run" } },
      {},
      { companyId: "c1" },
    );
    expect(String(envOf(managed).CLAUDE_CONFIG_DIR)).toMatch(/[\\/]c1[\\/]claude-home$/);
  });
});

class FakeRuntime {
  ensureCount = 0;
  async ensureSession(input: { sessionKey: string; cwd?: string }) {
    this.ensureCount += 1;
    return {
      sessionKey: input.sessionKey,
      backend: "acpx",
      runtimeSessionName: `runtime-${this.ensureCount}`,
      cwd: input.cwd,
      acpxRecordId: `record-${this.ensureCount}`,
      backendSessionId: `acp-${this.ensureCount}`,
      agentSessionId: `agent-${this.ensureCount}`,
    };
  }
  startTurn(input: { requestId: string }) {
    return {
      requestId: input.requestId,
      events: {
        [Symbol.asyncIterator]: async function* () {
          yield { type: "text_delta", text: "hello", stream: "output", tag: "agent_message_chunk" };
        },
      },
      result: Promise.resolve({ status: "completed", stopReason: "end_turn" }),
      cancel: async () => {},
      closeStream: async () => {},
    };
  }
  runTurn(): never {
    throw new Error("not used");
  }
  getCapabilities() {
    return { controls: [] };
  }
  getStatus() {
    return Promise.resolve({});
  }
  async setConfigOption() {}
  async setMode() {}
  async cancel() {}
  async close() {}
}

function buildContext(
  root: string,
  config: Record<string, unknown>,
  overrides: Partial<AdapterExecutionContext> = {},
): AdapterExecutionContext {
  return {
    runId: "run-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Claude ACP",
      adapterType: "claude_local",
      adapterConfig: {},
    },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: "PAP-1" },
    config: {
      engine: "acp",
      cwd: root,
      stateDir: path.join(root, "state"),
      promptTemplate: "Do the assigned work.",
      ...config,
    },
    context: {
      issueId: "issue-1",
      paperclipWorkspace: { cwd: root, source: "project_workspace", workspaceId: "workspace-1" },
    },
    onLog: async () => {},
    ...overrides,
  };
}

function homeDirFor(companyId: string): string {
  return path.join(paperclipHome, "instances", "default", "companies", companyId, "claude-home");
}

describe("createClaudeAcpExecutor Claude Home parity", () => {
  it("creates the Claude Home and reports a launch manifest for the ACP engine", async () => {
    const root = await makeTempRoot("paperclip-claude-acp-native-run-");
    const meta: AdapterInvocationMeta[] = [];
    let runtimes = 0;
    const execute = createClaudeAcpExecutor({
      createRuntime: () => {
        runtimes += 1;
        return new FakeRuntime() as never;
      },
    });
    const result = await execute(buildContext(root, { instructionsFilePath: path.join(root, "AGENTS.md") }, {
      onMeta: async (payload) => { meta.push(payload); },
      runtimeMcp: {
        getServers: () => [
          { name: "paperclip", url: "https://pc.example/mcp?token=secret", token: "t0k3n", connectionId: "conn-1" },
        ],
      },
    }));
    expect(result.exitCode).toBe(0);
    expect(runtimes).toBe(1);
    const home = homeDirFor("company-1");
    await expect(fs.stat(home)).resolves.toMatchObject({});
    const manifest = meta[0]?.launchManifest as unknown as ClaudeLaunchManifest;
    expect(manifest).toMatchObject({
      version: 1,
      engine: "acp",
      permission: { source: "acp_default" },
      claudeHome: { mode: "company", dir: home },
      settingSources: ["user", "project", "local"],
      instructions: { delivery: "user_prompt_prefix" },
    });
    expect(manifest.mcpServers.find((server) => server.name === "paperclip")).toMatchObject({
      origin: "paperclip",
      governed: true,
    });
    const serialized = JSON.stringify(manifest);
    expect(serialized).not.toContain("t0k3n");
    expect(serialized).not.toContain("token=secret");
  });

  it("reports claudePermissionMode as the manifest permission source", async () => {
    const root = await makeTempRoot("paperclip-claude-acp-native-perm-");
    const meta: AdapterInvocationMeta[] = [];
    const execute = createClaudeAcpExecutor({ createRuntime: () => new FakeRuntime() as never });
    await execute(buildContext(root, { claudePermissionMode: "plan" }, {
      onMeta: async (payload) => { meta.push(payload); },
    }));
    expect(meta[0]?.launchManifest).toMatchObject({
      permission: { mode: "plan", source: "claudePermissionMode" },
      settingsOverlayKeys: ["permissions"],
    });
  });

  it("fails a managed-connection run before spawn when Claude Home settings override auth", async () => {
    const root = await makeTempRoot("paperclip-claude-acp-native-conflict-");
    const home = homeDirFor("company-1");
    await fs.mkdir(home, { recursive: true });
    await fs.writeFile(
      path.join(home, "settings.json"),
      JSON.stringify({ apiKeyHelper: "/bin/key", env: { ANTHROPIC_API_KEY: "k" } }),
    );
    let runtimes = 0;
    const execute = createClaudeAcpExecutor({
      createRuntime: () => {
        runtimes += 1;
        return new FakeRuntime() as never;
      },
    });
    const result = await execute(buildContext(root, { managedAiConnection: true }));
    expect(runtimes).toBe(0);
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("ai_connection_incompatible");
    expect(result.errorMessage).toBe(
      "Claude Home settings.json defines apiKeyHelper, env.ANTHROPIC_API_KEY, which would override the selected AI connection. Remove them in Claude Home.",
    );
  });

  it("fails a managed-connection run when the agent settings overlay overrides auth", async () => {
    const root = await makeTempRoot("paperclip-claude-acp-native-overlay-");
    const execute = createClaudeAcpExecutor({ createRuntime: () => new FakeRuntime() as never });
    const result = await execute(buildContext(root, {
      managedAiConnection: true,
      claudeHome: "isolated",
      settingsOverlay: { apiKeyHelper: "/bin/key" },
    }));
    expect(result.errorCode).toBe("ai_connection_incompatible");
    expect(result.errorMessage).toBe(
      "The agent settings overlay defines apiKeyHelper, which would override the selected AI connection. Remove them from the agent configuration.",
    );
  });

  it("keeps isolated agents on the legacy ACP path", async () => {
    const root = await makeTempRoot("paperclip-claude-acp-native-isolated-");
    const meta: AdapterInvocationMeta[] = [];
    const execute = createClaudeAcpExecutor({ createRuntime: () => new FakeRuntime() as never });
    await execute(buildContext(root, { claudeHome: "isolated" }, {
      onMeta: async (payload) => { meta.push(payload); },
    }));
    await expect(fs.stat(homeDirFor("company-1"))).rejects.toThrow();
    expect(meta[0]?.env ?? {}).not.toHaveProperty("PAPERCLIP_CLAUDE_SDK_OPTIONS_JSON");
    expect(meta[0]?.launchManifest).toMatchObject({
      engine: "acp",
      claudeHome: { mode: "isolated", dir: null },
      settingSources: ["project", "local"],
    });
  });
});
