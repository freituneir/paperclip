import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext, AdapterInvocationMeta } from "@paperclipai/adapter-utils";
import type { ClaudeLaunchManifest } from "@paperclipai/shared";
import { buildInvocationEnvForLogs, redactEnvForLogs } from "@paperclipai/adapter-utils/server-utils";
import {
  ACP_PERMISSION_BRIDGE_ROOT_WARNING,
  acpRootBypassUnavailable,
  buildClaudeAcpConfig,
  createClaudeAcpExecutor,
  PAPERCLIP_CLAUDE_SDK_OPTIONS_ENV,
  readClaudeSettingsDefaultMode,
  resolveClaudeAcpPermissionBridge,
} from "./acp.js";
import { parseClaudeNativeOptions } from "./native-options.js";

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
  // Keep the host login lookup away from the developer's real ~/.claude.
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
    const sdk = JSON.parse(String(env[PAPERCLIP_CLAUDE_SDK_OPTIONS_ENV]));
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
    const sdk = JSON.parse(String(envOf(built)[PAPERCLIP_CLAUDE_SDK_OPTIONS_ENV]));
    expect(sdk.settings).toEqual({ permissions: { allow: ["Bash(ls)"], defaultMode: "acceptEdits" } });
    expect(sdk.strictMcpConfig).toBeUndefined();
  });

  it("names the SDK options env var so the log redactor masks it", () => {
    expect(PAPERCLIP_CLAUDE_SDK_OPTIONS_ENV).toBe("PAPERCLIP_CLAUDE_SDK_OPTIONS_SECRET_JSON");
    const built = buildClaudeAcpConfig(
      { settingsOverlay: { env: { MY_SERVICE_PASSWORD_VALUE: "hunter2-overlay" } } },
      {},
      { companyId: "c1" },
    );
    const env = Object.fromEntries(
      Object.entries(envOf(built)).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
    expect(env[PAPERCLIP_CLAUDE_SDK_OPTIONS_ENV]).toContain("hunter2-overlay");
    const logged = redactEnvForLogs(env);
    expect(logged[PAPERCLIP_CLAUDE_SDK_OPTIONS_ENV]).not.toContain("hunter2-overlay");
    expect(JSON.stringify(buildInvocationEnvForLogs(env))).not.toContain("hunter2-overlay");
  });

  it("does not forward extraArgs for isolated agents (ACP ignored them before Claude Home)", () => {
    const built = buildClaudeAcpConfig(
      { claudeHome: "isolated", extraArgs: ["--foo", "1"], permissionBridge: "off" },
      {},
      { companyId: "c1" },
    );
    expect(envOf(built)).not.toHaveProperty(PAPERCLIP_CLAUDE_SDK_OPTIONS_ENV);
    const withOther = buildClaudeAcpConfig(
      { claudeHome: "isolated", fallbackModel: "claude-sonnet-5", args: ["--foo", "1"] },
      {},
      { companyId: "c1" },
    );
    const sdk = JSON.parse(String(envOf(withOther)[PAPERCLIP_CLAUDE_SDK_OPTIONS_ENV]));
    expect(sdk.fallbackModel).toBe("claude-sonnet-5");
    expect(sdk).not.toHaveProperty("extraArgs");
  });

  it("leaves isolated agents untouched", () => {
    const built = buildClaudeAcpConfig(
      { claudeHome: "isolated", permissionBridge: "off" },
      {},
      { companyId: "c1", hasPaperclipMcp: true },
    );
    const env = envOf(built);
    expect(env).not.toHaveProperty("CLAUDE_CONFIG_DIR");
    expect(env).not.toHaveProperty(PAPERCLIP_CLAUDE_SDK_OPTIONS_ENV);
  });

  it("leaves remote targets untouched", () => {
    const built = buildClaudeAcpConfig(
      { claudeHome: "company", fallbackModel: "claude-sonnet-5" },
      {},
      { companyId: "c1", remote: true, hasPaperclipMcp: true },
    );
    const env = envOf(built);
    expect(env).not.toHaveProperty("CLAUDE_CONFIG_DIR");
    expect(env).not.toHaveProperty(PAPERCLIP_CLAUDE_SDK_OPTIONS_ENV);
  });

  it("does nothing without a company id (legacy callers)", () => {
    const env = envOf(buildClaudeAcpConfig({ claudeHome: "company" }, {}));
    expect(env).not.toHaveProperty("CLAUDE_CONFIG_DIR");
    expect(env).not.toHaveProperty(PAPERCLIP_CLAUDE_SDK_OPTIONS_ENV);
  });

  it("respects an operator CLAUDE_CONFIG_DIR unless the agent uses a managed AI connection", () => {
    const operator = buildClaudeAcpConfig(
      { env: { CLAUDE_CONFIG_DIR: "/operator/claude" }, permissionBridge: "off" },
      {},
      { companyId: "c1" },
    );
    expect(envOf(operator).CLAUDE_CONFIG_DIR).toBe("/operator/claude");
    expect(envOf(operator)).not.toHaveProperty(PAPERCLIP_CLAUDE_SDK_OPTIONS_ENV);

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
      permission: { source: "permission_bridge" },
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
    await execute(buildContext(root, { claudeHome: "isolated", permissionBridge: "off" }, {
      onMeta: async (payload) => { meta.push(payload); },
    }));
    await expect(fs.stat(homeDirFor("company-1"))).rejects.toThrow();
    expect(meta[0]?.env ?? {}).not.toHaveProperty(PAPERCLIP_CLAUDE_SDK_OPTIONS_ENV);
    expect(meta[0]?.launchManifest).toMatchObject({
      engine: "acp",
      claudeHome: { mode: "isolated", dir: null },
      settingSources: ["project", "local"],
    });
  });
  it("masks the SDK options (settings overlay secrets) in the logged invocation env", async () => {
    const root = await makeTempRoot("paperclip-claude-acp-native-redact-");
    const meta: AdapterInvocationMeta[] = [];
    const execute = createClaudeAcpExecutor({ createRuntime: () => new FakeRuntime() as never });
    await execute(buildContext(root, { settingsOverlay: { env: { SOME_UPSTREAM_CREDENTIAL: "overlay-s3cr3t" } } }, {
      onMeta: async (payload) => { meta.push(payload); },
    }));
    const loggedEnv = (meta[0]?.env ?? {}) as Record<string, string>;
    expect(loggedEnv).toHaveProperty(PAPERCLIP_CLAUDE_SDK_OPTIONS_ENV);
    expect(JSON.stringify(meta[0])).not.toContain("overlay-s3cr3t");
  });

  it("fails a managed-connection run when the project settings.local.json overrides auth", async () => {
    const root = await makeTempRoot("paperclip-claude-acp-native-project-");
    await fs.mkdir(path.join(root, ".claude"), { recursive: true });
    await fs.writeFile(
      path.join(root, ".claude", "settings.local.json"),
      JSON.stringify({ env: { CLAUDE_CODE_OAUTH_TOKEN: "t" } }),
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
    expect(result.errorCode).toBe("ai_connection_incompatible");
    expect(result.errorMessage).toContain(path.join(root, ".claude", "settings.local.json"));
    expect(result.errorMessage).toContain("env.CLAUDE_CODE_OAUTH_TOKEN");
  });

  it("warns in the manifest when the Claude Home has no login", async () => {
    const root = await makeTempRoot("paperclip-claude-acp-native-nologin-");
    const meta: AdapterInvocationMeta[] = [];
    const execute = createClaudeAcpExecutor({ createRuntime: () => new FakeRuntime() as never });
    const noAuthEnv = { ANTHROPIC_API_KEY: "", ANTHROPIC_AUTH_TOKEN: "", CLAUDE_CODE_OAUTH_TOKEN: "" };
    await execute(buildContext(root, { env: noAuthEnv }, { onMeta: async (payload) => { meta.push(payload); } }));
    const manifest = meta[0]?.launchManifest as unknown as ClaudeLaunchManifest;
    expect(manifest.warnings).toContain(
      `Claude Home has no login. Run \`CLAUDE_CONFIG_DIR='${homeDirFor("company-1")}' claude\` and /login once, use a managed AI connection, or set claudeHome to isolated.`,
    );
  });

  it("reports ignored extraArgs for isolated agents and unparseable extraArgs with an active home", async () => {
    const root = await makeTempRoot("paperclip-claude-acp-native-extra-");
    const isolatedMeta: AdapterInvocationMeta[] = [];
    const execute = createClaudeAcpExecutor({ createRuntime: () => new FakeRuntime() as never });
    await execute(buildContext(root, { claudeHome: "isolated", extraArgs: ["--foo", "1"] }, {
      onMeta: async (payload) => { isolatedMeta.push(payload); },
    }));
    const isolated = isolatedMeta[0]?.launchManifest as unknown as ClaudeLaunchManifest;
    expect(isolated.extraArgs).toEqual([]);
    expect(isolated.warnings).toContain(
      "extraArgs are applied on the ACP engine only with the company Claude Home; they were ignored for this isolated run.",
    );

    const homeMeta: AdapterInvocationMeta[] = [];
    await execute(buildContext(root, { extraArgs: ["--add-dir", "/a", "/b"] }, {
      onMeta: async (payload) => { homeMeta.push(payload); },
    }));
    const home = homeMeta[0]?.launchManifest as unknown as ClaudeLaunchManifest;
    expect(home.extraArgs).toEqual(["--add-dir", "/a", "/b"]);
    expect(home.warnings.some((warning) => warning.includes('"/b" was ignored'))).toBe(true);
  });
});

