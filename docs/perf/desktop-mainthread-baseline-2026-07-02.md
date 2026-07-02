# Desktop main-thread baseline — 2026-07-02 (#4539)

The committed desktop main-thread attribution for the render axis (`#4487`). The desktop sibling of
`docs/perf/mobile-mainthread-baseline-2026-06-27.md` (#4443). Its point: **decompose the
uncharacterized "Other" bucket** (52% of desktop main-thread per #4539) so the render axis is driven
by evidence, not the scriptEval proxy.

## How to measure

Two signals, same contamination discipline as mobile (**KTD3 / #4486** — the local lab host 4×-amplifies
CPU contention; the same URL scores 28/57/85, so **absolute times are indicative, not authoritative —
trust the proportions + structure**, both stable run-to-run):

1. **Attribution → `scripts/measure-desktop-mainthread.mjs`** (this harness — Playwright desktop
   viewport + a CDP `devtools.timeline` trace). It reports long-task-by-source (reused from the mobile
   harness) **and** decomposes the main-thread trace by event name — including breaking open "Other".
   Self-time subtracts nested children, so a `RunTask` containing a `Layout` isn't double-counted.
2. **Authoritative absolutes → PSI-desktop / a clean host.** As on mobile, take absolute TBT /
   `mainthread-work` from a zero-contention host, not this lab.

```bash
node scripts/measure-desktop-mainthread.mjs https://worldmonitor.app/dashboard --cpu 1 --settle 12000 --json
# --cpu 4 for a throttled pass; the proportions hold across throttle levels.
```

## Captured baseline (2026-07-02, `/dashboard`, unthrottled fast host — proportions authoritative)

Main-thread self-time total: **8,579 ms** (this run; the host is fast + unthrottled, so absolutes are
far below the #4539 lab figure of 21.3 s — **the proportions are the signal**, and they match the
issue's Lighthouse split: "Other" ~47% here vs ~52% there).

| Category | ms | % | Owner / note |
|---|---|---|---|
| **Other** (decomposed below) | 4,056 | **47.3%** | the #4539 black box — now opened |
| **Style & Layout** | 2,485 | **29.0%** | forced-reflow — **owned by #4536** |
| Rendering (paint/composite/raster) | 1,713 | 20.0% | — |
| Script Evaluation | 269 | 3.1% | **confirms scriptEval is NOT the desktop cost** |
| Parse | 54 | 0.6% | — |
| Garbage Collection | 2 | 0.0% | — |

### "Other" decomposed by event (the deliverable)

| Event | ms | % of main-thread | Actionable? |
|---|---|---|---|
| **`RunTask`** (top-level task self-time) | 3,122 | **36.4%** | This is the "~9 s document task" #4539 described — browser task-scheduling / native work *not* attributed to any named child. Not app JS. Reducing it = fewer/smaller top-level tasks (yield/batch) — overlaps **#4537 INP**. |
| `HandlePostMessage` | 296 | 3.5% | worker/message-channel traffic — audit volume |
| **`IntersectionObserverController::computeIntersections`** | 173 | 2.0% | **cleanest new lever** — the viewport/lazy-load observers recompute intersections on scroll/layout; likely over-observing |
| `UpdateLayer` | 110 | 1.3% | compositor layer churn |
| `v8.evaluateModule` | 86 | 1.0% | module eval (ties to the #4571 bundle work) |
| `FireIdleCallback` / `TimerFire` | ~72 | 0.8% | deferred work firing |
| `HitTest`, `EventDispatch`, GC-scavenger | ~90 | ~1.0% | small; not levers |

## Findings → follow-ups (the #4539 acceptance)

1. **The desktop render axis is real and script-eval is not it** (3.1%). The cost is `RunTask`
   self-time (36%) + Style&Layout (29%) + Rendering (20%). The open scriptEval/bytes campaign is not
   where the time is — **confirmed by attribution**, as the issue predicted.
2. **`RunTask` self-time (36%) is the "9 s document task"** — top-level task overhead, browser-internal.
   The lever is fewer/smaller synchronous top-level tasks (yield-to-main / batching), which is the
   **#4537 INP** axis; cross-linked rather than a new lever here.
3. **Style & Layout (29%)** → **#4536** (forced reflow) already owns it; no duplicate filed.
4. **`IntersectionObserverController::computeIntersections` (2%)** is the cleanest *new* actionable
   sub-bucket → **filed as a sized follow-up** (audit the viewport/lazy observers for over-firing).

> Re-run on a clean host (or PSI-desktop) for authoritative absolute ms before sizing a fix by
> absolute time; the proportions above are stable and sufficient to pick the lever.
