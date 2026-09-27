import { describe, expect, it } from "vitest";
import {
  buildClaudeCliNativeArgs,
  buildClaudeSdkOptions,
  extraArgsToSdkRecord,
  parseClaudeNativeOptions,
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
    });
    expect(parseClaudeNativeOptions({ claudePermissionMode: "plan" }).permissionMode).toBe("plan");
    expect(parseClaudeNativeOptions({ claudeHome: "bogus", settingsOverlay: {} })).toMatchObject({
      claudeHome: "company",
      settingsOverlay: null,
    });
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
