#!/bin/bash
# Daily Meta Ads sync, run by systemd timer meta-ads-sync on postiz-aws.
# Memory-capped so Postiz is never starved (host has ~440 MB free): the scope kills the sync, not Postiz.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="${SYNC_ENV_FILE:-$HOME/ads-mcp/sync.env}"
set -a; . "$ENV_FILE"; set +a
cd "$DIR"
export PATH="$HOME/.local/bin:$PATH" DLT_DATA_DIR="$HOME/ads-mcp/dlt-data" DLT_PROJECT_DIR="$DIR"
exec uv run --no-dev --frozen python pipeline.py