describe("acpRootBypassUnavailable", () => {
  const bypass = parseClaudeNativeOptions({ claudePermissionMode: "bypassPermissions" });
  it("is true only for bypassPermissions as root outside a sandbox", () => {
    expect(acpRootBypassUnavailable(bypass, 0, {})).toBe(true);
    expect(acpRootBypassUnavailable(bypass, 0, { IS_SANDBOX: "1" })).toBe(false);
    expect(acpRootBypassUnavailable(bypass, 1000, {})).toBe(false);
    expect(acpRootBypassUnavailable(parseClaudeNativeOptions({ claudePermissionMode: "acceptEdits" }), 0, {})).toBe(false);
  });
});

describe("Claude ACP permission bridge", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function sdkOf(config: Record<string, unknown>): Record<string, unknown> {
    const raw = envOf(config)[PAPERCLIP_CLAUDE_SDK_OPTIONS_ENV];
    return raw ? (JSON.parse(String(raw)) as Record<string, unknown>) : {};
  }

  it("defaults to task_chat and fills bypassPermissions into the SDK settings overlay", () => {
    vi.spyOn(process, "getuid").mockReturnValue(501);
    const built = buildClaudeAcpConfig({}, {}, { companyId: "c1" });
    expect(built.permissionBridge).toBe("task_chat");
    expect(built.permissionWaitSec).toBe(600);
    expect(sdkOf(built).settings).toEqual({ permissions: { defaultMode: "bypassPermissions" } });
  });

  it("merges the bypass default with an overlay that defines ask rules", () => {
    vi.spyOn(process, "getuid").mockReturnValue(501);
    const built = buildClaudeAcpConfig(
      { claudeHome: "isolated", settingsOverlay: { model: "opus", permissions: { ask: ["Bash(git push:*)"] } }, permissionWaitSec: 5 },
      {},
      { companyId: "c1" },
    );
    expect(sdkOf(built).settings).toEqual({
      model: "opus",
      permissions: { ask: ["Bash(git push:*)"], defaultMode: "bypassPermissions" },
    });
    expect(built.permissionWaitSec).toBe(10);
  });

  it("respects an explicit claudePermissionMode or overlay defaultMode", () => {
    vi.spyOn(process, "getuid").mockReturnValue(501);
    const explicit = buildClaudeAcpConfig({ claudePermissionMode: "acceptEdits" }, {}, { companyId: "c1" });
    expect(explicit.permissionBridge).toBe("task_chat");
    expect(sdkOf(explicit).settings).toEqual({ permissions: { defaultMode: "acceptEdits" } });
    const overlay = buildClaudeAcpConfig(
      { settingsOverlay: { permissions: { defaultMode: "plan" } } },
      {},
      { companyId: "c1" },
    );
    expect(sdkOf(overlay).settings).toEqual({ permissions: { defaultMode: "plan" } });
  });

  it("leaves the overlay alone when the bridge is off, remote, or without a company", () => {
    vi.spyOn(process, "getuid").mockReturnValue(501);
    const off = buildClaudeAcpConfig({ permissionBridge: "off" }, {}, { companyId: "c1" });
    expect(off.permissionBridge).toBe("off");
    expect(sdkOf(off).settings).toBeUndefined();
    const remote = buildClaudeAcpConfig({}, {}, { companyId: "c1", remote: true });
    expect(remote.permissionBridge).toBe("off");
    expect(envOf(remote)).not.toHaveProperty(PAPERCLIP_CLAUDE_SDK_OPTIONS_ENV);
    expect(buildClaudeAcpConfig({}, {}).permissionBridge).toBe("off");
  });

  it("is unavailable as root outside a sandbox when it would need bypassPermissions", () => {
    expect(resolveClaudeAcpPermissionBridge({}, { companyId: "c1" }, 0, {})).toEqual({
      state: "unavailable",
      fillBypassDefaultMode: false,
    });
    expect(resolveClaudeAcpPermissionBridge({}, { companyId: "c1" }, 0, { IS_SANDBOX: "1" })).toEqual({
      state: "task_chat",
      fillBypassDefaultMode: true,
    });
    expect(
      resolveClaudeAcpPermissionBridge({ claudePermissionMode: "acceptEdits" }, { companyId: "c1" }, 0, {}),
    ).toEqual({ state: "task_chat", fillBypassDefaultMode: false });
    expect(
      resolveClaudeAcpPermissionBridge({ claudePermissionMode: "bypassPermissions" }, { companyId: "c1" }, 0, {}).state,
    ).toBe("unavailable");
  });

  it("disables the bridge for the engine as root and says so in the manifest", async () => {
    vi.spyOn(process, "getuid").mockReturnValue(0);
    const previousSandbox = process.env.IS_SANDBOX;
    delete process.env.IS_SANDBOX;
    try {
      const built = buildClaudeAcpConfig({}, {}, { companyId: "c1" });
      expect(built.permissionBridge).toBe("off");
      expect(sdkOf(built).settings).toBeUndefined();

      const root = await makeTempRoot("paperclip-claude-acp-bridge-root-");
      const meta: AdapterInvocationMeta[] = [];
      const execute = createClaudeAcpExecutor({ createRuntime: () => new FakeRuntime() as never });
      await execute(buildContext(root, {}, { onMeta: async (payload) => { meta.push(payload); } }));
      const manifest = meta[0]?.launchManifest as unknown as ClaudeLaunchManifest;
      expect(manifest.permission.bridge).toBe("unavailable");
      expect(manifest.warnings).toContain(ACP_PERMISSION_BRIDGE_ROOT_WARNING);
    } finally {
      if (previousSandbox !== undefined) process.env.IS_SANDBOX = previousSandbox;
    }
  });

  it("reports task_chat in the ACP manifest and the bypass overlay key", async () => {
    vi.spyOn(process, "getuid").mockReturnValue(501);
    const root = await makeTempRoot("paperclip-claude-acp-bridge-");
    const meta: AdapterInvocationMeta[] = [];
    const execute = createClaudeAcpExecutor({ createRuntime: () => new FakeRuntime() as never });
    await execute(buildContext(root, {}, { onMeta: async (payload) => { meta.push(payload); } }));
    expect(meta[0]?.launchManifest).toMatchObject({
      // The manifest must say what Claude actually runs with, not the ACP client default.
      permission: { mode: "bypassPermissions", source: "permission_bridge", bridge: "task_chat" },
      settingsOverlayKeys: ["permissions"],
    });

    const offMeta: AdapterInvocationMeta[] = [];
    await execute(buildContext(root, { permissionBridge: "off" }, { onMeta: async (payload) => { offMeta.push(payload); } }));
    expect(offMeta[0]?.launchManifest).toMatchObject({ permission: { bridge: "off" }, settingsOverlayKeys: [] });
  });

  it("does not fill bypass when a settings source defines permissions.defaultMode", () => {
    vi.spyOn(process, "getuid").mockReturnValue(501);
    for (const mode of ["plan", "dontAsk"]) {
      const settingsDefaultMode = { mode, source: "Claude Home settings" };
      expect(resolveClaudeAcpPermissionBridge({}, { companyId: "c1", settingsDefaultMode })).toEqual({
        state: "task_chat",
        fillBypassDefaultMode: false,
        settingsDefaultMode,
      });
      const built = buildClaudeAcpConfig({}, {}, { companyId: "c1", settingsDefaultMode });
      expect(built.permissionBridge).toBe("task_chat");
      expect(sdkOf(built).settings).toBeUndefined();
    }
    // A settings mode needs no bypass, so root keeps the bridge.
    expect(
      resolveClaudeAcpPermissionBridge({}, { companyId: "c1", settingsDefaultMode: { mode: "plan", source: "x" } }, 0, {}).state,
    ).toBe("task_chat");
    // A settings bypass is no stricter than the fill.
    expect(
      resolveClaudeAcpPermissionBridge({}, {
        companyId: "c1",
        settingsDefaultMode: { mode: "bypassPermissions", source: "x" },
      }).fillBypassDefaultMode,
    ).toBe(true);
    // An explicit agent mode still wins over settings.
    expect(
      resolveClaudeAcpPermissionBridge({ claudePermissionMode: "acceptEdits" }, {
        companyId: "c1",
        settingsDefaultMode: { mode: "plan", source: "x" },
      }),
    ).toEqual({ state: "task_chat", fillBypassDefaultMode: false });
  });

  it("reads the settings defaultMode from Claude Home and project settings, ignoring Paperclip's own local write", async () => {
    const root = await makeTempRoot("paperclip-claude-acp-settings-mode-");
    await expect(readClaudeSettingsDefaultMode({ homeSettings: null, cwd: root })).resolves.toBeNull();
    await expect(
      readClaudeSettingsDefaultMode({ homeSettings: { permissions: { defaultMode: "dontAsk" } }, cwd: root }),
    ).resolves.toEqual({ mode: "dontAsk", source: "Claude Home settings" });
    await fs.mkdir(path.join(root, ".claude"), { recursive: true });
    // Paperclip's ACP engine writes defaultMode "default" (and rewrites dontAsk) here.
    await fs.writeFile(
      path.join(root, ".claude", "settings.local.json"),
      JSON.stringify({ permissions: { defaultMode: "default" } }),
    );
    await expect(readClaudeSettingsDefaultMode({ homeSettings: null, cwd: root })).resolves.toBeNull();
    await fs.writeFile(path.join(root, ".claude", "settings.json"), JSON.stringify({ permissions: { defaultMode: "plan" } }));
    await expect(
      readClaudeSettingsDefaultMode({ homeSettings: { permissions: { defaultMode: "dontAsk" } }, cwd: root }),
    ).resolves.toEqual({ mode: "plan", source: "Project settings .claude/settings.json" });
    await fs.writeFile(
      path.join(root, ".claude", "settings.local.json"),
      JSON.stringify({ permissions: { defaultMode: "acceptEdits" } }),
    );
    await expect(readClaudeSettingsDefaultMode({ homeSettings: null, cwd: root })).resolves.toEqual({
      mode: "acceptEdits",
      source: "Project settings .claude/settings.local.json",
    });
  });

  it("keeps a Claude Home settings defaultMode instead of filling bypass, with a manifest warning", async () => {
    vi.spyOn(process, "getuid").mockReturnValue(501);
    for (const mode of ["plan", "dontAsk"]) {
      const home = homeDirFor("company-1");
      await fs.mkdir(home, { recursive: true });
      await fs.writeFile(path.join(home, "settings.json"), JSON.stringify({ permissions: { defaultMode: mode } }));
      const root = await makeTempRoot("paperclip-claude-acp-bridge-home-mode-");
      const meta: AdapterInvocationMeta[] = [];
      const execute = createClaudeAcpExecutor({ createRuntime: () => new FakeRuntime() as never });
      await execute(buildContext(root, {}, {
        onMeta: async (payload) => {
          meta.push(payload);
        },
      }));
      const manifest = meta[0]?.launchManifest as unknown as ClaudeLaunchManifest;
      expect(manifest.permission).toMatchObject({ mode, source: "acp_default", bridge: "task_chat" });
      expect(manifest.settingsOverlayKeys).toEqual([]);
      expect(manifest.warnings).toContain(
        `Claude Home settings set permissions.defaultMode=${mode}; approval cards will appear for everything that mode asks about.`,
      );
    }
  });

  it("fills bypass when no settings source defines permissions.defaultMode", async () => {
    vi.spyOn(process, "getuid").mockReturnValue(501);
    const home = homeDirFor("company-1");
    await fs.mkdir(home, { recursive: true });
    await fs.writeFile(path.join(home, "settings.json"), JSON.stringify({ permissions: { ask: ["Bash(git push:*)"] } }));
    const root = await makeTempRoot("paperclip-claude-acp-bridge-no-mode-");
    const meta: AdapterInvocationMeta[] = [];
    const execute = createClaudeAcpExecutor({ createRuntime: () => new FakeRuntime() as never });
    await execute(buildContext(root, {}, { onMeta: async (payload) => { meta.push(payload); } }));
    const manifest = meta[0]?.launchManifest as unknown as ClaudeLaunchManifest;
    expect(manifest.permission).toMatchObject({ mode: "bypassPermissions", source: "permission_bridge" });
    expect(manifest.warnings.some((warning) => warning.includes("permissions.defaultMode="))).toBe(false);
  });
});
