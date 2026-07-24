// Vercel serverless function — RAWG game search, normalized, CORS + cache.
// Keeps the RAWG key server-side. Set RAWG_KEY in Vercel → Project → Settings →
// Environment Variables. Get a free key at https://rawg.io/apidocs
//
// Search:  /api/games?q=elden
// Returns: { results: [ { id, name, released, image } ] }
//
// RAWG is free for personal/small use; attribute RAWG with a link wherever the
// data or images are shown (we do this on the gauntlet setup page).

const cache = {}; // query -> { t, data }  (10 min)

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const q = (req.query.q || '').trim();
  if (!q) { res.status(200).json({ results: [] }); return; }

  const key = process.env.RAWG_KEY;
  if (!key) { res.status(500).json({ error: 'RAWG_KEY not set on the server' }); return; }

  const ck = q.toLowerCase();
  const now = Date.now();
  if (cache[ck] && now - cache[ck].t < 600000) {
    res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=1200');
    res.status(200).json(cache[ck].data);
    return;
  }

  try {
    const url = `https://api.rawg.io/api/games?key=${key}`
      + `&search=${encodeURIComponent(q)}&page_size=8&search_precise=true`;
    const r = await fetch(url, { headers: { 'User-Agent': 'TEZ-Creations/1.0 (gauntlet)' } });
    if (!r.ok) { res.status(502).json({ error: 'RAWG error ' + r.status }); return; }
    const d = await r.json();

    const results = (d.results || []).map(g => ({
      id: g.id,
      name: g.name,
      released: g.released ? String(g.released).slice(0, 4) : '',
      image: g.background_image || ''
    }));

    const payload = { results };
    if (Object.keys(cache).length > 200) for (const k in cache) delete cache[k];
    cache[ck] = { t: now, data: payload };

    res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=1200');
    res.status(200).json(payload);
  } catch (e) {
    res.status(502).json({ error: 'Could not reach RAWG' });
  }
}
