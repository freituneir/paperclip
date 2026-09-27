import type { AdapterExecutionContext, AdapterRuntimeEvent } from "../types.js";

/**
 * "Models reported by Claude": after a claude session is created or loaded,
 * the ACP runtime knows the exact model list the running Claude binary offers
 * for the logged-in account (claude-agent-acp builds it from the SDK's
 * initialization `models`, filtered by the user's `availableModels` allowlist).
 * The engine forwards that list once per run as a `provider.models` adapter
 * event so the server can replace the hardcoded picker list with it.
 */
export const PROVIDER_MODELS_EVENT_TYPE = "provider.models";

export interface ProviderReportedModel {
  id: string;
  label: string;
  description?: string;
}

export interface ProviderModelsEventPayload {
  provider: "anthropic";
  agent: "claude";
  models: ProviderReportedModel[];
  currentModelId: string | null;
  claudeCodeVersion?: string;
}

const MAX_MODELS = 200;
const MAX_TEXT = 500;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function cleanText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, MAX_TEXT) : undefined;
}

function parseOption(value: unknown): ProviderReportedModel | null {
  const option = asRecord(value);
  const id = cleanText(option?.value);
  if (!option || !id) return null;
  const description = cleanText(option.description);
  return { id, label: cleanText(option.name) ?? id, ...(description ? { description } : {}) };
}

/** Model entries from an ACP `select` config option (flat or grouped options). */
function modelsFromConfigOptions(configOptions: unknown): { models: ProviderReportedModel[]; currentModelId: string | null } | null {
  if (!Array.isArray(configOptions)) return null;
  for (const raw of configOptions) {
    const option = asRecord(raw);
    if (!option || option.type !== "select") continue;
    if (option.category !== "model" && option.id !== "model") continue;
    if (!Array.isArray(option.options)) continue;
    const models: ProviderReportedModel[] = [];
    for (const entry of option.options) {
      const group = asRecord(entry);
      if (group && Array.isArray(group.options)) {
        for (const nested of group.options) {
          const parsed = parseOption(nested);
          if (parsed) models.push(parsed);
        }
        continue;
      }
      const parsed = parseOption(entry);
      if (parsed) models.push(parsed);
    }
    if (models.length === 0) continue;
    return { models, currentModelId: cleanText(option.currentValue) ?? null };
  }
  return null;
}

function dedupe(models: ProviderReportedModel[]): ProviderReportedModel[] {
  const seen = new Set<string>();
  const out: ProviderReportedModel[] = [];
  for (const model of models) {
    if (seen.has(model.id)) continue;
    seen.add(model.id);
    out.push(model);
    if (out.length >= MAX_MODELS) break;
  }
  return out;
}

/**
 * Build the `provider.models` payload from an acpx `getStatus()` result.
 * Prefers the model config option in `details.configOptions` (it carries the
 * display names and descriptions Claude advertised); falls back to the bare
 * `models.availableModelIds`. Returns null when the runtime advertised nothing.
 */
export function providerModelsFromRuntimeStatus(
  status: unknown,
  options: { claudeCodeVersion?: string | null } = {},
): ProviderModelsEventPayload | null {
  const record = asRecord(status);
  if (!record) return null;
  const statusModels = asRecord(record.models);
  const details = asRecord(record.details);
  const fromConfig = modelsFromConfigOptions(details?.configOptions);
  let models: ProviderReportedModel[] = fromConfig?.models ?? [];
  if (models.length === 0 && Array.isArray(statusModels?.availableModelIds)) {
    models = statusModels.availableModelIds
      .map((id) => cleanText(id))
      .filter((id): id is string => Boolean(id))
      .map((id) => ({ id, label: id }));
  }
  models = dedupe(models);
  if (models.length === 0) return null;
  const currentModelId = cleanText(statusModels?.currentModelId) ?? fromConfig?.currentModelId ?? null;
  const claudeCodeVersion = cleanText(options.claudeCodeVersion);
  return {
    provider: "anthropic",
    agent: "claude",
    models,
    currentModelId,
    ...(claudeCodeVersion ? { claudeCodeVersion } : {}),
  };
}

/** Emit `provider.models`; never throws (this must not fail a run). */
export async function emitProviderModelsEvent(
  ctx: Pick<AdapterExecutionContext, "onEvent">,
  payload: ProviderModelsEventPayload,
): Promise<void> {
  if (!ctx.onEvent) return;
  const event: AdapterRuntimeEvent = {
    eventType: PROVIDER_MODELS_EVENT_TYPE,
    stream: "system",
    level: "info",
    message: `Claude reported ${payload.models.length} available model${payload.models.length === 1 ? "" : "s"}`,
    payload: payload as unknown as Record<string, unknown>,
  };
  try {
    await ctx.onEvent(event);
  } catch {
    // Model discovery is advisory; never fail the run over it.
  }
}
