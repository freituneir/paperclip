import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockLogActivity = vi.hoisted(() => vi.fn());
const mockAccessService = vi.hoisted(() => ({ decide: vi.fn() }));

vi.mock("../services/index.js", () => ({
  logActivity: mockLogActivity,
  accessService: () => mockAccessService,
}));
vi.mock("../services/agents.js", () => ({ agentService: () => ({}) }));
vi.mock("../services/tool-access.js", () => ({ toolAccessService: () => ({}) }));

const COMPANY_ID = "company-1";
const boardActor = {
  type: "board",
  userId: "user-1",
  companyIds: [COMPANY_ID],
  source: "session",
  isInstanceAdmin: false,
};

// A fake `claude` binary: records argv/env/cwd per invocation and prints fixture
// output per subcommand. Behaviour switches come from state.json next to it
// (the CLI gets a minimal env, so paths are baked in).
const FAKE_CLI = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const DIR = __DIR__;
const log = (entry) => fs.appendFileSync(path.join(DIR, "calls.jsonl"), JSON.stringify(entry) + "\n");
let state = {};
try { state = JSON.parse(fs.readFileSync(path.join(DIR, "state.json"), "utf8")); } catch {}
const args = process.argv.slice(2);
log({ argv: args, env: process.env, cwd: process.cwd(), pid: process.pid, at: Date.now() });
const cmd = args.slice(0, 2).join(" ");
const out = (s) => process.stdout.write(s);
const fail = (msg) => { process.stderr.write(msg); process.exit(1); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  if (cmd === "mcp list") {
    if (state.mcpList === "empty") return out("No MCP servers configured. Use \u0060claude mcp add\u0060 to add a server.\n");
    if (state.mcpList === "fail") return fail("\n  Error: config is broken\n");
    out("Checking MCP server health...\n\n");
    out("probe: http://127.0.0.1:9/mcp (HTTP) - ✘ Failed to connect — ECONNREFUSED 127.0.0.1:9\n");
    out("\u001b[32msecret-http\u001b[0m: https://user:pw@api.example.com/mcp?token=abc123 (HTTP) - ✓ Connected\n");
    out("plugin:linear:linear: https://mcp.linear.app/mcp (HTTP) - ⚠ Needs authentication\n");
    out("claude.ai Gmail: https://gmail.mcp.claude.com/mcp - ✓ Connected\n");
    out("local: npx -y some-server --api-key sk-live-123 --token=abc API_TOKEN=xyz - ⏸ Pending approval\n");
    return;
  }
  if (cmd === "mcp login") {
    out("Open this URL to sign in:\nhttps://auth.example.com/authorize?client_id=c&state=s\nPaste the redirect URL: ");
    if (state.loginHang) { await sleep(600000); return; }
    let input = "";
    process.stdin.on("data", (d) => {
      input += d;
      if (input.includes("\n")) { log({ loginInput: input }); out("✔ Signed in\n"); process.exit(0); }
    });
    return;
  }
  if (cmd === "mcp add-json" || cmd === "mcp remove" || cmd === "mcp logout") {
    if (args[2] === "boom") fail("Error: upstream said Authorization: Bearer sk-ant-secretvalue123456 nope\n");
    return out("ok\n");
  }
  if (cmd === "plugin list") {
    if (state.pluginList === "json") {
      return out(JSON.stringify([{ id: "linear@official", version: "1.2.0", scope: "user", enabled: true, installPath: "/x", installedAt: "2026-01-01T00:00:00Z", lastUpdated: "2026-01-02T00:00:00Z" }]));
    }
    return fail("Not logged in · Please run /login\n");
  }
  if (cmd === "plugin marketplace") {
    if (args[2] === "list") {
      return out(JSON.stringify([
        { name: "official", source: "github", repo: "anthropics/claude-plugins-official", installLocation: "/x/official" },
        { name: "byurl", source: "url", url: "https://example.com/m.json?sig=secret", installLocation: "/x/byurl" },
      ]));
    }
    if (state.slowMs) await sleep(state.slowMs);
    return out("ok\n");
  }
  if (cmd === "plugin install" || cmd === "plugin uninstall" || cmd === "plugin enable" || cmd === "plugin disable" || cmd === "plugin update") {
    if (state.slowMs) await sleep(state.slowMs);
    log({ end: args[2], at: Date.now() });
    return out("✔ Successfully installed plugin: " + args[2] + "\n");
  }
  if (cmd === "plugin details") return out("\u001b[1mlinear\u001b[0m\nComponents: 1 MCP server\nToken cost: ~1.2k\n");
  fail("unknown command " + args.join(" ") + "\n");
})();
`;

let actor: Record<string, unknown> = boardActor;
let rootDir = "";
let fakeDir = "";
const savedEnv = {
  root: process.env.PAPERCLIP_CLAUDE_HOME_ROOT,
  bin: process.env.PAPERCLIP_CLAUDE_BIN,
  apiKey: process.env.ANTHROPIC_API_KEY,
  oauth: process.env.CLAUDE_CODE_OAUTH_TOKEN,
  telemetry: process.env.DISABLE_TELEMETRY,
};

async function createApp(deps: Record<string, unknown> = {}) {
  vi.resetModules();
  const [{ errorHandler }, { claudeCliRoutes }] = await Promise.all([
    import("../middleware/index.js") as Promise<typeof import("../middleware/index.js")>,
    import("../routes/claude-cli.js") as Promise<typeof import("../routes/claude-cli.js")>,
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", claudeCliRoutes({} as any, deps));
  app.use(errorHandler);
  return app;
}

function homeDir() {
  return path.join(rootDir, COMPANY_ID);
}

async function setState(state: Record<string, unknown>) {
  await fs.writeFile(path.join(fakeDir, "state.json"), JSON.stringify(state));
}

async function calls(): Promise<any[]> {
  try {
    const raw = await fs.readFile(path.join(fakeDir, "calls.jsonl"), "utf8");
    return raw.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

async function argvs(): Promise<string[][]> {
  return (await calls()).filter((c) => c.argv).map((c) => c.argv);
}

function isAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check: () => Promise<boolean> | boolean, timeoutMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("waitFor timed out");
}

const base = `/api/companies/${COMPANY_ID}/claude-home`;

describe("claude cli routes", () => {
  beforeEach(async () => {
    actor = boardActor;
    mockLogActivity.mockReset();
    mockAccessService.decide.mockReset();
    mockAccessService.decide.mockResolvedValue({ allowed: true, reason: "allow_explicit_grant", explanation: "ok" });
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "claude-cli-routes-"));
    fakeDir = await fs.mkdtemp(path.join(os.tmpdir(), "claude-cli-fake-"));
    const script = `#!${process.execPath}\n${FAKE_CLI.replace("__DIR__", JSON.stringify(fakeDir))}`;
    await fs.writeFile(path.join(fakeDir, "claude"), script, { mode: 0o755 });
    await setState({});
    process.env.PAPERCLIP_CLAUDE_HOME_ROOT = rootDir;
    process.env.PAPERCLIP_CLAUDE_BIN = path.join(fakeDir, "claude");
    process.env.ANTHROPIC_API_KEY = "sk-ant-should-not-leak";
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "oauth-should-not-leak";
    process.env.DISABLE_TELEMETRY = "1";
  });

  afterEach(async () => {
    for (const [key, name] of [
      ["root", "PAPERCLIP_CLAUDE_HOME_ROOT"],
      ["bin", "PAPERCLIP_CLAUDE_BIN"],
      ["apiKey", "ANTHROPIC_API_KEY"],
      ["oauth", "CLAUDE_CODE_OAUTH_TOKEN"],
      ["telemetry", "DISABLE_TELEMETRY"],
    ] as const) {
      if (savedEnv[key] === undefined) delete process.env[name];
      else process.env[name] = savedEnv[key];
    }
    await fs.rm(rootDir, { recursive: true, force: true });
    await fs.rm(fakeDir, { recursive: true, force: true });
  });

  it("lists MCP servers via argv arrays with a minimal env and parses origins, status and redaction", async () => {
    await fs.mkdir(path.join(homeDir(), "plugins"), { recursive: true });
    await fs.writeFile(
      path.join(homeDir(), "plugins", "installed_plugins.json"),
      JSON.stringify({ version: 2, plugins: { "linear@official": [{ scope: "user", version: "1.0.0" }] } }),
    );
    const app = await createApp();
    const res = await request(app).get(`${base}/mcp`);
    expect(res.status).toBe(200);
    expect(res.body.cliAvailable).toBe(true);
    expect(res.body.error).toBeNull();

    const [call] = await calls();
    expect(call.argv).toEqual(["mcp", "list"]);
    expect(call.cwd).toBe(await fs.realpath(homeDir()));
    expect(call.env.CLAUDE_CONFIG_DIR).toBe(homeDir());
    expect(call.env.DISABLE_TELEMETRY).toBe("1");
    expect(call.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(call.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(call.env.PAPERCLIP_CLAUDE_HOME_ROOT).toBeUndefined();
    expect(call.env.HOME).not.toBe(os.homedir());
    expect(Object.keys(call.env).sort()).toEqual(
      expect.arrayContaining(["CLAUDE_CONFIG_DIR", "DISABLE_TELEMETRY", "HOME", "PATH"]),
    );

    const byName = Object.fromEntries(res.body.servers.map((s: any) => [s.name, s]));
    expect(Object.keys(byName)).toEqual(["probe", "secret-http", "plugin:linear:linear", "claude.ai Gmail", "local"]);
    expect(byName.probe).toMatchObject({
      origin: "claude_home",
      target: "http://127.0.0.1:9/mcp",
      transport: "HTTP",
      status: "failed",
      removable: true,
      supportsLogin: true,
    });
    expect(byName.probe.statusText).toContain("Failed to connect");
    expect(byName["secret-http"]).toMatchObject({
      status: "connected",
      target: "https://api.example.com/mcp",
    });
    expect(byName["plugin:linear:linear"]).toMatchObject({
      origin: "plugin",
      pluginId: "linear@official",
      status: "needs_auth",
      removable: false,
      supportsLogin: true,
    });
    expect(byName["claude.ai Gmail"]).toMatchObject({
      origin: "claude_ai",
      transport: null,
      status: "connected",
      removable: false,
      supportsLogin: true,
    });
    expect(byName.local).toMatchObject({ origin: "claude_home", status: "pending_approval", supportsLogin: false });
    expect(byName.local.target).toBe("npx -y some-server --api-key ***REDACTED*** --token=***REDACTED*** API_TOKEN=***REDACTED***");
    expect(JSON.stringify(res.body)).not.toMatch(/abc123|sk-live-123|xyz|user:pw/);
  });

  it("handles an empty MCP list and a failing list command", async () => {
    await setState({ mcpList: "empty" });
    const app = await createApp();
    const empty = await request(app).get(`${base}/mcp`);
    expect(empty.status).toBe(200);
    expect(empty.body.servers).toEqual([]);

    await setState({ mcpList: "fail" });
    const failed = await request(app).get(`${base}/mcp`);
    expect(failed.status).toBe(200);
    expect(failed.body.cliAvailable).toBe(true);
    expect(failed.body.error).toBe("Error: config is broken");
  });

  it("falls back to the file inventory when the binary is missing, and mutations answer 503", async () => {
    process.env.PAPERCLIP_CLAUDE_BIN = path.join(fakeDir, "does-not-exist");
    await fs.mkdir(homeDir(), { recursive: true });
    await fs.writeFile(
      path.join(homeDir(), ".claude.json"),
      JSON.stringify({ mcpServers: { files: { type: "http", url: "https://x.example.com/mcp?k=1" } } }),
    );
    const app = await createApp();
    const res = await request(app).get(`${base}/mcp`);
    expect(res.status).toBe(200);
    expect(res.body.cliAvailable).toBe(false);
    expect(res.body.servers).toEqual([
      expect.objectContaining({ name: "files", origin: "claude_home", transport: "HTTP", status: "unknown" }),
    ]);
    expect(res.body.servers[0].target).not.toContain("k=1");

    const install = await request(app).post(`${base}/plugins/install`).send({ id: "linear@official" });
    expect(install.status).toBe(503);
    expect(install.body.code).toBe("claude_cli_unavailable");
    expect(mockLogActivity).not.toHaveBeenCalled();

    const plugins = await request(app).get(`${base}/plugins`);
    expect(plugins.status).toBe(200);
    expect(plugins.body.cliAvailable).toBe(false);
  });

  it("adds and removes MCP servers with exact argv and logs activity", async () => {
    const app = await createApp();
    const add = await request(app)
      .post(`${base}/mcp`)
      .send({ name: "linear", config: { type: "http", url: "https://mcp.linear.app/mcp", headers: { A: "b" } } });
    expect(add.status).toBe(200);
    expect(Array.isArray(add.body.servers)).toBe(true);
    const del = await request(app).delete(`${base}/mcp/linear`);
    expect(del.status).toBe(200);
    const logout = await request(app).post(`${base}/mcp/linear/logout`);
    expect(logout.status).toBe(200);

    expect(await argvs()).toEqual([
      [
        "mcp",
        "add-json",
        "linear",
        JSON.stringify({ type: "http", url: "https://mcp.linear.app/mcp", headers: { A: "b" } }),
        "--scope",
        "user",
      ],
      ["mcp", "list"],
      ["mcp", "remove", "linear", "--scope", "user"],
      ["mcp", "list"],
      ["mcp", "logout", "linear"],
      ["mcp", "list"],
    ]);
    const actions = mockLogActivity.mock.calls.map((c) => c[1]);
    expect(actions).toEqual([
      expect.objectContaining({ action: "claude_cli.mcp_added", details: { target: "linear" }, companyId: COMPANY_ID }),
      expect.objectContaining({ action: "claude_cli.mcp_removed", details: { target: "linear" } }),
      expect.objectContaining({ action: "claude_cli.mcp_logged_out", details: { target: "linear" } }),
    ]);
  });

  it("returns 422 with the first redacted CLI error line on a non-zero exit", async () => {
    const app = await createApp();
    const res = await request(app).delete(`${base}/mcp/boom`);
    expect(res.status).toBe(422);
    expect(res.body.error).toContain("Error: upstream said");
    expect(res.body.error).not.toContain("sk-ant-secretvalue123456");
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("rejects invalid input with 400 without spawning", async () => {
    const app = await createApp();
    const cases: [string, string, Record<string, unknown>?][] = [
      ["post", `${base}/mcp`, { name: "bad name!", config: { type: "http", url: "https://x" } }],
      ["post", `${base}/mcp`, { name: "ok", config: { type: "ftp", url: "ftp://x" } }],
      ["post", `${base}/mcp`, { name: "ok", config: { type: "stdio" } }],
      ["post", `${base}/mcp`, { name: "ok", config: { type: "http", url: "https://x", headers: { A: "__redacted__" } } }],
      ["delete", `${base}/mcp/plugin:linear:linear`],
      ["delete", `${base}/mcp/--scope`],
      ["delete", `${base}/marketplaces/-rf`],
      ["delete", `${base}/mcp/${encodeURIComponent("a;rm -rf")}`],
      ["post", `${base}/marketplaces`, { source: "/etc/passwd" }],
      ["post", `${base}/marketplaces`, { source: "./local" }],
      ["post", `${base}/marketplaces`, { source: "http://insecure.example.com/m.json" }],
      ["post", `${base}/marketplaces`, { source: "--help" }],
      ["post", `${base}/marketplaces`, { source: "file:///tmp/x" }],
      ["delete", `${base}/marketplaces/%24bad`],
      ["post", `${base}/marketplaces/update`, { name: "../x" }],
      ["post", `${base}/plugins/install`, { id: "bad id" }],
      ["post", `${base}/plugins/install`, { id: "--force" }],
      ["post", `${base}/plugins/${encodeURIComponent("a@b@c")}/enable`],
      ["get", `${base}/plugins/${encodeURIComponent("x y")}/details`],
      ["post", `${base}/mcp/${encodeURIComponent("bad name")}/login`],
    ];
    for (const [method, url, body] of cases) {
      const res = await (request(app) as any)[method](url).send(body ?? {});
      expect(res.status, `${method} ${url} ${JSON.stringify(body)}`).toBe(400);
    }
    expect(await calls()).toEqual([]);
  });

  it("accepts allowed marketplace sources and redacts marketplace URLs", async () => {
    const app = await createApp();
    for (const source of [
      "anthropics/claude-plugins-official",
      "https://github.com/acme/plugins.git",
      "git@github.com:acme/plugins.git",
    ]) {
      const res = await request(app).post(`${base}/marketplaces`).send({ source });
      expect(res.status).toBe(200);
    }
    const res = await request(app).get(`${base}/marketplaces`);
    expect(res.body).toEqual({
      cliAvailable: true,
      marketplaces: [
        { name: "official", source: "github", location: "anthropics/claude-plugins-official", pluginCount: null },
        { name: "byurl", source: "url", location: "https://example.com/m.json", pluginCount: null },
      ],
    });
    const adds = (await argvs()).filter((a) => a[2] === "add");
    expect(adds).toEqual([
      ["plugin", "marketplace", "add", "anthropics/claude-plugins-official"],
      ["plugin", "marketplace", "add", "https://github.com/acme/plugins.git"],
      ["plugin", "marketplace", "add", "git@github.com:acme/plugins.git"],
    ]);
    await request(app).post(`${base}/marketplaces/update`).send({});
    await request(app).post(`${base}/marketplaces/update`).send({ name: "official" });
    await request(app).delete(`${base}/marketplaces/official`);
    const rest = (await argvs()).filter((a) => a[2] === "update" || a[2] === "remove");
    expect(rest).toEqual([
      ["plugin", "marketplace", "update"],
      ["plugin", "marketplace", "update", "official"],
      ["plugin", "marketplace", "remove", "official"],
    ]);
    expect(mockLogActivity.mock.calls.map((c) => c[1].action)).toEqual([
      "claude_cli.marketplace_added",
      "claude_cli.marketplace_added",
      "claude_cli.marketplace_added",
      "claude_cli.marketplace_updated",
      "claude_cli.marketplace_updated",
      "claude_cli.marketplace_removed",
    ]);
  });

  it("reads the plugin catalog from marketplace.json with installed flags", async () => {
    const catalogDir = path.join(homeDir(), "plugins", "marketplaces", "official", ".claude-plugin");
    await fs.mkdir(catalogDir, { recursive: true });
    await fs.writeFile(
      path.join(catalogDir, "marketplace.json"),
      JSON.stringify({
        name: "official",
        plugins: [
          {
            name: "linear",
            displayName: "Linear",
            description: "Issues",
            category: "productivity",
            tags: ["pm"],
            keywords: ["issues", "pm"],
            author: { name: "Linear Inc" },
            homepage: "https://linear.app?ref=x",
            version: "1.2.0",
          },
          { name: "github", description: "Repos", author: "GitHub" },
          { description: "no name, skipped" },
        ],
      }),
    );
    await setState({ pluginList: "json" });
    const app = await createApp();
    const res = await request(app).get(`${base}/plugins`);
    expect(res.status).toBe(200);
    expect(res.body.cliAvailable).toBe(true);
    expect(res.body.installed).toEqual([
      {
        id: "linear@official",
        version: "1.2.0",
        scope: "user",
        enabled: true,
        installedAt: "2026-01-01T00:00:00Z",
        lastUpdated: "2026-01-02T00:00:00Z",
      },
    ]);
    expect(res.body.available).toEqual([
      {
        id: "linear@official",
        name: "linear",
        marketplace: "official",
        displayName: "Linear",
        description: "Issues",
        category: "productivity",
        tags: ["pm", "issues"],
        author: "Linear Inc",
        homepage: "https://linear.app/",
        version: "1.2.0",
        installed: true,
      },
      {
        id: "github@official",
        name: "github",
        marketplace: "official",
        displayName: null,
        description: "Repos",
        category: null,
        tags: [],
        author: "GitHub",
        homepage: null,
        version: null,
        installed: false,
      },
    ]);
    const markets = await request(app).get(`${base}/marketplaces`);
    expect(markets.body.marketplaces[0].pluginCount).toBe(2);
  });

  it("treats 'Not logged in' plugin list as empty and falls back to installed_plugins.json", async () => {
    const app = await createApp();
    const empty = await request(app).get(`${base}/plugins`);
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual({ installed: [], available: [], cliAvailable: true });

    await fs.mkdir(path.join(homeDir(), "plugins"), { recursive: true });
    await fs.writeFile(
      path.join(homeDir(), "plugins", "installed_plugins.json"),
      JSON.stringify({ version: 2, plugins: { "a@m": [{ scope: "user", version: "0.1.0", installedAt: "t1" }] } }),
    );
    await fs.writeFile(path.join(homeDir(), "settings.json"), JSON.stringify({ enabledPlugins: { "a@m": false } }));
    const res = await request(app).get(`${base}/plugins`);
    expect(res.body.installed).toEqual([
      { id: "a@m", version: "0.1.0", scope: "user", enabled: false, installedAt: "t1", lastUpdated: null },
    ]);
  });

  it("runs plugin actions with exact argv, logs them, and returns details text", async () => {
    const app = await createApp();
    expect((await request(app).post(`${base}/plugins/install`).send({ id: "linear@official" })).status).toBe(200);
    expect((await request(app).post(`${base}/plugins/linear@official/disable`)).status).toBe(200);
    expect((await request(app).post(`${base}/plugins/linear@official/enable`)).status).toBe(200);
    expect((await request(app).post(`${base}/plugins/linear@official/update`)).status).toBe(200);
    expect((await request(app).delete(`${base}/plugins/linear@official`)).status).toBe(200);
    const details = await request(app).get(`${base}/plugins/linear@official/details`);
    expect(details.body).toEqual({ text: "linear\nComponents: 1 MCP server\nToken cost: ~1.2k" });
    const actions = (await argvs()).filter((a) => a[1] !== "list");
    expect(actions).toEqual([
      ["plugin", "install", "linear@official"],
      ["plugin", "disable", "linear@official"],
      ["plugin", "enable", "linear@official"],
      ["plugin", "update", "linear@official"],
      ["plugin", "uninstall", "linear@official"],
      ["plugin", "details", "linear@official"],
    ]);
    expect(mockLogActivity.mock.calls.map((c) => c[1].action)).toEqual([
      "claude_cli.plugin_installed",
      "claude_cli.plugin_disabled",
      "claude_cli.plugin_enabled",
      "claude_cli.plugin_updated",
      "claude_cli.plugin_uninstalled",
    ]);
  });

  it("serializes concurrent mutations per company", async () => {
    await setState({ slowMs: 300 });
    const app = await createApp();
    const [a, b] = await Promise.all([
      request(app).post(`${base}/plugins/install`).send({ id: "one@m" }),
      request(app).post(`${base}/plugins/install`).send({ id: "two@m" }),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const all = await calls();
    const starts = all.filter((c) => c.argv?.[1] === "install");
    const ends = all.filter((c) => c.end);
    expect(starts).toHaveLength(2);
    const [first, second] = starts.sort((x, y) => x.at - y.at);
    const firstEnd = ends.find((e) => e.end === first.argv[2]);
    expect(second.at).toBeGreaterThanOrEqual(firstEnd.at);
  });

  it("denies without agents:create and for non-board actors", async () => {
    mockAccessService.decide.mockResolvedValue({ allowed: false, reason: "deny", explanation: "nope" });
    const app = await createApp();
    expect((await request(app).get(`${base}/mcp`)).status).toBe(403);
    expect((await request(app).post(`${base}/plugins/install`).send({ id: "a@b" })).status).toBe(403);
    actor = { type: "agent", agentId: "a", companyId: COMPANY_ID };
    expect((await request(app).get(`${base}/plugins`)).status).toBe(403);
    expect(await calls()).toEqual([]);
  });

  it("runs the no-browser login flow: start → complete writes stdin and ends the process", async () => {
    const app = await createApp();
    const start = await request(app).post(`${base}/mcp/probe/login`);
    expect(start.status).toBe(200);
    expect(start.body.authUrl).toBe("https://auth.example.com/authorize?client_id=c&state=s");
    expect(typeof start.body.sessionId).toBe("string");
    const loginCall = (await calls()).find((c) => c.argv?.[1] === "login");
    expect(loginCall.argv).toEqual(["mcp", "login", "probe", "--no-browser"]);

    const bad = await request(app)
      .post(`${base}/mcp/login/${start.body.sessionId}/complete`)
      .send({ redirectUrl: "javascript:alert(1)" });
    expect(bad.status).toBe(400);

    const done = await request(app)
      .post(`${base}/mcp/login/${start.body.sessionId}/complete`)
      .send({ redirectUrl: "http://localhost:5555/callback?code=abc&state=s" });
    expect(done.status).toBe(200);
    expect(Array.isArray(done.body.servers)).toBe(true);
    const input = (await calls()).find((c) => c.loginInput);
    expect(input.loginInput).toBe("http://localhost:5555/callback?code=abc&state=s\n");
    expect(isAlive(loginCall.pid)).toBe(false);

    const again = await request(app)
      .post(`${base}/mcp/login/${start.body.sessionId}/complete`)
      .send({ redirectUrl: "http://localhost:5555/callback" });
    expect(again.status).toBe(404);
    expect(mockLogActivity.mock.calls.map((c) => c[1].action)).toEqual([
      "claude_cli.mcp_login_started",
      "claude_cli.mcp_login_completed",
    ]);
  });

  it("cancels a login session and kills the process", async () => {
    await setState({ loginHang: true });
    const app = await createApp();
    const start = await request(app).post(`${base}/mcp/probe/login`);
    expect(start.status).toBe(200);
    const pid = (await calls()).find((c) => c.argv?.[1] === "login").pid;
    expect(isAlive(pid)).toBe(true);
    const cancel = await request(app).delete(`${base}/mcp/login/${start.body.sessionId}`);
    expect(cancel.status).toBe(204);
    await waitFor(() => !isAlive(pid));
    const complete = await request(app)
      .post(`${base}/mcp/login/${start.body.sessionId}/complete`)
      .send({ redirectUrl: "http://localhost/cb" });
    expect(complete.status).toBe(404);
  });

  it("expires login sessions after the TTL and kills the process", async () => {
    await setState({ loginHang: true });
    const app = await createApp({ loginTtlMs: 200 });
    const { activeClaudeCliLoginSessions } = await import("../services/claude-cli.js");
    const start = await request(app).post(`${base}/mcp/probe/login`);
    expect(start.status).toBe(200);
    expect(activeClaudeCliLoginSessions()).toBe(1);
    const pid = (await calls()).find((c) => c.argv?.[1] === "login").pid;
    await waitFor(() => !isAlive(pid));
    expect(activeClaudeCliLoginSessions()).toBe(0);
    const complete = await request(app)
      .post(`${base}/mcp/login/${start.body.sessionId}/complete`)
      .send({ redirectUrl: "http://localhost/cb" });
    expect(complete.status).toBe(404);
  });

  it("replaces an existing login session for the same server", async () => {
    await setState({ loginHang: true });
    const app = await createApp();
    const first = await request(app).post(`${base}/mcp/probe/login`);
    const firstPid = (await calls()).find((c) => c.argv?.[1] === "login").pid;
    const second = await request(app).post(`${base}/mcp/probe/login`);
    expect(second.body.sessionId).not.toBe(first.body.sessionId);
    await waitFor(() => !isAlive(firstPid));
    await request(app).delete(`${base}/mcp/login/${second.body.sessionId}`);
  });
});
