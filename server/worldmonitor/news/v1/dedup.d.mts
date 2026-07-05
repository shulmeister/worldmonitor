/** Types for dedup.mjs (plain JS so .mjs tests can import it directly). */

export function deduplicateHeadlines(headlines: string[]): string[];

export function assignStoryIdentity<T extends { title: string; source: string }>(
  items: T[],
  normalizeTitle: (title: string) => string,
  sha256Hex: (text: string) => Promise<string>,
): Promise<Map<T, { titleHash: string; corroborationCount: number }>>;
