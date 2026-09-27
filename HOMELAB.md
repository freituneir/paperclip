# Homelab fork of Paperclip

This is `freituneir/paperclip`, a fork of [`paperclipai/paperclip`](https://github.com/paperclipai/paperclip)
for a self-hosted Paperclip on Proxmox (VM 100, `https://paperclip.drpt.sh`).
It is **upstream release `d554c47` plus the commits listed below** — nothing else.

Build from the **`homelab`** branch (or **`claude-transparency`**, which is `homelab` plus change 4). Each change also lives alone on its own
branch (based on `d554c47`) so it can be proposed upstream or dropped cleanly.

## How this version differs from upstream

| # | Branch | What changes for you | Files |
|---|---|---|---|
| 1 | `fix-tool-approval-500` | Approving a high-risk tool action from the **chat card** before its Inbox approval returns a clear 409 ("formal approval required") instead of a red **internal server error** | `server/src/errors.ts`, `server/src/middleware/error-handler.ts`, `server/src/services/tool-gateway.ts` |
| 2 | `dashboard-agents-per-agent` | The dashboard **Agents** panel shows **one card per agent** (its live run, else latest run) instead of one card per run | `ui/src/components/ActiveAgentsPanel.tsx`, `ui/src/pages/Dashboard.tsx` |
| 3 | `fix-claude-setup-token` | The Claude subscription connection accepts a **one-year `claude setup-token` token**, so agents stop failing ~12 h after signing in; adds a helper script | `server/src/services/local-ai-credentials.ts`, `scripts/homelab/claude-setup-token-login.sh` |
| 4 | `claude-transparency` (on top of `homelab`) | Agents run as **full Claude Code**: a persistent company **Claude Home** (native MCP servers, plugins, skills, subagents, slash commands, hooks, settings, CLAUDE.md), full model/effort/permission controls, and a **launch manifest** on every run showing what Claude got and whether each MCP server is **Claude Code (ungoverned)** or **Paperclip (governed)** | `packages/adapters/claude-local/**`, `patches/@agentclientprotocol__claude-agent-acp@0.73.0.patch`, `server/src/{routes,services}/claude-home.ts`, `ui/src/pages/ClaudeHome.tsx`, `ui/src/components/claude/**`, agent config + transcript UI; design in `doc/plans/2026-09-27-claude-code-transparency-*.md` |
| — | `homelab` only | This file | `HOMELAB.md` |

### 1. Chat-card approval returns 409, not 500

- **Symptom:** approving a destructive tool action (calendar events, Gmail
  labels/filters, …) in the task chat showed "internal server error"; the same
  approval from the Inbox worked.
- **Cause:** destructive tools need a *formal* board approval (Inbox) as well as
  the chat card. Accepting the card first makes the gateway refuse with
  `ToolGatewayHttpError(409, formal_approval_required)`. That class extended plain
  `Error`, so routes that don't catch it explicitly (the issue-interaction
  `accept` route) fell through to the global handler → **500**.
- **Change:** `ToolGatewayHttpError` moved to `errors.ts` as an `HttpError`
  subclass (same constructor/fields; still exported from `tool-gateway.ts`), and
  the error handler returns its `reasonCode` as `code`. Response is now
  `409 {error, code: "formal_approval_required", details: {approvalId}}`.
- **Behaviour unchanged:** the two approval layers stay. Approve high-risk
  actions in the Inbox.
- **Tests:** `server/src/__tests__/error-handler.test.ts`,
  `server/src/__tests__/issue-thread-interaction-routes.test.ts` (fails with 500
  without the fix).

### 2. Dashboard Agents panel: one card per agent

- **Symptom:** "Agents" listed the same agent several times — it rendered one
  card per *run*, padded to four with finished runs.
- **Change:** opt-in `groupByAgent` prop on `ActiveAgentsPanel`
  (`latestRunPerAgent()` keeps each agent's first run; the API returns live runs
  first, newest first). In grouped mode it fetches up to 50 recent runs so every
  recently active agent is represented. Only the dashboard opts in; the
  "Live agent runs" page still shows every run.
- **Limitation:** an agent with no run among the last 50 isn't shown.
- **Tests:** `ui/src/components/ActiveAgentsPanel.test.tsx` (fails without the change).

