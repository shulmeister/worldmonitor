/**
 * Conversion-funnel instrumentation policy (#4931).
 *
 * Source-extraction guards (same pattern as other policy tests): these
 * invariants are cheap to delete silently in a refactor and expensive to
 * notice — each one going missing blinds a segment of the funnel without
 * breaking any runtime behavior.
 *
 *  1. UMAMI_DOMAINS must list www.worldmonitor.app — the apex 301s to www in
 *     production and the Umami tracker's data-domains check is an EXACT
 *     hostname match; dropping www silently disables ALL dashboard analytics
 *     on the canonical host (the pre-#4931 state).
 *  2. The typed event catalog must contain the funnel events.
 *  3. startCheckout (dashboard) fires checkout-start; the checkout-return
 *     reconciliation fires checkout-success / checkout-failed.
 *  4. The /pro SPA and welcome landing must load the tracker with www listed
 *     and the static CSP nonce, and the /pro checkout service must fire
 *     checkout-start for both the direct and post-sign-in resume paths.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

test('UMAMI_DOMAINS covers the canonical www host', () => {
  const src = read('src/services/analytics.ts');
  const m = src.match(/const UMAMI_DOMAINS = '([^']+)'/);
  assert.ok(m, 'UMAMI_DOMAINS constant not found');
  const domains = m[1].split(',');
  assert.ok(domains.includes('www.worldmonitor.app'),
    'www.worldmonitor.app missing from UMAMI_DOMAINS — analytics dead on the canonical host');
  assert.ok(domains.includes('worldmonitor.app'),
    'apex worldmonitor.app missing from UMAMI_DOMAINS');
});

test('funnel events exist in the typed catalog', () => {
  const src = read('src/services/analytics.ts');
  for (const ev of ['checkout-start', 'checkout-success', 'checkout-failed']) {
    assert.ok(src.includes(`'${ev}': true`), `event '${ev}' missing from EVENTS catalog`);
  }
});

test('dashboard checkout entry fires checkout-start', () => {
  const src = read('src/services/checkout.ts');
  assert.ok(src.includes('trackCheckoutStart(productId'),
    'startCheckout no longer fires trackCheckoutStart — funnel start is blind');
});

test('checkout-return reconciliation fires success/failed events', () => {
  const src = read('src/app/panel-layout.ts');
  assert.ok(src.includes('trackCheckoutSuccess('),
    'checkout-return success path no longer fires trackCheckoutSuccess');
  assert.ok(src.includes('trackCheckoutFailed('),
    'checkout-return failed path no longer fires trackCheckoutFailed');
});

test('/pro and welcome pages load the Umami tracker (www + nonce)', () => {
  for (const page of ['pro-test/index.html', 'pro-test/welcome.html']) {
    const html = read(page);
    const tag = html.match(/<script[^>]+abacus\.worldmonitor\.app\/script\.js[^>]*>/);
    assert.ok(tag, `${page}: Umami tracker script tag missing`);
    assert.ok(tag[0].includes('data-website-id="e8800335-c853-46a8-8497-c993ed2f58bc"'),
      `${page}: tracker website id missing/changed`);
    assert.ok(/data-domains="[^"]*www\.worldmonitor\.app/.test(tag[0]),
      `${page}: www.worldmonitor.app missing from tracker data-domains`);
    assert.ok(tag[0].includes('nonce="wm-static-bootstrap"'),
      `${page}: static CSP nonce missing — strict-dynamic CSP will block the tracker`);
  }
});

test('/pro checkout service fires checkout-start on both paths', () => {
  const src = read('pro-test/src/services/checkout.ts');
  assert.ok(src.includes("surface: 'pro-page'"),
    'pro-page checkout-start missing from startCheckout');
  assert.ok(src.includes("surface: 'pro-resume'"),
    'pro-resume checkout-start missing from tryResumeCheckoutFromUrl');
});
