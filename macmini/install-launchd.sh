#!/usr/bin/env bash
# macmini/install-launchd.sh — generate, lint, and bootstrap worldmonitor LaunchAgents.
#
# Six services, in dependency order:
#   redis → redis-rest → relay → api → web → seeders
#
# Long-running (KeepAlive):        redis, redis-rest, relay, api, web
# One-shot refresher (StartInterval): seeders (every 1800s)
#
# Usage:
#   macmini/install-launchd.sh             # install + bootstrap
#   macmini/install-launchd.sh --uninstall # bootout + delete plists
#
# Idempotent: safe to re-run; existing services are bootout'd before bootstrap.

set -euo pipefail

# ---------- resolve paths (works regardless of cwd) ----------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
LOG_DIR="$HOME/logs"
LAUNCH_DOMAIN="gui/$(id -u)"
LABEL_PREFIX="com.coloradocareassist.worldmonitor"

# ---------- service definitions (dependency order) ----------
SERVICES=(redis redis-rest relay api web seeders)

# Long-running service ports (informational status check).
# NOTE: bash 3.2 (Apple-shipped) lacks `declare -A`, so map svc→port via case.
port_for() {
  case "$1" in
    redis)      printf '6390\n' ;;
    redis-rest) printf '8079\n' ;;
    relay)      printf '3004\n' ;;
    api)        printf '46123\n' ;;
    web)        printf '3040\n' ;;
    *)          return 1 ;;
  esac
}

# mode_for: only `seeders` is a one-shot refresher; everything else is long-lived.
mode_for() {
  case "$1" in
    seeders) printf 'oneshot\n' ;;
    *)       printf 'long\n' ;;
  esac
}

# ---------- helpers ----------
die() { printf 'install-launchd: %s\n' "$*" >&2; exit 1; }

# Emit a plist to stdout. $1=label  $2=abs wrapper  $3=mode  $4=abs repo root.
write_plist() {
  local label="$1" wrapper="$2" mode="$3" repo="$4"
  cat <<XML
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${label}</string>
	<key>ProgramArguments</key>
	<array>
		<string>/bin/bash</string>
		<string>${wrapper}</string>
	</array>
	<key>RunAtLoad</key>
	<true/>
	<key>WorkingDirectory</key>
	<string>${repo}</string>
	<key>StandardOutPath</key>
	<string>${LOG_DIR}/${label##*.}.log</string>
	<key>StandardErrorPath</key>
	<string>${LOG_DIR}/${label##*.}.log</string>
XML

  if [[ "$mode" == "long" ]]; then
    cat <<XML
	<key>KeepAlive</key>
	<true/>
XML
  else
    cat <<XML
	<key>KeepAlive</key>
	<false/>
	<key>StartInterval</key>
	<integer>1800</integer>
XML
  fi

  cat <<XML
</dict>
</plist>
XML
}

# Bootstrap a single label with stale-disabled override recovery.
bootstrap_label() {
  local label="$1" plist="$2"
  # Stale processes: best-effort bootout (no error if not loaded).
  launchctl bootout "$LAUNCH_DOMAIN/$label" 2>/dev/null || true
  sleep 1
  if ! launchctl bootstrap "$LAUNCH_DOMAIN" "$plist" 2>/dev/null; then
    # Stale disabled overrides survive reboots; flip it and try once more.
    launchctl enable "$LAUNCH_DOMAIN/$label" 2>/dev/null || true
    launchctl bootstrap "$LAUNCH_DOMAIN" "$plist" \
      || die "failed to bootstrap $label — check 'launchctl print $LAUNCH_DOMAIN/$label'"
  fi
}

# Print the post-install status table (informational; never fail).
print_status_table() {
  printf '\n=== worldmonitor launchd status ===\n'
  printf '%-50s %-7s %-7s\n' "LABEL" "PID" "STATE"
  printf '%-50s %-7s %-7s\n' "----" "---" "-----"
  local line label pid status
  # `launchctl list` tab-separates: PID Status Label
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    pid="${line%%	*}"; rest="${line#*	}"
    status="${rest%%	*}"; label="${rest#*	}"
    case "$label" in
      com.coloradocareassist.worldmonitor.*) ;;
      *) continue ;;
    esac
    printf '%-50s %-7s %-7s\n' "$label" "$pid" "$status"
  done < <(launchctl list 2>/dev/null | grep -E "^[-\t0-9]+\t[0-9]+\tcom\.coloradocareassist\.worldmonitor\." || true)

  printf '\n=== port checks ===\n'
  printf '%-12s %-6s %s\n' "SERVICE" "PORT" "STATUS"
  printf '%-12s %-6s %s\n' "-------" "----" "------"
  local svc port mark
  for svc in "${SERVICES[@]}"; do
    if ! port="$(port_for "$svc")"; then continue; fi
    mark="WAIT"
    if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
      mark="OK"
    fi
    printf '%-12s %-6s %s\n' "$svc" "$port" "$mark"
  done
  printf '\nlogs: %s/worldmonitor-*.log\n' "$LOG_DIR"
}

