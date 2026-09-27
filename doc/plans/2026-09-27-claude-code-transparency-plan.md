# Claude Code Transparency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `claude_local` agents run as full Claude Code: shared persistent Claude Home, native MCP/plugins/settings, full model/effort/permission controls. Also show exactly what each run got and where each piece came from (Claude Code vs Paperclip).

**Architecture:** A company-scoped `CLAUDE_CONFIG_DIR` ("Claude Home") is resolved in the adapter package. Both engines point Claude at it: the CLI through flags, and ACP through an env-carried SDK-options JSON consumed by a patched `claude-agent-acp`. A pure manifest builder describes every run and is persisted with the existing `adapter.invoke` run event. The server exposes inventory/edit routes and a pre-run "effective setup" endpoint. The UI adds a Claude Home page, agent fields, a run manifest card, and origin badges.

**Tech Stack:** TypeScript, Node 24, Express, Drizzle (no schema change), React + Vite + TanStack Query + shadcn, Vitest, pnpm 9 (`corepack pnpm`).

**Spec:** `doc/plans/2026-09-27-claude-code-transparency-design.md`

## Global Constraints

- No DB schema changes. All new agent settings live in `adapterConfig` (jsonb).
- Company scope on every route. Claude Home routes are **board-only**. Every mutation writes an activity-log entry.
- Secrets never leave the server: MCP `headers`/`env` values and settings `env` values are replaced by the literal `"__redacted__"` on read and restored from disk on write.
- `claudeHome` default = `"company"`; `nativeMcp` default = `"enabled"`; `claudePermissionMode` default = `""` (legacy behavior). `"isolated"` must reproduce today's behavior byte-for-byte in args/env.
- The Claude Home feature applies only to **local** execution targets. Remote/sandbox paths are untouched.
- UI: tokens only (`pnpm check:token-gates`), shadcn components, lucide icons, copy says "task" not "issue".
- Env var names are exact: `PAPERCLIP_CLAUDE_HOME_ROOT` (operator override) and `PAPERCLIP_CLAUDE_SDK_OPTIONS_JSON` (adapter → patched ACP agent).
- Run pnpm as `corepack pnpm`.

## Review Focus

1. **Missing or empty Claude Home dir.** The first run must create the dir, and the inventory must return `exists:false` or empty lists. No 500s.
2. **Malformed `settings.json` / `.claude.json`.** The inventory reports a `parseError` string for that file instead of throwing. The runs still start, and the manifest carries a warning.
3. **Redaction round-trip.** Saving settings or an MCP server whose values are `"__redacted__"` must keep the on-disk secret. Tests in Task 3.
4. **Managed AI connection + auth keys in the home's settings.** The run fails with `ai_connection_incompatible` before spawn. Test in Task 1.
5. **Resumed ACP sessions** must receive the same SDK options as new ones. The patch sits in the shared options builder. Verified in Task 2 by a test that asserts the env JSON shape, plus a manual check of the patched builder.

---

## Shared contract (created in Task 1, used by all)

`packages/shared/src/types/claude-home.ts` (exported from `packages/shared/src/index.ts`):

