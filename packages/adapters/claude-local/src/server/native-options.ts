import { asString, parseObject } from "@paperclipai/adapter-utils/server-utils";
import {
  CLAUDE_PERMISSION_MODES,
  type ClaudePermissionBridgeMode,
  type ClaudeHomeMode,
  type ClaudeNativeMcpMode,
  type ClaudePermissionMode,
} from "@paperclipai/shared";

/**
 * Native Claude Code options that Paperclip passes through to both engines.
 * The CLI lane turns them into flags; the ACP lane turns them into SDK options.
 */
export interface ClaudeNativeOptions {
  claudeHome: ClaudeHomeMode;
  nativeMcp: ClaudeNativeMcpMode;
  permissionMode: ClaudePermissionMode | null;
  fallbackModel: string | null;
  allowedTools: string[];
  disallowedTools: string[];
  settingsOverlay: Record<string, unknown> | null;
  /** Route Claude Code `ask` rules to Paperclip approval cards (ACP engine only). */
  permissionBridge: ClaudePermissionBridgeMode;
  /** How long one approval card may hold the tool call, in seconds. */
  permissionWaitSec: number;
}

export const DEFAULT_CLAUDE_PERMISSION_WAIT_SEC = 600;
export const MIN_CLAUDE_PERMISSION_WAIT_SEC = 10;
export const MAX_CLAUDE_PERMISSION_WAIT_SEC = 86_400;

/** Integer seconds, default 600, clamped to 10..86400. */
export function parseClaudePermissionWaitSec(value: unknown): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim().length > 0
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(parsed)) return DEFAULT_CLAUDE_PERMISSION_WAIT_SEC;
  return Math.min(MAX_CLAUDE_PERMISSION_WAIT_SEC, Math.max(MIN_CLAUDE_PERMISSION_WAIT_SEC, Math.trunc(parsed)));
}

export const CLAUDE_HOME_SETTING_SOURCES = ["user", "project", "local"] as const;

function isClaudePermissionMode(value: unknown): value is ClaudePermissionMode {
  return typeof value === "string" && (CLAUDE_PERMISSION_MODES as readonly string[]).includes(value);
}

/** Accept a string[] or a comma/newline separated string. */
function parseToolList(value: unknown): string[] {
  const raw = Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : typeof value === "string"
      ? value.split(/[,\n]/)
      : [];
  return raw.map((item) => item.trim()).filter((item) => item.length > 0);
}

export function parseClaudeNativeOptions(config: Record<string, unknown>): ClaudeNativeOptions {
  const permissionMode = asString(config.claudePermissionMode, "").trim();
  const fallbackModel = asString(config.fallbackModel, "").trim();
  const overlay = parseObject(config.settingsOverlay);
  return {
    claudeHome: config.claudeHome === "isolated" ? "isolated" : "company",
    nativeMcp: config.nativeMcp === "disabled" ? "disabled" : "enabled",
    permissionMode: isClaudePermissionMode(permissionMode) ? permissionMode : null,
    fallbackModel: fallbackModel || null,
    allowedTools: parseToolList(config.allowedTools),
    disallowedTools: parseToolList(config.disallowedTools),
    settingsOverlay: Object.keys(overlay).length > 0 ? overlay : null,
    permissionBridge: config.permissionBridge === "off" ? "off" : "task_chat",
    permissionWaitSec: parseClaudePermissionWaitSec(config.permissionWaitSec),
  };
}

/** The settings overlay with `permissions.defaultMode` set from the permission mode, or null when empty. */
export function settingsOverlayWithPermission(o: ClaudeNativeOptions): Record<string, unknown> | null {
  const overlay: Record<string, unknown> = { ...(o.settingsOverlay ?? {}) };
  if (o.permissionMode) {
    overlay.permissions = { ...parseObject(overlay.permissions), defaultMode: o.permissionMode };
  }
  return Object.keys(overlay).length > 0 ? overlay : null;
}