# ---------- uninstall path ----------
if [[ "${1:-}" == "--uninstall" ]]; then
  printf 'Uninstalling worldmonitor launchd services...\n'
  for svc in "${SERVICES[@]}"; do
    label="$LABEL_PREFIX-$svc"
    launchctl bootout "$LAUNCH_DOMAIN/$label" 2>/dev/null || true
    rm -f "$LAUNCH_AGENTS_DIR/$label.plist"
    printf '  removed %s\n' "$label"
  done
  printf 'Done.\n'
  exit 0
fi

# ---------- install path ----------
command -v plutil >/dev/null 2>&1 || die "plutil not found (required for plist lint)"

[[ -f "$REPO_ROOT/.env" ]] || die "missing $REPO_ROOT/.env — copy macmini/env.example first"

mkdir -p "$LOG_DIR" "$LAUNCH_AGENTS_DIR"

# Pre-flight: all six wrappers must exist; fail fast with a clear list.
missing=()
for svc in "${SERVICES[@]}"; do
  wrapper="$REPO_ROOT/macmini/run/$svc.sh"
  [[ -x "$wrapper" ]] || missing+=("$wrapper")
done
if (( ${#missing[@]} > 0 )); then
  printf 'install-launchd: missing or non-executable wrappers:\n' >&2
  for w in "${missing[@]}"; do printf '  - %s\n' "$w" >&2; done
  die "sibling-task wrappers must be in place before install (see macmini/README.md)"
fi

# Generate + write all six plists.
printf 'Generating plists in %s\n' "$LAUNCH_AGENTS_DIR"
for svc in "${SERVICES[@]}"; do
  mode="$(mode_for "$svc")"
  label="$LABEL_PREFIX-$svc"
  plist="$LAUNCH_AGENTS_DIR/$label.plist"
  wrapper="$REPO_ROOT/macmini/run/$svc.sh"
  write_plist "$label" "$wrapper" "$mode" "$REPO_ROOT" > "$plist"
done

# Lint ALL plists before touching launchctl — fail fast on any malformed XML.
printf 'Linting plists...\n'
failed=()
for svc in "${SERVICES[@]}"; do
  label="$LABEL_PREFIX-$svc"
  plist="$LAUNCH_AGENTS_DIR/$label.plist"
  if plutil -lint "$plist" >/dev/null 2>&1; then
    printf '  ok  %s\n' "$label"
  else
    printf '  FAIL %s\n' "$label"
    plutil -lint "$plist" || true
    failed+=("$plist")
  fi
done
if (( ${#failed[@]} > 0 )); then
  die "${#failed[@]} plist(s) failed lint — not touching launchctl"
fi

# Bootstrap in dependency order.
printf 'Bootstrapping in dependency order...\n'
for svc in "${SERVICES[@]}"; do
  label="$LABEL_PREFIX-$svc"
  plist="$LAUNCH_AGENTS_DIR/$label.plist"
  printf '  bootstrap %s\n' "$label"
  bootstrap_label "$label" "$plist"
done

# Informational status table — exit 0 even if ports aren't up yet.
print_status_table
exit 0