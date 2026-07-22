#!/usr/bin/env node
// Zero-dependency Node ESM web server: serves the built SPA (dist/) and proxies
// /api/* to the local-api-server sidecar. Replaces the Docker nginx image
// (nginx is decommissioned on this Mac mini). Behavior matches docker/nginx.conf.
//
// Env vars (all optional except the token):
//   WM_WEB_PORT       listen port (default 3040)
//   LOCAL_API_PORT    sidecar port (default 46123)
//   LOCAL_API_TOKEN   bearer token injected on the private hop to the sidecar (required)
//   WM_DIST_DIR       static root (default <repo-root>/dist)

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------- config ----------

const PORT = Number(process.env.WM_WEB_PORT) || 3040;
const API_PORT = Number(process.env.LOCAL_API_PORT) || 46123;
const API_TOKEN = process.env.LOCAL_API_TOKEN || '';
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.resolve(process.env.WM_DIST_DIR || path.join(SCRIPT_DIR, '..', 'dist'));

if (!API_TOKEN) {
  console.error('FATAL: LOCAL_API_TOKEN is not set. Refusing to start (the sidecar hop requires it).');
  process.exit(1);
}
if (!fs.existsSync(DIST_DIR) || !fs.existsSync(path.join(DIST_DIR, 'dashboard.html'))) {
  console.error(`FATAL: dist directory not found or missing dashboard.html: ${DIST_DIR}`);
  console.error('Run macmini/deploy.sh first to build the SPA into dist/.');
  process.exit(1);
}

// ---------- headers copied verbatim from docker/nginx.conf ----------

// Dashboard CSP — nginx SPA fallback location /. Kept byte-identical to
// docker/nginx.conf (and to docker/nginx-security-headers.conf + vercel.json).
const DASHBOARD_CSP =
  "default-src 'self'; connect-src 'self' https: wss: blob: data:; img-src 'self' data: blob: https:; " +
  "style-src 'self' 'unsafe-inline'; script-src 'self' 'strict-dynamic' 'nonce-wm-static-bootstrap' " +
  "'sha256-+SFBjfmi2XfnyAT3POBxf6JIKYDcNXtllPclOcaNBI0=' " +
  "'sha256-7oZNrsyfSuHAVU4KcnfCYgflzMCUu6NcFnN8paFIf0A=' " +
  "'sha256-lKs3SvF31U/ZDoqILsGd1YpSh0LSw9Xlo0hNHcX8Wqk=' " +
  "'sha256-jAPaz07sLDJ3o7wlzW1l2gFp/IZLG9nMWVawE66s8RI=' " +
  "'sha256-YuKFGGQ4QiGylTP1WSbSWemYdUjrcEKRHHp0h8dUyLc=' " +
  "'sha256-XsSfnJeoJYzlhuBF8lmmhxzSpSgSecVttS4CzI5UqnM=' " +
  "'sha256-YpNuL1hJEyya/Pw8JIX6ZTWbVjQT7oIlYOm4VhvRj/Y=' " +
  "'sha256-qFSeUweakvZf90cHXTBJlSgrlZOixT+/ph7kpKeRYL0=' " +
  "'wasm-unsafe-eval'; worker-src 'self' blob:; font-src 'self' data:; " +
  "media-src 'self' data: blob: https:; " +
  "frame-src 'self' https://www.worldmonitor.app https://worldmonitor.app https://tech.worldmonitor.app " +
  "https://finance.worldmonitor.app https://commodity.worldmonitor.app https://happy.worldmonitor.app " +
  "https://energy.worldmonitor.app https://www.youtube.com https://www.youtube-nocookie.com " +
  "https://www.google.com https://webcams.windy.com https://challenges.cloudflare.com " +
  "https://*.clerk.accounts.dev https://clerk.worldmonitor.app https://vercel.live https://*.vercel.app " +
  "https://*.dodopayments.com https://checkout.dodopayments.com https://test.checkout.dodopayments.com " +
  "https://*.hs.dodopayments.com https://*.custom.hs.dodopayments.com https://pay.google.com " +
  "https://hooks.stripe.com https://js.stripe.com; " +
  "frame-ancestors 'self' https://www.worldmonitor.app https://tech.worldmonitor.app " +
  "https://finance.worldmonitor.app https://commodity.worldmonitor.app https://happy.worldmonitor.app " +
  "https://energy.worldmonitor.app https://worldmonitor.app; " +
  "base-uri 'self'; object-src 'none'; form-action 'self' https://api.worldmonitor.app";

// Embed CSP — nginx location = /embed and = /embed.html. Same string in both.
const EMBED_CSP =
  "default-src 'self'; connect-src 'self' https: wss: blob: data:; img-src 'self' data: blob: https:; " +
  "style-src 'self' 'unsafe-inline'; script-src 'self'; worker-src 'self' blob:; " +
  "font-src 'self' data: https:; media-src 'self' data: blob: https:; frame-src 'none'; " +
  "frame-ancestors *; base-uri 'self'; object-src 'none'; form-action 'none'";

