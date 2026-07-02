#!/usr/bin/env node
/**
 * Desktop main-thread attribution harness (#4539 / U1+U2).
 *
 * Loads /dashboard under desktop emulation and attributes:
 *   - long tasks (PerformanceObserver 'longtask') by source — reuses the mobile
 *     harness's pure functions (#4443).
 *   - the main-thread trace, decomposed by event name, so the opaque Lighthouse
 *     "Other" bucket is broken open (Layout / HitTest / EventDispatch / GC /
 *     native RunTask document work) — the #4539 gap.
 *
 * The pure attribution/decomposition functions are exported and unit-tested with
 * fixtures (deterministic, CI-safe). Playwright is loaded lazily so importing this
 * module for its helpers never launches a browser.
 *
 * Why (KTD3, #4486): the desktop lab host is contention-contaminated (the same
 * URL scores 28/57/85). Trust the *relative decomposition* (proportions) + the
 * long-task structure — both stable run-to-run. Take absolute desktop timings
 * from a clean host (PSI-desktop / a clean machine), not the lab.
 *
 * Usage:
 *   node scripts/measure-desktop-mainthread.mjs [url] [--cpu 1] [--settle 15000] [--json]
 *   (default url: https://worldmonitor.app/dashboard)
 */
import { pathToFileURL } from 'node:url';
import { summarizeLongTasks } from './measure-mobile-mainthread.mjs';

function round(n) {
  return Math.round((Number(n) || 0) * 10) / 10;
}

// Map DevTools trace event names to the Lighthouse mainthread-work-breakdown
// groups. Any name NOT here falls into "other" — which is exactly the bucket
// #4539 needs opened, so "other" keeps its per-name breakdown.
const CATEGORY_BY_NAME = {
  // Script evaluation
  FunctionCall: 'scriptEval', EvaluateScript: 'scriptEval', 'v8.compile': 'scriptEval',
  'v8.run': 'scriptEval', RunMicrotasks: 'scriptEval', V8Execute: 'scriptEval',
  // Style & Layout
  Layout: 'styleLayout', UpdateLayoutTree: 'styleLayout', UpdateLayerTree: 'styleLayout',
  InvalidateLayout: 'styleLayout', ScheduleStyleRecalculation: 'styleLayout',
  RecalculateStyles: 'styleLayout',
  // Rendering / paint
  Paint: 'rendering', PrePaint: 'rendering', Layerize: 'rendering', PaintImage: 'rendering',
  CompositeLayers: 'rendering', 'Composite Layers': 'rendering', RasterTask: 'rendering',
  Commit: 'rendering',
  // Garbage collection
  MinorGC: 'gc', MajorGC: 'gc', 'V8.GCScavenger': 'gc', 'V8.GCFinalizeMC': 'gc',
  'V8.GCIncrementalMarking': 'gc',
  // Parse
  ParseHTML: 'parse', ParseAuthorStyleSheet: 'parse',
};

/** The renderer main-thread tid, from the trace's `thread_name` metadata (CrRendererMain). */
export function findMainThreadTid(traceEvents) {
  for (const e of Array.isArray(traceEvents) ? traceEvents : []) {
    if (e?.ph === 'M' && e?.name === 'thread_name' && e?.args?.name === 'CrRendererMain') {
      return e.tid;
    }
  }
  return null;
}

/**
 * Self-time per complete ('X') event on the main thread. Self-time = duration
 * minus the duration of directly-nested children, so a RunTask containing a
 * Layout isn't double-counted. Returns a Map(event -> selfMs). Pure.
 */
export function computeSelfTimes(events) {
  const list = (Array.isArray(events) ? events : [])
    .filter((e) => e && e.ph === 'X' && typeof e.ts === 'number' && typeof e.dur === 'number');
  // Parents sort before their children: earlier ts first, and for equal ts the
  // longer (containing) event first.
  const sorted = list.slice().sort((a, b) => a.ts - b.ts || b.dur - a.dur);
  const self = new Map();
  const stack = [];
  for (const e of sorted) {
    self.set(e, e.dur);
    while (stack.length && stack[stack.length - 1].ts + stack[stack.length - 1].dur <= e.ts) {
      stack.pop();
    }
    const parent = stack[stack.length - 1];
    if (parent) self.set(parent, self.get(parent) - e.dur);
    stack.push(e);
  }
  return self;
}

/**
 * Decompose main-thread trace events into the Lighthouse category groups, with
 * the residual "other" bucket broken out by event name (the #4539 deliverable).
 * `mainThreadTid` defaults to the CrRendererMain thread found in the trace.
 * Durations are microseconds in the trace → reported as ms. Pure.
 */
