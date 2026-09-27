#!/usr/bin/env bash
# homelab fork: sign Paperclip's "Claude subscription" connection in with a
# long-lived `claude setup-token` token instead of `claude auth login`.
#
# Why: `claude auth login` tokens expire within hours and Paperclip keeps only the
# access token, so every agent fails ("ACP agent reported a terminal access
# failure"). Setup tokens last a year. Upstream's Connect check rejected them
# (usage endpoint 403); this fork accepts them (server/src/services/local-ai-credentials.ts).
#
# Usage, inside the Paperclip container as the app user (node):
#   scripts/homelab/claude-setup-token-login.sh <CLAUDE_CONFIG_DIR shown on the connection screen>
# then click Connect. The token is never echoed or logged.
set -euo pipefail
DIR="${1:?usage: $0 <CLAUDE_CONFIG_DIR path shown on the Paperclip connection screen>}"
case "$DIR" in */ai-local-logins/*) ;; *) echo "Expected the ai-local-logins/<id> path from the Paperclip screen, got: $DIR" >&2; exit 2;; esac
echo "Step 1/2: Claude shows a sign-in link. Keep the terminal wide so the link isn't cut; approve it, paste the code back."
claude setup-token
echo
read -rsp "Step 2/2: paste the token it printed (starts with sk-ant-), then Enter: " TOKEN; echo
[[ "$TOKEN" == sk-ant-* ]] || { echo "That doesn't look like a Claude token. Nothing saved." >&2; exit 1; }
echo "Checking the token can run Claude (one tiny prompt)..."
if ! OUT=$(CLAUDE_CODE_OAUTH_TOKEN="$TOKEN" CLAUDE_CONFIG_DIR="$(mktemp -d)" timeout 120 claude -p "Reply with exactly: OK" 2>&1); then
  echo "Claude rejected the token. Nothing saved." >&2; exit 1
fi
mkdir -p "$DIR"; umask 077
printf '{"claudeAiOauth":{"accessToken":"%s"}}\n' "$TOKEN" > "$DIR/.credentials.json"
unset TOKEN
echo "Token works (Claude replied: ${OUT:0:20}). Saved — go back to Paperclip and click Connect."
