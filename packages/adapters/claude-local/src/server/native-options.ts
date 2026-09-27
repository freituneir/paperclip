import { asString, parseObject } from "@paperclipai/adapter-utils/server-utils";
import {
  CLAUDE_PERMISSION_MODES,
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

/** ["--foo","bar","--baz","--q=1"] -> { foo: "bar", baz: null, q: "1" }. Stray positional values are ignored. */
export function extraArgsToSdkRecord(args: string[]): Record<string, string | null> {
  const record: Record<string, string | null> = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (!arg.startsWith("-")) continue;
    const flag = arg.replace(/^-+/, "");
    if (!flag) continue;
    const equals = flag.indexOf("=");
    if (equals >= 0) {
      record[flag.slice(0, equals)] = flag.slice(equals + 1);
      continue;
    }
    const next = args[index + 1];
    if (next !== undefined && !next.startsWith("-")) {
      record[flag] = next;
      index += 1;
    } else {
      record[flag] = null;
    }
  }
  return record;
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
