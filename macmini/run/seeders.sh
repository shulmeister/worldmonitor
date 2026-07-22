#!/bin/bash
# One-shot seeder wrapper — invoked manually via `launchctl kickstart`, not KeepAlive.
# scripts/run-seeders.sh sources .env itself and enforces REDIS_TOKEN locally; the
# `set -a` below is defensive redundancy so the upstream wrapper fails loud if
# .env went missing between deploy and seed run.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

[ -f .env ] || { echo "FATAL: $REPO_ROOT/.env missing — copy macmini/env.example" >&2; exit 1; }
set -a; source .env; set +a

# Not exec'd: this is a one-shot — propagate the seeders' exit code to launchd
# and let the wrapper process terminate cleanly.
"$REPO_ROOT/scripts/run-seeders.sh"
