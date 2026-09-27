import type { AcpPermissionDecision, AcpPermissionRequest } from "acpx/runtime";
import type {
  AdapterExecutionContext,
  AdapterPermissionOutcome,
  AdapterPermissionRequest,
} from "../types.js";

/** Default time a host permission request may wait for a human, in seconds. */
export const DEFAULT_PERMISSION_WAIT_SEC = 600;
export const MIN_PERMISSION_WAIT_SEC = 10;
export const MAX_PERMISSION_WAIT_SEC = 86_400;

export type AcpxPermissionHandler = (
  request: AcpPermissionRequest,
  options: { signal: AbortSignal },
) => Promise<AcpPermissionDecision | undefined>;

/**
 * The mutable permission target a runtime carries across runs. The runtime's
 * `onPermissionRequest` hook is installed once, at runtime creation, and always
 * reads `current`. Each run claims the sink with its own handler (see
 * `claimAcpxPermissionSink`) and releases it when the run ends, so a warm
 * runtime never reaches a finished run's host callback.
 *
 * `bridgeEnabled` records the bridge mode of the last run that claimed the
 * sink. An empty sink (a late request after release, or a teardown race) fails
 * closed while the bridge is on, and returns `undefined` (the permission mode
 * decides, the legacy behavior) only while it is off.
 *
 * ACP handles are serialized per agent session, so at most one run owns a sink
 * at a time. `ownerRunId` names that run; an overlapping claim is reported and
 * the newest claim wins (the hook routes to the current owner), and a stale
 * release never clears a newer owner.
 */
export type AcpxPermissionSink = {
  current: AcpxPermissionHandler | null;
  bridgeEnabled: boolean;
  ownerRunId: string | null;
};

export function createAcpxPermissionSink(): AcpxPermissionSink {
  return { current: null, bridgeEnabled: false, ownerRunId: null };
}

function failClosedDecision(aborted: boolean): AcpPermissionDecision {
  return { outcome: aborted ? "cancel" : "reject_once" };
}

/** The runtime hook bound to a sink. */
export function acpxPermissionHookForSink(sink: AcpxPermissionSink): AcpxPermissionHandler {
  return async (request, options) => {
    const handler = sink.current;
    if (handler) return handler(request, options);
    if (!sink.bridgeEnabled) return undefined;
    return failClosedDecision(options.signal.aborted);
  };
}

/**
 * Point the sink at this run's handler (or none, when the run does not bridge)
 * and record the run's bridge mode. Returns the release, which clears the sink
 * only while this run still owns it. `onOverlap` fires when another run still
 * owned the sink; the new claim takes over routing.
 */
export function claimAcpxPermissionSink(input: {
  sink: AcpxPermissionSink;
  handler: AcpxPermissionHandler | null;
  runId: string;
  onOverlap?: (previousOwnerRunId: string | null) => void;
}): () => void {
  const { sink, handler, runId } = input;
  if (sink.ownerRunId !== null && sink.ownerRunId !== runId) input.onOverlap?.(sink.ownerRunId);
  sink.current = handler;
  sink.bridgeEnabled = handler !== null;
  sink.ownerRunId = runId;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (sink.ownerRunId !== runId || sink.current !== handler) return;
    sink.current = null;
    sink.ownerRunId = null;
  };
}

