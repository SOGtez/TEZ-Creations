# Gauntlet — win-to-advance game tracker (OBS overlay)

Build a list of games, play them on stream, and don't advance until you win the
current one. Your mods cross games off live with chat commands. Your progress is
saved automatically, so refreshing the OBS source never loses your place.

## Setup for your stream (≈3 min)

1. Go to **tezcreations.com/gauntlet/**
2. Enter your **Twitch channel** name and a **board title**.
3. **Search and add your games** (cover art is pulled in automatically). No art
   for a game? Use *"Add a game manually."*
4. Hit **Create board** and **copy the OBS browser source URL.**
5. In OBS: add a **Browser Source** with that URL, size it about **390 × 600**,
   and leave the background transparent.

That's everything — no accounts to make, nothing to install. The link remembers
your board, so you can come back to this page anytime to edit your game list.

## Chat commands (you + your mods only)

- `!win <game>`  — cross a game off (you beat it)
- `!lost <game>` — put it back on the board
- `!active <game>` — highlight it and show its NOW PLAYING cover

`<game>` can be part of the name or its list number: `!win elden`, `!active 3`.
Only the broadcaster and mods can run these — regular chat is ignored.

## Tips

- **Keep your overlay URL private.** Anyone with it could mess with your board.
  It contains a hard-to-guess board id, so don't paste it on stream.
- Want to try it before going live? Open **`sim.html`** — a full offline
  simulator where you can type commands and watch the overlay react.
- By default, winning the **active** game just clears the badge so you pick the
  next one with `!active`. (This behaviour is set site-wide.)
- Game search and cover art are provided by [RAWG](https://rawg.io).
