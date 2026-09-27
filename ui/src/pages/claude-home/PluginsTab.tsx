import { useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, FileText, Loader2, Plus, RefreshCw, Search, Trash2 } from "lucide-react";
import type {
  ClaudeCliAvailablePlugin,
  ClaudeCliMarketplace,
  ClaudeCliMarketplacesResponse,
  ClaudeCliPluginsResponse,
  ClaudeHomeInventory,
} from "@paperclipai/shared";
import { claudeHomeApi } from "@/api/claudeHome";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { queryKeys } from "@/lib/queryKeys";
import { InventoryPluginsSection } from "./ConfigSections";
import { CliUnavailableBanner, InlineError, Section, errorMessage, isCliUnavailableError } from "./shared";

export const OFFICIAL_MARKETPLACE_SOURCE = "anthropics/claude-plugins-official";

type PluginsSubTab = "discover" | "installed" | "marketplaces";

const LONG_OPERATION_HINT = "This can take up to a minute.";

export function PluginsTab({ companyId, inventory }: { companyId: string; inventory: ClaudeHomeInventory }) {
  const queryClient = useQueryClient();
  const [subTab, setSubTab] = useState<PluginsSubTab>("discover");
  const [detailsId, setDetailsId] = useState<string | null>(null);

  const pluginsQuery = useQuery({
    queryKey: queryKeys.claudeCli.plugins(companyId),
    queryFn: () => claudeHomeApi.listPlugins(companyId),
    retry: false,
  });
  const marketplacesQuery = useQuery({
    queryKey: queryKeys.claudeCli.marketplaces(companyId),
    queryFn: () => claudeHomeApi.listMarketplaces(companyId),
    retry: false,
  });

  const setPlugins = (next: ClaudeCliPluginsResponse) =>
    queryClient.setQueryData(queryKeys.claudeCli.plugins(companyId), next);
  const setMarketplaces = (marketplaces: ClaudeCliMarketplace[]) => {
    queryClient.setQueryData<ClaudeCliMarketplacesResponse>(queryKeys.claudeCli.marketplaces(companyId), (prev) => ({
      cliAvailable: prev?.cliAvailable ?? true,
      marketplaces,
    }));
    // The Discover catalog comes from the marketplaces' files.
    void queryClient.invalidateQueries({ queryKey: queryKeys.claudeCli.plugins(companyId) });
  };

  const cliUnavailable =
    pluginsQuery.data?.cliAvailable === false ||
    marketplacesQuery.data?.cliAvailable === false ||
    isCliUnavailableError(pluginsQuery.error) ||
    isCliUnavailableError(marketplacesQuery.error);

  if (cliUnavailable) {
    return (
      <div className="space-y-6">
        <CliUnavailableBanner />
        <InventoryPluginsSection inventory={inventory} />
      </div>
    );
  }

  const installedCount = pluginsQuery.data?.installed.length;
  const marketplaceCount = marketplacesQuery.data?.marketplaces.length;

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        The same as <code className="font-mono">/plugin</code> in Claude Code. Plugins add skills, agents, hooks and
        MCP servers to every agent that uses this home.
      </p>
      <Tabs value={subTab} onValueChange={(value) => setSubTab(value as PluginsSubTab)}>
        <TabsList variant="line" className="justify-start" aria-label="Plugin views">
          <TabsTrigger value="discover">Discover</TabsTrigger>
          <TabsTrigger value="installed">
            Installed{installedCount !== undefined ? ` (${installedCount})` : ""}
          </TabsTrigger>
          <TabsTrigger value="marketplaces">
            Marketplaces{marketplaceCount !== undefined ? ` (${marketplaceCount})` : ""}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="discover" className="pt-4">
          <QueryState query={pluginsQuery} label="plugins">
            {(data) => (
              <DiscoverView
                companyId={companyId}
                data={data}
                noMarketplaces={marketplaceCount === 0}
                onPlugins={setPlugins}
                onDetails={setDetailsId}
                onGoToMarketplaces={() => setSubTab("marketplaces")}
              />
            )}
          </QueryState>
        </TabsContent>
        <TabsContent value="installed" className="pt-4">
          <QueryState query={pluginsQuery} label="plugins">
            {(data) => (
              <InstalledView companyId={companyId} data={data} onPlugins={setPlugins} onDetails={setDetailsId} />
            )}
          </QueryState>
        </TabsContent>
        <TabsContent value="marketplaces" className="pt-4">
          <QueryState query={marketplacesQuery} label="marketplaces">
            {(data) => (
              <MarketplacesView companyId={companyId} marketplaces={data.marketplaces} onMarketplaces={setMarketplaces} />
            )}
          </QueryState>
        </TabsContent>
      </Tabs>

      <PluginDetailsDialog companyId={companyId} pluginId={detailsId} onClose={() => setDetailsId(null)} />
    </div>
  );
}

