// AK9 AWARDS — cast a vote (Bearer = the voter's Twitch access token).
// POST { choices: { awardId: nomineeId, ... } } → { ok:true }
//
// Every rule is enforced HERE, server-side (the page just mirrors it):
//   • valid token → trusted Twitch user id
//   • voting is open and the deadline hasn't passed
//   • the voter follows the channel (admins bypass)
//   • every chosen nominee actually belongs to its award
//   • one vote per person — the DB UNIQUE(twitch_user_id) makes a 2nd insert 409.

import { configured, validateToken, bearer, isAdminLogin, checkFollows,
  getProfile, sb, cors, readBody } from './_ak9.js';

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  if (!configured()) { res.status(503).json({ error: 'AK9 Awards is not set up yet.' }); return; }

  const token = bearer(req);
  const id = await validateToken(token);
  if (!id) { res.status(401).json({ error: 'Log in again.' }); return; }

  const body = readBody(req);
  const choices = (body.choices && typeof body.choices === 'object') ? body.choices : null;
  if (!choices || !Object.keys(choices).length) { res.status(400).json({ error: 'No picks submitted.' }); return; }

  try {
    const admin = isAdminLogin(id.login);

    // voting open + within deadline
    const s = (await sb('GET', 'ak9_settings?id=eq.1&select=deadline,voting_open&limit=1')).json;
    const settings = (s || [])[0] || { deadline: null, voting_open: true };
    if (!settings.voting_open) { res.status(403).json({ error: 'Voting is closed.' }); return; }
    if (settings.deadline && Date.now() > new Date(settings.deadline).getTime()) {
      res.status(403).json({ error: 'Voting has ended.' }); return;
    }

    // follower gate (admins bypass)
    if (!admin) {
      const f = await checkFollows(id.user_id);
      if (f === null) { res.status(503).json({ error: 'Voting isn’t open yet — try again soon.' }); return; }
      if (!f) { res.status(403).json({ error: 'follow_required' }); return; }
    }

    // validate every pick against the real awards/nominees
    const awards = (await sb('GET', 'ak9_awards?select=id,nominees')).json || [];
    const byId = {};
    awards.forEach(a => { byId[a.id] = new Set((a.nominees || []).map(n => String(n.id))); });
    const clean = {};
    for (const awardId of Object.keys(choices)) {
      const nomineeId = String(choices[awardId]);
      if (!byId[awardId]) { res.status(400).json({ error: 'Unknown award in ballot.' }); return; }
      if (!byId[awardId].has(nomineeId)) { res.status(400).json({ error: 'Invalid pick for an award.' }); return; }
      clean[awardId] = nomineeId;
    }

    // record the vote — UNIQUE(twitch_user_id) makes a duplicate a 409
    const prof = await getProfile(token, id.user_id);
    const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || null;
    const ins = await sb('POST', 'ak9_votes', {
      body: [{
        twitch_user_id: id.user_id, twitch_login: id.login,
        display_name: prof.display_name || id.login, choices: clean, ip,
      }],
      prefer: 'return=minimal',
    });
    if (ins.status === 409) { res.status(409).json({ error: 'already_voted' }); return; }
    if (!ins.ok) { res.status(502).json({ error: 'Could not save your vote — try again.' }); return; }

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('ak9-vote', err);
    res.status(502).json({ error: 'Could not save your vote — try again.' });
  }
}
