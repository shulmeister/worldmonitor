#!/bin/bash
# =============================================================================
# World Monitor — Mac-mini native deploy (no Docker)
# =============================================================================
# Mirrors the Dockerfile builder stage so the same artifacts land on a Mac-mini
# LaunchAgent stack as would have landed in the Docker image.
#
# Steps (kept in lock-step with Dockerfile lines 11–28):
#   1. npm ci --ignore-scripts            (skip blog-site postinstall)
#   2. (cd scripts && npm install)        (relay deps: fast-xml-parser, ws, …)
#   3. node docker/build-handlers.mjs     (TS API handlers → self-contained JS)
#   4. npm run build:crawlable-corpus
#   5. npm run build:content-corpus
#   6. npx tsc
#   7. npx vite build                     (→ dist/)
#
# Idempotent: safe to re-run after a `git pull`. NEVER restarts services,
# NEVER runs seeders — those are separate launchd jobs.
# =============================================================================

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# Echo a stage with elapsed seconds, fail-loud on any non-zero exit.
run_stage() {
  local label="$1"; shift
  echo
  echo "▶ $label"
  local start
  start=$(date +%s)
  "$@"
  local elapsed=$(( $(date +%s) - start ))
  echo "✓ $label  (${elapsed}s)"
}

run_stage "npm ci --ignore-scripts" \
  npm ci --ignore-scripts

run_stage "npm install --no-save redis@4 (redis-rest proxy dep — mirrors docker/Dockerfile.redis-rest)" \
  npm install --no-save redis@4 --no-audit --no-fund

run_stage "scripts/ npm install (relay deps)" \
  bash -c "cd scripts && npm install --no-audit --no-fund"

run_stage "docker/build-handlers.mjs (TS → self-contained JS)" \
  /opt/homebrew/bin/node docker/build-handlers.mjs

run_stage "npm run build:crawlable-corpus" \
  npm run build:crawlable-corpus

run_stage "npm run build:content-corpus" \
  npm run build:content-corpus

run_stage "npx tsc" \
  npx tsc

run_stage "npx vite build  → dist/dashboard.html" \
  npx vite build

echo
echo "deploy complete — restart services via macmini/install-launchd.sh (sibling task)"
