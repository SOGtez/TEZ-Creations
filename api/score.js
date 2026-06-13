// Vercel serverless function — ESPN games, normalized, CORS + 10s cache.
// Adds: city, venue, stage, match events (goals/cards), and for soccer the
// group letter via the standings endpoint.
//
// One game:   /api/score?league=worldcup&game=760415   (or ?path=soccer/fifa.world)
// Game list:  /api/score?league=nba                    (powers the game finder)

const LEAGUES = {
  nba:'basketball/nba', wnba:'basketball/wnba',
  ncaam:'basketball/mens-college-basketball', ncaaw:'basketball/womens-college-basketball',
  nfl:'football/nfl', ncaaf:'football/college-football',
  mlb:'baseball/mlb', nhl:'hockey/nhl',
  mls:'soccer/usa.1', epl:'soccer/eng.1', laliga:'soccer/esp.1', ucl:'soccer/uefa.champions',
  worldcup:'soccer/fifa.world'
};

const cache = {};   // scoreboard cache (10s)
const gcache = {};  // team->group map cache (6h)

async function getGroupMap(sportPath) {
  const now = Date.now();
  if (gcache[sportPath] && now - gcache[sportPath].t < 21600000) return gcache[sportPath].map;
  const map = {};
  try {
    // NOTE: soccer standings use /apis/v2/ (not /apis/site/v2/)
    const r = await fetch(`https://site.api.espn.com/apis/v2/sports/${sportPath}/standings`);
    const d = await r.json();
    const kids = d.children || d.groups || [];
    for (const k of kids) {
      const name = k.name || k.shortName || k.abbreviation || '';
      const entries = (k.standings && k.standings.entries) || k.entries || [];
      for (const e of entries) { const id = e.team && e.team.id; if (id) map[String(id)] = name; }
    }
  } catch (e) { /* fall back to stage label */ }
  if (Object.keys(gcache).length > 50) for (const k in gcache) delete gcache[k];
  gcache[sportPath] = { t: now, map };
  return map;
}

function normalizeTeams(comp) {
  const teams = comp.competitors.map(c => ({
    id: c.team.id,
    side: c.homeAway,
    name: c.team.shortDisplayName || c.team.name || c.team.displayName,
    full: c.team.displayName || c.team.name,
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
  // sportPath is interpolated into the upstream ESPN URL — constrain it to a
  // safe "sport/league" slug so it can't reach unintended paths or bloat the cache
  if (!/^[a-z0-9.\-]+\/[a-z0-9.\-]+$/i.test(sportPath)) {
    res.status(400).json({ error: 'Invalid league path' });
    return;
  }
  try {
    const now = Date.now();
    let board;
    if (cache[sportPath] && now - cache[sportPath].t < 10000) board = cache[sportPath].data;
    else {
      const r = await fetch(`https://site.api.espn.com/apis/site/v2/sports/${sportPath}/scoreboard`);
      board = await r.json();
      if (Object.keys(cache).length > 50) for (const k in cache) delete cache[k];
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
    if (!ev) { res.status(404).json({ error: 'Game not on the current scoreboard yet' }); return; }

    const comp = ev.competitions[0];
    const status = comp.status || ev.status;
    const teams = normalizeTeams(comp);

    // match events: goals (scoringPlay) + yellow/red cards, mapped to a side
    const sideOf = id => String(id) === String(teams[0].id) ? 'a'
                       : String(id) === String(teams[1].id) ? 'b' : null;
    const events = (comp.details || [])
      .map(d => {
        let type = null;
        if (d.redCard) type = 'red';
        else if (d.yellowCard) type = 'yellow';
        else if (d.scoringPlay) type = 'goal';
        if (!type) return null;
        return {
          type,
          minute: (d.clock && d.clock.displayValue) || '',
          side: sideOf(d.team && d.team.id),
          player: (d.athletesInvolved && d.athletesInvolved[0] &&
                   (d.athletesInvolved[0].shortName || d.athletesInvolved[0].displayName)) || '',
          number: (d.athletesInvolved && d.athletesInvolved[0] &&
                   d.athletesInvolved[0].jersey) || ''
        };
      })
      .filter(e => e && e.side);

    const city  = (comp.venue && comp.venue.address && comp.venue.address.city) || '';
    const venue = (comp.venue && comp.venue.fullName) || '';
    const stage = (board.leagues && board.leagues[0] && board.leagues[0].season &&
                   board.leagues[0].season.type && board.leagues[0].season.type.name) || '';

    let group = '';
    if (sportPath.startsWith('soccer')) {
      const gm = await getGroupMap(sportPath);
      group = gm[String(teams[0].id)] || gm[String(teams[1].id)] || '';
    }

    res.status(200).json({
      state: status.type.state,
      detail: status.type.shortDetail,
      clock: status.displayClock || '',
      clockSec: status.clock || 0,
      period: status.period || 0,
      city, venue, stage, group, teams, events
    });
  } catch (e) {
    console.error('score api error:', e);          // keep details server-side, don't leak to clients
    res.status(502).json({ error: 'Could not reach ESPN' });
  }
}