function QueryState<T>({
  query,
  label,
  children,
}: {
  query: { isLoading: boolean; isError: boolean; error: unknown; data: T | undefined; refetch: () => unknown };
  label: string;
  children: (data: T) => ReactNode;
}) {
  if (query.isLoading) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
        Loading {label}…
      </p>
    );
  }
  if (query.isError || query.data === undefined) {
    return (
      <div
        className="flex flex-wrap items-center gap-3 rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive"
        role="alert"
      >
        <p className="min-w-0 flex-1">
          Couldn’t load {label}: {errorMessage(query.error)}
        </p>
        <Button type="button" size="sm" variant="outline" onClick={() => void query.refetch()}>
          Try again
        </Button>
      </div>
    );
  }
  return <>{children(query.data)}</>;
}

function FilterSelect({
  label,
  value,
  options,
  allLabel,
  onChange,
}: {
  label: string;
  value: string;
  options: string[];
  allLabel: string;
  onChange: (value: string) => void;
}) {
  return (
    <select
      aria-label={label}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className="h-9 rounded-md border border-input bg-background px-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
    >
      <option value="">{allLabel}</option>
      {options.map((option) => (
        <option key={option} value={option}>
          {option}
        </option>
      ))}
    </select>
  );
}

function matchesSearch(plugin: ClaudeCliAvailablePlugin, query: string): boolean {
  if (!query) return true;
  const haystack = [plugin.name, plugin.displayName, plugin.description, plugin.author, plugin.category, ...plugin.tags]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return haystack.includes(query);
}

