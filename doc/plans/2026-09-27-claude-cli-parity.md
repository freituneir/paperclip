# Terminal parity for Claude Code MCP servers and plugins

Status: design + plan (branch `claude-transparency`). Date: 2026-09-27.

## Intent

Managing Claude Code in Paperclip should feel like the terminal (`/mcp`,
`/plugin`, `claude mcp …`, `claude plugin …`), with UI on top. Everything that
is already installed has to be visible, not only servers added by hand:

- plugin-bundled MCP servers
- claude.ai connectors
- project servers
- marketplaces and plugins

The dashboard shows the same run detail as the task view, including pending
approval cards.

## Principle: the CLI is the backend

The server runs the real `claude` binary with `CLAUDE_CONFIG_DIR=<Claude Home>`
and argument arrays (never a shell). Behaviour, file formats and future Claude
Code changes then match the terminal exactly. File parsing (the existing
inventory) remains only as a fallback when the CLI is unavailable.

Verified with CLI 2.1.283 in a scratch home:

| Terminal action | Command | Needs login? | Output |
|---|---|---|---|
| List MCP servers + health | `claude mcp list` | no | text lines `name: target (TYPE) - ✓ Connected / ✘ Failed… / ⏸ … / needs authentication` |
| Server details | `claude mcp get <name>` | no | text |
| Add server | `claude mcp add-json <name> <json> --scope user` | no | text |
| Remove | `claude mcp remove <name> --scope user` | no | text |
| OAuth sign-in | `claude mcp login <name> --no-browser` | no | prints auth URL, reads the redirect URL on stdin |
| Sign out | `claude mcp logout <name>` | no | text |
| Marketplaces | `claude plugin marketplace list --json` / `add <source>` / `remove <name>` / `update [name]` | no | JSON for list |
| Installed plugins | `claude plugin list --json` | no (with nothing installed it prints "Not logged in" → treat as `[]`) | JSON `[{id, version, scope, enabled, installPath, installedAt, lastUpdated}]` |
| Install / uninstall / enable / disable / update | `claude plugin install|uninstall|enable|disable|update <id>` | no | text |
| Plugin details | `claude plugin details <id>` | no | text: component inventory + projected token cost |
| Discover (available plugins) | read `<home>/plugins/marketplaces/<m>/.claude-plugin/marketplace.json` → `plugins[] {name, displayName?, description, category?, tags?, keywords?, author?, homepage?, version?}` | n/a | JSON file |

`--available` needs a login, so Discover reads the catalog files instead, which
is what the terminal's Discover tab shows.

## Server: `server/src/services/claude-cli.ts` + routes

- **Runner** `runClaudeCli(companyId, args, {stdin?, timeoutMs=60s})`:
  - `execFile`-style spawn of `claude` (override with `PAPERCLIP_CLAUDE_BIN`).
  - `cwd` = home dir.
  - env = minimal: PATH, a HOME temp dir, `CLAUDE_CONFIG_DIR` = home,
    `DISABLE_TELEMETRY` passthrough, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`
    passthrough.
  - Auth env such as `ANTHROPIC_API_KEY` is **never** passed.
  - Writes are serialized per company with the same lock the Claude Home service
    uses.
  - Output is capped at 1 MB. Returns `{exitCode, stdout, stderr}`.
  - When the binary is missing, it returns 503 `claude_cli_unavailable`.
- **Validation** (400 on failure):
  - MCP name `^[A-Za-z0-9_.:-]{1,80}$`. Colons are allowed because
    plugin-provided servers are named `plugin:x:y`.
  - Plugin id `^[A-Za-z0-9_.-]+(@[A-Za-z0-9_.-]+)?$`.
  - Marketplace source: `owner/repo`, an `https://` URL (git or `.json`), or a
    `git@github.com:` URL. Local paths are rejected.
- **Access:** every route is board-only and gated by `agents:create`, like
  Claude Home. Every mutation writes an activity log entry
  (`claude_cli.<action>` with `{target}`).
- **Parsing `mcp list`:** each line matches `^(?<name>.+?): (?<target>.+?)(?: \((?<type>[A-Z]+)\))? - (?<status>.+)$`.
  - Origin:
    - `plugin` when the name starts with `plugin:`;
    - `claude_ai` when it starts with `claude.ai ` or the type/target marks it as a claude.ai connector;
    - `project` when `mcp get` says Scope project (fetched lazily; default to user);
    - otherwise `claude_home`.
  - Status: `connected` (✓), `failed` (✘, with the message), `needs_auth`
    (contains "auth"), `pending_approval` (⏸), `unknown`.

