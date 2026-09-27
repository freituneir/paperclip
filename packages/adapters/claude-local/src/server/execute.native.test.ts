import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterInvocationMeta } from "@paperclipai/adapter-utils";
import type { RunProcessResult } from "@paperclipai/adapter-utils/server-utils";
import type { ClaudeLaunchManifest } from "@paperclipai/shared";

const { runChildProcess, ensureCommandResolvable, resolveCommandForLogs } = vi.hoisted(() => ({
  runChildProcess: vi.fn(async (_runId: string, _command: string, args: string[]): Promise<RunProcessResult> => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: args.includes("--version")
      ? "2.1.251 (Claude Code)\n"
      : [
          JSON.stringify({ type: "system", subtype: "init", session_id: "claude-session-1", model: "claude-sonnet" }),
          JSON.stringify({ type: "result", session_id: "claude-session-1", result: "hello", usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 } }),
        ].join("\n"),
    stderr: "",
    pid: 123,
    startedAt: new Date().toISOString(),
  })),
  ensureCommandResolvable: vi.fn(async () => undefined),
  resolveCommandForLogs: vi.fn(async () => "/usr/local/bin/claude"),
}));

vi.mock("@paperclipai/adapter-utils/server-utils", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/server-utils")>(
    "@paperclipai/adapter-utils/server-utils",
  );
  return { ...actual, ensureCommandResolvable, resolveCommandForLogs, runChildProcess };
});

import { execute } from "./execute.js";
import { resetClaudeCliCapabilitiesCacheForTests } from "./cli-capabilities.js";

const ENV_KEYS = ["PAPERCLIP_HOME", "PAPERCLIP_INSTANCE_ID", "PAPERCLIP_CLAUDE_HOME_ROOT", "CLAUDE_CONFIG_DIR"] as const;
const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
const cleanupDirs: string[] = [];
let rootDir = "";
let homeRoot = "";

beforeEach(async () => {
  rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-claude-native-exec-"));
  cleanupDirs.push(rootDir);
  homeRoot = path.join(rootDir, "homes");
  delete process.env.PAPERCLIP_INSTANCE_ID;
  process.env.PAPERCLIP_HOME = path.join(rootDir, "paperclip");
  process.env.PAPERCLIP_CLAUDE_HOME_ROOT = homeRoot;
  process.env.CLAUDE_CONFIG_DIR = path.join(rootDir, "host-claude");
});

afterEach(async () => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  resetClaudeCliCapabilitiesCacheForTests();
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

async function runLocal(config: Record<string, unknown>) {
  const workspaceDir = path.join(rootDir, "workspace");
  await mkdir(workspaceDir, { recursive: true });
  const metas: AdapterInvocationMeta[] = [];
  const logs: string[] = [];
  const result = await execute({
    runId: "run-native",
    agent: { id: "agent-1", companyId: "company-1", name: "Claude", adapterType: "claude_local", adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: { engine: "cli", command: "claude", env: { ANTHROPIC_API_KEY: "", ANTHROPIC_AUTH_TOKEN: "", CLAUDE_CODE_OAUTH_TOKEN: "" }, ...config },
    context: { paperclipWorkspace: { cwd: workspaceDir, source: "project_primary" } },
    onLog: async (_stream, chunk) => { logs.push(chunk); },
    onMeta: async (meta) => { metas.push(meta); },
  });
  const call = runChildProcess.mock.calls.find((candidate) => (candidate[2] as string[]).includes("--print"));
  return {
    result,
    args: (call?.[2] ?? []) as string[],
    manifest: metas[0]?.launchManifest as unknown as ClaudeLaunchManifest,
    logs: logs.join(""),
  };
}

describe("claude_local CLI native options on local targets", () => {
  it("falls back to the curated --allowedTools list for bypassPermissions when running as root", async () => {
    vi.spyOn(process, "getuid").mockReturnValue(0);
    const { args, manifest } = await runLocal({ claudePermissionMode: "bypassPermissions" });
    expect(args).not.toContain("--permission-mode");
    expect(args).not.toContain("--dangerously-skip-permissions");
    expect(args).toContain("--allowedTools");
    expect(args).not.toContain("--settings");
    expect(manifest.permission).toEqual({ mode: "allowlist", source: "dangerouslySkipPermissions", bridge: "off" });
    expect(manifest.warnings).toContain(
      'claudePermissionMode "bypassPermissions" cannot be used when Paperclip runs as root (Claude Code refuses to start); using the curated --allowedTools list instead.',
    );
  });

  it("keeps other permission modes as root", async () => {
    vi.spyOn(process, "getuid").mockReturnValue(0);
    const { args, manifest } = await runLocal({ claudePermissionMode: "acceptEdits" });
    expect(args).toEqual(expect.arrayContaining(["--permission-mode", "acceptEdits"]));
    expect(args).not.toContain("--allowedTools");
    expect(manifest.permission).toEqual({ mode: "acceptEdits", source: "claudePermissionMode", bridge: "off" });
  });

  it("keeps bypassPermissions for non-root users", async () => {
    vi.spyOn(process, "getuid").mockReturnValue(501);
    const { args } = await runLocal({ claudePermissionMode: "bypassPermissions" });
    expect(args).toEqual(expect.arrayContaining(["--permission-mode", "bypassPermissions"]));
  });

  it("warns (stderr + manifest) instead of copying a login when the Claude Home has none", async () => {
    const { result, logs, manifest } = await runLocal({});
    const warning = `Claude Home has no login. Run \`CLAUDE_CONFIG_DIR='${path.join(homeRoot, "company-1")}' claude\` and /login once, use a managed AI connection, or set claudeHome to isolated.`;
    expect(result.exitCode).toBe(0);
    expect(logs).toContain(warning);
    expect(manifest.warnings).toContain(warning);
  });
});

describe("claude_local CLI permission bridge", () => {
  const ASK_WARNING = "Claude `ask` rules are denied on the CLI engine; use the ACP engine for approval cards.";

  it("reports the bridge off without a warning when no ask rules exist", async () => {
    const { manifest } = await runLocal({});
    expect(manifest.permission.bridge).toBe("off");
    expect(manifest.warnings).not.toContain(ASK_WARNING);
  });

  it("warns that ask rules are denied when the overlay defines them", async () => {
    const { manifest } = await runLocal({ settingsOverlay: { permissions: { ask: ["Bash(git push:*)"] } } });
    expect(manifest.permission.bridge).toBe("off");
    expect(manifest.warnings).toContain(ASK_WARNING);
  });

  it("does not warn when the bridge is off", async () => {
    const { manifest } = await runLocal({
      permissionBridge: "off",
      settingsOverlay: { permissions: { ask: ["Bash(git push:*)"] } },
    });
    expect(manifest.warnings).not.toContain(ASK_WARNING);
  });
});
