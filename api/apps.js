// Small internal page APIs, consolidated into ONE serverless function to stay under
// Vercel's Hobby 12-function limit. Real logic lives in the _*.js helpers (underscore
// = not counted as its own function; imported + bundled here). Each is called only
// from our own served pages, so consolidating changes only our own fetch paths.
//
//   /api/apps?route=score      (GET)      ESPN scores — Drop #001 Sports Tracker
//   /api/apps?route=games      (GET)      RAWG game search — Game Gauntlet
//   /api/apps?route=usercheck  (GET|POST) handle availability + community reports — Handle Hunter
//   /api/apps?route=waitlist   (GET|POST) TEZ AI waitlist capture + admin list

import score from './_score.js';
import games from './_games.js';
import usercheck from './_usercheck.js';
import waitlist from './_waitlist.js';

const ROUTES = { score, games, usercheck, waitlist };

export default async function handler(req, res) {
  const fn = ROUTES[String(req.query.route || '')];
  if (!fn) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(404).json({ error: 'Unknown route.' });
    return;
  }
  return fn(req, res);
}
