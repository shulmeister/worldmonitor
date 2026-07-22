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

export PORT="$WM_WEB_PORT"

exec /opt/homebrew/bin/node macmini/web-server.mjs
