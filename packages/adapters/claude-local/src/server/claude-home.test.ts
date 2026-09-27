import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CLAUDE_REDACTED_VALUE } from "@paperclipai/shared";
import {
  ensureClaudeHomeDir,
  findHomeAuthConflicts,
  readClaudeHomeInventory,
  readProjectMcpServers,
  redactClaudeSecrets,
  resolveClaudeHomeDir,
  restoreRedactedSecrets,
  summarizeMcpServer,
} from "./claude-home.js";

const cleanupDirs: string[] = [];

async function makeTmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-home-test-"));
  cleanupDirs.push(dir);
  return dir;
}

async function writeFile(root: string, relative: string, contents: string) {
  const target = path.join(root, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, contents);
}

afterEach(async () => {
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop();
    if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

describe("resolveClaudeHomeDir", () => {
  it("honors PAPERCLIP_CLAUDE_HOME_ROOT", () => {
    expect(resolveClaudeHomeDir({ PAPERCLIP_CLAUDE_HOME_ROOT: "/srv/claude-homes" }, "company-1")).toBe(
      path.resolve("/srv/claude-homes", "company-1"),
    );
  });

  it("defaults to the instance root", () => {
    const dir = resolveClaudeHomeDir({ PAPERCLIP_HOME: "/srv/paperclip", PAPERCLIP_INSTANCE_ID: "default" }, "company-1");
    expect(dir.endsWith(path.join("companies", "company-1", "claude-home"))).toBe(true);
    expect(dir.startsWith(path.resolve("/srv/paperclip"))).toBe(true);
  });

  it("rejects company ids that escape the root", () => {
    expect(() => resolveClaudeHomeDir({ PAPERCLIP_CLAUDE_HOME_ROOT: "/srv" }, "../etc")).toThrow();
    expect(() => resolveClaudeHomeDir({ PAPERCLIP_CLAUDE_HOME_ROOT: "/srv" }, "")).toThrow();
  });
});

describe("ensureClaudeHomeDir", () => {
  it("creates the directory idempotently", async () => {
    const root = await makeTmpDir();
    const dir = path.join(root, "a", "b");
    await ensureClaudeHomeDir(dir);
    await ensureClaudeHomeDir(dir);
    expect((await fs.stat(dir)).isDirectory()).toBe(true);
  });
});

describe("readClaudeHomeInventory", () => {
  it("reports a missing dir as not existing with empty lists", async () => {
    const root = await makeTmpDir();
    const dir = path.join(root, "missing");
    const inventory = await readClaudeHomeInventory(dir);
    expect(inventory).toMatchObject({
      dir,
      exists: false,
      settings: null,
      settingsParseError: null,
      claudeMd: null,
      mcpServers: [],
      mcpServerConfigs: {},
      mcpParseError: null,
      plugins: [],
      skills: [],
      subagents: [],
      commands: [],
      hooks: [],
    });
    expect(inventory.cliCommand).toBe(`CLAUDE_CONFIG_DIR='${dir}' claude`);
  });

  it("parses settings, MCP servers, plugins, skills, agents, commands, and hooks", async () => {
    const dir = await makeTmpDir();
    await writeFile(dir, "settings.json", JSON.stringify({
      env: { SECRET_TOKEN: "s3cret" },
      enabledPlugins: { "alpha@market": true, "beta@market": false },
      hooks: {
        PreToolUse: [
          { matcher: "Bash", hooks: [{ type: "command", command: "a" }, { type: "command", command: "b" }] },
          { matcher: "Edit", hooks: [{ type: "command", command: "c" }] },
        ],
        Stop: [{ hooks: [{ type: "command", command: "d" }] }],
      },
    }));
    await writeFile(dir, "CLAUDE.md", "# Company rules\n");
    await writeFile(dir, ".claude.json", JSON.stringify({
      numStartups: 3,
      mcpServers: {
        linear: { type: "http", url: "https://mcp.linear.app/mcp?token=abc", headers: { Authorization: "Bearer xyz" } },
        files: { type: "stdio", command: "/usr/local/bin/files-mcp", args: ["--root", "/data"], env: { API_KEY: "k" } },
      },
    }));
    await writeFile(dir, "plugins/installed_plugins.json", JSON.stringify({
      version: 2,
      plugins: { "alpha@market": [{ scope: "user" }], "beta@market": [{ scope: "user" }] },
    }));
    await writeFile(dir, "skills/review/SKILL.md", "---\nname: code-review\ndescription: Reviews code\n---\nBody\n");
    await writeFile(dir, "agents/researcher.md", "---\nname: researcher\ndescription: Researches things\n---\nPrompt\n");
    await writeFile(dir, "commands/deploy.md", "---\ndescription: Deploys\n---\nDo it\n");

    const inventory = await readClaudeHomeInventory(dir);
    expect(inventory.exists).toBe(true);
    expect(inventory.settingsParseError).toBeNull();
    expect(inventory.settings?.env).toEqual({ SECRET_TOKEN: CLAUDE_REDACTED_VALUE });
    expect(inventory.claudeMd).toBe("# Company rules\n");
    expect(inventory.hooks).toEqual([
      { event: "PreToolUse", count: 3 },
      { event: "Stop", count: 1 },
    ]);
    expect(inventory.mcpServers).toEqual([
      {
        name: "files",
        origin: "claude_home",
        transport: "stdio",
        target: "files-mcp (2 args)",
        governed: false,
        envKeys: ["API_KEY"],
      },
      {
        name: "linear",
        origin: "claude_home",
        transport: "http",
        target: "https://mcp.linear.app/mcp",
        governed: false,
        headerKeys: ["Authorization"],
      },
    ]);
    expect(inventory.mcpServerConfigs.linear?.headers).toEqual({ Authorization: CLAUDE_REDACTED_VALUE });
    expect(inventory.mcpServerConfigs.files?.env).toEqual({ API_KEY: CLAUDE_REDACTED_VALUE });
    expect(inventory.plugins).toEqual([
      { name: "alpha@market", description: "enabled", origin: "plugin" },
      { name: "beta@market", description: "disabled", origin: "plugin" },
    ]);
    expect(inventory.skills).toEqual([{ name: "code-review", description: "Reviews code", origin: "claude_home" }]);
    expect(inventory.subagents).toEqual([{ name: "researcher", description: "Researches things", origin: "claude_home" }]);
    expect(inventory.commands).toEqual([{ name: "deploy", description: "Deploys", origin: "claude_home" }]);
    expect(JSON.stringify(inventory)).not.toContain("s3cret");
    expect(JSON.stringify(inventory)).not.toContain("xyz");
  });

  it("tolerates the flat installed_plugins.json shape", async () => {
    const dir = await makeTmpDir();
    await writeFile(dir, "plugins/installed_plugins.json", JSON.stringify({ "gamma@market": { version: "1" } }));
    const inventory = await readClaudeHomeInventory(dir);
    expect(inventory.plugins).toEqual([{ name: "gamma@market", description: "disabled", origin: "plugin" }]);
  });

  it("reports malformed settings.json and .claude.json without throwing", async () => {
    const dir = await makeTmpDir();
    await writeFile(dir, "settings.json", "{ not json");
    await writeFile(dir, ".claude.json", "[1,2");
    const inventory = await readClaudeHomeInventory(dir);
    expect(inventory.settings).toBeNull();
    expect(typeof inventory.settingsParseError).toBe("string");
    expect(typeof inventory.mcpParseError).toBe("string");
    expect(inventory.mcpServers).toEqual([]);
  });
});

describe("redaction", () => {
  const raw = {
    env: { ANTHROPIC_API_KEY: "sk-1", FOO: "bar" },
    mcpServers: {
      a: { type: "http", url: "https://x", headers: { Authorization: "Bearer t" } },
      b: { type: "stdio", command: "b", env: { TOKEN: "t2" } },
    },
    model: "opus",
  };

  it("replaces settings env values and MCP header/env values", () => {
    const redacted = redactClaudeSecrets(raw);
    expect(redacted).toEqual({
      env: { ANTHROPIC_API_KEY: CLAUDE_REDACTED_VALUE, FOO: CLAUDE_REDACTED_VALUE },
      mcpServers: {
        a: { type: "http", url: "https://x", headers: { Authorization: CLAUDE_REDACTED_VALUE } },
        b: { type: "stdio", command: "b", env: { TOKEN: CLAUDE_REDACTED_VALUE } },
      },
      model: "opus",
    });
    expect(raw.env.ANTHROPIC_API_KEY).toBe("sk-1");
  });

  it("restores redacted values from the previous document", () => {
    const edited = redactClaudeSecrets(raw) as typeof raw;
    edited.model = "sonnet";
    edited.env.FOO = "changed";
    const restored = restoreRedactedSecrets(edited, raw);
    expect(restored).toEqual({
      ...raw,
      env: { ANTHROPIC_API_KEY: "sk-1", FOO: "changed" },
      model: "sonnet",
    });
  });

  it("drops a redacted placeholder with no previous value", () => {
    expect(restoreRedactedSecrets({ env: { NEW: CLAUDE_REDACTED_VALUE, KEEP: "1" } }, {})).toEqual({ env: { KEEP: "1" } });
  });
});

describe("findHomeAuthConflicts", () => {
  it("lists auth keys that would override a managed AI connection", () => {
    expect(findHomeAuthConflicts({ apiKeyHelper: "x", env: { ANTHROPIC_API_KEY: "k", FOO: "1" } })).toEqual([
      "apiKeyHelper",
      "env.ANTHROPIC_API_KEY",
    ]);
    expect(findHomeAuthConflicts(null)).toEqual([]);
  });

  it("flags cloud credential helpers, provider routing, proxy and TLS env keys", () => {
    const env = Object.fromEntries([
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "ANTHROPIC_BASE_URL",
      "ANTHROPIC_BEDROCK_BASE_URL",
      "ANTHROPIC_VERTEX_BASE_URL",
      "AWS_BEARER_TOKEN_BEDROCK",
      "ANTHROPIC_CUSTOM_HEADERS",
      "CLAUDE_CODE_USE_BEDROCK",
      "CLAUDE_CODE_USE_VERTEX",
      "CLAUDE_CODE_USE_FOUNDRY",
      "HTTPS_PROXY",
      "HTTP_PROXY",
      "NODE_TLS_REJECT_UNAUTHORIZED",
      "UNRELATED",
    ].map((key) => [key, "1"]));
    expect(findHomeAuthConflicts({
      apiKeyHelper: "/bin/key",
      awsCredentialExport: "/bin/aws-export",
      awsAuthRefresh: "aws sso login",
      env,
    })).toEqual([
      "apiKeyHelper",
      "awsCredentialExport",
      "awsAuthRefresh",
      "env.ANTHROPIC_API_KEY",
      "env.ANTHROPIC_AUTH_TOKEN",
      "env.CLAUDE_CODE_OAUTH_TOKEN",
      "env.ANTHROPIC_BASE_URL",
      "env.ANTHROPIC_BEDROCK_BASE_URL",
      "env.ANTHROPIC_VERTEX_BASE_URL",
      "env.AWS_BEARER_TOKEN_BEDROCK",
      "env.ANTHROPIC_CUSTOM_HEADERS",
      "env.CLAUDE_CODE_USE_BEDROCK",
      "env.CLAUDE_CODE_USE_VERTEX",
      "env.CLAUDE_CODE_USE_FOUNDRY",
      "env.HTTPS_PROXY",
      "env.HTTP_PROXY",
      "env.NODE_TLS_REJECT_UNAUTHORIZED",
    ]);
    expect(findHomeAuthConflicts({ model: "opus" })).toEqual([]);
  });
});

describe("summarizeMcpServer / readProjectMcpServers", () => {
  it("strips URL query strings and credentials", () => {
    expect(summarizeMcpServer("s", { type: "sse", url: "https://user:pw@host/sse?key=1#frag" }, "project")).toEqual({
      name: "s",
      origin: "project",
      transport: "sse",
      target: "https://host/sse",
      governed: false,
    });
    expect(summarizeMcpServer("p", { type: "http", url: "https://gw/mcp" }, "paperclip").governed).toBe(true);
  });

  it("reads the workspace .mcp.json as project servers", async () => {
    const cwd = await makeTmpDir();
    expect(await readProjectMcpServers(cwd)).toEqual([]);
    await writeFile(cwd, ".mcp.json", JSON.stringify({ mcpServers: { db: { command: "db-mcp" } } }));
    expect(await readProjectMcpServers(cwd)).toEqual([
      { name: "db", origin: "project", transport: "stdio", target: "db-mcp (0 args)", governed: false },
    ]);
  });
});
