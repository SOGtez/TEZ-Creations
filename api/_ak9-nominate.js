// AK9 AWARDS — phase 1: submit nominations (Bearer = the voter's Twitch access token).
// POST { choices: { awardId: "free-text nominee name", ... } } → { ok:true }
//
// Same guardrails as voting, server-enforced:
//   • valid token → trusted Twitch user id
//   • phase is 'nominate' and the nominate deadline hasn't passed
//   • the nominator follows the channel (admins bypass)
//   • every awardId is real; each nominee is a short free-text name
//   • one nomination submission per person — PK(twitch_user_id) makes a 2nd insert 409.

import { configured, validateToken, bearer, isAdminLogin, checkFollows,
  getProfile, sb, cors, readBody } from './_ak9.js';

const MAX_NAME = 60;

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  if (!configured()) { res.status(503).json({ error: 'AK9 Awards is not set up yet.' }); return; }

  const token = bearer(req);
  const id = await validateToken(token);
  if (!id) { res.status(401).json({ error: 'Log in again.' }); return; }

  const body = readBody(req);
  const raw = (body.choices && typeof body.choices === 'object') ? body.choices : null;
  if (!raw || !Object.keys(raw).length) { res.status(400).json({ error: 'No nominations submitted.' }); return; }

  try {
    const admin = isAdminLogin(id.login);

    // must be in the nomination phase, within the deadline
    const s = (await sb('GET', 'ak9_settings?id=eq.1&select=phase,nominate_deadline&limit=1')).json;
    const settings = (s || [])[0] || { phase: 'vote', nominate_deadline: null };
    if (settings.phase !== 'nominate') { res.status(403).json({ error: 'Nominations aren’t open.' }); return; }
    if (settings.nominate_deadline && Date.now() > new Date(settings.nominate_deadline).getTime()) {
      res.status(403).json({ error: 'Nominations have ended.' }); return;
    }

    // follower gate (admins bypass)
    if (!admin) {
      const f = await checkFollows(id.user_id);
      if (f === null) { res.status(503).json({ error: 'Nominations aren’t open yet — try again soon.' }); return; }
      if (!f) { res.status(403).json({ error: 'follow_required' }); return; }
    }

    // only accept awardIds that actually exist; each nominee is a trimmed name string
    const awards = (await sb('GET', 'ak9_awards?select=id')).json || [];
    const validAward = new Set(awards.map(a => String(a.id)));
    const clean = {};
    for (const awardId of Object.keys(raw)) {
      if (!validAward.has(String(awardId))) continue;
      const name = String(raw[awardId] || '').trim().replace(/\s+/g, ' ').slice(0, MAX_NAME);
      if (name) clean[awardId] = name;
    }
    if (!Object.keys(clean).length) { res.status(400).json({ error: 'Add at least one nominee.' }); return; }
    // every award must be nominated (mirrors the client gate — no partial ballots)
    if (validAward.size && Object.keys(clean).length < validAward.size) {
      res.status(400).json({ error: 'Please name someone for every award.' }); return;
    }

    const prof = await getProfile(token, id.user_id);
    const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || null;
    const ins = await sb('POST', 'ak9_nominations', {
      body: [{
        twitch_user_id: id.user_id, twitch_login: id.login,
        display_name: prof.display_name || id.login, choices: clean, ip,
      }],
      prefer: 'return=minimal',
    });
    if (ins.status === 409) { res.status(409).json({ error: 'already_nominated' }); return; }
    if (!ins.ok) { res.status(502).json({ error: 'Could not save your nominations — try again.' }); return; }

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('ak9-nominate', err);
    res.status(502).json({ error: 'Could not save your nominations — try again.' });
  }
}