export function decomposeTraceEvents(traceEvents, opts = {}) {
  const events = Array.isArray(traceEvents) ? traceEvents : [];
  const tid = opts.mainThreadTid ?? findMainThreadTid(events);
  const mainEvents = tid == null ? events : events.filter((e) => e?.tid === tid);
  const self = computeSelfTimes(mainEvents);

  const byCategory = { scriptEval: 0, styleLayout: 0, rendering: 0, gc: 0, parse: 0, other: 0 };
  const otherByName = new Map();
  let totalUs = 0;
  for (const [event, selfUs] of self.entries()) {
    if (!(selfUs > 0)) continue;
    totalUs += selfUs;
    const category = CATEGORY_BY_NAME[event.name] || 'other';
    byCategory[category] += selfUs;
    if (category === 'other') {
      otherByName.set(event.name, (otherByName.get(event.name) || 0) + selfUs);
    }
  }

  const usToMs = (us) => round(us / 1000);
  const pct = (us) => (totalUs ? round((us / totalUs) * 100) : 0);
  const totalMs = usToMs(totalUs);
  return {
    totalMs,
    byCategory: Object.fromEntries(
      Object.entries(byCategory).map(([k, us]) => [k, { ms: usToMs(us), pct: pct(us) }]),
    ),
    // The "Other" decomposition, ranked — the sub-buckets #4539 wants surfaced.
    otherBreakdown: [...otherByName.entries()]
      .map(([name, us]) => ({ name, ms: usToMs(us), pct: pct(us) }))
      .sort((a, b) => b.ms - a.ms),
  };
}

export function parseArgs(argv) {
  const args = { url: 'https://worldmonitor.app/dashboard', cpu: 1, settle: 15000, json: false };
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--cpu') {
      const n = Number(rest[++i]);
      if (!Number.isNaN(n)) args.cpu = n;
    } else if (a === '--settle') {
      const n = Number(rest[++i]);
      if (!Number.isNaN(n)) args.settle = n;
    } else if (a === '--json') {
      args.json = true;
    } else if (!a.startsWith('--')) {
      args.url = a;
    }
  }
  return args;
}

/** Live capture (best-effort). Desktop viewport; captures longtasks + a CDP trace. */
async function measure(url, { cpu = 1, settle = 15000 } = {}) {
  const { chromium } = await import('@playwright/test');
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const client = await context.newCDPSession(page);
    if (cpu > 1) {
      try {
        await client.send('Emulation.setCPUThrottlingRate', { rate: cpu });
      } catch {
        /* CDP throttle unavailable — continue at host speed */
      }
    }
    await page.addInitScript(() => {
      window.__longtasks = [];
      try {
        new PerformanceObserver((list) => {
          for (const e of list.getEntries()) {
            window.__longtasks.push({
              name: e.name,
              duration: e.duration,
              startTime: e.startTime,
              attribution: (e.attribution || []).map((a) => ({
                name: a.name,
                containerType: a.containerType,
                containerName: a.containerName,
                containerSrc: a.containerSrc,
              })),
            });
          }
        }).observe({ type: 'longtask', buffered: true });
      } catch {
        /* longtask unsupported */
      }
    });
    // Category-filtered tracing keeps the payload reviewable while retaining the
    // devtools.timeline events decomposeTraceEvents classifies. Default
    // transferMode (ReportEvents) delivers events via Tracing.dataCollected —
    // must NOT be ReturnAsStream, which delivers via an IO stream handle instead.
    await client.send('Tracing.start', {
      traceConfig: { includedCategories: ['devtools.timeline', 'disabled-by-default-devtools.timeline', '__metadata'] },
    });
    await page.goto(url, { waitUntil: 'load', timeout: 60000 });
    await page.waitForTimeout(settle);
    const traceEvents = await collectTrace(client);
    const longtasks = await page.evaluate(() => window.__longtasks || []);
    return { url, cpu, longtasks, traceEvents };
  } finally {
    await browser.close();
  }
}

/** Drain the CDP tracing stream into a traceEvents array. */
async function collectTrace(client) {
  const events = [];
  const done = new Promise((resolve) => {
    client.on('Tracing.dataCollected', (payload) => {
      if (Array.isArray(payload?.value)) events.push(...payload.value);
    });
    client.on('Tracing.tracingComplete', () => resolve());
  });
  await client.send('Tracing.end');
  await done;
  return events;
}

/** Build the structured report (pure — exported for tests). */
export function buildReport(result) {
  return {
    url: result?.url,
    cpu: result?.cpu,
    tasks: summarizeLongTasks(result?.longtasks),
    mainThread: decomposeTraceEvents(result?.traceEvents),
  };
}

function printHuman(report) {
  const { tasks, mainThread } = report;
  console.log(`\nDesktop main-thread attribution — ${report.url} (CPU ${report.cpu}x)\n`);
  console.log(
    `Long tasks: ${tasks.taskCount} (${tasks.longTaskCount} >50ms) · total ${tasks.totalMs}ms · TBT ${tasks.tbtMs}ms`,
  );
  for (const r of tasks.ranked) {
    console.log(`  ${String(r.source).padEnd(28)} TBT ${String(r.tbtMs).padStart(7)}ms  (${r.count}× · max ${r.maxMs}ms)`);
  }
  console.log(`\nMain-thread by category (${mainThread.totalMs}ms total, proportions are the stable signal):`);
  for (const [cat, v] of Object.entries(mainThread.byCategory)) {
    console.log(`  ${cat.padEnd(14)} ${String(v.ms).padStart(8)}ms  (${v.pct}%)`);
  }
  console.log('\n"Other" decomposed by event (the #4539 black box):');
  for (const r of mainThread.otherBreakdown.slice(0, 12)) {
    console.log(`  ${String(r.name).padEnd(26)} ${String(r.ms).padStart(8)}ms  (${r.pct}%)`);
  }
  console.log('');
}

async function main() {
  const args = parseArgs(process.argv);
  const result = await measure(args.url, { cpu: args.cpu, settle: args.settle });
  const report = buildReport(result);
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else printHuman(report);
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
