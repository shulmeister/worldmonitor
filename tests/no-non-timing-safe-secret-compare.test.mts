/**
 * Regression for issue #3803: api/seed-contract-probe.ts used
 * `secret !== expected` for the x-probe-secret header, opening a
 * timing oracle on RELAY_SHARED_SECRET. Every other internal-auth
 * endpoint in the codebase uses the `timingSafeEqual` helper from
 * server/_shared/internal-auth.ts.
 *
 * This test scans every file under api/ for the pattern of comparing a
 * secret/token/bearer-bearing reference against an env-var value, an
 * `expected` constant, or ANOTHER secret-bearing reference via
 * `===` / `!==`, and fails if any such site exists. The fix in each
 * case is to use `timingSafeEqual` (or `authenticateInternalRequest`
 * if the header is `Authorization: Bearer …`).
 *
 * The identifier-vs-identifier arm exists because the original regex
 * required the right operand to be `process.env.*` or the bare word
 * `expected`, which meant the three most natural spellings of the bug all
 * sailed straight through:
 *   probeSecret !== expectedSecret     (`expected\b` never matches `expectedSecret`)
 *   probeSecret !== process.env.FOO    (`\bsecret\b` never matches inside `probeSecret`)
 *   secret === config.secret           (member expressions were not considered)
 * A guard that misses the natural spelling of the bug is a guard with no
 * teeth, so the meta-test below pins the matcher against an explicit
 * must-match / must-not-match table.
 *
 * The test is intentionally source-grep-based — it's runtime-independent
 * and catches the regression at lint/unit time without needing to spin
 * up the actual handler. Pattern documented in
 * ~/.claude/skills/test-ci-gotchas/reference/source-grep-regression-test-for-unexercisable-defensive-branch.md
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const apiDir = join(__dirname, '..', 'api');

// Variable-name fragments we treat as secret-bearing. Matched
// case-insensitively as a SUBSTRING of an identifier, so `secret` alone
// covers `probeSecret`, `sharedSecret`, `apiSecret`, `authSecret`,
// `RELAY_SHARED_SECRET`, … — the earlier compound entries were folded in
// when the matcher moved from whole-word to substring.
//
// Keep this list deliberate. A generic fragment like a bare `key` would
// flag `cacheKey`, `sortKey`, `redisKey` and drown the guard in noise; a
// disabled guard is worse than a narrow one.
const SECRET_VARS = ['secret', 'token', 'bearer'];

/**
 * Build the source-grep pattern. Exported so the meta-test table below
 * exercises the EXACT regex the real scan uses — a table testing a
 * copy-pasted duplicate proves nothing.
 *
 * Matches a secret-bearing reference compared with `===`/`!==` against
 * any of: `process.env.*`, a bare `expected`/`EXPECTED` constant, or
 * ANOTHER secret-bearing reference — in either operand order.
 *
 * The identifier-vs-identifier arm is the one that matters most in
 * practice: `probeSecret !== expectedSecret` is the most natural way to
 * write the #3803 bug, and the original `expected\b` right-hand arm sailed
 * straight past it because `expectedSecret` has no word boundary after
 * `expected`.
 *
 * Deliberately NOT matched: comparisons whose other operand is a string or
 * type literal (`typeof token === 'string'`), a nullish/undefined check, or
 * a plainly non-secret identifier. Those are not timing oracles on a
 * secret, and false positives get guards deleted.
 */
export function buildSecretComparePattern(fragments: readonly string[] = SECRET_VARS): RegExp {
  const varAlternation = fragments.join('|');
  // A reference whose FINAL segment carries a secret fragment: `secret`,
  // `probeSecret`, `RELAY_SHARED_SECRET`, `req.headers.token`, `a.apiSecret`.
  //
  // The lookbehind rejects `.` as well as word chars, so the match must
  // start at the head of the member chain rather than mid-identifier or
  // mid-chain. That is what keeps `dot === token.length - 1` and
  // `err.code === 'missing_secret'` unflagged: the fragment-bearing segment
  // has to be the one the operator actually applies to.
  const member = `(?:[A-Za-z0-9_$]+\\.)*`;
  const ident = `(?<![A-Za-z0-9_$.])${member}[A-Za-z0-9_$]*(?:${varAlternation})[A-Za-z0-9_$]*(?![A-Za-z0-9_$])`;
  const env = `process\\.env\\.[A-Z_a-z][A-Z_a-z0-9]*`;
  // NOTE: the operator is bracketed by `\s*`, NOT `.*`. Whitespace is the
  // only thing it can step over, so an operand that begins with a quote is
  // unreachable — `ident` can never start matching inside a string literal.
  // This is what makes `tokenType === 'bearer'` safe despite `bearer` being
  // a fragment; see the minimal pair in PATTERN_CASES.
  const op = `\\s*(?:!==|===)\\s*`;
  // Forward also covers ident-vs-ident (symmetric, so no reverse needed).
  const forward = `${ident}${op}(?:process\\.env\\.|expected\\b|EXPECTED\\b|${ident})`;
  const reverse = `(?:${env}|expected\\b|EXPECTED\\b)${op}${ident}`;
  return new RegExp(`(?:${forward}|${reverse})`, 'i');
}

