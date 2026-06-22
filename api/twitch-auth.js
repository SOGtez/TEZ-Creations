// TEZ Creations — Sub Goal: Twitch OAuth code exchange.
// Authorization Code flow → store the long-lived refresh token server-side in
// Supabase, hand the overlay only an opaque id. The refresh token + client
// secret never leave the server. No SDK (keeps the project build-free).
//
// Env (Vercel → Settings → Environment Variables):
//   TWITCH_CLIENT_SECRET       app secret from the Twitch dev console — SERVER ONLY
//   SUPABASE_URL               your project URL (same one in gauntlet/config.js)
//   SUPABASE_SERVICE_ROLE_KEY  service role key — SERVER ONLY, never shipped to client
//
// POST { code, redirect_uri } → { id, login, display_name, profile_image_url }

// public client id (same one the setup page uses; safe to hardcode)
const CLIENT_ID = 'i5n7ykd3ns3n0fxgbith466dnj51fc';

// only let codes be exchanged for our own registered redirect URIs
const ALLOWED_REDIRECTS = [
  'https://tezcreations.com/subgoal/',
  'https://www.tezcreations.com/subgoal/',
  'http://localhost:3000/subgoal/',
];

const env = () => ({
  secret: process.env.TWITCH_CLIENT_SECRET,
  sbUrl: process.env.SUPABASE_URL,
  sbKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
});
const configured = () => { const e = env(); return !!(e.secret && e.sbUrl && e.sbKey); };

function makeId(login) {
  const slug = String(login || 'sg').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20) || 'sg';
  const rnd = Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
  return slug + '-' + rnd;
}

async function sbUpsert(row) {
  const e = env();
  const r = await fetch(e.sbUrl + '/rest/v1/subgoal_tokens', {
    method: 'POST',
    headers: {
      apikey: e.sbKey, Authorization: 'Bearer ' + e.sbKey,
      'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify([row]),
  });
  if (!r.ok) throw new Error('store ' + r.status);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  if (!configured()) { res.status(503).json({ error: 'Twitch connect is not set up yet.' }); return; }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  body = body || {};
  const code = String(body.code || '');
  const redirectUri = String(body.redirect_uri || '');
  if (!code) { res.status(400).json({ error: 'Missing code.' }); return; }
  if (!ALLOWED_REDIRECTS.includes(redirectUri)) { res.status(400).json({ error: 'Bad redirect.' }); return; }

  const e = env();
  try {
    // 1) exchange the authorization code for tokens
    const tok = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: CLIENT_ID, client_secret: e.secret,
        code, grant_type: 'authorization_code', redirect_uri: redirectUri,
      }),
    });
    const tj = await tok.json();
    if (!tok.ok || !tj.refresh_token) { res.status(400).json({ error: 'Twitch rejected the login — try again.' }); return; }

    // 2) validate the access token → broadcaster id + login
    const val = await fetch('https://id.twitch.tv/oauth2/validate',
      { headers: { Authorization: 'OAuth ' + tj.access_token } });
    const vj = await val.json();
    if (!val.ok || !vj.user_id) { res.status(502).json({ error: 'Could not read your Twitch account.' }); return; }

    // 3) profile (display name + avatar) for the "connected" row
    let display = vj.login, avatar = '';
    try {
      const u = await fetch('https://api.twitch.tv/helix/users?id=' + vj.user_id,
        { headers: { Authorization: 'Bearer ' + tj.access_token, 'Client-Id': CLIENT_ID } });
      const uj = await u.json();
      const me = (uj.data || [])[0] || {};
      display = me.display_name || vj.login;
      avatar = me.profile_image_url || '';
    } catch (_) { /* non-fatal */ }

    // 4) store the refresh token under a fresh opaque id
    const id = makeId(vj.login);
    await sbUpsert({
      id, broadcaster_id: vj.user_id, login: vj.login,
      refresh_token: tj.refresh_token, scope: (tj.scope || []).join(' '),
      updated_at: new Date().toISOString(),
    });

    res.status(200).json({ id, login: vj.login, display_name: display, profile_image_url: avatar });
  } catch (err) {
    console.error('twitch-auth', err);
    res.status(502).json({ error: 'Could not complete the connection — try again.' });
  }
}