const OUTCOMES: ReadonlySet<AdapterPermissionOutcome> = new Set([
  "allow_once",
  "allow_always",
  "reject_once",
  "reject_always",
  "cancel",
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Map an ACP `session/request_permission` request to the adapter contract. */
export function mapAcpPermissionRequest(request: AcpPermissionRequest): AdapterPermissionRequest {
  const raw = asRecord(request.raw) ?? {};
  const toolCall = asRecord(raw.toolCall) ?? {};
  const meta = asRecord(toolCall._meta);
  const claudeCode = asRecord(meta?.claudeCode);
  const options = Array.isArray(raw.options) ? raw.options : [];
  return {
    toolCallId: asNullableString(toolCall.toolCallId),
    toolName: asNullableString(claudeCode?.toolName),
    title: asNullableString(toolCall.title),
    kind: asNullableString(toolCall.kind) ?? asNullableString(request.inferredKind),
    rawInput: toolCall.rawInput ?? null,
    options: options.flatMap((option) => {
      const record = asRecord(option);
      if (!record) return [];
      const optionId = asNullableString(record.optionId);
      if (!optionId) return [];
      return [{
        optionId,
        name: typeof record.name === "string" ? record.name : optionId,
        kind: typeof record.kind === "string" ? record.kind : "",
      }];
    }),
  };
}

/** Whether a run's config enables the host permission bridge. */
export function permissionBridgeEnabled(config: Record<string, unknown>): boolean {
  return config.permissionBridge !== "off";
}

/** The run's host wait bound, in milliseconds (default 600s, clamped 10s..24h). */
export function resolvePermissionWaitMs(config: Record<string, unknown>): number {
  const raw = config.permissionWaitSec;
  const parsed =
    typeof raw === "number"
      ? raw
      : typeof raw === "string" && raw.trim().length > 0
        ? Number(raw)
        : Number.NaN;
  const seconds = Number.isFinite(parsed) ? Math.trunc(parsed) : DEFAULT_PERMISSION_WAIT_SEC;
  return Math.min(MAX_PERMISSION_WAIT_SEC, Math.max(MIN_PERMISSION_WAIT_SEC, seconds)) * 1000;
}

/**
 * Build this run's permission handler, or `null` when the run cannot bridge
 * (no host hook or the bridge is off). The handler forwards to
 * `ctx.requestPermission` and records `permission.requested` /
 * `permission.resolved` run events (never the raw tool input).
 *
 * The handler fails closed: a host throw, a host `undefined`, or an invalid
 * outcome denies (`reject_once`), and an aborted run cancels (`cancel`), each
 * recorded with `source: "fail_closed"`. Returning `undefined` here would let
 * acpx's `approve-all` permission mode approve the tool call. `runSignal`
 * aborts when the run ends, so a host wait never outlives its run.
 */
export function createAcpxPermissionHandler(input: {
  ctx: Pick<AdapterExecutionContext, "requestPermission" | "onEvent" | "onLog" | "config" | "signal">;
  runSignal: AbortSignal;
}): AcpxPermissionHandler | null {
  const { ctx } = input;
  const requestPermission = ctx.requestPermission;
  const config = asRecord(ctx.config) ?? {};
  if (!requestPermission || !permissionBridgeEnabled(config)) return null;
  const waitMs = resolvePermissionWaitMs(config);
  const emit = async (eventType: string, payload: Record<string, unknown>, message: string) => {
    try {
      await ctx.onEvent?.({ eventType, stream: "system", level: "info", message, payload });
    } catch {
      // Run-event recording is best effort; it never changes the decision.
    }
  };
  const failClosed = async (
    toolCallId: string | null,
    aborted: boolean,
  ): Promise<AcpPermissionDecision> => {
    const decision = failClosedDecision(aborted);
    await emit(
      "permission.resolved",
      { toolCallId, outcome: decision.outcome, source: "fail_closed" },
      `Permission ${decision.outcome} (fail closed)`,
    );
    return decision;
  };
  return async (acpRequest, options) => {
    const request = mapAcpPermissionRequest(acpRequest);
    if (input.runSignal.aborted) return failClosed(request.toolCallId, true);
    await emit(
      "permission.requested",
      {
        toolName: request.toolName,
        title: request.title,
        kind: request.kind,
        toolCallId: request.toolCallId,
      },
      `Permission requested${request.toolName ? ` for ${request.toolName}` : ""}`,
    );
    const signals = [options.signal, input.runSignal, ...(ctx.signal ? [ctx.signal] : [])];
    const signal = AbortSignal.any(signals);
    let outcome: AdapterPermissionOutcome | null = null;
    try {
      const decision = await requestPermission(request, { signal, waitMs });
      if (decision && OUTCOMES.has(decision.outcome)) outcome = decision.outcome;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await ctx
        .onLog("stderr", `[paperclip] Permission bridge failed; denying the request: ${reason}\n`)
        .catch(() => {});
    }
    if (!outcome) return failClosed(request.toolCallId, signal.aborted);
    await emit(
      "permission.resolved",
      { toolCallId: request.toolCallId, outcome, source: "host" },
      `Permission ${outcome}`,
    );
    return { outcome };
  };
}
