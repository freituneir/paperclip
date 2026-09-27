// @vitest-environment jsdom

import type { ComponentProps } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  CLAUDE_REDACTED_VALUE,
  type ClaudeCliAvailablePlugin,
  type ClaudeCliMcpServer,
  type ClaudeCliPluginsResponse,
  type ClaudeHomeInventory,
} from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/client";
import { ClaudeHome } from "./ClaudeHome";
import {
  hasRedactedSecrets,
  mcpServerConfigFromForm,
  mcpServerFormFromConfig,
  validateMcpServerForm,
} from "./claude-home/mcp-server-form";

const mockClaudeHomeApi = vi.hoisted(() => ({
  get: vi.fn(),
  updateSettings: vi.fn(),
  updateClaudeMd: vi.fn(),
  upsertMcpServer: vi.fn(),
  deleteMcpServer: vi.fn(),
  listMcp: vi.fn(),
  addMcp: vi.fn(),
  removeMcp: vi.fn(),
  startMcpLogin: vi.fn(),
  completeMcpLogin: vi.fn(),
  cancelMcpLogin: vi.fn(),
  logoutMcp: vi.fn(),
  listMarketplaces: vi.fn(),
  addMarketplace: vi.fn(),
  removeMarketplace: vi.fn(),
  updateMarketplaces: vi.fn(),
  listPlugins: vi.fn(),
  installPlugin: vi.fn(),
  setPluginEnabled: vi.fn(),
  updatePlugin: vi.fn(),
  uninstallPlugin: vi.fn(),
  pluginDetails: vi.fn(),
}));
const mockToolsApi = vi.hoisted(() => ({ importMcpJson: vi.fn(), connectApp: vi.fn(), listConnections: vi.fn() }));
const mockNavigate = vi.hoisted(() => vi.fn());

vi.mock("@/api/claudeHome", () => ({ claudeHomeApi: mockClaudeHomeApi }));
vi.mock("@/api/tools", () => ({ toolsApi: mockToolsApi }));
vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));
vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));
vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: ComponentProps<"a"> & { to: string }) => (
    <a href={to} {...props}>{children}</a>
  ),
  useNavigate: () => mockNavigate,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

async function flushReact() {
  for (let index = 0; index < 5; index += 1) {
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  }
}

function inventory(overrides: Partial<ClaudeHomeInventory> = {}): ClaudeHomeInventory {
  return {
    dir: "/paperclip/instances/default/claude-home/company-1",
    exists: true,
    settings: { model: "opus" },
    settingsParseError: null,
    claudeMd: "# Shared memory",
    mcpServers: [
      { name: "linear", origin: "claude_home", transport: "http", target: "https://mcp.linear.app/mcp", governed: false, headerKeys: ["Authorization"] },
      { name: "github", origin: "claude_home", transport: "stdio", target: "npx (2 args)", governed: false, envKeys: ["GITHUB_TOKEN"] },
    ],
    mcpServerConfigs: {
      linear: { type: "http", url: "https://mcp.linear.app/mcp", headers: { Authorization: CLAUDE_REDACTED_VALUE } },
      github: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], env: { GITHUB_TOKEN: CLAUDE_REDACTED_VALUE } },
    },
    mcpParseError: null,
    plugins: [],
    skills: [],
    subagents: [],
    commands: [],
    hooks: [],
    cliCommand: "CLAUDE_CONFIG_DIR='/paperclip/instances/default/claude-home/company-1' claude",
    ...overrides,
  };
}

function cliServer(overrides: Partial<ClaudeCliMcpServer> & Pick<ClaudeCliMcpServer, "name">): ClaudeCliMcpServer {
  return {
    origin: "claude_home",
    target: "https://example.com/mcp",
    transport: "HTTP",
    status: "connected",
    statusText: "✓ Connected",
    pluginId: null,
    removable: true,
    supportsLogin: true,
    ...overrides,
  };
}

