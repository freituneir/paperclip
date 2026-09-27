import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Pencil, Plus, ShieldCheck, SquareTerminal, Trash2 } from "lucide-react";
import type { ClaudeHomeInventory, ClaudeMcpServerSummary, ClaudeNamedItem } from "@paperclipai/shared";
import { claudeHomeApi } from "@/api/claudeHome";
import { OriginBadge } from "@/components/claude/OriginBadge";
import { CopyText } from "@/components/CopyText";
import { PageSkeleton } from "@/components/PageSkeleton";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { queryKeys } from "@/lib/queryKeys";
import { AdoptMcpServerDialog, type AdoptTarget } from "./claude-home/AdoptMcpServerDialog";
import { McpServerDialog, type McpServerDialogTarget } from "./claude-home/McpServerDialog";
import { isAdoptableMcpServer } from "./claude-home/mcp-server-form";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong.";
}

export function ClaudeHome() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: "Claude Home" }]);
    return () => setBreadcrumbs([]);
  }, [setBreadcrumbs]);

  const inventoryQuery = useQuery({
    queryKey: queryKeys.claudeHome(selectedCompanyId ?? "__none__"),
    queryFn: () => claudeHomeApi.get(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });

  if (!selectedCompanyId) {
    return <div className="p-6 text-sm text-muted-foreground">Select an organization to open Claude Home.</div>;
  }
  if (inventoryQuery.isLoading) return <PageSkeleton variant="detail" />;
  if (inventoryQuery.isError || !inventoryQuery.data) {
    return (
      <div className="max-w-4xl space-y-3">
        <h2 className="text-xl font-bold">Claude Home</h2>
        <div
          className="flex flex-wrap items-center gap-3 rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive"
          role="alert"
        >
          <p className="min-w-0 flex-1">Couldn’t load Claude Home: {errorMessage(inventoryQuery.error)}</p>
          <Button type="button" size="sm" variant="outline" onClick={() => void inventoryQuery.refetch()}>
            Try again
          </Button>
        </div>
      </div>
    );
  }

  return <ClaudeHomeContent companyId={selectedCompanyId} inventory={inventoryQuery.data} />;
}

export function ClaudeHomeContent({
  companyId,
  inventory,
}: {
  companyId: string;
  inventory: ClaudeHomeInventory;
}) {
  const queryClient = useQueryClient();
  const setInventory = (next: ClaudeHomeInventory) =>
    queryClient.setQueryData(queryKeys.claudeHome(companyId), next);

  return (
    <div className="max-w-5xl space-y-8 pb-12">
      <header className="space-y-1">
        <h2 className="flex items-center gap-2 text-xl font-bold">
          <SquareTerminal className="h-5 w-5" aria-hidden />
          Claude Home
        </h2>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Your agents run real Claude Code. This is their shared Claude Code config (CLAUDE_CONFIG_DIR) on the
          Paperclip host.
        </p>
      </header>

      <LocationSection inventory={inventory} />
      <McpServersSection companyId={companyId} inventory={inventory} onSaved={setInventory} />
      <SettingsSection companyId={companyId} inventory={inventory} onSaved={setInventory} />
      <ClaudeMdSection companyId={companyId} inventory={inventory} onSaved={setInventory} />
      <ReadOnlyInventory inventory={inventory} />
    </div>
  );
}

