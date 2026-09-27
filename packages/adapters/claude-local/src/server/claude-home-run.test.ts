import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prepareClaudeHomeRun } from "./claude-home-run.js";
import { parseClaudeNativeOptions } from "./native-options.js";

const ENV_KEYS = ["PAPERCLIP_CLAUDE_HOME_ROOT", "CLAUDE_CONFIG_DIR"] as const;
const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
const cleanupDirs: string[] = [];
let root = "";
let homeRoot = "";
let hostClaudeDir = "";
let cwd = "";

async function write(file: string, contents: string) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, contents);
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-home-run-"));
  cleanupDirs.push(root);
  homeRoot = path.join(root, "homes");
  hostClaudeDir = path.join(root, "host-claude");
  cwd = path.join(root, "workspace");
  await fs.mkdir(cwd, { recursive: true });
  process.env.PAPERCLIP_CLAUDE_HOME_ROOT = homeRoot;
  process.env.CLAUDE_CONFIG_DIR = hostClaudeDir;
});

afterEach(async () => {
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop();
    if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

function prepare(input: {
  config?: Record<string, unknown>;
  managedAiConnection?: boolean;
  runEnv?: Record<string, unknown>;
  logs?: string[];
}) {
  return prepareClaudeHomeRun({
    native: parseClaudeNativeOptions(input.config ?? {}),
    targetIsRemote: false,
    configEnv: {},
    managedAiConnection: input.managedAiConnection ?? false,
    companyId: "co-1",
    cwd,
    runEnv: input.runEnv ?? {},
    onLog: async (_stream, chunk) => { input.logs?.push(chunk); },
  });
}

describe("prepareClaudeHomeRun project settings auth conflicts", () => {
  it("fails a managed-connection run when <cwd>/.claude/settings.json defines auth keys", async () => {
    await write(path.join(cwd, ".claude", "settings.json"), JSON.stringify({
      awsCredentialExport: "/bin/export",
      env: { ANTHROPIC_BASE_URL: "https://proxy.example", FOO: "1" },
    }));
    const logs: string[] = [];
    const run = await prepare({ managedAiConnection: true, logs });
    const file = path.join(cwd, ".claude", "settings.json");
    expect(run.failure).toEqual({
      errorCode: "ai_connection_incompatible",
      errorMessage: `Project settings ${file} defines awsCredentialExport, env.ANTHROPIC_BASE_URL, which would override the selected AI connection. Remove them from the project settings or set claudeHome to isolated.`,
    });
    expect(logs.join("")).toContain(file);
  });

  it("fails a managed-connection run when <cwd>/.claude/settings.local.json defines auth keys", async () => {
    await write(path.join(cwd, ".claude", "settings.local.json"), JSON.stringify({
      permissions: { additionalDirectories: ["/tmp/x"] },
      env: { HTTPS_PROXY: "http://proxy:3128" },
    }));
    const run = await prepare({ managedAiConnection: true });
    expect(run.failure?.errorCode).toBe("ai_connection_incompatible");
    expect(run.failure?.errorMessage).toContain(path.join(cwd, ".claude", "settings.local.json"));
    expect(run.failure?.errorMessage).toContain("env.HTTPS_PROXY");
  });

  it("allows Paperclip's own permissions-only settings.local.json and non-managed runs", async () => {
    await write(path.join(cwd, ".claude", "settings.local.json"), JSON.stringify({
      permissions: { additionalDirectories: ["/tmp/x"] },
    }));
    expect((await prepare({ managedAiConnection: true })).failure).toBeNull();
    await write(path.join(cwd, ".claude", "settings.json"), JSON.stringify({ apiKeyHelper: "/bin/key" }));
    expect((await prepare({ managedAiConnection: false })).failure).toBeNull();
  });
});

describe("prepareClaudeHomeRun login", () => {
  const noLoginWarning = (dir: string) =>
    `Claude Home has no login. Run \`CLAUDE_CONFIG_DIR='${dir}' claude\` and /login once, use a managed AI connection, or set claudeHome to isolated.`;

  it("never copies host credentials into the Claude Home", async () => {
    await write(path.join(hostClaudeDir, ".credentials.json"), '{"claudeAiOauth":{"refreshToken":"r"}}');
    const run = await prepare({});
    expect(run.homeDir).toBe(path.join(homeRoot, "co-1"));
    await expect(fs.access(path.join(run.homeDir!, ".credentials.json"))).rejects.toThrow();
  });

  it("warns (without failing) when the home has no login and no auth env", async () => {
    const logs: string[] = [];
    const run = await prepare({ logs });
    const dir = path.join(homeRoot, "co-1");
    expect(run.failure).toBeNull();
    expect(run.warnings).toContain(noLoginWarning(dir));
    expect(logs.join("")).toContain(noLoginWarning(dir));
  });

  it("does not warn when the home has credentials, auth env is set, the run is managed, or the home is isolated", async () => {
    for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"]) {
      const run = await prepare({ runEnv: { [key]: "x" } });
      expect(run.warnings.some((w) => w.startsWith("Claude Home has no login"))).toBe(false);
    }
    expect((await prepare({ managedAiConnection: true })).warnings).toEqual([]);
    expect((await prepare({ config: { claudeHome: "isolated" } })).warnings).toEqual([]);
    await write(path.join(homeRoot, "co-1", ".credentials.json"), "{}");
    expect((await prepare({})).warnings).toEqual([]);
  });
});
