// TEZ Creations — Drop #007 Consistency Tracker: claim + public read + backfill.
//
// POST  /api/tracker            { handle, tz }
//   Claim a Twitch channel: resolve it on Helix, create the creator row, arm
//   stream.online/offline EventSub webhooks, import recent VODs as a head start.
//   → { creator, claim_token }   (409 if already claimed, 404 if no such channel)
//
// GET   /api/tracker?u=handle
//   Public read: creator public fields + all activity rows. The client computes
//   streaks — this endpoint stays dumb.
//
// GET   /api/tracker?search=query
//   Find claimed trackers by handle/display name → { results:[{handle, display_name}] }
//
// GET   /api/tracker?preview=handle&tz=...
//   Read-only look at ANY Twitch channel: if claimed → the real record; else a
//   VOD-built preview (creator.preview=true, nothing written to the DB).
//
// PATCH /api/tracker             { handle, claim_token, activity?, schedule?, platforms? }
//   Owner edits (token from claim, verified timing-safe): manual backfill rows
//   (minutes 0 ⇒ delete), the 7-bool weekly schedule, and/or linked handles on
//   other platforms ({ kick, youtube } — empty/missing value unlinks).
//
// Env: TWITCH_CLIENT_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
//      EVENTSUB_SECRET (+ optional TWITCH_CLIENT_ID, EVENTSUB_CALLBACK overrides)

import crypto from 'node:crypto';

// Reuses the Confidential Sub-Goal app (client-credentials only needs id+secret).
const CLIENT_ID = process.env.TWITCH_CLIENT_ID || 'i5n7ykd3ns3n0fxgbith466dnj51fc';
const CALLBACK = process.env.EVENTSUB_CALLBACK || 'https://www.tezcreations.com/api/eventsub';

const env = () => ({
  secret: process.env.TWITCH_CLIENT_SECRET,
  esSecret: process.env.EVENTSUB_SECRET,
  sbUrl: process.env.SUPABASE_URL,
  sbKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
});
const configured = () => { const e = env(); return !!(e.secret && e.sbUrl && e.sbKey); };

// ---- tiny Supabase REST wrapper (house pattern from api/usercheck.js) ----
async function sb(method, path, { body, prefer } = {}) {
  const e = env();
  const headers = { apikey: e.sbKey, Authorization: 'Bearer ' + e.sbKey };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (prefer) headers.Prefer = prefer;
  const r = await fetch(e.sbUrl + '/rest/v1/' + path, {
    method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch (_) { /* non-json */ }
  return { ok: r.ok, status: r.status, json };
}

// ---- Twitch app token (client credentials), cached on warm instances ----
let appTok = null; // { token, exp(ms) }
async function appToken() {
  const now = Date.now();
  if (appTok && appTok.exp - 60000 > now) return appTok.token;
  const r = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID, client_secret: env().secret,
      grant_type: 'client_credentials',
    }),
  });
  const j = await r.json();
  if (!r.ok || !j.access_token) throw new Error('twitch app token ' + r.status);
  appTok = { token: j.access_token, exp: now + (j.expires_in || 3600) * 1000 };
  return appTok.token;
}
async function helix(path) {
  const tok = await appToken();
  const r = await fetch('https://api.twitch.tv/helix/' + path, {
    headers: { 'Client-Id': CLIENT_ID, Authorization: 'Bearer ' + tok },
  });
  const j = await r.json().catch(() => null);
  return { ok: r.ok, status: r.status, json: j };
}

// ---- helpers ----
const cleanLogin = (u) => String(u || '').trim().toLowerCase().replace(/^@/, '');
const validLogin = (u) => /^[a-z0-9_]{3,25}$/.test(u);
const PLATFORMS = ['twitch', 'kick', 'youtube'];
// Linked-handle shapes per platform (twitch is the record's own handle, never linked).
const LINK_RULES = { kick: /^[a-z0-9_]{3,25}$/i, youtube: /^[a-z0-9._-]{3,30}$/i };

