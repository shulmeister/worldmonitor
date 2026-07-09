import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  gdeltSeenDateToIso,
  buildGdeltConflictUrl,
  mapGdeltArticlesToEvents,
  GDELT_COUNTRY_NAMES,
} from '../scripts/_conflict-gdelt.mjs';
import { computeEmaWindows } from '../scripts/_ema-threat-engine.mjs';
import {
  fetchGdeltConflictEvents,
  GDELT_MIN_SUCCESSFUL_COUNTRIES,
} from '../scripts/seed-conflict-intel.mjs';

test('gdeltSeenDateToIso parses GDELT seendate formats to YYYY-MM-DD', () => {
  assert.equal(gdeltSeenDateToIso('20260709T140000Z'), '2026-07-09');
  assert.equal(gdeltSeenDateToIso('20260709140000'), '2026-07-09');
  assert.ok(Number.isFinite(Date.parse(gdeltSeenDateToIso('20260709T140000Z'))));
  // unparseable → '' (dropped downstream, never a bad Date)
  assert.equal(gdeltSeenDateToIso(''), '');
  assert.equal(gdeltSeenDateToIso('bad'), '');
  assert.equal(gdeltSeenDateToIso(null), '');
});

test('buildGdeltConflictUrl targets DOC 2.0 artlist json with the country name', () => {
  const url = buildGdeltConflictUrl('SD');
  assert.ok(url.startsWith('https://api.gdeltproject.org/api/v2/doc/doc?query='));
  assert.ok(url.includes('mode=artlist'));
  assert.ok(url.includes('format=json'));
  assert.ok(decodeURIComponent(url).includes('"Sudan"'));
});

test('mapGdeltArticlesToEvents emits {country, event_date} in the EMA-readable shape', () => {
  const articles = [
    { seendate: '20260709T140000Z', domain: 'aljazeera.com', url: 'https://x/1', title: 'a' },
    { seendate: '20260709T100000Z', domain: 'reuters.com', url: 'https://x/2', title: 'b' },
  ];
  const events = mapGdeltArticlesToEvents(articles, 'SD');
  assert.equal(events.length, 2);
  // country is the full name (matches UCDP / normalizeCountry), NOT the ISO2 code
  assert.equal(events[0].country, 'Sudan');
  // event_date is the field the EMA reads — the bug this fixes was its absence
  assert.equal(events[0].event_date, '2026-07-09');
  assert.ok('event_date' in events[0]);
});

test('mapGdeltArticlesToEvents drops articles with an unparseable seendate', () => {
  const events = mapGdeltArticlesToEvents(
    [{ seendate: '', domain: 'd' }, { seendate: 'garbage' }, { seendate: '20260709T000000Z' }],
    'YE',
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].country, 'Yemen');
});

test('mapGdeltArticlesToEvents is defensive against bad input', () => {
  assert.deepEqual(mapGdeltArticlesToEvents(null, 'SD'), []);
  assert.deepEqual(mapGdeltArticlesToEvents([{ seendate: '20260709T0000Z' }], 'ZZ'), []); // unknown cc → no name
});

test('GDELT-derived events register in the conflict EMA (end-to-end shape contract)', () => {
  // The whole point of #5099: without a valid event_date, computeEmaWindows would
  // Date.parse(undefined) → NaN → skip the event, leaving the country uncounted.
  const now = Date.parse('2026-07-09T18:00:00Z');
  const recent = new Date(now - 60 * 60 * 1000).toISOString().slice(0, 19).replace(/[-:T]/g, '') + 'Z';
  const events = mapGdeltArticlesToEvents(
    [{ seendate: recent, domain: 'd' }, { seendate: recent, domain: 'd2' }],
    'SD',
  );
  const windows = computeEmaWindows(new Map(), events, [], now);
  const sudan = [...windows.entries()].find(([c]) => String(c).toLowerCase().includes('sudan'));
  assert.ok(sudan, 'Sudan should be present in the EMA windows');
  // event_date within the 24h cutoff → counted (would be 0 if event_date were missing)
  assert.ok(sudan[1], 'Sudan window state should exist');
});

test('GDELT_COUNTRY_NAMES covers the priority conflict set with full display names', () => {
  assert.equal(GDELT_COUNTRY_NAMES.UA, 'Ukraine');
  assert.equal(GDELT_COUNTRY_NAMES.SD, 'Sudan');
  assert.equal(GDELT_COUNTRY_NAMES.CD, 'Democratic Republic of Congo');
  assert.ok(Object.keys(GDELT_COUNTRY_NAMES).length >= 20);
});

test('fetchGdeltConflictEvents fails closed when too many country fetches fail', async () => {
  let calls = 0;
  await assert.rejects(
    fetchGdeltConflictEvents({
      pace: async () => {},
      fetchCountryEvents: async (cc) => {
        calls += 1;
        if (calls < GDELT_MIN_SUCCESSFUL_COUNTRIES) {
          return { country: cc, ok: true, events: [{ country: 'Sudan', event_date: '2026-07-09' }] };
        }
        return { country: cc, ok: false, events: [], error: 'proxy unavailable' };
      },
    }),
    /coverage below floor: 15\/20 countries succeeded \(min 16\)/,
  );
});

test('fetchGdeltConflictEvents treats successful zero-article countries as coverage', async () => {
  const result = await fetchGdeltConflictEvents({
    pace: async () => {},
    fetchCountryEvents: async (cc) => ({ country: cc, ok: true, events: [] }),
  });

  assert.equal(result.events.length, 0);
  assert.equal(result.pagination.countriesSucceeded, 20);
  assert.equal(result.pagination.countriesFailed, 0);
});
