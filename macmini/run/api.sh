#!/bin/bash
# Launchd wrapper for the Tauri sidecar API server (local-api-server.mjs).
# Runs from REPO_ROOT so resourceDir (= process.cwd()) resolves api/ and data/
# next to it — the sidecar looks for ${resourceDir}/api and ${resourceDir}/data.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

[ -f .env ] || { echo "FATAL: $REPO_ROOT/.env missing — copy macmini/env.example" >&2; exit 1; }
set -a; source .env; set +a

export LOCAL_API_PORT
export LOCAL_API_MODE
export LOCAL_API_CLOUD_FALLBACK
export LOCAL_API_TOKEN
export UPSTASH_REDIS_REST_URL
export UPSTASH_REDIS_REST_TOKEN="$REDIS_TOKEN"
export WS_RELAY_URL="http://127.0.0.1:$WM_RELAY_PORT"

exec /opt/homebrew/bin/node src-tauri/sidecar/local-api-server.mjs
