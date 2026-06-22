/* ===== TEZ Creations — drop catalog =====
   To add a drop:
   1. Put its files in /drops/00X/
   2. Add an entry here (newest stuff can go anywhere — the feed sorts itself)

   action.kind:
   - "download" → button downloads the file at url
   - "use"      → button opens the on-site tool at url
   image: path to a cover image, or "" to auto-generate a cover
*/
const DROPS = [
  {
    id: "004",
    title: "Game Gauntlet",
    description:
      "A win-to-advance gauntlet tracker for OBS. Search and add your games with cover art, then mods cross them off live in chat with !win / !lost / !active. The active game gets a NOW PLAYING banner. State is saved, so an OBS refresh never loses progress.",
    date: "2026-06-21",
    type: "tool",
    image: "",
    action: { kind: "use", url: "gauntlet/index.html" }
  },
  {
    id: "003",
    title: "Live Map",
    description:
      "A live GPS map overlay for IRL & travel streams. Powered by your RealtimeIRL feed — your location glides across a clean dark map in OBS, with speed, heading, and where you are. Paste your pull key, copy a link, done.",
    date: "2026-06-14",
    type: "tool",
    image: "",
    action: { kind: "use", url: "drops/003/index.html" }
  },
  {
    id: "002",
    title: "Sub Goal Tracker",
    description:
      "An auto-updating Twitch sub goal overlay for OBS. Connect your Twitch, set your tiers, copy a link — it counts subs live, celebrates on goal, and rolls to the next one.",
    date: "2026-06-12",
    type: "tool",
    image: "subgoal/cover.png",
    action: { kind: "use", url: "subgoal/index.html" }
  },
  {
    id: "001",
    title: "Sports Tracker",
    description:
      "Pop a live score tracker on your stream. Pick a game, copy a link, paste it into OBS — scores, clock, and win celebrations update live while the game plays.",
    date: "2026-06-10",
    type: "tool",
    image: "drops/001/cover.png",
    action: { kind: "use", url: "drops/001/index.html" }
  }
];
