// Sub Goal — Twitch auth endpoints, consolidated into ONE serverless function to
// stay under Vercel's Hobby 12-function limit. Real logic lives in the _twitch-*.js
// helpers (underscore = not counted as its own function; imported + bundled here).
//
//   /api/twitch?route=auth   (POST)  auth-code exchange → store refresh token, return opaque id
//   /api/twitch?route=token  (GET)   ?id= → refresh the stored token for the OBS overlay

import auth from './_twitch-auth.js';
import token from './_twitch-token.js';

const ROUTES = { auth, token };

export default async function handler(req, res) {
  const fn = ROUTES[String(req.query.route || '')];
  if (!fn) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(404).json({ error: 'Unknown route.' });
    return;
  }
  return fn(req, res);
}
