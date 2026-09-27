import { createHash } from "node:crypto";

import { and, asc, eq, gte, isNotNull, isNull, like, sql } from "drizzle-orm";

import type { Db } from "@paperclipai/db";
import { issueThreadInteractions } from "@paperclipai/db";
import type {
  AdapterExecutionContext,
  AdapterPermissionDecision,
  AdapterPermissionOutcome,
  AdapterPermissionRequest,
} from "@paperclipai/adapter-utils/types";
import type { RequestConfirmationClaudePermissionPayload } from "@paperclipai/shared";

import { logger } from "../middleware/logger.js";
import { redactSensitiveText } from "../redaction.js";
import { issueThreadInteractionService } from "./issue-thread-interactions.js";
import { createRunSecretRedactionRegistry } from "./run-secret-redaction.js";

/**
 * Claude permission bridge: a Claude Code `ask`-rule permission request raised
 * by a claude_local run becomes a `request_confirmation` card in the task chat.
 *
 * - A live run waits (up to `waitMs`) for the human answer.
 * - An answer that arrives after the wait (or after the run ended) is recorded
 *   on the card; an acceptance is left unconsumed and acts as a one-time grant
 *   for the next matching request of the same agent on the same issue.
 */

export const CLAUDE_PERMISSION_IDEMPOTENCY_PREFIX = "claude-permission:";
export const CLAUDE_PERMISSION_INPUT_PREVIEW_MAX = 2000;
export const CLAUDE_PERMISSION_GRANT_TTL_MS = 24 * 60 * 60 * 1000;

export type ClaudePermissionPayload = RequestConfirmationClaudePermissionPayload;

export interface ClaudePermissionBinding {
  companyId: string;
  agentId: string;
  runId: string;
  issueId: string | null;
}

/** The subset of an interaction row the bridge needs. */
export interface ClaudePermissionInteractionRef {
  id: string;
  companyId: string;
  issueId: string;
  status: string;
  payload: unknown;
  /** Provenance: a bridge card is created by the agent itself, never a user. */
  idempotencyKey: string | null;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  resolvedByAgentId: string | null;
  resolvedByUserId: string | null;
  requestedResolverPolicy: string | null;
  effectiveResolverPolicy: string | null;
}

export interface ClaudePermissionGrantQuery {
  companyId: string;
  issueId: string;
  agentId: string;
  fingerprint: string;
  since: Date;
}

export interface ClaudePermissionCreateInput {
  companyId: string;
  issueId: string;
  agentId: string;
  runId: string;
  idempotencyKey: string;
  claudePermission: ClaudePermissionPayload;
}

/** Persistence seam, so the bridge can be unit-tested without a database. */
export interface ClaudePermissionStore {
  findByIdempotencyKey(input: {
    companyId: string;
    issueId: string;
    idempotencyKey: string;
  }): Promise<ClaudePermissionInteractionRef | null>;
  /**
   * Accepted, unconsumed grants with bridge provenance (created by this
   * agent's bridge, human-only, resolved by a user, outcome recorded), oldest
   * first.
   */
  findGrantCandidates(query: ClaudePermissionGrantQuery): Promise<ClaudePermissionInteractionRef[]>;
  create(input: ClaudePermissionCreateInput): Promise<ClaudePermissionInteractionRef>;
  /**
   * Merge `patch` into `payload.claudePermission`. With `requireUnconsumed`,
   * only a row whose `consumedAt` is still empty is updated. Returns whether a
   * row was updated.
   */
  patch(
    interactionId: string,
    patch: Partial<ClaudePermissionPayload>,
    opts?: { requireUnconsumed?: boolean; requireStatus?: string },
  ): Promise<boolean>;
}

type Waiter = {
  runId: string;
  companyId: string;
  settle: (decision: AdapterPermissionDecision) => void;
};

/** In-process live waiters, keyed by interaction id (shared by heartbeat and routes). */
const liveWaiters = new Map<string, Waiter>();

export function hasLiveClaudePermissionWaiter(interactionId: string): boolean {
  return liveWaiters.has(interactionId);
}

/** Test-only: drop every waiter. */
export function resetClaudePermissionWaitersForTest(): void {
  liveWaiters.clear();
}

