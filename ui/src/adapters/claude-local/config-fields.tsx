import { configFieldsForSection } from "../config-sections";
import type { AdapterConfigFieldsProps, AdapterConfigSection } from "../types";
import {
  Field,
  ToggleField,
  DraftInput,
  DraftNumberInput,
  help,
} from "../../components/agent-config-primitives";
import { ChoosePathButton } from "../../components/PathInstructionsModal";
import { LocalWorkspaceRuntimeFields } from "../local-workspace-runtime-fields";
import { JsonObjectConfigField } from "../runtime-json-fields";
import { CLAUDE_PERMISSION_MODES, type ClaudePermissionMode } from "@paperclipai/shared";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";

const instructionsFileHint =
  "Absolute path to a markdown file (e.g. AGENTS.md) that defines this agent's behavior. Injected into the system prompt at runtime.";

export function ClaudeLocalConfigFields({
  section,
  mode,
  isCreate,
  adapterType,
  values,
  set,
  config,
  eff,
  mark,
  models,
  hideInstructionsFile,
}: AdapterConfigFieldsProps) {
  return configFieldsForSection(section, (
    <>
      {!hideInstructionsFile && (
        <Field label="Agent instructions file" hint={instructionsFileHint}>
          <div className="flex items-center gap-2">
            <DraftInput
              value={
                isCreate
                  ? values!.instructionsFilePath ?? ""
                  : eff(
                      "adapterConfig",
                      "instructionsFilePath",
                      String(config.instructionsFilePath ?? ""),
                    )
              }
              onCommit={(v) =>
                isCreate
                  ? set!({ instructionsFilePath: v })
                  : mark("adapterConfig", "instructionsFilePath", v || undefined)
              }
              immediate
              className={inputClass}
              placeholder="/absolute/path/to/AGENTS.md"
            />
            <ChoosePathButton />
          </div>
        </Field>
      )}
      <LocalWorkspaceRuntimeFields
        isCreate={isCreate}
        values={values}
        set={set}
        config={config}
        mark={mark}
        eff={eff}
        mode={mode}
        adapterType={adapterType}
        models={models}
      />
    </>
  ));
}

const claudeHomeHelp =
  "Company: shares one persistent Claude Code config (MCP servers, plugins, skills, settings) across agents. Isolated: legacy per-run config.";
const nativeMcpHelp =
  "MCP servers configured in Claude Home run natively and are not governed by Paperclip approvals.";

const permissionModeLabels: Record<ClaudePermissionMode, string> = {
  bypassPermissions: "Bypass permissions",
  auto: "Auto",
  acceptEdits: "Accept edits",
  dontAsk: "Don't ask",
  plan: "Plan",
  manual: "Manual",
};

function formatToolList(value: unknown): string {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string").join(", ");
  }
  return typeof value === "string" ? value : "";
}

function parseToolList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function FieldHelp({ children }: { children: string }) {
  return <p className="mt-1 text-xs text-muted-foreground">{children}</p>;
}

const DEFAULT_PERMISSION_WAIT_SEC = 600;

const permissionBridgeHelp =
  "When Claude Code hits a permission rule that asks first, ask here in the task chat instead of auto-approving. ACP engine only.";

const permissionWaitHelp =
  "How long a run waits for an answer to an approval card. After that the request is denied and the card stays open; approving it lets the agent retry on its next run.";

type ToolListCreateKey = "claudeAllowedTools" | "claudeDisallowedTools";

/**
 * Native Claude Code options (Claude Home, native MCP, permission mode, tools,
 * settings overlay). Rendered as one child so the section partitioner keeps the
 * group together under its heading.
 */
