/**
 * Headline dedup + story-identity assignment for the news pipeline.
 * Plain JS module so it can be imported from both TS source and .mjs tests.
 *
 * #4919: similarity is delegated to shared/story-identity.js — the single
 * "same news story?" definition (previously this file carried its own
 * word-overlap>0.6 matcher, one of three inconsistent answers in the
 * codebase).
 */

import {
  storyVector,
  cosineSimilarity,
  clusterTexts,
  STORY_SIMILARITY_THRESHOLD,
} from '../../../../shared/story-identity.js';

/** @param {string[]} headlines */
export function deduplicateHeadlines(headlines) {
  const seenVectors = [];
  const unique = [];
  for (const headline of headlines) {
    const vec = storyVector(headline);
    // Unvectorizable headlines (empty/punctuation-only) can't be compared;
    // keep them rather than silently dropping content.
    const isDuplicate = vec !== null
      && seenVectors.some((seen) => cosineSimilarity(vec, seen) >= STORY_SIMILARITY_THRESHOLD);
    if (!isDuplicate) {
      if (vec !== null) seenVectors.push(vec);
      unique.push(headline);
    }
  }
  return unique;
}

/**
 * Cluster a request batch of feed items into stories and assign each item
 * its cluster's canonical identity (#4919). Replaces the exact
 * sha256(normalizeTitle) identity that forked a story on ANY wording edit
 * and deflated corroboration to verbatim-syndication-only.
 *
 * Canonical id = hash of the lexicographically smallest normalized member
 * title. Deterministic for a given batch; stable across runs while any
 * member wording keeps appearing in feeds (the common case — wire copy
 * persists for the whole 96h window). When the smallest-title member ages
 * out, the cluster mints a new id and the old story:track row orphans —
 * exactly what happened to EVERY wording variant under exact hashing, so
 * the worst case equals the old behavior and the common case consolidates.
 *
 * @template {{ title: string; source: string }} T
 * @param {T[]} items
 * @param {(title: string) => string} normalizeTitle title normalizer
 *   (strips source suffixes etc. — stays caller-owned so hash identity is
 *   unchanged for singleton clusters)
 * @param {(text: string) => Promise<string>} sha256Hex
 * @returns {Promise<Map<T, { titleHash: string; corroborationCount: number }>>}
 */
export async function assignStoryIdentity(items, normalizeTitle, sha256Hex) {
  const clusters = clusterTexts(items.map((item) => item.title || ''));
  const assignment = new Map();
  await Promise.all(clusters.map(async (indices) => {
    const canonical = indices
      .map((i) => normalizeTitle(items[i].title || ''))
      .sort()[0];
    const titleHash = await sha256Hex(canonical);
    const sources = new Set();
    for (const i of indices) {
      if (items[i].source) sources.add(items[i].source);
    }
    const corroborationCount = Math.max(1, sources.size);
    for (const i of indices) {
      assignment.set(items[i], { titleHash, corroborationCount });
    }
  }));
  return assignment;
}
