import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CLAUDE_REPORTED_MODELS_FILE,
  mergeClaudeModelLists,
  readClaudeReportedModels,
  recordProviderModelsEvent,
} from "../services/claude-reported-models.js";

let root: string;
let env: NodeJS.ProcessEnv;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-models-"));
  env = { PAPERCLIP_CLAUDE_HOME_ROOT: root };
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const event = {
  eventType: "provider.models",
  payload: {
    provider: "anthropic",
    agent: "claude",
    currentModelId: "default",
    models: [
      { id: "default", label: "Default (recommended)", description: "Opus 5.5" },
      { id: "sonnet", label: "Sonnet" },
      { id: "sonnet", label: "dup" },
      { label: "no id" },
    ],
  },
};

describe("recordProviderModelsEvent", () => {
  it("persists the Claude-reported list per company with run attribution", async () => {
    const ok = await recordProviderModelsEvent({
      adapterType: "claude_local",
      companyId: "company-1",
      agentId: "agent-1",
      runId: "run-1",
      event,
      env,
      now: () => new Date("2026-09-01T12:00:00.000Z"),
    });
    expect(ok).toBe(true);
    const raw = JSON.parse(
      await fs.readFile(path.join(root, "company-1", CLAUDE_REPORTED_MODELS_FILE), "utf8"),
    );
    expect(raw).toMatchObject({ agentId: "agent-1", runId: "run-1", reportedAt: "2026-09-01T12:00:00.000Z" });
    const stored = await readClaudeReportedModels(env, "company-1");
    expect(stored?.models).toEqual([
      { id: "default", label: "Default (recommended)", description: "Opus 5.5" },
      { id: "sonnet", label: "Sonnet" },
    ]);
    expect(stored?.currentModelId).toBe("default");
    // No leftover temp files from the atomic write.
    expect(await fs.readdir(path.join(root, "company-1"))).toEqual([CLAUDE_REPORTED_MODELS_FILE]);
  });

  it("ignores other adapters, other event types, and malformed payloads", async () => {
    const base = { companyId: "company-1", agentId: "a", runId: "r", env };
    expect(await recordProviderModelsEvent({ ...base, adapterType: "codex_local", event })).toBe(false);
    expect(await recordProviderModelsEvent({ ...base, adapterType: "claude_local", event: { ...event, eventType: "other" } })).toBe(false);
    expect(
      await recordProviderModelsEvent({ ...base, adapterType: "claude_local", event: { eventType: "provider.models", payload: { agent: "claude", provider: "anthropic", models: [] } } }),
    ).toBe(false);
    expect(await readClaudeReportedModels(env, "company-1")).toBeNull();
  });

  it("never throws when the write fails", async () => {
    const ok = await recordProviderModelsEvent({
      adapterType: "claude_local",
      companyId: "../escape",
      agentId: "a",
      runId: "r",
      event,
      env,
    });
    expect(ok).toBe(false);
  });

  it("treats a corrupt file as no report", async () => {
    await fs.mkdir(path.join(root, "company-1"), { recursive: true });
    await fs.writeFile(path.join(root, "company-1", CLAUDE_REPORTED_MODELS_FILE), "{nope");
    expect(await readClaudeReportedModels(env, "company-1")).toBeNull();
  });
});

describe("mergeClaudeModelLists", () => {
  it("puts Claude-reported models first and marks the rest builtin/api", () => {
    const merged = mergeClaudeModelLists(
      {
        version: 1,
        provider: "anthropic",
        agent: "claude",
        models: [{ id: "opus", label: "Opus", description: "Most capable" }],
        currentModelId: "opus",
        reportedAt: "2026-09-01T00:00:00.000Z",
        agentId: "a",
        runId: "r",
      },
      [
        { id: "claude-sonnet-5", label: "Sonnet 5" },
        { id: "opus", label: "dup" },
        { id: "claude-live", label: "Live" },
      ],
      new Set(["claude-live"]),
    );
    expect(merged).toEqual([
      { id: "opus", label: "Opus", source: "claude", reportedAt: "2026-09-01T00:00:00.000Z", note: "Most capable" },
      { id: "claude-sonnet-5", label: "Sonnet 5", source: "builtin" },
      { id: "claude-live", label: "Live", source: "api" },
    ]);
    expect(mergeClaudeModelLists(null, [{ id: "x", label: "x" }])).toEqual([{ id: "x", label: "x", source: "builtin" }]);
  });
});
