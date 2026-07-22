#!/bin/bash
# Launchd wrapper for the AIS WebSocket relay (scripts/ais-relay.cjs).
# Pushes AIS stream data + Finnhub quotes through to the sidecar/browser.
# Uses the local redis-rest proxy at 127.0.0.1:$WM_REDIS_REST_PORT.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

[ -f .env ] || { echo "FATAL: $REPO_ROOT/.env missing — copy macmini/env.example" >&2; exit 1; }
set -a; source .env; set +a

# Fail fast on an unfilled .env — a CHANGE_ME REDIS_TOKEN would otherwise become
# a publicly-known bearer for the Redis REST proxy (Fable review, PR #1).
for _v in REDIS_PASSWORD REDIS_TOKEN RELAY_SHARED_SECRET LOCAL_API_TOKEN; do
  case "${!_v:-}" in
    ""|CHANGE_ME) echo "FATAL: $_v is unset or CHANGE_ME in .env" >&2; exit 1 ;;
  esac
done

# Relay resolves scripts/package.json deps (fast-xml-parser, ws, etc.) from
# scripts/node_modules — that dir is populated by deploy.sh.
cd "$REPO_ROOT/scripts"

export HOST=127.0.0.1  # loopback only — Docker published these on 127.0.0.1; native must too
export PORT="$WM_RELAY_PORT"
export UPSTASH_REDIS_REST_URL="http://127.0.0.1:$WM_REDIS_REST_PORT"
export UPSTASH_REDIS_REST_TOKEN="$REDIS_TOKEN"
export UPSTASH_ALLOW_INSECURE_HTTP=true

# RELAY_SHARED_SECRET / AISSTREAM_API_KEY / FINNHUB_API_KEY are already exported
# by `set -a` above — relay.cjs reads them straight from process.env.

exec /opt/homebrew/bin/node ais-relay.cjs