/**
 * Strip JS comments so a doc comment mentioning the old pattern doesn't
 * false-positive the guard. Exported so the meta-test table runs through
 * the same normalisation the real scan applies.
 */
export function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

/**
 * The contract for the matcher: every future edit to
 * buildSecretComparePattern must keep every row green, which makes regex
 * changes provable instead of hopeful. Exported so the table can be
 * audited row-by-row from outside the test runner.
 *
 * Rows are run through stripComments() first — the same normalisation the
 * real scan applies — so the table reflects what the scan actually sees.
 */
export const PATTERN_CASES: ReadonlyArray<{ src: string; match: boolean; why: string }> = [
  // ---- MUST MATCH: env-var comparisons (the original #3803 shape).
  { src: 'secret !== expected', match: true, why: '#3803 verbatim' },
  { src: 'token === process.env.FOO', match: true, why: 'forward vs env' },
  { src: 'if (sharedSecret !== process.env.RELAY_SHARED_SECRET) return', match: true, why: 'forward vs env, camelCase var' },
  // ---- MUST MATCH: reverse / yoda ordering (added by PR #3820 review).
  { src: 'process.env.RELAY_SHARED_SECRET === secret', match: true, why: 'yoda vs env' },
  { src: 'if (process.env.FOO !== token) return', match: true, why: 'yoda vs env' },
  { src: 'EXPECTED === bearer', match: true, why: 'yoda vs EXPECTED constant' },
  // ---- MUST MATCH: identifier-vs-identifier, the most natural way to
  // write the bug. `expected\b` never matched `expectedSecret`, so the
  // guard used to sail straight past all four of these.
  { src: 'probeSecret !== expectedSecret', match: true, why: 'ident vs ident' },
  { src: 'expectedSecret === probeSecret', match: true, why: 'ident vs ident, reversed' },
  { src: 'relaySharedSecret !== expectedSharedSecret', match: true, why: 'ident vs ident, both compound' },
  { src: 'token === expectedToken', match: true, why: 'ident vs ident, bare left operand' },
  // ---- MUST MATCH: compound secret name vs env var. `\b(?:secret)\b`
  // never matched inside `probeSecret`, so this shape leaked too.
  { src: 'if (probeSecret !== process.env.RELAY_SHARED_SECRET) return', match: true, why: 'compound name vs env' },
  { src: 'process.env.CRON_SECRET === incomingToken', match: true, why: 'compound name vs env, reversed' },
  { src: 'apiSecret !== process.env.API_SECRET', match: true, why: 'compound name still covered after fragment collapse' },
  { src: 'authSecret === expected', match: true, why: 'compound name still covered after fragment collapse' },
  // ---- MUST MATCH: member expressions. The secret often arrives as a
  // property (`req.headers`, a config object), not a bare local.
  { src: 'if (secret === config.secret) return', match: true, why: 'member expression on the right' },
  { src: 'if (req.headers.token !== expectedToken) return', match: true, why: 'member expression on the left' },
  { src: 'if (a.apiSecret === b.apiSecret) return', match: true, why: 'member expression on both sides' },

  // ---- MUST NOT MATCH: the correct idiom.
  { src: 'timingSafeEqual(secret, expectedSecret)', match: false, why: 'the CORRECT idiom — never flag it' },
  // ---- MUST NOT MATCH: presence / nullish checks.
  { src: 'if (!secret) return unauthorized()', match: false, why: 'presence check' },
  { src: 'secret == null', match: false, why: 'loose nullish check, not a comparison of values' },
  { src: 'token !== undefined', match: false, why: 'undefined is not secret-bearing' },
  { src: 'secret === null', match: false, why: 'null is not secret-bearing' },
  // ---- MUST NOT MATCH: comparisons against string / type literals.
  { src: "typeof token === 'string'", match: false, why: 'classic trap: type check, not a secret compare' },
  { src: 'typeof secret !== "string"', match: false, why: 'type check, double-quoted' },
  { src: "if (scheme.toLowerCase() !== 'bearer') return", match: false, why: 'scheme literal, not a secret value' },
  { src: "tokenType === 'bearer'", match: false, why: 'secret-ish name compared to a literal' },
  // Minimal pair isolating the quote as the discriminator: identical
  // source but for the quotes. The operator sub-pattern ends in `\s*`,
  // which cannot step over a `'`, so a quoted right operand can never
  // begin an ident match. Reviewers reasonably suspect the fragment
  // inside 'bearer' is reachable — these two rows prove it is not.
  { src: 'tokenType === bearerValue', match: true, why: 'UNQUOTED operand: a real ident-vs-ident compare' },
  { src: "tokenType === 'bearerValue'", match: false, why: 'same line quoted: a literal, unreachable by the matcher' },
  // ---- MUST NOT MATCH: non-secret right operand.
  { src: 'token === idx', match: false, why: 'second identifier is plainly not secret-bearing' },
  { src: 'if (tokenCount === 0) return', match: false, why: 'numeric literal' },
  { src: 'tokens.length === expectedLength', match: false, why: 'length compare — neither operand is the secret' },
  // ---- MUST NOT MATCH: real lines from api/ that the member-expression
  // arm must not sweep up. Each of these is a live source line today.
  { src: "const mcpTokenId = typeof raw.mcpTokenId === 'string' ? raw.mcpTokenId : ''", match: false, why: 'api/_oauth-token.js:79 — type check on a member expression' },
  { src: "if (typeof token !== 'string' || token.length === 0) return", match: false, why: 'api/_mcp-grant-hmac.ts:86 — type + length check' },
  { src: 'if (dot <= 0 || dot === token.length - 1) return', match: false, why: 'api/_mcp-grant-hmac.ts:88 — index compare against token.length' },
  { src: "if (err.code === 'missing_secret') return", match: false, why: "api/brief/…:167 — string literal that merely contains 'secret'" },
  { src: "if (action !== 'rotate-secret') return", match: false, why: 'api/v2/shipping/…:60 — action literal, not a secret value' },
  { src: "if (grantType === 'refresh_token') {", match: false, why: 'api/oauth/token.ts:725 — grant-type literal containing "token"' },
  { src: "if (action === 'create-pairing-token') {", match: false, why: 'api/notification-channels.ts:239 — action literal containing "token"' },
  { src: 'if (i !== tokens.length - 1) return null', match: false, why: 'api/_notification-webhook-ssrf.ts:60 — index compare' },
  // ---- MUST NOT MATCH: innocuous baseline.
  { src: 'const secret = "abc"', match: false, why: 'assignment, not comparison' },
  { src: 'if (status === 200) return', match: false, why: 'no secret operand' },
  { src: 'userInput !== sanitizedInput', match: false, why: 'no secret operand' },
  { src: 'return process.env.FOO', match: false, why: 'no comparison' },
  // ---- MUST NOT MATCH: comments are stripped before matching.
  { src: '// legacy: secret !== expectedSecret', match: false, why: 'line comment is stripped' },
  { src: '/* was: probeSecret !== expectedSecret */', match: false, why: 'block comment is stripped' },
];

