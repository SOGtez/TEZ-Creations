// TEZ Creations — Sub Goal (Kick): webhook receiver for subscription events.
// Kick POSTs channel.subscription.* events here (URL set in the Kick app dashboard).
// We verify Kick's RSA signature over the RAW body, then bump the live sub count in
// Supabase, which the overlay reads via realtime. No SDK.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//
// Counting (matches Twitch's total behaviour): new sub = +1, each gifted sub = +1,
// renewals do NOT count (a renewal is the same subscriber, like Twitch).

import crypto from 'node:crypto';

// raw body is required for signature verification — don't let Vercel JSON-parse it
export const config = { api: { bodyParser: false } };

const env = () => ({
  sbUrl: process.env.SUPABASE_URL,
  sbKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
});
const configured = () => { const e = env(); return !!(e.sbUrl && e.sbKey); };

let PUBKEY = null;   // cached PEM public key (warm instances)
async function getPublicKey() {
  if (PUBKEY) return PUBKEY;
  const r = await fetch('https://api.kick.com/public/v1/public-key');
  const j = await r.json();
  PUBKEY = (j && j.data && (j.data.public_key || j.data.publicKey)) || j.public_key || null;
  return PUBKEY;
}

function readRaw(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function verify(pubPem, message, sigB64) {
  try {
    const v = crypto.createVerify('RSA-SHA256');
    v.update(message); v.end();
    return v.verify(pubPem, Buffer.from(sigB64, 'base64'));
  } catch (e) { return false; }
}

async function sb(path, opts) {
  const e = env();
  return fetch(e.sbUrl + '/rest/v1/' + path, {
    ...opts,
    headers: {
      apikey: e.sbKey, Authorization: 'Bearer ' + e.sbKey,
      'Content-Type': 'application/json', ...(opts && opts.headers),
    },
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  if (!configured()) { res.status(503).json({ error: 'not configured' }); return; }

  const raw = await readRaw(req);
  const h = req.headers;
  const msgId = h['kick-event-message-id'];
  const ts = h['kick-event-message-timestamp'];
  const sig = h['kick-event-signature'];
  const type = h['kick-event-type'];

  // verify signature: RSA-SHA256 over `<messageId>.<timestamp>.<rawBody>`
  if (!msgId || !ts || !sig) { res.status(400).json({ error: 'missing headers' }); return; }
  const pub = await getPublicKey();
  if (!pub || !verify(pub, `${msgId}.${ts}.${raw}`, sig)) { res.status(403).json({ error: 'bad signature' }); return; }

  let body; try { body = JSON.parse(raw); } catch (e) { res.status(400).json({ error: 'bad body' }); return; }

  // how many subs does this event add?
  let delta = 0;
  if (type === 'channel.subscription.new') delta = 1;
  else if (type === 'channel.subscription.gifts') delta = Math.max(1, (body.giftees || []).length);
  // renewals (and anything else) → 0; acknowledge and stop
  if (delta === 0) { res.status(200).json({ ok: true, counted: 0 }); return; }

  const broadcasterId = String((body.broadcaster && body.broadcaster.user_id) || '');
  if (!broadcasterId) { res.status(200).json({ ok: true, counted: 0 }); return; }

  try {
    // read current count, then add (low-volume stream counter; read+patch is fine)
    const cur = await sb('kick_subs?broadcaster_user_id=eq.' + encodeURIComponent(broadcasterId) + '&select=count&limit=1');
    const row = cur.ok ? (await cur.json())[0] : null;
    if (!row) { res.status(200).json({ ok: true, counted: 0 }); return; }   // no overlay connected for this channel
    const next = (row.count || 0) + delta;
    await sb('kick_subs?broadcaster_user_id=eq.' + encodeURIComponent(broadcasterId), {
      method: 'PATCH', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ count: next, last_event: { type, at: ts }, updated_at: new Date().toISOString() }),
    });
    res.status(200).json({ ok: true, counted: delta });
  } catch (err) {
    console.error('kick-webhook', err);
    res.status(200).json({ ok: true });   // 200 so Kick doesn't hammer retries on our transient error
  }
}
