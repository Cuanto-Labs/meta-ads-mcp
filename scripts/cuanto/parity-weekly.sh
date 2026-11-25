#!/usr/bin/env bash
# m6-2 LaunchAgent com.cuanto.meta-mcp-parity, Mon 9:00 ET. (1) scripts/parity.mjs (exit 1 = the reference has a tool
# we do not cover), (2) Graph/Marketing API changelog: a version above DEFAULT_META_API_VERSION means a new release.
# Either one sends ONE WhatsApp line via dev-m6. CUANTO_PARITY_DRY=1 prints instead of sending.
set -uo pipefail
repo="${CUANTO_REPO:-$HOME/coding/meta-ads-mcp}"
export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin
cd "$repo" || exit 2
notes=()
if [[ -z ${META_OFFICIAL_MCP_TOKEN:-} ]] && command -v secret >/dev/null; then META_OFFICIAL_MCP_TOKEN=$(secret get META_OFFICIAL_MCP_TOKEN 2>/dev/null || true); export META_OFFICIAL_MCP_TOKEN; fi
line=$(node scripts/parity.mjs 2>&1) || notes+=("parity: ${line:0:200}")
echo "$line"
pinned=$(grep -o 'v[0-9]\{2\}\.0' src/meta/api-version.ts | head -1)
latest=$(for u in https://developers.facebook.com/docs/marketing-api/marketing-api-changelog https://developers.facebook.com/docs/graph-api/changelog; do
  timeout 180 "$HOME/coding/scripts/web-get" "$u" 2>/dev/null; done | grep -o -E 'v[0-9]{2}\.0' | sort -V | tail -1)
echo "graph version: pinned=${pinned:-?} latest_on_changelog=${latest:-unreadable}"
if [[ -n $pinned && -n $latest && $(printf '%s\n%s\n' "$pinned" "$latest" | sort -V | tail -1) != "$pinned" ]]; then
  notes+=("Meta shipped Graph $latest, fork pinned to $pinned")
fi
(( ${#notes[@]} )) || exit 0
msg="Meta Ads MCP parity watch: ${notes[*]}. See docs/PARITY.md in Cuanto-Labs/meta-ads-mcp."
if [[ ${CUANTO_PARITY_DRY:-} == 1 ]]; then echo "$msg"; exit 1; fi
# the chat id lives on dev-m6 (~/.config/meta-ads-mcp/alert-to), not in this public repo
printf '%s' "$msg" | ssh dev-m6 'to=$(cat ~/.config/meta-ads-mcp/alert-to) && python3 ~/.claude/skills/wa/bin/waload.py --session main-personal send "$to" "$(cat)" --yes' >/dev/null 2>&1
exit 1
