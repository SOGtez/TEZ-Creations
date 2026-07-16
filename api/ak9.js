// AK9 AWARDS — single serverless entrypoint that dispatches to the individual
// handlers by ?route=. Consolidated into one function to stay under Vercel's
// Hobby-plan 12-function limit. The real logic lives in the _ak9-*.js files
// (underscore = not their own route; imported + bundled here).
//
//   /api/ak9?route=auth    (POST)       login / broadcaster connect
//   /api/ak9?route=ballot  (GET)        public awards + settings
//   /api/ak9?route=me       (GET)        per-user status
//   /api/ak9?route=nominate (POST)       phase-1: submit nominations
//   /api/ak9?route=vote     (POST)       cast a vote
//   /api/ak9?route=admin    (GET|POST)   admin dashboard + actions
//   /api/ak9?route=results  (GET)        public winners/tallies (only after voting closes)

import auth from './_ak9-auth.js';
import ballot from './_ak9-ballot.js';
import me from './_ak9-me.js';
import nominate from './_ak9-nominate.js';
import vote from './_ak9-vote.js';
import admin from './_ak9-admin.js';
import results from './_ak9-results.js';

const ROUTES = { auth, ballot, me, nominate, vote, admin, results };

export default async function handler(req, res) {
  const route = String(req.query.route || '');
  const fn = ROUTES[route];
  if (!fn) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(404).json({ error: 'Unknown route.' });
    return;
  }
  return fn(req, res);
}