```ts
export type ClaudeHomeMode = "company" | "isolated";
export type ClaudeNativeMcpMode = "enabled" | "disabled";
export const CLAUDE_PERMISSION_MODES = ["bypassPermissions", "auto", "acceptEdits", "dontAsk", "plan", "manual"] as const;
export type ClaudePermissionMode = (typeof CLAUDE_PERMISSION_MODES)[number];
export const CLAUDE_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export const CLAUDE_REDACTED_VALUE = "__redacted__";

export type ClaudeCapabilityOrigin = "paperclip" | "claude_home" | "project" | "plugin";

export interface ClaudeMcpServerSummary {
  name: string;
  origin: ClaudeCapabilityOrigin;
  transport: "http" | "sse" | "stdio" | "unknown";
  target: string | null;      // url without query, or command basename + args count
  governed: boolean;          // true only for origin "paperclip"
  headerKeys?: string[];
  envKeys?: string[];
}

export interface ClaudeNamedItem { name: string; description?: string | null; origin: ClaudeCapabilityOrigin; }

export interface ClaudeHomeInventory {
  dir: string;
  exists: boolean;
  settings: Record<string, unknown> | null;   // redacted
  settingsParseError: string | null;
  claudeMd: string | null;
  mcpServers: ClaudeMcpServerSummary[];        // origin claude_home
  mcpServerConfigs: Record<string, Record<string, unknown>>; // redacted raw configs, for editing
  mcpParseError: string | null;
  plugins: ClaudeNamedItem[];                  // origin plugin; description = "enabled" | "disabled"
  skills: ClaudeNamedItem[];
  subagents: ClaudeNamedItem[];
  commands: ClaudeNamedItem[];
  hooks: { event: string; count: number }[];
  cliCommand: string;                          // e.g. `CLAUDE_CONFIG_DIR='<dir>' claude`
}

export interface ClaudeLaunchManifest {
  version: 1;
  engine: "cli" | "acp";
  model: string | null;
  fallbackModel: string | null;
  effort: string | null;
  permission: { mode: string; source: "claudePermissionMode" | "dangerouslySkipPermissions" | "acp_default" | "remote_allowlist" };
  claudeHome: { mode: ClaudeHomeMode; dir: string | null };
  settingSources: string[];
  settingsOverlayKeys: string[];
  nativeMcp: ClaudeNativeMcpMode;
  mcpServers: ClaudeMcpServerSummary[];
  plugins: ClaudeNamedItem[];
  skills: ClaudeNamedItem[];                   // paperclip-mounted (origin paperclip) + native (claude_home)
  subagents: ClaudeNamedItem[];
  commands: ClaudeNamedItem[];
  hooks: { event: string; count: number }[];
  instructions: { path: string | null; delivery: "system_prompt_append" | "user_prompt_prefix" | "none" };
  allowedTools: string[];
  disallowedTools: string[];
  extraArgs: string[];
  sessionId?: string | null;                   // filled when known (takeover)
  cwd?: string | null;
  warnings: string[];
}
```

`packages/adapter-utils/src/types.ts`: add `launchManifest?: Record<string, unknown>;` to `AdapterInvocationMeta`.

---

### Task 1: Adapter foundation (Claude Home, native options, manifest, CLI lane)

**Files:**
- Create: `packages/shared/src/types/claude-home.ts` (contract above), export from `packages/shared/src/index.ts`
- Modify: `packages/adapter-utils/src/types.ts` (`launchManifest`)
- Create: `packages/adapters/claude-local/src/server/claude-home.ts`
- Create: `packages/adapters/claude-local/src/server/native-options.ts`
- Create: `packages/adapters/claude-local/src/server/launch-manifest.ts`
- Modify: `packages/adapters/claude-local/src/server/execute.ts` (`buildClaudeArgs` ~:880, config-dir selection ~:568, `onMeta` ~:953)
- Modify: `packages/adapters/claude-local/src/server/index.ts` (export the new modules)
- Modify: `packages/adapters/claude-local/src/index.ts` (models list, `agentConfigurationDoc` new fields)
- Tests: `claude-home.test.ts`, `native-options.test.ts`, `launch-manifest.test.ts` next to the sources; extend an existing execute test only if cheap.

**Interfaces (Produces):**

