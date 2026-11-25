#!/usr/bin/env bash
# postiz-aws, run by ads-mcp-health.timer (root, every 15 min): local /cuanto/health of both containers.
# Alert = fleet ntfy topic, same channel as postiz-guard (NTFY_FLEET_TOPIC from /etc/postiz-guard.env). The
# WhatsApp line comes from the dev-m6 edge probe (scripts/cuanto/edge-watch.sh), which also covers tunnel + Access.
# own-svc: ntfy here is our own alert channel.
set -uo pipefail
[[ -r /etc/postiz-guard.env ]] && . /etc/postiz-guard.env
dir=/home/ubuntu/ads-mcp
rc=0
for pair in prod:4421 dev:4422; do
  env=${pair%%:*}; port=${pair##*:}
  (
    set -a; . "$dir/$env.env"; set +a
    export CUANTO_HEALTH_URL="http://127.0.0.1:$port/cuanto/health"
    export CUANTO_ALERT_CMD='msg=$(cat); [ -n "${NTFY_FLEET_TOPIC:-}" ] && curl -fsS -m 10 -H "Title: ads-mcp" -H "Priority: high" -d "$msg" "https://ntfy.sh/${NTFY_FLEET_TOPIC}" >/dev/null 2>&1; echo "$msg" >&2'
    "$dir/health-check.sh"
  ) || rc=1
done
exit $rc
