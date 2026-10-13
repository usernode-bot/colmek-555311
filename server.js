const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

const app = express();
const port = process.env.PORT || 3000;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// The platform signs user-identity tokens with an RSA private key it never
// shares. Containers get only the PUBLIC half, so this app can verify who a
// user is but cannot mint an identity — and neither can any other app.
const JWT_PUBLIC_KEY = (process.env.USERNODE_JWT_PUBLIC_KEY || '')
  .replace(/\\n/g, '\n');

// Tokens are minted for one app: the audience is this app's numeric id, so a
// token issued for a different app is rejected below rather than accepted as
// a valid user.
const APP_AUDIENCE = process.env.USERNODE_APP_ID
  ? 'usernode:app:' + process.env.USERNODE_APP_ID
  : null;

// Visitors with no Homeroom account ("guests") may look around this app at
// its own address, read-only (every public app). The platform marks
// them with a token of their own: ES256, signed by a key of its own (its
// public half is USERNODE_GUEST_JWT_PUBLIC_KEY), this audience, `pur:
// 'guest'`, `guest: true`, and no id or username. Such a visitor is
// `req.guest`, never `req.user`, and every write they try is answered 401
// `account_required`, which the bridge turns into "Make an account to
// continue".
const GUEST_AUDIENCE = APP_AUDIENCE ? APP_AUDIENCE + ':guest' : null;
const GUEST_PUBLIC_KEY = (process.env.USERNODE_GUEST_JWT_PUBLIC_KEY || '')
  .replace(/\\n/g, '\n');

// Paths that stay open without authentication. Add a path here (and add it
// with `app.get`/`app.post` below) if you deliberately want it public.
// Everything else requires a valid platform-issued JWT.
const PUBLIC_API_PATHS = new Set(['/health']);

app.use(express.json());

// The platform's three centrally hosted files — the bridge, the native UI
// kit and the Tailwind runtime — are reachable at these paths on this app's
// OWN origin, so index.html can load them with a RELATIVE path and never
// name the platform's hostname. A hostname baked into an app is what breaks
// every app at once when the platform's domain moves.
//
// In production and on a staging preview the platform's edge answers these
// before the request ever reaches this process (a per-app Ingress rule on
// Kubernetes, the wildcard site's matcher on the docker runtime). This
// handler is what makes the same relative paths work under a plain
// `node server.js`, where there is no edge in front of the app at all.
//
// Registered BEFORE the auth middleware because these three files are
// public: the platform serves them anonymously from any app origin, and a
// login redirect arriving where a <script> was expected is exactly the
// failure a relative path is meant to avoid.
// The platform's origin, at RUNTIME, and ONLY from the variable the platform
// injects. No hostname is written into this file: a baked-in one is what left
// the whole fleet pointing at a domain the platform had moved away from.
// Unset only outside the platform (a plain local `node server.js`) — set
// USERNODE_PLATFORM_ORIGIN there too if you want the hosted assets locally.
const PLATFORM_ORIGIN = (process.env.USERNODE_PLATFORM_ORIGIN || '')
  .replace(/\/+$/, '');

app.get(/^\/usernode-(?:bridge|native|tailwind)\//, async (req, res) => {
  try {
    if (!PLATFORM_ORIGIN) return res.sendStatus(503);
    const upstream = await fetch(PLATFORM_ORIGIN + req.path);
    if (!upstream.ok) return res.sendStatus(upstream.status);
    const type = upstream.headers.get('content-type');
    if (type) res.type(type);
    // max-age=0 with revalidation, never a long TTL: the whole point of
    // central hosting is that a platform-side fix lands on the next load.
    res.set('Cache-Control', 'public, max-age=0, must-revalidate');
    return res.send(Buffer.from(await upstream.arrayBuffer()));
  } catch (err) {
    console.warn('hosted asset fetch failed: ' + err.message);
    return res.sendStatus(502);
  }
});

// "Now" for this request, as a Date: `req.now`, set for every request by
// the middleware below. Read the day and the time through it (and
// `usernode.now()` in the page), never `new Date()` or SQL's NOW(),
// wherever they decide what shows: a reminder, a rota, a deadline.
// Production always gets the real time. A staging preview may be shown as of
// a chosen moment: the platform opens it with `?un-now=<ISO time>`, and the
// page sends `usernode.now()` on as the `x-usernode-now` header. Only a
// staging container reads either. See "Time-dependent features" in the
// platform conventions.
const IS_STAGING = process.env.USERNODE_ENV === 'staging';
const PREVIEW_NOW = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
function requestNow(req) {
  const raw = IS_STAGING ? (req.headers['x-usernode-now'] || req.query['un-now']) : null;
  return typeof raw === 'string' && PREVIEW_NOW.test(raw) ? new Date(raw) : new Date();
}

