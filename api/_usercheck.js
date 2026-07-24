// Vercel serverless — multi-platform username checker for Handle Hunter.
//
// Supported platforms (?platform=): twitch, instagram, tiktok.
// Each reports one of:
//   • TAKEN  — an active account exists on that platform
//   • OPEN   — no active account (likely free)
//   • BLOCKED — the platform's own rules forbid the name (length / bad chars)
//   • UNKNOWN — the platform wouldn't give a clear answer (rate-limited / error);
//               NEVER shown as "open" so we don't send someone chasing a dead name
//   • UNCLAIMABLE — (Twitch only) looks open here, but our community flagged it as
//                   not actually registerable. Crowd-sourced layer for Twitch's blind spot.
//
// ⚠️ Twitch locked the TRUE "is this registerable?" check (GraphQL
// `isUsernameAvailable`) behind a Kasada bot-wall, so banned/held/reserved names
// can't be told apart from free ones server-side — hence the community vault.
// Instagram + TikTok have no ban-vs-free distinction either; "open = no live
// account". Both rate-limit by IP, so per-run counts are capped lower than Twitch's.
//
// GET  /api/usercheck?platform=twitch&usernames=a&usernames=b...
//   → { results:[ { username, status, available } ], platform, note }
//   status: 'taken' | 'open' | 'blocked' | 'unclaimable' | 'unknown'
//
// POST /api/usercheck            (Authorization: Bearer <tez token>)
//   body { handles:["foo","bar"] }  → { ok, count }   (Twitch community reports)
//   body { import:[...] }           → { ok, imported } (owner-only vault seed)

import crypto from 'node:crypto';

// Twitch's public web Client-ID (same one twitch.tv uses; safe, no secret needed).
const GQL_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';

// A browser-ish UA so Instagram/TikTok serve their normal responses.
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
// Instagram's public web app id — required header for web_profile_info.
const IG_APP_ID = '936619743392459';

