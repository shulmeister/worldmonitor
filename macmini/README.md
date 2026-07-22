# World Monitor — Mac mini Native Stack

This directory holds the native (no-Docker) deployment of World Monitor on a
Mac mini. Six LaunchAgents run the stack under `launchd`, fronted by a
Cloudflare Tunnel that serves the public hostname(s).

Sibling tasks own the other files in this directory; this doc references them
without recreating them.

| File | Owner | Purpose |
| ---- | ----- | ------- |
| `web-server.mjs` | sibling | Static file server + `/api/*` reverse-proxy to the API sidecar |
| `run/redis.sh` | sibling | Wraps `redis-server` (sources `.env`) |
| `run/redis-rest.sh` | sibling | Wraps the REST shim that exposes Redis over HTTP on `:8079` |
| `run/relay.sh` | sibling | Real-time relay (WebSocket fanout) on `:3004` |
| `run/api.sh` | sibling | World Monitor API sidecar on `:46123` |
| `run/seeders.sh` | sibling | One-shot data refresher (RSS, AIS, sanctions, …) |
| `run/web.sh` | sibling | Wrapper that execs `web-server.mjs` |
| `deploy.sh` | sibling | In-place build: deps, handler bundles, corpus, tsc, vite → `dist/` |
| `env.example` | sibling | Template for `<repo>/.env` (secrets + per-host config) |
| `install-launchd.sh` | this task | Generate + lint + bootstrap the 6 LaunchAgents |

## Architecture

```
                                  ┌───────────────────────────────┐
                                  │       Cloudflare Tunnel       │
                                  │  (worldmonitor.app, tech.*,   │
                                  │   finance.*, commodity.*,     │
                                  │   happy.*, energy.*)          │
                                  └───────────────┬───────────────┘
                                                  │ HTTPS (443)
                                                  ▼
                       ┌────────────────────────────────────────────────┐
                       │  web-server.mjs  (LaunchAgent: worldmonitor-web) │
                       │  LISTEN 127.0.0.1:3040                             │
                       │  ─ static  →  <repo>/dist/                       │
                       │  ─ /api/*  ─┐                                    │
                       └─────────────┼────────────────────────────────────┘
                                     │
                                     ▼
                       ┌────────────────────────────────────────────────┐
                       │  api sidecar  (LaunchAgent: worldmonitor-api)   │
                       │  LISTEN 127.0.0.1:46123                         │
                       │  ─ talks to redis-rest, scrapers, RSS, etc.     │
                       └────┬──────────────────────────────┬─────────────┘
                            │                              │
                            ▼                              ▼
         ┌────────────────────────────────┐   ┌─────────────────────────────┐
         │  redis-rest                    │   │  relay                      │
         │  (LaunchAgent: …-redis-rest)   │   │  (LaunchAgent: …-relay)     │
         │  LISTEN 127.0.0.1:8079         │   │  LISTEN 127.0.0.1:3004        │
         │  HTTP→Redis shim               │   │  WebSocket fanout          │
         └──────────────┬─────────────────┘   └─────────────┬───────────────┘
                        │                                  │
                        ▼                                  ▼
                ┌───────────────────────────────────────────────┐
                │  redis  (LaunchAgent: worldmonitor-redis)      │
                │  LISTEN 127.0.0.1:6390                         │
                │  Stateful cache + ephemeral keys              │
                └───────────────────────────────────────────────┘

                ┌───────────────────────────────────────────────┐
                │  seeders  (LaunchAgent: worldmonitor-seeders)  │
                │  NOT a daemon — StartInterval 1800s            │
                │  Refreshes RSS/AIS/sanctions/… on a timer      │
                └───────────────────────────────────────────────┘
```

All six services are children of one repo checkout. Each wrapper script in
`macmini/run/` sources `<repo>/.env` before exec'ing its process.

## Ports

| Service     | Port   | Bind          | Purpose                              |
| ----------- | ------ | ------------- | ------------------------------------ |
| web         | 3040   | `127.0.0.1`   | Cloudflare tunnel entrypoint (cloudflared runs on this host) |
| api         | 46123  | `127.0.0.1`   | Sidecar reached only from `web`       |
| redis-rest  | 8079   | `127.0.0.1`   | HTTP→Redis shim                       |
| redis       | 6390   | `127.0.0.1`   | Redis itself                          |
| relay       | 3004   | `127.0.0.1`   | AIS relay — reached only by the sidecar (HOST=127.0.0.1) |
| seeders     | —      | —             | Timer-only, no port                   |

