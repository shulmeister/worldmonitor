// #5231 — static guard for the seed-bundle-resilience-validation container's
// dependency contract.
//
// Dockerfile.seed-bundle-resilience-validation installs EXACTLY ONE npm
// package: tsx (as the ESM loader — never imported by code). Everything the
// bundle's member scripts reach — scripts/ helpers, and the ../server/*.ts
// modules they dynamic-import through the tsx loader — must therefore resolve
// using node: builtins and repo files only. ESM resolves a module's full
// static import closure eagerly, so ONE bare npm specifier anywhere in that
// closure crashes the cron with ERR_MODULE_NOT_FOUND even if the importing
// code path never runs.
//
// That is exactly how #5229 broke this bundle: server/_shared/usage.ts (deep
// in the closure via redis.ts) gained a static import of ./rate-limit, whose
// own static imports pull @upstash/ratelimit — declared only in the ROOT
// package.json, absent from the container. The seeder never calls the rate
// limiter; it crashed anyway, at resolution time.
//
// Scope notes (kept deliberately aligned with the crash mechanics):
//  - Static `import`/`export ... from` edges are followed and enforced.
//  - `import type` / `export type` edges are skipped (tsx erases them).
//  - Dynamic import() literals are followed only when they resolve into
//    server/ — the bundle members execute those unconditionally (loading the
//    scorers IS their job). Other dynamic imports and require() calls of bare
//    specifiers are conditional/lazy and cannot be classified statically, so
//    they are not enforced here.
//  - Relative require() literals in .cjs/.mjs helpers are followed so their
//    static closures stay covered (e.g. _seed-utils.mjs eagerly
//    createRequire()s _proxy-utils.cjs).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join, resolve, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isBuiltin } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const scriptsDir = join(root, 'scripts');
const serverDir = join(root, 'server');

// Bare npm specifiers installed in the container image. Keep in lockstep with
// the `npm install` line in Dockerfile.seed-bundle-resilience-validation.
// tsx is intentionally NOT listed: it is the loader, and code importing tsx
// directly would be a smell this guard should surface.
const CONTAINER_INSTALLED_PACKAGES = new Set([]);

function isFile(p) {
  return existsSync(p) && statSync(p).isFile();
}

