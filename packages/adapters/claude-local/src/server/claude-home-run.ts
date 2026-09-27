import type { AdapterExecutionResult } from "@paperclipai/adapter-utils";
import type { ClaudeHomeInventory } from "@paperclipai/shared";
import {
  claudeConfigDirHasCredentialsFile,
  ensureClaudeHomeDir,
  findHomeAuthConflicts,
  findProjectSettingsAuthConflicts,
  readClaudeHomeInventory,
  resolveClaudeHomeDir,
} from "./claude-home.js";
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

/** Env keys that authenticate Claude without a file-based login. */
const CLAUDE_AUTH_ENV_KEYS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"] as const;

function hasAuthEnv(env: Record<string, unknown>): boolean {
  return CLAUDE_AUTH_ENV_KEYS.some((key) => {
    const value = env[key];
    return typeof value === "string" && value.trim().length > 0;
  });
}

export function claudeHomeNoLoginWarning(homeDir: string): string {
  return `Claude Home has no login. Run \`CLAUDE_CONFIG_DIR='${homeDir}' claude\` and /login once, use a managed AI connection, or set claudeHome to isolated.`;
}

/**
 * Activate the Claude Home for a run: create it, read its inventory, warn when
 * it has no login (host credentials are never copied in: forking OAuth refresh
 * tokens can log the host out when they rotate), and refuse a managed-connection
 * run whose home settings, project settings (`<cwd>/.claude/settings*.json`,
 * loaded with the home), or settings overlay would override the selected
 * connection's auth. The caller points CLAUDE_CONFIG_DIR at `homeDir`.
 */
export async function prepareClaudeHomeRun(
  input: ClaudeHomeActivationInput & {
    companyId: string;
    /** The run's local cwd; its project settings are checked for auth conflicts. */
    cwd?: string | null;
    /** The env the Claude process will see (host env + agent env). */
    runEnv?: Record<string, unknown>;
    onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  },
): Promise<ClaudeHomeRunPreparation> {
  const activation = resolveClaudeHomeActivation(input);
  const warnings = [...activation.warnings];
  let homeDir: string | null = null;
  let inventory: ClaudeHomeInventory | null = null;
  if (activation.active) {
    homeDir = resolveClaudeHomeDir(process.env, input.companyId);
    await ensureClaudeHomeDir(homeDir);
    inventory = await readClaudeHomeInventory(homeDir);
    if (
      !input.managedAiConnection
      && !hasAuthEnv(input.runEnv ?? {})
      && !(await claudeConfigDirHasCredentialsFile(homeDir))
    ) {
      const warning = claudeHomeNoLoginWarning(homeDir);
      await input.onLog("stderr", `[paperclip] ${warning}\n`);
      warnings.push(warning);
    }
  }
  let failure: ClaudeHomeRunPreparation["failure"] = null;
  if (input.managedAiConnection) {
    const homeConflicts = findHomeAuthConflicts(inventory?.settings ?? null);
    const projectConflicts = activation.active && input.cwd
      ? await findProjectSettingsAuthConflicts(input.cwd)
      : [];
    const overlayConflicts = findHomeAuthConflicts(input.native.settingsOverlay);
    let errorMessage: string | null = null;
    if (homeConflicts.length > 0) {
      errorMessage = `Claude Home settings.json defines ${homeConflicts.join(", ")}, which would override the selected AI connection. Remove them in Claude Home.`;
    } else if (projectConflicts.length > 0) {
      const { file, conflicts } = projectConflicts[0]!;
      errorMessage = `Project settings ${file} defines ${conflicts.join(", ")}, which would override the selected AI connection. Remove them from the project settings or set claudeHome to isolated.`;
    } else if (overlayConflicts.length > 0) {
      errorMessage = `The agent settings overlay defines ${overlayConflicts.join(", ")}, which would override the selected AI connection. Remove them from the agent configuration.`;
    }
    if (errorMessage) {
      await input.onLog("stderr", `[paperclip] ${errorMessage}\n`);
      failure = { errorCode: "ai_connection_incompatible", errorMessage };
    }
  }
  return { active: activation.active, homeDir, inventory, warnings, failure };
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
