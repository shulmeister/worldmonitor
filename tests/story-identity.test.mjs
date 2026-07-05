// shared/story-identity.js — the single "same news story?" definition
// (#4919). The labeled pair set below is the tuning ground truth for
// STORY_SIMILARITY_THRESHOLD: if you change the vectorizer, weights, or
// threshold, this suite tells you whether separation still holds.

import assert from 'node:assert/strict';
import { describe, it, afterEach } from 'node:test';
import {
  STORY_SIMILARITY_THRESHOLD,
  normalizeStoryText,
  candidateTokens,
  storyVector,
  cosineSimilarity,
  storySimilarity,
  isSameStory,
  clusterTexts,
  setStoryVectorProvider,
} from '../shared/story-identity.js';

afterEach(() => setStoryVectorProvider(null));

// ── Labeled pairs (tuning ground truth) ────────────────────────────────────
//
// POSITIVES: the edit-variant class this identity MUST merge — source
// suffixes, truncations, qualifier swaps, reorders, light morphology.
// These are the real-world corroboration killers under exact-hash identity.
const POSITIVE_PAIRS = [
  ['Fed holds interest rates steady amid inflation concerns', 'Fed holds rates steady as inflation concerns persist'],
  ['Magnitude 6.8 earthquake strikes northern Chile', '6.8-magnitude earthquake hits northern Chile'],
  ['EU approves 12th sanctions package against Russia', 'European Union approves 12th sanctions package on Russia'],
  ['Ukraine drone strike hits Russian oil refinery in Ryazan region', 'Ukraine drone strike hits Russian oil refinery'],
  ['Iran threatens to close Strait of Hormuz if US blockade continues', 'Iran threatens to close Strait of Hormuz — live updates'],
  ['Apple unveils new AI features at WWDC keynote', 'At WWDC keynote, Apple unveils new AI features'],
  ['Iranian officials threaten Hormuz closure over sanctions', 'Iran officials threaten Hormuz closure over sanctions'],
  ['Nigeria fuel subsidy protests spread to Lagos as unions join', 'Nigeria fuel subsidy protests spread to Lagos'],
  ['Turkey hikes interest rates to 50% in surprise move', 'Turkey hikes rates to 50% in surprise move'],
  ['China exports fall 7.5% in June, worse than expected', 'Chinese exports fell 7.5% in June, worse than expected'],
];

// NEGATIVES: same-topic-DIFFERENT-event pairs that must stay apart —
// entity swaps, action swaps, parameter swaps, actor-direction flips.
const NEGATIVE_PAIRS = [
  ['Iran seizes oil tanker in Strait of Hormuz', 'Iran threatens to close Strait of Hormuz'],
  ['Fed holds rates steady amid inflation concerns', 'Fed cuts rates by 25 basis points amid slowing economy'],
  ['Magnitude 6.8 earthquake strikes northern Chile', 'Magnitude 5.9 earthquake strikes southern Peru'],
  ['Ukraine drone strike hits Russian oil refinery', 'Russian drone strike hits Ukrainian energy grid'],
  ['Apple unveils new AI features at WWDC keynote', 'Google unveils new AI features at I/O keynote'],
  ['Turkey hikes interest rates to 50% in surprise move', 'Argentina hikes interest rates to 50% in surprise move'],
  ['Nigeria fuel subsidy protests spread to Lagos', 'Kenya tax protests spread to Nairobi'],
  ['US imposes new sanctions on Iranian oil exports', 'US lifts sanctions on Venezuelan oil exports'],
  ['Israel strikes Hezbollah targets in southern Lebanon', 'Hezbollah strikes Israeli positions in northern Israel'],
];

// KNOWN LIMIT (documented, deliberately NOT asserted as separable): two
// events differing by ONE unboosted content token sit above the
// threshold — "China exports fall 7.5%" vs "China imports fall 7.5%",
// "12th sanctions package" vs "13th". No lexical similarity can order
// these below genuine rewrites of one story; the 96h ingest window and
// entity-corroboration signals bound the damage. Revisit when a semantic
// provider lands behind setStoryVectorProvider.

