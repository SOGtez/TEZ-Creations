// TEZ Creations — Drop #009 Subathon Timer: dashboard API.
// Mounted at /api/apps?route=subathon (underscore helper — no new function).
//
// GET  ?op=get&id=…       → public timer state (overlay poll fallback)
// POST { op, token, … }   → account-authed ops (token = TezAuth session token):
//   me                    → your timer (or null)
//   create                → make your timer (one per account)
//   connect_twitch { conn_id }  conn_id = subgoal_tokens id from /api/twitch?route=auth;
//                               arms the sub EventSub webhooks (app token)
//   connect_kick   { conn_id }  conn_id = kick_tokens id from /api/kick-auth
//   disconnect     { platform }
//   settings       { patch }    free: sec_per_sub, cap_hours · pro: resubs, tier
//                               multipliers, style — gated SERVER-SIDE
//   control        { action, hours?, minutes? }
//                               start/pause/resume/reset free · add/sub = pro
//
// The overlay itself never calls this for live data — it reads the row over
// Supabase realtime (public-read RLS), so settings changes appear instantly.

import crypto from 'node:crypto';
import { sbCore, coreConfigured, withDefaults, DEFAULT_SETTINGS } from './_subathon-core.js';

const CLIENT_ID = 'i5n7ykd3ns3n0fxgbith466dnj51fc';   // shared Twitch app (public)
const CALLBACK = process.env.EVENTSUB_CALLBACK || 'https://www.tezcreations.com/api/eventsub';
const SECRET = process.env.AUTH_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || '';

const configured = () => coreConfigured() && !!SECRET;

// ---- TezAuth session → user row (same token scheme as api/auth.js) --------
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
async function getUser(token) {
  const p = verifyToken(token);
  if (!p || !p.uid) return null;
  const q = await sbCore('GET', 'tez_users?id=eq.' + encodeURIComponent(p.uid) +
    '&select=id,code,tier,pro,pro_until&limit=1');
  const row = q.json && q.json[0];
  if (!row || !row.code) return null;
  let tier = row.tier || (row.pro ? 'pro' : 'free');
  if (row.pro_until && Date.now() > Date.parse(row.pro_until)) tier = 'free';   // lazy expiry
  return { code: row.code, pro: tier === 'pro' || tier === 'exclusive' };
}

// ---- Twitch app token (client credentials) — for arming EventSub ----------
let APP_TOK = null, APP_TOK_EXP = 0;
async function appToken() {
  if (APP_TOK && Date.now() < APP_TOK_EXP - 60000) return APP_TOK;
  const r = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID, client_secret: process.env.TWITCH_CLIENT_SECRET,
      grant_type: 'client_credentials',
    }),
  });
  const j = await r.json();
  if (!r.ok || !j.access_token) throw new Error('twitch app token ' + r.status);
  APP_TOK = j.access_token;
  APP_TOK_EXP = Date.now() + (j.expires_in || 3600) * 1000;
  return APP_TOK;
}

// Arm the sub webhooks for a broadcaster. 409 = already exists → fine.
async function armEventSub(broadcasterId) {
  const tok = await appToken();
  for (const type of ['channel.subscribe', 'channel.subscription.message']) {
    const r = await fetch('https://api.twitch.tv/helix/eventsub/subscriptions', {
      method: 'POST',
      headers: { 'Client-Id': CLIENT_ID, Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type, version: '1',
        condition: { broadcaster_user_id: String(broadcasterId) },
        transport: { method: 'webhook', callback: CALLBACK, secret: process.env.EVENTSUB_SECRET },
      }),
    });
    if (!r.ok && r.status !== 409) {
      const detail = await r.json().catch(() => null);
      console.error('subathon eventsub arm failed', type, r.status, detail);
      return false;
    }
  }
  return true;
}

// ---- helpers --------------------------------------------------------------
const makeId = () => 'sb-' + crypto.randomBytes(9).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12).padEnd(12, '0');

const timerFields = 'id,owner_code,twitch_broadcaster_id,twitch_login,kick_broadcaster_id,kick_login,settings,ends_at,paused_at,stats,last_event';

function publicTimer(t) {
  if (!t) return null;
  return {
    id: t.id,
    twitch_login: t.twitch_login || null, kick_login: t.kick_login || null,
    settings: withDefaults(t.settings),
    ends_at: t.ends_at, paused_at: t.paused_at,
    stats: t.stats || {}, last_event: t.last_event || null,
  };
}

