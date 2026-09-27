import { describe, expect, it } from "vitest";
import {
  buildClaudeCliNativeArgs,
  buildClaudeSdkOptions,
  extraArgsToSdkRecord,
  parseClaudeNativeOptions,
  parseExtraArgsForSdk,
  settingsOverlayWithPermission,
} from "./native-options.js";

describe("parseClaudeNativeOptions", () => {
  it("defaults to the company Claude Home with native MCP enabled", () => {
    expect(parseClaudeNativeOptions({})).toEqual({
      claudeHome: "company",
      nativeMcp: "enabled",
      permissionMode: null,
      fallbackModel: null,
      allowedTools: [],
      disallowedTools: [],
      settingsOverlay: null,
      permissionBridge: "task_chat",
      permissionWaitSec: 600,
    });
  });

  it("reads explicit values and ignores an invalid permission mode", () => {
    const parsed = parseClaudeNativeOptions({
      claudeHome: "isolated",
      nativeMcp: "disabled",
      claudePermissionMode: "yolo",
      fallbackModel: "  claude-sonnet-5 ",
      allowedTools: ["Read", " ", "Bash(git log:*)"],
      disallowedTools: "WebFetch, WebSearch",
      settingsOverlay: { model: "opus" },
    });
    expect(parsed).toEqual({
      claudeHome: "isolated",
      nativeMcp: "disabled",
      permissionMode: null,
      fallbackModel: "claude-sonnet-5",
      allowedTools: ["Read", "Bash(git log:*)"],
      disallowedTools: ["WebFetch", "WebSearch"],
      settingsOverlay: { model: "opus" },
      permissionBridge: "task_chat",
      permissionWaitSec: 600,
    });
    expect(parseClaudeNativeOptions({ claudePermissionMode: "plan" }).permissionMode).toBe("plan");
    expect(parseClaudeNativeOptions({ claudeHome: "bogus", settingsOverlay: {} })).toMatchObject({
      claudeHome: "company",
      settingsOverlay: null,
    });
  });

  it("parses the permission bridge and clamps the wait", () => {
    expect(parseClaudeNativeOptions({ permissionBridge: "off" }).permissionBridge).toBe("off");
    expect(parseClaudeNativeOptions({ permissionBridge: "bogus" }).permissionBridge).toBe("task_chat");
    expect(parseClaudeNativeOptions({ permissionWaitSec: 1 }).permissionWaitSec).toBe(10);
    expect(parseClaudeNativeOptions({ permissionWaitSec: 999_999 }).permissionWaitSec).toBe(86_400);
    expect(parseClaudeNativeOptions({ permissionWaitSec: "90.7" }).permissionWaitSec).toBe(90);
    expect(parseClaudeNativeOptions({ permissionWaitSec: "x" }).permissionWaitSec).toBe(600);
  });
});

describe("extraArgsToSdkRecord", () => {
  it("converts CLI flags into an SDK extraArgs record", () => {
    expect(extraArgsToSdkRecord(["--foo", "bar", "--baz", "--q=1"])).toEqual({ foo: "bar", baz: null, q: "1" });
  });

  it("ignores stray positional values", () => {
    expect(extraArgsToSdkRecord(["stray", "--flag"])).toEqual({ flag: null });
  });
});

describe("parseExtraArgsForSdk", () => {
  it("parses --flag value, --flag=value and bare --flag without warnings", () => {
    expect(parseExtraArgsForSdk(["--foo", "bar", "--baz", "--q=1"])).toEqual({
      record: { foo: "bar", baz: null, q: "1" },
      warnings: [],
    });
  });

  it("warns instead of silently dropping a flag followed by 2+ values", () => {
    const parsed = parseExtraArgsForSdk(["--allowedTools", "Read", "Write", "--verbose"]);
    expect(parsed.record).toEqual({ allowedTools: "Read", verbose: null });
    expect(parsed.warnings).toEqual([
      'extraArgs: --allowedTools is followed by 2 values (Read, Write); the ACP engine passes only one value per flag, so "Write" was ignored. Use --flag=value or a single value.',
    ]);
  });

  it("warns about positional values that do not follow a flag", () => {
    expect(parseExtraArgsForSdk(["stray", "--flag"]).warnings).toEqual([
      'extraArgs: "stray" does not follow a flag and was ignored on the ACP engine.',
    ]);
  });
});

