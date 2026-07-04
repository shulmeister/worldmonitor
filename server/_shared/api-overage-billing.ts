import type { MeterResult } from './api-key-rate-limit';

export const API_OVERAGE_METER_ID = 'api.request' as const;

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

export function buildApiOverageUsageEvent(input: {
  userId: string | null | undefined;
  route: string;
  method: string;
  status: number;
  includedAllowance: number;
  meter: Pick<MeterResult, 'count' | 'metered'> | null | undefined;
  date?: Date;
  isUserApiKey: boolean;
}): ApiOverageUsageEvent | null {
  const userId = normalizeNonEmpty(input.userId);
  const route = normalizeNonEmpty(input.route);
  const method = normalizeNonEmpty(input.method)?.toUpperCase() ?? null;
  const status = Number(input.status);
  const allowance = Number(input.includedAllowance);
  const dailyCount = Number(input.meter?.count);

  if (!input.isUserApiKey || !userId || !route || !method) return null;
  if (!Number.isInteger(status) || status >= 500) return null;
  if (!input.meter?.metered || !Number.isSafeInteger(dailyCount) || dailyCount < 1) return null;
  if (!Number.isSafeInteger(allowance) || allowance <= 0) return null;
  if (dailyCount <= allowance) return null;

  const usageDate = formatUsageDate(input.date);
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

function formatUsageDate(date?: Date): string {
  const d = date && Number.isFinite(date.valueOf()) ? date : new Date();
  return d.toISOString().slice(0, 10);
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
