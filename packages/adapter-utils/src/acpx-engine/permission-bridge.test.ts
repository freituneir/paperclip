import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AcpPermissionRequest, AcpRuntimeOptions } from "acpx/runtime";
import type { AdapterExecutionContext } from "../types.js";
import { createAcpxEngineExecutor } from "./execute.js";
import {
  acpxPermissionHookForSink,
  claimAcpxPermissionSink,
  createAcpxPermissionHandler,
  createAcpxPermissionSink,
  mapAcpPermissionRequest,
  resolvePermissionWaitMs,
} from "./permission-bridge.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })),
  );
});

function acpRequest(overrides: Record<string, unknown> = {}): AcpPermissionRequest {
  return {
    sessionId: "session-1",
    inferredKind: "execute",
    raw: {
      sessionId: "session-1",
      toolCall: {
        toolCallId: "tool-1",
        title: "git push origin main",
        kind: "execute",
        rawInput: { command: "git push origin main", token: "secret-token" },
        _meta: { claudeCode: { toolName: "Bash" } },
      },
      options: [
        { optionId: "allow", name: "Allow", kind: "allow_once" },
        { optionId: "reject", name: "Reject", kind: "reject_once" },
      ],
      ...overrides,
    },
  } as unknown as AcpPermissionRequest;
}

describe("mapAcpPermissionRequest", () => {
  it("maps the ACP request to the adapter contract", () => {
    expect(mapAcpPermissionRequest(acpRequest())).toEqual({
      toolCallId: "tool-1",
      toolName: "Bash",
      title: "git push origin main",
      kind: "execute",
      rawInput: { command: "git push origin main", token: "secret-token" },
      options: [
        { optionId: "allow", name: "Allow", kind: "allow_once" },
        { optionId: "reject", name: "Reject", kind: "reject_once" },
      ],
    });
  });

  it("tolerates missing fields", () => {
    const mapped = mapAcpPermissionRequest({
      sessionId: "s",
      inferredKind: undefined,
      raw: { sessionId: "s", toolCall: {}, options: [null, { name: "x" }] },
    } as unknown as AcpPermissionRequest);
    expect(mapped).toEqual({
      toolCallId: null,
      toolName: null,
      title: null,
      kind: null,
      rawInput: null,
      options: [],
    });
  });
});

describe("resolvePermissionWaitMs", () => {
  it("defaults to 600s and clamps to 10s..86400s", () => {
    expect(resolvePermissionWaitMs({})).toBe(600_000);
    expect(resolvePermissionWaitMs({ permissionWaitSec: 1 })).toBe(10_000);
    expect(resolvePermissionWaitMs({ permissionWaitSec: 10_000_000 })).toBe(86_400_000);
    expect(resolvePermissionWaitMs({ permissionWaitSec: "120" })).toBe(120_000);
    expect(resolvePermissionWaitMs({ permissionWaitSec: "nope" })).toBe(600_000);
  });
});

