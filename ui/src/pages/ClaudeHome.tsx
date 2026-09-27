import { useCallback, useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, ShieldCheck, SquareTerminal } from "lucide-react";
import type { ClaudeHomeInventory } from "@paperclipai/shared";
import { claudeHomeApi } from "@/api/claudeHome";
import { CopyText } from "@/components/CopyText";
import { PageSkeleton } from "@/components/PageSkeleton";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { queryKeys } from "@/lib/queryKeys";
import {
  ClaudeMdSection,
  SettingsSection,
  SkillsAndAgentsSections,
} from "./claude-home/ConfigSections";
import { McpTab } from "./claude-home/McpTab";
import { PluginsTab } from "./claude-home/PluginsTab";
import { Section, errorMessage, isForbidden } from "./claude-home/shared";

export function ClaudeHome() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const defaultRetry = useQueryClient().getDefaultOptions().queries?.retry;

  useEffect(() => {
    setBreadcrumbs([{ label: "Claude Home" }]);
    return () => setBreadcrumbs([]);
  }, [setBreadcrumbs]);

  const inventoryQuery = useQuery({
    queryKey: queryKeys.claudeHome(selectedCompanyId ?? "__none__"),
    queryFn: () => claudeHomeApi.get(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
    // A 403 (no agents:create permission) will not change on retry.
    retry: (failureCount, error) => {
      if (isForbidden(error)) return false;
      if (typeof defaultRetry === "function") return defaultRetry(failureCount, error);
      if (typeof defaultRetry === "boolean") return defaultRetry;
      return failureCount < (defaultRetry ?? 3);
    },
  });

  if (!selectedCompanyId) {
    return <div className="p-6 text-sm text-muted-foreground">Select an organization to open Claude Home.</div>;
  }
  if (inventoryQuery.isLoading) return <PageSkeleton variant="detail" />;
  if (inventoryQuery.isError && isForbidden(inventoryQuery.error)) {
    return (
      <div className="max-w-4xl space-y-3">
        <h2 className="text-xl font-bold">Claude Home</h2>
        <div
          className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3 text-sm text-muted-foreground"
          data-testid="claude-home-forbidden"
        >
          <ShieldCheck className="h-4 w-4 shrink-0" aria-hidden />
          <p className="min-w-0 flex-1">
            You need permission to manage agents to view Claude Home. Its settings, hooks and MCP commands run on the
            host for every agent in this organization.
          </p>
        </div>
      </div>
    );
  }
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

/** Tabs in terminal order; each is deep-linkable as `#<key>`. */
export const CLAUDE_HOME_TABS = [
  { key: "mcp", label: "MCP" },
  { key: "plugins", label: "Plugins" },
  { key: "settings", label: "Settings" },
  { key: "claude-md", label: "CLAUDE.md" },
  { key: "skills", label: "Skills & agents" },
] as const;

export type ClaudeHomeTab = (typeof CLAUDE_HOME_TABS)[number]["key"];

function tabFromHash(hash: string): ClaudeHomeTab {
  const key = hash.replace(/^#/, "");
  return CLAUDE_HOME_TABS.find((tab) => tab.key === key)?.key ?? "mcp";
}

function currentHash(): string {
  return typeof window === "undefined" ? "" : window.location.hash;
}

/** The active tab mirrors the URL hash so tabs are linkable (`/claude-home#plugins`). */
function useHashTab(): [ClaudeHomeTab, (tab: ClaudeHomeTab) => void] {
  const [tab, setTabState] = useState<ClaudeHomeTab>(() => tabFromHash(currentHash()));
  useEffect(() => {
    const onHashChange = () => setTabState(tabFromHash(currentHash()));
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);
  const setTab = useCallback((next: ClaudeHomeTab) => {
    setTabState(next);
    const { pathname, search } = window.location;
    window.history.replaceState(window.history.state, "", `${pathname}${search}#${next}`);
  }, []);
  return [tab, setTab];
}

export function ClaudeHomeContent({
  companyId,
  inventory,
}: {
  companyId: string;
  inventory: ClaudeHomeInventory;
}) {
  const queryClient = useQueryClient();
  const [tab, setTab] = useHashTab();
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

      <Tabs value={tab} onValueChange={(value) => setTab(value as ClaudeHomeTab)}>
        <TabsList variant="line" className="justify-start" aria-label="Claude Home sections">
          {CLAUDE_HOME_TABS.map((item) => (
            <TabsTrigger key={item.key} value={item.key} data-tab={item.key}>
              {item.label}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="mcp" className="pt-4">
          <McpTab companyId={companyId} inventory={inventory} />
        </TabsContent>
        <TabsContent value="plugins" className="pt-4">
          <PluginsTab companyId={companyId} inventory={inventory} />
        </TabsContent>
        <TabsContent value="settings" className="pt-4">
          <SettingsSection companyId={companyId} inventory={inventory} onSaved={setInventory} />
        </TabsContent>
        <TabsContent value="claude-md" className="pt-4">
          <ClaudeMdSection companyId={companyId} inventory={inventory} onSaved={setInventory} />
        </TabsContent>
        <TabsContent value="skills" className="pt-4">
          <SkillsAndAgentsSections inventory={inventory} />
        </TabsContent>
      </Tabs>
    </div>
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
