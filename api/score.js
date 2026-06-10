// Vercel serverless function — fetches games from ESPN, normalizes them,
// adds CORS, and caches ~10s so many viewers = few ESPN calls.
//
// One game:   /api/score?league=nba&game=401859965
// Game list:  /api/score?league=nba            (powers the game finder)
// Any sport:  /api/score?path=football/nfl&game=...

const LEAGUES = {
  nba:'basketball/nba', wnba:'basketball/wnba',
  ncaam:'basketball/mens-college-basketball', ncaaw:'basketball/womens-college-basketball',
  nfl:'football/nfl', ncaaf:'football/college-football',
  mlb:'baseball/mlb', nhl:'hockey/nhl',
  mls:'soccer/usa.1', epl:'soccer/eng.1', laliga:'soccer/esp.1', ucl:'soccer/uefa.champions'
};

const cache = {}; // { sportPath: { t, data } }

function normalizeTeams(comp) {
  const teams = comp.competitors.map(c => ({
    side: c.homeAway,
    name: c.team.shortDisplayName || c.team.name || c.team.displayName,
    abbrev: c.team.abbreviation || '',
    logo: c.team.logo || '',
    color: '#' + (c.team.color || '888888'),
    alt: '#' + (c.team.alternateColor || '444444'),
    score: parseInt(c.score || '0', 10),
    record: (c.records && c.records[0] && c.records[0].summary) || ''
  }));
  teams.sort((a, b) => (a.side === 'away' ? -1 : 1)); // away left, home right
  return teams;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const league = (req.query.league || 'nba').toLowerCase();
  const game = req.query.game;
  const sportPath = req.query.path || LEAGUES[league];

  if (!sportPath) {
    res.status(400).json({ error: 'Need a valid ?league= (or ?path=)' });
    return;
  }

  try {
    const now = Date.now();
    let board;
    if (cache[sportPath] && now - cache[sportPath].t < 10000) {
      board = cache[sportPath].data;
    } else {
      const r = await fetch(`https://site.api.espn.com/apis/site/v2/sports/${sportPath}/scoreboard`);
      board = await r.json();
      cache[sportPath] = { t: now, data: board };
    }

    res.setHeader('Cache-Control', 's-maxage=10, stale-while-revalidate=20');

    // No ?game= → return the whole scoreboard (for the game finder)
    if (!game) {
      const games = (board.events || []).map(ev => {
        const comp = ev.competitions[0];
        const status = comp.status || ev.status;
        return {
          id: String(ev.id),
          state: status.type.state,
          detail: status.type.shortDetail,
          date: ev.date,
          teams: normalizeTeams(comp)
        };
      });
      res.status(200).json({ games });
      return;
    }

    const ev = (board.events || []).find(e => String(e.id) === String(game));
    if (!ev) {
      res.status(404).json({ error: 'Game not on the current scoreboard yet' });
      return;
    }

    const comp = ev.competitions[0];
    const status = comp.status || ev.status;

    res.status(200).json({
      state: status.type.state,        // 'pre' | 'in' | 'post'
      detail: status.type.shortDetail, // e.g. "8:24 - 3rd", "Final", "Sat 7:30 PM"
      clock: status.displayClock || '',
      period: status.period || 0,
      teams: normalizeTeams(comp)
    });
  } catch (e) {
    res.status(502).json({ error: 'Could not reach ESPN', detail: String(e) });
  }
}
