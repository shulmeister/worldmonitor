#!/bin/bash
# Launchd wrapper: AI news insights + LLM importance (seed-insights.mjs).
#
# WHY THIS EXISTS (self-host gap): seed-insights needs the news digest cached in
# Redis, which it normally warms by calling list-feed-digest — but that call
# requires ?public=1 (which it doesn't send) or a product API key, so in a keyless
# self-host it 401s to the cloud and writes nothing. The relay (ais-relay.cjs) is
# the other producer that keeps the digest warm + does LLM classification, but it
# hard-exits without AISSTREAM_API_KEY. So until the relay runs, this wrapper warms
# the digest from the LOCAL public endpoint (proxy injects LOCAL_API_TOKEN), then
# runs seed-insights, which reads the fresh digest and classifies via the
# OLLAMA_* provider (MiniMax-Text-01) → writes news:insights:v1 (the AI Insights
# panel data, served via the public bootstrap).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

[ -f .env ] || { echo "FATAL: $REPO_ROOT/.env missing — copy macmini/env.example" >&2; exit 1; }
set -a; source .env; set +a

# Fail fast on an unfilled .env (same guard the other wrappers use).
for _v in REDIS_PASSWORD REDIS_TOKEN LOCAL_API_TOKEN; do
  case "${!_v:-}" in
    ""|CHANGE_ME) echo "FATAL: $_v is unset or CHANGE_ME in .env" >&2; exit 1 ;;
  esac
done

# seed-insights reads Redis via the REST proxy, and warms the digest from API_BASE_URL.
export UPSTASH_REDIS_REST_URL="http://127.0.0.1:${WM_REDIS_REST_PORT:-8079}"
export UPSTASH_REDIS_REST_TOKEN="$REDIS_TOKEN"
export API_BASE_URL="${API_BASE_URL:-http://127.0.0.1:${WM_WEB_PORT:-3040}}"

WEB="http://127.0.0.1:${WM_WEB_PORT:-3040}"

# 1. Warm the EN + ZH digests via the LOCAL public endpoint. The web-server proxy
#    injects LOCAL_API_TOKEN on the private hop, and ?public=1 uses the keyless
#    public tier — so this succeeds where seed-insights' own cloud warm 401s.
#    The digest caches with a ~15-min TTL, well within one seed-insights run.
for lang in en zh; do
  code=$(/usr/bin/curl -s -m 90 -o /dev/null -w '%{http_code}' \
    "${WEB}/api/news/v1/list-feed-digest?variant=full&lang=${lang}&public=1" || echo 000)
  echo "[insights] warmed ${lang} digest -> HTTP ${code}"
done

# 2. Run the seeder. It reads the fresh digest, classifies via OLLAMA_* (MiniMax),
#    and writes news:insights:v1. Non-fatal on failure — the panel keeps the last
#    good insights until the next run.
exec /opt/homebrew/bin/node scripts/seed-insights.mjs
