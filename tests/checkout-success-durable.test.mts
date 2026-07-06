/**
 * Durable checkout-success delivery (#4934 round-2 F2).
 *
 * The entitlement watcher reloads the dashboard the moment Pro lands —
 * often before the deferred Umami queue flushes, which would silently drop
 * the terminal funnel event. Contract under test:
 *
 *   1. delivered normally → the sessionStorage marker is cleared, so a
 *      later boot replays nothing (no double-count);
 *   2. reload before delivery → the marker survives, and
 *      replayPendingCheckoutSuccess() re-emits the event (replayed:true);
 *   3. replay after successful delivery is a no-op.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

const PENDING_KEY = 'wm-checkout-success-pending';

class MemoryStorage {
  private readonly store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.has(key) ? (this.store.get(key) as string) : null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
}

type TrackedCall = { name: string; data?: Record<string, unknown> };

function installWindow(
  storage: MemoryStorage,
  opts: { withUmami: boolean },
): TrackedCall[] {
  const calls: TrackedCall[] = [];
  const fakeWindow: Record<string, unknown> = { sessionStorage: storage };
  if (opts.withUmami) {
    fakeWindow.umami = {
      track: (name: string, data?: Record<string, unknown>) => calls.push({ name, data }),
      identify: () => {},
    };
  }
  Object.defineProperty(globalThis, 'window', { configurable: true, value: fakeWindow });
  return calls;
}

describe('checkout-start product bucketing (#4934 round-4 F2)', () => {
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it('collapses unknown product ids to "unknown" and passes known ids through', async () => {
    const analytics = await import('../src/services/analytics.ts');
    analytics.resetAnalyticsForTesting();
    const calls = installWindow(new MemoryStorage(), { withUmami: true });

    analytics.trackCheckoutStart('pdt_evil_injected_via_url', true, 'dashboard-resume');
    analytics.trackCheckoutStart('pdt_0Nbtt71uObulf7fGXhQup', true);

    assert.equal(calls[0]!.data!.productId, 'unknown', 'crafted id must not reach analytics verbatim');
    assert.equal(calls[1]!.data!.productId, 'pdt_0Nbtt71uObulf7fGXhQup', 'catalog id must pass through');
  });
});

describe('durable checkout-success', () => {
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it('clears the marker on actual delivery, so nothing replays later', async () => {
    const analytics = await import('../src/services/analytics.ts');
    analytics.resetAnalyticsForTesting();
    const storage = new MemoryStorage();
    const calls = installWindow(storage, { withUmami: true });

    analytics.trackCheckoutSuccess('url-return');
    assert.deepEqual(calls, [{ name: 'checkout-success', data: { source: 'url-return' } }]);
    assert.equal(storage.getItem(PENDING_KEY), null, 'marker must clear on delivery');

    // Simulated later boot: replay must be a no-op.
    analytics.resetAnalyticsForTesting();
    const laterCalls = installWindow(storage, { withUmami: true });
    analytics.replayPendingCheckoutSuccess();
    assert.deepEqual(laterCalls, [], 'delivered event must not be double-counted');
  });

  it('replays the event on the next boot when a reload beat the queue flush', async () => {
    const analytics = await import('../src/services/analytics.ts');
    analytics.resetAnalyticsForTesting();
    const storage = new MemoryStorage();
    // No umami yet — the tracker had not loaded when the reload happened.
    installWindow(storage, { withUmami: false });

    analytics.trackCheckoutSuccess('url-return');
    assert.equal(storage.getItem(PENDING_KEY), 'url-return', 'marker must persist until delivery');

    // Reload: in-memory queue is gone, sessionStorage survives in the tab.
    analytics.resetAnalyticsForTesting();
    const calls = installWindow(storage, { withUmami: true });
    analytics.replayPendingCheckoutSuccess();

    assert.deepEqual(calls, [
      { name: 'checkout-success', data: { source: 'url-return', replayed: true } },
    ]);
    assert.equal(storage.getItem(PENDING_KEY), null, 'marker must clear once the replay delivers');
  });
});
