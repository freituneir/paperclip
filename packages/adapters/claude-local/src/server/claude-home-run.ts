import type { AdapterExecutionResult } from "@paperclipai/adapter-utils";
import type { ClaudeHomeInventory } from "@paperclipai/shared";
import {
  ensureClaudeHomeDir,
  findHomeAuthConflicts,
  readClaudeHomeInventory,
  resolveClaudeHomeDir,
  seedClaudeHomeCredentials,
} from "./claude-home.js";
import { resolveSharedClaudeConfigDir } from "./claude-config.js";
import type { ClaudeNativeOptions } from "./native-options.js";

/**
 * Run-time Claude Home rules shared by the CLI and ACP lanes.
 *
 * The company Claude Home is a persistent, company-scoped CLAUDE_CONFIG_DIR for
 * local targets. It wins over a managed AI connection's per-run config dir, but
 * an operator-set CLAUDE_CONFIG_DIR in the agent env is respected.
 */
export interface ClaudeHomeActivationInput {
  native: ClaudeNativeOptions;
  targetIsRemote: boolean;
  configEnv: Record<string, unknown>;
  managedAiConnection: boolean;
}

export interface ClaudeHomeActivation {
  active: boolean;
  warnings: string[];
}

function hasExplicitClaudeConfigDir(configEnv: Record<string, unknown>): boolean {
  const value = configEnv.CLAUDE_CONFIG_DIR;
  return typeof value === "string" && value.trim().length > 0;
}

export function resolveClaudeHomeActivation(input: ClaudeHomeActivationInput): ClaudeHomeActivation {
  const operatorClaudeConfigDir = hasExplicitClaudeConfigDir(input.configEnv) && !input.managedAiConnection;
  const wantsHome = input.native.claudeHome === "company";
  const warnings: string[] = [];
  if (wantsHome && input.targetIsRemote) {
    warnings.push("Claude Home applies only to local execution targets; this remote run uses its own Claude config.");
  } else if (wantsHome && operatorClaudeConfigDir) {
    warnings.push("CLAUDE_CONFIG_DIR is set in the agent env, so the company Claude Home was not applied.");
  }
  return { active: wantsHome && !input.targetIsRemote && !operatorClaudeConfigDir, warnings };
}

export interface ClaudeHomeRunPreparation {
  active: boolean;
  homeDir: string | null;
  inventory: ClaudeHomeInventory | null;
  warnings: string[];
  /** Set when the run must fail before spawn (already logged to stderr). */
  failure: { errorCode: "ai_connection_incompatible"; errorMessage: string } | null;
}

/**
 * Activate the Claude Home for a run: create it, carry the host login over
 * (only without a managed AI connection), read its inventory, and refuse a
 * managed-connection run whose home settings or settings overlay would
 * override the selected connection's auth. The caller points
 * CLAUDE_CONFIG_DIR at `homeDir`.
 */
export async function prepareClaudeHomeRun(
  input: ClaudeHomeActivationInput & {
    companyId: string;
    onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  },
): Promise<ClaudeHomeRunPreparation> {
  const activation = resolveClaudeHomeActivation(input);
  let homeDir: string | null = null;
  let inventory: ClaudeHomeInventory | null = null;
  if (activation.active) {
    homeDir = resolveClaudeHomeDir(process.env, input.companyId);
    await ensureClaudeHomeDir(homeDir);
    if (!input.managedAiConnection) {
      const sourceConfigDir = resolveSharedClaudeConfigDir(process.env);
      if (await seedClaudeHomeCredentials(homeDir, sourceConfigDir)) {
        await input.onLog("stdout", `[paperclip] Copied Claude login from ${sourceConfigDir} into Claude Home ${homeDir}.\n`);
      }
    }
    inventory = await readClaudeHomeInventory(homeDir);
  }
  let failure: ClaudeHomeRunPreparation["failure"] = null;
  if (input.managedAiConnection) {
    const homeConflicts = findHomeAuthConflicts(inventory?.settings ?? null);
    const overlayConflicts = findHomeAuthConflicts(input.native.settingsOverlay);
    if (homeConflicts.length > 0 || overlayConflicts.length > 0) {
      const errorMessage = homeConflicts.length > 0
        ? `Claude Home settings.json defines ${homeConflicts.join(", ")}, which would override the selected AI connection. Remove them in Claude Home.`
        : `The agent settings overlay defines ${overlayConflicts.join(", ")}, which would override the selected AI connection. Remove them from the agent configuration.`;
      await input.onLog("stderr", `[paperclip] ${errorMessage}\n`);
      failure = { errorCode: "ai_connection_incompatible", errorMessage };
    }
  }
  return { active: activation.active, homeDir, inventory, warnings: activation.warnings, failure };
}

/** The pre-spawn execution result for a `prepareClaudeHomeRun` failure. */
export function claudeHomeFailureResult(
  failure: NonNullable<ClaudeHomeRunPreparation["failure"]>,
): AdapterExecutionResult {
  return {
    exitCode: 1,
    signal: null,
    timedOut: false,
    errorCode: failure.errorCode,
    errorMessage: failure.errorMessage,
    resultJson: {
      executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
    },
  };
}
