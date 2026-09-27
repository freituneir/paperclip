# Claude permission bridge: `ask` rules become Paperclip approval cards

Status: implemented (branch `claude-transparency`), hardened after security review. Date: 2026-09-27.

## Intent

The operator writes normal Claude Code permission rules (`permissions.ask` in
Claude Home `settings.json`, an agent overlay, or a repo `.claude/settings.json`).
When an agent hits an `ask` rule, the operator should be asked in Paperclip, as
a card in the task chat, instead of the request being auto-approved (ACP today)
or silently denied (headless CLI).

## Verified facts

- `ask` rules force a permission request even under `bypassPermissions`. This was
  tested with CLI 2.1.283: under `-p` the request is denied and recorded in
  `permission_denials`. `deny` rules are always enforced.
- acpx 0.13.1 exposes an async host hook,
  `AcpRuntimeOptions.onPermissionRequest(request, {signal})`, which returns an
  `AcpPermissionDecision {outcome}` or `undefined` to fall back to the mode.
  Paperclip's ACP engine does not set it. The runtime is created only on a cold
  start, so warm handles need a per-run sink.
- The request carries `toolCall {toolCallId, title, kind, rawInput,
  _meta.claudeCode.toolName}` and `options[] {optionId, name, kind}`.
  claude-agent-acp leaves out persistent ("always") options when an `ask` rule
  matched.
- A permission wait counts against the turn timeout (`timeoutSec`; 0 = none for
  local).

## Design

**Config (claude_local):**
- `permissionBridge`: `"task_chat"` (default) or `"off"`.
- `permissionWaitSec`: default `600`.

**Claude mode:** when the bridge is on, the ACP lane is local, and
`claudePermissionMode` is unset, the SDK settings overlay sets
`permissions.defaultMode = "bypassPermissions"`. Requests then arise only from
`ask` rules. As root outside a sandbox, bypass is unavailable, so the bridge is
disabled with a manifest warning. An explicit `claudePermissionMode` is
respected, and the operator then gets cards for everything that mode asks about.

**Adapter contract** (`packages/adapter-utils/src/types.ts`):

```ts
export interface AdapterPermissionRequest {
  toolCallId: string | null; toolName: string | null; title: string | null;
  kind: string | null; rawInput: unknown;
  options: { optionId: string; name: string; kind: string }[];
}
export type AdapterPermissionOutcome = "allow_once" | "allow_always" | "reject_once" | "reject_always" | "cancel";
export interface AdapterPermissionDecision { outcome: AdapterPermissionOutcome }
// AdapterExecutionContext:
requestPermission?: (request: AdapterPermissionRequest, opts: { signal: AbortSignal; waitMs: number }) => Promise<AdapterPermissionDecision | undefined>;
```

**ACP engine:**
- When `ctx.requestPermission` exists and `config.permissionBridge !== "off"`,
  the runtime's `onPermissionRequest` forwards to it through a per-run sink. The
  sink is a mutable holder set per run and cleared in `finally`, so a warm handle
  never calls a finished run.
- Any throw, or `undefined`, falls back to the mode.
- Each request and decision is recorded as a run event (`permission.requested` /
  `permission.resolved`, run log only).

**Server bridge** (`server/src/services/claude-permission-bridge.ts`):
- `requestPermission(run, request, {signal, waitMs})`:
  1. With no issue on the run, returns `{outcome:"reject_once"}` and logs why.
  2. **One-time grant:** if an accepted, unconsumed `claude_permission`
     interaction exists for the same agent and issue with the same fingerprint
     (`sha256(toolName + canonical rawInput)`), it marks it consumed and returns
     `allow_once`.
  3. Otherwise it creates a `request_confirmation` interaction:
     - `payload.claudePermission {fingerprint, toolName, title, kind, inputPreview, options, runId, agentId, alwaysAvailable}`
     - `resolverPolicy "human_only"`
     - `continuationPolicy "wake_assignee"`
     - idempotency key `claude-permission:{runId}:{toolCallId}`
  4. It parks a promise in an in-process Map keyed by the interaction id and
     races it against `waitMs` and the signal.
     - A human answer in time resolves with that decision.
     - On timeout it returns `reject_once` and the card stays open (parked).
     - When the signal aborts, it returns `cancel`.
- Accepting or rejecting a `claudePermission` interaction goes through the
  existing `/interactions/:id/accept|reject` routes, which branch on
  `payload.claudePermission`:
  - With a live waiter, the waiter resolves: accept → `allow_once`, or
    `allow_always` when `rememberAction` is set and it is available; reject →
    `reject_once`.
  - With no live waiter (timed out, or the run ended), the interaction is
    recorded as accepted/rejected. An acceptance is left unconsumed, which is the
    one-time grant, and the assignee is woken through the interaction's
    `wake_assignee` continuation.

**UI:**
- `request_confirmation` cards with `payload.claudePermission` render a
  **ClaudePermissionCard**: an "Claude Code wants to run" title, the tool name,
  the command/input preview in mono, and the buttons Allow once / Always allow
  (only when `alwaysAvailable`) / Deny.
- The config fields gain "Ask rules → approval cards" and a wait time.
- The launch manifest shows the bridge state.

**Manifest:**
- `permission.bridge: "task_chat" | "off" | "unavailable"`.
- CLI lane: `"off"`, with the warning "ask rules are denied on the CLI engine".

## Tasks

1. **Contract + ACP engine + claude-local:**
   - the types;
   - the engine sink and hook, with event emission;
   - claude-local config parsing, the defaultMode overlay, root and CLI handling,
     and the manifest `permission.bridge`;
   - tests.
2. **Server:**
   - the bridge service;
   - heartbeat wiring of `ctx.requestPermission` (only for claude_local runs
     that have an issue);
   - the accept/reject route branches;
   - one-time grants;
   - tests with mocked interactions and fake timers.
3. **UI:**
   - ClaudePermissionCard in the interaction card dispatch (task chat + issue
     thread);
   - config fields;
   - the manifest chip;
   - tests.

## Review focus

- A late answer after the run ended must not throw or leak, and must wake the
  agent.
- A double answer or a double click must be idempotent.
- A warm ACP handle must never call a finished run's sink.
- Previews must not expose secrets. `rawInput` for Bash can hold tokens, so it
  gets the same length cap as other chat previews, and the full input is stored
  only in the interaction payload, which is company-scoped.
- The permission to answer is the same as for any `request_confirmation`
  (human_only).

## Post-review hardening (implemented)

- **Provenance:**
  - The public create route rejects `payload.claudePermission` and
    `claude-permission:` idempotency keys.
  - These cards are governed. They are human_only and are never addressed to or
    resolved by agents.
  - A grant requires a card the bridge created (agent creator, no user creator,
    bridge key, human_only), a user resolver and a recorded outcome.
- **Fail closed:** with the bridge on, host errors, `undefined` or invalid
  answers, a released or empty sink, and runs without a task all deny
  (`reject_once`, or `cancel` when aborted). They never fall back to acpx
  `approve-all`. This supersedes the "undefined falls back to the mode" line
  above.
- **Channels:** these cards are never sent to external chat channels. Answers
  from Telegram, plugins or other non-Paperclip paths are refused.
- **Redaction:** tool name, title and preview are secret-redacted before they
  are stored. The fingerprint still uses the raw input.
- **Respecting user modes:** bypass is filled only when no Claude Home or project
  settings file sets `permissions.defaultMode`. Otherwise that mode applies and
  the manifest warns.
- **Behavior change:** an `ask` rule on a run without a task is now denied, the
  same as headless Claude. It used to be auto-approved.
