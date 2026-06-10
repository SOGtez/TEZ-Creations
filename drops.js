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
    id: "001",
    title: "Sports Tracker",
    description:
      "Pop a live score tracker on your stream. Pick a game, copy a link, paste it into OBS — scores, clock, and win celebrations update live while the game plays.",
    date: "2026-06-10",
    type: "tool",
    image: "",
    action: { kind: "use", url: "drops/001/index.html" }
  }
];
