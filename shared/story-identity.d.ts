/**
 * Types for shared/story-identity.js — the single "same news story?"
 * similarity definition (#4919). See the .js module doc for method
 * details and tuning provenance.
 */

/** Dual-view story vector — opaque; produce with storyVector(), compare
 * with cosineSimilarity(). `u` = uniform-weight view, `b` =
 * entity/number-boosted view; similarity is the min of both cosines. */
export interface StoryVector {
  u: Float64Array;
  b: Float64Array;
}

export const STORY_SIMILARITY_THRESHOLD: number;

export function normalizeStoryText(text: string): string;
export function candidateTokens(text: string): Set<string>;
export function setStoryVectorProvider(
  provider: ((text: string) => StoryVector | null) | null,
): void;
export function storyVector(text: string): StoryVector | null;
export function cosineSimilarity(a: StoryVector | null, b: StoryVector | null): number;
export function storySimilarity(textA: string, textB: string): number;
export function isSameStory(textA: string, textB: string, threshold?: number): boolean;
export function clusterTexts(texts: string[], opts?: { threshold?: number }): number[][];
