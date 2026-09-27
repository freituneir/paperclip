import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildClaudePermissionInputPreview,
  buildClaudePermissionRequester,
  claudePermissionBridgeService,
  claudePermissionFingerprint,
  hasLiveClaudePermissionWaiter,
  resetClaudePermissionWaitersForTest,
  type ClaudePermissionCreateInput,
  type ClaudePermissionInteractionRef,
  type ClaudePermissionStore,
} from "../services/claude-permission-bridge.js";

const COMPANY = "company-1";
const AGENT = "agent-1";
const ISSUE = "issue-1";

type Row = ClaudePermissionInteractionRef & {
  idempotencyKey: string;
  agentId: string;
  resolvedAt: Date | null;
};

function createMemoryStore() {
  const rows: Row[] = [];
  let seq = 0;
  const cp = (row: Row) => (row.payload as { claudePermission: Record<string, unknown> }).claudePermission;
  const store: ClaudePermissionStore = {
    findByIdempotencyKey: vi.fn(async (input) =>
      rows.find((row) => row.companyId === input.companyId && row.issueId === input.issueId && row.idempotencyKey === input.idempotencyKey) ?? null),
    findGrantCandidates: vi.fn(async (query) =>
      rows.filter((row) =>
        row.companyId === query.companyId &&
        row.issueId === query.issueId &&
        row.agentId === query.agentId &&
        row.status === "accepted" &&
        row.resolvedAt !== null &&
        row.resolvedAt >= query.since &&
        cp(row).fingerprint === query.fingerprint &&
        !cp(row).consumedAt)),
    create: vi.fn(async (input: ClaudePermissionCreateInput) => {
      const row: Row = {
        id: `interaction-${++seq}`,
        companyId: input.companyId,
        issueId: input.issueId,
        status: "pending",
        idempotencyKey: input.idempotencyKey,
        agentId: input.agentId,
        resolvedAt: null,
        payload: { version: 1, prompt: "x", claudePermission: { ...input.claudePermission } },
      };
      rows.push(row);
      return row;
    }),
    patch: vi.fn(async (id, patch, opts = {}) => {
      const row = rows.find((candidate) => candidate.id === id);
      if (!row) return false;
      if (opts.requireUnconsumed && cp(row).consumedAt) return false;
      if (opts.requireStatus && row.status !== opts.requireStatus) return false;
      Object.assign(cp(row), patch);
      return true;
    }),
  };
  /** Simulate the generic accept/reject route path. */
  const resolve = (id: string, status: "accepted" | "rejected", at = new Date()) => {
    const row = rows.find((candidate) => candidate.id === id)!;
    if (row.status !== "pending") throw Object.assign(new Error("already resolved"), { status: 409 });
    row.status = status;
    row.resolvedAt = at;
    return row;
  };
  return { rows, store, resolve, cp };
}

const bashRequest = (command = "git push origin main", toolCallId: string | null = "tool-1") => ({
  toolCallId,
  toolName: "Bash",
  title: `Run ${command}`,
  kind: "execute",
  rawInput: { command, description: "push" },
  options: [
    { optionId: "allow", name: "Allow", kind: "allow_once" },
    { optionId: "reject", name: "Reject", kind: "reject_once" },
  ],
});

const binding = (runId = "run-1", issueId: string | null = ISSUE) => ({ companyId: COMPANY, agentId: AGENT, runId, issueId });