function stableStringify(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? "null" : encoded;
  }
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.keys(value as Record<string, unknown>)
    .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`);
  return `{${entries.join(",")}}`;
}

export function claudePermissionFingerprint(toolName: string | null, rawInput: unknown): string {
  return createHash("sha256")
    .update(`${toolName ?? ""}\u0000${stableStringify(rawInput)}`)
    .digest("hex");
}

function cap(text: string): string {
  return text.length > CLAUDE_PERMISSION_INPUT_PREVIEW_MAX
    ? `${text.slice(0, CLAUDE_PERMISSION_INPUT_PREVIEW_MAX - 1)}…`
    : text;
}

function renderClaudePermissionInput(rawInput: unknown): string {
  if (rawInput === undefined || rawInput === null) return "";
  if (typeof rawInput === "string") return rawInput;
  if (typeof rawInput === "object" && !Array.isArray(rawInput)) {
    const command = (rawInput as Record<string, unknown>).command;
    if (typeof command === "string" && command.trim().length > 0) return command;
  }
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(rawInput, null, 2);
  } catch {
    encoded = String(rawInput);
  }
  return encoded ?? "";
}

export function buildClaudePermissionInputPreview(rawInput: unknown): string {
  return cap(renderClaudePermissionInput(rawInput));
}

function readClaudePermission(payload: unknown): ClaudePermissionPayload | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const value = (payload as Record<string, unknown>).claudePermission;
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as ClaudePermissionPayload)
    : null;
}

/**
 * Whether a row was created by the permission bridge for this agent: the
 * reserved idempotency-key prefix, created by the agent (never a user), and
 * pinned human-only. The public create route refuses both the key prefix and
 * the claudePermission payload, so only the bridge produces such rows.
 */
function hasBridgeProvenance(ref: ClaudePermissionInteractionRef, agentId: string): boolean {
  const claudePermission = readClaudePermission(ref.payload);
  return (
    claudePermission !== null &&
    claudePermission.agentId === agentId &&
    typeof ref.idempotencyKey === "string" &&
    ref.idempotencyKey.startsWith(CLAUDE_PERMISSION_IDEMPOTENCY_PREFIX) &&
    ref.createdByAgentId === agentId &&
    ref.createdByUserId === null &&
    ref.requestedResolverPolicy === "human_only" &&
    ref.effectiveResolverPolicy === "human_only"
  );
}

/** An acceptance a human recorded through the Paperclip routes. */
function isHumanAcceptance(ref: ClaudePermissionInteractionRef): boolean {
  const claudePermission = readClaudePermission(ref.payload);
  return (
    ref.status === "accepted" &&
    typeof ref.resolvedByUserId === "string" &&
    ref.resolvedByUserId.length > 0 &&
    ref.resolvedByAgentId === null &&
    Boolean(claudePermission?.outcome)
  );
}

export function isClaudePermissionInteraction(interaction: { kind?: string; payload?: unknown }): boolean {
  return interaction.kind === "request_confirmation" && readClaudePermission(interaction.payload) !== null;
}

/** Decision the live run receives for a human answer. */
export function claudePermissionDecisionForAnswer(
  payload: unknown,
  answer: { accepted: boolean; rememberAction?: boolean },
): AdapterPermissionOutcome {
  if (!answer.accepted) return "reject_once";
  const claudePermission = readClaudePermission(payload);
  return answer.rememberAction === true && claudePermission?.alwaysAvailable === true
    ? "allow_always"
    : "allow_once";
}

/** allow_always survives only when the current request still offers it. */
function grantOutcome(
  recorded: AdapterPermissionOutcome | null,
  request: AdapterPermissionRequest,
): AdapterPermissionOutcome {
  return recorded === "allow_always" && (request.options ?? []).some((option) => option.kind === "allow_always")
    ? "allow_always"
    : "allow_once";
}

function toolLabel(request: AdapterPermissionRequest): string {
  return (request.toolName ?? request.title ?? "a tool").trim().slice(0, 200) || "a tool";
}

function buildDetailsMarkdown(claudePermission: ClaudePermissionPayload): string {
  const lines = [`**Tool:** \`${(claudePermission.toolName ?? "unknown").replace(/`/g, "'")}\``];
  if (claudePermission.title) lines.push(`**Request:** ${claudePermission.title.slice(0, 1000)}`);
  if (claudePermission.inputPreview) {
    const fence = claudePermission.inputPreview.includes("```") ? "~~~~" : "```";
    lines.push("", fence, claudePermission.inputPreview, fence);
  }
  return lines.join("\n");
}

