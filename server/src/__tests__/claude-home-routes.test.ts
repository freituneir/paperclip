import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockLogActivity = vi.hoisted(() => vi.fn());
const mockAgentService = vi.hoisted(() => ({ getById: vi.fn() }));
const mockToolAccessService = vi.hoisted(() => ({ getEffectiveProfilesForAgent: vi.fn() }));

vi.mock("../services/index.js", () => ({
  logActivity: mockLogActivity,
}));
vi.mock("../services/agents.js", () => ({
  agentService: () => mockAgentService,
}));
vi.mock("../services/tool-access.js", () => ({
  toolAccessService: () => mockToolAccessService,
}));

const COMPANY_ID = "company-1";
const AGENT_ID = "11111111-1111-4111-8111-111111111111";

const boardActor = {
  type: "board",
  userId: "user-1",
  companyIds: [COMPANY_ID],
  source: "session",
  isInstanceAdmin: false,
};
const agentActor = {
  type: "agent",
  agentId: AGENT_ID,
  companyId: COMPANY_ID,
};

let actor: Record<string, unknown> = boardActor;
let rootDir = "";
const savedEnv = { root: process.env.PAPERCLIP_CLAUDE_HOME_ROOT };

async function createApp() {
  vi.resetModules();
  const [{ errorHandler }, { claudeHomeRoutes }] = await Promise.all([
    import("../middleware/index.js") as Promise<typeof import("../middleware/index.js")>,
    import("../routes/claude-home.js") as Promise<typeof import("../routes/claude-home.js")>,
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", claudeHomeRoutes({} as any));
  app.use(errorHandler);
  return app;
}

function homeDir() {
  return path.join(rootDir, COMPANY_ID);
}

describe("claude home routes", () => {
  beforeEach(async () => {
    actor = boardActor;
    mockLogActivity.mockReset();
    mockAgentService.getById.mockReset();
    mockToolAccessService.getEffectiveProfilesForAgent.mockReset();
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "claude-home-routes-"));
    process.env.PAPERCLIP_CLAUDE_HOME_ROOT = rootDir;
  });

  afterEach(async () => {
    if (savedEnv.root === undefined) delete process.env.PAPERCLIP_CLAUDE_HOME_ROOT;
    else process.env.PAPERCLIP_CLAUDE_HOME_ROOT = savedEnv.root;
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  it("GET on an empty home ensures the directory and returns exists:true", async () => {
    const app = await createApp();
    const res = await request(app).get(`/api/companies/${COMPANY_ID}/claude-home`);
    expect(res.status).toBe(200);
    expect(res.body.exists).toBe(true);
    expect(res.body.dir).toBe(homeDir());
    expect(res.body.mcpServers).toEqual([]);
    expect(res.body.settings).toBeNull();
    const stat = await fs.stat(homeDir());
    expect(stat.isDirectory()).toBe(true);
  });

  it("PUT settings keeps redacted secrets from disk and writes 0600", async () => {
    await fs.mkdir(homeDir(), { recursive: true });
    await fs.writeFile(
      path.join(homeDir(), "settings.json"),
      JSON.stringify({ env: { TOKEN: "s3" }, model: "opus" }),
    );
    const app = await createApp();
    const res = await request(app)
      .put(`/api/companies/${COMPANY_ID}/claude-home/settings`)
      .send({ settings: { env: { TOKEN: "__redacted__", NEW: "v" }, model: "sonnet" } });
    expect(res.status).toBe(200);
    expect(res.body.settings).toEqual({ env: { TOKEN: "__redacted__", NEW: "__redacted__" }, model: "sonnet" });
    const onDisk = JSON.parse(await fs.readFile(path.join(homeDir(), "settings.json"), "utf8"));
    expect(onDisk).toEqual({ env: { TOKEN: "s3", NEW: "v" }, model: "sonnet" });
    const mode = (await fs.stat(path.join(homeDir(), "settings.json"))).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "claude_home.settings_updated", companyId: COMPANY_ID }),
    );
  });

  it("PUT settings refuses to overwrite an unparseable settings.json with 422", async () => {
    await fs.mkdir(homeDir(), { recursive: true });
    await fs.writeFile(path.join(homeDir(), "settings.json"), "{not json");
    const app = await createApp();
    const res = await request(app)
      .put(`/api/companies/${COMPANY_ID}/claude-home/settings`)
      .send({ settings: { model: "opus" } });
    expect(res.status).toBe(422);
    expect(await fs.readFile(path.join(homeDir(), "settings.json"), "utf8")).toBe("{not json");
  });

  it("PUT settings rejects a non-object body with 400", async () => {
    const app = await createApp();
    const res = await request(app)
      .put(`/api/companies/${COMPANY_ID}/claude-home/settings`)
      .send({ settings: ["nope"] });
    expect(res.status).toBe(400);
  });

  it("PUT claude-md writes CLAUDE.md", async () => {
    const app = await createApp();
    const res = await request(app)
      .put(`/api/companies/${COMPANY_ID}/claude-home/claude-md`)
      .send({ content: "# Hello\n" });
    expect(res.status).toBe(200);
    expect(res.body.claudeMd).toBe("# Hello\n");
    expect(await fs.readFile(path.join(homeDir(), "CLAUDE.md"), "utf8")).toBe("# Hello\n");
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "claude_home.claude_md_updated" }),
    );
  });

  it("PUT an MCP server with an invalid name returns 400", async () => {
    const app = await createApp();
    const res = await request(app)
      .put(`/api/companies/${COMPANY_ID}/claude-home/mcp-servers/bad%20name!`)
      .send({ config: { type: "http", url: "https://example.com/mcp" } });
    expect(res.status).toBe(400);
  });

  it("PUT a stdio MCP server without a command returns 400", async () => {
    const app = await createApp();
    const res = await request(app)
      .put(`/api/companies/${COMPANY_ID}/claude-home/mcp-servers/local`)
      .send({ config: { type: "stdio", args: ["x"] } });
    expect(res.status).toBe(400);
  });

  it("PUT an http MCP server without a url returns 400", async () => {
    const app = await createApp();
    const res = await request(app)
      .put(`/api/companies/${COMPANY_ID}/claude-home/mcp-servers/remote`)
      .send({ config: { type: "http" } });
    expect(res.status).toBe(400);
  });

  it("upserts an MCP server, preserves other .claude.json keys, redacts headers, then deletes it", async () => {
    await fs.mkdir(homeDir(), { recursive: true });
    await fs.writeFile(
      path.join(homeDir(), ".claude.json"),
      JSON.stringify({ numStartups: 7, projects: { "/w": { allowedTools: [] } } }),
    );
    const app = await createApp();
    const put = await request(app)
      .put(`/api/companies/${COMPANY_ID}/claude-home/mcp-servers/linear`)
      .send({
        config: {
          type: "http",
          url: "https://mcp.linear.app/mcp?token=abc",
          headers: { Authorization: "Bearer secret" },
        },
      });
    expect(put.status).toBe(200);
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "claude_home.mcp_server_upserted", entityId: "linear" }),
    );

    const get = await request(app).get(`/api/companies/${COMPANY_ID}/claude-home`);
    expect(get.status).toBe(200);
    const server = get.body.mcpServers.find((entry: { name: string }) => entry.name === "linear");
    expect(server).toMatchObject({
      name: "linear",
      origin: "claude_home",
      governed: false,
      transport: "http",
      target: "https://mcp.linear.app/mcp",
      headerKeys: ["Authorization"],
    });
    expect(JSON.stringify(get.body)).not.toContain("Bearer secret");
    expect(get.body.mcpServerConfigs.linear.headers).toEqual({ Authorization: "__redacted__" });

    // Round-trip with the redacted placeholder keeps the on-disk secret.
    const roundTrip = await request(app)
      .put(`/api/companies/${COMPANY_ID}/claude-home/mcp-servers/linear`)
      .send({ config: get.body.mcpServerConfigs.linear });
    expect(roundTrip.status).toBe(200);

    let onDisk = JSON.parse(await fs.readFile(path.join(homeDir(), ".claude.json"), "utf8"));
    expect(onDisk.numStartups).toBe(7);
    expect(onDisk.projects).toEqual({ "/w": { allowedTools: [] } });
    expect(onDisk.mcpServers.linear.headers).toEqual({ Authorization: "Bearer secret" });
    expect((await fs.stat(path.join(homeDir(), ".claude.json"))).mode & 0o777).toBe(0o600);

    const del = await request(app).delete(`/api/companies/${COMPANY_ID}/claude-home/mcp-servers/linear`);
    expect(del.status).toBe(200);
    expect(del.body.mcpServers).toEqual([]);
    onDisk = JSON.parse(await fs.readFile(path.join(homeDir(), ".claude.json"), "utf8"));
    expect(onDisk.mcpServers).toEqual({});
    expect(onDisk.numStartups).toBe(7);
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "claude_home.mcp_server_deleted", entityId: "linear" }),
    );
  });

  it("DELETE of an unknown MCP server returns 404", async () => {
    const app = await createApp();
    const res = await request(app).delete(`/api/companies/${COMPANY_ID}/claude-home/mcp-servers/missing`);
    expect(res.status).toBe(404);
  });

  it("refuses MCP writes when .claude.json cannot be parsed", async () => {
    await fs.mkdir(homeDir(), { recursive: true });
    await fs.writeFile(path.join(homeDir(), ".claude.json"), "{broken");
    const app = await createApp();
    const res = await request(app)
      .put(`/api/companies/${COMPANY_ID}/claude-home/mcp-servers/x`)
      .send({ config: { command: "npx", args: ["x"] } });
    expect(res.status).toBe(422);
    expect(await fs.readFile(path.join(homeDir(), ".claude.json"), "utf8")).toBe("{broken");
  });

  it("an agent actor cannot write the Claude Home (403)", async () => {
    actor = agentActor;
    const app = await createApp();
    const res = await request(app)
      .put(`/api/companies/${COMPANY_ID}/claude-home/settings`)
      .send({ settings: { model: "opus" } });
    expect(res.status).toBe(403);
    const get = await request(app).get(`/api/companies/${COMPANY_ID}/claude-home`);
    expect(get.status).toBe(403);
  });

  it("a board user without access to the company gets 403", async () => {
    const app = await createApp();
    const res = await request(app).get(`/api/companies/company-2/claude-home`);
    expect(res.status).toBe(403);
    const put = await request(app)
      .put(`/api/companies/company-2/claude-home/claude-md`)
      .send({ content: "x" });
    expect(put.status).toBe(403);
  });

  describe("claude-setup", () => {
    function claudeAgent(adapterConfig: Record<string, unknown> = {}) {
      return {
        id: AGENT_ID,
        companyId: COMPANY_ID,
        name: "Coder",
        adapterType: "claude_local",
        adapterConfig,
      };
    }

    it("returns a version 1 manifest for a claude_local agent", async () => {
      await fs.mkdir(homeDir(), { recursive: true });
      await fs.writeFile(
        path.join(homeDir(), ".claude.json"),
        JSON.stringify({ mcpServers: { native: { command: "npx", args: ["-y", "x"], env: { KEY: "secret" } } } }),
      );
      mockAgentService.getById.mockResolvedValue(
        claudeAgent({
          engine: "cli",
          model: "claude-opus-5-5",
          effort: "xhigh",
          instructionsFilePath: "/tmp/AGENTS.md",
          claudePermissionMode: "acceptEdits",
        }),
      );
      mockToolAccessService.getEffectiveProfilesForAgent.mockResolvedValue({
        agentId: AGENT_ID,
        profiles: [],
        bindings: [],
        entries: [{ effect: "include", connectionId: "conn-1" }],
        allowedTools: [],
        allowedToolNames: [],
        installedConnections: [
          { id: "conn-1", name: "GitHub", status: "active", enabled: true, transport: "mcp_remote", healthStatus: "healthy" },
          { id: "conn-2", name: "Unpermitted", status: "active", enabled: true, transport: "mcp_remote", healthStatus: "healthy" },
        ],
      });
      const app = await createApp();
      const res = await request(app).get(`/api/companies/${COMPANY_ID}/agents/${AGENT_ID}/claude-setup`);
      expect(res.status).toBe(200);
      expect(res.body.version).toBe(1);
      expect(res.body.engine).toBe("cli");
      expect(res.body.model).toBe("claude-opus-5-5");
      expect(res.body.effort).toBe("xhigh");
      expect(res.body.permission).toEqual({ mode: "acceptEdits", source: "claudePermissionMode" });
      expect(res.body.instructions).toEqual({ path: "/tmp/AGENTS.md", delivery: "system_prompt_append" });
      expect(res.body.claudeHome).toEqual({ mode: "company", dir: homeDir() });
      const names = res.body.mcpServers.map((server: { name: string; origin: string }) => `${server.origin}:${server.name}`);
      expect(names).toEqual(
        expect.arrayContaining([
          "paperclip:paperclip-assigned",
          "paperclip:GitHub",
          "paperclip:Paperclip connections",
          "paperclip:Paperclip projects",
          "claude_home:native",
        ]),
      );
      expect(names).not.toContain("paperclip:Unpermitted");
      expect(JSON.stringify(res.body)).not.toContain("secret");
    });

    it("uses acp defaults and user_prompt_prefix delivery", async () => {
      mockAgentService.getById.mockResolvedValue(claudeAgent({ instructionsFilePath: "/tmp/AGENTS.md" }));
      mockToolAccessService.getEffectiveProfilesForAgent.mockResolvedValue({
        agentId: AGENT_ID, profiles: [], bindings: [], entries: [], allowedTools: [], allowedToolNames: [], installedConnections: [],
      });
      const app = await createApp();
      const res = await request(app).get(`/api/companies/${COMPANY_ID}/agents/${AGENT_ID}/claude-setup`);
      expect(res.status).toBe(200);
      expect(res.body.engine).toBe("acp");
      expect(res.body.instructions.delivery).toBe("user_prompt_prefix");
      expect(res.body.mcpServers.map((server: { name: string }) => server.name)).not.toContain("paperclip-assigned");
    });

    it("allows a same-company agent actor to read it", async () => {
      actor = agentActor;
      mockAgentService.getById.mockResolvedValue(claudeAgent());
      mockToolAccessService.getEffectiveProfilesForAgent.mockResolvedValue({
        agentId: AGENT_ID, profiles: [], bindings: [], entries: [], allowedTools: [], allowedToolNames: [], installedConnections: [],
      });
      const app = await createApp();
      const res = await request(app).get(`/api/companies/${COMPANY_ID}/agents/${AGENT_ID}/claude-setup`);
      expect(res.status).toBe(200);
      expect(res.body.instructions.delivery).toBe("none");
    });

    it("returns 422 for a non claude_local agent", async () => {
      mockAgentService.getById.mockResolvedValue({ ...claudeAgent(), adapterType: "codex_local" });
      const app = await createApp();
      const res = await request(app).get(`/api/companies/${COMPANY_ID}/agents/${AGENT_ID}/claude-setup`);
      expect(res.status).toBe(422);
    });

    it("returns 404 for an agent in another company", async () => {
      mockAgentService.getById.mockResolvedValue({ ...claudeAgent(), companyId: "company-2" });
      const app = await createApp();
      const res = await request(app).get(`/api/companies/${COMPANY_ID}/agents/${AGENT_ID}/claude-setup`);
      expect(res.status).toBe(404);
    });
  });
});