async function flush() {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

describe("claude permission bridge", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-27T12:00:00.000Z"));
    resetClaudePermissionWaitersForTest();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fingerprints stably and previews Bash commands", () => {
    expect(claudePermissionFingerprint("Bash", { a: 1, b: [1, { d: 2, c: 3 }] }))
      .toBe(claudePermissionFingerprint("Bash", { b: [1, { c: 3, d: 2 }], a: 1 }));
    expect(claudePermissionFingerprint("Bash", { a: 1 })).not.toBe(claudePermissionFingerprint("Read", { a: 1 }));
    expect(buildClaudePermissionInputPreview({ command: "ls -la" })).toBe("ls -la");
    expect(buildClaudePermissionInputPreview({ file_path: "/x" })).toBe('{\n  "file_path": "/x"\n}');
    expect(buildClaudePermissionInputPreview({ command: "x".repeat(5000) })).toHaveLength(2000);
  });

  it("rejects when the run has no issue", async () => {
    const { store } = createMemoryStore();
    const bridge = claudePermissionBridgeService(null, { store });
    const decision = await bridge.requestPermission(binding("run-1", null), bashRequest(), {
      signal: new AbortController().signal,
      waitMs: 1000,
    });
    expect(decision).toEqual({ outcome: "reject_once" });
    expect(store.create).not.toHaveBeenCalled();
  });

  it("creates a card and resolves allow_once on a live accept", async () => {
    const { store, rows, resolve, cp } = createMemoryStore();
    const bridge = claudePermissionBridgeService(null, { store });
    const pending = bridge.requestPermission(binding(), bashRequest(), { signal: new AbortController().signal, waitMs: 60_000 });
    await flush();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.idempotencyKey).toBe("claude-permission:run-1:tool-1");
    expect(cp(rows[0]!)).toMatchObject({
      version: 1,
      toolName: "Bash",
      inputPreview: "git push origin main",
      alwaysAvailable: false,
      runId: "run-1",
      agentId: AGENT,
      fingerprint: claudePermissionFingerprint("Bash", bashRequest().rawInput),
    });
    expect(hasLiveClaudePermissionWaiter(rows[0]!.id)).toBe(true);

    const accepted = resolve(rows[0]!.id, "accepted");
    await expect(bridge.resolveFromRoute(accepted, { accepted: true, rememberAction: true }))
      .resolves.toEqual({ live: true, outcome: "allow_once" });
    await expect(pending).resolves.toEqual({ outcome: "allow_once" });
    expect(cp(rows[0]!)).toMatchObject({ outcome: "allow_once", consumedByRunId: "run-1" });
    expect(hasLiveClaudePermissionWaiter(rows[0]!.id)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns allow_always when rememberAction is set and always is offered", async () => {
    const { store, rows, resolve, cp } = createMemoryStore();
    const bridge = claudePermissionBridgeService(null, { store });
    const request = { ...bashRequest(), options: [...bashRequest().options, { optionId: "always", name: "Always", kind: "allow_always" }] };
    const pending = bridge.requestPermission(binding(), request, { signal: new AbortController().signal, waitMs: 60_000 });
    await flush();
    expect(cp(rows[0]!).alwaysAvailable).toBe(true);
    await bridge.resolveFromRoute(resolve(rows[0]!.id, "accepted"), { accepted: true, rememberAction: true });
    await expect(pending).resolves.toEqual({ outcome: "allow_always" });
    expect(cp(rows[0]!).outcome).toBe("allow_always");
  });

  it("returns reject_once on a live reject", async () => {
    const { store, rows, resolve, cp } = createMemoryStore();
    const bridge = claudePermissionBridgeService(null, { store });
    const pending = bridge.requestPermission(binding(), bashRequest(), { signal: new AbortController().signal, waitMs: 60_000 });
    await flush();
    await expect(bridge.resolveFromRoute(resolve(rows[0]!.id, "rejected"), { accepted: false }))
      .resolves.toEqual({ live: true, outcome: "reject_once" });
    await expect(pending).resolves.toEqual({ outcome: "reject_once" });
    expect(cp(rows[0]!).outcome).toBe("reject_once");
  });

  it("records outcome on a late reject without a waiter", async () => {
    const { store, rows, resolve, cp } = createMemoryStore();
    const bridge = claudePermissionBridgeService(null, { store });
    const pending = bridge.requestPermission(binding(), bashRequest(), { signal: new AbortController().signal, waitMs: 1 });
    await flush();
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    await expect(bridge.resolveFromRoute(resolve(rows[0]!.id, "rejected"), { accepted: false }))
      .resolves.toEqual({ live: false, outcome: "reject_once" });
    expect(cp(rows[0]!).outcome).toBe("reject_once");
  });

  it("keeps allow_always on a late remembered accept when the next request offers it", async () => {
    const { store, rows, resolve, cp } = createMemoryStore();
    const bridge = claudePermissionBridgeService(null, { store });
    const always = { optionId: "always", name: "Always", kind: "allow_always" };
    const request = { ...bashRequest(), options: [...bashRequest().options, always] };
    const pending = bridge.requestPermission(binding(), request, { signal: new AbortController().signal, waitMs: 1 });
    await flush();
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    await expect(bridge.resolveFromRoute(resolve(rows[0]!.id, "accepted"), { accepted: true, rememberAction: true }))
      .resolves.toEqual({ live: false, outcome: "allow_always" });
    expect(cp(rows[0]!)).toMatchObject({ outcome: "allow_always" });
    expect(cp(rows[0]!).consumedAt).toBeUndefined();
    await expect(
      bridge.requestPermission(binding("run-2"), { ...request, toolCallId: "tool-2" }, { signal: new AbortController().signal, waitMs: 1 }),
    ).resolves.toEqual({ outcome: "allow_always" });
  });

  it("times out to reject_once, parks the card, and a late accept becomes a one-time grant", async () => {
    const { store, rows, resolve, cp } = createMemoryStore();
    const bridge = claudePermissionBridgeService(null, { store });
    const pending = bridge.requestPermission(binding(), bashRequest(), { signal: new AbortController().signal, waitMs: 5_000 });
    await flush();
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(pending).resolves.toEqual({ outcome: "reject_once" });
    expect(rows[0]!.status).toBe("pending");
    expect(cp(rows[0]!).parkedAt).toBe("2026-09-27T12:00:05.000Z");
    expect(hasLiveClaudePermissionWaiter(rows[0]!.id)).toBe(false);

    // Late accept: no live waiter, so the acceptance stays unconsumed.
    await expect(bridge.resolveFromRoute(resolve(rows[0]!.id, "accepted"), { accepted: true }))
      .resolves.toEqual({ live: false, outcome: "allow_once" });
    expect(cp(rows[0]!).outcome).toBe("allow_once");
    expect(cp(rows[0]!).consumedAt).toBeUndefined();

    // A non-matching request in the next run is not granted.
    const other = bridge.requestPermission(binding("run-2"), bashRequest("rm -rf /", "tool-9"), { signal: new AbortController().signal, waitMs: 10 });
    await flush();
    await vi.advanceTimersByTimeAsync(10);
    await expect(other).resolves.toEqual({ outcome: "reject_once" });
    expect(cp(rows[0]!).consumedAt).toBeUndefined();

    // The matching request (new tool call id) consumes the grant exactly once.
    await expect(
      bridge.requestPermission(binding("run-2"), bashRequest(undefined, "tool-2"), { signal: new AbortController().signal, waitMs: 10 }),
    ).resolves.toEqual({ outcome: "allow_once" });
    expect(cp(rows[0]!)).toMatchObject({ consumedByRunId: "run-2" });
    const rowsBefore = rows.length;
    const again = bridge.requestPermission(binding("run-3"), bashRequest(undefined, "tool-3"), { signal: new AbortController().signal, waitMs: 10 });
    await flush();
    expect(rows.length).toBe(rowsBefore + 1);
    await vi.advanceTimersByTimeAsync(10);
    await expect(again).resolves.toEqual({ outcome: "reject_once" });
  });

  it("ignores grants older than 24 hours", async () => {
    const { store, rows, resolve } = createMemoryStore();
    const bridge = claudePermissionBridgeService(null, { store });
    const first = bridge.requestPermission(binding(), bashRequest(), { signal: new AbortController().signal, waitMs: 1 });
    await flush();
    await vi.advanceTimersByTimeAsync(1);
    await first;
    resolve(rows[0]!.id, "accepted", new Date("2026-09-26T11:00:00.000Z"));
    const next = bridge.requestPermission(binding("run-2"), bashRequest(undefined, "tool-2"), { signal: new AbortController().signal, waitMs: 1 });
    await flush();
    await vi.advanceTimersByTimeAsync(1);
    await expect(next).resolves.toEqual({ outcome: "reject_once" });
  });

  it("cancels when the signal aborts and cleans up", async () => {
    const { store, rows } = createMemoryStore();
    const bridge = claudePermissionBridgeService(null, { store });
    const controller = new AbortController();
    const pending = bridge.requestPermission(binding(), bashRequest(), { signal: controller.signal, waitMs: 60_000 });
    await flush();
    controller.abort();
    await expect(pending).resolves.toEqual({ outcome: "cancel" });
    expect(hasLiveClaudePermissionWaiter(rows[0]!.id)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(rows[0]!.status).toBe("pending");
  });

  it("returns cancel immediately for an already aborted signal", async () => {
    const { store } = createMemoryStore();
    const bridge = claudePermissionBridgeService(null, { store });
    const controller = new AbortController();
    controller.abort();
    await expect(bridge.requestPermission(binding(), bashRequest(), { signal: controller.signal, waitMs: 1000 }))
      .resolves.toEqual({ outcome: "cancel" });
    expect(store.create).not.toHaveBeenCalled();
  });

  it("treats a double accept as safe", async () => {
    const { store, rows, resolve, cp } = createMemoryStore();
    const bridge = claudePermissionBridgeService(null, { store });
    const pending = bridge.requestPermission(binding(), bashRequest(), { signal: new AbortController().signal, waitMs: 60_000 });
    await flush();
    const accepted = resolve(rows[0]!.id, "accepted");
    await bridge.resolveFromRoute(accepted, { accepted: true });
    await expect(bridge.resolveFromRoute(accepted, { accepted: true })).resolves.toEqual({ live: false, outcome: null });
    await expect(pending).resolves.toEqual({ outcome: "allow_once" });
    // The generic path refuses the second resolution with a 409.
    expect(() => resolve(rows[0]!.id, "accepted")).toThrow("already resolved");
    // The live acceptance was consumed, so it never becomes a grant.
    expect(cp(rows[0]!).consumedAt).toBeTruthy();
    const next = bridge.requestPermission(binding("run-2"), bashRequest(undefined, "tool-2"), { signal: new AbortController().signal, waitMs: 1 });
    await flush();
    await vi.advanceTimersByTimeAsync(1);
    await expect(next).resolves.toEqual({ outcome: "reject_once" });
  });

  it("fails closed when the store throws", async () => {
    const { store } = createMemoryStore();
    (store.create as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("db down"));
    const bridge = claudePermissionBridgeService(null, { store });
    await expect(bridge.requestPermission(binding(), bashRequest(), { signal: new AbortController().signal, waitMs: 1000 }))
      .resolves.toEqual({ outcome: "reject_once" });
  });
});

describe("buildClaudePermissionRequester", () => {
  const base = { db: null, companyId: COMPANY, agentId: AGENT, runId: "run-1" };

  it("only wires claude_local runs that have an issue", async () => {
    expect(buildClaudePermissionRequester({ ...base, adapterType: "codex_local", issueId: ISSUE })).toBeUndefined();
    expect(buildClaudePermissionRequester({ ...base, adapterType: "claude_local", issueId: null })).toBeUndefined();
    const bridge = { requestPermission: vi.fn(async () => ({ outcome: "allow_once" as const })) };
    const requester = buildClaudePermissionRequester({ ...base, adapterType: "claude_local", issueId: ISSUE, bridge });
    expect(requester).toBeTypeOf("function");
    const signal = new AbortController().signal;
    await expect(requester!(bashRequest(), { signal, waitMs: 5 })).resolves.toEqual({ outcome: "allow_once" });
    expect(bridge.requestPermission).toHaveBeenCalledWith(
      { companyId: COMPANY, agentId: AGENT, runId: "run-1", issueId: ISSUE },
      bashRequest(),
      { signal, waitMs: 5 },
    );
  });
});
