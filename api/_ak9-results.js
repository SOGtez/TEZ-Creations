// AK9 AWARDS — public RESULTS (no auth). Winners + full tally per award.
//
// GET → while voting is still open:
//         { revealed:false, settings:{ month_label, deadline, voting_open } }
//       once voting is CLOSED (voting_open=false OR past the deadline):
//         { revealed:true, totalVoters, settings, awards:[ {
//             id, title, description, total,
//             winnerIds:[…],                 // all nominees tied for the top (empty if 0 votes)
//             nominees:[ { id, name, image, votes } ]  // sorted most→least
//           } ] }
//
// Vote counts are ONLY ever returned after voting closes — never during, so the
// live standings can't be watched or gamed. Mirrors the admin tally logic.

import { configured, sb, cors } from './_ak9.js';

function isClosed(s) {
  if (!s) return false;
  if (s.voting_open === false) return true;
  if (s.deadline && Date.now() > new Date(s.deadline).getTime()) return true;
  return false;
}

export default async function handler(req, res) {
  cors(res);
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') { res.status(405).json({ error: 'Method not allowed' }); return; }
  if (!configured()) { res.status(503).json({ error: 'AK9 Awards is not set up yet.' }); return; }

  try {
    // select=* so optional/added columns never break the query (project convention).
    const s = (await sb('GET', 'ak9_settings?id=eq.1&select=*&limit=1')).json;
    const settings = (s || [])[0] || { month_label: '', deadline: null, voting_open: true };
    const pub = { month_label: settings.month_label || '', deadline: settings.deadline || null, voting_open: settings.voting_open !== false };

    if (!isClosed(settings)) { res.status(200).json({ revealed: false, settings: pub }); return; }

    const awards = (await sb('GET', 'ak9_awards?select=id,title,description,sort,nominees&order=sort.asc,created_at.asc')).json || [];
    const votes = (await sb('GET', 'ak9_votes?select=choices')).json || [];

    // tally: { awardId: { nomineeId: count } }
    const tally = {};
    votes.forEach(v => {
      const ch = v.choices || {};
      for (const awardId of Object.keys(ch)) {
        (tally[awardId] || (tally[awardId] = {}));
        const nid = ch[awardId];
        tally[awardId][nid] = (tally[awardId][nid] || 0) + 1;
      }
    });

    const out = awards.map(a => {
      const counts = tally[a.id] || {};
      const noms = (Array.isArray(a.nominees) ? a.nominees : []).map(n => ({
        id: String(n.id || ''), name: String(n.name || ''), image: String(n.image || ''),
        votes: counts[String(n.id || '')] || 0,
      }));
      noms.sort((x, y) => y.votes - x.votes);
      const total = noms.reduce((sum, n) => sum + n.votes, 0);
      const max = noms.reduce((m, n) => Math.max(m, n.votes), 0);
      const winnerIds = max > 0 ? noms.filter(n => n.votes === max).map(n => n.id) : [];
      return { id: a.id, title: a.title, description: a.description || '', total, winnerIds, nominees: noms };
    });

    res.status(200).json({ revealed: true, totalVoters: votes.length, settings: pub, awards: out });
  } catch (err) {
    console.error('ak9-results', err);
    res.status(502).json({ error: 'Could not load results.' });
  }
}