// Verify platform-issued JWT if one was passed, then enforce auth on
// anything not explicitly marked public. The iframe adds `?token=…`
// on load; the frontend script forwards the token via `x-usernode-token`
// on subsequent fetches.
app.use((req, res, next) => {
  req.now = requestNow(req);
  const token = req.query.token || req.headers['x-usernode-token'];
  if (token && JWT_PUBLIC_KEY && APP_AUDIENCE) {
    try {
      // Pin the algorithm, issuer and audience. Without `algorithms` a
      // caller could hand us an HS256 token signed with the public PEM
      // (which every app knows) and forge any user.
      const claims = jwt.verify(token, JWT_PUBLIC_KEY, {
        algorithms: ['RS256'],
        issuer: 'usernode',
        audience: APP_AUDIENCE,
      });
      // `pur` names what the token is for. Only user-identity tokens
      // authenticate a person here.
      if (claims && claims.pur === 'iframe') req.user = claims;
    } catch {}
  }
  if (!req.user && token && GUEST_PUBLIC_KEY && GUEST_AUDIENCE) {
    try {
      const guest = jwt.verify(token, GUEST_PUBLIC_KEY, {
        algorithms: ['ES256'],
        issuer: 'usernode',
        audience: GUEST_AUDIENCE,
      });
      if (guest && guest.pur === 'guest' && guest.guest === true) req.guest = true;
    } catch {}
  }

  // Static assets (CSS/JS/images) are always served; the API and the HTML
  // shell are gated so direct hits to the staging/prod subdomain don't
  // leak app data to the public internet. A guest may READ: every GET,
  // `/api/*` included, so read routes must not assume req.user (use
  // `req.user ? req.user.id : null`). Every write needs an account.
  if (req.method !== 'GET' || req.path.startsWith('/api/')) {
    if (PUBLIC_API_PATHS.has(req.path)) return next();
    if (!req.user && req.guest) {
      if (req.method === 'GET' || req.method === 'HEAD') return next();
      return res.status(401).json({ error: 'account_required' });
    }
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
});

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// ── Live XAUUSD price ────────────────────────────────────────────────────
// The dashboard's chart shows the real gold price, sampled here on the
// server's own timer so the browser never calls the source and however many
// people have the page open, the source sees one request per 10 s. The
// buffer is a rolling one-hour window held in memory only: fine to lose on
// restart, the chart just fills in again over the next minutes.
// Two keyless public sources, tried in order on every sample: the primary,
// then PAX Gold on CoinGecko (a 1:1 gold-backed token, so its USD price
// tracks spot within a fraction of a percent). A point may come from either,
// which only shows as a small step on the sparkline for as long as the
// fallback is in use.
const XAU_SOURCES = [
  {
    label: 'gold-api.com',
    url: 'https://api.gold-api.com/price/XAU',
    parse: (data) => data && Number(data.price),
  },
  {
    label: 'coingecko.com (pax-gold)',
    url: 'https://api.coingecko.com/api/v3/simple/price?ids=pax-gold&vs_currencies=usd',
    parse: (data) => data && data['pax-gold'] && Number(data['pax-gold'].usd),
  },
];
const XAU_SAMPLE_MS = 10_000;
const XAU_MAX_POINTS = 360; // 360 × 10 s = one hour
const XAU_STALE_MS = 120_000; // no good sample for 2 min ⇒ the feed is stale
const xau = {
  points: [], source: null, lastOkAt: null, failing: false, timer: null,
  // Why the last all-sources sample failed ("gold-api.com: HTTP 403; …"),
  // for the /api/xau failure payload. Cleared on the next good sample.
  lastError: null,
};

async function fetchXauPrice(source) {
  const res = await fetch(source.url, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const data = await res.json();
  // Accept only a positive finite number: an HTML error page or a changed
  // shape must not put garbage in the buffer.
  const price = source.parse(data);
  if (!Number.isFinite(price) || price <= 0) throw new Error('unexpected price shape');
  return Math.round(price * 100) / 100;
}

async function sampleXau() {
  const errors = [];
  for (const source of XAU_SOURCES) {
    try {
      const price = await fetchXauPrice(source);
      xau.points.push({ t: new Date().toISOString(), p: price });
      if (xau.points.length > XAU_MAX_POINTS) xau.points.shift();
      xau.source = source.label;
      xau.lastOkAt = Date.now();
      xau.lastError = null;
      if (xau.failing) {
        xau.failing = false;
        console.warn('XAU price feed recovered via ' + source.label + '.');
      }
      return;
    } catch (err) {
      // Keep every source's reason, not only the last one: the browser shows
      // this joined string in the error card, so "HTTP 403" without its
      // source name would not say which feed broke.
      errors.push(source.label + ': ' + (err && err.message ? err.message : String(err)));
    }
  }
  const reason = errors.join('; ');
  xau.lastError = { at: new Date().toISOString(), reason };
  // Warn once when sampling starts failing on every source and once when it
  // recovers, so a long outage does not fill the log.
  if (!xau.failing) {
    xau.failing = true;
    console.warn('XAU price feed failing on all sources: ' + reason);
  }
}

// Always answers 200, so a source outage never shows up as a failed request
// in the browser console; `ok` says whether there is anything to show.
app.get('/api/xau', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  if (xau.points.length === 0) {
    // `reason` carries the actual failure (per source, e.g. "gold-api.com:
    // HTTP 403; coingecko.com (pax-gold): HTTP 429") so an outage in the
    // staging preview is diagnosable from the card instead of a bare
    // "could not be loaded". The fallback covers the first seconds after a
    // container boot, before any sample has tried a source.
    return res.json({
      ok: false,
      error: 'live_feed_unavailable',
      reason: xau.lastError ? xau.lastError.reason : 'waiting for the first sample',
      points: [],
    });
  }
  return res.json({
    ok: true,
    symbol: 'XAUUSD',
    source: xau.source || XAU_SOURCES[0].label,
    points: xau.points,
    stale: xau.lastOkAt === null || Date.now() - xau.lastOkAt > XAU_STALE_MS,
  });
});

// What the page needs to know before it boots: whether this visit should run
// the staged demo (staging only, asked for with ?demo=1) and whether the
// viewer is signed in. GET, so guests may read it.
app.get('/api/session', (req, res) => {
  res.json({
    demo: IS_STAGING && req.query.demo === '1',
    signedIn: !!req.user,
  });
});

// The template ships no favicon file; index.html carries an inline SVG
// icon instead. Answer 204 here so anything that still probes
// /favicon.ico (older browsers, direct visits) doesn't fall through to
// the auth-gated catch-all and surface a 401 in the console on every
// fresh load.
app.get('/favicon.ico', (_req, res) => res.status(204).end());

app.use(express.static(path.join(__dirname, 'public')));

// HTML shell: serve the app if authenticated. Unauthenticated top-level
// visits (share links pasted into a browser — Sec-Fetch-Dest: document)
// are sent to the platform's chromeless view of this app, where the shell
// embeds it with a real token so the link just works. Every other
// tokenless case (iframe loads with an expired token, old browsers
// without Sec-Fetch-*) gets the "open in Homeroom" landing page instead
// of a redirect, so the platform shell is never loaded INSIDE its own
// app iframe and stray visits still don't reveal the app.
app.get('*', (req, res) => {
  if (!req.user && !req.guest) {
    // Deep-link pass-through (platform #743): carry the visited
    // path+query into the chromeless view so share links land on the
    // shared screen, not Home. The clean platform route stores `path`
    // as one encoded query value so an inner ?, &, or = survives. The
    // shell decodes and validates it as relative-only before use. The
    // character test keeps the
    // value attribute-safe for the landing anchor below — anything
    // unusual falls back to the bare link.
    const deepPath = /^\/[A-Za-z0-9\-._~!$&()*+,;=:@\/%?]*$/.test(req.originalUrl)
      ? '?path=' + encodeURIComponent(req.originalUrl) : '';
    if (PLATFORM_ORIGIN && req.get('sec-fetch-dest') === 'document') {
      return res.redirect(302, PLATFORM_ORIGIN + '/app/colmek-555311/full' + deepPath);
    }
    return res.status(401).send(`<!doctype html><meta charset=utf-8><title>Open in Homeroom</title>
<body style="font-family:system-ui;background:#09090b;color:#e4e4e7;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
  <div style="max-width:24rem;padding:2rem;text-align:center">
    <h1 style="font-size:1.25rem;margin:0 0 0.5rem">Open this app inside Homeroom</h1>
    <p style="color:#a1a1aa;font-size:0.9rem;margin:0 0 1.25rem">This page is served via the platform; direct visits aren't authenticated.</p>
    <a href="${PLATFORM_ORIGIN}/app/colmek-555311/full${deepPath}" style="display:inline-block;padding:0.5rem 1rem;background:#7c3aed;color:white;border-radius:0.5rem;text-decoration:none;font-size:0.9rem">Open in Homeroom</a>
  </div>
</body>`);
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

async function start() {
  const server = app.listen(port, () => console.log(`Listening on :${port}`));
  // Let Envoy retire idle upstream connections at 60s, with a 15s margin.
  server.keepAliveTimeout = 75_000;

  // Start the live price sampler: one sample now so the chart has a point
  // straight away, then one every 10 s. A read-only fetch with no side
  // effect, so it runs in staging and production alike.
  sampleXau();
  xau.timer = setInterval(sampleXau, XAU_SAMPLE_MS);
  xau.timer.unref();

  // Shut down cleanly when the platform stops the container: stop taking
  // connections, give the in-flight ones 3 s to drain, close the database
  // pool, then exit.
  const shutdown = () => {
    if (xau.timer) clearInterval(xau.timer);
    server.close(() => process.exit(0));
    setTimeout(() => { pool.end().finally(() => process.exit(0)); }, 3000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

start().catch(err => { console.error(err); process.exit(1); });
