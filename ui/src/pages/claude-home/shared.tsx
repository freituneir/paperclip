import type { ReactNode } from "react";
import { SquareTerminal } from "lucide-react";
import type { ClaudeNamedItem } from "@paperclipai/shared";
import { ApiError } from "@/api/client";

export function isForbidden(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403;
}

/** The server answers 503 `claude_cli_unavailable` when the `claude` binary is missing on the host. */
export function isCliUnavailableError(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  const body = error.body as { code?: unknown; error?: unknown } | null;
  return (
    error.status === 503 ||
    body?.code === "claude_cli_unavailable" ||
    body?.error === "claude_cli_unavailable"
  );
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong.";
}

export function Section({
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

export function InlineError({ error, prefix }: { error: unknown; prefix?: string }) {
  if (!error) return null;
  return (
    <p className="text-xs text-destructive" role="alert">
      {prefix ? `${prefix}: ` : null}
      {errorMessage(error)}
    </p>
  );
}

/** Shown on the MCP and Plugins tabs when the server can't run the `claude` binary. */
export function CliUnavailableBanner() {
  return (
    <div
      className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3 text-sm text-muted-foreground"
      data-testid="claude-cli-unavailable"
    >
      <SquareTerminal className="h-4 w-4 shrink-0" aria-hidden />
      <p className="min-w-0 flex-1">
        Claude Code CLI isn’t available on the Paperclip host; showing a read-only view.
      </p>
    </div>
  );
}

export function NamedItemList({
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
