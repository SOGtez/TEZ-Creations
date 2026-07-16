// AK9 AWARDS — public ballot (no auth, no vote data).
// GET → { settings:{ month_label, deadline, voting_open }, awards:[ ... ] }
// Used to render the awards + nominees for everyone (logged in or not). Vote
// counts are NEVER included here — only the admin endpoint returns those.

import { configured, sb, cors } from './_ak9.js';

// strip nominees down to what the public page needs
function publicNominees(n) {
  return (Array.isArray(n) ? n : []).map(x => ({
    id: String(x.id || ''), name: String(x.name || ''), image: String(x.image || ''),
  }));
}

export default async function handler(req, res) {
  cors(res);
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') { res.status(405).json({ error: 'Method not allowed' }); return; }
  if (!configured()) { res.status(503).json({ error: 'AK9 Awards is not set up yet.' }); return; }

  try {
    const s = (await sb('GET', 'ak9_settings?id=eq.1&select=month_label,deadline,voting_open,phase,nominate_deadline&limit=1')).json;
    const settings = (s || [])[0] || { month_label: '', deadline: null, voting_open: true, phase: 'vote', nominate_deadline: null };
    const aw = (await sb('GET', 'ak9_awards?select=id,title,description,sort,nominees&order=sort.asc,created_at.asc')).json || [];
    const awards = aw.map(a => ({
      id: a.id, title: a.title, description: a.description || '',
      sort: a.sort || 0, nominees: publicNominees(a.nominees),
    }));
    res.status(200).json({ settings, awards });
  } catch (err) {
    console.error('ak9-ballot', err);
    res.status(502).json({ error: 'Could not load the ballot.' });
  }
}