describe("createAcpxPermissionHandler", () => {
  function makeCtx(overrides: Partial<AdapterExecutionContext> = {}) {
    const events: Array<{ eventType: string; payload?: Record<string, unknown> }> = [];
    const logs: string[] = [];
    const ctx = {
      config: {},
      onLog: async (_stream: "stdout" | "stderr", chunk: string) => {
        logs.push(chunk);
      },
      onEvent: async (event: { eventType: string; payload?: Record<string, unknown> }) => {
        events.push(event);
      },
      ...overrides,
    } as AdapterExecutionContext;
    return { ctx, events, logs };
  }

  it("returns null without a host hook or when the bridge is off", () => {
    const runSignal = new AbortController().signal;
    expect(createAcpxPermissionHandler({ ctx: makeCtx().ctx, runSignal })).toBeNull();
    expect(
      createAcpxPermissionHandler({
        ctx: makeCtx({ config: { permissionBridge: "off" }, requestPermission: vi.fn() }).ctx,
        runSignal,
      }),
    ).toBeNull();
  });

  it("delegates to requestPermission with the mapped request and wait bound", async () => {
    const requestPermission = vi.fn(async () => ({ outcome: "allow_once" as const }));
    const { ctx, events } = makeCtx({ config: { permissionWaitSec: 30 }, requestPermission });
    const handler = createAcpxPermissionHandler({ ctx, runSignal: new AbortController().signal })!;
    const decision = await handler(acpRequest(), { signal: new AbortController().signal });
    expect(decision).toEqual({ outcome: "allow_once" });
    expect(requestPermission).toHaveBeenCalledOnce();
    const [request, opts] = requestPermission.mock.calls[0] as unknown as [unknown, { signal: AbortSignal; waitMs: number }];
    expect(request).toEqual(mapAcpPermissionRequest(acpRequest()));
    expect(opts.waitMs).toBe(30_000);
    expect(opts.signal).toBeInstanceOf(AbortSignal);
    expect(events.map((event) => event.eventType)).toEqual(["permission.requested", "permission.resolved"]);
    // No title: for Bash it is the command itself, which can carry secrets, and
    // run events are not run-secret redacted (the approval card is).
    expect(events[0]?.payload).toEqual({
      toolName: "Bash",
      kind: "execute",
      toolCallId: "tool-1",
    });
    expect(JSON.stringify(events)).not.toContain("git push origin main");
    expect(events[1]?.payload).toEqual({ toolCallId: "tool-1", outcome: "allow_once", source: "host" });
    expect(JSON.stringify(events)).not.toContain("secret-token");
  });

  it("fails closed (reject_once) when the host throws, returns undefined, or an invalid outcome", async () => {
    const throwing = makeCtx({
      requestPermission: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    const handler = createAcpxPermissionHandler({ ctx: throwing.ctx, runSignal: new AbortController().signal })!;
    await expect(handler(acpRequest(), { signal: new AbortController().signal })).resolves.toEqual({
      outcome: "reject_once",
    });
    expect(throwing.logs.join("")).toContain("Permission bridge failed");
    expect(throwing.events[1]?.payload).toEqual({ toolCallId: "tool-1", outcome: "reject_once", source: "fail_closed" });

    const empty = makeCtx({ requestPermission: vi.fn(async () => undefined) });
    const emptyHandler = createAcpxPermissionHandler({ ctx: empty.ctx, runSignal: new AbortController().signal })!;
    await expect(emptyHandler(acpRequest(), { signal: new AbortController().signal })).resolves.toEqual({
      outcome: "reject_once",
    });
    expect(empty.events[1]?.payload).toMatchObject({ source: "fail_closed", outcome: "reject_once" });

    const invalid = makeCtx({ requestPermission: vi.fn(async () => ({ outcome: "approve" }) as never) });
    const invalidHandler = createAcpxPermissionHandler({ ctx: invalid.ctx, runSignal: new AbortController().signal })!;
    await expect(invalidHandler(acpRequest(), { signal: new AbortController().signal })).resolves.toEqual({
      outcome: "reject_once",
    });
    expect(invalid.events[1]?.payload).toMatchObject({ source: "fail_closed", outcome: "reject_once" });
  });

  it("cancels without asking the host when the run signal is already aborted", async () => {
    const requestPermission = vi.fn(async () => ({ outcome: "allow_once" as const }));
    const { ctx, events } = makeCtx({ requestPermission });
    const runAbort = new AbortController();
    runAbort.abort();
    const handler = createAcpxPermissionHandler({ ctx, runSignal: runAbort.signal })!;
    await expect(handler(acpRequest(), { signal: new AbortController().signal })).resolves.toEqual({
      outcome: "cancel",
    });
    expect(requestPermission).not.toHaveBeenCalled();
    expect(events.find((event) => event.eventType === "permission.resolved")?.payload).toEqual({
      toolCallId: "tool-1",
      outcome: "cancel",
      source: "fail_closed",
    });
  });

  it("cancels when the host fails after the run aborted mid-wait", async () => {
    const runAbort = new AbortController();
    const requestPermission = vi.fn(async () => {
      runAbort.abort();
      throw new Error("aborted");
    });
    const { ctx, events } = makeCtx({ requestPermission });
    const handler = createAcpxPermissionHandler({ ctx, runSignal: runAbort.signal })!;
    await expect(handler(acpRequest(), { signal: new AbortController().signal })).resolves.toEqual({
      outcome: "cancel",
    });
    expect(events[1]?.payload).toMatchObject({ outcome: "cancel", source: "fail_closed" });
  });

  it("passes a signal that aborts when the run ends", async () => {
    const runAbort = new AbortController();
    let seen: AbortSignal | undefined;
    const requestPermission = vi.fn(async (_request: unknown, opts: { signal: AbortSignal }) => {
      seen = opts.signal;
      runAbort.abort();
      return undefined;
    });
    const { ctx } = makeCtx({ requestPermission });
    const handler = createAcpxPermissionHandler({ ctx, runSignal: runAbort.signal })!;
    await handler(acpRequest(), { signal: new AbortController().signal });
    expect(seen?.aborted).toBe(true);
  });
});

describe("acpxPermissionHookForSink", () => {
  it("returns undefined with an empty sink while the bridge is off (legacy)", async () => {
    const sink = createAcpxPermissionSink();
    const hook = acpxPermissionHookForSink(sink);
    await expect(hook(acpRequest(), { signal: new AbortController().signal })).resolves.toBeUndefined();
    sink.current = async () => ({ outcome: "reject_once" });
    await expect(hook(acpRequest(), { signal: new AbortController().signal })).resolves.toEqual({
      outcome: "reject_once",
    });
  });

  it("denies with an empty sink while the bridge is on", async () => {
    const sink = createAcpxPermissionSink();
    sink.bridgeEnabled = true;
    const hook = acpxPermissionHookForSink(sink);
    await expect(hook(acpRequest(), { signal: new AbortController().signal })).resolves.toEqual({
      outcome: "reject_once",
    });
    const aborted = new AbortController();
    aborted.abort();
    await expect(hook(acpRequest(), { signal: aborted.signal })).resolves.toEqual({ outcome: "cancel" });
  });
});

describe("claimAcpxPermissionSink", () => {
  const allow = async () => ({ outcome: "allow_once" as const });
  const reject = async () => ({ outcome: "reject_always" as const });

  it("routes a reused runtime's hook to each run in turn and denies after release", async () => {
    const sink = createAcpxPermissionSink();
    const hook = acpxPermissionHookForSink(sink);
    const releaseFirst = claimAcpxPermissionSink({ sink, handler: allow, runId: "run-1" });
    await expect(hook(acpRequest(), { signal: new AbortController().signal })).resolves.toEqual({ outcome: "allow_once" });
    releaseFirst();
    await expect(hook(acpRequest(), { signal: new AbortController().signal })).resolves.toEqual({ outcome: "reject_once" });

    const releaseSecond = claimAcpxPermissionSink({ sink, handler: reject, runId: "run-2" });
    await expect(hook(acpRequest(), { signal: new AbortController().signal })).resolves.toEqual({
      outcome: "reject_always",
    });
    releaseSecond();
    await expect(hook(acpRequest(), { signal: new AbortController().signal })).resolves.toEqual({ outcome: "reject_once" });
  });

  it("records the bridge mode of the claiming run (off keeps legacy undefined)", async () => {
    const sink = createAcpxPermissionSink();
    const hook = acpxPermissionHookForSink(sink);
    claimAcpxPermissionSink({ sink, handler: allow, runId: "run-1" })();
    claimAcpxPermissionSink({ sink, handler: null, runId: "run-2" })();
    expect(sink.bridgeEnabled).toBe(false);
    await expect(hook(acpRequest(), { signal: new AbortController().signal })).resolves.toBeUndefined();
  });

  it("reports an overlapping claim and a stale release never clears the new owner", async () => {
    const sink = createAcpxPermissionSink();
    const hook = acpxPermissionHookForSink(sink);
    const overlaps: Array<string | null> = [];
    const releaseFirst = claimAcpxPermissionSink({ sink, handler: allow, runId: "run-1" });
    const releaseSecond = claimAcpxPermissionSink({
      sink,
      handler: reject,
      runId: "run-2",
      onOverlap: (previous) => overlaps.push(previous),
    });
    expect(overlaps).toEqual(["run-1"]);
    releaseFirst();
    expect(sink.ownerRunId).toBe("run-2");
    await expect(hook(acpRequest(), { signal: new AbortController().signal })).resolves.toEqual({
      outcome: "reject_always",
    });
    releaseSecond();
    expect(sink.current).toBeNull();
    expect(sink.ownerRunId).toBeNull();
  });
});

describe("ACPX engine permission bridge", () => {
  async function runWithPermissionRequest(input: {
    config?: Record<string, unknown>;
    requestPermission?: AdapterExecutionContext["requestPermission"];
  }) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-acpx-permission-"));
    tempRoots.push(root);
    const runtimeOptions: AcpRuntimeOptions[] = [];
    const decisions: unknown[] = [];
    const events: Array<{ eventType: string; payload?: Record<string, unknown> }> = [];
    const execute = createAcpxEngineExecutor({
      warmHandles: new Map(),
      createRuntime: (options) => {
        runtimeOptions.push(options);
        return {
          ensureSession: async () => ({
            backendSessionId: "backend-session",
            agentSessionId: "agent-session",
            runtimeSessionName: "runtime-session",
          }),
          startTurn: () => ({
            events: (async function* () {
              decisions.push(
                await options.onPermissionRequest?.(acpRequest(), { signal: new AbortController().signal }),
              );
              yield { type: "done", stopReason: "end_turn" };
            })(),
            result: Promise.resolve({ status: "completed" as const, stopReason: "end_turn" }),
            cancel: async () => {},
          }),
          setConfigOption: async () => {},
          close: async () => {},
        } as never;
      },
    });
    const result = await execute({
      runId: "run-1",
      agent: { id: "agent-1", companyId: "company-1" },
      runtime: {},
      config: { agent: "claude", cwd: root, stateDir: path.join(root, "state"), ...input.config },
      context: { taskId: "issue-1", paperclipWorkspace: { cwd: root } },
      requestPermission: input.requestPermission,
      onLog: async () => {},
      onMeta: async () => {},
      onEvent: async (event: { eventType: string; payload?: Record<string, unknown> }) => {
        events.push(event);
      },
    } as never);
    expect(result.exitCode).toBe(0);
    return { runtimeOptions, decisions, events };
  }

  it("installs a hook that forwards to ctx.requestPermission and clears after the run", async () => {
    const requestPermission = vi.fn(async () => ({ outcome: "allow_once" as const }));
    const { runtimeOptions, decisions, events } = await runWithPermissionRequest({ requestPermission });
    expect(decisions).toEqual([{ outcome: "allow_once" }]);
    expect(requestPermission).toHaveBeenCalledOnce();
    expect((requestPermission.mock.calls[0] as unknown as [{ toolName: string }])[0].toolName).toBe("Bash");
    const permissionEvents = events.filter((event) => event.eventType.startsWith("permission."));
    expect(permissionEvents.map((event) => event.eventType)).toEqual(["permission.requested", "permission.resolved"]);
    expect(JSON.stringify(permissionEvents)).not.toContain("secret-token");

    // A warm runtime keeps the hook, but the finished run's sink is cleared:
    // a late request after release is denied, never approved by the mode.
    const hook = runtimeOptions[0]!.onPermissionRequest!;
    await expect(hook(acpRequest(), { signal: new AbortController().signal })).resolves.toEqual({
      outcome: "reject_once",
    });
    expect(requestPermission).toHaveBeenCalledOnce();
  });

  it("falls back to the mode when the bridge is off", async () => {
    const requestPermission = vi.fn(async () => ({ outcome: "allow_once" as const }));
    const { decisions, events } = await runWithPermissionRequest({
      config: { permissionBridge: "off" },
      requestPermission,
    });
    expect(decisions).toEqual([undefined]);
    expect(requestPermission).not.toHaveBeenCalled();
    expect(events.some((event) => event.eventType.startsWith("permission."))).toBe(false);
  });

  it("falls back to the mode without a host hook", async () => {
    const { decisions } = await runWithPermissionRequest({});
    expect(decisions).toEqual([undefined]);
  });

  it("fails closed when the host throws", async () => {
    const { decisions, events } = await runWithPermissionRequest({
      requestPermission: async () => {
        throw new Error("host down");
      },
    });
    expect(decisions).toEqual([{ outcome: "reject_once" }]);
    expect(events.find((event) => event.eventType === "permission.resolved")?.payload).toMatchObject({
      source: "fail_closed",
    });
  });

  it("keeps the legacy undefined on a late request when the bridge was off", async () => {
    const { runtimeOptions } = await runWithPermissionRequest({
      config: { permissionBridge: "off" },
      requestPermission: vi.fn(async () => ({ outcome: "allow_once" as const })),
    });
    const hook = runtimeOptions[0]!.onPermissionRequest!;
    await expect(hook(acpRequest(), { signal: new AbortController().signal })).resolves.toBeUndefined();
  });
});
