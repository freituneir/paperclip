import { buildAdapterEnvConfig, type CreateConfigValues } from "@paperclipai/adapter-utils";

function parseCommaArgs(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function buildClaudeLocalConfig(v: CreateConfigValues): Record<string, unknown> {
  const ac: Record<string, unknown> = {};
  if (v.claudeEngine === "cli") ac.engine = "cli";
  if (v.claudeEngine === "acp") {
    ac.engine = "acp";
    if (v.claudeAcpAgentCommand) ac.agentCommand = v.claudeAcpAgentCommand;
    if (v.claudeAcpMode) ac.mode = v.claudeAcpMode;
    if (v.claudeAcpNonInteractivePermissions) {
      ac.nonInteractivePermissions = v.claudeAcpNonInteractivePermissions;
    }
    if (v.claudeAcpStateDir) ac.stateDir = v.claudeAcpStateDir;
    if (typeof v.claudeAcpWarmHandleIdleMs === "number") {
      ac.warmHandleIdleMs = v.claudeAcpWarmHandleIdleMs;
    }
  }
  if (v.cwd) ac.cwd = v.cwd;
  if (v.instructionsFilePath) ac.instructionsFilePath = v.instructionsFilePath;
  if (v.model) ac.model = v.model;
  if (v.thinkingEffort) ac.effort = v.thinkingEffort;
  if (v.chrome) ac.chrome = true;
  ac.timeoutSec = 0;
  ac.graceSec = 15;
  const env = buildAdapterEnvConfig(v.envBindings, v.envVars);
  if (Object.keys(env).length > 0) ac.env = env;
  ac.maxTurnsPerRun = v.maxTurnsPerRun;
  ac.dangerouslySkipPermissions = v.dangerouslySkipPermissions;
  if (v.workspaceStrategyType === "git_worktree") {
    ac.workspaceStrategy = {
      type: "git_worktree",
      ...(v.workspaceBaseRef ? { baseRef: v.workspaceBaseRef } : {}),
      ...(v.workspaceBranchTemplate ? { branchTemplate: v.workspaceBranchTemplate } : {}),
      ...(v.worktreeParentDir ? { worktreeParentDir: v.worktreeParentDir } : {}),
    };
  }
  const runtimeServices = parseJsonObject(v.runtimeServicesJson ?? "");
  if (runtimeServices && Array.isArray(runtimeServices.services)) {
    ac.workspaceRuntime = runtimeServices;
  }
  if (v.command) ac.command = v.command;
  if (v.extraArgs) ac.extraArgs = parseCommaArgs(v.extraArgs);
  // Native Claude Code options. Defaults ("company" home, native MCP enabled,
  // Paperclip permission default) are omitted so the runtime default applies.
  if (v.claudeHome === "isolated") ac.claudeHome = "isolated";
  if (v.claudeNativeMcp === "disabled") ac.nativeMcp = "disabled";
  const permissionMode = v.claudePermissionMode?.trim();
  if (permissionMode) ac.claudePermissionMode = permissionMode;
  const fallbackModel = v.claudeFallbackModel?.trim();
  if (fallbackModel) ac.fallbackModel = fallbackModel;
  if (v.claudePermissionBridge === "off") ac.permissionBridge = "off";
  const permissionWaitSec = v.claudePermissionWaitSec;
  if (
    typeof permissionWaitSec === "number" &&
    Number.isFinite(permissionWaitSec) &&
    permissionWaitSec > 0 &&
    permissionWaitSec !== 600
  ) {
    ac.permissionWaitSec = Math.floor(permissionWaitSec);
  }
  const allowedTools = parseCommaArgs(v.claudeAllowedTools ?? "");
  if (allowedTools.length > 0) ac.allowedTools = allowedTools;
  const disallowedTools = parseCommaArgs(v.claudeDisallowedTools ?? "");
  if (disallowedTools.length > 0) ac.disallowedTools = disallowedTools;
  const settingsOverlay = parseJsonObject(v.claudeSettingsOverlayJson ?? "");
  if (settingsOverlay && Object.keys(settingsOverlay).length > 0) ac.settingsOverlay = settingsOverlay;
  return ac;
}