### 3. Long-lived Claude setup tokens

- **Symptom:** after ~12 h every agent failed with *"ACP agent reported a terminal
  access failure"* (ACP failure category `access` = provider login refused).
- **Cause:** the local sign-in (`claude auth login`) keeps only
  `claudeAiOauth.accessToken`; the refresh token is discarded, so the token
  expires. Upstream's setup-token flow (one-year token) only works in sandbox
  environments. Its Connect check requires Anthropic's usage endpoint to return
  200, but setup tokens are inference-only and get **403**.
- **Change:** keep upstream's quota check first; if it fails, probe the usage
  endpoint once: **403** (authenticated, missing scope) → accepted. **429**
  (rate limited — the connection screen's polling triggers ~1 h limits) →
  verify by running one tiny `claude -p` prompt with the token in a throwaway
  config dir; accepted only if Claude answers. 401 (invalid/expired), failed
  prompts and network errors are still rejected.
- **Helper:** `scripts/homelab/claude-setup-token-login.sh` (in the image at
  `/app/scripts/homelab/…`) runs `claude setup-token`, checks the token with a
  one-word prompt, and writes it where the Connect button looks.
- **Tests:** `server/src/__tests__/local-ai-credentials.test.ts` (setup token
  accepted on 403; accepted on 429 only when a Claude prompt succeeds; 401,
  failed prompt and network failure rejected; no extra probe when the normal
  check passes). The new tests fail without the fix.

#### Connecting (or re-connecting) Claude with a setup token

1. Paperclip → the Claude subscription connection → sign in. The screen shows
   `(export CLAUDE_CONFIG_DIR='/paperclip/instances/default/ai-local-logins/<id>' … claude auth login)`.
   **Don't run that.** Copy the `ai-local-logins/<id>` path.
2. From a wide terminal:
   ```
   ssh -t hassan@192.168.0.73 "cd /opt/paperclip && docker compose exec -u node paperclip /app/scripts/homelab/claude-setup-token-login.sh /paperclip/instances/default/ai-local-logins/<id>"
   ```
3. Open the link (it must contain `response_type=code`), approve, paste the code,
   then paste the printed `sk-ant-oat01-…` token at the hidden prompt. **Never
   paste the token into chats or tickets.**
4. Back in Paperclip, click **Connect**. The token lasts one year.

### 4. Full Claude Code through Paperclip (Claude Home)

- **Symptom:** Paperclip felt like a thinner harness than Claude Code. Native
  MCP servers, plugins, user settings and CLAUDE.md never reached agents, the
  model/effort lists were fixed, and nothing showed what a run really had.
- **Causes:** managed AI connections gave each run an empty temp
  `CLAUDE_CONFIG_DIR`; the ACP client sent `settingSources: ["project","local"]`
  (no user settings); the CLI lane forced `--strict-mcp-config`.
- **Change:** each company has a persistent **Claude Home**, a normal
  `CLAUDE_CONFIG_DIR`. In this deployment it lives at
  `/paperclip/instances/default/companies/<companyId>/claude-home` on the
  `paperclip-data` volume, so no compose change is needed.
  `PAPERCLIP_CLAUDE_HOME_ROOT` overrides the root. Local runs use it with the
  user, project and local setting sources on both engines. The managed AI
  connection still supplies the credential via env. If the home's
  `settings.json` sets `apiKeyHelper` or auth env keys, the run fails with
  `ai_connection_incompatible` instead of billing another account.
- **Per agent** (agent → Configuration → *Claude Code*):
  - Claude Home: company or isolated (the old behavior).
  - Native MCP on/off.
  - Permission mode.
  - Fallback model.
  - Allowed and disallowed tools.
  - A settings-JSON overlay.
  - Effort up to `max`.
  - Extra args, now honored on ACP too.
- **Visibility:**
  - Every run's Invocation card shows a **launch manifest** listing every MCP
    server with its origin badge: *Claude Code* (native, not governed by
    Paperclip approvals) or *Paperclip · governed*.
  - Agent → Tools shows the same **effective setup** before a run.
  - The **Claude Home** page edits `settings.json`, CLAUDE.md and MCP servers,
    and lists plugins, skills, subagents, commands and hooks. It can also
    **adopt** a native http/sse server into a governed Paperclip connection.
- **Native editing:** the real CLI is the power editor. Plugins, OAuth MCP
  logins and `claude mcp add` all write straight into the home:
  ```
  ssh -t hassan@192.168.0.73 "cd /opt/paperclip && docker compose exec -it -u node paperclip sh -lc 'CLAUDE_CONFIG_DIR=/paperclip/instances/default/companies/<companyId>/claude-home claude'"
  ```
  An interactive session there needs its own login (`/login` once; it is stored
  in the home). Agent runs keep using the managed connection.
  Agents without a managed connection need that login too: the run logs
  "Claude Home has no login" until you do it. Paperclip never copies OAuth
  credentials, because copied refresh tokens break when one copy rotates.
- **Take over a run:** the run page shows
  `cd '<cwd>' && CLAUDE_CONFIG_DIR='<home>' claude --resume <session>`. Run it
  inside the container (prefix as above) to continue the agent's session in real
  Claude Code. Sessions now persist in the home instead of a deleted temp dir.
- **Security note:** native MCP servers bypass Paperclip's approvals and audit,
  and stdio servers run inside the Paperclip container. That is the parked
  "agents share the container" issue (`FUTURE-PROBLEMS.md`). Use the per-agent
  *Native MCP* switch, or *Adopt into Paperclip*, for anything risky.
- **First run after upgrading:** existing ACP agents start one fresh session,
  because the session fingerprint includes the new env.
- **Tests:**
  - `packages/adapters/claude-local/src/server/{claude-home,native-options,launch-manifest,acp.native}.test.ts`
  - `server/src/__tests__/claude-home-routes.test.ts`
  - `server/src/__tests__/claude-local-execute.test.ts`
  - `ui/src/components/claude/*.test.tsx`
  - `ui/src/adapters/claude-local/config-fields.test.tsx`
  - the task-chat and transcript tests (TodoWrite checklist, subagent labels)

## Building and deploying

```
git clone -b homelab https://github.com/freituneir/paperclip
cd paperclip
docker build --target production -t local/paperclip:homelab .   # target matters: the default is `cloud`
```
On the VM, in `/opt/paperclip/docker-compose.yml` set
`image: local/paperclip:homelab` and run `docker compose up -d`. Back up the data
volume first (see `/opt/backups`). Docker there uses userns-remap, so build on the
VM or `docker save | docker load` the image into it.

The deployment config (telemetry off, containment, network isolation, Caddy /
Cloudflare tunnel, Gmail + Calendar via self-hosted `workspace-mcp`) is **not in
this repo**; it lives in the operator's project folder (`paperclip/`,
`workspace-mcp/`, `GMAIL-CALENDAR-NOTES.md`).

