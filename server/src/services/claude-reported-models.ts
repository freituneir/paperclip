import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { AdapterModel, AdapterRuntimeEvent } from "@paperclipai/adapter-utils";
import { ensureClaudeHomeDir, resolveClaudeHomeDir } from "@paperclipai/adapter-claude-local/server";

// "Models reported by Claude". The ACPX engine emits one `provider.models`
// adapter event per claude run carrying the model list the running Claude
// binary advertised for the logged-in account. We persist the latest list per
// company next to the company's Claude Home (no schema change) and the model
// list endpoint serves it ahead of the hardcoded fallback list.

export const PROVIDER_MODELS_EVENT_TYPE = "provider.models";
export const CLAUDE_REPORTED_MODELS_FILE = ".paperclip-models.json";

const MAX_MODELS = 200;
const MAX_TEXT = 500;

export interface ClaudeReportedModel {
  id: string;
  label: string;
  description?: string;
}

export interface ClaudeReportedModelsRecord {
  version: 1;
  provider: "anthropic";
  agent: "claude";
  models: ClaudeReportedModel[];
  currentModelId: string | null;
  claudeCodeVersion?: string;
  reportedAt: string;
  agentId: string;
  runId: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function cleanText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, MAX_TEXT) : undefined;
}

function parseModels(value: unknown): ClaudeReportedModel[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const models: ClaudeReportedModel[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    const id = cleanText(record?.id);
    if (!record || !id || seen.has(id)) continue;
    seen.add(id);
    const description = cleanText(record.description);
    models.push({ id, label: cleanText(record.label) ?? id, ...(description ? { description } : {}) });
    if (models.length >= MAX_MODELS) break;
  }
  return models;
}

/** Validate a `provider.models` event payload; null when it is not a usable Claude report. */
export function parseProviderModelsPayload(
  payload: unknown,
): Pick<ClaudeReportedModelsRecord, "models" | "currentModelId" | "claudeCodeVersion"> | null {
  const record = asRecord(payload);
  if (!record || record.agent !== "claude" || record.provider !== "anthropic") return null;
  const models = parseModels(record.models);
  if (models.length === 0) return null;
  const claudeCodeVersion = cleanText(record.claudeCodeVersion);
  return {
    models,
    currentModelId: cleanText(record.currentModelId) ?? null,
    ...(claudeCodeVersion ? { claudeCodeVersion } : {}),
  };
}

export function claudeReportedModelsPath(env: NodeJS.ProcessEnv, companyId: string): string {
  return path.join(resolveClaudeHomeDir(env, companyId), CLAUDE_REPORTED_MODELS_FILE);
}

export async function writeClaudeReportedModels(
  env: NodeJS.ProcessEnv,
  companyId: string,
  record: ClaudeReportedModelsRecord,
): Promise<void> {
  const target = claudeReportedModelsPath(env, companyId);
  await ensureClaudeHomeDir(path.dirname(target));
  const tmpPath = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(tmpPath, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(tmpPath, target);
  } catch (error) {
    await fs.rm(tmpPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** The persisted report, or null when missing/unreadable/invalid (never throws). */
export async function readClaudeReportedModels(
  env: NodeJS.ProcessEnv,
  companyId: string,
): Promise<ClaudeReportedModelsRecord | null> {
  try {
    const raw = await fs.readFile(claudeReportedModelsPath(env, companyId), "utf8");
    const parsed = asRecord(JSON.parse(raw));
    if (!parsed) return null;
    const payload = parseProviderModelsPayload(parsed);
    const reportedAt = cleanText(parsed.reportedAt);
    if (!payload || !reportedAt) return null;
    return {
      version: 1,
      provider: "anthropic",
      agent: "claude",
      ...payload,
      reportedAt,
      agentId: cleanText(parsed.agentId) ?? "",
      runId: cleanText(parsed.runId) ?? "",
    };
  } catch {
    return null;
  }
}

/**
 * Heartbeat hook: persist a `provider.models` event from a claude_local run.
 * Cheap and isolated — returns false (never throws) when the event does not
 * apply or the write fails.
 */
export async function recordProviderModelsEvent(input: {
  adapterType: string;
  companyId: string;
  agentId: string;
  runId: string;
  event: Pick<AdapterRuntimeEvent, "eventType" | "payload">;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}): Promise<boolean> {
  try {
    if (input.event.eventType !== PROVIDER_MODELS_EVENT_TYPE) return false;
    if (input.adapterType !== "claude_local") return false;
    const payload = parseProviderModelsPayload(input.event.payload);
    if (!payload) return false;
    await writeClaudeReportedModels(input.env ?? process.env, input.companyId, {
      version: 1,
      provider: "anthropic",
      agent: "claude",
      ...payload,
      reportedAt: (input.now?.() ?? new Date()).toISOString(),
      agentId: input.agentId,
      runId: input.runId,
    });
    return true;
  } catch (error) {
    console.warn("[paperclip] failed to persist Claude-reported models", {
      companyId: input.companyId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * Claude-reported models first (authoritative, source "claude"), then any
 * other listed model not already present. Listed entries keep their source;
 * otherwise they are "api" when they came from live API discovery (id listed
 * in `apiIds`) and "builtin" (hardcoded, unverified) in every other case.
 */
export function mergeClaudeModelLists(
  reported: ClaudeReportedModelsRecord | null,
  listed: AdapterModel[],
  apiIds: ReadonlySet<string> = new Set(),
): AdapterModel[] {
  const out: AdapterModel[] = [];
  const seen = new Set<string>();
  for (const model of reported?.models ?? []) {
    if (seen.has(model.id)) continue;
    seen.add(model.id);
    out.push({
      id: model.id,
      label: model.label,
      source: "claude",
      reportedAt: reported!.reportedAt,
      ...(model.description ? { note: model.description } : {}),
    });
  }
  for (const model of listed) {
    if (seen.has(model.id)) continue;
    seen.add(model.id);
    out.push({
      ...model,
      source: model.source ?? (apiIds.has(model.id) ? "api" : "builtin"),
    });
  }
  return out;
}
