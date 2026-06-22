// TEZ Creations — Sub Goal (Kick): OAuth code exchange + webhook registration.
// Kick uses Authorization Code + PKCE + client secret. We store the refresh token
// server-side (Supabase, locked) and hand the overlay an opaque id. Then we register
// the channel.subscription.* webhooks so Kick pushes sub events to /api/kick-webhook.
// No SDK (keeps the project build-free).
//
// Env (Vercel): KICK_CLIENT_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// POST { code, code_verifier, redirect_uri } → { id, login, display_name, profile_image_url }

const CLIENT_ID = '01KVRE8MZK5EY1QMJ178V7FV4V';   // public Kick app client id

const ALLOWED_REDIRECTS = [
  'https://tezcreations.com/subgoal/',
  'https://www.tezcreations.com/subgoal/',
  'http://localhost:3000/subgoal/',
];

// the sub events we want Kick to push to our webhook
const EVENTS = [
  { name: 'channel.subscription.new', version: 1 },
  { name: 'channel.subscription.renewal', version: 1 },
  { name: 'channel.subscription.gifts', version: 1 },
];

const env = () => ({
  secret: process.env.KICK_CLIENT_SECRET,
  sbUrl: process.env.SUPABASE_URL,
  sbKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
});
const configured = () => { const e = env(); return !!(e.secret && e.sbUrl && e.sbKey); };

function makeId(login) {
  const slug = String(login || 'kick').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20) || 'kick';
  const rnd = Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
  return slug + '-' + rnd;
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
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  if (!configured()) { res.status(503).json({ error: 'Kick connect is not set up yet.' }); return; }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  body = body || {};
  const code = String(body.code || '');
  const verifier = String(body.code_verifier || '');
  const redirectUri = String(body.redirect_uri || '');
  if (!code || !verifier) { res.status(400).json({ error: 'Missing code.' }); return; }
  if (!ALLOWED_REDIRECTS.includes(redirectUri)) { res.status(400).json({ error: 'Bad redirect.' }); return; }

  const e = env();
  try {
    // 1) exchange code (+ PKCE verifier) for tokens
    const tok = await fetch('https://id.kick.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code', client_id: CLIENT_ID, client_secret: e.secret,
        code, redirect_uri: redirectUri, code_verifier: verifier,
      }),
    });
    const tj = await tok.json();
    if (!tok.ok || !tj.refresh_token) { res.status(400).json({ error: 'Kick rejected the login — try again.' }); return; }

    // 2) who is this? (broadcaster id + name + avatar) — Users endpoint returns the token's user
    let userId = '', login = '', display = '', avatar = '';
    try {
      const u = await fetch('https://api.kick.com/public/v1/users', { headers: { Authorization: 'Bearer ' + tj.access_token } });
      const uj = await u.json();
      const me = (uj.data || [])[0] || {};
      userId = String(me.user_id || me.id || '');
      login = me.name || me.username || me.slug || '';
      display = me.name || login;
      avatar = me.profile_picture || me.profile_pic || '';
    } catch (_) { /* handled below */ }
    if (!userId) { res.status(502).json({ error: 'Could not read your Kick account.' }); return; }

    // 3) register the subscription webhooks (Kick sends them to the app's configured URL)
    try {
      const sub = await fetch('https://api.kick.com/public/v1/events/subscriptions', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + tj.access_token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ events: EVENTS, method: 'webhook' }),
      });
      if (!sub.ok) console.warn('kick events subscribe', sub.status, await sub.text().catch(() => ''));
    } catch (err) { console.warn('kick events subscribe failed', err); }

    // 4) store the refresh token (locked) + reset/seed the live count row.
    //    Reconnect replaces any prior link for this channel (fresh session count).
    const id = makeId(login);
    await sb('kick_tokens?broadcaster_user_id=eq.' + encodeURIComponent(userId), { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
    await sb('kick_subs?broadcaster_user_id=eq.' + encodeURIComponent(userId), { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
    const r1 = await sb('kick_tokens', { method: 'POST', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify([{ id, broadcaster_user_id: userId, login, refresh_token: tj.refresh_token, scope: tj.scope || '', updated_at: new Date().toISOString() }]) });
    const r2 = await sb('kick_subs', { method: 'POST', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify([{ id, broadcaster_user_id: userId, login, count: 0, updated_at: new Date().toISOString() }]) });
    if (!r1.ok || !r2.ok) { res.status(502).json({ error: 'Could not save the connection.' }); return; }

    res.status(200).json({ id, login, display_name: display, profile_image_url: avatar });
  } catch (err) {
    console.error('kick-auth', err);
    res.status(502).json({ error: 'Could not complete the connection — try again.' });
  }
}