function cleanTz(tz) {
  try { new Intl.DateTimeFormat('en', { timeZone: String(tz) }); return String(tz); }
  catch (_) { return 'UTC'; }
}
// Local calendar day (YYYY-MM-DD) of a timestamp in the creator's timezone.
function localDay(ts, tz) {
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(ts)); }
  catch (_) { return new Date(ts).toISOString().slice(0, 10); }
}
// Twitch VOD duration string ("3h20m10s") → minutes.
function durMinutes(s) {
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(String(s || ''));
  if (!m) return 0;
  return (+(m[1] || 0)) * 60 + (+(m[2] || 0)) + ((+(m[3] || 0)) >= 30 ? 1 : 0);
}
function safeEqual(a, b) {
  const A = Buffer.from(String(a || '')), B = Buffer.from(String(b || ''));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}
function publicCreator(row) {
  const ls = row.live_state || {};
  const live = !!(ls.started_at && !ls.last_offline_at);
  return {
    id: row.id, handle: row.handle, display_name: row.display_name,
    tz: row.tz, schedule: row.schedule, platforms: row.platforms || {},
    created_at: row.created_at,
    live, live_started_at: live ? ls.started_at : null,
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (!configured()) { res.status(503).json({ error: 'Tracker is not set up yet.' }); return; }
  if (req.method === 'POST') return claim(req, res);
  if (req.method === 'GET') {
    if (req.query.search !== undefined) return search(req, res);
    if (req.query.preview !== undefined) return preview(req, res);
    return read(req, res);
  }
  if (req.method === 'PATCH') return edit(req, res);
  res.status(405).json({ error: 'Method not allowed' });
}

function parseBody(req) {
  let b = req.body;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch (_) { b = {}; } }
  return b || {};
}

// ---- POST: claim a channel ----
async function claim(req, res) {
  if (!env().esSecret) { res.status(503).json({ error: 'Tracker is not set up yet (EVENTSUB_SECRET missing).' }); return; }
  const body = parseBody(req);
  const handle = cleanLogin(body.handle);
  if (!validLogin(handle)) { res.status(400).json({ error: 'Handles are 3–25 letters, numbers or underscores.' }); return; }
  const tz = cleanTz(body.tz);

  try {
    // 1. resolve the channel on Twitch
    const u = await helix('users?login=' + encodeURIComponent(handle));
    const user = u.json && u.json.data && u.json.data[0];
    if (!user) { res.status(404).json({ error: 'No Twitch channel named "' + handle + '".' }); return; }

    // 2–3. create the creator row with a fresh secret token
    const claimToken = crypto.randomBytes(24).toString('base64url');
    const ins = await sb('POST', 'tracker_creators', {
      body: {
        handle, twitch_id: String(user.id), display_name: user.display_name || handle,
        tz, claim_token: claimToken,
      },
      prefer: 'return=representation',
    });
    if (ins.status === 409) { res.status(409).json({ error: 'That channel is already claimed.' }); return; }
    if (!ins.ok || !ins.json || !ins.json[0]) { res.status(502).json({ error: 'Could not save the claim. Try again.' }); return; }
    const creator = ins.json[0];

    // 4. arm EventSub webhooks — all-or-nothing: any failure rolls the claim back
    const tok = await appToken();
    for (const type of ['stream.online', 'stream.offline']) {
      const r = await fetch('https://api.twitch.tv/helix/eventsub/subscriptions', {
        method: 'POST',
        headers: { 'Client-Id': CLIENT_ID, Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type, version: '1',
          condition: { broadcaster_user_id: String(user.id) },
          transport: { method: 'webhook', callback: CALLBACK, secret: env().esSecret },
        }),
      });
      // 409 = a subscription for this channel already exists (e.g. from a deleted
      // claim) — the webhook still points at us, so treat it as armed.
      if (!r.ok && r.status !== 409) {
        const detail = await r.json().catch(() => null);
        console.error('tracker eventsub subscribe failed', type, r.status, detail);
        await sb('DELETE', 'tracker_creators?id=eq.' + creator.id);
        res.status(502).json({ error: 'Could not arm auto-tracking (Twitch said no). Nothing was claimed — try again.' });
        return;
      }
    }

    // 5. VOD head start — recent archives become activity rows (per-day totals)
    try {
      const days = await vodDays(String(user.id), tz);
      const rows = days.map((d) => ({
        creator_id: creator.id, date: d.date, platform: 'twitch',
        minutes: d.minutes, source: 'vod',
        started_at: d.started_at, updated_at: new Date().toISOString(),
      }));
      if (rows.length) {
        await sb('POST', 'tracker_activity?on_conflict=creator_id,date,platform', {
          body: rows, prefer: 'resolution=merge-duplicates,return=minimal',
        });
      }
    } catch (e) { console.error('tracker vod import', e); }  // head start only — never fail the claim

    res.status(200).json({ creator: publicCreator(creator), claim_token: claimToken });
  } catch (err) {
    console.error('tracker claim', err);
    res.status(502).json({ error: 'Claim failed — try again.' });
  }
}

