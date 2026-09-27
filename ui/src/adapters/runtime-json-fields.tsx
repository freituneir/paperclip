import { createContext, useContext, useEffect, useState } from "react";
import type { AdapterConfigFieldsProps, CreateConfigValues } from "./types";
import { Field, help } from "../components/agent-config-primitives";

// TODO(issue-worktree-support): re-enable this UI once the workflow is ready to ship.
const SHOW_EXPERIMENTAL_ISSUE_WORKTREE_UI = false;

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function formatJsonObject(value: unknown): string {
  const record = asRecord(value);
  return Object.keys(record).length > 0 ? JSON.stringify(record, null, 2) : "";
}

function updateJsonConfig(
  isCreate: boolean,
  key: "runtimeServicesJson" | "payloadTemplateJson",
  next: string,
  set: AdapterConfigFieldsProps["set"],
  mark: AdapterConfigFieldsProps["mark"],
  configKey: string,
) {
  if (isCreate) {
    set?.({ [key]: next });
    return;
  }

  const trimmed = next.trim();
  if (!trimmed) {
    mark("adapterConfig", configKey, undefined);
    return;
  }

  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      mark("adapterConfig", configKey, parsed);
    }
  } catch {
    // Keep local draft until JSON is valid.
  }
}

type JsonFieldProps = Pick<
  AdapterConfigFieldsProps,
  "isCreate" | "values" | "set" | "config" | "mark"
>;

export function RuntimeServicesJsonField({
  isCreate,
  values,
  set,
  config,
  mark,
}: JsonFieldProps) {
  if (!SHOW_EXPERIMENTAL_ISSUE_WORKTREE_UI) {
    return null;
  }

  const existing = formatJsonObject(config.workspaceRuntime);
  const [draft, setDraft] = useState(existing);

  useEffect(() => {
    if (!isCreate) setDraft(existing);
  }, [existing, isCreate]);

  const value = isCreate ? values?.runtimeServicesJson ?? "" : draft;

  return (
    <Field label="Runtime services JSON" hint={help.runtimeServicesJson}>
      <textarea
        className={`${inputClass} min-h-[148px]`}
        value={value}
        onChange={(e) => {
          const next = e.target.value;
          if (!isCreate) setDraft(next);
          updateJsonConfig(isCreate, "runtimeServicesJson", next, set, mark, "workspaceRuntime");
        }}
        placeholder={`{\n  "services": [\n    {\n      "name": "preview",\n      "lifecycle": "ephemeral",\n      "metadata": {\n        "purpose": "remote preview"\n      }\n    }\n  ]\n}`}
      />
    </Field>
  );
}

export function PayloadTemplateJsonField({
  isCreate,
  values,
  set,
  config,
  mark,
}: JsonFieldProps) {
  const existing = formatJsonObject(config.payloadTemplate);
  const [draft, setDraft] = useState(existing);

  useEffect(() => {
    if (!isCreate) setDraft(existing);
  }, [existing, isCreate]);

  const value = isCreate ? values?.payloadTemplateJson ?? "" : draft;

  return (
    <Field label="Payload template JSON" hint={help.payloadTemplateJson}>
      <textarea
        className={`${inputClass} min-h-[132px]`}
        value={value}
        onChange={(e) => {
          const next = e.target.value;
          if (!isCreate) setDraft(next);
          updateJsonConfig(isCreate, "payloadTemplateJson", next, set, mark, "payloadTemplate");
        }}
        placeholder={`{\n  "agentId": "remote-agent-123",\n  "metadata": {\n    "team": "platform"\n  }\n}`}
      />
    </Field>
  );
}

/**
 * Lets an edit form learn which JSON object drafts are currently invalid. An
 * invalid edit draft never reaches the form overlay (the last valid value
 * stays there), so the form must refuse to save while any draft is invalid;
 * otherwise it would silently persist the stale value. `null` outside a form.
 */
export const JsonDraftValidityContext = createContext<((key: string, invalid: boolean) => void) | null>(null);

type JsonObjectCreateKey = {
  [K in keyof CreateConfigValues]-?: NonNullable<CreateConfigValues[K]> extends string ? K : never;
}[keyof CreateConfigValues];

/** Parse error for a JSON object draft, or null when the draft is empty or valid. */
export function jsonObjectDraftError(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return "Must be a JSON object.";
    }
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : "Invalid JSON.";
  }
}

/**
 * A JSON object textarea bound to one adapter config key. Create mode stores the
 * raw text in `values[createKey]`; edit mode marks the parsed object (or
 * undefined when empty) and keeps an invalid draft local with a parse error.
 */
export function JsonObjectConfigField({
  isCreate,
  values,
  set,
  config,
  mark,
  label,
  hint,
  createKey,
  configKey,
  placeholder,
}: JsonFieldProps & {
  label: string;
  hint?: string;
  createKey: JsonObjectCreateKey;
  configKey: string;
  placeholder?: string;
}) {
  const existing = formatJsonObject(config[configKey]);
  const [draft, setDraft] = useState(existing);

  useEffect(() => {
    if (!isCreate) setDraft(existing);
  }, [existing, isCreate]);

  const value = isCreate ? String(values?.[createKey] ?? "") : draft;
  const error = jsonObjectDraftError(value);
  const reportValidity = useContext(JsonDraftValidityContext);
  const invalidEditDraft = !isCreate && error !== null;

  useEffect(() => {
    if (!reportValidity) return;
    reportValidity(configKey, invalidEditDraft);
    return () => reportValidity(configKey, false);
  }, [reportValidity, configKey, invalidEditDraft]);

  return (
    <Field label={label} hint={hint}>
      <textarea
        className={`${inputClass} min-h-32`}
        value={value}
        aria-invalid={error ? true : undefined}
        onChange={(e) => {
          const next = e.target.value;
          if (isCreate) {
            set?.({ [createKey]: next } as Partial<CreateConfigValues>);
            return;
          }
          setDraft(next);
          const trimmed = next.trim();
          if (!trimmed) {
            mark("adapterConfig", configKey, undefined);
            return;
          }
          if (jsonObjectDraftError(trimmed) === null) {
            mark("adapterConfig", configKey, JSON.parse(trimmed));
          }
        }}
        placeholder={placeholder}
      />
      {error && (
        <p className="mt-1 text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
    </Field>
  );
}
