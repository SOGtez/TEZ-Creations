/* TEZ Creations — papergames.io Connect 4 Assist (tester-only, for fun).
   Reads the live board DOM, runs TezC4 (solver.js), and overlays a TEZ ghost
   mark on the recommended drop. Server-gated: activates only when /api/auth
   ?route=me says the logged-in account is a tier tester (the server decides).

   DOM contract (recon 2026-07-24):
   - board: #connect4 .grid  → 42 div.grid-item.cell-{row}-{col}, row 1 = top
   - piece: circle.circle-light | circle.circle-dark | circle.empty-slot
   - .last-move dot sits inside the most recently played cell (either player)
   - my color: first .col-6 in app-room-players → circle.shape.circle-*
   - clicking any cell of a column drops into its lowest empty slot */

"use strict";

(function () {
  var API = "https://tez-creations.vercel.app/api";
  var TOKEN_KEY = "tez_token";
  var ASSIST_KEY = "tez_c4_assist";

  var allowed = false;   // account passed the server gate
  var enabled = true;    // popup toggle
  var solving = false;
  var lastHash = "";
  var lastGhost = null;  // { col, heights, hash } — restore if Angular re-renders it away

  /* ---------- gate ---------- */
  function gate(cb) {
    chrome.storage.local.get([TOKEN_KEY, ASSIST_KEY], function (o) {
      enabled = o[ASSIST_KEY] !== false;
      if (!o[TOKEN_KEY]) { cb(false); return; }
      fetch(API + "/auth?route=me", { headers: { Authorization: "Bearer " + o[TOKEN_KEY] } })
        .then(function (r) { return r.json(); })
        .then(function (j) { cb(!!(j.user && j.user.tierTester)); })
        .catch(function () { cb(false); });
    });
  }

  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== "local") return;
    if (changes[ASSIST_KEY]) {
      enabled = changes[ASSIST_KEY].newValue !== false;
      lastHash = "";
      sync();
    }
    if (changes[TOKEN_KEY]) {
      gate(function (ok) { allowed = ok; lastHash = ""; sync(); });
    }
  });

  /* ---------- board reading ---------- */
  function readBoard() {
    var cells = document.querySelectorAll("#connect4 .grid-item");
    if (cells.length !== 42) return null;
    var grid = [];
    for (var r = 0; r < 6; r++) grid.push([0, 0, 0, 0, 0, 0, 0]);
    var lastMoveColor = null;
    for (var i = 0; i < cells.length; i++) {
      var m = cells[i].className.match(/cell-(\d)-(\d)/);
      var circ = cells[i].querySelector("circle");
      if (!m || !circ) return null;
      var row = +m[1] - 1, col = +m[2] - 1;
      var v = null;
      // The site's hover preview swaps the circle to a real piece class
      // (circle-light) and tags the cell piece-hover-placeholder — it is NOT
      // a placed stone, so treat the cell as empty or the solver sees phantoms.
      if (!cells[i].classList.contains("piece-hover-placeholder")) {
        var cls = circ.className.baseVal || "";
        v = cls.indexOf("circle-light") !== -1 ? "light" : cls.indexOf("circle-dark") !== -1 ? "dark" : null;
      }
      grid[row][col] = v;
      if (v && cells[i].querySelector(".last-move")) lastMoveColor = v;
    }
    return { grid: grid, lastMoveColor: lastMoveColor };
  }

  function myColor() {
    // Online matchmaking can seat the local player in EITHER header column (and
    // either color), so match by username: the account menu stays in the room
    // DOM (hidden) and each seat has one span.text-truncate with the name.
    var cols = document.querySelectorAll("app-room-players .col-6");
    if (!cols.length) return null;
    var nameEl = document.querySelector("app-user-menu .name-credit div");
    var myName = nameEl ? nameEl.textContent.trim() : "";
    var pick = null;
    if (myName) {
      for (var i = 0; i < cols.length; i++) {
        var span = cols[i].querySelector("span.text-truncate");
        if (span && span.textContent.trim() === myName) { pick = cols[i]; break; }
      }
    }
    if (!pick) pick = cols[0]; // bot/friend rooms list the local player first
    var seat = pick.querySelector("circle.shape");
    if (!seat) return null;
    var cls = seat.className.baseVal || "";
    return cls.indexOf("circle-light") !== -1 ? "light" : cls.indexOf("circle-dark") !== -1 ? "dark" : null;
  }

  /* ---------- overlay ---------- */
  function badge(text, tone) {
    var el = document.querySelector(".tez-c4-badge");
    if (!text) { if (el) el.remove(); return; }
    if (!el) {
      el = document.createElement("div");
      el.className = "tez-c4-badge";
      el.innerHTML = '<span class="tez-c4-dot"></span><span class="tez-c4-brand">TEZ</span><span class="tez-c4-text"></span>';
      document.body.appendChild(el);
    }
    el.querySelector(".tez-c4-text").textContent = text;
    el.classList.toggle("is-hot", tone === "hot");
  }

  function clearGhost() {
    var g = document.querySelector(".tez-ghost");
    if (g) {
      var host = g.parentElement;
      g.remove();
      if (host) host.classList.remove("tez-ghost-host");
    }
  }

  function showGhost(col, heights) {
    var domRow = 6 - heights[col];
    var cell = document.querySelector("#connect4 .grid-item.cell-" + domRow + "-" + (col + 1));
    if (!cell) return;
    var existing = document.querySelector(".tez-ghost");
    if (existing && existing.parentElement === cell) return;
    clearGhost();
    cell.classList.add("tez-ghost-host");
    var g = document.createElement("div");
    g.className = "tez-ghost";
    g.innerHTML = '<span class="tez-ghost-t">T</span>';
    cell.appendChild(g);
  }

  /* ---------- main loop ---------- */
  function gameOverBanner() {
    // time-up / resign endings leave no 4-in-a-row on the board — the only
    // signal is the site's punch banner ("You lost!", "X won by time-up", …)
    var punch = document.querySelector("app-punch-message");
    return !!(punch && /won|lost|draw/i.test(punch.textContent || ""));
  }

  function sync() {
    if (!allowed || !enabled) { clearGhost(); badge(null); return; }
    if (!document.querySelector("#connect4 .grid")) { clearGhost(); badge(null); lastHash = ""; return; }
    if (gameOverBanner()) { clearGhost(); badge("game over"); return; }

    var state = readBoard();
    var mine = myColor();
    if (!state || !mine) { clearGhost(); badge("reading board…"); return; }

    var grid = [], heights = [0, 0, 0, 0, 0, 0, 0], total = 0, mineCount = 0, oppCount = 0;
    for (var r = 0; r < 6; r++) {
      grid.push([]);
      for (var c = 0; c < 7; c++) {
        var v = state.grid[r][c];
        grid[r][c] = v === null ? 0 : v === mine ? 1 : 2;
        if (v !== null) {
          heights[c]++; total++;
          if (v === mine) mineCount++; else oppCount++;
        }
      }
    }
    // last-move dot position is part of the state: it decides the turn when
    // counts are equal, and it can update a beat after the piece renders
    var hash = mine + ":" + (state.lastMoveColor || "-") + ":" + grid.map(function (row) { return row.join(""); }).join("");
    if (hash === lastHash) {
      // board unchanged — but Angular re-renders can eat the ghost; put it back
      if (lastGhost && lastGhost.hash === hash && !document.querySelector(".tez-ghost")) {
        showGhost(lastGhost.col, lastGhost.heights);
      }
      if (document.querySelector(".tez-ghost, .tez-c4-badge")) return;
    }
    lastHash = hash;

    var boards = TezC4.boardsFromGrid(grid);
    if (TezC4.moverWon(boards)) { clearGhost(); badge("you won — gg"); return; }
    if (TezC4.oppWon(boards)) { clearGhost(); badge("game over"); return; }
    if (total === 42) { clearGhost(); badge("draw"); return; }

    // Turn detection, lag-proof: whoever has MORE stones moved last — that is
    // true even while the site's last-move dot is still catching up to a fresh
    // move. The dot only decides when counts are equal (then the fresh piece
    // and its dot render together locally, so it is trustworthy).
    var myTurn;
    if (total === 0) myTurn = true; // opening — center is correct for either seat
    else if (mineCount !== oppCount) myTurn = oppCount > mineCount;
    else myTurn = state.lastMoveColor !== null && state.lastMoveColor !== mine;
    if (!myTurn) { clearGhost(); badge("waiting for opponent…"); return; }
    if (solving) return;

    solving = true;
    badge("thinking…");
    var solvedFor = hash;
    // Adaptive budget: the opening has the deepest tree and decides the game —
    // spend real time there. A ~1.5s "thinking…" beat is nothing to a human.
    var budget = total <= 10 ? 1500 : total <= 20 ? 900 : 600;
    setTimeout(function () { // let drop animations settle, keep the click snappy
      var best = null;
      try { best = TezC4.bestMove(boards, budget); } catch (e) { /* fall through */ }
      solving = false;
      if (lastHash !== solvedFor) { lastHash = ""; lastGhost = null; schedule(); return; } // board moved mid-solve — redo
      if (!best) { badge("no move found"); return; }
      lastGhost = { col: best.col, heights: heights, hash: solvedFor };
      showGhost(best.col, heights);
      if (best.kind === "win") badge("winning drop — take it", "hot");
      else if (best.kind === "block") badge("block here — now", "hot");
      else if (best.score > TezC4.WIN - 100) badge("forced win — follow the ghost", "hot");
      else if (best.kind === "opening") badge("opening — take center");
      else badge("best drop: column " + (best.col + 1));
    }, 60);
  }

  /* ---------- boot ---------- */
  var pending = null;
  function schedule() {
    if (pending) return;
    pending = setTimeout(function () { pending = null; sync(); }, 250);
  }

  gate(function (ok) {
    allowed = ok;
    if (!ok) return; // stays dormant for everyone else
    new MutationObserver(schedule).observe(document.documentElement, {
      childList: true, subtree: true, attributes: true, attributeFilter: ["class"]
    });
    sync();
  });
})();
