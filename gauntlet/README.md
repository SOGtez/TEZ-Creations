# Gauntlet — win-to-advance game tracker (OBS overlay)

A streamer plays a list of games and can't advance until they win the current
one. Mods cross games off live with chat commands. State lives in Supabase so an
OBS refresh never loses progress.

## Files & where they go in the repo

```
api/
  games.js          → RAWG game-search proxy (keeps the API key server-side)
gauntlet/
  index.html        → setup page (search games, build the list, get the OBS URL)
  overlay.html      → the OBS browser source
  config.js         → your Supabase URL + anon key (you fill this in)
  schema.sql        → run once in Supabase
  sim.html          → offline simulator for testing (optional; not required live)
```

Then add one entry to `drops.js` so it shows in the gallery (see `drops-entry.js`).

## One-time setup (≈10 min)

1. **Supabase** — create a project, open the SQL editor, paste in `schema.sql`, run it.
2. **config.js** — paste your Supabase Project URL + anon (public) key.
3. **RAWG** — get a free key at https://rawg.io/apidocs, add it to Vercel as the
   `RAWG_KEY` environment variable, redeploy.
4. Open `/gauntlet/` on the site, search + add games, enter the Twitch channel,
   hit **Create board**, copy the overlay URL.
5. In OBS: add a **Browser Source** with that URL, ~390 × 600, transparent.

## Chat commands (broadcaster + mods only)

- `!win <game>`  — cross a game off
- `!lost <game>` — put it back
- `!active <game>` — highlight it + show the NOW PLAYING cover

`<game>` can be a name fragment or the list number: `!win elden`, `!active 3`.

## Two toggles in config.js

- `AUTO_ADVANCE_ACTIVE` — when you win the active game, `false` clears the badge
  (you set the next one with `!active`); `true` auto-jumps it to the next game.
- Chat is read **anonymously** (no Twitch login — just the channel name). The
  overlay never posts in chat; the on-screen update is the confirmation.

## Notes

- The anon key sits in the page source and the prototype RLS policies allow open
  writes — fine for a stream overlay; use a non-obvious board id. Tighten later
  in `schema.sql` if you ever need to.
- Game art comes from RAWG (their free tier requires the attribution link that's
  already on the setup page).
