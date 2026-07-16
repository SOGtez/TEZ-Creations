// AK9 AWARDS — admin API (Bearer = an admin's Twitch access token).
// Gated SERVER-SIDE: the token is validated and the login must be in AK9_ADMINS.
//
// GET  → { settings, awards, votes, tallies, totalVoters, nominationTally,
//          totalNominators, broadcaster }
// POST { action, ... }:
//   save_award         { award:{ id?, title, description, sort, nominees } }
//   delete_award       { id }
//   save_settings      { month_label, deadline, voting_open, phase, nominate_deadline }
//   reset_votes        { confirm:true }   ← clears ALL votes (new month)
//   reset_nominations  { confirm:true }   ← clears ALL phase-1 nominations
//   reset_voter        { twitch_user_id }

import { configured, validateToken, bearer, isAdminLogin, getBroadcaster, getBroadcasterRaw, CHANNEL_LOGIN, sb, cors, readBody, probeFollowerApi, twitchProfiles } from './_ak9.js';

// Best-effort: fill each nominee's avatar from Twitch. A nominee's login is its
// explicit twitch_login, else its name if that looks like a Twitch handle
// ([a-z0-9_], 3–25). Only fills a MISSING image; a manually-set image is kept.
async function enrichNomineeAvatars(nominees) {
  const loginOf = (n) => {
    const explicit = String(n.twitch_login || '').trim().toLowerCase().replace(/^@/, '');
    if (/^[a-z0-9_]{3,25}$/.test(explicit)) return explicit;
    const fromName = String(n.name || '').trim().toLowerCase().replace(/^@/, '');
    return /^[a-z0-9_]{3,25}$/.test(fromName) ? fromName : '';
  };
  const need = nominees.filter(n => !n.image).map(loginOf).filter(Boolean);
  if (!need.length) return;
  let map;
  try { map = await twitchProfiles(need); } catch (_) { return; }   // never block a save
  nominees.forEach(n => {
    if (n.image) return;
    const login = loginOf(n);
    const p = login && map.get(login);
    if (p) { n.image = p.profile_image_url || ''; if (!n.twitch_login) n.twitch_login = p.login; }
  });
}

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

// Normalize a free-text nominee for grouping: lowercase, strip a leading @,
// collapse whitespace. Merges "AleksK9" / "aleksk9" / "@aleksk9 ".
function normNom(s) {
  return String(s || '').trim().toLowerCase().replace(/^@+/, '').replace(/\s+/g, ' ');
}

// Tally free-text nominations per award into a ranked list:
//   { awardId: [ { name (most common spelling), count } ], ... }  sorted desc.
function tallyNominations(noms, awardIds) {
  const byAward = {};
  awardIds.forEach(id => { byAward[id] = new Map(); });
  noms.forEach(row => {
    const ch = row.choices || {};
    for (const awardId of Object.keys(ch)) {
      if (!byAward[awardId]) byAward[awardId] = new Map();
      const norm = normNom(ch[awardId]);
      if (!norm) continue;
      const g = byAward[awardId].get(norm) || { count: 0, spellings: {} };
      g.count++;
      const disp = String(ch[awardId]).trim().replace(/^@+/, '').replace(/\s+/g, ' ');
      g.spellings[disp] = (g.spellings[disp] || 0) + 1;
      byAward[awardId].set(norm, g);
    }
  });
  const out = {};
  for (const awardId of Object.keys(byAward)) {
    out[awardId] = [...byAward[awardId].values()].map(g => ({
      // display = the spelling that appeared most often
      name: Object.keys(g.spellings).sort((a, b) => g.spellings[b] - g.spellings[a])[0],
      count: g.count,
    })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  }
  return out;
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
      const settings = ((await sb('GET', 'ak9_settings?id=eq.1&select=month_label,deadline,voting_open,phase,nominate_deadline&limit=1')).json || [])[0]
        || { month_label: '', deadline: null, voting_open: true, phase: 'vote', nominate_deadline: null };
      const awards = (await sb('GET', 'ak9_awards?select=id,title,description,sort,nominees&order=sort.asc,created_at.asc')).json || [];
      const votes = (await sb('GET', 'ak9_votes?select=twitch_user_id,twitch_login,display_name,choices,created_at&order=created_at.asc')).json || [];
      const noms = (await sb('GET', 'ak9_nominations?select=twitch_user_id,choices&order=created_at.asc')).json || [];

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

      // ranked free-text nomination counts per award (phase 1 → finalists)
      const nominationTally = tallyNominations(noms, awards.map(a => String(a.id)));

      const bc = await getBroadcaster();       // refreshes → proves the token works
      const raw = await getBroadcasterRaw();    // what's actually stored (no refresh)
      res.status(200).json({
        settings, awards, votes, tallies, totalVoters: votes.length,
        nominationTally, totalNominators: noms.length,
        broadcaster: bc ? { login: bc.login, broadcaster_id: bc.broadcaster_id } : null,
        broadcasterDiag: {
          refreshOk: !!bc,                                  // token refreshed successfully
          tableOk: !raw.tableMissing && !raw.readError,     // ak9_broadcaster is readable
          hasRow: !!raw.hasRow,                             // a connection was actually saved
          storedLogin: raw.login || null,
          storedScope: raw.scope || null,
          updatedAt: raw.updated_at || null,
          scopeOk: /moderator:read:followers/.test(raw.scope || ''),
          loginMatches: (raw.login || '').toLowerCase() === CHANNEL_LOGIN,
          expectedChannel: CHANNEL_LOGIN,
          followerApi: await probeFollowerApi(),   // live end-to-end probe
        },
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
        await enrichNomineeAvatars(row.nominees);   // auto-fill Twitch pfps
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
        // phase: nominate | vote | closed (default vote if unrecognized)
        if (body.phase !== undefined) {
          patch.phase = ['nominate', 'vote', 'closed'].includes(body.phase) ? body.phase : 'vote';
        }
        // deadline: accept an ISO string or null/empty to clear
        if (body.deadline === null || body.deadline === '') patch.deadline = null;
        else if (body.deadline) {
          const t = new Date(body.deadline);
          if (isNaN(t.getTime())) { res.status(400).json({ error: 'Bad deadline date.' }); return; }
          patch.deadline = t.toISOString();
        }
        // nominate_deadline: same rules
        if (body.nominate_deadline === null || body.nominate_deadline === '') patch.nominate_deadline = null;
        else if (body.nominate_deadline) {
          const t = new Date(body.nominate_deadline);
          if (isNaN(t.getTime())) { res.status(400).json({ error: 'Bad nomination deadline.' }); return; }
          patch.nominate_deadline = t.toISOString();
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

      if (action === 'reset_nominations') {
        if (body.confirm !== true) { res.status(400).json({ error: 'Confirmation required.' }); return; }
        const d = await sb('DELETE', 'ak9_nominations?twitch_user_id=not.is.null', { prefer: 'return=minimal' });
        if (!d.ok) { res.status(502).json({ error: 'Could not reset nominations.' }); return; }
        res.status(200).json({ ok: true }); return;
      }

      if (action === 'reset_voter') {
        // clear ONE person's vote so they can vote again
        const uid = String(body.twitch_user_id || '');
        if (!uid) { res.status(400).json({ error: 'Missing voter id.' }); return; }
        const d = await sb('DELETE', 'ak9_votes?twitch_user_id=eq.' + encodeURIComponent(uid), { prefer: 'return=minimal' });
        if (!d.ok) { res.status(502).json({ error: 'Could not reset that voter.' }); return; }
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
