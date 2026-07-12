// TEZ Creations — Drop #007 Consistency Tracker: Twitch EventSub webhook receiver.
// Twitch POSTs stream.online / stream.offline here (armed per-creator at claim
// time by api/tracker.js). We verify the HMAC over the RAW body, then upsert the
// creator's activity row for the day, which the page/overlay pick up via Realtime.
//
// Session rules (locked product decisions):
//   • a stream credits the local day it STARTED, in the creator's timezone
//   • an online within 15 min of the previous offline continues the SAME session
//   • online lights the cell immediately (minutes ≥ 1); offline writes the total
//   • a second separate stream the same day ADDS minutes (day_base carries the
//     day's minutes from before the current session)
//
// Env: EVENTSUB_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import crypto from 'node:crypto';

// Twitch's HMAC is over messageId + timestamp + raw body — Vercel must not parse it.
export const config = { api: { bodyParser: false } };

const MERGE_WINDOW_MS = 15 * 60 * 1000;   // disconnect-merge window
const REPLAY_WINDOW_MS = 10 * 60 * 1000;  // reject messages older than this

const env = () => ({
  esSecret: process.env.EVENTSUB_SECRET,
  sbUrl: process.env.SUPABASE_URL,
  sbKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
});
const configured = () => { const e = env(); return !!(e.esSecret && e.sbUrl && e.sbKey); };

function readRaw(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

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

function localDay(ts, tz) {
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(ts)); }
  catch (_) { return new Date(ts).toISOString().slice(0, 10); }
}
function safeEqual(a, b) {
  const A = Buffer.from(String(a || '')), B = Buffer.from(String(b || ''));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}

// Recent message-id dedupe (warm instances). The (creator, date, platform) upsert
// is already idempotent-ish, so a lightweight guard is enough per the spec.
const seenIds = new Set();
function seenBefore(id) {
  if (!id) return false;
  if (seenIds.has(id)) return true;
  seenIds.add(id);
  if (seenIds.size > 500) { const first = seenIds.values().next().value; seenIds.delete(first); }
  return false;
}

async function getCreatorByTwitchId(twitchId) {
  const q = await sb('GET', 'tracker_creators?twitch_id=eq.' + encodeURIComponent(twitchId) +
    '&select=id,tz,live_state&limit=1');
  return (q.json && q.json[0]) || null;
}
async function setLiveState(creatorId, liveState) {
  await sb('PATCH', 'tracker_creators?id=eq.' + creatorId, {
    body: { live_state: liveState }, prefer: 'return=minimal',
  });
}
async function upsertActivity(row) {
  await sb('POST', 'tracker_activity?on_conflict=creator_id,date,platform', {
    body: { ...row, platform: 'twitch', updated_at: new Date().toISOString() },
    prefer: 'resolution=merge-duplicates,return=minimal',
  });
}
// Minutes already on the day's row before the current session starts.
async function dayBase(creatorId, date) {
  const q = await sb('GET', 'tracker_activity?creator_id=eq.' + creatorId +
    '&date=eq.' + date + '&platform=eq.twitch&select=minutes&limit=1');
  const row = q.json && q.json[0];
  return row ? (row.minutes | 0) : 0;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  if (!configured()) { res.status(503).json({ error: 'not configured' }); return; }

  const raw = await readRaw(req);
  const h = req.headers;
  const msgId = h['twitch-eventsub-message-id'];
  const ts = h['twitch-eventsub-message-timestamp'];
  const sig = h['twitch-eventsub-message-signature'];
  const msgType = h['twitch-eventsub-message-type'];
  if (!msgId || !ts || !sig || !msgType) { res.status(400).json({ error: 'missing headers' }); return; }

  // HMAC-SHA256 over `<id><timestamp><rawBody>`, presented as "sha256=<hex>"
  const expect = 'sha256=' + crypto.createHmac('sha256', env().esSecret)
    .update(msgId + ts + raw).digest('hex');
  if (!safeEqual(sig, expect)) { res.status(403).json({ error: 'bad signature' }); return; }

  let body; try { body = JSON.parse(raw); } catch (_) { res.status(400).json({ error: 'bad body' }); return; }

  // -- webhook_callback_verification: echo the challenge as plain text --
  if (msgType === 'webhook_callback_verification') {
    res.setHeader('Content-Type', 'text/plain');
    res.status(200).send(String(body.challenge || ''));
    return;
  }

  // -- revocation: remember it on the creator row so a future UI can resurface it --
  if (msgType === 'revocation') {
    console.error('eventsub revoked', body.subscription && body.subscription.type,
      body.subscription && body.subscription.status);
    try {
      const bid = body.subscription && body.subscription.condition &&
        body.subscription.condition.broadcaster_user_id;
      if (bid) {
        const creator = await getCreatorByTwitchId(String(bid));
        if (creator) {
          await setLiveState(creator.id, { ...(creator.live_state || {}), revoked_at: new Date().toISOString() });
        }
      }
    } catch (e) { console.error('eventsub revocation store', e); }
    res.status(204).end();
    return;
  }

  if (msgType !== 'notification') { res.status(200).json({ ok: true }); return; }

  // replay guard + dedupe — always answer 2xx fast after this point
  if (Math.abs(Date.now() - Date.parse(ts)) > REPLAY_WINDOW_MS) { res.status(403).json({ error: 'stale message' }); return; }
  if (seenBefore(msgId)) { res.status(200).json({ ok: true, dedup: true }); return; }

  try {
    const subType = body.subscription && body.subscription.type;
    const event = body.event || {};
    const twitchId = String(event.broadcaster_user_id || '');
    if (!twitchId) { res.status(200).json({ ok: true }); return; }
    const creator = await getCreatorByTwitchId(twitchId);
    if (!creator) { res.status(200).json({ ok: true }); return; }   // no claim for this channel
    const ls = creator.live_state || {};
    const nowIso = new Date().toISOString();

    if (subType === 'stream.online') {
      const withinMerge = ls.last_offline_at && ls.started_at &&
        (Date.now() - Date.parse(ls.last_offline_at)) < MERGE_WINDOW_MS;
      if (withinMerge) {
        // same session continues — keep the original start; the day row already
        // holds the pre-disconnect minutes, offline will recompute from start.
        await setLiveState(creator.id, { ...ls, last_offline_at: null });
      } else {
        const startedAt = event.started_at || nowIso;
        const date = localDay(startedAt, creator.tz);
        const base = await dayBase(creator.id, date);
        await setLiveState(creator.id, { started_at: startedAt, last_offline_at: null, date, day_base: base });
        // light the cell (and the overlay) the moment they go live
        await upsertActivity({
          creator_id: creator.id, date, minutes: Math.max(base, 1),
          source: 'webhook', started_at: startedAt, ended_at: null,
        });
      }
    } else if (subType === 'stream.offline') {
      if (ls.started_at) {
        const elapsed = Math.max(1, Math.round((Date.now() - Date.parse(ls.started_at)) / 60000));
        const date = ls.date || localDay(ls.started_at, creator.tz);   // credit the START day
        await upsertActivity({
          creator_id: creator.id, date, minutes: (ls.day_base | 0) + elapsed,
          source: 'webhook', started_at: ls.started_at, ended_at: nowIso,
        });
        // keep started_at/date/day_base for the 15-min merge window
        await setLiveState(creator.id, { ...ls, last_offline_at: nowIso });
      }
    }

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('eventsub', err);
    res.status(200).json({ ok: true });   // 2xx so Twitch doesn't retry-storm / revoke
  }
}
