/* ===== TEZ Creations — drop catalog =====
   To add a drop:
   1. Put its files in /drops/00X/
   2. Add an entry here (newest stuff can go anywhere — the feed sorts itself)

   action.kind:
   - "download" → button downloads the file at url
   - "use"      → button opens the on-site tool at url
   image: path to a cover image, or "" to auto-generate a cover
   category: groups the drop in the sidebar nav (e.g. "Stream Tools", "Apps").
            Sidebar category order is set in sidebar.js (CAT_ORDER).
*/
const DROPS = [
  {
    id: "008",
    title: "Bag Radar",
    description:
      "Grants, creator funds, brand programs, and contests — structured, verified, and matched to you. A 30-second fit quiz turns the directory into a personal list, deadline countdowns keep the urgent stuff on top, and expired opportunities remove themselves automatically.",
    date: "2026-07-13",
    type: "tool",
    category: "Creator Apps",
    image: "drops/008/cover.png",
    action: { kind: "use", url: "drops/008/index.html" }
  },
  {
    id: "007",
    title: "Consistency Tracker",
    description:
      "A GitHub-style consistency graph for your streams — built around your schedule, not a punishing daily grind. Claim your handle once and every stream logs itself the moment you go live. Streak stats, backfill editing, and an OBS overlay that updates in real time.",
    date: "2026-07-11",
    type: "tool",
    category: "Stream Tools",
    image: "drops/007/cover.png",
    action: { kind: "use", url: "drops/007/index.html" }
  },
  {
    id: "006",
    title: "Handle Hunter",
    description:
      "Hunt rare, short usernames by character count. Pick a platform and a length, choose your style filters (real words, animals, nature, l33t, combos), and we generate meaningful candidates and check availability live against Twitch. Copy the open ones and go claim them.",
    date: "2026-06-29",
    type: "tool",
    category: "Apps",
    image: "drops/006/cover.png",
    action: { kind: "use", url: "drops/006/index.html" }
  },
  {
    id: "005",
    title: "Ghosted",
    description:
      "Find out who doesn't follow you back on Instagram — and who quietly unfollowed you. Upload your own data export and everything is computed right in your browser; nothing is ever sent to a server. Check again later and it shows exactly who left since last time.",
    date: "2026-06-23",
    type: "tool",
    category: "Apps",
    image: "drops/005/cover.png",
    action: { kind: "use", url: "drops/005/index.html" }
  },
  {
    id: "004",
    title: "Game Gauntlet",
    description:
      "A win-to-advance gauntlet tracker for OBS. Search and add your games with cover art, then mods cross them off live in chat with !win / !lost / !active. The active game gets a NOW PLAYING banner. State is saved, so an OBS refresh never loses progress.",
    date: "2026-06-21",
    type: "tool",
    category: "Stream Tools",
    image: "gauntlet/cover.png",
    action: { kind: "use", url: "gauntlet/index.html" }
  },
  {
    id: "003",
    title: "Live Map",
    description:
      "A live GPS map overlay for IRL & travel streams. Powered by your RealtimeIRL feed — your location glides across a clean dark map in OBS, with speed, heading, and where you are. Paste your pull key, copy a link, done.",
    date: "2026-06-14",
    type: "tool",
    category: "Stream Tools",
    image: "drops/003/cover.png",
    action: { kind: "use", url: "drops/003/index.html" }
  },
  {
    id: "002",
    title: "Sub Goal Tracker",
    description:
      "An auto-updating Twitch sub goal overlay for OBS. Connect your Twitch, set your tiers, copy a link — it counts subs live, celebrates on goal, and rolls to the next one.",
    date: "2026-06-12",
    type: "tool",
    category: "Stream Tools",
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
    category: "Stream Tools",
    image: "drops/001/cover.png",
    action: { kind: "use", url: "drops/001/index.html" }
  }
];