const EMBED_PERMISSIONS_POLICY =
  'camera=(), microphone=(), geolocation=(), accelerometer=(), autoplay=(), bluetooth=(), ' +
  'display-capture=(), encrypted-media=(), gyroscope=(), hid=(), idle-detection=(), magnetometer=(), ' +
  'midi=(), payment=(), picture-in-picture=(), screen-wake-lock=(), serial=(), usb=(), xr-spatial-tracking=()';

const DASHBOARD_PERMISSIONS_POLICY =
  'storage-access=(self "https://www.youtube.com" "https://youtube.com")';

const ASSET_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-XSS-Protection': '1; mode=block',
  'Cache-Control': 'public, max-age=31536000, immutable',
};

const DASHBOARD_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-XSS-Protection': '1; mode=block',
  'Content-Security-Policy': DASHBOARD_CSP,
  'Cache-Control': 'no-cache, no-store, must-revalidate',
  'Permissions-Policy': DASHBOARD_PERMISSIONS_POLICY,
};

const EMBED_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains; preload',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Cache-Control': 'private, no-cache, must-revalidate',
  'Permissions-Policy': EMBED_PERMISSIONS_POLICY,
  'Content-Security-Policy': EMBED_CSP,
};

// ---------- MIME map ----------

const MIME = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  js: 'application/javascript; charset=utf-8',
  mjs: 'application/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  geojson: 'application/geo+json; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  wasm: 'application/wasm',
  webmanifest: 'application/manifest+json; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  map: 'application/json; charset=utf-8',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
};

function mimeFor(filePath) {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  return MIME[ext] || 'application/octet-stream';
}

// ---------- helpers ----------

function safeJoinDist(urlPath) {
  // urlPath is the percent-decoded pathname (no query) — decoded once in the
  // request handler; node:http does NOT pre-decode req.url. Reject NUL bytes and
  // anything that resolves outside DIST_DIR.
  if (urlPath.includes('\0')) return null;
  const cleaned = urlPath.replace(/^\/+/, '');
  const resolved = path.resolve(DIST_DIR, cleaned);
  const rel = path.relative(DIST_DIR, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return resolved;
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, headers);
  res.end(body);
}

function serveFile(req, res, absPath, headers) {
  // Stream the file so we don't materialize large textures/audio into memory.
  const stream = fs.createReadStream(absPath);
  stream.on('error', (err) => {
    // Headers may already be out (stream errored mid-body) — a second
    // writeHead here would throw inside the listener and kill the process.
    if (res.headersSent) { res.destroy(); return; }
    const status = err.code === 'ENOENT' || err.code === 'EISDIR' ? 404 : 500;
    send(res, status, status === 404 ? 'Not Found' : 'Internal Server Error',
      { 'Content-Type': 'text/plain; charset=utf-8' });
  });
  res.writeHead(200, headers);
  stream.pipe(res);
}

const ACCESS_LOG = (method, urlPath, status, ms) =>
  console.log(`${method} ${urlPath} ${status} ${ms}ms`);

// ---------- handlers ----------

function handleHealthz(req, res) {
  send(res, 200, JSON.stringify({ ok: true }), {
    'Content-Type': 'application/json; charset=utf-8',
  });
}

function handleStatic(req, res, urlPath, start) {
  // Embed routes — locked-down CSP, no SPA fallback.
  if (urlPath === '/embed' || urlPath === '/embed.html') {
    const abs = path.join(DIST_DIR, 'embed.html');
    if (!fs.existsSync(abs)) {
      return send(res, 404, 'Not Found', { 'Content-Type': 'text/plain; charset=utf-8' });
    }
    serveFile(req, res, abs, { ...EMBED_HEADERS, 'Content-Type': MIME.html });
    return ACCESS_LOG(req.method, urlPath, 200, Date.now() - start);
  }

  // Immutable asset trees — strict 404, no SPA fallback.
  const isAssetTree =
    urlPath.startsWith('/assets/') ||
    urlPath.startsWith('/map-styles/') ||
    urlPath.startsWith('/data/') ||
    urlPath.startsWith('/textures/');

  // SPA entry / fallback for everything else. Decide the file to serve first.
  let target;
  if (urlPath === '/' || urlPath === '') {
    target = path.join(DIST_DIR, 'dashboard.html');
  } else if (isAssetTree) {
    const safe = safeJoinDist(urlPath);
    if (!safe) {
      send(res, 400, 'Bad Request', { 'Content-Type': 'text/plain; charset=utf-8' });
      return ACCESS_LOG(req.method, urlPath, 400, Date.now() - start);
    }
    let st;
    try { st = fs.statSync(safe); } catch { st = null; }
    if (!st || !st.isFile()) {
      // Directories included: nginx returns 404 for GET /assets/; streaming a
      // directory would emit EISDIR after writeHead and crash the process.
      send(res, 404, 'Not Found', { 'Content-Type': 'text/plain; charset=utf-8' });
      return ACCESS_LOG(req.method, urlPath, 404, Date.now() - start);
    }
    serveFile(req, res, safe, { ...ASSET_HEADERS, 'Content-Type': mimeFor(safe) });
    return ACCESS_LOG(req.method, urlPath, 200, Date.now() - start);
  } else {
    // Anything else: try the exact file; otherwise fall back to dashboard.html.
    // Mirrors nginx `try_files $uri $uri/ /dashboard.html` — paths with no
    // extension are not assumed to be files.
    const safe = safeJoinDist(urlPath);
    if (safe && fs.existsSync(safe) && fs.statSync(safe).isFile()) {
      target = safe;
    } else {
      target = path.join(DIST_DIR, 'dashboard.html');
    }
  }

  const headers = target.endsWith('dashboard.html')
    ? { ...DASHBOARD_HEADERS, 'Content-Type': MIME.html }
    : { ...ASSET_HEADERS, 'Content-Type': mimeFor(target) };
  serveFile(req, res, target, headers);
  ACCESS_LOG(req.method, urlPath, 200, Date.now() - start);
}

