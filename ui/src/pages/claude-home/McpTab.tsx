import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Loader2, LogOut, Plus, RefreshCw, ShieldCheck, Trash2 } from "lucide-react";
import type {
  ClaudeCliMcpListResponse,
  ClaudeCliMcpServer,
  ClaudeCliMcpStatus,
  ClaudeHomeInventory,
  ClaudeMcpServerSummary,
} from "@paperclipai/shared";
import { claudeHomeApi } from "@/api/claudeHome";
import { toolsApi } from "@/api/tools";
import { OriginBadge } from "@/components/claude/OriginBadge";
import { StatusBadge } from "@/components/StatusBadge";
import { Button } from "@/components/ui/button";
import { queryKeys } from "@/lib/queryKeys";
import { Link } from "@/lib/router";
import { AdoptMcpServerDialog, type AdoptTarget } from "./AdoptMcpServerDialog";
import { McpLoginDialog } from "./McpLoginDialog";
import { McpServerDialog, type McpServerDialogTarget } from "./McpServerDialog";
import { isAdoptableMcpServer } from "./mcp-server-form";
import { CliUnavailableBanner, InlineError, Section, errorMessage, isCliUnavailableError } from "./shared";

/** CLI status → the shared status vocabulary (StatusBadge keys) and its label. */
const MCP_STATUS: Record<ClaudeCliMcpStatus, { badge: string; label: string }> = {
  connected: { badge: "succeeded", label: "Connected" },
  failed: { badge: "failed", label: "Failed" },
  needs_auth: { badge: "warning", label: "Needs sign-in" },
  pending_approval: { badge: "pending_approval", label: "Pending approval" },
  unknown: { badge: "unknown", label: "Unknown" },
};

export function McpStatusChip({ server }: { server: Pick<ClaudeCliMcpServer, "status" | "statusText"> }) {
  const status = MCP_STATUS[server.status] ?? MCP_STATUS.unknown;
  return (
    <span title={server.statusText || status.label} data-mcp-status={server.status} className="inline-flex">
      <StatusBadge status={status.badge} label={status.label} />
    </span>
  );
}

function managedByLabel(server: ClaudeCliMcpServer): string {
  if (server.origin === "plugin") {
    return server.pluginId ? `Managed by plugin ${server.pluginId}` : "Managed by a plugin";
  }
  if (server.origin === "claude_ai") return "claude.ai connector";
  if (server.origin === "project") return "Managed by the project";
  return "Managed outside Claude Home";
}

export function McpTab({
  companyId,
  inventory,
}: {
  companyId: string;
  inventory: ClaudeHomeInventory;
}) {
  const queryClient = useQueryClient();
  const mcpQuery = useQuery({
    queryKey: queryKeys.claudeCli.mcp(companyId),
    queryFn: () => claudeHomeApi.listMcp(companyId),
    retry: false,
    // `claude mcp list` runs every server's health check; don't repeat it on every focus.
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });

  const setServers = (servers: ClaudeCliMcpServer[]) =>
    queryClient.setQueryData<ClaudeCliMcpListResponse>(queryKeys.claudeCli.mcp(companyId), (prev) => ({
      cliAvailable: prev?.cliAvailable ?? true,
      servers,
      error: null,
    }));

  const cliUnavailable = mcpQuery.data?.cliAvailable === false || isCliUnavailableError(mcpQuery.error);

  let body;
  if (mcpQuery.isLoading) {
    body = (
      <Section title="MCP servers">
        <p className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="mcp-checking">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          Checking MCP servers… Claude Code runs each server’s health check, which can take a few seconds.
        </p>
      </Section>
    );
  } else if (cliUnavailable) {
    body = (
      <>
        <CliUnavailableBanner />
        <FileMcpServersSection companyId={companyId} inventory={inventory} />
      </>
    );
  } else if (mcpQuery.isError || !mcpQuery.data) {
    body = (
      <Section title="MCP servers">
        <div
          className="flex flex-wrap items-center gap-3 rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive"
          role="alert"
        >
          <p className="min-w-0 flex-1">Couldn’t list MCP servers: {errorMessage(mcpQuery.error)}</p>
          <Button type="button" size="sm" variant="outline" onClick={() => void mcpQuery.refetch()}>
            Try again
          </Button>
        </div>
      </Section>
    );
  } else {
    body = (
      <CliMcpServersSection
        companyId={companyId}
        inventory={inventory}
        data={mcpQuery.data}
        checking={mcpQuery.isFetching}
        onRefresh={() => void mcpQuery.refetch()}
        onServers={setServers}
      />
    );
  }

  return (
    <div className="space-y-8">
      {body}
      <GovernedConnectorsSection companyId={companyId} />
    </div>
  );
}