## Updating to a new upstream release

```
git fetch https://github.com/paperclipai/paperclip.git --tags
git switch -c homelab-<new> <new-release-commit>
git cherry-pick <commit of each fix branch>   # resolve conflicts, rerun the tests above
git cherry-pick <HOMELAB.md commit>           # update the base version at the top
```
Drop any change upstream has since fixed. Keep the per-fix branches rebased so
each can still be offered upstream on its own.

## Running the tests locally

```
corepack pnpm@9.15.4 install --frozen-lockfile --ignore-scripts \
  --filter "@paperclipai/server..." --filter "@paperclipai/ui..." \
  --filter ./packages/plugins/sdk --filter ./packages/kv-demo-mcp-server
cd server && corepack pnpm@9.15.4 exec vitest run error-handler issue-thread-interaction-routes local-ai-credentials tool-gateway
cd ../ui && corepack pnpm@9.15.4 exec vitest run src/components/ActiveAgentsPanel.test.tsx src/pages/Dashboard.test.ts
```
- `--ignore-scripts` skips third-party install hooks. Because of that, the
  embedded Postgres used by DB-backed tests needs its library links created from
  `node_modules/.pnpm/@embedded-postgres+<platform>*/…/native/pg-symlinks.json`
  (each `target` → `source`). Otherwise those suites skip.
- Some server suites (plugins, runner) fail identically on upstream `d554c47`
  without building every workspace package; they are unrelated to these changes.