**Contract** (shared types in `packages/shared/src/types/claude-cli.ts`, `/api` prefix, company-scoped):

```
GET    /companies/:c/claude-home/mcp                       → { servers: ClaudeCliMcpServer[], cliAvailable, error? }
POST   /companies/:c/claude-home/mcp            {name, config}      → { servers }   (add-json --scope user; restore redacted from existing? no: new secrets only)
DELETE /companies/:c/claude-home/mcp/:name                          → { servers }
POST   /companies/:c/claude-home/mcp/:name/login                    → { sessionId, authUrl }      (no-browser flow)
POST   /companies/:c/claude-home/mcp/login/:sessionId/complete {redirectUrl} → { servers }
DELETE /companies/:c/claude-home/mcp/login/:sessionId               → 204
POST   /companies/:c/claude-home/mcp/:name/logout                   → { servers }
GET    /companies/:c/claude-home/marketplaces                       → { marketplaces: ClaudeCliMarketplace[] }
POST   /companies/:c/claude-home/marketplaces   {source}            → { marketplaces }
DELETE /companies/:c/claude-home/marketplaces/:name                 → { marketplaces }
POST   /companies/:c/claude-home/marketplaces/update {name?}        → { marketplaces }
GET    /companies/:c/claude-home/plugins                            → { installed: ClaudeCliInstalledPlugin[], available: ClaudeCliAvailablePlugin[] }
POST   /companies/:c/claude-home/plugins/install {id}               → same as GET
POST   /companies/:c/claude-home/plugins/:id/(enable|disable|update) → same as GET
DELETE /companies/:c/claude-home/plugins/:id                        → same as GET  (uninstall)
GET    /companies/:c/claude-home/plugins/:id/details                → { text }
```

Login sessions:
- A session lives in an in-process Map with a 10-minute TTL and one active
  session per server name.
- The child process is killed on timeout, cancel or complete.
- The auth URL is the first `https://` URL printed on stdout or stderr.
- CLI errors come back as 422 with the CLI's first stderr line (secrets
  redacted), except a missing binary, which is 503.

## UI: Claude Home becomes terminal-shaped tabs

Tabs (URL hash per tab):
- **MCP** (`/mcp`)
  - Every server `claude mcp list` reports, with an origin badge (Claude Code /
    plugin / claude.ai / project) and a status chip (Connected, Failed with
    reason, Needs sign-in, Pending approval).
  - Actions: Add (a form that turns into add-json), Remove (not for plugin or
    claude.ai servers; the UI says "Managed by plugin X"), Sign in / Sign out
    (the no-browser flow: open the link, paste the redirect URL), Adopt into
    Paperclip (http/sse, as before), Refresh.
  - Section "Also available through Paperclip": the company's governed
    connectors with Paperclip badges, linking to Apps.
- **Plugins** (`/plugin`), with sub-tabs as in the terminal:
  - **Discover:** search, marketplace and category filter, cards with
    Install/Installed, and a details drawer (`plugin details`: components,
    token cost).
  - **Installed:** enable/disable switch, update, uninstall, details.
  - **Marketplaces:** list, add (source field with examples `owner/repo`), update, remove.
- **Settings**, **CLAUDE.md**, **Skills & agents** (existing sections, moved into tabs).

When `cliAvailable` is false, the UI shows a banner and falls back to the
existing file-based inventory, read-only.

## Dashboard parity

- Dashboard agent cards (`RunChatSurface` → `IssueChatThread`, legacy
  `ui/src/lib/transcriptPresentation.ts`):
  - TodoWrite renders as a checklist.
  - Subagent calls get labels.
  - To support both, the pure parsers (`tool-input-shapes.ts`) move into
    `ui/src/lib/` (re-exported from the old path) so lib code can use them.
- An agent with a pending Claude permission card on its current task shows
  **Waiting for you** on its dashboard card, and the ClaudePermissionCard is
  rendered inline with the same accept/reject API.

## Tasks

1. Shared types (coordinator) → server CLI service + routes + tests (mock the
   binary with a fake script on PATH that records argv and prints fixtures).
2. UI Claude Home tabs: MCP, Plugins (Discover/Installed/Marketplaces), login
   flow, fallback.
3. Dashboard parity.
