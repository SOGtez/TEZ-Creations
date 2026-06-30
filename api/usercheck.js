// Vercel serverless — Twitch username checker for Handle Hunter.
//
// ⚠️ Twitch locked the TRUE "is this registerable?" check (the GraphQL
// `isUsernameAvailable` query) behind a Kasada / integrity bot-wall, so it can't
// be called from a server. That means a banned / held / reserved name can't be
// detected as such from here. What we CAN do reliably:
//   • TAKEN  — an active Twitch account exists (public GQL `userResultByLogin`)
//   • BLOCKED — Twitch's own rules forbid it (under 4 chars / bad pattern)
//   • OPEN   — no active account (likely free)
//   • UNCLAIMABLE — looks open here, but our community flagged it as not actually
//                   registerable (they tried and Twitch refused). This is the
//                   crowd-sourced layer that fills Twitch's deliberate blind spot.
//
// GET  /api/usercheck?platform=twitch&usernames=a&usernames=b...
//   → { results:[ { username, status, available } ], note }
//   status: 'taken' | 'open' | 'blocked' | 'unclaimable'
//
// POST /api/usercheck            (Authorization: Bearer <tez token>)
//   body { handles:["foo","bar"] }  → { ok, count }
//   Records handles a signed-in user discovered are unclaimable. Stored in
//   tez_unclaimable so future hunts stop showing them as "open".

import crypto from 'node:crypto';

// Twitch's public web Client-ID (same one twitch.tv uses; safe, no secret needed).
const GQL_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';

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

// Twitch won't let you register a NEW name under 4 chars, over 25, or with
// anything outside [a-z0-9_]. Those can never be claimed → flag them.
function ruleBlocked(login) {
  if (login.length < 4 || login.length > 25) return true;
  if (!/^[a-z0-9_]+$/.test(login)) return true;
  return false;
}

const cleanLogin = (u) => String(u).trim().toLowerCase().replace(/[^a-z0-9_]/g, '');

// Look up which of these logins the community has flagged unclaimable.
async function unclaimableSet(logins) {
  if (!dbReady() || !logins.length) return new Set();
  const list = logins.map((l) => '"' + l + '"').join(',');
  const q = await sb('GET', 'tez_unclaimable?handle=in.(' + encodeURIComponent(list) +
    ')&select=handle,reports,confirmed');
  const set = new Set();
  if (q.json && Array.isArray(q.json)) {
    for (const row of q.json) {
      if (row.confirmed || (row.reports || 0) >= CONFIRM_THRESHOLD) set.add(row.handle);
    }
  }
  return set;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method === 'POST') return report(req, res);
  if (req.method !== 'GET') { res.status(405).json({ error: 'Method not allowed' }); return; }
  return check(req, res);
}

// ---- GET: check availability (with community overlay) ----
async function check(req, res) {
  const platform = (req.query.platform || '').toLowerCase();
  if (platform !== 'twitch') {
    res.status(400).json({ error: 'Only platform=twitch is supported right now.' });
    return;
  }

  // usernames arrive as repeated params (?usernames=a&usernames=b) → array on
  // Vercel — or as a comma string. Handle both.
  const rawParam = req.query.usernames;
  const rawList = Array.isArray(rawParam) ? rawParam : String(rawParam || '').split(',');
  const logins = [...new Set(
    rawList.map(cleanLogin).filter((u) => u.length >= 1 && u.length <= 25)
  )].slice(0, 100);

  if (logins.length === 0) { res.status(400).json({ results: [] }); return; }

  try {
    // One batched GQL request, aliased per login. __typename is "User" when an
    // active account exists, "UserDoesNotExist" when it doesn't.
    const query = 'query{' +
      logins.map((l, i) => `u${i}:userResultByLogin(login:"${l}"){__typename}`).join(' ') +
      '}';

    const r = await fetch('https://gql.twitch.tv/gql', {
      method: 'POST',
      headers: { 'Client-Id': GQL_CLIENT_ID, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    });

    if (!r.ok) {
      if (r.status === 429) { res.status(429).json({ error: 'Rate limited by Twitch.' }); return; }
      throw new Error('Twitch GQL error: ' + r.status);
    }

    const j = await r.json();
    const data = (j && j.data) || {};

    // First pass: taken / blocked / open from Twitch + our rules.
    const base = logins.map((login, i) => {
      const node = data['u' + i];
      const exists = node && node.__typename === 'User';
      let status;
      if (exists) status = 'taken';
      else if (ruleBlocked(login)) status = 'blocked';
      else status = 'open';
      return { username: login, status };
    });

    // Second pass: overlay the community "unclaimable" layer onto open names.
    const openLogins = base.filter((r) => r.status === 'open').map((r) => r.username);
    const flagged = await unclaimableSet(openLogins);

    const results = base.map((r) => {
      const status = (r.status === 'open' && flagged.has(r.username)) ? 'unclaimable' : r.status;
      return { username: r.username, status, available: status === 'open' };
    });

    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
    res.status(200).json({
      results,
      note: 'open = no active Twitch account. unclaimable = community-flagged as not registerable. Twitch still reserves some names, so verify before relying on it.',
    });
  } catch (err) {
    console.error('usercheck', err);
    res.status(502).json({ error: 'Could not reach Twitch — try again.' });
  }
}

// ---- POST: a signed-in user reports handles as unclaimable ----
async function report(req, res) {
  if (!dbReady()) { res.status(503).json({ error: 'Reporting is not set up yet.' }); return; }
  const payload = verifyToken(bearer(req));
  if (!payload) { res.status(401).json({ error: 'Sign in to flag unclaimable names.' }); return; }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) { body = {}; } }
  const handles = [...new Set(
    (Array.isArray(body && body.handles) ? body.handles : [])
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