export function createDbClaudePermissionStore(db: Db): ClaudePermissionStore {
  const t = issueThreadInteractions;
  const toRef = (row: {
    id: string;
    companyId: string;
    issueId: string;
    status: string;
    payload: unknown;
    idempotencyKey: string | null;
    createdByAgentId: string | null;
    createdByUserId: string | null;
    resolvedByAgentId: string | null;
    resolvedByUserId: string | null;
    requestedResolverPolicy: string | null;
    effectiveResolverPolicy: string | null;
  }): ClaudePermissionInteractionRef => ({
    id: row.id,
    companyId: row.companyId,
    issueId: row.issueId,
    status: row.status,
    payload: row.payload,
    idempotencyKey: row.idempotencyKey ?? null,
    createdByAgentId: row.createdByAgentId ?? null,
    createdByUserId: row.createdByUserId ?? null,
    resolvedByAgentId: row.resolvedByAgentId ?? null,
    resolvedByUserId: row.resolvedByUserId ?? null,
    requestedResolverPolicy: row.requestedResolverPolicy ?? null,
    effectiveResolverPolicy: row.effectiveResolverPolicy ?? null,
  });
  return {
    async findByIdempotencyKey(input) {
      const row = await db
        .select()
        .from(t)
        .where(
          and(
            eq(t.companyId, input.companyId),
            eq(t.issueId, input.issueId),
            eq(t.idempotencyKey, input.idempotencyKey),
          ),
        )
        .then((rows) => rows[0] ?? null);
      return row ? toRef(row) : null;
    },
    async findGrantCandidates(query) {
      const rows = await db
        .select()
        .from(t)
        .where(
          and(
            eq(t.companyId, query.companyId),
            eq(t.issueId, query.issueId),
            eq(t.kind, "request_confirmation"),
            eq(t.status, "accepted"),
            // Provenance: only cards the bridge created for this agent,
            // pinned human-only and answered by a user, are grants.
            eq(t.createdByAgentId, query.agentId),
            isNull(t.createdByUserId),
            like(t.idempotencyKey, `${CLAUDE_PERMISSION_IDEMPOTENCY_PREFIX}%`),
            eq(t.requestedResolverPolicy, "human_only"),
            eq(t.effectiveResolverPolicy, "human_only"),
            isNotNull(t.resolvedByUserId),
            isNull(t.resolvedByAgentId),
            gte(t.resolvedAt, query.since),
            sql`${t.payload}->'claudePermission'->>'fingerprint' = ${query.fingerprint}`,
            sql`${t.payload}->'claudePermission'->>'agentId' = ${query.agentId}`,
            // The outcome is written by the route after the accept commits; a
            // live accept writes it together with consumedAt, so an accepted
            // card whose outcome is not recorded yet is never a grant.
            sql`(${t.payload}->'claudePermission'->>'outcome') is not null`,
            sql`(${t.payload}->'claudePermission'->>'consumedAt') is null`,
          ),
        )
        .orderBy(asc(t.resolvedAt))
        .limit(5);
      return rows.map(toRef);
    },
    async create(input) {
      const interaction = await issueThreadInteractionService(db).create(
        { id: input.issueId, companyId: input.companyId },
        {
          kind: "request_confirmation",
          idempotencyKey: input.idempotencyKey,
          title: "Claude Code permission request",
          summary: `Claude Code wants to run ${input.claudePermission.toolName ?? "a tool"}.`.slice(0, 1000),
          resolverPolicy: "human_only",
          continuationPolicy: "wake_assignee",
          // No sourceRunId: the waiting run is still live, and the accept path
          // blocks sourced confirmations until the source run's workspace has
          // synced. The run id lives in payload.claudePermission.runId.
          payload: {
            version: 1,
            prompt: `Claude Code wants to run ${input.claudePermission.toolName ?? "a tool"}`.slice(0, 1000),
            acceptLabel: "Allow once",
            rejectLabel: "Deny",
            rejectRequiresReason: false,
            allowDeclineReason: true,
            supersedeOnUserComment: false,
            detailsMarkdown: buildDetailsMarkdown(input.claudePermission),
            claudePermission: input.claudePermission,
          },
        },
        { agentId: input.agentId, runId: input.runId },
        { supersedePendingSiblingInteractions: false },
      );
      return toRef(interaction as unknown as Parameters<typeof toRef>[0]);
    },
    async patch(interactionId, patch, opts = {}) {
      const conditions = [eq(t.id, interactionId)];
      if (opts.requireUnconsumed) {
        conditions.push(sql`(${t.payload}->'claudePermission'->>'consumedAt') is null`);
      }
      if (opts.requireStatus) conditions.push(eq(t.status, opts.requireStatus));
      const rows = await db
        .update(t)
        .set({
          payload: sql`jsonb_set(${t.payload}, '{claudePermission}', coalesce(${t.payload}->'claudePermission', '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb)`,
          updatedAt: new Date(),
        })
        .where(and(...conditions))
        .returning({ id: t.id });
      return rows.length > 0;
    },
  };
}