async function myTimer(code) {
  const q = await sbCore('GET', 'subathon_timers?owner_code=eq.' + encodeURIComponent(code) +
    '&select=' + timerFields + '&limit=1');
  return (q.json && q.json[0]) || null;
}
async function patchTimer(id, body) {
  return sbCore('PATCH', 'subathon_timers?id=eq.' + encodeURIComponent(id), {
    body: { ...body, updated_at: new Date().toISOString() }, prefer: 'return=representation',
  });
}

const clamp = (v, lo, hi, dflt) => { v = +v; return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt; };

// Merge a settings patch. Free fields always apply; pro fields only if isPro.
function mergeSettings(cur, patch, isPro) {
  const s = withDefaults(cur);
  const p = patch && typeof patch === 'object' ? patch : {};
  if (p.sec_per_sub !== undefined) s.sec_per_sub = clamp(p.sec_per_sub, 1, 3600, s.sec_per_sub);
  if (p.cap_hours !== undefined) s.cap_hours = clamp(p.cap_hours, 0, 1000, s.cap_hours);
  if (isPro) {
    if (p.count_resubs !== undefined) s.count_resubs = !!p.count_resubs;
    if (p.tier_mult_on !== undefined) s.tier_mult_on = !!p.tier_mult_on;
    if (p.tier_mult && typeof p.tier_mult === 'object') {
      s.tier_mult = {
        t2: clamp(p.tier_mult.t2, 1, 100, s.tier_mult.t2),
        t3: clamp(p.tier_mult.t3, 1, 100, s.tier_mult.t3),
      };
    }
    if (p.style && typeof p.style === 'object') {
      const st = p.style;
      s.style = {
        theme: ['tez', 'minimal', 'neon'].includes(st.theme) ? st.theme : s.style.theme,
        accent: /^#[0-9a-fA-F]{6}$/.test(String(st.accent || '')) ? st.accent : s.style.accent,
        label: st.label !== undefined ? String(st.label).slice(0, 40) : s.style.label,
        show_label: st.show_label !== undefined ? !!st.show_label : s.style.show_label,
        show_toasts: st.show_toasts !== undefined ? !!st.show_toasts : s.style.show_toasts,
        size: st.size !== undefined ? clamp(st.size, 50, 200, s.style.size) : s.style.size,
      };
    }
  }
  return s;
}

function readBody(req) {
  let b = req.body;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch (_) { b = {}; } }
  return b || {};
}

