const OVERLAY_STATE_KEY = '__wmOverlay';

type OverlayMarker = {
  id: string;
  token: string;
};

type OverlayEntry = OverlayMarker & {
  closeFromHistory: () => void;
};

export interface OverlayHistoryEnvironment {
  readonly state: unknown;
  pushState(state: unknown): void;
  replaceState(state: unknown): void;
  back(): void;
  addPopStateListener(listener: (event: PopStateEvent) => void): void;
  removePopStateListener(listener: (event: PopStateEvent) => void): void;
}

function markerFromState(state: unknown): OverlayMarker | null {
  if (!state || typeof state !== 'object') return null;
  const marker = (state as Record<string, unknown>)[OVERLAY_STATE_KEY];
  if (!marker || typeof marker !== 'object') return null;
  const { id, token } = marker as Partial<OverlayMarker>;
  return typeof id === 'string' && typeof token === 'string' ? { id, token } : null;
}

function withMarker(state: unknown, marker: OverlayMarker): Record<string, unknown> {
  const base = state && typeof state === 'object' ? state as Record<string, unknown> : {};
  return { ...base, [OVERLAY_STATE_KEY]: marker };
}

function withoutMarker(state: unknown): Record<string, unknown> {
  const base = state && typeof state === 'object' ? state as Record<string, unknown> : {};
  const { [OVERLAY_STATE_KEY]: _discarded, ...rest } = base;
  return rest;
}

/**
 * Gives mobile sheets a single browser-history stack. UI close controls remove
 * their synthetic entry; browser Back closes only the overlay above the state
 * being returned to. The manager deliberately owns no DOM so menu, search,
 * settings, map popup, and deep-dive surfaces all share the same semantics.
 */
export class OverlayHistoryManager {
  private entries: OverlayEntry[] = [];
  private readonly listeners = new Set<(top: string | null) => void>();
  private nextToken = 0;
  private readonly handlePopState = (event: PopStateEvent): void => {
    const destination = markerFromState(event.state);
    const destinationIndex = destination
      ? this.entries.findIndex((entry) => entry.token === destination.token)
      : -1;

    if (destination && destinationIndex === -1) {
      // Forward navigation must not resurrect UI that no longer exists.
      this.environment.replaceState(withoutMarker(event.state));
      return;
    }

    const closing = this.entries.splice(destinationIndex + 1).reverse();
    for (const entry of closing) entry.closeFromHistory();
    this.notify();
  };

  constructor(private readonly environment: OverlayHistoryEnvironment) {
    this.environment.addPopStateListener(this.handlePopState);
  }

  public open(id: string, closeFromHistory: () => void): void {
    const existingIndex = this.entries.findIndex((entry) => entry.id === id);
    if (existingIndex >= 0) {
      const existing = this.entries[existingIndex];
      if (existing) existing.closeFromHistory = closeFromHistory;
      return;
    }
    const entry: OverlayEntry = {
      id,
      token: `wm-overlay-${++this.nextToken}`,
      closeFromHistory,
    };
    this.entries.push(entry);
    this.environment.pushState(withMarker(this.environment.state, { id: entry.id, token: entry.token }));
    this.notify();
  }

  public replace(fromId: string, id: string, closeFromHistory: () => void): void {
    const top = this.entries[this.entries.length - 1];
    if (!top || top.id !== fromId) {
      this.open(id, closeFromHistory);
      return;
    }
    const entry: OverlayEntry = {
      id,
      token: `wm-overlay-${++this.nextToken}`,
      closeFromHistory,
    };
    this.entries[this.entries.length - 1] = entry;
    this.environment.replaceState(withMarker(this.environment.state, { id: entry.id, token: entry.token }));
    this.notify();
  }

  public close(id: string): void {
    const index = this.entries.findIndex((entry) => entry.id === id);
    if (index === -1) return;
    const [entry] = this.entries.splice(index, 1);
    if (!entry) return;
    const current = markerFromState(this.environment.state);
    if (index === this.entries.length && current?.token === entry.token) {
      this.environment.back();
    }
    this.notify();
  }

  public top(): string | null {
    return this.entries[this.entries.length - 1]?.id ?? null;
  }

  public subscribe(listener: (top: string | null) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public reset(): void {
    this.entries = [];
    if (markerFromState(this.environment.state)) {
      this.environment.replaceState(withoutMarker(this.environment.state));
    }
    this.notify();
  }

  public destroy(): void {
    this.reset();
    this.environment.removePopStateListener(this.handlePopState);
    this.listeners.clear();
  }

  private notify(): void {
    const top = this.top();
    this.listeners.forEach((listener) => listener(top));
  }
}

function browserEnvironment(): OverlayHistoryEnvironment {
  if (typeof window === 'undefined') {
    return {
      state: null,
      pushState() {},
      replaceState() {},
      back() {},
      addPopStateListener() {},
      removePopStateListener() {},
    };
  }
  return {
    get state() {
      return window.history.state;
    },
    pushState(state) {
      window.history.pushState(state, '', window.location.href);
    },
    replaceState(state) {
      window.history.replaceState(state, '', window.location.href);
    },
    back() {
      window.history.back();
    },
    addPopStateListener(listener) {
      window.addEventListener('popstate', listener);
    },
    removePopStateListener(listener) {
      window.removeEventListener('popstate', listener);
    },
  };
}

export const overlayHistory = new OverlayHistoryManager(browserEnvironment());