/** CLI flags for the native options. Order is stable. */
export function buildClaudeCliNativeArgs(
  o: ClaudeNativeOptions,
  input: { settingsFilePath: string | null; homeActive: boolean },
): string[] {
  const args: string[] = [];
  if (input.homeActive) args.push("--setting-sources", CLAUDE_HOME_SETTING_SOURCES.join(","));
  if (input.settingsFilePath) args.push("--settings", input.settingsFilePath);
  if (o.fallbackModel) args.push("--fallback-model", o.fallbackModel);
  if (o.permissionMode) args.push("--permission-mode", o.permissionMode);
  if (o.allowedTools.length > 0) args.push("--allowedTools", ...o.allowedTools);
  if (o.disallowedTools.length > 0) args.push("--disallowedTools", ...o.disallowedTools);
  return args;
}

/**
 * Parse CLI-style extra args into the SDK `extraArgs` record. Supported shapes:
 * `--flag value`, `--flag=value`, and bare `--flag`. Anything else (a flag
 * followed by 2+ values, or a value that follows no flag) cannot be expressed
 * in the record; those tokens are dropped and reported in `warnings`.
 */
export function parseExtraArgsForSdk(args: string[]): {
  record: Record<string, string | null>;
  warnings: string[];
} {
  const record: Record<string, string | null> = {};
  const warnings: string[] = [];
  const isFlag = (value: string | undefined) => value !== undefined && value.startsWith("-");
  let index = 0;
  while (index < args.length) {
    const arg = args[index]!;
    index += 1;
    const flag = isFlag(arg) ? arg.replace(/^-+/, "") : "";
    if (!flag) {
      warnings.push(`extraArgs: ${JSON.stringify(arg)} does not follow a flag and was ignored on the ACP engine.`);
      continue;
    }
    const equals = flag.indexOf("=");
    if (equals >= 0) {
      record[flag.slice(0, equals)] = flag.slice(equals + 1);
      continue;
    }
    const values: string[] = [];
    while (index < args.length && !isFlag(args[index])) {
      values.push(args[index]!);
      index += 1;
    }
    record[flag] = values[0] ?? null;
    if (values.length > 1) {
      const dropped = values.slice(1).map((value) => JSON.stringify(value)).join(", ");
      warnings.push(
        `extraArgs: ${arg} is followed by ${values.length} values (${values.join(", ")}); the ACP engine passes only one value per flag, so ${dropped} ${values.length === 2 ? "was" : "were"} ignored. Use --flag=value or a single value.`,
      );
    }
  }
  return { record, warnings };
}

/** ["--foo","bar","--baz","--q=1"] -> { foo: "bar", baz: null, q: "1" }. See `parseExtraArgsForSdk`. */
export function extraArgsToSdkRecord(args: string[]): Record<string, string | null> {
  return parseExtraArgsForSdk(args).record;
}

/**
 * Claude Agent SDK options for the ACP lane. `strictMcpConfig` mirrors the CLI
 * lane: strict when native MCP is disabled, or when Paperclip MCP servers exist
 * and the Claude Home is not active (legacy behavior).
 */
export function buildClaudeSdkOptions(
  o: ClaudeNativeOptions,
  input: { homeActive: boolean; hasPaperclipMcp: boolean; extraArgs: string[] },
): Record<string, unknown> {
  const options: Record<string, unknown> = {};
  if (input.homeActive) options.settingSources = [...CLAUDE_HOME_SETTING_SOURCES];
  const settings = settingsOverlayWithPermission(o);
  if (settings) options.settings = settings;
  if (o.nativeMcp === "disabled" || (input.hasPaperclipMcp && !input.homeActive)) {
    options.strictMcpConfig = true;
  }
  if (o.fallbackModel) options.fallbackModel = o.fallbackModel;
  if (o.allowedTools.length > 0) options.allowedTools = [...o.allowedTools];
  if (o.disallowedTools.length > 0) options.disallowedTools = [...o.disallowedTools];
  const extraArgs = extraArgsToSdkRecord(input.extraArgs);
  if (Object.keys(extraArgs).length > 0) options.extraArgs = extraArgs;
  return options;
}

export const CLI_ASK_RULES_DENIED_WARNING =
  "Claude `ask` rules are denied on the CLI engine; use the ACP engine for approval cards.";

/** True when any given settings object has a non-empty `permissions.ask` list. */
export function hasClaudeAskRules(...settings: Array<Record<string, unknown> | null | undefined>): boolean {
  return settings.some((entry) => {
    const ask = parseObject(parseObject(entry).permissions).ask;
    return Array.isArray(ask) && ask.some((rule) => typeof rule === "string" && rule.trim().length > 0);
  });
}