// ---- handler --------------------------------------------------------------
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (!configured()) { res.status(503).json({ error: 'Subathon Timer is not set up yet.' }); return; }

  try {
    if (req.method === 'GET') {
      const id = String(req.query.id || '');
      if (String(req.query.op || 'get') !== 'get' || !id) { res.status(400).json({ error: 'Bad request.' }); return; }
      const q = await sbCore('GET', 'subathon_timers?id=eq.' + encodeURIComponent(id) + '&select=' + timerFields + '&limit=1');
      const t = q.json && q.json[0];
      if (!t) { res.status(404).json({ error: 'Unknown timer.' }); return; }
      res.status(200).json({ timer: publicTimer(t) });
      return;
    }

    if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
    const body = readBody(req);
    const op = String(body.op || '');

    const user = await getUser(body.token);
    if (!user) { res.status(401).json({ error: 'Log in to your TEZ account first.' }); return; }

    if (op === 'me') {
      const t = await myTimer(user.code);
      res.status(200).json({ timer: publicTimer(t), pro: user.pro });
      return;
    }

    if (op === 'create') {
      let t = await myTimer(user.code);
      if (!t) {
        const ins = await sbCore('POST', 'subathon_timers', {
          body: [{ id: makeId(), owner_code: user.code, settings: DEFAULT_SETTINGS, stats: {} }],
          prefer: 'return=representation',
        });
        if (!ins.ok) { res.status(502).json({ error: 'Could not create your timer.' }); return; }
        t = ins.json[0];
      }
      res.status(200).json({ timer: publicTimer(t), pro: user.pro });
      return;
    }

    // everything below needs an existing timer
    const t = await myTimer(user.code);
    if (!t) { res.status(404).json({ error: 'Create your timer first.' }); return; }

    if (op === 'connect_twitch') {
      const connId = String(body.conn_id || '');
      const q = await sbCore('GET', 'subgoal_tokens?id=eq.' + encodeURIComponent(connId) +
        '&select=broadcaster_id,login,scope&limit=1');
      const conn = q.json && q.json[0];
      if (!conn) { res.status(400).json({ error: 'That Twitch connection was not found — connect again.' }); return; }
      if (!/channel:read:subscriptions/.test(conn.scope || '')) {
        res.status(400).json({ error: 'That connection is missing the subscriptions permission — connect again.' }); return;
      }
      if (!(await armEventSub(conn.broadcaster_id))) {
        res.status(502).json({ error: 'Twitch would not let us arm the sub events — try again in a minute.' }); return;
      }
      const u = await patchTimer(t.id, { twitch_broadcaster_id: String(conn.broadcaster_id), twitch_login: conn.login });
      res.status(200).json({ timer: publicTimer((u.json || [])[0] || t), pro: user.pro });
      return;
    }

    if (op === 'connect_kick') {
      const connId = String(body.conn_id || '');
      const q = await sbCore('GET', 'kick_tokens?id=eq.' + encodeURIComponent(connId) +
        '&select=broadcaster_user_id,login&limit=1');
      const conn = q.json && q.json[0];
      if (!conn) { res.status(400).json({ error: 'That Kick connection was not found — connect again.' }); return; }
      const u = await patchTimer(t.id, { kick_broadcaster_id: String(conn.broadcaster_user_id), kick_login: conn.login });
      res.status(200).json({ timer: publicTimer((u.json || [])[0] || t), pro: user.pro });
      return;
    }

    if (op === 'disconnect') {
      const platform = String(body.platform || '');
      const patch = platform === 'kick'
        ? { kick_broadcaster_id: null, kick_login: null }
        : { twitch_broadcaster_id: null, twitch_login: null };
      const u = await patchTimer(t.id, patch);
      res.status(200).json({ timer: publicTimer((u.json || [])[0] || t), pro: user.pro });
      return;
    }

    if (op === 'settings') {
      const merged = mergeSettings(t.settings, body.patch, user.pro);
      const u = await patchTimer(t.id, { settings: merged });
      res.status(200).json({ timer: publicTimer((u.json || [])[0] || t), pro: user.pro });
      return;
    }

    if (op === 'control') {
      const action = String(body.action || '');
      const now = Date.now();
      let patch = null;

      if (action === 'start') {
        const ms = (clamp(body.hours, 0, 1000, 0) * 3600 + clamp(body.minutes, 0, 59, 0) * 60) * 1000;
        if (ms < 60000) { res.status(400).json({ error: 'Give the timer at least 1 minute.' }); return; }
        patch = { ends_at: new Date(now + ms).toISOString(), paused_at: null, stats: {}, last_event: null };
      } else if (action === 'pause') {
        if (!t.ends_at || t.paused_at) { res.status(400).json({ error: 'The timer is not running.' }); return; }
        patch = { paused_at: new Date(now).toISOString() };
      } else if (action === 'resume') {
        if (!t.ends_at || !t.paused_at) { res.status(400).json({ error: 'The timer is not paused.' }); return; }
        const shift = now - Date.parse(t.paused_at);
        patch = { ends_at: new Date(Date.parse(t.ends_at) + shift).toISOString(), paused_at: null };
      } else if (action === 'add' || action === 'sub') {
        if (!user.pro) { res.status(403).json({ error: 'Manual time tools are a Pro feature.' }); return; }
        if (!t.ends_at) { res.status(400).json({ error: 'Start the timer first.' }); return; }
        const ms = clamp(body.minutes, 1, 6000, 0) * 60000;
        if (!ms) { res.status(400).json({ error: 'How many minutes?' }); return; }
        const base = t.paused_at ? Date.parse(t.paused_at) : now;
        const remaining = Math.max(0, Date.parse(t.ends_at) - base);
        const next = action === 'add' ? remaining + ms : Math.max(60000, remaining - ms);
        patch = { ends_at: new Date(base + next).toISOString() };
      } else if (action === 'reset') {
        patch = { ends_at: null, paused_at: null, last_event: null };
      } else {
        res.status(400).json({ error: 'Unknown action.' }); return;
      }

      const u = await patchTimer(t.id, patch);
      res.status(200).json({ timer: publicTimer((u.json || [])[0] || t), pro: user.pro });
      return;
    }

    res.status(400).json({ error: 'Unknown op.' });
  } catch (err) {
    console.error('subathon api', err);
    res.status(502).json({ error: 'Something went wrong.' });
  }
}
