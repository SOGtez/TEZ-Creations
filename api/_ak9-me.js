// AK9 AWARDS — per-user status (Bearer = the voter's Twitch access token).
// GET → { user, isAdmin, isFollower, hasVoted, choices?, broadcasterReady, settings }
// The voter page calls this after login to decide what to show.

import { configured, validateToken, bearer, isAdminLogin, checkFollows, sb, cors } from './_ak9.js';

export default async function handler(req, res) {
  cors(res);
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'GET') { res.status(405).json({ error: 'Method not allowed' }); return; }
  if (!configured()) { res.status(503).json({ error: 'AK9 Awards is not set up yet.' }); return; }

  const id = await validateToken(bearer(req));
  if (!id) { res.status(401).json({ error: 'Log in again.' }); return; }

  try {
    const admin = isAdminLogin(id.login);

    // already voted?
    const voteRow = (await sb('GET', 'ak9_votes?twitch_user_id=eq.' +
      encodeURIComponent(id.user_id) + '&select=choices,created_at&limit=1')).json;
    const existing = (voteRow || [])[0] || null;

    // already nominated (phase 1)?
    const nomRow = (await sb('GET', 'ak9_nominations?twitch_user_id=eq.' +
      encodeURIComponent(id.user_id) + '&select=choices,created_at&limit=1')).json;
    const nom = (nomRow || [])[0] || null;

    // follower check (admins bypass — you can't follow your own channel)
    let isFollower, broadcasterReady = true;
    if (admin) { isFollower = true; }
    else {
      const f = await checkFollows(id.user_id);
      if (f === null) { broadcasterReady = false; isFollower = false; }
      else isFollower = f;
    }

    // select=* so a not-yet-migrated column (theme / nominate_open) never breaks the query
    const s = (await sb('GET', 'ak9_settings?id=eq.1&select=*&limit=1')).json;
    const settings = (s || [])[0] || { month_label: '', deadline: null, voting_open: true, phase: 'vote', nominate_deadline: null, nominate_open: null, theme: 'classic' };

    res.status(200).json({
      user: { id: id.user_id, login: id.login },
      isAdmin: admin,
      isFollower,
      broadcasterReady,
      hasVoted: !!existing,
      choices: existing ? existing.choices : null,
      hasNominated: !!nom,
      nominateChoices: nom ? nom.choices : null,
      settings,
    });
  } catch (err) {
    console.error('ak9-me', err);
    res.status(502).json({ error: 'Could not load your status.' });
  }
}
