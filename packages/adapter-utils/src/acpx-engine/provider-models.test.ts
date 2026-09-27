import { describe, expect, it, vi } from "vitest";
import { emitProviderModelsEvent, providerModelsFromRuntimeStatus } from "./provider-models.js";

describe("providerModelsFromRuntimeStatus", () => {
  it("reads grouped model config options with names and descriptions", () => {
    const payload = providerModelsFromRuntimeStatus(
      {
        models: { currentModelId: "opus", availableModelIds: ["opus"] },
        details: {
          configOptions: [
            {
              id: "model",
              type: "select",
              category: "model",
              currentValue: "opus",
              options: [{ group: "g", name: "Group", options: [{ value: "opus", name: "Opus", description: " big " }] }],
            },
          ],
        },
      },
      { claudeCodeVersion: "2.3.4" },
    );
    expect(payload).toEqual({
      provider: "anthropic",
      agent: "claude",
      currentModelId: "opus",
      claudeCodeVersion: "2.3.4",
      models: [{ id: "opus", label: "Opus", description: "big" }],
    });
  });

  it("falls back to bare model ids and returns null when nothing is advertised", () => {
    expect(
      providerModelsFromRuntimeStatus({ models: { availableModelIds: ["a", "a", " ", "b"] } })?.models,
    ).toEqual([
      { id: "a", label: "a" },
      { id: "b", label: "b" },
    ]);
    expect(providerModelsFromRuntimeStatus({ models: { availableModelIds: [] } })).toBeNull();
    expect(providerModelsFromRuntimeStatus(null)).toBeNull();
  });

  it("never throws when the event sink fails", async () => {
    const onEvent = vi.fn(async () => {
      throw new Error("sink down");
    });
    await expect(
      emitProviderModelsEvent({ onEvent }, { provider: "anthropic", agent: "claude", models: [{ id: "x", label: "x" }], currentModelId: null }),
    ).resolves.toBeUndefined();
    expect(onEvent).toHaveBeenCalledTimes(1);
  });
});
