// @vitest-environment jsdom

import type { ComponentProps } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CLAUDE_REDACTED_VALUE, type ClaudeHomeInventory } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
}));
const mockToolsApi = vi.hoisted(() => ({ importMcpJson: vi.fn(), connectApp: vi.fn() }));
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

describe("ClaudeHome", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(async () => {
    await act(() => root?.unmount());
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  async function renderPage() {
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

  it("renders native MCP servers with the Claude Code origin badge", async () => {
    mockClaudeHomeApi.get.mockResolvedValue(inventory());
    await renderPage();

    expect(mockClaudeHomeApi.get).toHaveBeenCalledWith("company-1");
    for (const name of ["linear", "github"]) {
      const row = container.querySelector(`tr[data-mcp-server="${name}"]`);
      expect(row).not.toBeNull();
      const badge = row!.querySelector('[data-origin="claude_home"]');
      expect(badge?.textContent).toBe("Claude Code");
    }
    expect(container.textContent).toContain(
      "Your agents run real Claude Code. This is their shared Claude Code config (CLAUDE_CONFIG_DIR) on the Paperclip host.",
    );
    expect(container.textContent).toContain(inventory().cliCommand);
  });

  it("offers Adopt into Paperclip only for http/sse servers", async () => {
    mockClaudeHomeApi.get.mockResolvedValue(
      inventory({
        mcpServers: [
          ...inventory().mcpServers,
          { name: "events", origin: "claude_home", transport: "sse", target: "https://events.example.com/sse", governed: false },
        ],
      }),
    );
    await renderPage();

    const adoptIn = (name: string) =>
      Array.from(container.querySelectorAll(`tr[data-mcp-server="${name}"] button`)).some((button) =>
        button.textContent?.includes("Adopt into Paperclip"),
      );
    expect(adoptIn("linear")).toBe(true);
    expect(adoptIn("events")).toBe(true);
    expect(adoptIn("github")).toBe(false);
  });

  it("shows the load error instead of an empty page", async () => {
    mockClaudeHomeApi.get.mockRejectedValue(new Error("Board access required"));
    await renderPage();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Board access required");
  });

  it("shows empty states that explain how to add capabilities natively", async () => {
    mockClaudeHomeApi.get.mockResolvedValue(inventory({ mcpServers: [], mcpServerConfigs: {} }));
    await renderPage();
    expect(container.textContent).toContain("No native MCP servers yet.");
    expect(container.textContent).toContain("/plugin install <name>");
    expect(container.textContent).toContain("/hooks");
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
