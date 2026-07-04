import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  API_OVERAGE_METER_ID,
  buildApiOverageUsageEvent,
} from '../server/_shared/api-overage-billing.ts';

const DAY = new Date(Date.UTC(2026, 6, 4, 15, 30, 0));

function build(overrides: Partial<Parameters<typeof buildApiOverageUsageEvent>[0]> = {}) {
  return buildApiOverageUsageEvent({
    userId: 'user_123',
    route: '/api/news/v1/list-feed-digest',
    method: 'get',
    status: 200,
    includedAllowance: 1000,
    meter: { count: 1001, metered: true },
    date: DAY,
    isUserApiKey: true,
    ...overrides,
  });
}

describe('#4560 — API overage billable usage event contract', () => {
  it('returns null while the daily count is at or below the included allowance', () => {
    assert.equal(build({ meter: { count: 1000, metered: true } }), null);
    assert.equal(build({ meter: { count: 999, metered: true } }), null);
  });

  it('creates one billable api.request event for an over-allowance request', () => {
    const event = build();

    assert.ok(event);
    assert.equal(event.meterId, API_OVERAGE_METER_ID);
    assert.equal(event.userId, 'user_123');
    assert.equal(event.route, '/api/news/v1/list-feed-digest');
    assert.equal(event.method, 'GET');
    assert.equal(event.status, 200);
    assert.equal(event.usageDate, '2026-07-04');
    assert.equal(event.quantity, 1);
    assert.equal(event.dailyCount, 1001);
    assert.equal(event.includedAllowance, 1000);
    assert.match(event.eventId, /^wm_api_request_[0-9a-z]+$/);
    assert.match(
      event.idempotencyKey,
      /^api\.request:user_123:2026-07-04:GET:\/api\/news\/v1\/list-feed-digest:200:1001$/,
    );
  });

  it('does not bill 5xx responses', () => {
    assert.equal(build({ status: 500 }), null);
    assert.equal(build({ status: 503 }), null);
  });

  it('requires a counted user API-key request', () => {
    assert.equal(build({ userId: '' }), null);
    assert.equal(build({ isUserApiKey: false }), null);
    assert.equal(build({ meter: { count: 1001, metered: false } }), null);
    assert.equal(build({ meter: { count: 1001.5, metered: true } }), null);
    assert.equal(build({ includedAllowance: -1 }), null);
    assert.equal(build({ includedAllowance: 1000.5 }), null);
  });

  it('uses stable idempotency material for the same request count', () => {
    const first = build();
    const second = build();
    const nextCount = build({ meter: { count: 1002, metered: true } });

    assert.ok(first);
    assert.ok(second);
    assert.ok(nextCount);
    assert.equal(first.eventId, second.eventId);
    assert.equal(first.idempotencyKey, second.idempotencyKey);
    assert.notEqual(first.eventId, nextCount.eventId);
  });
});