function handleApiProxy(req, res, urlPath, start) {
  const target = `http://127.0.0.1:${API_PORT}${urlPath}`;
  // Build outbound headers: copy client, then overwrite hop-critical ones.
  const outHeaders = { ...req.headers };
  // Preserve Host (clients may have set one; the sidecar expects the original host).
  // Strip hop-by-hop + length (recomputed by http.request when piping a body).
  delete outHeaders['connection'];
  delete outHeaders['keep-alive'];
  delete outHeaders['proxy-authenticate'];
  delete outHeaders['proxy-authorization'];
  delete outHeaders['te'];
  delete outHeaders['trailers'];
  delete outHeaders['transfer-encoding'];
  delete outHeaders['upgrade'];
  // X-Forwarded-For: append (nginx does proxy_add_x_forwarded_for).
  const clientAddr = req.socket.remoteAddress || '';
  const priorXff = req.headers['x-forwarded-for'];
  outHeaders['x-forwarded-for'] = priorXff ? `${priorXff}, ${clientAddr}` : clientAddr;
  outHeaders['x-forwarded-proto'] = 'https';
  // The sidecar's origin allowlist trusts http://localhost:* to detect a
  // same-host browser fetch. Rewrite to that so origin checks pass.
  outHeaders['origin'] = 'http://localhost';
  // Overwrite any client Authorization — the token never leaves the private hop.
  outHeaders['authorization'] = `Bearer ${API_TOKEN}`;

  const proxyReq = http.request(
    target,
    {
      method: req.method,
      headers: outHeaders,
      timeout: 120_000,
    },
    (proxyRes) => {
      // Stream upstream response back — but drop hop-by-hop headers; Node has
      // already decoded chunked framing, so re-declaring it would be a lie.
      const h = { ...proxyRes.headers };
      delete h['connection'];
      delete h['keep-alive'];
      delete h['transfer-encoding'];
      res.writeHead(proxyRes.statusCode || 502, h);
      proxyRes.pipe(res);
    }
  );

  proxyReq.on('timeout', () => {
    proxyReq.destroy(new Error('upstream timeout'));
  });
  proxyReq.on('error', (err) => {
    console.error(`api proxy error: ${err.message}`);
    if (!res.headersSent) {
      send(res, 502, JSON.stringify({ error: 'sidecar unavailable' }), {
        'Content-Type': 'application/json; charset=utf-8',
      });
    } else {
      res.destroy();
    }
  });

  req.on('close', () => {
    // Client gave up — abort the upstream so we don't leak sockets.
    proxyReq.destroy();
  });

  req.pipe(proxyReq);

  const onDone = (status) => ACCESS_LOG(req.method, urlPath, status, Date.now() - start);
  res.on('close', () => onDone(res.statusCode));
}

// ---------- server ----------

const server = http.createServer((req, res) => {
  const start = Date.now();
  // req.url is RAW: it still has the query string and percent-encoding.
  // Route on the decoded pathname; hand the raw URL to the API proxy so the
  // sidecar receives the query string untouched.
  const rawUrl = req.url || '/';
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(rawUrl, 'http://internal').pathname);
  } catch {
    return send(res, 400, 'Bad Request', { 'Content-Type': 'text/plain; charset=utf-8' });
  }

  // Healthz short-circuits before any static work.
  if (req.method === 'GET' && pathname === '/healthz') {
    handleHealthz(req, res);
    return ACCESS_LOG(req.method, pathname, 200, Date.now() - start);
  }

  // API proxy takes precedence over static (matches nginx location /api/).
  if (pathname === '/api' || pathname.startsWith('/api/')) {
    return handleApiProxy(req, res, rawUrl, start);
  }

  handleStatic(req, res, pathname, start);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`wm-web listening on http://127.0.0.1:${PORT} (dist=${DIST_DIR}, api=:${API_PORT})`);
});
