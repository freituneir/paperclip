import type { ReactNode } from "react";
import { ChevronRight, Copy } from "lucide-react";
import type { ClaudeLaunchManifest, ClaudeNamedItem } from "@paperclipai/shared";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { CopyText } from "@/components/CopyText";
import { InlineBanner } from "@/components/InlineBanner";
import { cn } from "@/lib/utils";
import { OriginBadge } from "./OriginBadge";

export const UNGOVERNED_MCP_LEGEND =
  "Claude Code servers run natively and are not governed by Paperclip approvals.";

/** POSIX single-quote a value: `it's` → `'it'\''s'`. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function shellArg(value: string): string {
  return /^[A-Za-z0-9._:@%+=/-]+$/.test(value) ? value : shellQuote(value);
}

/**
 * Command that resumes a run's session in real Claude Code on the Paperclip
 * host. Only possible when the run used the company Claude Home and we know
 * the cwd and session id; returns null otherwise.
 */
export function buildTakeoverCommand(
  manifest: ClaudeLaunchManifest,
  sessionId?: string | null,
): string | null {
  const session = (sessionId ?? manifest.sessionId ?? "").trim();
  const cwd = manifest.cwd?.trim();
  const dir = manifest.claudeHome.dir?.trim();
  if (manifest.claudeHome.mode !== "company" || !dir || !cwd || !session) return null;
  return `cd ${shellQuote(cwd)} && CLAUDE_CONFIG_DIR=${shellQuote(dir)} claude --resume ${shellArg(session)}`;
}

function Chip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Badge variant="outline" className="font-normal">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono">{children}</span>
    </Badge>
  );
}

type PermissionBridgeState = "task_chat" | "off" | "unavailable";

/**
 * `permission.bridge` is added to the shared manifest type by the engine; read
 * it through a narrow guard so older manifests (and older type shapes) still
 * render.
 */
export function readPermissionBridge(manifest: ClaudeLaunchManifest): PermissionBridgeState | null {
  const permission = manifest.permission as unknown;
  if (!permission || typeof permission !== "object") return null;
  const bridge = (permission as { bridge?: unknown }).bridge;
  return bridge === "task_chat" || bridge === "off" || bridge === "unavailable" ? bridge : null;
}

const PERMISSION_BRIDGE_LABELS: Record<PermissionBridgeState, string> = {
  task_chat: "Ask rules → approval cards",
  off: "Ask rules auto-denied",
  unavailable: "Approval cards unavailable",
};