// Resolve a relative specifier the way node+tsx would inside the container.
function resolveRelative(fromFile, spec) {
  const base = resolve(dirname(fromFile), spec);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.mts`,
    `${base}.js`,
    `${base}.mjs`,
    `${base}.cjs`,
    join(base, 'index.ts'),
    join(base, 'index.js'),
    join(base, 'index.mjs'),
  ];
  // TS-style: an explicit .js specifier may map to a .ts source.
  if (spec.endsWith('.js')) candidates.push(base.replace(/\.js$/, '.ts'));
  if (spec.endsWith('.mjs')) candidates.push(base.replace(/\.mjs$/, '.mts'));
  return candidates.find(isFile) ?? null;
}

// Extract import edges from one source file. Anchored to line starts so
// commented-out imports don't count.
function extractEdges(src) {
  const staticSpecs = [];
  const dynamicSpecs = [];
  const requireSpecs = [];

  // import ... from '...' (multi-line safe; skips `import type`)
  for (const m of src.matchAll(/^[ \t]*import\s+(?!type\s)[^'";]*?\bfrom\s*['"]([^'"]+)['"]/gms)) {
    staticSpecs.push(m[1]);
  }
  // side-effect: import '...'
  for (const m of src.matchAll(/^[ \t]*import\s*['"]([^'"]+)['"]/gm)) {
    staticSpecs.push(m[1]);
  }
  // export { ... } from '...' / export * from '...' (skips `export type`)
  for (const m of src.matchAll(/^[ \t]*export\s+(?!type\b)(?:\*(?:\s+as\s+\w+)?|\{[^}]*\})\s*from\s*['"]([^'"]+)['"]/gms)) {
    staticSpecs.push(m[1]);
  }
  // dynamic import('...') literals
  for (const m of src.matchAll(/\bimport\(\s*['"]([^'"]+)['"]/g)) {
    dynamicSpecs.push(m[1]);
  }
  // require('...') literals (createRequire in .mjs, plain require in .cjs)
  for (const m of src.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    requireSpecs.push(m[1]);
  }
  return { staticSpecs, dynamicSpecs, requireSpecs };
}

function isBare(spec) {
  return !spec.startsWith('.') && !spec.startsWith('/');
}

// Walk the container-reachable graph from the bundle's member scripts.
// Returns bare-specifier violations and unresolvable relative imports, each
// with the import chain from a member script for debuggability.
function walkContainerGraph(memberFiles) {
  const parent = new Map(); // file -> importing file
  const visited = new Set();
  const queue = [...memberFiles];
  const violations = [];
  const unresolved = [];

  const chainOf = (file) => {
    const chain = [];
    for (let f = file; f; f = parent.get(f)) chain.unshift(relative(root, f));
    return chain.join('\n    -> ');
  };

  while (queue.length > 0) {
    const file = queue.shift();
    if (visited.has(file)) continue;
    visited.add(file);
    if (extname(file) === '.json') continue; // data, no imports

    const src = readFileSync(file, 'utf-8');
    const { staticSpecs, dynamicSpecs, requireSpecs } = extractEdges(src);

    const followRelative = (spec) => {
      const resolved = resolveRelative(file, spec);
      if (!resolved) {
        unresolved.push(`'${spec}' imported from\n    ${chainOf(file)}`);
        return;
      }
      if (!visited.has(resolved) && !parent.has(resolved)) parent.set(resolved, file);
      queue.push(resolved);
    };

    for (const spec of staticSpecs) {
      if (isBare(spec)) {
        if (!isBuiltin(spec) && !CONTAINER_INSTALLED_PACKAGES.has(spec.split('/').slice(0, spec.startsWith('@') ? 2 : 1).join('/'))) {
          violations.push(`'${spec}' statically imported via\n    ${chainOf(file)}`);
        }
        continue;
      }
      followRelative(spec);
    }

    for (const spec of dynamicSpecs) {
      if (isBare(spec)) continue; // lazy; cannot classify statically
      const resolved = resolveRelative(file, spec);
      // Follow only dynamic imports into server/ — the members execute those
      // unconditionally (that is the bundle's purpose).
      if (resolved && resolved.startsWith(serverDir)) {
        if (!visited.has(resolved) && !parent.has(resolved)) parent.set(resolved, file);
        queue.push(resolved);
      }
    }

    for (const spec of requireSpecs) {
      if (isBare(spec)) continue; // lazy/conditional; cannot classify statically
      followRelative(spec);
    }
  }

  return { violations, unresolved, visitedCount: visited.size };
}

describe('seed-bundle-resilience-validation container import graph (#5231)', () => {
  const bundleSrc = readFileSync(join(scriptsDir, 'seed-bundle-resilience-validation.mjs'), 'utf-8');
  const members = [...bundleSrc.matchAll(/script:\s*'([^']+)'/g)].map((m) => m[1]);

  it('discovers the bundle member scripts', () => {
    assert.ok(members.length >= 3, `expected >=3 member scripts, found ${members.length}`);
    assert.ok(
      members.includes('validate-resilience-sensitivity.mjs'),
      'Sensitivity-Suite member missing — the bundle definition or this regex drifted',
    );
    for (const member of members) {
      assert.ok(isFile(join(scriptsDir, member)), `member script missing on disk: scripts/${member}`);
    }
  });

  it('every relative import in the container-reachable graph resolves on disk', () => {
    const { unresolved } = walkContainerGraph(members.map((m) => join(scriptsDir, m)));
    assert.deepEqual(
      unresolved,
      [],
      `unresolvable relative import(s) — these crash the cron with ERR_MODULE_NOT_FOUND:\n\n  ${unresolved.join('\n\n  ')}`,
    );
  });

  it('reaches no bare npm specifier absent from the container (node builtins only)', () => {
    const { violations, visitedCount } = walkContainerGraph(members.map((m) => join(scriptsDir, m)));
    assert.ok(visitedCount > 10, `graph walk looks broken — only ${visitedCount} modules visited`);
    assert.deepEqual(
      violations,
      [],
      `bare npm import(s) reachable from the resilience-validation container, which installs ONLY the tsx loader ` +
        `(Dockerfile.seed-bundle-resilience-validation). ESM resolves these eagerly, so the cron crashes with ` +
        `ERR_MODULE_NOT_FOUND even if the importing code never runs. Break the import chain (extract a ` +
        `dependency-free module) or add the package to the container image:\n\n  ${violations.join('\n\n  ')}`,
    );
  });
});
