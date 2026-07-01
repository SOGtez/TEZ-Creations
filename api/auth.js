// TEZ Creations — accounts backend (sign up / log in / session).
//
// One Serverless Function, dispatched by ?route=  (keeps us under Vercel's
// 12-function Hobby limit). No SDK — plain fetch + Node crypto, build-free.
//
//   POST /api/auth?route=signup   { name, email, password }  -> { token, user }
//   POST /api/auth?route=login    { email, password }        -> { token, user }
//   GET  /api/auth?route=me       (Authorization: Bearer …)  -> { user }
//
// Env (Vercel → Settings → Environment Variables):
//   SUPABASE_URL               project URL (same one the other tools use)
//   SUPABASE_SERVICE_ROLE_KEY  service role key — SERVER ONLY
//   AUTH_SECRET                (optional) HMAC key for session tokens. If unset
//                              we fall back to the service-role key, so no extra
//                              setup is required; set it to rotate all sessions.
//
// Passwords are hashed with scrypt (salted, per-user). Sessions are stateless
// HMAC-signed tokens (30 days). The DB never stores a plaintext password.

import crypto from 'node:crypto';
import dns from 'node:dns';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SECRET = process.env.AUTH_SECRET || SUPABASE_KEY || '';
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

const configured = () => !!(SUPABASE_URL && SUPABASE_KEY && SECRET);

// ---- tiny Supabase REST wrapper (service role bypasses RLS) ----
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

// ---- password hashing (scrypt) ----
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const dk = crypto.scryptSync(pw, salt, 64);
  return 's2$' + salt.toString('hex') + '$' + dk.toString('hex');
}
function verifyPassword(pw, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 3 || parts[0] !== 's2') return false;
  const want = Buffer.from(parts[2], 'hex');
  const got = crypto.scryptSync(pw, Buffer.from(parts[1], 'hex'), 64);
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

// ---- session token (stateless, HMAC-signed) ----
function signToken(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return body + '.' + sig;
}
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

// Friendly public id, e.g. "TEZ-7F3K2". Crockford-ish alphabet: no 0/1/I/L/O/U
// so it's easy to read aloud and can't be confused.
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
function genCode() {
  const bytes = crypto.randomBytes(5);
  let s = '';
  for (let i = 0; i < 5; i++) s += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return 'TEZ-' + s;
}

// Tiers, low → high. `tier` is the source of truth; fall back to the legacy `pro`
// boolean for any row that predates the tier column.
const TIER_RANK = { free: 0, pro: 1, exclusive: 2 };
function tierOf(row) {
  const t = row.tier || (row.pro ? 'pro' : 'free');
  return TIER_RANK[t] === undefined ? 'free' : t;
}
const publicUser = (row) => {
  const tier = tierOf(row);
  return {
    id: row.id, name: row.name, email: row.email, code: row.code || null,
    tier,
    pro: TIER_RANK[tier] >= TIER_RANK.pro, // true for pro AND exclusive
    exclusive: tier === 'exclusive',
    created_at: row.created_at || null,
    pro_until: row.pro_until || null,
  };
};

// Time-limited grants: once pro_until passes, revert the account to free. We do it
// lazily on login / session-refresh and self-heal the DB. A NULL pro_until = permanent.
function isExpiredGrant(row) {
  return row.pro_until && Date.now() > Date.parse(row.pro_until);
}
async function applyExpiry(row) {
  if (!row || !isExpiredGrant(row)) return row;
  row.tier = 'free';
  row.pro_until = null;
  try {
    await sb('PATCH', 'tez_users?id=eq.' + encodeURIComponent(row.id), { body: { tier: 'free', pro_until: null } });
  } catch (_) { /* best-effort; the in-memory downgrade still applies this request */ }
  return row;
}
const issue = (row) => ({ token: signToken({ uid: row.id, exp: Date.now() + TOKEN_TTL_MS }), user: publicUser(row) });

const norm = (e) => String(e || '').trim().toLowerCase();
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// Does this email's domain actually exist and accept mail? Catches typos and
// made-up domains (e.g. "@gmial.con"). It does NOT prove the specific mailbox
// exists or that the user owns it — that needs a confirmation-link flow.
async function emailDomainDeliverable(email) {
  const domain = (email.split('@')[1] || '').trim();
  if (!domain) return false;
  try {
    const mx = await dns.promises.resolveMx(domain);
    if (mx && mx.some((r) => r.exchange)) return true;
  } catch (_) { /* no MX — fall through to A-record check (RFC 5321 fallback) */ }
  try {
    const a = await dns.promises.resolve(domain); // A records
    return Array.isArray(a) && a.length > 0;
  } catch (_) { return false; }
}

