# Claude Code transparency: full Claude Code + Paperclip orchestration

Status: design (homelab fork `freituneir/paperclip`, branch `claude-transparency`)
Date: 2026-09-27

## 1. Intent

The operator wants Paperclip agents to be **full Claude Code with extra
orchestration**, not a thinner harness. Native Claude Code features (MCP
servers, plugins, skills, subagents, slash commands, hooks, settings, model and
effort selection, permission modes) must be usable through Paperclip, and the UI
must make it obvious whether a capability comes from **Claude Code** (native,
ungoverned by Paperclip) or from **Paperclip** (gateway-governed: approvals,
audit, vault credentials).

Decisions already made with the operator:

- Native config lives **on the Paperclip host** (homelab), not the operator's
  laptop. No laptop sync.
- Native MCP servers are **allowed and clearly labeled** as ungoverned; a
  per-agent switch can turn them off (Paperclip-only).
- One **shared company Claude Home** plus a **per-agent overlay**.

## 2. What is wrong today (root causes)

| Area | Today |
|---|---|
| Config dir | Managed AI connections (`prepareManagedAiRuntime`) give every run a fresh `mkdtemp` `HOME` and an empty `CLAUDE_CONFIG_DIR`. No native config can load; sessions are thrown away with the temp dir. |
| ACP user settings | `acpx` sends `settingSources: ["project","local"]` to `claude-agent-acp`, so **user** settings, CLAUDE.md, plugins, skills, agents and user MCP servers are ignored on the default engine. |
| CLI MCP | `--strict-mcp-config` whenever any Paperclip MCP server exists, which drops every native MCP server. |
| Controls | Hardcoded model list; effort only low/medium/high; no permission mode, fallback model, allowed/disallowed tools, or settings overlay; `extraArgs` ignored on ACP. |
| Visibility | Runs record only argv/env/notes. Nothing shows which MCP servers, plugins, skills, or settings sources a run actually had, or where each came from. |

Verified: with `CLAUDE_CONFIG_DIR=X`, Claude Code reads user MCP servers from
`X/.claude.json` (tested with CLI 2.1.283). A single directory is a complete
Claude Home.

## 3. Design

### 3.1 Claude Home (company-scoped, persistent)

- Directory: `$PAPERCLIP_CLAUDE_HOME_ROOT/<companyId>` if the env var is set,
  else `<instanceRoot>/companies/<companyId>/claude-home`. The instance root is
  already on the persistent volume in Docker deployments.
- It is a normal `CLAUDE_CONFIG_DIR`: `settings.json`, `CLAUDE.md`,
  `.claude.json` (user MCP servers), `plugins/`, `skills/`, `agents/`,
  `commands/`, `projects/` (session transcripts).
- **The real `claude` CLI is the power editor.** The UI shows a copyable
  command that opens Claude Code against the home
  (`CLAUDE_CONFIG_DIR=<dir> claude`), so `claude mcp add`, `/plugin install`,
  and OAuth MCP logins all work natively. Paperclip does not re-implement them.
- Resolution lives in the adapter package (`resolveClaudeHomeDir`), and the
  server imports it, so there is one source of truth.

### 3.2 Adapter (claude_local): new config fields

| Field | Values (default) | CLI lane | ACP lane |
|---|---|---|---|
| `claudeHome` | `"company"` (default) \| `"isolated"` | `CLAUDE_CONFIG_DIR=<home>`, `--setting-sources user,project,local` | same env + SDK `settingSources` |
| `nativeMcp` | `"enabled"` (default) \| `"disabled"` | no `--strict-mcp-config` unless disabled | SDK `strictMcpConfig` when disabled |
| `claudePermissionMode` | `""` (legacy behavior) \| `bypassPermissions` \| `auto` \| `acceptEdits` \| `dontAsk` \| `plan` \| `manual` | `--permission-mode` (replaces `--dangerously-skip-permissions`) | settings overlay `permissions.defaultMode` |
| `fallbackModel` | string | `--fallback-model` | SDK `fallbackModel` |
| `allowedTools` / `disallowedTools` | string[] | `--allowedTools` / `--disallowedTools` | SDK options |
| `settingsOverlay` | object | `--settings <run file>` | SDK `settings` (flag tier) |
| `effort` | adds `xhigh`, `max` | `--effort` | `session/set_config_option` (unchanged path) |
| `extraArgs` | now honored on ACP | unchanged | converted to SDK `extraArgs` record |

`"isolated"` keeps today's behavior exactly. `claudeHome` only applies to local
execution targets. Remote/sandbox targets keep their seed path, which is out of
scope.

**ACP plumbing.** The Claude adapter serializes the SDK options above into the
env var `PAPERCLIP_CLAUDE_SDK_OPTIONS_JSON` on the ACP agent process. The
existing `claude-agent-acp` patch is extended to merge those options after
`acpx`'s `_meta` options, so they win over acpx's `settingSources`. The
ACP-controlled fields (`cwd`, `mcpServers`, `canUseTool`, hooks) stay controlled
by ACP. The patch is applied in the one options builder used by both new and
resumed sessions.

**Managed AI connection safety.** With a managed connection, the credential
arrives through env (`CLAUDE_CODE_OAUTH_TOKEN` and similar). If the Claude
Home's `settings.json` defines `apiKeyHelper` or auth env keys, the run fails
with a clear `ai_connection_incompatible` message. This mirrors the existing
project-settings check and stops a home setting from silently hijacking billing.