const CLI_SERVERS: ClaudeCliMcpServer[] = [
  cliServer({ name: "linear", target: "https://mcp.linear.app/mcp" }),
  cliServer({ name: "github", transport: "STDIO", target: "npx -y @modelcontextprotocol/server-github", supportsLogin: false, status: "failed", statusText: "Failed to connect — ECONNREFUSED" }),
  cliServer({ name: "plugin:linear:linear", origin: "plugin", pluginId: "linear@claude-plugins-official", removable: false, status: "needs_auth", statusText: "Needs authentication" }),
  cliServer({ name: "claude.ai Gmail", origin: "claude_ai", removable: false, status: "pending_approval", statusText: "⏸ Pending approval" }),
  cliServer({ name: "docs", origin: "project", transport: "SSE", removable: false, supportsLogin: false, status: "unknown", statusText: "?" }),
];

function available(overrides: Partial<ClaudeCliAvailablePlugin> & Pick<ClaudeCliAvailablePlugin, "name" | "marketplace">): ClaudeCliAvailablePlugin {
  return {
    id: `${overrides.name}@${overrides.marketplace}`,
    displayName: null,
    description: null,
    category: null,
    tags: [],
    author: null,
    homepage: null,
    version: null,
    installed: false,
    ...overrides,
  };
}

function pluginsResponse(overrides: Partial<ClaudeCliPluginsResponse> = {}): ClaudeCliPluginsResponse {
  return {
    cliAvailable: true,
    installed: [
      { id: "linear@claude-plugins-official", version: "1.0.0", scope: "user", enabled: true, installedAt: null, lastUpdated: null },
    ],
    available: [
      available({ name: "linear", marketplace: "claude-plugins-official", displayName: "Linear", description: "Issue tracking", category: "productivity", installed: true }),
      available({ name: "sentry", marketplace: "claude-plugins-official", description: "Error monitoring", category: "monitoring", tags: ["errors"] }),
      available({ name: "notes", marketplace: "team-market", description: "Team notes", category: "productivity" }),
    ],
    ...overrides,
  };
}

function buttons(scope: ParentNode = document.body) {
  return Array.from(scope.querySelectorAll("button"));
}

function buttonByText(text: string, scope: ParentNode = document.body) {
  const found = buttons(scope).find((button) => button.textContent?.trim() === text);
  if (!found) throw new Error(`No button "${text}"`);
  return found;
}

async function click(element: Element) {
  await act(() => {
    (element as HTMLElement).click();
  });
  await flushReact();
}

async function selectTab(trigger: Element) {
  await act(() => {
    trigger.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
  });
  await flushReact();
}