describe("buildClaudeCliNativeArgs", () => {
  it("returns nothing for defaults without an active home", () => {
    expect(buildClaudeCliNativeArgs(parseClaudeNativeOptions({}), { settingsFilePath: null, homeActive: false })).toEqual([]);
  });

  it("emits flags in a stable order", () => {
    const options = parseClaudeNativeOptions({
      claudePermissionMode: "acceptEdits",
      fallbackModel: "claude-sonnet-5",
      allowedTools: ["Read", "Edit"],
      disallowedTools: ["WebFetch"],
    });
    expect(buildClaudeCliNativeArgs(options, { settingsFilePath: "/tmp/run/settings.json", homeActive: true })).toEqual([
      "--setting-sources", "user,project,local",
      "--settings", "/tmp/run/settings.json",
      "--fallback-model", "claude-sonnet-5",
      "--permission-mode", "acceptEdits",
      "--allowedTools", "Read", "Edit",
      "--disallowedTools", "WebFetch",
    ]);
  });
});

describe("settingsOverlayWithPermission", () => {
  it("merges the permission mode into the overlay permissions", () => {
    const options = parseClaudeNativeOptions({
      claudePermissionMode: "dontAsk",
      settingsOverlay: { permissions: { allow: ["Read"] }, model: "opus" },
    });
    expect(settingsOverlayWithPermission(options)).toEqual({
      permissions: { allow: ["Read"], defaultMode: "dontAsk" },
      model: "opus",
    });
  });

  it("returns null when there is nothing to overlay", () => {
    expect(settingsOverlayWithPermission(parseClaudeNativeOptions({}))).toBeNull();
  });
});

describe("buildClaudeSdkOptions", () => {
  it("is empty for defaults without an active home", () => {
    expect(buildClaudeSdkOptions(parseClaudeNativeOptions({}), { homeActive: false, hasPaperclipMcp: false, extraArgs: [] })).toEqual({});
  });

  it("sets strictMcpConfig when native MCP is disabled and Paperclip MCP exists", () => {
    const options = parseClaudeNativeOptions({ nativeMcp: "disabled" });
    expect(buildClaudeSdkOptions(options, { homeActive: true, hasPaperclipMcp: true, extraArgs: [] })).toMatchObject({
      strictMcpConfig: true,
    });
  });

  it("does not set strictMcpConfig when native MCP is enabled on an active home", () => {
    const options = parseClaudeNativeOptions({});
    expect(buildClaudeSdkOptions(options, { homeActive: true, hasPaperclipMcp: true, extraArgs: [] }).strictMcpConfig).toBeUndefined();
  });

  it("loads user, project, and local settings with an active home", () => {
    expect(buildClaudeSdkOptions(parseClaudeNativeOptions({}), { homeActive: true, hasPaperclipMcp: false, extraArgs: [] })).toEqual({
      settingSources: ["user", "project", "local"],
    });
  });

  it("puts the permission mode into settings and carries the other options", () => {
    const options = parseClaudeNativeOptions({
      claudePermissionMode: "plan",
      settingsOverlay: { env: { FOO: "1" } },
      fallbackModel: "claude-haiku-4-5",
      allowedTools: ["Read"],
      disallowedTools: ["Bash"],
    });
    expect(buildClaudeSdkOptions(options, { homeActive: true, hasPaperclipMcp: false, extraArgs: ["--foo", "1"] })).toEqual({
      settingSources: ["user", "project", "local"],
      settings: { env: { FOO: "1" }, permissions: { defaultMode: "plan" } },
      fallbackModel: "claude-haiku-4-5",
      allowedTools: ["Read"],
      disallowedTools: ["Bash"],
      extraArgs: { foo: "1" },
    });
  });
});