function readBody(req) {
  let b = req.body;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch (_) { b = {}; } }
  return b || {};
}
function bearer(req) {
  const h = req.headers.authorization || req.headers.Authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(String(h));
  return m ? m[1].trim() : '';
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (!configured()) { res.status(503).json({ error: 'Accounts are not set up yet.' }); return; }

  const route = String(req.query.route || '');
  try {
    if (route === 'signup') return await signup(req, res);
    if (route === 'login') return await login(req, res);
    if (route === 'me') return await me(req, res);
    if (route === 'update') return await updateProfile(req, res);
    if (route === 'password') return await changePassword(req, res);
    res.status(404).json({ error: 'Unknown route.' });
  } catch (err) {
    console.error('auth', route, err && err.message);
    res.status(500).json({ error: 'Something went wrong. Try again.' });
  }
}

async function signup(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  const b = readBody(req);
  const name = String(b.name || '').trim();
  const email = norm(b.email);
  const pass = String(b.password || '');
  if (name.length < 2) { res.status(400).json({ error: 'Enter your name.' }); return; }
  if (!EMAIL_RE.test(email)) { res.status(400).json({ error: 'Enter a valid email.' }); return; }
  if (pass.length < 6) { res.status(400).json({ error: 'Password must be at least 6 characters.' }); return; }
  if (!(await emailDomainDeliverable(email))) {
    res.status(400).json({ error: "That email domain doesn't exist — check for a typo." });
    return;
  }

  const pass_hash = hashPassword(pass);
  // Insert with a generated code. A 409 is either the email (real "taken") or a
  // rare code collision — disambiguate by checking the email, and regenerate the
  // code on collision.
  for (let attempt = 0; attempt < 6; attempt++) {
    const ins = await sb('POST', 'tez_users', {
      body: { email, name, pass_hash, code: genCode() },
      prefer: 'return=representation',
    });
    if (ins.ok && ins.json && ins.json[0]) { res.status(200).json(issue(ins.json[0])); return; }
    if (ins.status === 409) {
      const ex = await sb('GET', 'tez_users?email=eq.' + encodeURIComponent(email) + '&select=id&limit=1');
      if (ex.json && ex.json[0]) { res.status(409).json({ error: 'An account with that email already exists. Log in instead.' }); return; }
      continue; // code collision → try a new code
    }
    break; // unexpected error
  }
  res.status(502).json({ error: 'Could not create your account. Try again.' });
}

async function login(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  const b = readBody(req);
  const email = norm(b.email);
  const pass = String(b.password || '');
  const q = await sb('GET', 'tez_users?email=eq.' + encodeURIComponent(email) +
    '&select=id,name,email,pass_hash,code,pro,tier,pro_until&limit=1');
  const row = q.json && q.json[0];
  // Same generic message whether the email is unknown or the password is wrong.
  if (!row || !verifyPassword(pass, row.pass_hash)) {
    res.status(401).json({ error: 'Wrong email or password.' });
    return;
  }
  await applyExpiry(row);
  res.status(200).json(issue(row));
}

async function me(req, res) {
  const p = verifyToken(bearer(req) || readBody(req).token);
  if (!p) { res.status(401).json({ error: 'Not signed in.' }); return; }
  const q = await sb('GET', 'tez_users?id=eq.' + encodeURIComponent(p.uid) + '&select=id,name,email,code,pro,tier,created_at,pro_until&limit=1');
  const row = q.json && q.json[0];
  if (!row) { res.status(401).json({ error: 'Account not found.' }); return; }
  await applyExpiry(row);
  res.status(200).json({ user: publicUser(row) });
}

// Update editable profile fields (currently just the display name).
async function updateProfile(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  const p = verifyToken(bearer(req) || readBody(req).token);
  if (!p) { res.status(401).json({ error: 'Not signed in.' }); return; }
  const name = String(readBody(req).name || '').trim();
  if (name.length < 2) { res.status(400).json({ error: 'Enter your name (2+ characters).' }); return; }
  const upd = await sb('PATCH', 'tez_users?id=eq.' + encodeURIComponent(p.uid), {
    body: { name }, prefer: 'return=representation',
  });
  if (upd.ok && upd.json && upd.json[0]) { res.status(200).json({ user: publicUser(upd.json[0]) }); return; }
  res.status(500).json({ error: 'Could not save. Try again.' });
}

// Change password: verify the current one, then store a fresh scrypt hash.
async function changePassword(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  const p = verifyToken(bearer(req) || readBody(req).token);
  if (!p) { res.status(401).json({ error: 'Not signed in.' }); return; }
  const b = readBody(req);
  const current = String(b.current || '');
  const next = String(b.next || '');
  if (next.length < 6) { res.status(400).json({ error: 'New password must be at least 6 characters.' }); return; }
  const q = await sb('GET', 'tez_users?id=eq.' + encodeURIComponent(p.uid) + '&select=pass_hash&limit=1');
  const row = q.json && q.json[0];
  if (!row) { res.status(401).json({ error: 'Account not found.' }); return; }
  if (!verifyPassword(current, row.pass_hash)) { res.status(401).json({ error: 'Current password is wrong.' }); return; }
  const upd = await sb('PATCH', 'tez_users?id=eq.' + encodeURIComponent(p.uid), { body: { pass_hash: hashPassword(next) } });
  if (upd.ok) { res.status(200).json({ ok: true }); return; }
  res.status(500).json({ error: 'Could not update password. Try again.' });
}
