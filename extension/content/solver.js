/* TezC4 — Connect 4 engine for the TEZ extension.
   Bitboards in the Pons/Fhourstones layout: bit = col*7 + row, row 0 at the
   bottom, 6 playable rows + 1 sentinel per column. The 49-bit boards are split
   into two 32-bit ints (lo = bits 0-31, hi = bits 32-48) because JS bitwise ops
   are 32-bit — this searches ~10x deeper per ms than a BigInt build.
   Negamax + alpha-beta + iterative deepening + transposition table, time-
   budgeted so a suggestion never blocks the page. Immediate win/block tactics
   are checked outside the search and are always exact. */

"use strict";

var TezC4 = (function () {
  var WIDTH = 7;
  var WIN = 100000;
  var EVAL_CLAMP = 40000;
  var LOST_EVAL = 90000; // beaten by any true mate score (WIN - ply >= 99958)
  var MATE_BAND = WIN - 1000;

  var ORDER = [3, 2, 4, 1, 5, 0, 6]; // center-out

  /* per-column constants (bit = col*7 + row) */
  var BOT_LO = [], BOT_HI = [], TOP_LO = [], TOP_HI = [], COL_LO = [], COL_HI = [];
  var BOARD_LO = 0, BOARD_HI = 0, BOTM_LO = 0, BOTM_HI = 0;
  var ODD_LO = 0, ODD_HI = 0; // rows 0, 2, 4 (bottom row = 0) — "odd rows" in 1-based theory
  (function () {
    for (var c = 0; c < WIDTH; c++) {
      var base = c * 7;
      var bLo = 0, bHi = 0, tLo = 0, tHi = 0, cLo = 0, cHi = 0;
      if (base < 32) bLo = (1 << base) >>> 0; else bHi = (1 << (base - 32)) >>> 0;
      var top = base + 5;
      if (top < 32) tLo = (1 << top) >>> 0; else tHi = (1 << (top - 32)) >>> 0;
      for (var r = 0; r < 6; r++) {
        var bit = base + r;
        if (bit < 32) cLo = (cLo | (1 << bit)) >>> 0; else cHi = (cHi | (1 << (bit - 32))) >>> 0;
        if (r % 2 === 0) {
          if (bit < 32) ODD_LO = (ODD_LO | (1 << bit)) >>> 0; else ODD_HI = (ODD_HI | (1 << (bit - 32))) >>> 0;
        }
      }
      BOT_LO.push(bLo); BOT_HI.push(bHi);
      TOP_LO.push(tLo); TOP_HI.push(tHi);
      COL_LO.push(cLo); COL_HI.push(cHi);
      BOARD_LO = (BOARD_LO | cLo) >>> 0; BOARD_HI = (BOARD_HI | cHi) >>> 0;
      BOTM_LO = (BOTM_LO | bLo) >>> 0; BOTM_HI = (BOTM_HI | bHi) >>> 0;
    }
  })();

  function popcount32(x) {
    x = x - ((x >> 1) & 0x55555555);
    x = (x & 0x33333333) + ((x >> 2) & 0x33333333);
    return (((x + (x >> 4)) & 0x0f0f0f0f) * 0x01010101) >> 24;
  }
  function popcount(lo, hi) { return popcount32(lo >>> 0) + popcount32(hi >>> 0); }

  /* four-in-a-row present in board (lo, hi)? */
  function alignment(lo, hi) {
    var mLo, mHi;
    mLo = lo & ((lo >>> 1) | (hi << 31)); // vertical
    mHi = hi & (hi >>> 1);
    if (((mLo & ((mLo >>> 2) | (mHi << 30))) | (mHi & (mHi >>> 2))) !== 0) return true;
    mLo = lo & ((lo >>> 7) | (hi << 25)); // horizontal
    mHi = hi & (hi >>> 7);
    if (((mLo & ((mLo >>> 14) | (mHi << 18))) | (mHi & (mHi >>> 14))) !== 0) return true;
    mLo = lo & ((lo >>> 6) | (hi << 26)); // diagonal \
    mHi = hi & (hi >>> 6);
    if (((mLo & ((mLo >>> 12) | (mHi << 20))) | (mHi & (mHi >>> 12))) !== 0) return true;
    mLo = lo & ((lo >>> 8) | (hi << 24)); // diagonal /
    mHi = hi & (hi >>> 8);
    if (((mLo & ((mLo >>> 16) | (mHi << 16))) | (mHi & (mHi >>> 16))) !== 0) return true;
    return false;
  }

  /* Empty squares that would complete a 4 for board p, given all stones m.
     Pons compute_winning_position, expanded per 32-bit half. Garbage bits
     above bit 48 from left shifts are cleared by the final BOARD mask. */
  var WS_LO = 0, WS_HI = 0; // out params (avoids allocating a pair per call)
  function winningSpots(pLo, pHi, mLo, mHi) {
    var rLo, rHi, aLo, aHi, bLo, bHi, cLo, cHi, dLo, dHi, eLo, eHi, fLo, fHi, p1Lo, p1Hi, p2Lo, p2Hi;

    rLo = (pLo << 1) & (pLo << 2) & (pLo << 3); // vertical
    rHi = ((pHi << 1) | (pLo >>> 31)) & ((pHi << 2) | (pLo >>> 30)) & ((pHi << 3) | (pLo >>> 29));

    var s, s2, s3;
    var shifts = [7, 6, 8]; // horizontal, diag \, diag /
    for (var i = 0; i < 3; i++) {
      s = shifts[i]; s2 = s + s; s3 = s2 + s;
      aLo = pLo << s; aHi = (pHi << s) | (pLo >>> (32 - s));          // p << s
      bLo = pLo << s2; bHi = (pHi << s2) | (pLo >>> (32 - s2));      // p << 2s
      cLo = pLo << s3; cHi = (pHi << s3) | (pLo >>> (32 - s3));      // p << 3s
      dLo = (pLo >>> s) | (pHi << (32 - s)); dHi = pHi >>> s;        // p >> s
      eLo = (pLo >>> s2) | (pHi << (32 - s2)); eHi = pHi >>> s2;     // p >> 2s
      fLo = (pLo >>> s3) | (pHi << (32 - s3)); fHi = pHi >>> s3;     // p >> 3s
      p1Lo = aLo & bLo; p1Hi = aHi & bHi;
      rLo |= p1Lo & cLo; rHi |= p1Hi & cHi;
      rLo |= p1Lo & dLo; rHi |= p1Hi & dHi;
      p2Lo = dLo & eLo; p2Hi = dHi & eHi;
      rLo |= p2Lo & aLo; rHi |= p2Hi & aHi;
      rLo |= p2Lo & fLo; rHi |= p2Hi & fHi;
    }

    WS_LO = (rLo & BOARD_LO & ~mLo) >>> 0;
    WS_HI = (rHi & BOARD_HI & ~mHi) >>> 0;
  }

  function playable(mLo, mHi, c) { return ((mLo & TOP_LO[c]) | (mHi & TOP_HI[c])) === 0; }

  /* landing square of a drop in column c: (mask + bottom(c)) & colMask(c) */
  var MB_LO = 0, MB_HI = 0;
  function moveBit(mLo, mHi, c) {
    var sum = (mLo >>> 0) + BOT_LO[c];
    var lo = sum >>> 0;
    var hi = ((mHi >>> 0) + BOT_HI[c] + (sum > 4294967295 ? 1 : 0)) >>> 0;
    MB_LO = (lo & COL_LO[c]) >>> 0;
    MB_HI = (hi & COL_HI[c]) >>> 0;
  }

  var ND_LO = 0, ND_HI = 0; // next landing square of every column
  function nextDrops(mLo, mHi) {
    var sum = (mLo >>> 0) + BOTM_LO;
    ND_LO = (sum >>> 0) & BOARD_LO;
    ND_HI = (((mHi >>> 0) + BOTM_HI + (sum > 4294967295 ? 1 : 0)) & BOARD_HI) >>> 0;
  }

  /* Heuristic for non-terminal leaves, from the mover's perspective.
     The mover has no immediate win here (negamax checks that before evaluating). */
  function evaluate(pLo, pHi, mLo, mHi) {
    var oLo = (pLo ^ mLo) >>> 0, oHi = (pHi ^ mHi) >>> 0;
    winningSpots(oLo, oHi, mLo, mHi);
    var owLo = WS_LO, owHi = WS_HI;
    nextDrops(mLo, mHi);
    // Two playable winning squares — or two stacked in one column — can't both
    // be blocked: the position is lost now, no need to search the execution.
    var playLo = owLo & ND_LO, playHi = owHi & ND_HI;
    var playableWins = popcount(playLo, playHi);
    if (playableWins >= 2) return -LOST_EVAL;
    if (((owLo & ((owLo >>> 1) | (owHi << 31)) & ND_LO) | (owHi & (owHi >>> 1) & ND_HI)) !== 0) return -LOST_EVAL;

    winningSpots(pLo, pHi, mLo, mHi);
    var score = 24 * (popcount(WS_LO, WS_HI) - popcount(owLo, owHi));
    if (playableWins !== 0) score -= 120; // forced to block next move

    // Threat parity (zugzwang theory): the player who moved FIRST wins endgame
    // fill-outs with threats on odd rows (1,3,5 from the bottom), the second
    // player with even-row threats. Wrong-parity threats usually die when the
    // columns fill, so weight correct-parity threats much higher — this is what
    // lets a depth-limited search respect wins that only execute 20 plies out.
    var stones = popcount(mLo, mHi);
    var moverIsFirst = stones % 2 === 0; // first player is on move when count is even
    var myStrongLo, myStrongHi, opStrongLo, opStrongHi;
    if (moverIsFirst) {
      myStrongLo = WS_LO & ODD_LO; myStrongHi = WS_HI & ODD_HI;
      opStrongLo = owLo & ~ODD_LO; opStrongHi = owHi & ~ODD_HI;
    } else {
      myStrongLo = WS_LO & ~ODD_LO; myStrongHi = WS_HI & ~ODD_HI;
      opStrongLo = owLo & ODD_LO; opStrongHi = owHi & ODD_HI;
    }
    score += 56 * (popcount(myStrongLo, myStrongHi) - popcount(opStrongLo, opStrongHi));

    score += 6 * (popcount(pLo & COL_LO[3], pHi & COL_HI[3]) - popcount(oLo & COL_LO[3], oHi & COL_HI[3]));
    var sideLo = (COL_LO[2] | COL_LO[4]) >>> 0, sideHi = (COL_HI[2] | COL_HI[4]) >>> 0;
    score += 2 * (popcount(pLo & sideLo, pHi & sideHi) - popcount(oLo & sideLo, oHi & sideHi));
    return score > EVAL_CLAMP ? EVAL_CLAMP : score < -EVAL_CLAMP ? -EVAL_CLAMP : score;
  }

  var ABORT = { aborted: true };
  var tt, nodes, hardDeadline;
  var killers = new Int8Array(48); // last beta-cutoff move per ply

  function now() { return performance.now(); }
  function posKey(pLo, pHi, mLo, mHi) {
    // pos + mask is a unique position key (Pons) and fits in 49 bits — exact as a double
    return ((pHi >>> 0) + (mHi >>> 0)) * 4294967296 + (pLo >>> 0) + (mLo >>> 0);
  }

  function negamax(pLo, pHi, mLo, mHi, depth, alpha, beta, ply) {
    nodes++;
    if ((nodes & 4095) === 0 && now() > hardDeadline) throw ABORT;
    if (((mLo ^ BOARD_LO) | (mHi ^ BOARD_HI)) === 0) return 0; // draw

    var c, i;
    for (i = 0; i < WIDTH; i++) { // win on the spot
      c = ORDER[i];
      if (playable(mLo, mHi, c)) {
        moveBit(mLo, mHi, c);
        if (alignment(pLo | MB_LO, pHi | MB_HI)) return WIN - ply;
      }
    }
    if (depth <= 0) return evaluate(pLo, pHi, mLo, mHi);

    // TT entries are packed ints: score+150000 (18 bits) | depth (5) | move+1 (3) | flag (2)
    var key = posKey(pLo, pHi, mLo, mHi);
    var entry = tt.get(key);
    var ttMove = -1;
    if (entry !== undefined) {
      if (((entry >> 5) & 31) >= depth) {
        // mate scores are stored node-relative; convert back to path-relative
        var ts = (entry >>> 10) - 150000;
        if (ts > MATE_BAND) ts -= ply; else if (ts < -MATE_BAND) ts += ply;
        var tf = entry & 3;
        if (tf === 0) return ts;
        if (tf === 1 && ts >= beta) return ts;
        if (tf === 2 && ts <= alpha) return ts;
      }
      ttMove = ((entry >> 2) & 7) - 1;
    }

    var bestScore = -Infinity;
    var bestMv = -1;
    var alpha0 = alpha;
    var killer = killers[ply];
    var first = true;
    // order: TT move, killer move, then center-out
    for (i = -2; i < WIDTH; i++) {
      c = i === -2 ? ttMove : i === -1 ? killer : ORDER[i];
      if (c < 0 || !playable(mLo, mHi, c)) continue;
      if (i === -1 && c === ttMove) continue;
      if (i >= 0 && (c === ttMove || c === killer)) continue;
      moveBit(mLo, mHi, c);
      var nmLo = (mLo | MB_LO) >>> 0, nmHi = (mHi | MB_HI) >>> 0;
      // child position = opponent's stones = pos ^ OLD mask (the new stone stays ours)
      var cpLo = (pLo ^ mLo) >>> 0, cpHi = (pHi ^ mHi) >>> 0;
      var s;
      if (first) {
        s = -negamax(cpLo, cpHi, nmLo, nmHi, depth - 1, -beta, -alpha, ply + 1);
        first = false;
      } else {
        // PVS: prove the move is worse with a null window, re-search only if not
        s = -negamax(cpLo, cpHi, nmLo, nmHi, depth - 1, -alpha - 1, -alpha, ply + 1);
        if (s > alpha && s < beta) {
          s = -negamax(cpLo, cpHi, nmLo, nmHi, depth - 1, -beta, -alpha, ply + 1);
        }
      }
      if (s > bestScore) { bestScore = s; bestMv = c; }
      if (bestScore > alpha) alpha = bestScore;
      if (alpha >= beta) { killers[ply] = c; break; }
    }

    // mate scores (WIN - ply) are path-dependent — store them node-relative
    var ss = bestScore;
    if (ss > MATE_BAND) ss += ply; else if (ss < -MATE_BAND) ss -= ply;
    if (tt.size > 600000) tt.clear();
    var flag = bestScore <= alpha0 ? 2 : bestScore >= beta ? 1 : 0;
    tt.set(key, ((ss + 150000) << 10) | (depth << 5) | ((bestMv + 1) << 2) | flag);
    return bestScore;
  }

  function rootSearch(bd, depth, moves) {
    var best = { col: moves[0], score: -Infinity };
    var alpha = -Infinity;
    var scores = new Array(moves.length);
    for (var i = 0; i < moves.length; i++) {
      var c = moves[i];
      moveBit(bd.mLo, bd.mHi, c);
      var nmLo = (bd.mLo | MB_LO) >>> 0, nmHi = (bd.mHi | MB_HI) >>> 0;
      var s = -negamax((bd.pLo ^ bd.mLo) >>> 0, (bd.pHi ^ bd.mHi) >>> 0, nmLo, nmHi, depth - 1, -Infinity, -alpha, 1);
      scores[i] = s;
      if (s > best.score) { best.score = s; best.col = c; }
      if (best.score > alpha) alpha = best.score;
    }
    // best-first root order for the next, deeper iteration — faster cutoffs
    var order = moves.map(function (m, idx) { return { m: m, s: scores[idx] }; });
    order.sort(function (a, b) { return b.s - a.s; });
    for (i = 0; i < moves.length; i++) moves[i] = order[i].m;
    return best;
  }

  /* bd = { pLo, pHi, mLo, mHi } — pos is the side to move.
     Returns { col, score, kind, depth? } — kind: win | block | search | opening. */
  function bestMove(bd, budgetMs) {
    if ((bd.mLo | bd.mHi) === 0) return { col: 3, score: 0, kind: "opening" };

    var moves = [];
    var i, c;
    for (i = 0; i < WIDTH; i++) { c = ORDER[i]; if (playable(bd.mLo, bd.mHi, c)) moves.push(c); }
    if (moves.length === 0) return null;

    var oLo = (bd.pLo ^ bd.mLo) >>> 0, oHi = (bd.pHi ^ bd.mHi) >>> 0;
    for (i = 0; i < moves.length; i++) { // take a win now
      c = moves[i];
      moveBit(bd.mLo, bd.mHi, c);
      if (alignment(bd.pLo | MB_LO, bd.pHi | MB_HI)) return { col: c, score: WIN, kind: "win" };
    }
    for (i = 0; i < moves.length; i++) { // block an instant loss
      c = moves[i];
      moveBit(bd.mLo, bd.mHi, c);
      if (alignment(oLo | MB_LO, oHi | MB_HI)) return { col: c, score: 0, kind: "block" };
    }

    tt = new Map();
    killers.fill(-1);
    var budget = budgetMs || 400;
    var soft = now() + budget;
    hardDeadline = now() + budget * 1.5;
    var best = { col: moves[0], score: 0, kind: "search" };
    for (var depth = 4; depth <= 30; depth += 2) {
      nodes = 0;
      try {
        var r = rootSearch(bd, depth, moves);
        best = { col: r.col, score: r.score, kind: "search", depth: depth };
      } catch (e) {
        if (e === ABORT) break;
        throw e;
      }
      if (now() > soft) break;
      if (best.score > MATE_BAND || best.score < -MATE_BAND) break; // proven line
    }
    return best;
  }

  /* grid[row][col] with row 0 = TOP (DOM order), values: 0 empty, 1 mover, 2 opponent. */
  function boardsFromGrid(grid) {
    var pLo = 0, pHi = 0, mLo = 0, mHi = 0;
    for (var domRow = 0; domRow < 6; domRow++) {
      for (var col = 0; col < WIDTH; col++) {
        var v = grid[domRow][col];
        if (v === 0) continue;
        var bit = col * 7 + (5 - domRow);
        if (bit < 32) {
          mLo = (mLo | (1 << bit)) >>> 0;
          if (v === 1) pLo = (pLo | (1 << bit)) >>> 0;
        } else {
          mHi = (mHi | (1 << (bit - 32))) >>> 0;
          if (v === 1) pHi = (pHi | (1 << (bit - 32))) >>> 0;
        }
      }
    }
    return { pLo: pLo, pHi: pHi, mLo: mLo, mHi: mHi };
  }

  function moverWon(bd) { return alignment(bd.pLo, bd.pHi); }
  function oppWon(bd) { return alignment((bd.pLo ^ bd.mLo) >>> 0, (bd.pHi ^ bd.mHi) >>> 0); }

  return {
    bestMove: bestMove,
    boardsFromGrid: boardsFromGrid,
    moverWon: moverWon,
    oppWon: oppWon,
    WIN: WIN,
    _internals: { alignment: alignment, evaluate: evaluate, playable: playable, WIN: WIN, winningSpots: function (pLo, pHi, mLo, mHi) { winningSpots(pLo, pHi, mLo, mHi); return { lo: WS_LO, hi: WS_HI }; }, nextDrops: function (mLo, mHi) { nextDrops(mLo, mHi); return { lo: ND_LO, hi: ND_HI }; }, moveBit: function (mLo, mHi, c) { moveBit(mLo, mHi, c); return { lo: MB_LO, hi: MB_HI }; } }
  };
})();