// Recent archive VODs bucketed per local day → [{date, minutes, started_at}]
async function vodDays(userId, tz) {
  const v = await helix('videos?user_id=' + encodeURIComponent(userId) + '&type=archive&first=20');
  const vids = (v.json && v.json.data) || [];
  const byDay = {};
  for (const vid of vids) {
    const mins = durMinutes(vid.duration);
    if (mins < 1 || !vid.created_at) continue;
    const day = localDay(vid.created_at, tz);          // VOD created_at ≈ stream start
    if (!byDay[day]) byDay[day] = { minutes: 0, started_at: vid.created_at };
    byDay[day].minutes += mins;
    if (vid.created_at < byDay[day].started_at) byDay[day].started_at = vid.created_at;
  }
  return Object.keys(byDay).map((day) => ({
    date: day, minutes: byDay[day].minutes, started_at: byDay[day].started_at,
  }));
}

// The full public record for a claimed creator (shared by read + preview).
async function respondFull(res, row) {
  const a = await sb('GET', 'tracker_activity?creator_id=eq.' + row.id +
    '&select=date,platform,minutes,source&order=date.asc&limit=5000');
  res.setHeader('Cache-Control', 'no-store');    // realtime pages want fresh live_state
  res.status(200).json({ creator: publicCreator(row), activity: a.json || [] });
}

// ---- GET: public read ----
async function read(req, res) {
  const handle = cleanLogin(req.query.u);
  if (!validLogin(handle)) { res.status(400).json({ error: 'bad handle' }); return; }
  try {
    const q = await sb('GET', 'tracker_creators?handle=eq.' + encodeURIComponent(handle) + '&select=*&limit=1');
    const row = q.json && q.json[0];
    if (!row) { res.status(404).json({ error: 'That channel has not been claimed yet.' }); return; }
    await respondFull(res, row);
  } catch (err) {
    console.error('tracker read', err);
    res.status(502).json({ error: 'Could not load the tracker.' });
  }
}

// ---- GET ?search=: find claimed trackers by handle or display name ----
async function search(req, res) {
  const q = String(req.query.search || '').trim().toLowerCase()
    .replace(/[^a-z0-9_ ]/g, '').slice(0, 25);
  if (q.length < 2) { res.status(200).json({ results: [] }); return; }
  try {
    const pat = '*' + q + '*';
    const filter = encodeURIComponent('(handle.ilike.' + pat + ',display_name.ilike.' + pat + ')');
    const r = await sb('GET', 'tracker_creators?or=' + filter +
      '&select=handle,display_name&order=handle.asc&limit=10');
    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
    res.status(200).json({ results: r.json || [] });
  } catch (err) {
    console.error('tracker search', err);
    res.status(502).json({ error: 'Search failed.' });
  }
}

