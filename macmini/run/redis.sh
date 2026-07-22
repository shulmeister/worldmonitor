#!/bin/bash
# Launchd wrapper for the local Redis instance (Homebrew redis-server).
# Binds 127.0.0.1:$WM_REDIS_PORT (NOT 6379 — deliberate, avoids brew-services collisions).
# Data dir: $REPO_ROOT/macmini/redis-data (auto-created).
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

mkdir -p "$REPO_ROOT/macmini/redis-data"

exec /opt/homebrew/bin/redis-server \
  --port "$WM_REDIS_PORT" \
  --bind 127.0.0.1 \
  --requirepass "$REDIS_PASSWORD" \
  --maxmemory 256mb \
  --maxmemory-policy allkeys-lru \
  --appendonly yes \
  --dir "$REPO_ROOT/macmini/redis-data"