All ports are reachable on localhost. `web` and `relay` also bind public
addresses because the Cloudflare Tunnel dials them directly.

## Environment Variables

Secrets live in `<repo>/.env`, copied from `macmini/env.example`. The
wrappers `source` this file before launching. See `env.example` for the full
list; the must-fill entries are:

```bash
# Crypto-grade secrets — generate each once with `openssl rand -hex 32`
SESSION_SECRET=…
ENCRYPTION_KEY=…
INTERNAL_API_TOKEN=…
WEBHOOK_SIGNING_SECRET=…

# API keys (any of these missing → that feature is empty in the UI)
OPENAI_API_KEY=…          # AI synthesis
AISSTREAM_API_KEY=…       # vessel tracking
…                         # see env.example for the full set
```

If `.env` is missing, every service exits at boot — the installer will refuse
to run (see Troubleshooting).

## Install (fresh Mac mini)

```bash
# 1. Get the code
git clone <repo> ~/worldmonitor
cd ~/worldmonitor

# 2. Create the secrets file
cp macmini/env.example .env
openssl rand -hex 32   # paste into SESSION_SECRET
openssl rand -hex 32   # paste into ENCRYPTION_KEY
openssl rand -hex 32   # paste into INTERNAL_API_TOKEN
openssl rand -hex 32   # paste into WEBHOOK_SIGNING_SECRET
$EDITOR .env           # fill the API keys you actually need

# 3. Build the bundle
macmini/deploy.sh              # produces dist/, installs server bundles

# 4. Install + start the six LaunchAgents
macmini/install-launchd.sh

# 5. Seed once so the UI isn't empty
macmini/run/seeders.sh         # exits 0 when done; seeders agent will re-run every 30 min
```

Every wrapper re-sources `.env` on exec, so plain `.env` edits only need a
`launchctl kickstart -k gui/$(id -u)/<label>` of the affected services.
Re-run `install-launchd.sh` (idempotent) when you change ports/schedules
(plist content) or add `AISSTREAM_API_KEY` (it installs the relay agent).

## Update

```bash
cd ~/worldmonitor
git fetch upstream && git merge upstream/main
macmini/deploy.sh

# Restart the two services that serve traffic
launchctl kickstart -k gui/$(id -u)/com.coloradocareassist.worldmonitor-api
launchctl kickstart -k gui/$(id -u)/com.coloradocareassist.worldmonitor-web
```

`redis` and `redis-rest` only need a restart if their config changed;
`relay` reconnects automatically; `seeders` re-runs on its own timer.

## Uninstall

```bash
macmini/install-launchd.sh --uninstall
```

This bootouts and removes the six plists only — it does **not** touch any
other `com.coloradocareassist.*` LaunchAgent on the machine.

## Troubleshooting

| Symptom | Likely cause | Fix |
| ------- | ------------ | --- |
| Every service dies at boot | `<repo>/.env` missing or unreadable | `cp macmini/env.example .env && $EDITOR .env` |
| `0/55 OK health` in the UI | Seeders haven't run yet | `macmini/run/seeders.sh` once, or wait 30 min |
| Map shows no vessels | `AISSTREAM_API_KEY` unset (relay agent is skipped without it) | Add key to `.env`, re-run `macmini/install-launchd.sh` (installs + starts the relay) |
| `launchctl bootstrap` errors on a label that worked yesterday | Stale `disabled` override | `launchctl enable gui/$(id -u)/<label>` then re-run `macmini/install-launchd.sh` |
| Cloudflare tunnel 502s | `web` died | `tail -50 ~/logs/worldmonitor-web.log`, then `launchctl kickstart -k gui/$(id -u)/com.coloradocareassist.worldmonitor-web` |
| All services log "ECONNREFUSED 127.0.0.1:6390" | Redis isn't up | Check `~/logs/worldmonitor-redis.log`; the installer bootstraps in dep order so this should self-heal on next install |

### Logs

All services log to `~/logs/worldmonitor-<svc>.log` (stdout and stderr share
the same file). Tail them directly:

```bash
tail -f ~/logs/worldmonitor-{redis,redis-rest,relay,api,web,seeders}.log
```

### Restart a single service

```bash
launchctl kickstart -k gui/$(id -u)/com.coloradocareassist.worldmonitor-api
```

`kickstart -k` only rolls workers — it does **not** pick up env changes. To
re-read `.env` after editing it, re-run `macmini/install-launchd.sh` (it
bootouts + bootstraps every label).