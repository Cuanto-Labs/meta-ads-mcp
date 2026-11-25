#!/usr/bin/env bash
# Every 15 min (systemd timer / cron on the runtime host, installed in Task 1.5):
# GET /cuanto/health, which runs GET /v27.0/me. On failure, run $CUANTO_ALERT_CMD with one line on stdin.
# Env: CUANTO_HEALTH_URL (e.g. http://127.0.0.1:4421/cuanto/health), CUANTO_SERVICE_SECRET, CUANTO_ALERT_CMD.
set -euo pipefail
body=$(curl -sS -m 30 -H "Authorization: Bearer ${CUANTO_SERVICE_SECRET:?}" "${CUANTO_HEALTH_URL:?}" 2>&1) && status=0 || status=$?
if [[ $status -eq 0 && $body == *'"ok":true'* ]]; then exit 0; fi
line="meta-ads-mcp health failed on $(hostname): $(printf '%s' "$body" | tr -d '\n' | cut -c1-200)"
if [[ -n ${CUANTO_ALERT_CMD:-} ]]; then printf '%s\n' "$line" | bash -c "$CUANTO_ALERT_CMD"; else printf '%s\n' "$line" >&2; fi
exit 1
