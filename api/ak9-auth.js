// AK9 AWARDS — Twitch OAuth code exchange.
// POST { code, redirect_uri, role? }
//   role omitted/"voter" → { access_token, expires_in, user, isAdmin }
//   role "broadcaster"   → also stores the refresh token (with moderator:read:followers)
//                          so the server can verify followers; → { ok, login, broadcaster:true }
//
// The voter's access token is returned to the client and sent as a Bearer on later
// calls (identity-only, no sensitive scope). The broadcaster's refresh token is the
// only sensitive one and it never leaves the server.

import { CLIENT_ID, ALLOWED_REDIRECTS, env, configured, isAdminLogin, sb,
  getProfile, cors, readBody } from './_ak9.js';

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  if (!configured()) { res.status(503).json({ error: 'AK9 Awards is not set up yet.' }); return; }

  const body = readBody(req);
  const code = String(body.code || '');
  const redirectUri = String(body.redirect_uri || '');
  const role = body.role === 'broadcaster' ? 'broadcaster' : 'voter';
  if (!code) { res.status(400).json({ error: 'Missing code.' }); return; }
  if (!ALLOWED_REDIRECTS.includes(redirectUri)) { res.status(400).json({ error: 'Bad redirect.' }); return; }

  const e = env();
  try {
    // 1) exchange the authorization code for tokens
    const tok = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: CLIENT_ID, client_secret: e.secret,
        code, grant_type: 'authorization_code', redirect_uri: redirectUri,
      }),
    });
    const tj = await tok.json();
    if (!tok.ok || !tj.access_token) { res.status(400).json({ error: 'Twitch rejected the login — try again.' }); return; }

    // 2) validate → user id + login
    const val = await fetch('https://id.twitch.tv/oauth2/validate',
      { headers: { Authorization: 'OAuth ' + tj.access_token } });
    const vj = await val.json();
    if (!val.ok || !vj.user_id) { res.status(502).json({ error: 'Could not read your Twitch account.' }); return; }

    if (role === 'broadcaster') {
      // store the refresh token for follower verification (needs moderator:read:followers)
      if (!tj.refresh_token) { res.status(400).json({ error: 'Twitch did not return a refresh token — try again.' }); return; }
      const scope = (tj.scope || []).join(' ');
      if (!/moderator:read:followers/.test(scope)) {
        res.status(400).json({ error: 'Missing the follower-read permission — reconnect and approve it.' }); return;
      }
      const up = await sb('POST', 'ak9_broadcaster', {
        body: [{ id: 1, broadcaster_id: vj.user_id, login: vj.login,
          refresh_token: tj.refresh_token, scope, updated_at: new Date().toISOString() }],
        prefer: 'resolution=merge-duplicates,return=minimal',
      });
      if (!up.ok) { res.status(502).json({ error: 'Could not save the channel connection.' }); return; }
      res.status(200).json({ ok: true, login: vj.login, broadcaster: true });
      return;
    }

    // voter: hand back a short-lived access token (used as Bearer) + profile
    const prof = await getProfile(tj.access_token, vj.user_id);
    res.status(200).json({
      access_token: tj.access_token,
      expires_in: tj.expires_in || 3600,
      user: {
        id: vj.user_id, login: vj.login,
        display_name: prof.display_name || vj.login,
        profile_image_url: prof.profile_image_url || '',
      },
      isAdmin: isAdminLogin(vj.login),
    });
  } catch (err) {
    console.error('ak9-auth', err);
    res.status(502).json({ error: 'Could not complete the login — try again.' });
  }
}