```ts
// claude-home.ts
export function resolveClaudeHomeDir(env: NodeJS.ProcessEnv, companyId: string): string;
//  PAPERCLIP_CLAUDE_HOME_ROOT ? join(root, companyId) : join(instanceRoot, "companies", companyId, "claude-home")
export async function ensureClaudeHomeDir(dir: string): Promise<void>;            // mkdir -p, mode 0o700
export async function readClaudeHomeInventory(dir: string): Promise<ClaudeHomeInventory>;
export function redactClaudeSecrets<T>(value: T): T;   // settings.env values, mcp headers/env values -> "__redacted__"
export function restoreRedactedSecrets(next: unknown, previous: unknown): unknown; // deep: "__redacted__" -> previous value at same path
export function findHomeAuthConflicts(settings: Record<string, unknown> | null): string[]; // ["apiKeyHelper", "env.ANTHROPIC_API_KEY", ...]
export async function readProjectMcpServers(cwd: string): Promise<ClaudeMcpServerSummary[]>; // <cwd>/.mcp.json, origin "project"
export function summarizeMcpServer(name: string, cfg: Record<string, unknown>, origin: ClaudeCapabilityOrigin): ClaudeMcpServerSummary;

// native-options.ts
export interface ClaudeNativeOptions {
  claudeHome: ClaudeHomeMode; nativeMcp: ClaudeNativeMcpMode;
  permissionMode: ClaudePermissionMode | null; fallbackModel: string | null;
  allowedTools: string[]; disallowedTools: string[];
  settingsOverlay: Record<string, unknown> | null;
}
export function parseClaudeNativeOptions(config: Record<string, unknown>): ClaudeNativeOptions;
export function buildClaudeCliNativeArgs(o: ClaudeNativeOptions, input: { settingsFilePath: string | null; homeActive: boolean }): string[];
//  homeActive -> ["--setting-sources","user,project,local"]; settingsFilePath -> ["--settings", path];
//  fallbackModel -> ["--fallback-model", m]; permissionMode -> ["--permission-mode", m];
//  allowedTools -> ["--allowedTools", ...]; disallowedTools -> ["--disallowedTools", ...]
export function buildClaudeSdkOptions(o: ClaudeNativeOptions, input: { homeActive: boolean; hasPaperclipMcp: boolean; extraArgs: string[] }): Record<string, unknown>;
//  { settingSources?: ["user","project","local"], settings?: overlay(+permissions.defaultMode), strictMcpConfig?: true,
//    fallbackModel?, allowedTools?, disallowedTools?, extraArgs?: Record<string,string|null> }
export function extraArgsToSdkRecord(args: string[]): Record<string, string | null>;
//  ["--foo","bar","--baz","--q=1"] -> { foo:"bar", baz:null, q:"1" }
export function settingsOverlayWithPermission(o: ClaudeNativeOptions): Record<string, unknown> | null;

// launch-manifest.ts
export function buildClaudeLaunchManifest(input: {
  engine: "cli" | "acp"; model: string | null; effort: string | null; options: ClaudeNativeOptions;
  permission: ClaudeLaunchManifest["permission"]; homeDir: string | null; inventory: ClaudeHomeInventory | null;
  paperclipMcp: { name: string; url: string }[]; projectMcp: ClaudeMcpServerSummary[];
  paperclipSkills: string[]; instructionsPath: string | null; instructionsDelivery: ClaudeLaunchManifest["instructions"]["delivery"];
  extraArgs: string[]; settingSources: string[]; cwd: string | null; warnings?: string[];
}): ClaudeLaunchManifest;
```

**Behavior in `execute.ts` (CLI lane):**
- `const native = parseClaudeNativeOptions(config)`. `homeActive = native.claudeHome === "company" && !executionTargetIsRemote`.
- If `homeActive`: `homeDir = resolveClaudeHomeDir(process.env, agent.companyId)`, `await ensureClaudeHomeDir(homeDir)`, `env.CLAUDE_CONFIG_DIR = homeDir` (after `buildClaudeRuntimeConfig`, which also overrides a managed-connection temp dir). The `sharedClaudeConfigDir` used for Bubblewrap `managedPaths` must become `homeDir`. `loggedEnv.CLAUDE_CONFIG_DIR = homeDir`.
- If `homeActive && config.managedAiConnection`: read the inventory. If `findHomeAuthConflicts(settings)` is non-empty, return `{exitCode:1, errorCode:"ai_connection_incompatible", errorMessage:"Claude Home settings.json defines <keys>, which would override the selected AI connection. Remove them in Claude Home."}` before spawning.
- Replace `if (config.managedAiConnection) args.push("--setting-sources","user")` with: `homeActive` → the native args set sources to `user,project,local`, else keep the legacy line.
- `--strict-mcp-config` only when `runtimeMcpServers.length > 0 && (native.nativeMcp === "disabled" || !homeActive)`. Legacy isolated behavior stays unchanged.
- Permission: if `native.permissionMode` is set, **do not** push `buildClaudeExecutionPermissionArgs(...)`; push `--permission-mode` instead (except on remote targets, where the curated allowlist is kept and the manifest source is `remote_allowlist`).
- The settings overlay (`settingsOverlayWithPermission`) is written to `<claudeRuntimeStateDir>/runs/<runId>/settings.json` (0600) and passed with `--settings`.
- Build the manifest, then pass `launchManifest` in `onMeta`. Also add a `commandNotes` line: `Claude Home: <dir> (native MCP <enabled|disabled>)`.
- Models list: prepend `claude-opus-5-5`, keep the rest, and add `claude-opus-5-5[1m]`, `claude-sonnet-5[1m]`, and aliases `opus`, `sonnet`, `haiku`, `opusplan` (labels such as "Alias: latest Opus").