export interface ClaudePermissionBridgeOptions {
  store?: ClaudePermissionStore;
  now?: () => Date;
  /** Redacts secret values from card text before it is stored. */
  redact?: (binding: ClaudePermissionBinding & { issueId: string }, text: string) => Promise<string>;
}

function createDefaultRedactor(db: Db | null): NonNullable<ClaudePermissionBridgeOptions["redact"]> {
  const registry = db ? createRunSecretRedactionRegistry(db) : null;
  return async (binding, text) => {
    let redacted = text;
    if (registry) {
      redacted = await registry.redactForRun(binding.companyId, binding.runId, redacted);
      redacted = await registry.redactForIssue(binding.companyId, binding.issueId, redacted);
    }
    return redactSensitiveText(redacted);
  };
}

export function claudePermissionBridgeService(db: Db | null, opts: ClaudePermissionBridgeOptions = {}) {
  const store = opts.store ?? (db ? createDbClaudePermissionStore(db) : null);
  if (!store) throw new Error("claudePermissionBridgeService requires a db or a store");
  const now = opts.now ?? (() => new Date());
  const redact = opts.redact ?? createDefaultRedactor(db);

  async function consumeGrant(
    binding: ClaudePermissionBinding & { issueId: string },
    fingerprint: string,
  ): Promise<{ id: string; outcome: AdapterPermissionOutcome | null } | null> {
    const candidates = await store!.findGrantCandidates({
      companyId: binding.companyId,
      issueId: binding.issueId,
      agentId: binding.agentId,
      fingerprint,
      since: new Date(now().getTime() - CLAUDE_PERMISSION_GRANT_TTL_MS),
    });
    for (const candidate of candidates) {
      const claudePermission = readClaudePermission(candidate.payload);
      if (
        !hasBridgeProvenance(candidate, binding.agentId) ||
        !isHumanAcceptance(candidate) ||
        !claudePermission ||
        claudePermission.fingerprint !== fingerprint ||
        claudePermission.agentId !== binding.agentId ||
        claudePermission.consumedAt
      ) {
        continue;
      }
      const consumed = await store!.patch(
        candidate.id,
        { consumedAt: now().toISOString(), consumedByRunId: binding.runId },
        { requireUnconsumed: true, requireStatus: "accepted" },
      );
      if (consumed) return { id: candidate.id, outcome: claudePermission.outcome ?? null };
    }
    return null;
  }

  function waitForAnswer(
    interactionId: string,
    binding: ClaudePermissionBinding,
    opts: { signal: AbortSignal; waitMs: number },
  ): Promise<{ decision: AdapterPermissionDecision; reason: "answer" | "timeout" | "abort" }> {
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      let settled = false;
      const finish = (decision: AdapterPermissionDecision, reason: "answer" | "timeout" | "abort") => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        opts.signal.removeEventListener("abort", onAbort);
        if (liveWaiters.get(interactionId)?.settle === settleFromRoute) liveWaiters.delete(interactionId);
        resolve({ decision, reason });
      };
      const settleFromRoute = (decision: AdapterPermissionDecision) => finish(decision, "answer");
      const onAbort = () => finish({ outcome: "cancel" }, "abort");

      liveWaiters.set(interactionId, {
        runId: binding.runId,
        companyId: binding.companyId,
        settle: settleFromRoute,
      });
      opts.signal.addEventListener("abort", onAbort, { once: true });
      if (opts.signal.aborted) {
        onAbort();
        return;
      }
      const waitMs = Number.isFinite(opts.waitMs) ? Math.max(0, opts.waitMs) : 0;
      timer = setTimeout(() => finish({ outcome: "reject_once" }, "timeout"), waitMs);
    });
  }

  async function park(interactionId: string) {
    try {
      await store!.patch(interactionId, { parkedAt: now().toISOString() }, { requireStatus: "pending" });
    } catch (err) {
      logger.warn({ err, interactionId }, "claude permission bridge: failed to mark request parked");
    }
  }

  async function requestPermission(
    binding: ClaudePermissionBinding,
    request: AdapterPermissionRequest,
    opts: { signal: AbortSignal; waitMs: number },
  ): Promise<AdapterPermissionDecision> {
    const log = { companyId: binding.companyId, agentId: binding.agentId, runId: binding.runId, issueId: binding.issueId, toolName: request.toolName };
    if (!binding.issueId) {
      logger.info(log, "claude permission bridge: run has no issue; rejecting permission request");
      return { outcome: "reject_once" };
    }
    if (opts.signal.aborted) return { outcome: "cancel" };
    const issueBinding = { ...binding, issueId: binding.issueId };
    const fingerprint = claudePermissionFingerprint(request.toolName, request.rawInput);

    try {
      const grant = await consumeGrant(issueBinding, fingerprint);
      if (grant) {
        logger.info({ ...log, interactionId: grant.id }, "claude permission bridge: consumed one-time grant");
        return { outcome: grantOutcome(grant.outcome, request) };
      }

      const idempotencyKey = `${CLAUDE_PERMISSION_IDEMPOTENCY_PREFIX}${binding.runId}:${request.toolCallId ?? fingerprint}`.slice(0, 255);
      let interaction = await store!.findByIdempotencyKey({
        companyId: binding.companyId,
        issueId: binding.issueId,
        idempotencyKey,
      });
      if (interaction && !hasBridgeProvenance(interaction, binding.agentId)) {
        logger.warn(
          { ...log, interactionId: interaction.id },
          "claude permission bridge: idempotency key is held by a card without bridge provenance; rejecting",
        );
        return { outcome: "reject_once" };
      }
      if (interaction) {
        // A replay of the same tool call in the same run: reuse its card.
        const existing = readClaudePermission(interaction.payload);
        if (interaction.status === "accepted") {
          // Only a human acceptance whose outcome is already recorded counts.
          if (!isHumanAcceptance(interaction)) return { outcome: "reject_once" };
          if (existing && !existing.consumedAt) {
            const consumed = await store!.patch(
              interaction.id,
              { consumedAt: now().toISOString(), consumedByRunId: binding.runId },
              { requireUnconsumed: true, requireStatus: "accepted" },
            );
            if (consumed) return { outcome: grantOutcome(existing.outcome ?? null, request) };
          }
          return { outcome: grantOutcome(existing?.outcome ?? null, request) };
        }
        if (interaction.status !== "pending") return { outcome: "reject_once" };
        if (liveWaiters.has(interaction.id)) {
          // Another in-flight wait already owns this card; do not steal it.
          return { outcome: "reject_once" };
        }
      } else {
        const options = (request.options ?? []).slice(0, 20).map((option) => ({
          optionId: String(option.optionId).slice(0, 500),
          name: String(option.name).slice(0, 500),
          kind: String(option.kind).slice(0, 120),
        }));
        const claudePermission: ClaudePermissionPayload = {
          version: 1,
          fingerprint,
          toolCallId: request.toolCallId ? request.toolCallId.slice(0, 500) : null,
          toolName: request.toolName ? (await redact(issueBinding, request.toolName)).slice(0, 500) : null,
          title: request.title ? (await redact(issueBinding, request.title)).slice(0, 1000) : null,
          kind: request.kind ? request.kind.slice(0, 120) : null,
          // Redact before capping so a secret cut at the cap cannot leak a prefix.
          inputPreview: cap(await redact(issueBinding, renderClaudePermissionInput(request.rawInput))),
          options,
          alwaysAvailable: options.some((option) => option.kind === "allow_always"),
          runId: binding.runId,
          agentId: binding.agentId,
        };
        interaction = await store!.create({
          companyId: binding.companyId,
          issueId: binding.issueId,
          agentId: binding.agentId,
          runId: binding.runId,
          idempotencyKey,
          claudePermission,
        });
        if (!hasBridgeProvenance(interaction, binding.agentId) || interaction.status !== "pending") {
          // The service reused a row with this key that the bridge did not make.
          logger.warn(
            { ...log, interactionId: interaction.id },
            "claude permission bridge: created card lacks bridge provenance; rejecting",
          );
          return { outcome: "reject_once" };
        }
        logger.info(
          { ...log, interactionId: interaction.id, label: toolLabel(request) },
          "claude permission bridge: created permission card",
        );
      }

      const { decision, reason } = await waitForAnswer(interaction.id, binding, opts);
      if (reason !== "answer") await park(interaction.id);
      return decision;
    } catch (err) {
      // Fail closed: an ask rule must never be silently approved.
      logger.warn({ ...log, err }, "claude permission bridge: request failed; rejecting");
      return opts.signal.aborted ? { outcome: "cancel" } : { outcome: "reject_once" };
    }
  }

  /**
   * Called by the accept/reject routes after the interaction has been
   * resolved through the generic path. Records `outcome` on the card. With a
   * live waiter, delivers the answer to the waiting run and marks the
   * acceptance consumed. Without one, an acceptance stays unconsumed: it is
   * the one-time grant for the next matching request.
   */
  async function resolveFromRoute(
    interaction: Pick<ClaudePermissionInteractionRef, "id" | "companyId" | "status" | "payload">,
    answer: { accepted: boolean; rememberAction?: boolean },
  ): Promise<{ live: boolean; outcome: AdapterPermissionOutcome | null }> {
    const claudePermission = readClaudePermission(interaction.payload);
    if (!claudePermission) return { live: false, outcome: null };
    const expectedStatus = answer.accepted ? "accepted" : "rejected";
    if (interaction.status !== expectedStatus) return { live: false, outcome: null };
    // A repeated route call (double click) must not rewrite the recorded outcome.
    if (claudePermission.outcome) return { live: false, outcome: null };
    const waiter = liveWaiters.get(interaction.id);
    const live = Boolean(waiter && waiter.companyId === interaction.companyId);
    if (live) liveWaiters.delete(interaction.id);
    const outcome = claudePermissionDecisionForAnswer(interaction.payload, answer);
    const decidedAt = now().toISOString();
    try {
      await store!.patch(
        interaction.id,
        live && answer.accepted
          ? { outcome, decidedAt, consumedAt: decidedAt, consumedByRunId: waiter!.runId }
          : { outcome, decidedAt },
        { requireStatus: expectedStatus },
      );
    } catch (err) {
      logger.warn({ err, interactionId: interaction.id }, "claude permission bridge: failed to record outcome");
    }
    if (live) waiter!.settle({ outcome });
    return { live, outcome };
  }

  return { requestPermission, resolveFromRoute };
}