async function typeInto(element: HTMLInputElement | HTMLSelectElement, value: string) {
  const proto = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
  await act(() => {
    setter.call(element, value);
    element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
  await flushReact();
}

describe("ClaudeHome", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockClaudeHomeApi.get.mockResolvedValue(inventory());
    mockClaudeHomeApi.listMcp.mockResolvedValue({ servers: CLI_SERVERS, cliAvailable: true, error: null });
    mockClaudeHomeApi.listPlugins.mockResolvedValue(pluginsResponse());
    mockClaudeHomeApi.listMarketplaces.mockResolvedValue({
      cliAvailable: true,
      marketplaces: [
        { name: "claude-plugins-official", source: "github", location: "anthropics/claude-plugins-official", pluginCount: 2 },
        { name: "team-market", source: "url", location: "https://example.com/marketplace.json", pluginCount: 1 },
      ],
    });
    mockToolsApi.listConnections.mockResolvedValue({
      connections: [
        { id: "conn-1", name: "GitHub (governed)", status: "active", connectionPurpose: "tool" },
        { id: "conn-2", name: "Old", status: "archived", connectionPurpose: "tool" },
      ],
    });
  });

  afterEach(async () => {
    await act(() => root?.unmount());
    container.remove();
    document.body.innerHTML = "";
    window.history.replaceState(null, "", "/");
    vi.clearAllMocks();
  });

  async function renderPage(hash = "") {
    window.history.replaceState(null, "", `/claude-home${hash}`);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <ClaudeHome />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    return client;
  }

  const row = (name: string) => container.querySelector(`tr[data-mcp-server="${CSS.escape(name)}"]`);

  describe("MCP tab", () => {
    it("lists every server the CLI reports with origin badges and status chips", async () => {
      await renderPage();

      expect(mockClaudeHomeApi.listMcp).toHaveBeenCalledWith("company-1");
      expect(container.textContent).toContain(inventory().cliCommand);
      const expectations: Array<[string, string, string, string]> = [
        ["linear", "claude_home", "Claude Code", "Connected"],
        ["github", "claude_home", "Claude Code", "Failed"],
        ["plugin:linear:linear", "plugin", "Claude Code · plugin", "Needs sign-in"],
        ["claude.ai Gmail", "claude_ai", "Claude Code · claude.ai", "Pending approval"],
        ["docs", "project", "Claude Code · project", "Unknown"],
      ];
      for (const [name, origin, label, status] of expectations) {
        const tr = row(name);
        expect(tr, name).not.toBeNull();
        expect(tr!.querySelector(`[data-origin="${origin}"]`)?.textContent).toBe(label);
        expect(tr!.querySelector("[data-mcp-status]")?.textContent).toBe(status);
      }
      expect(row("github")!.querySelector('[data-testid="mcp-status-reason"]')?.textContent).toBe(
        "Failed to connect — ECONNREFUSED",
      );
      expect(container.querySelector('[data-testid="claude-cli-unavailable"]')).toBeNull();
    });

    it("hides Remove for plugin and claude.ai servers and says who manages them", async () => {
      await renderPage();
      const hasRemove = (name: string) => row(name)!.querySelector(`[aria-label="Remove ${name}"]`) !== null;
      expect(hasRemove("linear")).toBe(true);
      expect(hasRemove("plugin:linear:linear")).toBe(false);
      expect(hasRemove("claude.ai Gmail")).toBe(false);
      expect(row("plugin:linear:linear")!.textContent).toContain("Managed by plugin linear@claude-plugins-official");
      expect(row("claude.ai Gmail")!.textContent).toContain("claude.ai connector");
    });

    it("removes a server after an inline confirmation", async () => {
      mockClaudeHomeApi.removeMcp.mockResolvedValue({ servers: CLI_SERVERS.filter((s) => s.name !== "linear") });
      await renderPage();
      await click(row("linear")!.querySelector('[aria-label="Remove linear"]')!);
      const confirm = row("linear")!.querySelector('[data-testid="mcp-remove-confirm"]')!;
      expect(confirm.textContent).toContain("Remove linear?");
      expect(mockClaudeHomeApi.removeMcp).not.toHaveBeenCalled();
      await click(buttonByText("Remove", confirm));
      expect(mockClaudeHomeApi.removeMcp).toHaveBeenCalledWith("company-1", "linear");
      expect(row("linear")).toBeNull();
    });

    it("signs in with the no-browser flow: start, open link, paste the redirect URL, complete", async () => {
      mockClaudeHomeApi.startMcpLogin.mockResolvedValue({ sessionId: "sess-1", authUrl: "https://auth.example.com/authorize?x=1" });
      mockClaudeHomeApi.completeMcpLogin.mockResolvedValue({
        servers: CLI_SERVERS.map((s) => (s.name === "plugin:linear:linear" ? { ...s, status: "connected" as const } : s)),
      });
      await renderPage();

      await click(buttonByText("Sign in", row("plugin:linear:linear")!));
      expect(mockClaudeHomeApi.startMcpLogin).toHaveBeenCalledWith("company-1", "plugin:linear:linear");
      expect(mockClaudeHomeApi.startMcpLogin).toHaveBeenCalledTimes(1);
      const link = document.body.querySelector<HTMLAnchorElement>('[data-testid="mcp-login-auth-link"]')!;
      expect(link.getAttribute("href")).toBe("https://auth.example.com/authorize?x=1");
      expect(link.getAttribute("target")).toBe("_blank");

      const input = document.body.querySelector<HTMLInputElement>("#mcp-login-redirect")!;
      await typeInto(input, "http://localhost:5555/callback?code=abc");
      await click(buttonByText("Finish sign-in"));
      expect(mockClaudeHomeApi.completeMcpLogin).toHaveBeenCalledWith(
        "company-1",
        "sess-1",
        "http://localhost:5555/callback?code=abc",
      );
      expect(mockClaudeHomeApi.cancelMcpLogin).not.toHaveBeenCalled();
      expect(row("plugin:linear:linear")!.querySelector("[data-mcp-status]")?.textContent).toBe("Connected");
    });

    it("cancels the login session when the dialog is dismissed", async () => {
      mockClaudeHomeApi.startMcpLogin.mockResolvedValue({ sessionId: "sess-2", authUrl: "https://auth.example.com/a" });
      mockClaudeHomeApi.cancelMcpLogin.mockResolvedValue(undefined);
      await renderPage();
      await click(buttonByText("Sign in", row("plugin:linear:linear")!));
      await click(buttonByText("Cancel", document.body.querySelector('[role="dialog"]')!));
      expect(mockClaudeHomeApi.cancelMcpLogin).toHaveBeenCalledWith("company-1", "sess-2");
      expect(mockClaudeHomeApi.completeMcpLogin).not.toHaveBeenCalled();
    });

    it("signs out of a connected server", async () => {
      mockClaudeHomeApi.logoutMcp.mockResolvedValue({ servers: CLI_SERVERS });
      await renderPage();
      await click(buttonByText("Sign out", row("linear")!));
      expect(mockClaudeHomeApi.logoutMcp).toHaveBeenCalledWith("company-1", "linear");
    });

    it("shows Checking… while Refresh re-runs health checks", async () => {
      await renderPage();
      let resolve: (value: unknown) => void = () => undefined;
      mockClaudeHomeApi.listMcp.mockReturnValueOnce(new Promise((r) => (resolve = r)));
      await click(buttonByText("Refresh"));
      expect(buttonByText("Checking…").disabled).toBe(true);
      await act(async () => resolve({ servers: CLI_SERVERS, cliAvailable: true }));
      await flushReact();
      expect(buttonByText("Refresh").disabled).toBe(false);
    });

    it("offers Adopt into Paperclip only for Claude Code http/sse servers", async () => {
      await renderPage();
      const adoptIn = (name: string) => buttons(row(name)!).some((b) => b.textContent?.includes("Adopt into Paperclip"));
      expect(adoptIn("linear")).toBe(true);
      expect(adoptIn("github")).toBe(false);
      expect(adoptIn("plugin:linear:linear")).toBe(false);
      expect(adoptIn("docs")).toBe(false);
    });

    it("lists governed Paperclip connectors linking to Apps", async () => {
      await renderPage();
      const item = container.querySelector('[data-governed-connection="conn-1"]');
      expect(item?.querySelector('[data-origin="paperclip"]')?.textContent).toBe("Paperclip · governed");
      expect(item?.querySelector('a[href="/apps/conn-1/permissions"]')).not.toBeNull();
      expect(container.querySelector('[data-governed-connection="conn-2"]')).toBeNull();
    });
  });

  describe("when the CLI isn't available", () => {
    beforeEach(() => {
      mockClaudeHomeApi.listMcp.mockResolvedValue({ servers: [], cliAvailable: false });
      mockClaudeHomeApi.listPlugins.mockResolvedValue({ installed: [], available: [], cliAvailable: false });
      mockClaudeHomeApi.listMarketplaces.mockResolvedValue({ marketplaces: [], cliAvailable: false });
    });

    it("shows the banner and falls back to the file-based MCP inventory, read-only", async () => {
      await renderPage();
      expect(container.querySelector('[data-testid="claude-cli-unavailable"]')?.textContent).toContain(
        "Claude Code CLI isn’t available on the Paperclip host; showing a read-only view",
      );
      for (const name of ["linear", "github"]) {
        expect(row(name)?.querySelector('[data-origin="claude_home"]')?.textContent).toBe("Claude Code");
      }
      expect(buttons(container).some((b) => b.textContent?.includes("Add server"))).toBe(false);
      const adoptIn = (name: string) => buttons(row(name)!).some((b) => b.textContent?.includes("Adopt into Paperclip"));
      expect(adoptIn("linear")).toBe(true);
      expect(adoptIn("github")).toBe(false);
    });

    it("also falls back on a 503 claude_cli_unavailable", async () => {
      mockClaudeHomeApi.listMcp.mockRejectedValue(
        new ApiError("Claude Code CLI is not available", 503, { error: "Claude Code CLI is not available", code: "claude_cli_unavailable" }),
      );
      await renderPage();
      expect(container.querySelector('[data-testid="claude-cli-unavailable"]')).not.toBeNull();
      expect(row("linear")).not.toBeNull();
    });

    it("shows empty states that explain how to add capabilities natively", async () => {
      mockClaudeHomeApi.get.mockResolvedValue(inventory({ mcpServers: [], mcpServerConfigs: {} }));
      await renderPage();
      expect(container.textContent).toContain("No native MCP servers yet.");
      await selectTab(container.querySelector('[data-tab="plugins"]')!);
      expect(container.querySelector('[data-testid="claude-cli-unavailable"]')).not.toBeNull();
      expect(container.textContent).toContain("/plugin install <name>");
      await selectTab(container.querySelector('[data-tab="skills"]')!);
      expect(container.textContent).toContain("/hooks");
    });
  });

  describe("Plugins tab", () => {
    const card = (id: string) => container.querySelector(`[data-plugin-card="${id}"]`);

    it("filters Discover by search, marketplace and category, and installs", async () => {
      mockClaudeHomeApi.installPlugin.mockResolvedValue(
        pluginsResponse({
          installed: [
            ...pluginsResponse().installed,
            { id: "sentry@claude-plugins-official", version: "2.0.0", scope: "user", enabled: true, installedAt: null, lastUpdated: null },
          ],
        }),
      );
      await renderPage("#plugins");
      expect(mockClaudeHomeApi.listPlugins).toHaveBeenCalledWith("company-1");
      expect(card("linear@claude-plugins-official")?.textContent).toContain("Linear");
      const linearInstall = buttons(card("linear@claude-plugins-official")!).find((b) => b.textContent?.includes("Installed"));
      expect(linearInstall?.disabled).toBe(true);

      const search = container.querySelector<HTMLInputElement>('input[aria-label="Search plugins"]')!;
      await typeInto(search, "error");
      expect(card("sentry@claude-plugins-official")).not.toBeNull();
      expect(card("linear@claude-plugins-official")).toBeNull();
      await typeInto(search, "");

      await typeInto(container.querySelector<HTMLSelectElement>('select[aria-label="Marketplace"]')!, "team-market");
      expect(card("notes@team-market")).not.toBeNull();
      expect(card("sentry@claude-plugins-official")).toBeNull();
      await typeInto(container.querySelector<HTMLSelectElement>('select[aria-label="Marketplace"]')!, "");

      await typeInto(container.querySelector<HTMLSelectElement>('select[aria-label="Category"]')!, "monitoring");
      expect(card("sentry@claude-plugins-official")).not.toBeNull();
      expect(card("notes@team-market")).toBeNull();

      await click(buttonByText("Install", card("sentry@claude-plugins-official")!));
      expect(mockClaudeHomeApi.installPlugin).toHaveBeenCalledWith("company-1", "sentry@claude-plugins-official");
      const after = buttons(card("sentry@claude-plugins-official")!).find((b) => b.textContent?.includes("Installed"));
      expect(after?.disabled).toBe(true);
    });

    it("shows plugin details as monospace text", async () => {
      mockClaudeHomeApi.pluginDetails.mockResolvedValue({ text: "Skills: 2\nProjected tokens: 1,200" });
      await renderPage("#plugins");
      await click(buttonByText("Details", card("sentry@claude-plugins-official")!));
      expect(mockClaudeHomeApi.pluginDetails).toHaveBeenCalledWith("company-1", "sentry@claude-plugins-official");
      expect(document.body.querySelector('[data-testid="plugin-details-text"]')?.textContent).toContain(
        "Projected tokens: 1,200",
      );
    });

    it("toggles, updates and uninstalls installed plugins", async () => {
      const disabled = pluginsResponse({
        installed: [{ ...pluginsResponse().installed[0], enabled: false }],
      });
      mockClaudeHomeApi.setPluginEnabled.mockResolvedValue(disabled);
      mockClaudeHomeApi.updatePlugin.mockResolvedValue(disabled);
      mockClaudeHomeApi.uninstallPlugin.mockResolvedValue(pluginsResponse({ installed: [] }));
      await renderPage("#plugins");
      await selectTab(buttons(container).find((b) => b.textContent?.startsWith("Installed"))!);

      const item = () => container.querySelector('[data-installed-plugin="linear@claude-plugins-official"]')!;
      await click(item().querySelector('[role="switch"]')!);
      expect(mockClaudeHomeApi.setPluginEnabled).toHaveBeenCalledWith("company-1", "linear@claude-plugins-official", false);
      expect(item().querySelector('[role="switch"]')?.getAttribute("aria-checked")).toBe("false");
      await click(item().querySelector('[role="switch"]')!);
      expect(mockClaudeHomeApi.setPluginEnabled).toHaveBeenLastCalledWith("company-1", "linear@claude-plugins-official", true);

      await click(buttonByText("Update", item()));
      expect(mockClaudeHomeApi.updatePlugin).toHaveBeenCalledWith("company-1", "linear@claude-plugins-official");

      await click(buttonByText("Uninstall", item()));
      expect(mockClaudeHomeApi.uninstallPlugin).not.toHaveBeenCalled();
      await click(buttonByText("Uninstall", item().querySelector('[data-testid="plugin-uninstall-confirm"]')!));
      expect(mockClaudeHomeApi.uninstallPlugin).toHaveBeenCalledWith("company-1", "linear@claude-plugins-official");
      expect(container.textContent).toContain("No plugins installed.");
    });

    it("adds, updates and removes marketplaces", async () => {
      const after = [{ name: "claude-plugins-official", source: "github", location: "anthropics/claude-plugins-official", pluginCount: 2 }];
      mockClaudeHomeApi.addMarketplace.mockResolvedValue({ marketplaces: after });
      mockClaudeHomeApi.updateMarketplaces.mockResolvedValue({ marketplaces: after });
      mockClaudeHomeApi.removeMarketplace.mockResolvedValue({ marketplaces: after });
      await renderPage("#plugins");
      await selectTab(buttons(container).find((b) => b.textContent?.startsWith("Marketplaces"))!);

      const marketplaceRow = (name: string) => container.querySelector(`tr[data-marketplace="${name}"]`);
      expect(marketplaceRow("team-market")?.textContent).toContain("https://example.com/marketplace.json");

      await typeInto(container.querySelector<HTMLInputElement>('input[aria-label="Marketplace source"]')!, "acme/plugins");
      await click(buttonByText("Add marketplace"));
      expect(mockClaudeHomeApi.addMarketplace).toHaveBeenCalledWith("company-1", "acme/plugins");

      await click(marketplaceRow("claude-plugins-official")!.querySelector('[aria-label="Update claude-plugins-official"]')!);
      expect(mockClaudeHomeApi.updateMarketplaces).toHaveBeenCalledWith("company-1", "claude-plugins-official");
      await click(buttonByText("Update all"));
      expect(mockClaudeHomeApi.updateMarketplaces).toHaveBeenLastCalledWith("company-1", undefined);

      await click(marketplaceRow("claude-plugins-official")!.querySelector('[aria-label="Remove claude-plugins-official"]')!);
      expect(mockClaudeHomeApi.removeMarketplace).not.toHaveBeenCalled();
      await click(buttonByText("Remove", marketplaceRow("claude-plugins-official")!));
      expect(mockClaudeHomeApi.removeMarketplace).toHaveBeenCalledWith("company-1", "claude-plugins-official");
    });

    it("suggests the official marketplace when none are added", async () => {
      mockClaudeHomeApi.listMarketplaces.mockResolvedValue({ marketplaces: [], cliAvailable: true });
      await renderPage("#plugins");
      await selectTab(buttons(container).find((b) => b.textContent?.startsWith("Marketplaces"))!);
      await click(buttonByText("Use anthropics/claude-plugins-official"));
      expect(container.querySelector<HTMLInputElement>('input[aria-label="Marketplace source"]')?.value).toBe(
        "anthropics/claude-plugins-official",
      );
    });
  });

  it("selects the tab from the URL hash and writes the hash when switching", async () => {
    await renderPage("#settings");
    expect(container.querySelector('[data-tab="settings"]')?.getAttribute("data-state")).toBe("active");
    expect(container.querySelector('textarea[aria-label="settings.json"]')).not.toBeNull();
    expect(mockClaudeHomeApi.listMcp).not.toHaveBeenCalled();

    await selectTab(container.querySelector('[data-tab="claude-md"]')!);
    expect(window.location.hash).toBe("#claude-md");
    expect(container.querySelector<HTMLTextAreaElement>('textarea[aria-label="CLAUDE.md"]')?.value).toBe("# Shared memory");

    await act(() => {
      window.location.hash = "#skills";
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    await flushReact();
    expect(container.querySelector('[data-tab="skills"]')?.getAttribute("data-state")).toBe("active");
  });

  it("shows the load error instead of an empty page", async () => {
    mockClaudeHomeApi.get.mockRejectedValue(new Error("Board access required"));
    await renderPage();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Board access required");
  });

  it("explains the missing agent-management permission on 403 without a retry button", async () => {
    mockClaudeHomeApi.get.mockRejectedValue(
      new ApiError("Missing permission: agents:create", 403, { error: "Missing permission: agents:create" }),
    );
    await renderPage();
    const notice = container.querySelector('[data-testid="claude-home-forbidden"]');
    expect(notice?.textContent).toContain("You need permission to manage agents to view Claude Home");
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect([...container.querySelectorAll("button")].some((button) => button.textContent?.includes("Try again"))).toBe(false);
    expect(mockClaudeHomeApi.get).toHaveBeenCalledTimes(1);
  });
});

describe("mcp server form", () => {
  it("round-trips redacted secrets as the placeholder unless edited", () => {
    const original = {
      type: "http",
      url: "https://mcp.linear.app/mcp",
      headers: { Authorization: CLAUDE_REDACTED_VALUE, "X-Team": "eng" },
      timeout: 30,
    };
    const form = mcpServerFormFromConfig("linear", original);
    expect(form.headers[0]).toEqual({ key: "Authorization", value: "", redacted: true });
    expect(mcpServerConfigFromForm(form, original)).toEqual(original);

    const edited = { ...form, headers: [{ ...form.headers[0], value: "Bearer new" }, form.headers[1]] };
    expect(mcpServerConfigFromForm(edited, original)).toMatchObject({
      headers: { Authorization: "Bearer new", "X-Team": "eng" },
    });
    expect(hasRedactedSecrets(original)).toBe(true);
    expect(hasRedactedSecrets({ url: "https://x.example.com" })).toBe(false);
  });

  it("infers stdio from a command and validates required fields", () => {
    const form = mcpServerFormFromConfig("github", { command: "npx", args: ["-y", "pkg"] });
    expect(form.type).toBe("stdio");
    expect(form.args).toBe("-y\npkg");
    expect(mcpServerConfigFromForm(form)).toEqual({ type: "stdio", command: "npx", args: ["-y", "pkg"] });
    expect(validateMcpServerForm({ ...form, command: " " })).toMatch(/command/);
    expect(validateMcpServerForm({ ...form, name: "bad name" })).toMatch(/Name/);
    expect(validateMcpServerForm({ ...form, type: "http", url: "ftp://x" })).toMatch(/http/);
  });
});