- [ ] **Step 1: Write failing tests**
  - `native-options.test.ts`:
    - defaults (`company`/`enabled`/null);
    - an invalid permission mode is ignored;
    - `extraArgsToSdkRecord(["--foo","bar","--baz","--q=1"])` equals `{foo:"bar",baz:null,q:"1"}`;
    - `buildClaudeCliNativeArgs` order and content;
    - `buildClaudeSdkOptions` with `nativeMcp:"disabled"` + paperclip MCP gives `strictMcpConfig:true`;
    - with `homeActive` it gives `settingSources:["user","project","local"]`;
    - `permissionMode` lands in `settings.permissions.defaultMode`, merged with the overlay.
  - `claude-home.test.ts`, on a tmp dir:
    - the inventory of a missing dir has `exists:false` and empty arrays;
    - the inventory parses `settings.json` (hooks → counts, `enabledPlugins`), `.claude.json` mcpServers (http + stdio), `skills/x/SKILL.md` (frontmatter `description`), `agents/a.md`, `commands/c.md`, `plugins/installed_plugins.json` (`{plugins:{"name@mkt":[...]}}` or `{"name@mkt":...}`; tolerate both);
    - a malformed `settings.json` sets `settingsParseError`;
    - redaction replaces header/env values;
    - `restoreRedactedSecrets` restores them;
    - `findHomeAuthConflicts({apiKeyHelper:"x", env:{ANTHROPIC_API_KEY:"k", FOO:"1"}})` equals `["apiKeyHelper","env.ANTHROPIC_API_KEY"]`;
    - `resolveClaudeHomeDir` honors `PAPERCLIP_CLAUDE_HOME_ROOT`.
  - `launch-manifest.test.ts`:
    - paperclip servers are `governed:true`, home servers `governed:false`;
    - no header values appear anywhere in `JSON.stringify(manifest)`;
    - URL query strings are stripped;
    - `nativeMcp:"disabled"` excludes home/project/plugin MCP servers from `mcpServers` and adds a warning line "Native MCP servers disabled for this agent".