// ---- GET ?preview=: read-only look at ANY channel, claimed or not ----
async function preview(req, res) {
  const handle = cleanLogin(req.query.preview);
  if (!validLogin(handle)) { res.status(400).json({ error: 'bad handle' }); return; }
  const tz = cleanTz(req.query.tz);
  try {
    // already claimed → serve the real record, not a thinner VOD view
    const q = await sb('GET', 'tracker_creators?handle=eq.' + encodeURIComponent(handle) + '&select=*&limit=1');
    if (q.json && q.json[0]) return respondFull(res, q.json[0]);

    const u = await helix('users?login=' + encodeURIComponent(handle));
    const user = u.json && u.json.data && u.json.data[0];
    if (!user) { res.status(404).json({ error: 'No Twitch channel named "' + handle + '".' }); return; }
    const days = await vodDays(String(user.id), tz);   // nothing is written to the DB
    res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=300');
    res.status(200).json({
      creator: {
        id: null, handle: String(user.login || handle).toLowerCase(),
        display_name: user.display_name || handle, tz,
        schedule: [false, false, false, false, false, false, false],
        platforms: {},
        created_at: null, live: false, live_started_at: null, preview: true,
      },
      activity: days.map((d) => ({ date: d.date, platform: 'twitch', minutes: d.minutes, source: 'vod' })),
    });
  } catch (err) {
    console.error('tracker preview', err);
    res.status(502).json({ error: 'Lookup failed — try again.' });
  }
}

// ---- PATCH: owner edits (manual backfill + schedule) ----
async function edit(req, res) {
  const body = parseBody(req);
  const handle = cleanLogin(body.handle);
  if (!validLogin(handle)) { res.status(400).json({ error: 'bad handle' }); return; }
  try {
    const q = await sb('GET', 'tracker_creators?handle=eq.' + encodeURIComponent(handle) + '&select=id,claim_token&limit=1');
    const row = q.json && q.json[0];
    if (!row) { res.status(404).json({ error: 'unknown handle' }); return; }
    if (!safeEqual(body.claim_token, row.claim_token)) { res.status(403).json({ error: 'Bad edit token.' }); return; }

    let saved = 0;
    const items = Array.isArray(body.activity) ? body.activity.slice(0, 100) : [];
    for (const it of items) {
      const date = String(it.date || '');
      const platform = String(it.platform || '');
      const minutes = Math.max(0, Math.min(1440, it.minutes | 0));
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !PLATFORMS.includes(platform)) continue;
      const key = 'creator_id=eq.' + row.id + '&date=eq.' + date + '&platform=eq.' + platform;
      if (minutes === 0) {
        const r = await sb('DELETE', 'tracker_activity?' + key);
        if (r.ok) saved++;
      } else {
        const r = await sb('POST', 'tracker_activity?on_conflict=creator_id,date,platform', {
          body: {
            creator_id: row.id, date, platform, minutes, source: 'manual',
            started_at: null, ended_at: null, updated_at: new Date().toISOString(),
          },
          prefer: 'resolution=merge-duplicates,return=minimal',
        });
        if (r.ok) saved++;
      }
    }

    if (Array.isArray(body.schedule)) {
      if (body.schedule.length !== 7) { res.status(400).json({ error: 'schedule must be 7 booleans' }); return; }
      const sched = body.schedule.map(Boolean);
      const r = await sb('PATCH', 'tracker_creators?id=eq.' + row.id, {
        body: { schedule: sched }, prefer: 'return=minimal',
      });
      if (r.ok) saved++;
    }

    // linked handles on other platforms — full replace of the {kick, youtube} object
    if (body.platforms !== undefined) {
      const src = (body.platforms && typeof body.platforms === 'object' && !Array.isArray(body.platforms))
        ? body.platforms : {};
      const plat = {};
      for (const k of Object.keys(LINK_RULES)) {
        const v = String(src[k] == null ? '' : src[k]).trim().replace(/^@/, '');
        if (!v) continue;                                    // empty ⇒ unlink
        if (!LINK_RULES[k].test(v)) {
          res.status(400).json({ error: 'That ' + k + ' handle does not look right.' });
          return;
        }
        plat[k] = k === 'kick' ? v.toLowerCase() : v;        // youtube handles keep their casing
      }
      const r = await sb('PATCH', 'tracker_creators?id=eq.' + row.id, {
        body: { platforms: plat }, prefer: 'return=minimal',
      });
      // surface a hard failure (e.g. platforms column not migrated yet) instead
      // of a silent success — the page shows its "couldn't save" toast on !ok
      if (!r.ok) { res.status(502).json({ error: 'Could not save the channel links.' }); return; }
      saved++;
    }

    res.status(200).json({ ok: true, saved });
  } catch (err) {
    console.error('tracker edit', err);
    res.status(502).json({ error: 'Edit failed — try again.' });
  }
}