/**
 * Build `ctx.requestPermission` for an adapter invocation. Every claude_local
 * run gets the bridge, with or without an issue: an ask rule with nobody to
 * ask is denied (as headless Claude does), never auto-approved by the
 * adapter's fallback. Other adapters leave it unset.
 */
export function buildClaudePermissionRequester(input: {
  db: Db | null;
  adapterType: string | null | undefined;
  companyId: string;
  agentId: string;
  runId: string;
  issueId: string | null | undefined;
  bridge?: Pick<ReturnType<typeof claudePermissionBridgeService>, "requestPermission">;
  /** Receives a human-readable line for the run log. */
  onNotice?: (message: string) => void | Promise<void>;
}): AdapterExecutionContext["requestPermission"] {
  if (input.adapterType !== "claude_local") return undefined;
  const issueId = input.issueId ?? null;
  let bridge = input.bridge ?? null;
  return async (request, opts) => {
    bridge ??= claudePermissionBridgeService(input.db);
    const decision = await bridge.requestPermission(
      { companyId: input.companyId, agentId: input.agentId, runId: input.runId, issueId },
      request,
      opts,
    );
    if (!issueId && input.onNotice) {
      try {
        await input.onNotice(
          `Claude asked for permission (${toolLabel(request)}) but this run has no task to post an approval card to; denied.`,
        );
      } catch (err) {
        logger.warn({ err, runId: input.runId }, "claude permission bridge: failed to write run notice");
      }
    }
    return decision;
  };
}
