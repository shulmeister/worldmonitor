import { CHROME_UA, sleep } from './_seed-utils.mjs';

export const USPTO_ODP_API = 'https://api.uspto.gov/api/v1/patent/applications/search';
export const MAX_PER_CATEGORY = 20;

// Internal-only identity metadata. Symbols keep the canonical application key
// out of the published patent contract while allowing cross-category results
// to deduplicate even when one response has a publication ID and another only
// has the underlying application number.
const PATENT_IDENTITY = Symbol('patentIdentity');

// Key defense/dual-use assignees. Multi-word names use phrase matching so a
// broad prefix such as "General*" cannot pull unrelated applicants.
export const DEFENSE_ASSIGNEE_QUERIES = [
  'Raytheon*',
  'Lockheed*',
  'Northrop*',
  'Huawei*',
  'SMIC*',
  'TSMC*',
  'DARPA*',
  'Boeing*',
  'L3Harris*',
  '"General Dynamics"',
  '"BAE Systems"',
  'Thales*',
];

export const CPC_CATEGORIES = [
  { code: 'H04B', desc: 'Transmission / Communications' },
  { code: 'H01L', desc: 'Semiconductor devices' },
  { code: 'F42B', desc: 'Ammunition / Explosives' },
  { code: 'G06N', desc: 'AI / Neural networks' },
  { code: 'C12N', desc: 'Microorganisms / Biotechnology' },
];

export function buildOdpQuery(cpcCode) {
  const code = String(cpcCode ?? '').trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9]{3}$/.test(code)) {
    throw new Error(`Invalid CPC subclass: ${cpcCode}`);
  }

  const assignees = DEFENSE_ASSIGNEE_QUERIES
    .map((query) => `applicationMetaData.firstApplicantName:${query}`)
    .join(' OR ');

  return `applicationMetaData.cpcClassificationBag:${code}* AND (${assignees})`;
}

function normalizeCpc(code) {
  return String(code ?? '').replace(/\s+/g, '').toUpperCase();
}

function normalizedPatentId(id) {
  const value = String(id ?? '').replace(/\s+/g, '');
  if (!value) return '';
  return /^US/i.test(value) ? value.toUpperCase() : `US${value}`;
}

function normalizedApplicationId(id) {
  return String(id ?? '').replace(/[^a-z0-9]/gi, '').toUpperCase();
}

function normalizedDocumentId(id) {
  return String(id ?? '').replace(/\s+/g, '').toUpperCase();
}

export function mapPatentApplication(record, category) {
  const metadata = record?.applicationMetaData ?? {};
  const applicationNumber = String(record?.applicationNumberText ?? metadata.applicationNumberText ?? '').trim();
  const publicationNumber = normalizedPatentId(metadata.earliestPublicationNumber);
  const grantNumber = normalizedPatentId(metadata.patentNumber);
  const patentId = publicationNumber || grantNumber || applicationNumber;
  const date = String(metadata.filingDate ?? metadata.earliestPublicationDate ?? metadata.grantDate ?? '').trim();
  if (!patentId || !date) return null;

  const applicant = metadata.firstApplicantName
    ?? metadata.applicantBag?.[0]?.applicantNameText
    ?? '';
  const categoryCode = normalizeCpc(category?.code);

  const googlePatentId = publicationNumber || grantNumber;
  const url = googlePatentId
    ? `https://patents.google.com/patent/${encodeURIComponent(googlePatentId)}`
    : `https://data.uspto.gov/patent-file-wrapper/search/details/${encodeURIComponent(applicationNumber)}/application-data`;

  const patent = {
    patentId,
    title: String(metadata.inventionTitle ?? '').slice(0, 300),
    date,
    assignee: String(applicant).slice(0, 200),
    cpcCode: categoryCode,
    cpcDesc: String(category?.desc ?? ''),
    // Patent File Wrapper search metadata does not include abstracts. Keep the
    // field present for wire compatibility; the public contract marks it empty.
    abstract: '',
    url,
  };

  const applicationId = normalizedApplicationId(applicationNumber);
  Object.defineProperty(patent, PATENT_IDENTITY, {
    value: {
      key: applicationId ? `APPLICATION:${applicationId}` : `DOCUMENT:${normalizedDocumentId(patentId)}`,
      // Prefer the richest stable display/link representation when otherwise
      // identical application records arrive with different identifier shapes.
      rank: publicationNumber ? 2 : grantNumber ? 1 : 0,
    },
  });

  return patent;
}

function requireApiKey(apiKey) {
  const value = String(apiKey ?? '').trim();
  if (!value) throw new Error('USPTO_API_KEY is required');
  return value;
}

export async function fetchCategoryPatents(category, {
  apiKey,
  fetchFn = (...args) => globalThis.fetch(...args),
} = {}) {
  const key = requireApiKey(apiKey);
  const url = new URL(USPTO_ODP_API);
  url.searchParams.set('q', buildOdpQuery(category.code));
  url.searchParams.set('limit', String(MAX_PER_CATEGORY));
  url.searchParams.set('sort', 'applicationMetaData.filingDate desc');

  const response = await fetchFn(url.toString(), {
    headers: {
      'X-API-KEY': key,
      'User-Agent': CHROME_UA,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(20_000),
  });

  // ODP uses 404 for a valid query with zero matching records.
  if (response.status === 404) return [];
  if (!response.ok) throw new Error(`USPTO ODP HTTP ${response.status}`);

  const data = await response.json();
  const records = Array.isArray(data?.patentFileWrapperDataBag)
    ? data.patentFileWrapperDataBag
    : [];

  return records
    .map((record) => mapPatentApplication(record, category))
    .filter(Boolean);
}

export async function fetchAllPatents({
  apiKey,
  categories = CPC_CATEGORIES,
  delayMs = 3_000,
  fetchCategory = fetchCategoryPatents,
  logger = console,
} = {}) {
  const key = requireApiKey(apiKey);
  const all = [];

  for (let index = 0; index < categories.length; index++) {
    const category = categories[index];
    if (index > 0 && delayMs > 0) await sleep(delayMs);
    logger.log(`  Fetching ${category.code} (${category.desc})...`);

    try {
      const patents = await fetchCategory(category, { apiKey: key });
      logger.log(`    ${patents.length} patents`);
      all.push(...patents);
    } catch (error) {
      logger.warn(`    ${category.code}: failed (${error.message})`);
    }
  }

  const byIdentity = new Map();
  for (const patent of all) {
    const identity = patent[PATENT_IDENTITY] ?? {
      key: `DOCUMENT:${normalizedDocumentId(patent.patentId)}`,
      rank: 0,
    };
    const existing = byIdentity.get(identity.key);
    if (!existing || identity.rank > existing.identity.rank) {
      byIdentity.set(identity.key, { patent, identity });
    }
  }
  const patents = [...byIdentity.values()]
    .map(({ patent }) => patent)
    .sort((a, b) => b.date.localeCompare(a.date));

  return { patents, total: patents.length, fetchedAt: new Date().toISOString() };
}