function DiscoverView({
  companyId,
  data,
  noMarketplaces,
  onPlugins,
  onDetails,
  onGoToMarketplaces,
}: {
  companyId: string;
  data: ClaudeCliPluginsResponse;
  noMarketplaces: boolean;
  onPlugins: (next: ClaudeCliPluginsResponse) => void;
  onDetails: (id: string) => void;
  onGoToMarketplaces: () => void;
}) {
  const [search, setSearch] = useState("");
  const [marketplace, setMarketplace] = useState("");
  const [category, setCategory] = useState("");

  const install = useMutation({
    mutationFn: (id: string) => claudeHomeApi.installPlugin(companyId, id),
    onSuccess: onPlugins,
  });

  const installedIds = useMemo(() => new Set(data.installed.map((plugin) => plugin.id)), [data.installed]);
  const marketplaces = useMemo(
    () => [...new Set(data.available.map((plugin) => plugin.marketplace))].sort(),
    [data.available],
  );
  const categories = useMemo(
    () => [...new Set(data.available.map((plugin) => plugin.category).filter((c): c is string => Boolean(c)))].sort(),
    [data.available],
  );
  const query = search.trim().toLowerCase();
  const visible = data.available.filter(
    (plugin) =>
      (!marketplace || plugin.marketplace === marketplace) &&
      (!category || plugin.category === category) &&
      matchesSearch(plugin, query),
  );

  if (data.available.length === 0) {
    return (
      <div className="space-y-3 rounded-lg border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">
        <p>
          {noMarketplaces
            ? "No marketplaces yet. Add a marketplace to browse its plugins."
            : "The added marketplaces don’t list any plugins. Update them to fetch the latest catalog."}
        </p>
        <Button type="button" size="sm" variant="outline" onClick={onGoToMarketplaces}>
          Open Marketplaces
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Search
            className="pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            aria-label="Search plugins"
            placeholder="Search plugins"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className="pl-8"
          />
        </div>
        <FilterSelect
          label="Marketplace"
          value={marketplace}
          options={marketplaces}
          allLabel="All marketplaces"
          onChange={setMarketplace}
        />
        {categories.length > 0 ? (
          <FilterSelect
            label="Category"
            value={category}
            options={categories}
            allLabel="All categories"
            onChange={setCategory}
          />
        ) : null}
      </div>

      {install.isPending ? (
        <p className="flex items-center gap-2 text-xs text-muted-foreground" role="status">
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          Installing {install.variables}… {LONG_OPERATION_HINT}
        </p>
      ) : null}

      {visible.length === 0 ? (
        <p className="text-sm text-muted-foreground">No plugins match these filters.</p>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2" aria-label="Available plugins">
          {visible.map((plugin) => {
            const installed = plugin.installed || installedIds.has(plugin.id);
            const installing = install.isPending && install.variables === plugin.id;
            return (
              <li
                key={plugin.id}
                className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3"
                data-plugin-card={plugin.id}
              >
                <div className="min-w-0 space-y-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-sm font-semibold">{plugin.displayName || plugin.name}</span>
                    {plugin.version ? (
                      <span className="shrink-0 font-mono text-xs text-muted-foreground">v{plugin.version}</span>
                    ) : null}
                  </div>
                  <div className="truncate font-mono text-xs text-muted-foreground">{plugin.id}</div>
                </div>
                {plugin.description ? (
                  <p className="line-clamp-2 text-sm text-muted-foreground" title={plugin.description}>
                    {plugin.description}
                  </p>
                ) : null}
                <div className="flex flex-wrap items-center gap-1">
                  {plugin.category ? <Badge variant="secondary">{plugin.category}</Badge> : null}
                  {plugin.tags.slice(0, 4).map((tag) => (
                    <Badge key={tag} variant="outline">
                      {tag}
                    </Badge>
                  ))}
                </div>
                <div className="text-xs text-muted-foreground">
                  {plugin.author ? <>By {plugin.author} · </> : null}
                  <span className="font-mono">{plugin.marketplace}</span>
                </div>
                {install.isError && install.variables === plugin.id ? (
                  <InlineError error={install.error} prefix="Install failed" />
                ) : null}
                <div className="mt-auto flex items-center gap-2 pt-1">
                  <Button
                    type="button"
                    size="xs"
                    variant={installed ? "outline" : "default"}
                    disabled={installed || install.isPending}
                    aria-label={installed ? `${plugin.id} is installed` : `Install ${plugin.id}`}
                    onClick={() => install.mutate(plugin.id)}
                  >
                    {installing ? <Loader2 className="animate-spin" aria-hidden /> : <Download aria-hidden />}
                    {installed ? "Installed" : installing ? "Installing…" : "Install"}
                  </Button>
                  <Button type="button" size="xs" variant="ghost" onClick={() => onDetails(plugin.id)}>
                    <FileText aria-hidden />
                    Details
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

type InstalledAction = "update" | "uninstall" | "toggle";

function InstalledView({
  companyId,
  data,
  onPlugins,
  onDetails,
}: {
  companyId: string;
  data: ClaudeCliPluginsResponse;
  onPlugins: (next: ClaudeCliPluginsResponse) => void;
  onDetails: (id: string) => void;
}) {
  const [confirmUninstall, setConfirmUninstall] = useState<string | null>(null);
  const action = useMutation({
    mutationFn: (input: { id: string; kind: InstalledAction; enabled?: boolean }) => {
      if (input.kind === "toggle") return claudeHomeApi.setPluginEnabled(companyId, input.id, Boolean(input.enabled));
      if (input.kind === "update") return claudeHomeApi.updatePlugin(companyId, input.id);
      return claudeHomeApi.uninstallPlugin(companyId, input.id);
    },
    onSuccess: (next) => {
      onPlugins(next);
      setConfirmUninstall(null);
    },
  });
  const availableById = useMemo(
    () => new Map(data.available.map((plugin) => [plugin.id, plugin])),
    [data.available],
  );
  const pendingFor = (id: string, kind?: InstalledAction) =>
    action.isPending && action.variables?.id === id && (!kind || action.variables.kind === kind);

  if (data.installed.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">
        No plugins installed. Find one on the Discover tab.
      </p>
    );
  }

  return (
    <ul className="divide-y divide-border rounded-lg border border-border" aria-label="Installed plugins">
      {data.installed.map((plugin) => {
        const catalog = availableById.get(plugin.id);
        const pending = pendingFor(plugin.id);
        const pendingLabel = pendingFor(plugin.id, "update")
          ? `Updating ${plugin.id}… ${LONG_OPERATION_HINT}`
          : pendingFor(plugin.id, "uninstall")
            ? `Uninstalling ${plugin.id}…`
            : pendingFor(plugin.id, "toggle")
              ? action.variables?.enabled
                ? "Enabling…"
                : "Disabling…"
              : null;
        return (
          <li key={plugin.id} className="space-y-2 px-3 py-3" data-installed-plugin={plugin.id}>
            <div className="flex flex-wrap items-center gap-3">
              <ToggleSwitch
                checked={plugin.enabled}
                disabled={action.isPending}
                aria-label={`${plugin.enabled ? "Disable" : "Enable"} ${plugin.id}`}
                onCheckedChange={(enabled) => action.mutate({ id: plugin.id, kind: "toggle", enabled })}
              />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{catalog?.displayName || catalog?.name || plugin.id}</div>
                <div className="truncate font-mono text-xs text-muted-foreground">
                  {plugin.id}
                  {plugin.version ? ` · v${plugin.version}` : ""}
                  {plugin.scope ? ` · ${plugin.scope}` : ""}
                </div>
              </div>
              {confirmUninstall === plugin.id ? (
                <div className="flex flex-wrap items-center gap-2" data-testid="plugin-uninstall-confirm">
                  <span className="text-xs">Uninstall {plugin.id}?</span>
                  <Button
                    type="button"
                    size="xs"
                    variant="destructive"
                    disabled={action.isPending}
                    onClick={() => action.mutate({ id: plugin.id, kind: "uninstall" })}
                  >
                    {pendingFor(plugin.id, "uninstall") ? "Uninstalling…" : "Uninstall"}
                  </Button>
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    disabled={action.isPending}
                    onClick={() => setConfirmUninstall(null)}
                  >
                    Cancel
                  </Button>
                </div>
              ) : (
                <div className="flex flex-wrap items-center gap-1">
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    disabled={action.isPending}
                    onClick={() => action.mutate({ id: plugin.id, kind: "update" })}
                  >
                    <RefreshCw aria-hidden />
                    {pendingFor(plugin.id, "update") ? "Updating…" : "Update"}
                  </Button>
                  <Button type="button" size="xs" variant="ghost" onClick={() => onDetails(plugin.id)}>
                    <FileText aria-hidden />
                    Details
                  </Button>
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    disabled={action.isPending}
                    onClick={() => {
                      action.reset();
                      setConfirmUninstall(plugin.id);
                    }}
                  >
                    <Trash2 aria-hidden />
                    Uninstall
                  </Button>
                </div>
              )}
            </div>
            {pending && pendingLabel ? (
              <p className="flex items-center gap-2 text-xs text-muted-foreground" role="status">
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                {pendingLabel}
              </p>
            ) : null}
            {action.isError && action.variables?.id === plugin.id ? <InlineError error={action.error} /> : null}
          </li>
        );
      })}
    </ul>
  );
}

function MarketplacesView({
  companyId,
  marketplaces,
  onMarketplaces,
}: {
  companyId: string;
  marketplaces: ClaudeCliMarketplace[];
  onMarketplaces: (marketplaces: ClaudeCliMarketplace[]) => void;
}) {
  const [source, setSource] = useState("");
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);

  const add = useMutation({
    mutationFn: (value: string) => claudeHomeApi.addMarketplace(companyId, value),
    onSuccess: (next) => {
      onMarketplaces(next.marketplaces);
      setSource("");
    },
  });
  const update = useMutation({
    /** `null` updates every marketplace. */
    mutationFn: (name: string | null) => claudeHomeApi.updateMarketplaces(companyId, name ?? undefined),
    onSuccess: (next) => onMarketplaces(next.marketplaces),
  });
  const remove = useMutation({
    mutationFn: (name: string) => claudeHomeApi.removeMarketplace(companyId, name),
    onSuccess: (next) => {
      onMarketplaces(next.marketplaces);
      setConfirmRemove(null);
    },
  });
  const busy = add.isPending || update.isPending || remove.isPending;
  const trimmed = source.trim();

  return (
    <div className="space-y-6">
      <Section
        title="Add marketplace"
        description="A GitHub repo, a git URL, or a URL to a marketplace.json."
      >
        <form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!trimmed || busy) return;
            add.mutate(trimmed);
          }}
        >
          <Label htmlFor="claude-marketplace-source" className="sr-only">
            Marketplace source
          </Label>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              id="claude-marketplace-source"
              aria-label="Marketplace source"
              value={source}
              onChange={(event) => setSource(event.target.value)}
              placeholder={OFFICIAL_MARKETPLACE_SOURCE}
              spellCheck={false}
              autoComplete="off"
              className="min-w-0 flex-1 font-mono text-xs"
            />
            <Button type="submit" size="sm" disabled={!trimmed || busy}>
              {add.isPending ? <Loader2 className="animate-spin" aria-hidden /> : <Plus aria-hidden />}
              {add.isPending ? "Adding…" : "Add marketplace"}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Examples: <code className="font-mono">{OFFICIAL_MARKETPLACE_SOURCE}</code>,{" "}
            <code className="font-mono">https://example.com/marketplace.json</code>
          </p>
          {add.isPending ? (
            <p className="text-xs text-muted-foreground" role="status">
              Fetching the marketplace… {LONG_OPERATION_HINT}
            </p>
          ) : null}
          <InlineError error={add.error} prefix="Couldn’t add the marketplace" />
        </form>
      </Section>

      <Section
        title="Marketplaces"
        action={
          marketplaces.length > 0 ? (
            <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => update.mutate(null)}>
              {update.isPending && update.variables === null ? (
                <Loader2 className="animate-spin" aria-hidden />
              ) : (
                <RefreshCw aria-hidden />
              )}
              {update.isPending && update.variables === null ? "Updating all…" : "Update all"}
            </Button>
          ) : null
        }
      >
        {update.isError && update.variables === null ? (
          <InlineError error={update.error} prefix="Update failed" />
        ) : null}
        {marketplaces.length === 0 ? (
          <div
            className="space-y-3 rounded-lg border border-dashed border-border px-4 py-6 text-sm text-muted-foreground"
            data-testid="marketplaces-empty"
          >
            <p>No marketplaces yet. Start with Anthropic’s official marketplace.</p>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setSource(OFFICIAL_MARKETPLACE_SOURCE)}
            >
              Use {OFFICIAL_MARKETPLACE_SOURCE}
            </Button>
          </div>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead className="bg-accent/20 text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">Name</th>
                  <th className="px-3 py-2 font-medium">Source</th>
                  <th className="px-3 py-2 font-medium">Location</th>
                  <th className="px-3 py-2 font-medium">Plugins</th>
                  <th className="px-3 py-2 font-medium">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {marketplaces.map((marketplace) => {
                  const updating = update.isPending && update.variables === marketplace.name;
                  const rowError =
                    (update.isError && update.variables === marketplace.name ? update.error : null) ??
                    (remove.isError && remove.variables === marketplace.name ? remove.error : null);
                  return (
                    <tr key={marketplace.name} className="border-t border-border align-top" data-marketplace={marketplace.name}>
                      <td className="px-3 py-2 font-mono text-xs">{marketplace.name}</td>
                      <td className="px-3 py-2 text-xs">{marketplace.source}</td>
                      <td
                        className="max-w-xs truncate px-3 py-2 font-mono text-xs text-muted-foreground"
                        title={marketplace.location ?? ""}
                      >
                        {marketplace.location ?? "—"}
                      </td>
                      <td className="px-3 py-2 font-mono text-xs">{marketplace.pluginCount ?? "—"}</td>
                      <td className="px-3 py-2">
                        {confirmRemove === marketplace.name ? (
                          <div className="flex flex-wrap items-center justify-end gap-2" data-testid="marketplace-remove-confirm">
                            <span className="text-xs">Remove {marketplace.name}?</span>
                            <Button
                              type="button"
                              size="xs"
                              variant="destructive"
                              disabled={busy}
                              onClick={() => remove.mutate(marketplace.name)}
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
                          <div className="flex items-center justify-end gap-1">
                            <Button
                              type="button"
                              size="xs"
                              variant="outline"
                              disabled={busy}
                              aria-label={`Update ${marketplace.name}`}
                              onClick={() => update.mutate(marketplace.name)}
                            >
                              {updating ? <Loader2 className="animate-spin" aria-hidden /> : <RefreshCw aria-hidden />}
                              {updating ? "Updating…" : "Update"}
                            </Button>
                            <Button
                              type="button"
                              size="xs"
                              variant="ghost"
                              disabled={busy}
                              aria-label={`Remove ${marketplace.name}`}
                              onClick={() => {
                                remove.reset();
                                setConfirmRemove(marketplace.name);
                              }}
                            >
                              <Trash2 aria-hidden />
                              Remove
                            </Button>
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
      </Section>
    </div>
  );
}

function PluginDetailsDialog({
  companyId,
  pluginId,
  onClose,
}: {
  companyId: string;
  pluginId: string | null;
  onClose: () => void;
}) {
  const detailsQuery = useQuery({
    queryKey: queryKeys.claudeCli.pluginDetails(companyId, pluginId ?? "__none__"),
    queryFn: () => claudeHomeApi.pluginDetails(companyId, pluginId!),
    enabled: pluginId !== null,
    retry: false,
  });
  return (
    <Dialog open={pluginId !== null} onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="break-all font-mono text-sm">{pluginId}</DialogTitle>
          <DialogDescription>
            What <code className="font-mono">claude plugin details</code> reports: components and projected token
            cost.
          </DialogDescription>
        </DialogHeader>
        {detailsQuery.isLoading ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            Loading details…
          </p>
        ) : detailsQuery.isError ? (
          <InlineError error={detailsQuery.error} prefix="Couldn’t load details" />
        ) : (
          <pre
            className="max-h-96 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-3 font-mono text-xs"
            data-testid="plugin-details-text"
          >
            {detailsQuery.data?.text || "No details."}
          </pre>
        )}
      </DialogContent>
    </Dialog>
  );
}
