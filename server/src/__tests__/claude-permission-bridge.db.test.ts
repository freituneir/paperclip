import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  goals,
  heartbeatRuns,
  instanceSettings,
  issueComments,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import { requestConfirmationPayloadSchema } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";
import {
  CLAUDE_PERMISSION_INPUT_PREVIEW_MAX,
  claudePermissionBridgeService,
  claudePermissionFingerprint,
  createDbClaudePermissionStore,
  hasLiveClaudePermissionWaiter,
  resetClaudePermissionWaitersForTest,
} from "../services/claude-permission-bridge.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Seed = {
  companyId: string;
  goalId: string;
  issueId: string;
  otherIssueId: string;
  agentId: string;
  otherAgentId: string;
};

const bashRequest = (command = "git push origin main", toolCallId: string | null = "tool-1") => ({
  toolCallId,
  toolName: "Bash",
  title: `Run ${command}`,
  kind: "execute",
  rawInput: { command, description: "push" },
  options: [
    { optionId: "allow", name: "Allow", kind: "allow_once" },
    { optionId: "always", name: "Always allow", kind: "allow_always" },
    { optionId: "reject", name: "Reject", kind: "reject_once" },
  ],
});

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("waitFor timed out");
}

describeEmbeddedPostgres("claude permission bridge (real database)", () => {
  let db!: ReturnType<typeof createDb>;
  let interactionsSvc!: ReturnType<typeof issueThreadInteractionService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-claude-permission-bridge-");
    db = createDb(tempDb.connectionString);
    interactionsSvc = issueThreadInteractionService(db);
  }, 20_000);

  beforeEach(() => {
    resetClaudePermissionWaitersForTest();
  });

  afterEach(async () => {
    resetClaudePermissionWaitersForTest();
    await db.delete(issueThreadInteractions);
    await db.delete(activityLog);
    await db.delete(issueComments);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(goals);
    await db.delete(agents);
    await db.delete(instanceSettings);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed(): Promise<Seed> {
    const companyId = randomUUID();
    const goalId = randomUUID();
    const issueId = randomUUID();
    const otherIssueId = randomUUID();
    const agentId = randomUUID();
    const otherAgentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: false });
    await db.insert(goals).values({ id: goalId, companyId, title: "Bridge", level: "task", status: "active" });
    await db.insert(agents).values(
      [agentId, otherAgentId].map((id, index) => ({
        id,
        companyId,
        name: `Claude ${index}`,
        role: "engineer",
        status: "active",
        adapterType: "claude_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      })),
    );
    await db.insert(issues).values(
      [issueId, otherIssueId].map((id, index) => ({
        id,
        companyId,
        goalId,
        title: `Issue ${index}`,
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: agentId,
      })),
    );
    return { companyId, goalId, issueId, otherIssueId, agentId, otherAgentId };
  }

  const bindingFor = (s: Seed, overrides: Partial<{ runId: string; agentId: string; issueId: string | null }> = {}) => ({
    companyId: s.companyId,
    agentId: overrides.agentId ?? s.agentId,
    runId: overrides.runId ?? randomUUID(),
    issueId: overrides.issueId === undefined ? s.issueId : overrides.issueId,
  });

  const wait = (waitMs: number) => ({ signal: new AbortController().signal, waitMs });

  async function rows(issueId?: string) {
    const all = await db.select().from(issueThreadInteractions);
    return issueId ? all.filter((row) => row.issueId === issueId) : all;
  }

  const cpOf = (row: { payload: unknown }) =>
    (row.payload as { claudePermission?: Record<string, unknown> }).claudePermission;

  async function rowById(id: string) {
    const [row] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, id));
    return row!;
  }

  async function accept(s: Seed, interactionId: string, issueId = s.issueId) {
    const accepted = await interactionsSvc.acceptInteraction(
      { id: issueId, companyId: s.companyId, goalId: s.goalId, projectId: null },
      interactionId,
      {},
      { userId: "local-board" },
    );
    return accepted.interaction;
  }

  /** Time out one request so its card is parked, then accept it late (a grant). */
  async function createLateGrant(s: Seed, bridge: ReturnType<typeof claudePermissionBridgeService>, request = bashRequest()) {
    const decision = await bridge.requestPermission(bindingFor(s), request, wait(20));
    expect(decision).toEqual({ outcome: "reject_once" });
    const [card] = (await rows(s.issueId)).filter((row) => row.status === "pending");
    const accepted = await accept(s, card!.id);
    const delivery = await bridge.resolveFromRoute(accepted, { accepted: true });
    expect(delivery).toEqual({ live: false, outcome: "allow_once" });
    return card!.id;
  }

  it("creates one request_confirmation card with a persisted claudePermission payload", async () => {
    const s = await seed();
    const bridge = claudePermissionBridgeService(db);
    const runId = randomUUID();
    const longCommand = `echo ${"x".repeat(5000)}`;
    const request = bashRequest(longCommand);

    const decision = await bridge.requestPermission(bindingFor(s, { runId }), request, wait(20));
    expect(decision).toEqual({ outcome: "reject_once" });

    const stored = await rows();
    expect(stored).toHaveLength(1);
    const row = stored[0]!;
    expect(row).toMatchObject({
      kind: "request_confirmation",
      status: "pending",
      issueId: s.issueId,
      createdByAgentId: s.agentId,
      idempotencyKey: `claude-permission:${runId}:tool-1`,
    });
    const cp = cpOf(row)!;
    expect(cp).toMatchObject({
      version: 1,
      fingerprint: claudePermissionFingerprint("Bash", request.rawInput),
      toolCallId: "tool-1",
      toolName: "Bash",
      kind: "execute",
      options: request.options,
      alwaysAvailable: true,
      runId,
      agentId: s.agentId,
    });
    expect(cp.inputPreview).toHaveLength(CLAUDE_PERMISSION_INPUT_PREVIEW_MAX);
    expect(typeof cp.parkedAt).toBe("string");
    // The stored payload round-trips through the shared validator with the key intact.
    const reparsed = requestConfirmationPayloadSchema.parse(row.payload);
    expect(reparsed.claudePermission).toMatchObject({ fingerprint: cp.fingerprint, runId, agentId: s.agentId });
    // And through the service read path.
    const viaService = await interactionsSvc.getById(row.id);
    expect(cpOf(viaService!)).toMatchObject({ fingerprint: cp.fingerprint });
  });

  it("reuses the card for a replay of the same runId + toolCallId", async () => {
    const s = await seed();
    const bridge = claudePermissionBridgeService(db);
    const binding = bindingFor(s);

    // While the first wait is live, a replay does not steal the card or add one.
    const first = bridge.requestPermission(binding, bashRequest(), wait(10_000));
    await waitFor(async () => (await rows()).length === 1 && hasLiveClaudePermissionWaiter((await rows())[0]!.id));
    await expect(bridge.requestPermission(binding, bashRequest(), wait(10_000))).resolves.toEqual({ outcome: "reject_once" });
    expect(await rows()).toHaveLength(1);

    const [card] = await rows();
    const accepted = await accept(s, card!.id);
    await bridge.resolveFromRoute(accepted, { accepted: true });
    await expect(first).resolves.toEqual({ outcome: "allow_once" });

    // A replay after the card was answered reuses the recorded answer.
    await expect(bridge.requestPermission(binding, bashRequest(), wait(20))).resolves.toEqual({ outcome: "allow_once" });
    expect(await rows()).toHaveLength(1);
  });

  it("delivers a live accept to the waiting run and persists outcome/decidedAt/consumedAt", async () => {
    const s = await seed();
    const bridge = claudePermissionBridgeService(db);
    const runId = randomUUID();
    const pending = bridge.requestPermission(bindingFor(s, { runId }), bashRequest(), wait(10_000));
    await waitFor(async () => {
      const [row] = await rows();
      return Boolean(row && hasLiveClaudePermissionWaiter(row.id));
    });
    const [card] = await rows();

    const accepted = await accept(s, card!.id);
    const delivery = await bridge.resolveFromRoute(accepted, { accepted: true });
    expect(delivery).toEqual({ live: true, outcome: "allow_once" });
    await expect(pending).resolves.toEqual({ outcome: "allow_once" });

    const stored = await rowById(card!.id);
    expect(stored.status).toBe("accepted");
    const cp = cpOf(stored)!;
    expect(cp).toMatchObject({ outcome: "allow_once", consumedByRunId: runId });
    expect(typeof cp.decidedAt).toBe("string");
    expect(cp.consumedAt).toBe(cp.decidedAt);
    expect(cp.parkedAt ?? null).toBeNull();
    // The jsonb merge kept the rest of the payload.
    expect(cp.fingerprint).toBe(claudePermissionFingerprint("Bash", bashRequest().rawInput));
    expect((stored.payload as { prompt?: string }).prompt).toContain("Bash");
    expect(requestConfirmationPayloadSchema.parse(stored.payload).claudePermission?.outcome).toBe("allow_once");
    expect(hasLiveClaudePermissionWaiter(card!.id)).toBe(false);

    // A double-click does not rewrite the outcome.
    await expect(bridge.resolveFromRoute(stored, { accepted: true })).resolves.toEqual({ live: false, outcome: null });
  });

  it("parks on timeout, records a late accept as a one-time grant, and uses it exactly once", async () => {
    const s = await seed();
    const bridge = claudePermissionBridgeService(db);
    const firstRunId = randomUUID();

    await expect(bridge.requestPermission(bindingFor(s, { runId: firstRunId }), bashRequest(), wait(20)))
      .resolves.toEqual({ outcome: "reject_once" });
    const [card] = await rows();
    expect(card!.status).toBe("pending");
    expect(typeof cpOf(card!)!.parkedAt).toBe("string");
    expect(hasLiveClaudePermissionWaiter(card!.id)).toBe(false);

    const accepted = await accept(s, card!.id);
    await expect(bridge.resolveFromRoute(accepted, { accepted: true })).resolves.toEqual({ live: false, outcome: "allow_once" });
    let cp = cpOf(await rowById(card!.id))!;
    expect(cp.outcome).toBe("allow_once");
    expect(typeof cp.decidedAt).toBe("string");
    expect(cp.consumedAt ?? null).toBeNull();

    // Next run, different tool call id, same fingerprint: consumes the grant.
    const secondRunId = randomUUID();
    await expect(
      bridge.requestPermission(bindingFor(s, { runId: secondRunId }), bashRequest(undefined, "tool-9"), wait(20)),
    ).resolves.toEqual({ outcome: "allow_once" });
    cp = cpOf(await rowById(card!.id))!;
    expect(typeof cp.consumedAt).toBe("string");
    expect(cp.consumedByRunId).toBe(secondRunId);
    expect(await rows()).toHaveLength(1);

    // Third request: the grant is spent, so a new card is created.
    await expect(bridge.requestPermission(bindingFor(s), bashRequest(), wait(20))).resolves.toEqual({ outcome: "reject_once" });
    const all = await rows();
    expect(all).toHaveLength(2);
    expect(all.find((row) => row.id !== card!.id)!.status).toBe("pending");
  });

  it("lets exactly one of two concurrent runs consume a grant", async () => {
    const s = await seed();
    const bridge = claudePermissionBridgeService(db);
    const grantId = await createLateGrant(s, bridge);

    const runA = randomUUID();
    const runB = randomUUID();
    const decisions = await Promise.all([
      bridge.requestPermission(bindingFor(s, { runId: runA }), bashRequest(undefined, "a"), wait(50)),
      bridge.requestPermission(bindingFor(s, { runId: runB }), bashRequest(undefined, "b"), wait(50)),
    ]);
    expect(decisions.filter((d) => d.outcome === "allow_once")).toHaveLength(1);
    expect(decisions.filter((d) => d.outcome === "reject_once")).toHaveLength(1);
    const cp = cpOf(await rowById(grantId))!;
    const winner = decisions[0]!.outcome === "allow_once" ? runA : runB;
    expect(cp.consumedByRunId).toBe(winner);

    // The conditional update itself: two racing patches, one row update.
    const second = await createLateGrant(s, bridge, bashRequest("npm publish"));
    const store = createDbClaudePermissionStore(db);
    const results = await Promise.all(
      ["x", "y", "z"].map((runId) =>
        store.patch(second, { consumedAt: new Date().toISOString(), consumedByRunId: runId }, { requireUnconsumed: true, requireStatus: "accepted" })),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("does not use grants from another agent, another issue, another fingerprint, or older than 24h", async () => {
    const s = await seed();
    const bridge = claudePermissionBridgeService(db);
    const grantId = await createLateGrant(s, bridge);
    const countBefore = (await rows()).length;

    // Different agent on the same issue.
    await expect(bridge.requestPermission(bindingFor(s, { agentId: s.otherAgentId }), bashRequest(), wait(20)))
      .resolves.toEqual({ outcome: "reject_once" });
    // Same agent, different issue.
    await expect(bridge.requestPermission(bindingFor(s, { issueId: s.otherIssueId }), bashRequest(), wait(20)))
      .resolves.toEqual({ outcome: "reject_once" });
    // Same agent and issue, different input.
    await expect(bridge.requestPermission(bindingFor(s), bashRequest("rm -rf build"), wait(20)))
      .resolves.toEqual({ outcome: "reject_once" });
    expect(cpOf(await rowById(grantId))!.consumedAt ?? null).toBeNull();
    expect((await rows()).length).toBe(countBefore + 3);

    // Backdate the grant past the TTL: no longer usable.
    await db
      .update(issueThreadInteractions)
      .set({ resolvedAt: new Date(Date.now() - 25 * 60 * 60 * 1000) })
      .where(eq(issueThreadInteractions.id, grantId));
    await expect(bridge.requestPermission(bindingFor(s), bashRequest(), wait(20)))
      .resolves.toEqual({ outcome: "reject_once" });
    expect(cpOf(await rowById(grantId))!.consumedAt ?? null).toBeNull();

    // Sanity: the same grant within the TTL is usable.
    await db
      .update(issueThreadInteractions)
      .set({ resolvedAt: new Date(Date.now() - 23 * 60 * 60 * 1000) })
      .where(eq(issueThreadInteractions.id, grantId));
    await expect(bridge.requestPermission(bindingFor(s), bashRequest(), wait(20)))
      .resolves.toEqual({ outcome: "allow_once" });
  });

  it("is not superseded by the agent's other confirmation cards or by the startup sweep", async () => {
    const s = await seed();
    const bridge = claudePermissionBridgeService(db);
    await bridge.requestPermission(bindingFor(s), bashRequest(), wait(20));
    const [permissionCard] = await rows();
    expect(permissionCard!.status).toBe("pending");

    const draft = () =>
      interactionsSvc.create(
        { id: s.issueId, companyId: s.companyId },
        {
          kind: "request_confirmation",
          payload: { version: 1, prompt: "Ship the plan?" },
        },
        { agentId: s.agentId },
      );
    const firstDraft = await draft();
    expect((await rowById(permissionCard!.id)).status).toBe("pending");
    // A second draft supersedes the first draft, still not the permission card.
    await draft();
    expect((await rowById(firstDraft.id)).status).toBe("expired");
    expect((await rowById(permissionCard!.id)).status).toBe("pending");

    // Make an older pending draft that the sweep would expire, next to the card.
    await db
      .update(issueThreadInteractions)
      .set({ status: "pending", resolvedAt: null, result: null })
      .where(eq(issueThreadInteractions.id, firstDraft.id));
    await db
      .update(issueThreadInteractions)
      .set({ createdAt: sql`now() - interval '1 hour'` })
      .where(and(eq(issueThreadInteractions.id, permissionCard!.id)));
    const swept = await interactionsSvc.sweepSupersededPendingRequestConfirmations();
    expect(swept.expired).toBe(1);
    expect((await rowById(firstDraft.id)).status).toBe("expired");
    expect((await rowById(permissionCard!.id)).status).toBe("pending");
  });
});
