#!/usr/bin/env bash
# dev-m6 LaunchAgent com.cuanto.meta-ads-mcp-health, every 15 min: probes both public hosts through Cloudflare
# Access with the service token (secrets read live from the vault, never stored). On failure sends ONE WhatsApp
# line to the chat id in ~/.config/meta-ads-mcp/alert-to (kept out of this public repo) (repeat alerts suppressed for 2 h). CUANTO_EDGE_DRY=1 prints instead of sending.
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
S="$HOME/coding/scripts/secretd.py"
stamp="$HOME/.cache/meta-ads-mcp-edge.stamp"; mkdir -p "$(dirname "$stamp")"
fails=""
for env in prod dev; do
  host=ads-mcp.cuantolabs.com; [[ $env == dev ]] && host=ads-mcp-dev.cuantolabs.com
  b="env/cuanto-ads-$env"
  out=$(CUANTO_HEALTH_URL="https://$host/cuanto/health" \
    CUANTO_SERVICE_SECRET=$(python3 "$S" field "$b" CUANTO_SERVICE_SECRET | tr -d '\n') \
    CF_ACCESS_CLIENT_ID=$(python3 "$S" field "$b" CF_ACCESS_CLIENT_ID | tr -d '\n') \
    CF_ACCESS_CLIENT_SECRET=$(python3 "$S" field "$b" CF_ACCESS_CLIENT_SECRET | tr -d '\n') \
    CUANTO_ALERT_CMD='cat' "$here/health-check.sh" 2>&1) || fails="$fails $env: ${out:0:160};"
  [[ ${CUANTO_EDGE_FORCE_FAIL:-} == "$env" ]] && fails="$fails $env: forced test failure;"
done
if [[ -z $fails ]]; then rm -f "$stamp"; exit 0; fi
msg="Cuanto Ads Meta service check failed:$fails Check: ssh postiz-aws docker ps (ads-mcp-prod, ads-mcp-dev) and systemctl status cloudflared-ads-mcp."
if [[ ${CUANTO_EDGE_DRY:-} == 1 ]]; then echo "$msg"; exit 1; fi
now=$(date +%s); last=$(cat "$stamp" 2>/dev/null || echo 0)
[[ $last =~ ^[0-9]+$ ]] || last=0
if [[ -z ${CUANTO_EDGE_FORCE_FAIL:-} ]] && (( now - last < 7200 )); then exit 1; fi
to=$(cat "${CUANTO_ALERT_TO_FILE:-$HOME/.config/meta-ads-mcp/alert-to}" 2>/dev/null) || exit 1
python3 "$HOME/.claude/skills/wa/bin/waload.py" --session main-personal send "$to" "$msg" --yes >/dev/null 2>&1 && echo "$now" > "$stamp"
exit 1
