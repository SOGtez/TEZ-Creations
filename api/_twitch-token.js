// TEZ Creations — Sub Goal: mint a short-lived Twitch access token from the
// stored refresh token. The overlay calls this with its opaque id; the powerful
// refresh token + client secret never leave the server. No SDK.
//
// Env: TWITCH_CLIENT_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// GET ?id=<opaque> → { access_token, expires_in, broadcaster_id, client_id }
//   401 { error:'reauth' } → refresh token is dead (revoked); streamer must reconnect.

const CLIENT_ID = 'i5n7ykd3ns3n0fxgbith466dnj51fc';

const env = () => ({
  secret: process.env.TWITCH_CLIENT_SECRET,
  sbUrl: process.env.SUPABASE_URL,
  sbKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
});
const configured = () => { const e = env(); return !!(e.secret && e.sbUrl && e.sbKey); };

// in-memory cache (warm instances only): id -> { access_token, exp(ms), broadcaster_id }
// keeps an OBS source from hitting Twitch's token endpoint on every poll.
const cache = {};

async function sbGet(id) {
  const e = env();
  const r = await fetch(e.sbUrl + '/rest/v1/subgoal_tokens?id=eq.' + encodeURIComponent(id) +
    '&select=refresh_token,broadcaster_id&limit=1',
    { headers: { apikey: e.sbKey, Authorization: 'Bearer ' + e.sbKey } });
  if (!r.ok) throw new Error('lookup ' + r.status);
  return (await r.json())[0] || null;
}
async function sbUpdateRefresh(id, refresh) {
  const e = env();
  await fetch(e.sbUrl + '/rest/v1/subgoal_tokens?id=eq.' + encodeURIComponent(id), {
    method: 'PATCH',
    headers: {
      apikey: e.sbKey, Authorization: 'Bearer ' + e.sbKey,
      'Content-Type': 'application/json', Prefer: 'return=minimal',
    },
    body: JSON.stringify({ refresh_token: refresh, updated_at: new Date().toISOString() }),
  });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  const id = String(req.query.id || '');
  if (!/^[a-z0-9-]{6,80}$/.test(id)) { res.status(400).json({ error: 'bad id' }); return; }
  if (!configured()) { res.status(503).json({ error: 'not configured' }); return; }

  const now = Date.now();
  const hit = cache[id];
  if (hit && hit.exp - 60000 > now) {
    res.status(200).json({
      access_token: hit.access_token, expires_in: Math.round((hit.exp - now) / 1000),
      broadcaster_id: hit.broadcaster_id, client_id: CLIENT_ID,
    });
    return;
  }

  const e = env();
  try {
    const row = await sbGet(id);
    if (!row) { res.status(404).json({ error: 'unknown id' }); return; }

    const tok = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: CLIENT_ID, client_secret: e.secret,
        grant_type: 'refresh_token', refresh_token: row.refresh_token,
      }),
    });
    const tj = await tok.json();
    if (!tok.ok || !tj.access_token) { res.status(401).json({ error: 'reauth' }); return; }

    // Twitch may rotate the refresh token — persist the new one if so.
    if (tj.refresh_token && tj.refresh_token !== row.refresh_token) {
      sbUpdateRefresh(id, tj.refresh_token).catch(() => {});  // fire-and-forget
    }

    const expMs = now + (tj.expires_in || 3600) * 1000;
    if (Object.keys(cache).length > 500) for (const k in cache) delete cache[k];
    cache[id] = { access_token: tj.access_token, exp: expMs, broadcaster_id: row.broadcaster_id };

    res.status(200).json({
      access_token: tj.access_token, expires_in: tj.expires_in || 3600,
      broadcaster_id: row.broadcaster_id, client_id: CLIENT_ID,
    });
  } catch (err) {
    console.error('twitch-token', err);
    res.status(502).json({ error: 'refresh failed' });
  }
}