describe('labeled-pair separation (tuning ground truth)', () => {
  it('every edit-variant positive pair clears the threshold', () => {
    for (const [a, b] of POSITIVE_PAIRS) {
      const sim = storySimilarity(a, b);
      assert.ok(
        sim >= STORY_SIMILARITY_THRESHOLD,
        `expected same-story (${sim.toFixed(3)} >= ${STORY_SIMILARITY_THRESHOLD}): "${a}" ~ "${b}"`,
      );
    }
  });

  it('every distinct-event negative pair stays below the threshold', () => {
    for (const [a, b] of NEGATIVE_PAIRS) {
      const sim = storySimilarity(a, b);
      assert.ok(
        sim < STORY_SIMILARITY_THRESHOLD,
        `expected distinct (${sim.toFixed(3)} < ${STORY_SIMILARITY_THRESHOLD}): "${a}" vs "${b}"`,
      );
    }
  });

  it('separation holds with margin on both sides (retune trip-wire)', () => {
    const minPos = Math.min(...POSITIVE_PAIRS.map(([a, b]) => storySimilarity(a, b)));
    const maxNeg = Math.max(...NEGATIVE_PAIRS.map(([a, b]) => storySimilarity(a, b)));
    assert.ok(minPos - STORY_SIMILARITY_THRESHOLD >= 0.015, `positive floor too close: ${minPos.toFixed(3)}`);
    assert.ok(STORY_SIMILARITY_THRESHOLD - maxNeg >= 0.015, `negative ceiling too close: ${maxNeg.toFixed(3)}`);
  });
});

describe('storyVector / cosineSimilarity', () => {
  it('identical texts are similarity 1', () => {
    const sim = storySimilarity('Iran threatens to close Strait of Hormuz', 'Iran threatens to close Strait of Hormuz');
    assert.ok(Math.abs(sim - 1) < 1e-9);
  });

  it('empty/garbage text yields null vector and zero similarity', () => {
    assert.equal(storyVector(''), null);
    assert.equal(storyVector('   —— !!'), null);
    assert.equal(storySimilarity('', 'Iran threatens Hormuz'), 0);
    assert.equal(cosineSimilarity(null, storyVector('Iran threatens Hormuz')), 0);
  });

  it('is symmetric', () => {
    const a = 'Fed holds rates steady amid inflation concerns';
    const b = 'Fed holds interest rates steady';
    assert.ok(Math.abs(storySimilarity(a, b) - storySimilarity(b, a)) < 1e-12);
  });

  it('unsegmented scripts (CJK) still produce vectors and match near-duplicates', () => {
    const a = '日本銀行が金利を引き上げ、市場に衝撃';
    const b = '日本銀行が金利を引き上げ';
    assert.ok(storyVector(a), 'CJK title must vectorize');
    assert.ok(storySimilarity(a, b) > storySimilarity(a, '米国大統領がメキシコ国境を視察'));
  });

  it('case-only differences do not change identity (boost is view-internal)', () => {
    const sim = storySimilarity(
      'IRAN THREATENS TO CLOSE STRAIT OF HORMUZ',
      'Iran threatens to close Strait of Hormuz',
    );
    assert.ok(sim >= STORY_SIMILARITY_THRESHOLD, `all-caps variant must merge (got ${sim.toFixed(3)})`);
  });
});

describe('clusterTexts', () => {
  it('groups edit variants and keeps distinct events apart', () => {
    const texts = [
      'Iran threatens to close Strait of Hormuz if US blockade continues',
      'Iran threatens to close Strait of Hormuz — live updates',
      'Stock market rallies on tech earnings report',
      'Iran seizes oil tanker in Strait of Hormuz',
    ];
    const clusters = clusterTexts(texts);
    const byMember = new Map();
    clusters.forEach((cluster, ci) => cluster.forEach((i) => byMember.set(i, ci)));
    assert.equal(byMember.get(0), byMember.get(1), 'variants must share a cluster');
    assert.notEqual(byMember.get(0), byMember.get(2), 'unrelated story must not join');
    assert.notEqual(byMember.get(0), byMember.get(3), 'same-topic different event must not join');
    assert.equal(clusters.flat().length, texts.length, 'every index appears exactly once');
  });

  it('is deterministic and order-stable for a fixed input', () => {
    const texts = [
      'Turkey hikes interest rates to 50% in surprise move',
      'Turkey hikes rates to 50% in surprise move',
      'Kenya tax protests spread to Nairobi',
    ];
    assert.deepEqual(clusterTexts(texts), clusterTexts(texts));
  });

  it('respects an explicit threshold override', () => {
    const texts = ['Fed holds interest rates steady', 'Fed holds rates steady'];
    assert.equal(clusterTexts(texts, { threshold: 0.999 }).length, 2);
    assert.equal(clusterTexts(texts).length, 1);
  });
});

describe('candidateTokens / normalizeStoryText', () => {
  it('drops short ASCII tokens and keeps non-ASCII with bigrams', () => {
    const toks = candidateTokens('US to cut rates 日本');
    assert.ok(!toks.has('to'));
    assert.ok(toks.has('rates'));
    assert.ok(toks.has('日本'));
    assert.ok(toks.has('日本'.slice(0, 2)));
  });

  it('normalizeStoryText strips punctuation and collapses whitespace', () => {
    assert.equal(normalizeStoryText('  Fed — holds,  rates!  '), 'fed holds rates');
  });
});

