import type { MeterResult } from './api-key-rate-limit';

export const API_OVERAGE_METER_ID = 'api.request' as const;

/** Statuses that are never billable overage even when the daily count is over
 *  allowance:
 *   - 401 / 403 — unauthenticated / unauthorized; no metered work was performed.
 *   - 429 — the enforce-mode daily refusal (#4684). That request is rejected
 *     AFTER the INCR and its meter increment is rolled back, so billing it would
 *     both charge a refused call and alias the rolled-back count onto the next
 *     served request's idempotency key. */
const NON_BILLABLE_STATUSES: ReadonlySet<number> = new Set([401, 403, 429]);

export interface ApiOverageUsageEvent {
  meterId: typeof API_OVERAGE_METER_ID;
  eventId: string;
  idempotencyKey: string;
  userId: string;
  route: string;
  method: string;
  status: number;
  usageDate: string;
  quantity: number;
  dailyCount: number;
  includedAllowance: number;
}

/**
 * Pure, disabled-by-default builder for a future Dodo overage event candidate
 * (#4560). Returns `null` unless the request is an eligible, served, over-
 * allowance paid user-API-key call. Does no I/O and never bills.
 */
export function buildApiOverageUsageEvent(input: {
  userId: string | null | undefined;
  /** Router-matched request path with NO query string (e.g.
   *  `/api/news/v1/list-feed-digest`). A trailing `?...` is stripped
   *  defensively, but callers should pass the matched route so the idempotency
   *  identity stays stable across query variants. */
  route: string;
  method: string;
  /** Terminal HTTP status of the served request. */
  status: number;
  includedAllowance: number;
  /** Phase 1 daily meter result. `usageDay` (not a fresh clock read) is the
   *  authoritative day for this event, so the day and the count come from one
   *  meter snapshot and cannot desync across a UTC-midnight boundary. */
  meter: Pick<MeterResult, 'count' | 'metered' | 'usageDay'> | null | undefined;
  isUserApiKey: boolean;
}): ApiOverageUsageEvent | null {
  const userId = normalizeNonEmpty(input.userId);
  const route = normalizeRoute(input.route);
  const method = normalizeNonEmpty(input.method)?.toUpperCase() ?? null;
  const usageDate = normalizeUsageDay(input.meter?.usageDay);
  const status = Number(input.status);
  const allowance = Number(input.includedAllowance);
  const dailyCount = Number(input.meter?.count);

  if (!input.isUserApiKey || !userId || !route || !method || !usageDate) return null;
  if (!Number.isInteger(status) || status < 100 || status >= 500) return null;
  if (NON_BILLABLE_STATUSES.has(status)) return null;
  if (!input.meter?.metered || !Number.isSafeInteger(dailyCount) || dailyCount < 1) return null;
  if (!Number.isSafeInteger(allowance) || allowance <= 0) return null;
  if (dailyCount <= allowance) return null;

  const idempotencyKey = [
    API_OVERAGE_METER_ID,
    userId,
    usageDate,
    method,
    route,
    String(status),
    String(dailyCount),
  ].join(':');

  return {
    meterId: API_OVERAGE_METER_ID,
    eventId: `wm_api_request_${stableHash(idempotencyKey)}`,
    idempotencyKey,
    userId,
    route,
    method,
    status,
    usageDate,
    quantity: 1,
    dailyCount,
    includedAllowance: allowance,
  };
}

function normalizeNonEmpty(value: string | null | undefined): string | null {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized.length > 0 ? normalized : null;
}

/** Router-matched path only: strip any query string and surrounding space. */
function normalizeRoute(value: string | null | undefined): string | null {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  const q = trimmed.indexOf('?');
  const path = (q >= 0 ? trimmed.slice(0, q) : trimmed).trim();
  return path.length > 0 ? path : null;
}

/** Accept only a strict `yyyy-mm-dd` UTC day stamp sourced from the meter. */
function normalizeUsageDay(value: string | null | undefined): string | null {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed : null;
}

function stableHash(value: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= BigInt(value.charCodeAt(i));
    hash = (hash * prime) & mask;
  }
  return hash.toString(36);
}
