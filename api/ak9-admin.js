// AK9 AWARDS — admin API (Bearer = an admin's Twitch access token).
// Gated SERVER-SIDE: the token is validated and the login must be in AK9_ADMINS.
//
// GET  → { settings, awards, votes, tallies, totalVoters, broadcaster }
// POST { action, ... }:
//   save_award    { award:{ id?, title, description, sort, nominees } }
//   delete_award  { id }
//   save_settings { month_label, deadline, voting_open }
//   reset_votes   { confirm:true }   ← clears ALL votes (new month)

import { configured, validateToken, bearer, isAdminLogin, getBroadcaster, sb, cors, readBody } from './_ak9.js';

async function requireAdmin(req, res) {
  const id = await validateToken(bearer(req));
  if (!id) { res.status(401).json({ error: 'Log in again.' }); return null; }
  if (!isAdminLogin(id.login)) { res.status(403).json({ error: 'Not an admin account.' }); return null; }
  return id;
}

function cleanNominees(arr) {
  return (Array.isArray(arr) ? arr : []).slice(0, 100).map((n, i) => ({
    id: String(n.id || ('n' + (i + 1) + '-' + Math.random().toString(36).slice(2, 8))),
    name: String(n.name || '').slice(0, 120),
    image: String(n.image || '').slice(0, 400),
    twitch_login: String(n.twitch_login || '').slice(0, 60),
  })).filter(n => n.name);
}

export default async function handler(req, res) {
  cors(res);
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (!configured()) { res.status(503).json({ error: 'AK9 Awards is not set up yet.' }); return; }

  const admin = await requireAdmin(req, res);
  if (!admin) return;

  try {
    if (req.method === 'GET') {
      const settings = ((await sb('GET', 'ak9_settings?id=eq.1&select=month_label,deadline,voting_open&limit=1')).json || [])[0]
        || { month_label: '', deadline: null, voting_open: true };
      const awards = (await sb('GET', 'ak9_awards?select=id,title,description,sort,nominees&order=sort.asc,created_at.asc')).json || [];
      const votes = (await sb('GET', 'ak9_votes?select=twitch_login,display_name,choices,created_at&order=created_at.asc')).json || [];

      // tallies: { awardId: { nomineeId: count } }
      const tallies = {};
      awards.forEach(a => { tallies[a.id] = {}; });
      votes.forEach(v => {
        const ch = v.choices || {};
        for (const awardId of Object.keys(ch)) {
          if (!tallies[awardId]) tallies[awardId] = {};
          const nid = ch[awardId];
          tallies[awardId][nid] = (tallies[awardId][nid] || 0) + 1;
        }
      });

      const bc = await getBroadcaster();
      res.status(200).json({
        settings, awards, votes, tallies, totalVoters: votes.length,
        broadcaster: bc ? { login: bc.login, broadcaster_id: bc.broadcaster_id } : null,
        you: { login: admin.login },
      });
      return;
    }

    if (req.method === 'POST') {
      const body = readBody(req);
      const action = String(body.action || '');

      if (action === 'save_award') {
        const a = body.award || {};
        const row = {
          title: String(a.title || '').slice(0, 160),
          description: String(a.description || '').slice(0, 600),
          sort: Number.isFinite(+a.sort) ? +a.sort : 0,
          nominees: cleanNominees(a.nominees),
        };
        if (!row.title) { res.status(400).json({ error: 'Award needs a title.' }); return; }
        if (a.id) {
          const u = await sb('PATCH', 'ak9_awards?id=eq.' + encodeURIComponent(a.id),
            { body: row, prefer: 'return=representation' });
          if (!u.ok) { res.status(502).json({ error: 'Could not update the award.' }); return; }
          res.status(200).json({ ok: true, award: (u.json || [])[0] || null }); return;
        } else {
          const c = await sb('POST', 'ak9_awards', { body: [row], prefer: 'return=representation' });
          if (!c.ok) { res.status(502).json({ error: 'Could not create the award.' }); return; }
          res.status(200).json({ ok: true, award: (c.json || [])[0] || null }); return;
        }
      }

      if (action === 'delete_award') {
        const id = String(body.id || '');
        if (!id) { res.status(400).json({ error: 'Missing award id.' }); return; }
        const d = await sb('DELETE', 'ak9_awards?id=eq.' + encodeURIComponent(id), { prefer: 'return=minimal' });
        if (!d.ok) { res.status(502).json({ error: 'Could not delete the award.' }); return; }
        res.status(200).json({ ok: true }); return;
      }

      if (action === 'save_settings') {
        const patch = {
          month_label: String(body.month_label || '').slice(0, 80),
          voting_open: body.voting_open !== false,
          updated_at: new Date().toISOString(),
        };
        // deadline: accept an ISO string or null/empty to clear
        if (body.deadline === null || body.deadline === '') patch.deadline = null;
        else if (body.deadline) {
          const t = new Date(body.deadline);
          if (isNaN(t.getTime())) { res.status(400).json({ error: 'Bad deadline date.' }); return; }
          patch.deadline = t.toISOString();
        }
        const u = await sb('PATCH', 'ak9_settings?id=eq.1', { body: patch, prefer: 'return=representation' });
        if (!u.ok) { res.status(502).json({ error: 'Could not save settings.' }); return; }
        res.status(200).json({ ok: true, settings: (u.json || [])[0] || null }); return;
      }

      if (action === 'reset_votes') {
        if (body.confirm !== true) { res.status(400).json({ error: 'Confirmation required.' }); return; }
        // delete all rows (id is never null → matches everything)
        const d = await sb('DELETE', 'ak9_votes?id=not.is.null', { prefer: 'return=minimal' });
        if (!d.ok) { res.status(502).json({ error: 'Could not reset votes.' }); return; }
        res.status(200).json({ ok: true }); return;
      }

      res.status(400).json({ error: 'Unknown action.' }); return;
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('ak9-admin', err);
    res.status(502).json({ error: 'Something went wrong.' });
  }
}