function Section({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="space-y-3" aria-label={title}>
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <h3 className="text-sm font-semibold">{title}</h3>
          {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function InlineError({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <p className="text-xs text-destructive" role="alert">
      {errorMessage(error)}
    </p>
  );
}

function LocationSection({ inventory }: { inventory: ClaudeHomeInventory }) {
  return (
    <Section title="Location">
      <div className="space-y-3 rounded-lg border border-border bg-card p-4">
        <div className="space-y-1">
          <div className="text-xs text-muted-foreground">Directory</div>
          <div className="break-all font-mono text-xs">{inventory.dir}</div>
          {!inventory.exists ? (
            <p className="text-xs text-muted-foreground">
              This directory doesn’t exist yet. Paperclip creates it on the first save here or the first agent run.
            </p>
          ) : null}
        </div>
        <div className="space-y-1">
          <div className="text-xs text-muted-foreground">Open this home in Claude Code</div>
          <div className="flex flex-wrap items-center gap-2">
            <code className="min-w-0 flex-1 break-all rounded-md bg-muted px-2 py-1 font-mono text-xs">
              {inventory.cliCommand}
            </code>
            <CopyText
              text={inventory.cliCommand}
              ariaLabel="Copy Claude Code command"
              className="inline-flex items-center gap-1 text-xs text-muted-foreground"
            >
              <Copy className="h-3.5 w-3.5" aria-hidden />
              Copy
            </CopyText>
          </div>
          <p className="text-xs text-muted-foreground">
            Run it on the Paperclip host. <code className="font-mono">claude mcp add</code>,{" "}
            <code className="font-mono">/plugin install</code>, and MCP OAuth logins run there write directly into
            this home. When Paperclip runs in Docker, prefix the command with{" "}
            <code className="font-mono">docker compose exec -it paperclip</code>.
          </p>
        </div>
      </div>
    </Section>
  );
}

function McpServersSection({
  companyId,
  inventory,
  onSaved,
}: {
  companyId: string;
  inventory: ClaudeHomeInventory;
  onSaved: (next: ClaudeHomeInventory) => void;
}) {
  const [editTarget, setEditTarget] = useState<McpServerDialogTarget | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [adoptTarget, setAdoptTarget] = useState<AdoptTarget | null>(null);

  const upsert = useMutation({
    mutationFn: (input: { name: string; config: Record<string, unknown> }) =>
      claudeHomeApi.upsertMcpServer(companyId, input.name, input.config),
    onSuccess: (next) => {
      onSaved(next);
      setEditTarget(null);
    },
  });
  const remove = useMutation({
    mutationFn: (name: string) => claudeHomeApi.deleteMcpServer(companyId, name),
    onSuccess: (next) => {
      onSaved(next);
      setDeleteTarget(null);
    },
  });

  const configFor = (name: string) => inventory.mcpServerConfigs[name] ?? {};
  const openEditor = (target: McpServerDialogTarget) => {
    upsert.reset();
    setEditTarget(target);
  };

  return (
    <Section
      title="MCP servers"
      description="Servers from this home's .claude.json. They run natively in Claude Code, outside Paperclip approvals."
      action={
        <Button type="button" size="sm" onClick={() => openEditor({ name: null, config: {} })}>
          <Plus />
          Add server
        </Button>
      }
    >
      {inventory.mcpParseError ? (
        <p className="text-xs text-destructive" role="alert">
          .claude.json couldn’t be parsed: {inventory.mcpParseError}
        </p>
      ) : null}
      {inventory.mcpServers.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">
          No native MCP servers yet. Add one here, or run <code className="font-mono">claude mcp add</code> with
          the command above.
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
              {inventory.mcpServers.map((server) => (
                <McpServerRow
                  key={server.name}
                  server={server}
                  editable={server.origin === "claude_home" && Boolean(inventory.mcpServerConfigs[server.name])}
                  onEdit={() => openEditor({ name: server.name, config: configFor(server.name) })}
                  onDelete={() => {
                    remove.reset();
                    setDeleteTarget(server.name);
                  }}
                  onAdopt={() => setAdoptTarget({ name: server.name, config: configFor(server.name) })}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <McpServerDialog
        target={editTarget}
        saving={upsert.isPending}
        error={upsert.isError ? errorMessage(upsert.error) : null}
        onClose={() => setEditTarget(null)}
        onSave={(name, config) => upsert.mutate({ name, config })}
      />

      <AdoptMcpServerDialog companyId={companyId} target={adoptTarget} onClose={() => setAdoptTarget(null)} />

      <AlertDialog open={deleteTarget !== null} onOpenChange={(open) => (!open ? setDeleteTarget(null) : undefined)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleteTarget}?</AlertDialogTitle>
            <AlertDialogDescription>
              Removes the server from this Claude Home. Agents stop getting it on their next run.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <InlineError error={remove.error} />
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={remove.isPending}
              onClick={(event) => {
                event.preventDefault();
                if (deleteTarget) remove.mutate(deleteTarget);
              }}
            >
              {remove.isPending ? "Deleting…" : "Delete server"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Section>
  );
}

function McpServerRow({
  server,
  editable,
  onEdit,
  onDelete,
  onAdopt,
}: {
  server: ClaudeMcpServerSummary;
  editable: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onAdopt: () => void;
}) {
  return (
    <tr className="border-t border-border" data-mcp-server={server.name}>
      <td className="px-3 py-2 font-mono text-xs">{server.name}</td>
      <td className="px-3 py-2">
        <OriginBadge origin={server.origin} />
      </td>
      <td className="px-3 py-2 text-xs">{server.transport}</td>
      <td className="max-w-xs truncate px-3 py-2 font-mono text-xs text-muted-foreground" title={server.target ?? ""}>
        {server.target ?? "—"}
      </td>
      <td className="px-3 py-2">
        <div className="flex items-center justify-end gap-1">
          {isAdoptableMcpServer(server) ? (
            <Button type="button" size="xs" variant="outline" onClick={onAdopt}>
              <ShieldCheck />
              Adopt into Paperclip
            </Button>
          ) : null}
          {editable ? (
            <>
              <Button type="button" size="icon-xs" variant="ghost" aria-label={`Edit ${server.name}`} onClick={onEdit}>
                <Pencil />
              </Button>
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                aria-label={`Delete ${server.name}`}
                onClick={onDelete}
              >
                <Trash2 />
              </Button>
            </>
          ) : null}
        </div>
      </td>
    </tr>
  );
}

function SettingsSection({
  companyId,
  inventory,
  onSaved,
}: {
  companyId: string;
  inventory: ClaudeHomeInventory;
  onSaved: (next: ClaudeHomeInventory) => void;
}) {
  const initial = useMemo(() => JSON.stringify(inventory.settings ?? {}, null, 2), [inventory.settings]);
  const [text, setText] = useState(initial);
  useEffect(() => setText(initial), [initial]);

  const parseError = useMemo(() => {
    try {
      const parsed: unknown = JSON.parse(text);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "Settings must be a JSON object.";
      return null;
    } catch (error) {
      return `Invalid JSON: ${errorMessage(error)}`;
    }
  }, [text]);

  const save = useMutation({
    mutationFn: () => claudeHomeApi.updateSettings(companyId, JSON.parse(text) as Record<string, unknown>),
    onSuccess: onSaved,
  });
  const dirty = text !== initial;

  return (
    <Section
      title="Settings"
      description={
        <>
          settings.json for this home. Secret values show as <code className="font-mono">__redacted__</code>; leave
          them as-is to keep the stored value.
        </>
      }
    >
      {inventory.settingsParseError ? (
        <p className="text-xs text-destructive" role="alert">
          settings.json on disk couldn’t be parsed: {inventory.settingsParseError}. Fix it in Claude Code on the host
          before saving here.
        </p>
      ) : null}
      <Textarea
        aria-label="settings.json"
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          if (save.isSuccess) save.reset();
        }}
        rows={14}
        spellCheck={false}
        className="font-mono text-xs"
      />
      {parseError ? <p className="text-xs text-destructive">{parseError}</p> : null}
      <InlineError error={save.error} />
      <div className="flex items-center gap-3">
        <Button type="button" size="sm" disabled={!dirty || Boolean(parseError) || save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? "Saving…" : "Save settings"}
        </Button>
        {save.isSuccess && !dirty ? <span className="text-xs text-muted-foreground">Saved.</span> : null}
      </div>
    </Section>
  );
}

function ClaudeMdSection({
  companyId,
  inventory,
  onSaved,
}: {
  companyId: string;
  inventory: ClaudeHomeInventory;
  onSaved: (next: ClaudeHomeInventory) => void;
}) {
  const initial = inventory.claudeMd ?? "";
  const [text, setText] = useState(initial);
  useEffect(() => setText(initial), [initial]);

  const save = useMutation({
    mutationFn: () => claudeHomeApi.updateClaudeMd(companyId, text),
    onSuccess: onSaved,
  });
  const dirty = text !== initial;

  return (
    <Section title="CLAUDE.md" description="User-level memory every agent in this home loads.">
      <Textarea
        aria-label="CLAUDE.md"
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          if (save.isSuccess) save.reset();
        }}
        rows={10}
        spellCheck={false}
        placeholder="No CLAUDE.md yet."
        className="font-mono text-xs"
      />
      <InlineError error={save.error} />
      <div className="flex items-center gap-3">
        <Button type="button" size="sm" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? "Saving…" : "Save CLAUDE.md"}
        </Button>
        {save.isSuccess && !dirty ? <span className="text-xs text-muted-foreground">Saved.</span> : null}
      </div>
    </Section>
  );
}

function NamedItemList({
  items,
  empty,
  renderTrailing,
}: {
  items: ClaudeNamedItem[];
  empty: ReactNode;
  renderTrailing?: (item: ClaudeNamedItem) => ReactNode;
}) {
  if (items.length === 0) return <p className="text-sm text-muted-foreground">{empty}</p>;
  return (
    <ul className="divide-y divide-border rounded-lg border border-border">
      {items.map((item) => (
        <li key={`${item.origin}:${item.name}`} className="flex items-center justify-between gap-3 px-3 py-2">
          <div className="min-w-0">
            <div className="truncate font-mono text-xs">{item.name}</div>
            {!renderTrailing && item.description ? (
              <div className="truncate text-xs text-muted-foreground">{item.description}</div>
            ) : null}
          </div>
          {renderTrailing ? renderTrailing(item) : null}
        </li>
      ))}
    </ul>
  );
}

function ReadOnlyInventory({ inventory }: { inventory: ClaudeHomeInventory }) {
  const dir = inventory.dir;
  return (
    <>
      <Section title="Plugins" description="Installed plugins. Manage them with /plugin in Claude Code.">
        <NamedItemList
          items={inventory.plugins}
          empty={
            <>
              No plugins installed. Run <code className="font-mono">/plugin install &lt;name&gt;</code> in Claude Code
              opened with the command above.
            </>
          }
          renderTrailing={(item) => (
            <Badge variant={item.description === "enabled" ? "secondary" : "outline"}>
              {item.description === "enabled" ? "Enabled" : "Disabled"}
            </Badge>
          )}
        />
      </Section>
      <Section title="Skills">
        <NamedItemList
          items={inventory.skills}
          empty={
            <>
              No native skills. Add a folder with a SKILL.md under{" "}
              <code className="break-all font-mono">{dir}/skills/</code>.
            </>
          }
        />
      </Section>
      <Section title="Subagents">
        <NamedItemList
          items={inventory.subagents}
          empty={
            <>
              No subagents. Create one with <code className="font-mono">/agents</code> in Claude Code, or add a
              Markdown file under <code className="break-all font-mono">{dir}/agents/</code>.
            </>
          }
        />
      </Section>
      <Section title="Slash commands">
        <NamedItemList
          items={inventory.commands}
          empty={
            <>
              No custom slash commands. Add a Markdown file under{" "}
              <code className="break-all font-mono">{dir}/commands/</code>.
            </>
          }
        />
      </Section>
      <Section title="Hooks">
        {inventory.hooks.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No hooks. Add them under <code className="font-mono">hooks</code> in the settings above, or with{" "}
            <code className="font-mono">/hooks</code> in Claude Code.
          </p>
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {inventory.hooks.map((hook) => (
              <li key={hook.event} className="flex items-center justify-between gap-3 px-3 py-2 text-xs">
                <span className="font-mono">{hook.event}</span>
                <span className="text-muted-foreground">
                  {hook.count} {hook.count === 1 ? "hook" : "hooks"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  );
}
