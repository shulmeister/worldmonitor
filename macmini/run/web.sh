#!/bin/bash
# Launchd wrapper for the static-frontend web server (macmini/web-server.mjs).
# Serves the built dist/ + reverse-proxies /api to the sidecar on LOCAL_API_PORT.
#
# NOTE: web-server.mjs is built/installed by a sibling task. This wrapper just
# execs it — if the file is missing the launchd job will surface that as a
# load failure, which is the intended signal to run deploy.sh + the sibling.
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

# web-server.mjs reads WM_WEB_PORT (already exported by `set -a` above);
# it does not honor PORT, so no extra export here.
exec /opt/homebrew/bin/node macmini/web-server.mjs
