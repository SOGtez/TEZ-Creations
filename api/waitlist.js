// TEZ AI — waitlist capture, backed by Upstash Redis over its REST API (no SDK,
// so the project stays build-free like the rest of the site).
//
// Env vars (set in Vercel → Project → Settings → Environment Variables):
//   UPSTASH_REDIS_REST_URL    from the Upstash database "REST API" panel
//   UPSTASH_REDIS_REST_TOKEN  ditto
//   WAITLIST_ADMIN_KEY        any long random string — unlocks the admin list
//
// POST {name, email, website?}  → { ok, isNew, position }   (website = honeypot)
// GET  ?key=<WAITLIST_ADMIN_KEY> → { count, entries:[{name,email,ts}] }

const KEY = 'tezai:waitlist';

// read env at request time (set in Vercel; also keeps the handler unit-testable)
const env = () => ({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
  admin: process.env.WAITLIST_ADMIN_KEY,
});
const configured = () => { const e = env(); return !!(e.url && e.token); };

async function redis(cmd) {
  const e = env();
  const r = await fetch(e.url, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + e.token, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  if (!r.ok) throw new Error('redis ' + r.status);
  return (await r.json()).result;
}

export default async function handler(req, res) {
  // ---------- admin: list signups ----------
  if (req.method === 'GET') {
    const admin = env().admin;
    if (!admin || req.query.key !== admin) { res.status(403).json({ error: 'forbidden' }); return; }
    if (!configured()) { res.status(503).json({ error: 'Storage not configured yet.' }); return; }
    try {
      const flat = (await redis(['HGETALL', KEY])) || [];
      const entries = [];
      for (let i = 0; i < flat.length; i += 2) {
        try { entries.push(JSON.parse(flat[i + 1])); } catch (e) { /* skip bad row */ }
      }
      entries.sort((a, b) => (a.ts || 0) - (b.ts || 0));
      res.status(200).json({ count: entries.length, entries });
    } catch (e) { console.error('waitlist GET', e); res.status(502).json({ error: 'Could not read the list.' }); }
    return;
  }

  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  body = body || {};

  // honeypot: a real user never fills this; quietly accept bots without storing
  if (body.website) { res.status(200).json({ ok: true, position: null }); return; }

  const name = String(body.name || '').trim().slice(0, 80);
  const email = String(body.email || '').trim().toLowerCase().slice(0, 120);
  if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    res.status(400).json({ error: 'Please enter your name and a valid email.' }); return;
  }

  if (!configured()) { res.status(503).json({ error: "The waitlist isn't open just yet — check back shortly." }); return; }

  try {
    // light per-IP rate limit: ~8 submissions / minute
    const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
    const n = await redis(['INCR', 'tezai:rl:' + ip]);
    if (n === 1) await redis(['EXPIRE', 'tezai:rl:' + ip, '60']);
    if (n > 8) { res.status(429).json({ error: 'Too many tries — give it a minute.' }); return; }

    const isNew = await redis(['HSETNX', KEY, email, JSON.stringify({ name, email, ts: Date.now() })]);
    const position = await redis(['HLEN', KEY]);
    res.status(200).json({ ok: true, isNew: isNew === 1, position });
  } catch (e) {
    console.error('waitlist POST', e);
    res.status(502).json({ error: 'Could not reach the list — try again in a moment.' });
  }
}