// Run async work over items with a bounded concurrency (keeps us from hammering
// a platform with 100 parallel requests from one IP).
async function pool(items, concurrency, worker) {
  const out = new Array(items.length);
  let idx = 0;
  async function run() {
    while (idx < items.length) {
      const i = idx++;
      out[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  return out;
}

// Supabase (service role bypasses RLS) — shares the project the accounts use.
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SECRET = process.env.AUTH_SECRET || SUPABASE_KEY || '';
const dbReady = () => !!(SUPABASE_URL && SUPABASE_KEY);

// How many independent user reports flip a name to "unclaimable" for everyone.
// 1 = trust the first reporter (fits a small, signed-in community). Raise this if
// you ever want a vote threshold before a flag goes public.
const CONFIRM_THRESHOLD = 1;

// ---- tiny Supabase REST wrapper ----
async function sb(method, path, { body, prefer } = {}) {
  const headers = { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (prefer) headers.Prefer = prefer;
  const r = await fetch(SUPABASE_URL + '/rest/v1/' + path, {
    method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch (_) { /* non-json */ }
  return { ok: r.ok, status: r.status, json };
}

// ---- session token verify (same scheme as api/auth.js) ----
function verifyToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 2) return null;
  const expect = crypto.createHmac('sha256', SECRET).update(parts[0]).digest('base64url');
  const a = Buffer.from(parts[1]), b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let p; try { p = JSON.parse(Buffer.from(parts[0], 'base64url').toString()); } catch (_) { return null; }
  if (!p || !p.exp || p.exp < Date.now()) return null;
  return p;
}
function bearer(req) {
  const h = req.headers.authorization || req.headers.Authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(String(h));
  return m ? m[1].trim() : '';
}

// ---- per-platform username checking ----
// Each platform: clean() normalizes a raw handle, blocked() is true when the
// platform's own rules forbid registering it, and check() resolves a batch of
// already-cleaned logins to 'taken' | 'open' | 'unknown'.

// Twitch: batched public GQL. __typename 'User' = taken, else no active account.
async function twitchCheck(logins) {
  const query = 'query{' +
    logins.map((l, i) => `u${i}:userResultByLogin(login:"${l}"){__typename}`).join(' ') +
    '}';
  const r = await fetch('https://gql.twitch.tv/gql', {
    method: 'POST',
    headers: { 'Client-Id': GQL_CLIENT_ID, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  if (!r.ok) {
    if (r.status === 429) { const e = new Error('rate'); e.rate = true; throw e; }
    throw new Error('Twitch GQL error: ' + r.status);
  }
  const j = await r.json();
  const data = (j && j.data) || {};
  return logins.map((login, i) => {
    const node = data['u' + i];
    return node && node.__typename === 'User' ? 'taken' : 'open';
  });
}

// Instagram: web_profile_info returns 200 for a real profile, 404 when the
// handle has no account. 429/anything else → unknown (never a false "open").
async function instagramOne(login) {
  try {
    const r = await fetch(
      'https://www.instagram.com/api/v1/users/web_profile_info/?username=' + encodeURIComponent(login),
      { headers: {
        'User-Agent': BROWSER_UA, 'x-ig-app-id': IG_APP_ID, 'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.9', 'X-Requested-With': 'XMLHttpRequest',
        'Referer': 'https://www.instagram.com/', 'sec-fetch-site': 'same-origin',
      } });
    if (r.status === 200) return 'taken';
    if (r.status === 404) return 'open';
    return 'unknown';
  } catch (_) { return 'unknown'; }
}

// TikTok: the profile page is a SPA carrying embedded JSON. The reliable signal is
// the PRESENCE of the profile object ("uniqueId":"<handle>") — it's there for BOTH
// public and PRIVATE accounts. Private accounts report a "not found" statusCode
// (10222) even though they exist, so the status code alone falsely reads them as
// open; the uniqueId check must win. Only a not-found code WITHOUT a matching
// uniqueId means the handle is actually free.
function reEsc(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
async function tiktokOne(login) {
  try {
    const r = await fetch('https://www.tiktok.com/@' + encodeURIComponent(login), {
      headers: { 'User-Agent': BROWSER_UA, 'Accept': 'text/html' } });
    if (!r.ok && r.status !== 404) return 'unknown';
    const html = await r.text();
    // Positive existence proof — covers public AND private accounts.
    if (new RegExp('"uniqueId":"' + reEsc(login) + '"', 'i').test(html)) return 'taken';
    const m = html.match(/"statusCode":\s*(\d+)/);
    if (m) {
      const code = parseInt(m[1], 10);
      if (code === 0) return 'taken';                             // a profile loaded
      if (code === 10221 || code === 10222 || code === 10202) return 'open';  // no such account
    }
    return r.status === 404 ? 'open' : 'unknown';
  } catch (_) { return 'unknown'; }
}

// The community "can't-claim" vault is Twitch-only, so its handle cleaning follows
// Twitch's rules (used by the POST report/import paths below).
const cleanLogin = (u) => String(u).trim().toLowerCase().replace(/[^a-z0-9_]/g, '');

const PLATFORMS = {
  twitch: {
    min: 4, max: 25,
    clean: (u) => String(u).trim().toLowerCase().replace(/[^a-z0-9_]/g, ''),
    blocked: (l) => l.length < 4 || l.length > 25 || !/^[a-z0-9_]+$/.test(l),
    batchCap: 100, concurrency: 1, hasVault: true,
    check: twitchCheck,
  },
  instagram: {
    // IG allows letters, numbers, periods, underscores; up to 30 chars.
    min: 1, max: 30,
    clean: (u) => String(u).trim().toLowerCase().replace(/^@/, '').replace(/[^a-z0-9._]/g, ''),
    blocked: (l) => l.length < 1 || l.length > 30 || !/^[a-z0-9._]+$/.test(l),
    batchCap: 25, concurrency: 6,
    check: (logins) => pool(logins, 6, instagramOne),
  },
  tiktok: {
    // TikTok allows letters, numbers, periods, underscores; 2–24 chars.
    min: 2, max: 24,
    clean: (u) => String(u).trim().toLowerCase().replace(/^@/, '').replace(/[^a-z0-9._]/g, ''),
    blocked: (l) => l.length < 2 || l.length > 24 || !/^[a-z0-9._]+$/.test(l),
    batchCap: 25, concurrency: 5,
    check: (logins) => pool(logins, 5, tiktokOne),
  },
};

// Look up the community "can't-claim" info for these logins, keyed by handle:
//   { reports, confirmed }.  Only names that clear the threshold (or are
//   owner-confirmed) are returned.
async function unclaimableInfo(logins) {
  if (!dbReady() || !logins.length) return new Map();
  const list = logins.map((l) => '"' + l + '"').join(',');
  const q = await sb('GET', 'tez_unclaimable?handle=in.(' + encodeURIComponent(list) +
    ')&select=handle,reports,confirmed');
  const map = new Map();
  if (q.json && Array.isArray(q.json)) {
    for (const row of q.json) {
      if (row.confirmed || (row.reports || 0) >= CONFIRM_THRESHOLD) {
        map.set(row.handle, { reports: row.reports || 0, confirmed: !!row.confirmed });
      }
    }
  }
  return map;
}

// Resolve the caller's tier from their (optional) session token. The verified
// "can't-claim" vault is a Pro perk, so free/anonymous callers get raw results.
// select=* so a missing optional column (e.g. pro_until) never breaks the query.
async function callerTier(req) {
  const tok = bearer(req);
  if (!tok || !dbReady()) return 'free';
  const p = verifyToken(tok);
  if (!p) return 'free';
  const q = await sb('GET', 'tez_users?id=eq.' + encodeURIComponent(p.uid) + '&select=*&limit=1');
  const row = q.json && q.json[0];
  if (!row) return 'free';
  if (row.pro_until && Date.now() > Date.parse(row.pro_until)) return 'free'; // expired grant
  const t = row.tier || (row.pro ? 'pro' : 'free');
  return (t === 'pro' || t === 'exclusive') ? t : 'free';
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method === 'POST') return post(req, res);
  if (req.method !== 'GET') { res.status(405).json({ error: 'Method not allowed' }); return; }
  return check(req, res);
}

// ---- GET: check availability (per platform, + Twitch community overlay) ----
async function check(req, res) {
  const platform = (req.query.platform || 'twitch').toLowerCase();
  const P = PLATFORMS[platform];
  if (!P) {
    res.status(400).json({ error: 'Unsupported platform. Try twitch, instagram, or tiktok.' });
    return;
  }

  // usernames arrive as repeated params (?usernames=a&usernames=b) → array on
  // Vercel — or as a comma string. Handle both.
  const rawParam = req.query.usernames;
  const rawList = Array.isArray(rawParam) ? rawParam : String(rawParam || '').split(',');
  const logins = [...new Set(
    rawList.map(P.clean).filter((u) => u.length >= 1 && u.length <= P.max)
  )].slice(0, P.batchCap);

  if (logins.length === 0) { res.status(400).json({ results: [] }); return; }

  // The verified "can't-claim" vault is a Pro perk (Twitch only) — resolve tier first.
  const tier = await callerTier(req);
  const isPro = tier === 'pro' || tier === 'exclusive';

  // Blocked names never hit the network — resolve them from rules up front and
  // only send the plausibly-registerable ones to the platform.
  const blocked = new Set();
  const toQuery = [];
  for (const l of logins) { if (P.blocked(l)) blocked.add(l); else toQuery.push(l); }

  try {
    let live = new Map();
    if (toQuery.length) {
      const statuses = await P.check(toQuery);
      toQuery.forEach((l, i) => live.set(l, statuses[i] || 'unknown'));
    }

    const base = logins.map((login) => ({
      username: login,
      status: blocked.has(login) ? 'blocked' : (live.get(login) || 'unknown'),
    }));

    // Twitch-only overlay: cross-check open names against the verified vault (Pro).
    const openLogins = base.filter((r) => r.status === 'open').map((r) => r.username);
    const info = (P.hasVault && isPro) ? await unclaimableInfo(openLogins) : new Map();

    const results = base.map((r) => {
      if (r.status === 'open' && info.has(r.username)) {
        const c = info.get(r.username);
        return { username: r.username, status: 'unclaimable', available: false, reports: c.reports, confirmed: c.confirmed };
      }
      return { username: r.username, status: r.status, available: r.status === 'open' };
    });

    // A per-tier response must never be shared-cached (token is in a header, not
    // the URL), so only cache anonymous/no-token checks at the edge.
    if (bearer(req)) res.setHeader('Cache-Control', 'private, no-store');
    else res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');

    const label = platform === 'twitch' ? 'Twitch' : platform === 'instagram' ? 'Instagram' : 'TikTok';
    res.status(200).json({
      results, tier, pro: isPro, platform,
      note: (P.hasVault && isPro)
        ? 'open = no active ' + label + ' account. unclaimable = in the verified can’t-claim vault. ' + label + ' still reserves some names, so verify before relying on it.'
        : 'open = no active ' + label + ' account. Some names are reserved or held — verify the ↗ link before you rely on it.',
    });
  } catch (err) {
    if (err && err.rate) { res.status(429).json({ error: 'Rate limited — wait a moment and try fewer names.' }); return; }
    console.error('usercheck', platform, err);
    res.status(502).json({ error: 'Could not reach ' + platform + ' — try again.' });
  }
}

// Accounts allowed to bulk-seed the vault (owner only). Extend if the owner
// grants seeding to another account. Checked server-side against the DB row.
const IMPORT_OWNERS = ['TEZ-FGHXR'];
async function isImportOwner(uid) {
  const q = await sb('GET', 'tez_users?id=eq.' + encodeURIComponent(uid) + '&select=code&limit=1');
  const row = q.json && q.json[0];
  return !!(row && IMPORT_OWNERS.includes(row.code || ''));
}

// ---- POST: signed-in write actions ----
//   { handles:[…] }  → community report (any signed-in user)
//   { import:[…]  }  → bulk-seed the verified vault (owner only)
async function post(req, res) {
  if (!dbReady()) { res.status(503).json({ error: 'Not set up yet.' }); return; }
  const payload = verifyToken(bearer(req));
  if (!payload) { res.status(401).json({ error: 'Sign in first.' }); return; }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) { body = {}; } }
  body = body || {};

  if (Array.isArray(body.import)) return importSeed(req, res, payload, body.import);
  return report(req, res, payload, body);
}

// A signed-in user reports handles they found un-registerable (community layer).
async function report(req, res, payload, body) {
  const handles = [...new Set(
    (Array.isArray(body.handles) ? body.handles : [])
      .map(cleanLogin)
      .filter((h) => h.length >= 4 && h.length <= 25)
  )].slice(0, 100);

  if (!handles.length) { res.status(400).json({ error: 'No valid handles to report.' }); return; }

  try {
    let count = 0;
    for (const handle of handles) {
      const r = await sb('POST', 'rpc/report_unclaimable', {
        body: { p_handle: handle, p_user: payload.uid },
      });
      if (r.ok) count++;
    }
    res.status(200).json({ ok: true, count });
  } catch (err) {
    console.error('usercheck report', err);
    res.status(500).json({ error: 'Could not save your report. Try again.' });
  }
}

// Owner-only: bulk-seed the vault from a real can't-claim list (e.g. a public
// banned-names export). Upserts as owner-confirmed; existing rows keep their
// community report count (reports is left out of the upsert payload on conflict).
async function importSeed(req, res, payload, list) {
  if (!(await isImportOwner(payload.uid))) { res.status(403).json({ error: 'This account cannot seed the vault.' }); return; }
  const handles = [...new Set(
    list.map(cleanLogin).filter((h) => h.length >= 1 && h.length <= 25)
  )].slice(0, 5000);
  if (!handles.length) { res.status(400).json({ error: 'No valid handles to import.' }); return; }

  const rows = handles.map((h) => ({ handle: h, confirmed: true, note: 'seed' }));
  try {
    const r = await sb('POST', 'tez_unclaimable?on_conflict=handle', {
      body: rows, prefer: 'resolution=merge-duplicates,return=minimal',
    });
    if (r.ok) { res.status(200).json({ ok: true, imported: handles.length }); return; }
    res.status(502).json({ error: 'Import failed.', status: r.status });
  } catch (err) {
    console.error('usercheck import', err);
    res.status(500).json({ error: 'Import failed. Try again.' });
  }
}
