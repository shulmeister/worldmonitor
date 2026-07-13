import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildOdpQuery,
  fetchAllPatents,
  fetchCategoryPatents,
  mapPatentApplication,
} from '../scripts/_defense-patents-source.mjs';

const H04B = { code: 'H04B', desc: 'Transmission / Communications' };

function odpRecord({
  applicationNumberText = '19123456',
  applicant = 'Raytheon Company',
  cpc = ['H04B   7/18513', 'H04W  64/00'],
  filingDate = '2026-03-05',
  publicationDate = '2026-07-09',
  publicationNumber = 'US20260197796A1',
  title = 'SATELLITE COMMUNICATION METHOD AND APPARATUS',
} = {}) {
  return {
    applicationNumberText,
    applicationMetaData: {
      applicantBag: [{ applicantNameText: applicant }],
      cpcClassificationBag: cpc,
      earliestPublicationDate: publicationDate,
      earliestPublicationNumber: publicationNumber,
      filingDate,
      firstApplicantName: applicant,
      inventionTitle: title,
    },
  };
}

describe('USPTO ODP defense-patent source', () => {
  it('builds a fielded CPC-prefix and assignee-prefix query', () => {
    const query = buildOdpQuery('H04B');

    assert.match(query, /^applicationMetaData\.cpcClassificationBag:H04B\* AND \(/);
    assert.match(query, /applicationMetaData\.firstApplicantName:Raytheon\*/);
    assert.match(query, /applicationMetaData\.firstApplicantName:Lockheed\*/);
    assert.match(query, / OR /);
    assert.doesNotMatch(query, /_begins|_text_phrase/);
  });

  it('maps ODP application metadata to the existing panel contract', () => {
    assert.deepEqual(mapPatentApplication(odpRecord(), H04B), {
      patentId: 'US20260197796A1',
      title: 'SATELLITE COMMUNICATION METHOD AND APPARATUS',
      date: '2026-03-05',
      assignee: 'Raytheon Company',
      cpcCode: 'H04B7/18513',
      cpcDesc: H04B.desc,
      abstract: '',
      url: 'https://patents.google.com/patent/US20260197796A1',
    });
  });

  it('falls back to filing/application data when a publication is not available', () => {
    const mapped = mapPatentApplication(odpRecord({
      applicationNumberText: '19999999',
      publicationDate: null,
      publicationNumber: null,
    }), H04B);

    assert.equal(mapped.patentId, '19999999');
    assert.equal(mapped.date, '2026-03-05');
    assert.equal(
      mapped.url,
      'https://data.uspto.gov/patent-file-wrapper/search/details/19999999/application-data',
    );
  });

  it('sends the API key only in the ODP header and maps the response', async () => {
    let captured;
    const patents = await fetchCategoryPatents(H04B, {
      apiKey: 'test-key',
      fetchFn: async (url, init) => {
        captured = { url: new URL(url), init };
        return new Response(JSON.stringify({ patentFileWrapperDataBag: [odpRecord()] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    });

    assert.equal(captured.url.origin, 'https://api.uspto.gov');
    assert.equal(captured.url.pathname, '/api/v1/patent/applications/search');
    assert.equal(captured.url.searchParams.get('limit'), '20');
    assert.equal(captured.url.searchParams.get('sort'), 'applicationMetaData.filingDate desc');
    assert.equal(captured.url.searchParams.has('api_key'), false);
    assert.equal(captured.init.headers['X-API-KEY'], 'test-key');
    assert.equal(patents.length, 1);
  });

  it('fails closed before making a request when USPTO_API_KEY is missing', async () => {
    let called = false;
    await assert.rejects(
      fetchCategoryPatents(H04B, {
        apiKey: '',
        fetchFn: async () => {
          called = true;
          return new Response('{}');
        },
      }),
      /USPTO_API_KEY is required/,
    );
    assert.equal(called, false);
  });

  it('keeps successful categories, deduplicates IDs, and sorts newest first', async () => {
    const categories = [H04B, { code: 'H01L', desc: 'Semiconductor devices' }, { code: 'F42B', desc: 'Ammunition / Explosives' }];
    const duplicate = { patentId: 'US1', title: 'one', date: '2026-01-01', assignee: 'A', cpcCode: 'H04B', cpcDesc: '', abstract: '', url: '' };
    const newest = { ...duplicate, patentId: 'US2', date: '2026-02-01' };

    const result = await fetchAllPatents({
      apiKey: 'test-key',
      categories,
      delayMs: 0,
      fetchCategory: async (category) => {
        if (category.code === 'H01L') throw new Error('upstream unavailable');
        return category.code === 'H04B' ? [duplicate] : [newest, duplicate];
      },
      logger: { log() {}, warn() {} },
    });

    assert.deepEqual(result.patents.map((patent) => patent.patentId), ['US2', 'US1']);
    assert.equal(result.total, 2);
    assert.match(result.fetchedAt, /^\d{4}-\d{2}-\d{2}T/);
  });
});

describe('defense-patents deployment wiring', () => {
  it('runs weekly inside the existing static-reference bundle', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(here, '..', 'scripts', 'seed-bundle-static-ref.mjs'), 'utf8');

    assert.match(source, /label:\s*'Defense-Patents'/);
    assert.match(source, /script:\s*'seed-defense-patents\.mjs'/);
    assert.match(source, /seedMetaKey:\s*'military:defense-patents'/);
    assert.match(source, /canonicalKey:\s*'patents:defense:latest'/);
    assert.match(source, /intervalMs:\s*WEEK/);
  });
});