function NamedGroup({ title, items }: { title: string; items: ClaudeNamedItem[] }) {
  if (items.length === 0) return null;
  return (
    <Collapsible>
      <CollapsibleTrigger className="group flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground">
        <ChevronRight className="h-3 w-3 transition-transform group-data-[state=open]:rotate-90" />
        {title}
        <span className="tabular-nums">({items.length})</span>
      </CollapsibleTrigger>
      <CollapsibleContent className="pt-1.5">
        <ul className="space-y-1 pl-4">
          {items.map((item) => (
            <li key={`${item.origin}:${item.name}`} className="flex flex-wrap items-center gap-2 text-xs">
              <span className="font-mono">{item.name}</span>
              <OriginBadge origin={item.origin} />
              {item.description ? (
                <span className="min-w-0 text-muted-foreground">{item.description}</span>
              ) : null}
            </li>
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
}

function HooksGroup({ hooks }: { hooks: ClaudeLaunchManifest["hooks"] }) {
  if (hooks.length === 0) return null;
  const total = hooks.reduce((sum, hook) => sum + hook.count, 0);
  return (
    <Collapsible>
      <CollapsibleTrigger className="group flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground">
        <ChevronRight className="h-3 w-3 transition-transform group-data-[state=open]:rotate-90" />
        Hooks
        <span className="tabular-nums">({total})</span>
      </CollapsibleTrigger>
      <CollapsibleContent className="pt-1.5">
        <ul className="space-y-1 pl-4">
          {hooks.map((hook) => (
            <li key={hook.event} className="text-xs">
              <span className="font-mono">{hook.event}</span>
              <span className="text-muted-foreground tabular-nums"> × {hook.count}</span>
            </li>
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** What a Claude Code run launched with (or an agent will launch with), with origin badges. */
export function LaunchManifestCard({
  manifest,
  sessionId,
  compact = false,
}: {
  manifest: ClaudeLaunchManifest;
  sessionId?: string | null;
  compact?: boolean;
}) {
  const hasUngoverned = manifest.mcpServers.some((server) => !server.governed);
  const takeoverCommand = buildTakeoverCommand(manifest, sessionId);
  const homeLabel = manifest.claudeHome.mode === "company" ? "company" : "isolated";
  const permissionBridge = readPermissionBridge(manifest);

  return (
    <div
      className={cn(
        "space-y-2",
        !compact && "rounded-lg border border-border bg-background/60 p-3",
      )}
      data-testid="launch-manifest-card"
    >
      {!compact && <div className="text-xs font-medium text-muted-foreground">Launch manifest</div>}

      <div className="flex flex-wrap gap-1.5">
        <Chip label="Engine">{manifest.engine}</Chip>
        <Chip label="Model">
          {manifest.model ?? "default"}
          {manifest.fallbackModel ? ` · fallback: ${manifest.fallbackModel}` : ""}
        </Chip>
        {manifest.effort ? <Chip label="Effort">{manifest.effort}</Chip> : null}
        <Chip label="Permissions">{manifest.permission.mode}</Chip>
        <Chip label="Claude Home">{homeLabel}</Chip>
        {permissionBridge ? (
          <Badge variant="outline" className="font-normal" data-testid="launch-manifest-permission-bridge">
            {PERMISSION_BRIDGE_LABELS[permissionBridge]}
          </Badge>
        ) : null}
      </div>

      {manifest.claudeHome.dir ? (
        <div className="text-xs break-all">
          <span className="text-muted-foreground">Claude Home dir: </span>
          <span className="font-mono">{manifest.claudeHome.dir}</span>
        </div>
      ) : null}

      <div className="space-y-1">
        <div className="text-xs text-muted-foreground">
          MCP servers <span className="tabular-nums">({manifest.mcpServers.length})</span>
          {manifest.nativeMcp === "disabled" ? " · native MCP disabled" : ""}
        </div>
        {manifest.mcpServers.length === 0 ? (
          <p className="text-xs text-muted-foreground">No MCP servers.</p>
        ) : (
          <ul className="space-y-1">
            {manifest.mcpServers.map((server) => (
              <li
                key={`${server.origin}:${server.name}`}
                className="flex flex-wrap items-center gap-2 text-xs"
                data-governed={server.governed ? "true" : "false"}
              >
                <span className="font-mono font-medium">{server.name}</span>
                <OriginBadge origin={server.origin} />
                <span className="text-muted-foreground">{server.transport}</span>
                {server.target ? (
                  <span className="min-w-0 break-all font-mono text-muted-foreground">{server.target}</span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {hasUngoverned ? <p className="text-xs text-muted-foreground">{UNGOVERNED_MCP_LEGEND}</p> : null}
      </div>

      <div className="space-y-1">
        <NamedGroup title="Plugins" items={manifest.plugins} />
        <NamedGroup title="Skills" items={manifest.skills} />
        <NamedGroup title="Subagents" items={manifest.subagents} />
        <NamedGroup title="Slash commands" items={manifest.commands} />
        <HooksGroup hooks={manifest.hooks} />
      </div>

      <div className="text-xs">
        <span className="text-muted-foreground">Setting sources: </span>
        <span className="font-mono">
          {manifest.settingSources.length > 0 ? manifest.settingSources.join(", ") : "none"}
        </span>
        {manifest.settingsOverlayKeys.length > 0 ? (
          <>
            <span className="text-muted-foreground"> · overlay keys: </span>
            <span className="font-mono">{manifest.settingsOverlayKeys.join(", ")}</span>
          </>
        ) : null}
      </div>

      {manifest.warnings.length > 0 ? (
        <InlineBanner tone="warning" compact title="Warnings">
          <ul className="list-disc space-y-1 pl-4">
            {manifest.warnings.map((warning, index) => (
              <li key={`${index}-${warning}`}>{warning}</li>
            ))}
          </ul>
        </InlineBanner>
      ) : null}

      {takeoverCommand ? (
        <div className="space-y-1" data-testid="launch-manifest-takeover">
          <div className="text-xs text-muted-foreground">
            Continue this session in real Claude Code on the Paperclip host (prefix with{" "}
            <code className="font-mono">docker compose exec -it paperclip</code> when running in Docker).
          </div>
          <CopyText
            text={takeoverCommand}
            ariaLabel="Copy takeover command"
            title="Copy command"
            containerClassName="flex w-full"
            className="flex w-full items-start gap-2 rounded-md border border-border bg-muted/40 p-2 text-left font-mono text-xs break-all"
          >
            <span className="min-w-0 flex-1">{takeoverCommand}</span>
            <Copy className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />
          </CopyText>
        </div>
      ) : null}
    </div>
  );
}
