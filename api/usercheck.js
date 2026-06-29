// Vercel serverless function — Twitch username availability checker.
// Keeps the Client Secret server-side; Client-ID is public (same as subgoal).
// Twitch /helix/users accepts up to 100 login names per request — we batch.
//
// GET /api/usercheck?platform=twitch&usernames=a,b,c,...
// Returns: { results: [ { username, available: bool } ] }
//
// Env (Vercel → Settings → Environment Variables):
//   TWITCH_CLIENT_SECRET  — app secret from dev.twitch.tv/console/apps
//
// The Client-ID is the same one used by subgoal (safe to expose in JS).

const CLIENT_ID = 'i5n7ykd3ns3n0fxgbith466dnj51fc';

// In-memory app token cache (lives for the duration of the serverless instance)
let appToken = null;
let appTokenExpiry = 0;

async function getAppToken(secret) {
  const now = Date.now();
  // Refresh 5 min before expiry
  if (appToken && now < appTokenExpiry - 300000) return appToken;

  const r = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: secret,
      grant_type: 'client_credentials',
    }),
  });
  if (!r.ok) throw new Error('Failed to get Twitch app token: ' + r.status);
  const d = await r.json();
  appToken = d.access_token;
  // expires_in is in seconds
  appTokenExpiry = now + (d.expires_in || 3600) * 1000;
  return appToken;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'GET') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const secret = process.env.TWITCH_CLIENT_SECRET;
  if (!secret) { res.status(503).json({ error: 'TWITCH_CLIENT_SECRET not configured on server.' }); return; }

  const platform = (req.query.platform || '').toLowerCase();
  if (platform !== 'twitch') {
    res.status(400).json({ error: 'Only platform=twitch is supported right now.' });
    return;
  }

  // usernames can arrive as a comma string (?usernames=a,b,c) OR as repeated
  // params (?usernames=a&usernames=b) — Vercel gives the latter as an array.
  // Handle both. (The Handle Hunter page sends the repeated-param form.)
  const rawParam = req.query.usernames;
  const rawList = Array.isArray(rawParam)
    ? rawParam
    : String(rawParam || '').split(',');
  if (!rawList.length) { res.status(400).json({ results: [] }); return; }

  // Parse, lowercase, dedupe, strip invalid chars, cap at 100
  const logins = [...new Set(
    rawList
      .map(u => String(u).trim().toLowerCase().replace(/[^a-z0-9_]/g, ''))
      .filter(u => u.length >= 1 && u.length <= 25)
  )].slice(0, 100);

  if (logins.length === 0) { res.status(400).json({ error: 'No valid usernames supplied.' }); return; }

  try {
    const token = await getAppToken(secret);

    // Twitch /helix/users: usernames that EXIST come back in data[].
    // Anything absent from the response is available.
    const url = 'https://api.twitch.tv/helix/users?' +
      logins.map(l => 'login=' + encodeURIComponent(l)).join('&');

    const r = await fetch(url, {
      headers: {
        Authorization: 'Bearer ' + token,
        'Client-Id': CLIENT_ID,
      },
    });

    if (!r.ok) {
      // 429 = rate limited; pass it through so the client can back off
      if (r.status === 429) {
        const retryAfter = r.headers.get('Ratelimit-Reset') || '';
        res.status(429).json({ error: 'Rate limited by Twitch.', retryAfter });
        return;
      }
      throw new Error('Twitch API error: ' + r.status);
    }

    const d = await r.json();
    const takenSet = new Set((d.data || []).map(u => u.login.toLowerCase()));

    const results = logins.map(login => ({
      username: login,
      available: !takenSet.has(login),
    }));

    // Short cache — results can change but no need to hammer
    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
    res.status(200).json({ results });
  } catch (err) {
    console.error('usercheck', err);
    res.status(502).json({ error: 'Could not reach Twitch — try again.' });
  }
}
