#!/bin/bash
# Launchd wrapper for the Upstash-compatible Redis REST proxy.
# Talks to local Redis on 127.0.0.1:$WM_REDIS_PORT via SRH_CONNECTION_STRING,
# requires the SRH_TOKEN bearer on every request.
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

export HOST=127.0.0.1  # loopback only — Docker published these on 127.0.0.1; native must too
export PORT="$WM_REDIS_REST_PORT"
export SRH_TOKEN="$REDIS_TOKEN"
export SRH_CONNECTION_STRING="redis://:$REDIS_PASSWORD@127.0.0.1:$WM_REDIS_PORT"

exec /opt/homebrew/bin/node docker/redis-rest-proxy.mjs