describe('setStoryVectorProvider (semantic upgrade seam)', () => {
  it('routes storyVector through the provider and restores on null', () => {
    const fixed = { u: new Float64Array(4).fill(0.5), b: new Float64Array(4).fill(0.5) };
    setStoryVectorProvider(() => fixed);
    assert.equal(storyVector('anything'), fixed);
    assert.ok(Math.abs(storySimilarity('a b c', 'x y z') - 1) < 1e-9, 'provider vectors drive similarity');
    setStoryVectorProvider(null);
    assert.notEqual(storyVector('Iran threatens Hormuz closure'), fixed);
  });
});

// ── assignStoryIdentity (list-feed-digest integration surface) ─────────────

import { createHash } from 'node:crypto';
import { assignStoryIdentity, deduplicateHeadlines } from '../server/worldmonitor/news/v1/dedup.mjs';

const sha256Hex = async (text) => createHash('sha256').update(text).digest('hex');
const normalizeTitle = (title) => title.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();

describe('assignStoryIdentity (#4919 acceptance)', () => {
  it('REGRESSION: corroboration rises when the same event arrives with different wording', async () => {
    // Under the old exact-hash identity these three wordings were three
    // separate stories with corroborationCount=1 each.
    const items = [
      { title: 'Iran threatens to close Strait of Hormuz if US blockade continues', source: 'Reuters' },
      { title: 'Iran threatens to close Strait of Hormuz — live updates', source: 'BBC' },
      { title: 'Iran threatens to close Strait of Hormuz if US blockade continues', source: 'AP' },
      { title: 'Stock market rallies on tech earnings report', source: 'CNBC' },
    ];
    const assignment = await assignStoryIdentity(items, normalizeTitle, sha256Hex);
    assert.equal(assignment.get(items[0]).corroborationCount, 3, 'three sources, three wordings, ONE story');
    assert.equal(assignment.get(items[0]).titleHash, assignment.get(items[1]).titleHash);
    assert.equal(assignment.get(items[0]).titleHash, assignment.get(items[2]).titleHash);
    assert.equal(assignment.get(items[3]).corroborationCount, 1);
    assert.notEqual(assignment.get(items[3]).titleHash, assignment.get(items[0]).titleHash);
  });

  it('singleton clusters hash exactly as the old identity (story:track keys unchanged)', async () => {
    const items = [{ title: 'Kenya tax protests spread to Nairobi', source: 'AFP' }];
    const assignment = await assignStoryIdentity(items, normalizeTitle, sha256Hex);
    assert.equal(
      assignment.get(items[0]).titleHash,
      await sha256Hex(normalizeTitle(items[0].title)),
    );
  });

  it('canonical hash is order-independent (stable across batch orderings)', async () => {
    const a = { title: 'Iran threatens to close Strait of Hormuz — live updates', source: 'BBC' };
    const b = { title: 'Iran threatens to close Strait of Hormuz', source: 'Reuters' };
    const first = await assignStoryIdentity([a, b], normalizeTitle, sha256Hex);
    const second = await assignStoryIdentity([b, a], normalizeTitle, sha256Hex);
    assert.equal(first.get(a).titleHash, second.get(a).titleHash);
  });

  it('duplicate sources within a cluster count once', async () => {
    const items = [
      { title: 'Turkey hikes interest rates to 50% in surprise move', source: 'Reuters' },
      { title: 'Turkey hikes rates to 50% in surprise move', source: 'Reuters' },
    ];
    const assignment = await assignStoryIdentity(items, normalizeTitle, sha256Hex);
    assert.equal(assignment.get(items[0]).corroborationCount, 1, 'same outlet republishing is not corroboration');
  });

  it('every item receives an assignment', async () => {
    const items = [
      { title: 'A completely unique story about lunar mining', source: 'X' },
      { title: '', source: 'Y' },
      { title: '!!!', source: 'Z' },
    ];
    const assignment = await assignStoryIdentity(items, normalizeTitle, sha256Hex);
    for (const item of items) assert.ok(assignment.get(item), `missing assignment for "${item.title}"`);
  });
});

describe('deduplicateHeadlines (shared-similarity rewrite)', () => {
  it('keeps unvectorizable headlines rather than dropping them', () => {
    const result = deduplicateHeadlines(['', '¡!', 'Fed holds rates steady']);
    assert.equal(result.length, 3);
  });
});
