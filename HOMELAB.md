# Homelab fork of Paperclip

This is `freituneir/paperclip`, a fork of [`paperclipai/paperclip`](https://github.com/paperclipai/paperclip)
for a self-hosted Paperclip on Proxmox (VM 100, `https://paperclip.drpt.sh`).
It is **upstream release `d554c47` plus the commits listed below** — nothing else.

Build from the **`homelab`** branch. Each change also lives alone on its own
branch (based on `d554c47`) so it can be proposed upstream or dropped cleanly.

## How this version differs from upstream

| # | Branch | What changes for you | Files |
|---|---|---|---|
| 1 | `fix-tool-approval-500` | Approving a high-risk tool action from the **chat card** before its Inbox approval returns a clear 409 ("formal approval required") instead of a red **internal server error** | `server/src/errors.ts`, `server/src/middleware/error-handler.ts`, `server/src/services/tool-gateway.ts` |
| 2 | `dashboard-agents-per-agent` | The dashboard **Agents** panel shows **one card per agent** (its live run, else latest run) instead of one card per run | `ui/src/components/ActiveAgentsPanel.tsx`, `ui/src/pages/Dashboard.tsx` |
| 3 | `fix-claude-setup-token` | The Claude subscription connection accepts a **one-year `claude setup-token` token**, so agents stop failing ~12 h after signing in; adds a helper script | `server/src/services/local-ai-credentials.ts`, `scripts/homelab/claude-setup-token-login.sh` |
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
- **Change:** keep upstream's quota check first; if it fails, accept the token
  only if the usage endpoint answers **403** (authenticated, missing scope).
  401 (invalid/expired) and network errors are still rejected.
- **Helper:** `scripts/homelab/claude-setup-token-login.sh` (in the image at
  `/app/scripts/homelab/…`) runs `claude setup-token`, checks the token with a
  one-word prompt, and writes it where the Connect button looks.
- **Tests:** `server/src/__tests__/local-ai-credentials.test.ts` (setup token
  accepted on 403; 401 and network failure rejected; no extra probe when the
  normal check passes). The new test fails without the fix.

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
