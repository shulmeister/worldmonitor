import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { OverlayHistoryManager, type OverlayHistoryEnvironment } from '../src/utils/overlay-history';

function createEnvironment() {
  const listeners = new Set<(event: PopStateEvent) => void>();
  const entries: unknown[] = [null];
  let index = 0;

  const environment: OverlayHistoryEnvironment = {
    get state() {
      return entries[index];
    },
    pushState(state) {
      entries.splice(index + 1, entries.length, structuredClone(state));
      index += 1;
    },
    replaceState(state) {
      entries[index] = structuredClone(state);
    },
    back() {
      if (index === 0) return;
      index -= 1;
      const event = { state: entries[index] } as PopStateEvent;
      listeners.forEach((listener) => listener(event));
    },
    addPopStateListener(listener) {
      listeners.add(listener);
    },
    removePopStateListener(listener) {
      listeners.delete(listener);
    },
  };

  const forward = () => {
    if (index >= entries.length - 1) return;
    index += 1;
    const event = { state: entries[index] } as PopStateEvent;
    listeners.forEach((listener) => listener(event));
  };

  return { environment, getIndex: () => index, forward };
}

describe('OverlayHistoryManager', () => {
  it('closes only the topmost overlay when browser Back is pressed', () => {
    const { environment, getIndex } = createEnvironment();
    const manager = new OverlayHistoryManager(environment);
    const closed: string[] = [];

    manager.open('menu', () => closed.push('menu'));
    manager.open('search', () => closed.push('search'));
    assert.equal(getIndex(), 2);

    environment.back();
    assert.deepEqual(closed, ['search']);
    assert.equal(manager.top(), 'menu');

    environment.back();
    assert.deepEqual(closed, ['search', 'menu']);
    assert.equal(manager.top(), null);
    manager.destroy();
  });

  it('replaces menu history when transitioning into a nested region sheet', () => {
    const { environment, getIndex } = createEnvironment();
    const manager = new OverlayHistoryManager(environment);
    const closed: string[] = [];

    manager.open('menu', () => closed.push('menu'));
    manager.replace('menu', 'region', () => closed.push('region'));
    assert.equal(getIndex(), 1, 'the transition must not require two Back presses');
    assert.equal(manager.top(), 'region');

    environment.back();
    assert.deepEqual(closed, ['region']);
    assert.equal(manager.top(), null);
    manager.destroy();
  });

  it('removes its synthetic entry when an overlay closes from its own control', () => {
    const { environment, getIndex } = createEnvironment();
    const manager = new OverlayHistoryManager(environment);
    let popCloseCalls = 0;

    manager.open('settings', () => { popCloseCalls += 1; });
    manager.close('settings');

    assert.equal(getIndex(), 0);
    assert.equal(popCloseCalls, 0, 'the caller already closed the UI');
    assert.equal(manager.top(), null);
    manager.destroy();
  });

  it('discards retained callbacks and the active marker during app teardown', () => {
    const { environment, getIndex } = createEnvironment();
    const manager = new OverlayHistoryManager(environment);
    let closeCalls = 0;

    manager.open('menu', () => { closeCalls += 1; });
    manager.reset();

    assert.equal(manager.top(), null);
    assert.equal(getIndex(), 1, 'teardown must not navigate the page');
    assert.equal((environment.state as Record<string, unknown>).__wmOverlay, undefined);
    environment.back();
    assert.equal(closeCalls, 0, 'discarded UI callbacks must not run after teardown');
    manager.destroy();
  });

  it('scrubs stale overlay markers instead of resurrecting UI on Forward', () => {
    const { environment, forward } = createEnvironment();
    const manager = new OverlayHistoryManager(environment);
    let closeCalls = 0;

    manager.open('search', () => { closeCalls += 1; });
    manager.close('search');
    forward();

    assert.equal(manager.top(), null);
    assert.equal(closeCalls, 0);
    assert.equal((environment.state as Record<string, unknown>).__wmOverlay, undefined);
    manager.destroy();
  });

  it('drains a fixed snapshot when a close callback opens another overlay', () => {
    const { environment } = createEnvironment();
    const manager = new OverlayHistoryManager(environment);
    const closed: string[] = [];

    manager.open('settings', () => {
      closed.push('settings');
      manager.open('confirm', () => closed.push('confirm'));
    });
    environment.back();

    assert.deepEqual(closed, ['settings']);
    assert.equal(manager.top(), 'confirm');
    manager.destroy();
  });
});