function CliMcpServersSection({
  companyId,
  inventory,
  data,
  checking,
  onRefresh,
  onServers,
}: {
  companyId: string;
  inventory: ClaudeHomeInventory;
  data: ClaudeCliMcpListResponse;
  checking: boolean;
  onRefresh: () => void;
  onServers: (servers: ClaudeCliMcpServer[]) => void;
}) {
  const [addTarget, setAddTarget] = useState<McpServerDialogTarget | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [loginTarget, setLoginTarget] = useState<string | null>(null);
  const [adoptTarget, setAdoptTarget] = useState<AdoptTarget | null>(null);

  const add = useMutation({
    mutationFn: (input: { name: string; config: Record<string, unknown> }) =>
      claudeHomeApi.addMcp(companyId, input.name, input.config),
    onSuccess: (next) => {
      onServers(next.servers);
      setAddTarget(null);
    },
  });
  const remove = useMutation({
    mutationFn: (name: string) => claudeHomeApi.removeMcp(companyId, name),
    onSuccess: (next) => {
      onServers(next.servers);
      setConfirmRemove(null);
    },
  });
  const logout = useMutation({
    mutationFn: (name: string) => claudeHomeApi.logoutMcp(companyId, name),
    onSuccess: (next) => onServers(next.servers),
  });

  const busy = remove.isPending || logout.isPending;

  return (
    <Section
      title="MCP servers"
      description={
        <>
          Everything <code className="font-mono">claude mcp list</code> reports for this home: your servers, plugin
          servers, claude.ai connectors and project servers. They run natively in Claude Code, outside Paperclip
          approvals.
        </>
      }
      action={
        <div className="flex items-center gap-2">
          <Button type="button" size="sm" variant="outline" disabled={checking} onClick={onRefresh}>
            {checking ? <Loader2 className="animate-spin" aria-hidden /> : <RefreshCw aria-hidden />}
            {checking ? "Checking…" : "Refresh"}
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => {
              add.reset();
              setAddTarget({ name: null, config: {} });
            }}
          >
            <Plus />
            Add server
          </Button>
        </div>
      }
    >
      {data.error ? (
        <p className="text-xs text-destructive" role="alert">
          Claude Code reported a problem listing servers: {data.error}
        </p>
      ) : null}
      {data.servers.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">
          No MCP servers yet. Add one here, or run <code className="font-mono">claude mcp add</code> with the command
          above.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="bg-accent/20 text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Name</th>
                <th className="px-3 py-2 font-medium">Origin</th>
                <th className="px-3 py-2 font-medium">Transport</th>
                <th className="px-3 py-2 font-medium">Target</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {data.servers.map((server) => {
                const transport = server.transport?.toLowerCase() ?? "";
                const adoptable = server.origin === "claude_home" && (transport === "http" || transport === "sse");
                const rowError =
                  (remove.isError && remove.variables === server.name ? remove.error : null) ??
                  (logout.isError && logout.variables === server.name ? logout.error : null);
                return (
                  <tr key={server.name} className="border-t border-border align-top" data-mcp-server={server.name}>
                    <td className="px-3 py-2 font-mono text-xs">{server.name}</td>
                    <td className="px-3 py-2">
                      <OriginBadge origin={server.origin} />
                    </td>
                    <td className="px-3 py-2 text-xs">{server.transport ?? "—"}</td>
                    <td
                      className="max-w-xs truncate px-3 py-2 font-mono text-xs text-muted-foreground"
                      title={server.target}
                    >
                      {server.target || "—"}
                    </td>
                    <td className="px-3 py-2">
                      <div className="space-y-1">
                        <McpStatusChip server={server} />
                        {server.status === "failed" && server.statusText ? (
                          <p className="max-w-xs text-xs text-destructive" data-testid="mcp-status-reason">
                            {server.statusText}
                          </p>
                        ) : null}
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      {confirmRemove === server.name ? (
                        <div className="flex flex-wrap items-center justify-end gap-2" data-testid="mcp-remove-confirm">
                          <span className="text-xs">Remove {server.name}?</span>
                          <Button
                            type="button"
                            size="xs"
                            variant="destructive"
                            disabled={remove.isPending}
                            onClick={() => remove.mutate(server.name)}
                          >
                            {remove.isPending ? "Removing…" : "Remove"}
                          </Button>
                          <Button
                            type="button"
                            size="xs"
                            variant="ghost"
                            disabled={remove.isPending}
                            onClick={() => setConfirmRemove(null)}
                          >
                            Cancel
                          </Button>
                        </div>
                      ) : (
                        <div className="flex flex-wrap items-center justify-end gap-1">
                          {adoptable ? (
                            <Button
                              type="button"
                              size="xs"
                              variant="outline"
                              onClick={() =>
                                setAdoptTarget({
                                  name: server.name,
                                  config: inventory.mcpServerConfigs[server.name] ?? {
                                    type: transport,
                                    url: server.target,
                                  },
                                })
                              }
                            >
                              <ShieldCheck />
                              Adopt into Paperclip
                            </Button>
                          ) : null}
                          {server.supportsLogin && server.status !== "connected" ? (
                            <Button
                              type="button"
                              size="xs"
                              variant={server.status === "needs_auth" ? "default" : "outline"}
                              disabled={busy}
                              onClick={() => setLoginTarget(server.name)}
                            >
                              <KeyRound />
                              Sign in
                            </Button>
                          ) : null}
                          {server.supportsLogin && server.status === "connected" ? (
                            <Button
                              type="button"
                              size="xs"
                              variant="ghost"
                              disabled={busy}
                              onClick={() => logout.mutate(server.name)}
                            >
                              <LogOut />
                              {logout.isPending && logout.variables === server.name ? "Signing out…" : "Sign out"}
                            </Button>
                          ) : null}
                          {server.removable ? (
                            <Button
                              type="button"
                              size="xs"
                              variant="ghost"
                              aria-label={`Remove ${server.name}`}
                              disabled={busy}
                              onClick={() => {
                                remove.reset();
                                setConfirmRemove(server.name);
                              }}
                            >
                              <Trash2 />
                              Remove
                            </Button>
                          ) : (
                            <span className="px-2 text-xs text-muted-foreground" data-testid="mcp-managed-by">
                              {managedByLabel(server)}
                            </span>
                          )}
                        </div>
                      )}
                      {rowError ? (
                        <div className="mt-1 text-right">
                          <InlineError error={rowError} />
                        </div>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <McpServerDialog
        target={addTarget}
        saving={add.isPending}
        error={add.isError ? errorMessage(add.error) : null}
        onClose={() => setAddTarget(null)}
        onSave={(name, config) => add.mutate({ name, config })}
      />
      <McpLoginDialog
        companyId={companyId}
        serverName={loginTarget}
        onClose={() => setLoginTarget(null)}
        onSignedIn={onServers}
      />
      <AdoptMcpServerDialog companyId={companyId} target={adoptTarget} onClose={() => setAdoptTarget(null)} />
    </Section>
  );
}

/** Read-only file-based list from `.claude.json`, used when the CLI isn't available. */
function FileMcpServersSection({ companyId, inventory }: { companyId: string; inventory: ClaudeHomeInventory }) {
  const [adoptTarget, setAdoptTarget] = useState<AdoptTarget | null>(null);
  return (
    <Section
      title="MCP servers"
      description="Servers from this home's .claude.json. They run natively in Claude Code, outside Paperclip approvals."
    >
      {inventory.mcpParseError ? (
        <p className="text-xs text-destructive" role="alert">
          .claude.json couldn’t be parsed: {inventory.mcpParseError}
        </p>
      ) : null}
      {inventory.mcpServers.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">
          No native MCP servers yet. Run <code className="font-mono">claude mcp add</code> with the command above.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="bg-accent/20 text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Name</th>
                <th className="px-3 py-2 font-medium">Origin</th>
                <th className="px-3 py-2 font-medium">Transport</th>
                <th className="px-3 py-2 font-medium">Target</th>
                <th className="px-3 py-2 font-medium">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {inventory.mcpServers.map((server: ClaudeMcpServerSummary) => (
                <tr key={server.name} className="border-t border-border" data-mcp-server={server.name}>
                  <td className="px-3 py-2 font-mono text-xs">{server.name}</td>
                  <td className="px-3 py-2">
                    <OriginBadge origin={server.origin} />
                  </td>
                  <td className="px-3 py-2 text-xs">{server.transport}</td>
                  <td
                    className="max-w-xs truncate px-3 py-2 font-mono text-xs text-muted-foreground"
                    title={server.target ?? ""}
                  >
                    {server.target ?? "—"}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center justify-end gap-1">
                      {isAdoptableMcpServer(server) ? (
                        <Button
                          type="button"
                          size="xs"
                          variant="outline"
                          onClick={() =>
                            setAdoptTarget({ name: server.name, config: inventory.mcpServerConfigs[server.name] ?? {} })
                          }
                        >
                          <ShieldCheck />
                          Adopt into Paperclip
                        </Button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <AdoptMcpServerDialog companyId={companyId} target={adoptTarget} onClose={() => setAdoptTarget(null)} />
    </Section>
  );
}

/** The company's governed Paperclip connectors, so the operator sees both worlds side by side. */
function GovernedConnectorsSection({ companyId }: { companyId: string }) {
  const connectionsQuery = useQuery({
    queryKey: queryKeys.tools.connections(companyId),
    queryFn: () => toolsApi.listConnections(companyId),
    retry: false,
  });
  const connections = (connectionsQuery.data?.connections ?? []).filter(
    (connection) =>
      connection.status !== "archived" && (connection.connectionPurpose ?? "tool") === "tool",
  );

  return (
    <Section
      title="Also available through Paperclip"
      description="Governed connectors: agents reach them through the Paperclip gateway with approvals and audit."
      action={
        <Link to="/apps" className="text-sm font-medium text-primary hover:underline">
          Open Apps
        </Link>
      }
    >
      {connectionsQuery.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading connectors…</p>
      ) : connectionsQuery.isError ? (
        <InlineError error={connectionsQuery.error} prefix="Couldn’t load Paperclip connectors" />
      ) : connections.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No governed connectors yet. Connect an app on the Apps page to give agents approved, audited access.
        </p>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border" aria-label="Paperclip connectors">
          {connections.map((connection) => (
            <li
              key={connection.id}
              className="flex items-center justify-between gap-3 px-3 py-2"
              data-governed-connection={connection.id}
            >
              <div className="flex min-w-0 items-center gap-2">
                <span className="truncate text-sm font-medium">{connection.name}</span>
                <OriginBadge origin="paperclip" />
              </div>
              <Link
                to={`/apps/${connection.id}/permissions`}
                className="shrink-0 text-xs font-medium text-primary hover:underline"
              >
                Permissions
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
