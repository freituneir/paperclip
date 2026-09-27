import { useEffect, useState } from "react";
import { CheckCircle2, Clock, Loader2, MinusCircle, ShieldQuestion, XCircle } from "lucide-react";
import type { IssueThreadInteraction } from "@paperclipai/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface ClaudePermissionOption {
  optionId: string;
  name: string;
  kind: string;
}

/**
 * `payload.claudePermission` on a `request_confirmation` interaction, written by
 * the server permission bridge when Claude Code hits an `ask` rule. Parsed
 * defensively: every field may be missing on an older or partial payload.
 */
export interface ClaudePermissionPayload {
  fingerprint: string;
  toolName: string | null;
  title: string | null;
  kind: string | null;
  inputPreview: string;
  options: ClaudePermissionOption[];
  alwaysAvailable: boolean;
  runId: string;
  agentId: string;
  parkedAt: string | null;
  consumedAt: string | null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads `payload.claudePermission` from any interaction. Returns null unless
 * the interaction is a `request_confirmation` carrying an object there.
 */
export function readClaudePermissionPayload(
  interaction: IssueThreadInteraction,
): ClaudePermissionPayload | null {
  if (interaction.kind !== "request_confirmation") return null;
  const payload = interaction.payload as unknown;
  if (!isRecord(payload)) return null;
  const raw = payload.claudePermission;
  if (!isRecord(raw)) return null;
  const options = Array.isArray(raw.options)
    ? raw.options.filter(isRecord).map((option) => ({
        optionId: String(option.optionId ?? ""),
        name: String(option.name ?? ""),
        kind: String(option.kind ?? ""),
      }))
    : [];
  return {
    fingerprint: String(raw.fingerprint ?? ""),
    toolName: stringOrNull(raw.toolName),
    title: stringOrNull(raw.title),
    kind: stringOrNull(raw.kind),
    inputPreview: typeof raw.inputPreview === "string" ? raw.inputPreview : "",
    options,
    alwaysAvailable: raw.alwaysAvailable === true,
    runId: String(raw.runId ?? ""),
    agentId: String(raw.agentId ?? ""),
    parkedAt: stringOrNull(raw.parkedAt),
    consumedAt: stringOrNull(raw.consumedAt),
  };
}

export function claudePermissionToolLabel(permission: ClaudePermissionPayload): string {
  return permission.toolName ?? permission.title ?? "a tool";
}

export const CLAUDE_PERMISSION_PARKED_NOTE =
  "The agent stopped waiting; approving lets it retry on its next run.";

type Decision = "once" | "always" | "deny";

type ResolvedState = "allowed" | "always" | "used" | "denied" | "expired" | "cancelled" | "failed";

function wasAlwaysAllowed(interaction: IssueThreadInteraction): boolean {
  const result = interaction.result as unknown;
  if (!isRecord(result)) return false;
  if (result.rememberAction === true || result.rememberedAction === true) return true;
  const bridge = result.claudePermission;
  if (!isRecord(bridge)) return false;
  return bridge.outcome === "allow_always" || bridge.rememberAction === true;
}

function resolvedState(
  interaction: IssueThreadInteraction,
  permission: ClaudePermissionPayload,
): ResolvedState | null {
  switch (interaction.status) {
    case "pending":
      return null;
    case "accepted":
      if (wasAlwaysAllowed(interaction)) return "always";
      return permission.consumedAt ? "used" : "allowed";
    case "rejected":
      return "denied";
    case "expired":
      return "expired";
    case "cancelled":
      return "cancelled";
    case "answered":
      return permission.consumedAt ? "used" : "allowed";
    default:
      return "failed";
  }
}

const RESOLVED_COPY: Record<ResolvedState, { label: string; Icon: typeof CheckCircle2 }> = {
  allowed: { label: "Allowed once", Icon: CheckCircle2 },
  always: { label: "Always allowed", Icon: CheckCircle2 },
  used: { label: "Allowed once · used on the agent's retry", Icon: CheckCircle2 },
  denied: { label: "Denied", Icon: XCircle },
  expired: { label: "Expired", Icon: Clock },
  cancelled: { label: "Cancelled", Icon: MinusCircle },
  failed: { label: "Could not be answered", Icon: XCircle },
};

function rejectReason(interaction: IssueThreadInteraction): string | null {
  const result = interaction.result as unknown;
  if (!isRecord(result)) return null;
  return stringOrNull(result.reason)?.trim() ?? null;
}

export interface ClaudePermissionCardProps {
  interaction: IssueThreadInteraction;
  permission: ClaudePermissionPayload;
  /** Accept; `rememberAction` true means "Always allow". */
  onAllow?: (rememberAction: boolean) => Promise<void> | void;
  onDeny?: () => Promise<void> | void;
  /** Maps a failed answer to inline copy; defaults to the error message. */
  resolveErrorMessage?: (error: unknown) => string;
}

/**
 * Approval card for a Claude Code `ask` permission rule. Allow once / Always
 * allow / Deny while pending; a read-only outcome line once resolved.
 */
export function ClaudePermissionCard({
  interaction,
  permission,
  onAllow,
  onDeny,
  resolveErrorMessage,
}: ClaudePermissionCardProps) {
  const [working, setWorking] = useState<Decision | null>(null);
  const [error, setError] = useState<string | null>(null);
  const state = resolvedState(interaction, permission);
  const isPending = state === null;
  const toolLabel = claudePermissionToolLabel(permission);

  useEffect(() => {
    if (!isPending) setWorking(null);
  }, [interaction.id, isPending]);

  async function decide(decision: Decision) {
    setWorking(decision);
    setError(null);
    try {
      if (decision === "deny") await onDeny?.();
      else await onAllow?.(decision === "always");
    } catch (caught) {
      setError(
        resolveErrorMessage
          ? resolveErrorMessage(caught)
          : caught instanceof Error && caught.message
            ? caught.message
            : "Could not send your answer. Try again.",
      );
    } finally {
      setWorking(null);
    }
  }

  const resolved = state ? RESOLVED_COPY[state] : null;
  const reason = state === "denied" ? rejectReason(interaction) : null;
  const busy = working !== null;

  return (
    <div className="space-y-3 text-foreground" data-testid="claude-permission-card">
      <div className="flex items-start gap-3">
        <ShieldQuestion className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0 flex-1 space-y-1">
          <Badge variant="outline" className="font-normal text-muted-foreground">
            Claude Code permission
          </Badge>
          <p className="text-sm font-semibold break-words">
            Claude Code wants to use <span className="font-mono">{toolLabel}</span>
          </p>
          <p className="text-xs text-muted-foreground">
            Matched a permission rule that asks first (Claude Code <code className="font-mono">ask</code>)
          </p>
        </div>
      </div>

      {permission.inputPreview ? (
        <pre
          className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3 font-mono text-xs text-foreground"
          data-testid="claude-permission-preview"
        >
          {permission.inputPreview}
        </pre>
      ) : null}

      {isPending && permission.parkedAt ? (
        <p className="text-xs text-muted-foreground" data-testid="claude-permission-parked">
          {CLAUDE_PERMISSION_PARKED_NOTE}
        </p>
      ) : null}

      {isPending ? (
        <div className="flex flex-wrap justify-end gap-2" role="group" aria-label="Answer permission request">
          <Button size="sm" variant="outline" disabled={!onDeny || busy} onClick={() => void decide("deny")}>
            {working === "deny" ? "Denying…" : "Deny"}
          </Button>
          {permission.alwaysAvailable ? (
            <Button size="sm" variant="outline" disabled={!onAllow || busy} onClick={() => void decide("always")}>
              {working === "always" ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Saving…
                </>
              ) : (
                "Always allow"
              )}
            </Button>
          ) : null}
          <Button size="sm" variant="cta" disabled={!onAllow || busy} onClick={() => void decide("once")}>
            {working === "once" ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Allowing…
              </>
            ) : (
              "Allow once"
            )}
          </Button>
        </div>
      ) : resolved ? (
        <div className="space-y-1 text-sm text-muted-foreground" aria-live="polite" data-testid="claude-permission-outcome">
          <p className="flex items-center gap-1.5">
            <resolved.Icon className={cn("h-3.5 w-3.5 shrink-0", state === "denied" && "text-destructive")} />
            {resolved.label}
          </p>
          {reason ? <p className="break-words">{reason}</p> : null}
        </div>
      ) : null}

      <div aria-live="assertive">
        {error ? (
          <div className="rounded-sm border border-destructive/60 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        ) : null}
      </div>
    </div>
  );
}