### 3.3 Launch manifest (per run) and effective setup (per agent)

A pure function `buildClaudeLaunchManifest()` in the adapter produces:

```
{ version: 1, engine, model, fallbackModel, effort, permission: {mode, source},
  claudeHome: {mode, dir}, settingSources, settingsOverlayKeys,
  nativeMcp, mcpServers: [{name, origin, transport, target, governed}],
  plugins, skills: {paperclip, native}, subagents, commands, hooks,
  instructions: {path, delivery}, allowedTools, disallowedTools, extraArgs,
  warnings }
```

- `origin` is one of `paperclip` / `claude_home` / `project` (workspace
  `.mcp.json`) / `plugin`. `governed` is true only for `paperclip`.
- Secrets never appear: header and env values are dropped and only key names
  are kept. URLs have their query strings stripped.
- It is attached to `AdapterInvocationMeta.launchManifest`, which is persisted
  with the existing `adapter.invoke` run event. That is a run-log change, so no
  telemetry review is needed. On ACP, the Claude executor wraps `onMeta` to add
  it.
- Server: `GET /api/companies/:companyId/agents/:agentId/claude-setup` returns
  the same manifest computed **before** a run from the agent config plus the
  Claude Home inventory, with the Paperclip section built from the agent's
  installed connections.

### 3.4 Claude Home inventory and editing API (board-only, company-scoped)

- `GET  /api/companies/:companyId/claude-home` returns the inventory: dir,
  exists, `settings` (JSON, with secrets redacted), `claudeMd`, `mcpServers`
  (redacted), `plugins` (from `plugins/installed_plugins.json` +
  `enabledPlugins`), `skills`, `agents`, `commands`, `hooks` (event names +
  counts), and a `cliCommand` hint.
- `PUT  /api/companies/:companyId/claude-home/settings` accepts a JSON body
  (validated object). Redacted placeholders are merged back from disk so a
  round-trip never erases secrets.
- `PUT  /api/companies/:companyId/claude-home/claude-md` accepts text.
- `PUT  /api/companies/:companyId/claude-home/mcp-servers/:name` upserts a
  server in `.claude.json` (http/sse/stdio). It preserves the other keys in the
  file and restores redacted values.
- `DELETE /api/companies/:companyId/claude-home/mcp-servers/:name`
- Every mutation writes an activity-log entry. Writes are atomic (temp file +
  rename).

### 3.5 UI

1. **Claude Home page** (`/claude-home`, in the sidebar near Apps). Sections:
   Location + "Open in Claude Code" command; MCP servers (add/edit/remove, each
   badged **Claude Code**); Settings JSON editor; CLAUDE.md editor; read-only
   Plugins, Skills, Subagents, Slash commands, Hooks.
2. **Agent config (Claude Code section)**: Claude Home mode, Native MCP toggle,
   permission mode, fallback model, allowed/disallowed tools, settings overlay
   JSON, and effort with xhigh/max.
3. **Agent "Tools" tab**: a new **Effective setup** panel that lists every MCP
   server the agent will get, badged `Claude Code · not governed` or
   `Paperclip · governed`, plus plugins/skills/subagents with origin.
4. **Run page**: a **Launch manifest** card above the invocation details, with
   model / effort / permission chips and the MCP list with origin badges.
5. **Apps page**: a notice that N native Claude Code MCP servers are also
   available, linking to Claude Home.

### 3.6 Follow-on slices in this branch

- **C. Adopt into Paperclip.** A button on a native http/sse server in Claude
  Home posts it to the existing MCP import endpoint and turns it into a
  governed Paperclip connection. The native copy can then be removed.
- **D. Take over.** The run page shows a copyable
  `CLAUDE_CONFIG_DIR=<home> claude --resume <sessionId>` (with the cwd) when
  the run used the company Claude Home. This works because sessions now persist.
- **E. Transcript fidelity.** TodoWrite renders as a checklist, and subagent
  (Task/Agent) tool calls show their description and subagent type. This
  improves existing renderers and adds no new event types.
- **Model list.** Add current models (`claude-opus-5-5`, `claude-sonnet-5`,
  `claude-fable-5-1`, `claude-haiku-4-5`), the aliases (`opus`, `sonnet`,
  `haiku`, `opusplan`) and `[1m]` variants.

## 4. Risks

- **Ungoverned tools.** Native MCP servers bypass Paperclip approvals by design.
  They are labeled everywhere and can be disabled per agent. The agents still
  share the Paperclip container (the operator parked this).
- **Concurrent writers.** Several agents share one `.claude.json`. Claude Code
  already tolerates concurrent sessions in one config dir. The API writes
  atomically.
- **Behavior change.** `claudeHome` defaults to `company`. Existing agents gain
  native config after upgrade, which is the intended fork behavior.
  `"isolated"` restores the old behavior.
- **Patch maintenance.** The `claude-agent-acp` patch grows by one merge point.

## 5. Testing

- Unit: manifest builder (origins, redaction), CLI arg builder (strict/native,
  permission mode, settings file, fallback), ACP SDK-options env serialization,
  Claude Home service (inventory parse, redaction round-trip, atomic writes,
  MCP upsert/delete), route auth (board-only, company scope).
- UI: component tests for the manifest card and origin badges (Vitest + RTL, as
  the repo does).
- Gates: targeted Vitest, `pnpm -r typecheck`, `pnpm check:token-gates`, build.
