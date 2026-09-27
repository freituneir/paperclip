import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AcpPermissionRequest, AcpRuntimeOptions } from "acpx/runtime";
import type { AdapterExecutionContext } from "../types.js";
import { createAcpxEngineExecutor } from "./execute.js";
import {
  acpxPermissionHookForSink,
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
    expect(events[0]?.payload).toEqual({
      toolName: "Bash",
      title: "git push origin main",
      kind: "execute",
      toolCallId: "tool-1",
    });
    expect(events[1]?.payload).toEqual({ toolCallId: "tool-1", outcome: "allow_once", source: "host" });
    expect(JSON.stringify(events)).not.toContain("secret-token");
  });

  it("falls back to the mode when the host throws or returns undefined", async () => {
    const throwing = makeCtx({
      requestPermission: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    const handler = createAcpxPermissionHandler({ ctx: throwing.ctx, runSignal: new AbortController().signal })!;
    await expect(handler(acpRequest(), { signal: new AbortController().signal })).resolves.toBeUndefined();
    expect(throwing.logs.join("")).toContain("Permission bridge failed");
    expect(throwing.events[1]?.payload).toEqual({ toolCallId: "tool-1", outcome: null, source: "mode" });

    const empty = makeCtx({ requestPermission: vi.fn(async () => undefined) });
    const emptyHandler = createAcpxPermissionHandler({ ctx: empty.ctx, runSignal: new AbortController().signal })!;
    await expect(emptyHandler(acpRequest(), { signal: new AbortController().signal })).resolves.toBeUndefined();
    expect(empty.events[1]?.payload).toMatchObject({ source: "mode", outcome: null });
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
  it("returns undefined with an empty sink", async () => {
    const sink = createAcpxPermissionSink();
    const hook = acpxPermissionHookForSink(sink);
    await expect(hook(acpRequest(), { signal: new AbortController().signal })).resolves.toBeUndefined();
    sink.current = async () => ({ outcome: "reject_once" });
    await expect(hook(acpRequest(), { signal: new AbortController().signal })).resolves.toEqual({
      outcome: "reject_once",
    });
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

    // A warm runtime keeps the hook, but the finished run's sink is cleared.
    const hook = runtimeOptions[0]!.onPermissionRequest!;
    await expect(hook(acpRequest(), { signal: new AbortController().signal })).resolves.toBeUndefined();
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

  it("falls back to the mode when the host throws", async () => {
    const { decisions } = await runWithPermissionRequest({
      requestPermission: async () => {
        throw new Error("host down");
      },
    });
    expect(decisions).toEqual([undefined]);
  });
});