// Files that legitimately compare these against constants for reasons
// other than auth (e.g. test fixtures, config validation).
// Empty for now — the test starts strict; add documented exceptions if
// they come up with a comment explaining why the timing oracle doesn't
// apply.
const ALLOWLIST_FILES: ReadonlySet<string> = new Set([]);

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir)) {
    const full = join(dir, entry);
    const s = await stat(full);
    if (s.isDirectory()) {
      // Skip vendored / generated subdirs.
      if (entry === 'node_modules' || entry === '.next' || entry === 'dist') continue;
      out.push(...await walk(full));
    } else if (/\.(ts|js|mjs|cjs)$/.test(entry) && !/\.test\.[mc]?[jt]s$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

describe('no non-timing-safe secret comparison in api/ (#3803)', () => {
  it('no `<secretish> (===|!==) (process.env.* | expected* | <secretish>)` comparison exists in any api/ source', async () => {
    const files = await walk(apiDir);
    const violations: string[] = [];

    // See buildSecretComparePattern for the shapes this matches. The
    // meta-test below pins the full must-match / must-not-match table.
    const pattern = buildSecretComparePattern();

    for (const file of files) {
      const rel = file.slice(file.indexOf('/api/') + 1);
      if (ALLOWLIST_FILES.has(rel)) continue;
      const source = await readFile(file, 'utf8');
      if (pattern.test(stripComments(source))) {
        violations.push(rel);
      }
    }

    assert.deepEqual(
      violations,
      [],
      `Non-timing-safe secret comparison detected in: ${violations.join(', ')}. ` +
        `Use timingSafeEqual from server/_shared/internal-auth.ts instead. See issue #3803.`,
    );
  });

  it('api/seed-contract-probe.ts uses timingSafeEqual for x-probe-secret (#3803 specific)', async () => {
    const source = await readFile(
      new URL('../api/seed-contract-probe.ts', import.meta.url),
      'utf8',
    );
    // Must import the helper.
    assert.match(
      source,
      /import\s*\{[^}]*\btimingSafeEqual\b[^}]*\}\s*from\s*['"][^'"]*internal-auth/,
      'seed-contract-probe.ts must import timingSafeEqual from internal-auth',
    );
    // Must invoke it for the x-probe-secret comparison.
    assert.match(
      source,
      /await\s+timingSafeEqual\s*\(\s*secret/,
      'seed-contract-probe.ts must call timingSafeEqual(secret, ...) for the x-probe-secret check',
    );
  });

  it('meta: the source-grep regex matches exactly the intended shapes', () => {
    const pattern = buildSecretComparePattern();

    const failures: string[] = [];
    for (const { src, match, why } of PATTERN_CASES) {
      const actual = pattern.test(stripComments(src));
      if (actual !== match) {
        failures.push(
          `  ${actual ? 'MATCHED but must not' : 'MISSED but must match'}: ${JSON.stringify(src)}  (${why})`,
        );
      }
    }

    assert.deepEqual(
      failures,
      [],
      `secret-compare pattern table mismatches:\n${failures.join('\n')}\n`,
    );
  });
});
