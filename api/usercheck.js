// Vercel serverless — Twitch username checker for Handle Hunter.
//
// ⚠️ Twitch locked the TRUE "is this registerable?" check (the GraphQL
// `isUsernameAvailable` query) behind a Kasada / integrity bot-wall, so it can't
// be called from a server. That means a banned / held / reserved name can't be
// detected as such from here. What we CAN do reliably:
//   • TAKEN  — an active Twitch account exists (public GQL `userResultByLogin`)
//   • BLOCKED — Twitch's own rules forbid it (under 4 chars / bad pattern)
//   • OPEN   — no active account (likely free, but Twitch still reserves/holds
//              many short names, so the UI tells users to verify before relying)
//
// GET /api/usercheck?platform=twitch&usernames=a&usernames=b...
//   → { results:[ { username, status, available } ], note }
//   status: 'taken' | 'open' | 'blocked'

// Twitch's public web Client-ID (same one twitch.tv uses; safe, no secret needed).
const GQL_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';

// Twitch won't let you register a NEW name under 4 chars, over 25, or with
// anything outside [a-z0-9_]. Those can never be claimed → flag them.
function ruleBlocked(login) {
  if (login.length < 4 || login.length > 25) return true;
  if (!/^[a-z0-9_]+$/.test(login)) return true;
  return false;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'GET') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const platform = (req.query.platform || '').toLowerCase();
  if (platform !== 'twitch') {
    res.status(400).json({ error: 'Only platform=twitch is supported right now.' });
    return;
  }

  // usernames arrive as repeated params (?usernames=a&usernames=b) → array on
  // Vercel — or as a comma string. Handle both.
  const rawParam = req.query.usernames;
  const rawList = Array.isArray(rawParam) ? rawParam : String(rawParam || '').split(',');
  const logins = [...new Set(
    rawList
      .map(u => String(u).trim().toLowerCase().replace(/[^a-z0-9_]/g, ''))
      .filter(u => u.length >= 1 && u.length <= 25)
  )].slice(0, 100);

  if (logins.length === 0) { res.status(400).json({ results: [] }); return; }

  try {
    // One batched GQL request, aliased per login. __typename is "User" when an
    // active account exists, "UserDoesNotExist" when it doesn't.
    const query = 'query{' +
      logins.map((l, i) => `u${i}:userResultByLogin(login:"${l}"){__typename}`).join(' ') +
      '}';

    const r = await fetch('https://gql.twitch.tv/gql', {
      method: 'POST',
      headers: { 'Client-Id': GQL_CLIENT_ID, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    });

    if (!r.ok) {
      if (r.status === 429) { res.status(429).json({ error: 'Rate limited by Twitch.' }); return; }
      throw new Error('Twitch GQL error: ' + r.status);
    }

    const j = await r.json();
    const data = (j && j.data) || {};

    const results = logins.map((login, i) => {
      const node = data['u' + i];
      const exists = node && node.__typename === 'User';
      let status;
      if (exists) status = 'taken';
      else if (ruleBlocked(login)) status = 'blocked';   // can never be registered
      else status = 'open';                              // no active account
      return { username: login, status, available: status === 'open' };
    });

    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
    res.status(200).json({
      results,
      note: 'open = no active Twitch account. Twitch still reserves/holds many short names, so verify before relying on it.',
    });
  } catch (err) {
    console.error('usercheck', err);
    res.status(502).json({ error: 'Could not reach Twitch — try again.' });
  }
}