function ClaudeCodeFields({
  isCreate,
  values,
  set,
  config,
  eff,
  mark,
}: AdapterConfigFieldsProps & { configSection?: AdapterConfigSection }) {
  const claudeHome = isCreate
    ? values!.claudeHome ?? "company"
    : eff<unknown>("adapterConfig", "claudeHome", config.claudeHome) === "isolated"
      ? "isolated"
      : "company";
  const nativeMcpEnabled = isCreate
    ? values!.claudeNativeMcp !== "disabled"
    : eff<unknown>("adapterConfig", "nativeMcp", config.nativeMcp) !== "disabled";
  const permissionMode = isCreate
    ? values!.claudePermissionMode ?? ""
    : String(eff<unknown>("adapterConfig", "claudePermissionMode", config.claudePermissionMode) ?? "");

  const permissionBridgeEnabled = isCreate
    ? values!.claudePermissionBridge !== "off"
    : eff<unknown>("adapterConfig", "permissionBridge", config.permissionBridge) !== "off";
  const storedWaitSec = isCreate
    ? values!.claudePermissionWaitSec
    : eff<unknown>("adapterConfig", "permissionWaitSec", config.permissionWaitSec);
  const permissionWaitSec =
    typeof storedWaitSec === "number" && Number.isFinite(storedWaitSec) && storedWaitSec > 0
      ? storedWaitSec
      : DEFAULT_PERMISSION_WAIT_SEC;

  const toolListField = (label: string, createKey: ToolListCreateKey, configKey: string, placeholder: string) => (
    <Field label={label} hint="Comma-separated Claude Code tool rules.">
      <DraftInput
        value={
          isCreate
            ? values![createKey] ?? ""
            : formatToolList(eff<unknown>("adapterConfig", configKey, config[configKey]))
        }
        onCommit={(v) => {
          if (isCreate) {
            set!({ [createKey]: v });
            return;
          }
          const tools = parseToolList(v);
          mark("adapterConfig", configKey, tools.length > 0 ? tools : undefined);
        }}
        className={inputClass}
        placeholder={placeholder}
      />
    </Field>
  );

  return (
    <div className="space-y-3 border-t border-border pt-3" data-testid="claude-code-fields">
      <h4 className="text-xs font-medium text-foreground">Claude Code</h4>
      <Field label="Claude Home">
        <select
          className={inputClass}
          value={claudeHome}
          onChange={(e) => {
            const value = e.target.value === "isolated" ? "isolated" : "company";
            isCreate
              ? set!({ claudeHome: value })
              : mark("adapterConfig", "claudeHome", value === "company" ? undefined : value);
          }}
        >
          <option value="company">Company (shared)</option>
          <option value="isolated">Isolated</option>
        </select>
        <FieldHelp>{claudeHomeHelp}</FieldHelp>
      </Field>
      <div>
        <ToggleField
          label="Native MCP servers"
          checked={nativeMcpEnabled}
          onChange={(v) =>
            isCreate
              ? set!({ claudeNativeMcp: v ? "enabled" : "disabled" })
              : mark("adapterConfig", "nativeMcp", v ? undefined : "disabled")
          }
        />
        <FieldHelp>{nativeMcpHelp}</FieldHelp>
      </div>
      <Field
        label="Permission mode"
        hint="Sets Claude Code's --permission-mode. On local runs it replaces the Skip permissions behavior."
      >
        <select
          className={inputClass}
          value={permissionMode}
          onChange={(e) => {
            const value = e.target.value;
            isCreate
              ? set!({ claudePermissionMode: value })
              : mark("adapterConfig", "claudePermissionMode", value || undefined);
          }}
        >
          <option value="">Paperclip default</option>
          {CLAUDE_PERMISSION_MODES.map((mode) => (
            <option key={mode} value={mode}>
              {permissionModeLabels[mode]}
            </option>
          ))}
        </select>
      </Field>
      <div>
        <ToggleField
          label="Approval cards for ask rules"
          toggleTestId="claude-permission-bridge-toggle"
          checked={permissionBridgeEnabled}
          onChange={(v) =>
            isCreate
              ? set!({ claudePermissionBridge: v ? "task_chat" : "off" })
              : mark("adapterConfig", "permissionBridge", v ? undefined : "off")
          }
        />
        <FieldHelp>{permissionBridgeHelp}</FieldHelp>
      </div>
      <Field label="Wait for an answer (seconds)" hint={permissionWaitHelp}>
        {isCreate ? (
          <input
            type="number"
            min={1}
            className={inputClass}
            value={permissionWaitSec}
            onChange={(e) => {
              const next = Number(e.target.value);
              set!({ claudePermissionWaitSec: Number.isFinite(next) && next > 0 ? next : undefined });
            }}
          />
        ) : (
          <DraftNumberInput
            value={permissionWaitSec}
            onCommit={(v) =>
              mark(
                "adapterConfig",
                "permissionWaitSec",
                v > 0 && v !== DEFAULT_PERMISSION_WAIT_SEC ? Math.floor(v) : undefined,
              )
            }
            immediate
            className={inputClass}
          />
        )}
      </Field>
      <Field label="Fallback model" hint="Model Claude Code switches to when the primary model is overloaded.">
        <DraftInput
          value={
            isCreate
              ? values!.claudeFallbackModel ?? ""
              : String(eff<unknown>("adapterConfig", "fallbackModel", config.fallbackModel) ?? "")
          }
          onCommit={(v) =>
            isCreate
              ? set!({ claudeFallbackModel: v })
              : mark("adapterConfig", "fallbackModel", v.trim() || undefined)
          }
          className={inputClass}
          placeholder="e.g. claude-sonnet-5"
        />
      </Field>
      {toolListField("Allowed tools", "claudeAllowedTools", "allowedTools", "e.g. Read, Bash(git:*)")}
      {toolListField("Disallowed tools", "claudeDisallowedTools", "disallowedTools", "e.g. WebFetch")}
      <JsonObjectConfigField
        isCreate={isCreate}
        values={values}
        set={set}
        config={config}
        mark={mark}
        label="Settings overlay JSON"
        hint="Claude Code settings merged over the Claude Home settings for this agent."
        createKey="claudeSettingsOverlayJson"
        configKey="settingsOverlay"
        placeholder={`{\n  "env": { "FOO": "1" }\n}`}
      />
      <FieldHelp>Extra args (Advanced) now apply to both the CLI and ACP engines.</FieldHelp>
    </div>
  );
}