- [ ] **Step 2: Run** `corepack pnpm --filter @paperclipai/adapter-claude-local exec vitest run src/server/native-options.test.ts src/server/claude-home.test.ts src/server/launch-manifest.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement** the three modules, the shared types, and the `execute.ts` wiring above.
- [ ] **Step 4: Run** the same tests plus the existing `src/server/*.test.ts` in the package. Expect PASS (existing tests unchanged, because `isolated` or no-op paths keep their args). If existing tests assert the exact argv of a managed-connection run, set `claudeHome:"isolated"` in those fixtures only when the assertion is about legacy behavior.
- [ ] **Step 5: Typecheck** with `corepack pnpm --filter @paperclipai/shared --filter @paperclipai/adapter-utils --filter @paperclipai/adapter-claude-local typecheck`.

### Task 2: ACP lane parity

**Files:**
- Modify: `packages/adapters/claude-local/src/server/acp.ts` (`buildClaudeAcpConfig`, `createClaudeAcpExecutor`)
- Modify: `patches/@agentclientprotocol__claude-agent-acp@0.73.0.patch` (via `corepack pnpm patch @agentclientprotocol/claude-agent-acp@0.73.0`, edit `dist/acp-agent.js`, then `corepack pnpm patch-commit <dir>`)
- Test: `packages/adapters/claude-local/src/server/acp.native.test.ts`

**Interfaces:** Consumes the Task 1 functions. Produces the env keys `CLAUDE_CONFIG_DIR` and `PAPERCLIP_CLAUDE_SDK_OPTIONS_JSON` on the ACP config env.

- `buildClaudeAcpConfig(config, inheritedEnv, opts?: { companyId?: string; remote?: boolean; hasPaperclipMcp?: boolean })`. When local and `claudeHome==="company"`, set `env.CLAUDE_CONFIG_DIR = resolveClaudeHomeDir(process.env, companyId)` and `env.PAPERCLIP_CLAUDE_SDK_OPTIONS_JSON = JSON.stringify(buildClaudeSdkOptions(...))`. Omit the SDK options JSON when it is `{}`. `extraArgs` from config go into the SDK `extraArgs`.
- `createClaudeAcpExecutor`:
  - ensure the home dir exists;
  - run the managed-connection auth-conflict check (the same message as the CLI lane);
  - wrap `ctx.onMeta` so the meta gets `launchManifest` (engine `"acp"`, `instructions.delivery: "user_prompt_prefix"`, `permission` source `acp_default` unless `claudePermissionMode` is set);
  - take `paperclipMcp` from `ctx.runtimeMcp?.getServers()`.
- Patch `acp-agent.js`: right after `...userProvidedOptions,` inside `const options = {`, insert `...readPaperclipClaudeSdkOptions(),`. Define that function near the top of the file: parse `process.env.PAPERCLIP_CLAUDE_SDK_OPTIONS_JSON`, return `{}` on absence or error, and pick only the keys `settingSources, settings, strictMcpConfig, fallbackModel, allowedTools, disallowedTools, extraArgs`. For `extraArgs` and `disallowedTools`, merge into the later ACP-controlled spreads instead: change `extraArgs: {...userProvidedOptions?.extraArgs, ...` to also spread `readPaperclipClaudeSdkOptions().extraArgs`, and `disallowedTools: [...(userProvidedOptions?.disallowedTools||[]), ...(paperclipSdk.disallowedTools||[]), ...disallowedTools]`. The `settings` merge must be a deep-merge of `settings` with `configuredSettings`, so the provider-routing block still wins on `env` and `apiKeyHelper`: compute the Paperclip settings before `configuredSettings` and use `userProvidedOptions?.settings ?? paperclipSdk.settings ?? (modelConfig ? … : undefined)`.

- [ ] **Step 1: Failing test** `acp.native.test.ts`:
  - `buildClaudeAcpConfig({claudeHome:"company", nativeMcp:"disabled", fallbackModel:"claude-sonnet-5", extraArgs:["--foo","1"]}, {}, {companyId:"c1", hasPaperclipMcp:true})` → `env.CLAUDE_CONFIG_DIR` ends with `c1/claude-home` (with `PAPERCLIP_HOME` set to a tmp dir), and the parsed JSON has `strictMcpConfig:true`, `fallbackModel`, `extraArgs:{foo:"1"}`, `settingSources:["user","project","local"]`;
  - `claudeHome:"isolated"` → neither key is present;
  - `remote:true` → neither key is present.
- [ ] **Step 2:** run it; expect FAIL. **Step 3:** implement. **Step 4:** run the package tests (including the existing `acp.test.ts`); expect PASS. Verify the patch: `grep -n readPaperclipClaudeSdkOptions node_modules/.pnpm/@agentclientprotocol+claude-agent-acp@0.73.0*/node_modules/@agentclientprotocol/claude-agent-acp/dist/acp-agent.js` shows the definition plus two uses.

### Task 3: Server Claude Home service, routes, effective setup

**Files:**
- Create: `server/src/services/claude-home.ts`
- Create: `server/src/routes/claude-home.ts`; register it where sibling company routes are mounted (follow `server/src/routes/company-skills.ts` registration)
- Modify: `packages/shared` API path constants if the repo keeps them (follow the company-skills precedent)
- Test: `server/src/__tests__/claude-home-routes.test.ts` (follow the style of an existing route test with supertest + embedded DB or mocked services, whichever the siblings use)

**Interfaces:**
- `claudeHomeService(db)`:
  - `getInventory(companyId)`
  - `saveSettings(companyId, next)`: restore redacted values, validate that it is an object, write atomically, return the inventory
  - `saveClaudeMd(companyId, text)`
  - `upsertMcpServer(companyId, name, cfg)`: validate that `name` matches `/^[A-Za-z0-9_.-]{1,64}$/`, that `cfg.type ∈ http|sse|stdio` (or has `command` → stdio), that there is a `url` for http/sse and a `command` for stdio; restore redacted values from the existing entry; keep other `.claude.json` keys
  - `deleteMcpServer(companyId, name)`
  - `getAgentEffectiveSetup(companyId, agentId)`: loads the agent; if not `claude_local`, 422; builds the manifest with `buildClaudeLaunchManifest` using the agent adapterConfig, inventory, project MCP from `adapterConfig.cwd` if set, and Paperclip MCP names from the agent's installed/permitted tool connections (list the connection names as `{name, url:""}`; plus fixed entries `paperclip-assigned`, `Paperclip connections`, `Paperclip projects` when the agent has any)
- Routes (board-only, company access, activity log `claude_home.settings_updated`, `claude_home.claude_md_updated`, `claude_home.mcp_server_upserted`, `claude_home.mcp_server_deleted`):
  - `GET /api/companies/:companyId/claude-home`
  - `PUT /api/companies/:companyId/claude-home/settings` body `{settings}`
  - `PUT /api/companies/:companyId/claude-home/claude-md` body `{content}`
  - `PUT /api/companies/:companyId/claude-home/mcp-servers/:name` body `{config}`
  - `DELETE /api/companies/:companyId/claude-home/mcp-servers/:name`
  - `GET /api/companies/:companyId/agents/:agentId/claude-setup` (board or same-company agent read)

- [ ] **Step 1: Failing tests:**
  - GET on an empty home → 200 `exists:true` (the service ensures the dir);
  - PUT settings with `{env:{TOKEN:"__redacted__"}}` over an on-disk `{env:{TOKEN:"s3"}}` keeps `s3` on disk;
  - PUT an MCP server with an invalid name → 400;
  - stdio without a command → 400;
  - upsert, then GET shows the server with origin `claude_home` and `governed:false`, with header values absent;
  - DELETE removes it;
  - an agent actor calling PUT → 403;
  - a company mismatch → 403/404 per repo convention;
  - the claude-setup endpoint for a claude_local agent returns `version:1`.
- [ ] **Steps 2–4:** run with `corepack pnpm --filter @paperclipai/server exec vitest run src/__tests__/claude-home-routes.test.ts` → FAIL → implement → PASS. Typecheck the server.

### Task 4: UI agent config fields (Claude Code section)

**Files:** `ui/src/adapters/claude-local/config-fields.tsx`, `packages/adapters/claude-local/src/ui/build-config.ts` (create-time mapping), effort options in `ui/src/components/AgentConfigForm.tsx:~290` (add `xhigh`, `max` for claude_local only if options are shared across adapters; otherwise add them globally only if other adapters accept them. Check the codex/others' effort semantics first and scope to claude_local through the adapter module if needed).

Fields, following the existing field components and create (`values/set`) / edit (`eff/mark`) conventions in that file:
- Claude Home: select Company (shared) / Isolated
- Native MCP servers: toggle (enabled/disabled), helper text "Claude Code MCP servers from Claude Home are not governed by Paperclip approvals."
- Permission mode: select, with "Paperclip default" = empty
- Fallback model: text
- Allowed tools / Disallowed tools: comma-separated text → string[]
- Settings overlay: JSON textarea with parse validation (use the existing runtime JSON field helper if there is one, `ui/src/adapters/runtime-json-fields.tsx`)
- Note: "Extra args now apply to both engines."

- [ ] Tests: extend `packages/adapters/claude-local/src/ui/build-config.test.ts` so the new fields map through (arrays split, trimmed; empty omitted). Run it, then UI typecheck.

### Task 5: UI Claude Home page + Apps notice + Adopt into Paperclip

**Files:**
- Create: `ui/src/api/claudeHome.ts`
- Create: `ui/src/pages/ClaudeHome.tsx`
- Create: `ui/src/components/claude/OriginBadge.tsx` (shared by Tasks 5–6): `<OriginBadge origin governed />` renders `Claude Code` (or `Claude Code · plugin` / `project`) or `Paperclip · governed`, using existing Badge variants/tokens
- Modify: `ui/src/App.tsx` (route `claude-home`), the sidebar/nav near Apps, `ui/src/lib/queryKeys` (`claudeHome(companyId)`, `claudeSetup(companyId, agentId)`), `ui/src/pages/apps/Browse.tsx` (notice card: "N MCP servers are also configured natively in Claude Code. They run outside Paperclip approvals." + link)

Page sections:
- Location (dir + copy button for `cliCommand`; explain that `claude mcp add` / `/plugin install` there write to this home)
- MCP servers table (name, OriginBadge, transport, target; Edit/Delete; Add dialog with a type select, url/command/args, and key=value headers/env where values show the redacted placeholder)
- **Adopt into Paperclip** button for http/sse servers: calls the existing `POST /companies/:companyId/tools/mcp/import-json` with `{json: JSON.stringify({mcpServers:{[name]: cfg}})}`. Check the request body shape used by `ui/src/pages/tools/PasteConfigTab.tsx` and reuse its API client function. Then navigate to where PasteConfigTab sends the user after import, or show the returned draft link
- Settings JSON editor (textarea + Save, parse validation, parse error from the server shown)
- CLAUDE.md editor
- Read-only lists: Plugins (enabled/disabled), Skills, Subagents, Slash commands, Hooks (event × count)

- [ ] Tests: `ui/src/components/claude/OriginBadge.test.tsx` (labels per origin), and a `ClaudeHome` render test with mocked API showing a native MCP row with the "Claude Code" badge and the Adopt button only for http. Run with `corepack pnpm --filter @paperclipai/ui exec vitest run <files>`, then `corepack pnpm check:token-gates`.

### Task 6: UI run launch manifest, effective setup, takeover

**Files:**
- Create: `ui/src/components/claude/LaunchManifestCard.tsx`: props `{ manifest: ClaudeLaunchManifest; compact?: boolean }`
  - chips: engine, model (+fallback), effort, permission mode, Claude Home mode;
  - MCP list with OriginBadge; plugins / skills / subagents / commands counts, expandable to names;
  - setting sources; warnings (warning tone);
  - takeover block when `claudeHome.mode==="company"` and `sessionId` and `cwd` are present: copyable `cd '<cwd>' && CLAUDE_CONFIG_DIR='<dir>' claude --resume <sessionId>` with the caption "Continue this session in real Claude Code on the Paperclip host".
- Modify: `ui/src/pages/AgentDetail.tsx` `RunInvocationCard` (and `AgentDetail.production.tsx` if it is a live duplicate; check which one is routed): render `LaunchManifestCard` when `payload.launchManifest?.version === 1`, above Details. Fill `sessionId` from the run's `sessionIdAfter`/`sessionIdBefore` if the card has access to the run; otherwise leave it out.
- Modify: `ui/src/pages/AgentToolsTab.tsx`: an "Effective setup" section at top for claude_local agents, which fetches `/claude-setup` and renders `LaunchManifestCard compact`, with a link to Claude Home.

- [ ] Tests: `LaunchManifestCard.test.tsx`: renders the governed/ungoverned badges, a warning, and the takeover command only when sessionId+cwd+company mode are all present. Run it, then the token gates.

### Task 7: Transcript fidelity

**Files:** `packages/adapters/claude-local/src/ui/parse-stdout.ts` and/or `ui/src/components/task-chat/transcript-adapter.ts` / `RunTranscriptView.tsx` tool rendering.
- TodoWrite (`todo_write` family "plan"): render the `todos` input as a checklist (status → checked/in-progress/pending icon), instead of raw JSON.
- Task/Agent tool calls: the display name includes `subagent_type` and `description` ("Subagent · Explore: Map adapter").
- [ ] Tests: extend the existing tests for `summarizeToolInput`/`toolDisplayName` (`ui/src/components/task-chat/*.test.ts`) with TodoWrite and Task inputs. Run them.

### Task 8: Homelab deployment wiring + docs

**Files:** `HOMELAB.md` (repo), `/Users/hassan/Documents/claude/proxmark/paperclip/HOMELAB.md` copy, `/Users/hassan/Documents/claude/proxmark/paperclip/docker-compose.yml` (read first).
- Document the new branch and features, and where Claude Home lives in the container (instance root on the data volume). Document the `docker compose exec -it paperclip sh -lc "CLAUDE_CONFIG_DIR=… claude"` editing workflow. Add `PAPERCLIP_CLAUDE_HOME_ROOT` to compose only if the instance root is not on a persistent volume.
- Confirm that the `claude` CLI exists in the production image (`Dockerfile` production target). If not, note it; the ACP lane bundles the SDK.

### Final: whole-branch verification

- `corepack pnpm -r typecheck`, targeted test suites, `corepack pnpm check:token-gates`, `corepack pnpm build` (if memory allows), then commit per task.