export function ClaudeLocalAdvancedFields(props: AdapterConfigFieldsProps) {
  const {
    section,
    isCreate,
    values,
    set,
    config,
    eff,
    mark,
    managedSandboxOnly,
  } = props;
  const rawEngine = isCreate
    ? values!.claudeEngine ?? "auto"
    : eff("adapterConfig", "engine", String(config.engine ?? "auto"));
  const engine = rawEngine === "acp" || rawEngine === "cli" ? rawEngine : "auto";
  const acpSelected = engine === "acp";

  return configFieldsForSection(section, (
    <>
      {/*
        The execution engine picks which binary runs on the execution host, and
        the ACP sub-fields below name host paths. The platform-managed
        environment owns both, so the managed-sandbox-only policy hides them,
        the same way `runnerManaged` hides them for the Paperclip Runner.
      */}
      {!managedSandboxOnly && <Field label="Execution engine" hint="Default uses ACP. If ACP is unavailable, the run fails with a setup error. Choose CLI explicitly to use it.">
        <select
          className={inputClass}
          value={engine}
          onChange={(e) => {
            const value = e.target.value === "acp" ? "acp" : e.target.value === "cli" ? "cli" : "auto";
            isCreate
              ? set!({ claudeEngine: value })
              : mark("adapterConfig", "engine", value === "auto" ? undefined : value);
          }}
        >
          <option value="auto">Default (ACP)</option>
          <option value="cli">Claude CLI</option>
          <option value="acp">ACP</option>
        </select>
      </Field>}
      {acpSelected && (
        <>
          {!managedSandboxOnly && (
            <Field configSection="advanced"
              label="ACP server command"
              hint="Optional override for the Claude ACP server command. Defaults to the package-local claude-agent-acp binary."
            >
              <DraftInput
                value={
                  isCreate
                    ? values!.claudeAcpAgentCommand ?? ""
                    : eff("adapterConfig", "agentCommand", String(config.agentCommand ?? ""))
                }
                onCommit={(v) =>
                  isCreate
                    ? set!({ claudeAcpAgentCommand: v })
                    : mark("adapterConfig", "agentCommand", v || undefined)
                }
                immediate
                className={inputClass}
                placeholder="claude-agent-acp"
              />
            </Field>
          )}
          <Field configSection="runPolicy" label="ACP session mode" hint="Persistent keeps ACP session state between runs. One-shot starts fresh each run.">
            <select
              className={inputClass}
              value={
                isCreate
                  ? values!.claudeAcpMode ?? "persistent"
                  : eff("adapterConfig", "mode", String(config.mode ?? "persistent"))
              }
              onChange={(e) => {
                const value = e.target.value === "oneshot" ? "oneshot" : "persistent";
                isCreate
                  ? set!({ claudeAcpMode: value })
                  : mark("adapterConfig", "mode", value);
              }}
            >
              <option value="persistent">Persistent</option>
              <option value="oneshot">One-shot</option>
            </select>
          </Field>
          <Field
            label="ACP non-interactive permissions"
            hint="Fallback if the ACP agent asks for input outside an interactive session."
          >
            <select
              className={inputClass}
              value={
                isCreate
                  ? values!.claudeAcpNonInteractivePermissions ?? "deny"
                  : eff("adapterConfig", "nonInteractivePermissions", String(config.nonInteractivePermissions ?? "deny"))
              }
              onChange={(e) => {
                const value = e.target.value === "fail" ? "fail" : "deny";
                isCreate
                  ? set!({ claudeAcpNonInteractivePermissions: value })
                  : mark("adapterConfig", "nonInteractivePermissions", value);
              }}
            >
              <option value="deny">Deny</option>
              <option value="fail">Fail</option>
            </select>
          </Field>
          {!managedSandboxOnly && (
            <Field
              label="ACP state directory"
              hint="Optional ACP session state directory. Defaults to Paperclip-managed organization/agent scoped storage."
            >
              <div className="flex items-center gap-2">
                <DraftInput
                  value={
                    isCreate
                      ? values!.claudeAcpStateDir ?? ""
                      : eff("adapterConfig", "stateDir", String(config.stateDir ?? ""))
                  }
                  onCommit={(v) =>
                    isCreate
                      ? set!({ claudeAcpStateDir: v })
                      : mark("adapterConfig", "stateDir", v || undefined)
                  }
                  immediate
                  className={inputClass}
                  placeholder="/path/to/acp-state"
                />
                <ChoosePathButton />
              </div>
            </Field>
          )}
          <Field configSection="runPolicy"
            label="ACP warm process idle ms"
            hint="Defaults to 0, which closes the ACP process after each run while retaining persistent session state."
          >
            {isCreate ? (
              <input
                type="number"
                className={inputClass}
                value={values!.claudeAcpWarmHandleIdleMs ?? 0}
                onChange={(e) => set!({ claudeAcpWarmHandleIdleMs: Number(e.target.value) })}
              />
            ) : (
              <DraftNumberInput
                value={eff(
                  "adapterConfig",
                  "warmHandleIdleMs",
                  Number(config.warmHandleIdleMs ?? 0),
                )}
                onCommit={(v) => mark("adapterConfig", "warmHandleIdleMs", v || 0)}
                immediate
                className={inputClass}
              />
            )}
          </Field>
        </>
      )}
      <ToggleField
        label="Enable Chrome"
        hint={help.chrome}
        checked={
          isCreate
            ? values!.chrome
            : eff("adapterConfig", "chrome", config.chrome === true)
        }
        onChange={(v) =>
          isCreate
            ? set!({ chrome: v })
            : mark("adapterConfig", "chrome", v)
        }
      />
      <ToggleField
        label="Skip permissions"
        hint={help.dangerouslySkipPermissions}
        checked={
          isCreate
            ? values!.dangerouslySkipPermissions
            : eff(
                "adapterConfig",
                "dangerouslySkipPermissions",
                config.dangerouslySkipPermissions !== false,
              )
        }
        onChange={(v) =>
          isCreate
            ? set!({ dangerouslySkipPermissions: v })
            : mark("adapterConfig", "dangerouslySkipPermissions", v)
        }
      />
      <Field label="Max turns per run" hint={help.maxTurnsPerRun}>
        {isCreate ? (
          <input
            type="number"
            className={inputClass}
            value={values!.maxTurnsPerRun}
            onChange={(e) => set!({ maxTurnsPerRun: Number(e.target.value) })}
          />
        ) : (
          <DraftNumberInput
            value={eff(
              "adapterConfig",
              "maxTurnsPerRun",
              Number(config.maxTurnsPerRun ?? 1000),
            )}
            onCommit={(v) => mark("adapterConfig", "maxTurnsPerRun", v || 1000)}
            immediate
            className={inputClass}
          />
        )}
      </Field>
      <ClaudeCodeFields {...props} configSection="configuration" />
    </>
  ));
}
