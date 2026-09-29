#!/usr/bin/env node
'use strict';
/*
 * verify-ai-core.js — checks for the CPU softlock fix + compute-headroom PR.
 *
 *   node tools/verify-ai-core.js
 *
 * 1. distToGoal equivalence. The goal-distance table must return exactly what
 *    the old per-call BFS returned, for every cell on both boards. The old
 *    algorithm is reimplemented here verbatim as the reference, so this is an
 *    independent check rather than the new code grading its own homework.
 * 2. Softlock. Drops a trap on the cell the CPU most wants, then confirms the
 *    turn still advances. Run this against origin/main too: there it fails,
 *    which is the point.
 */

const { boot } = require('./aisim.js');

let failures = 0;
function check(name, ok, detail) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
}

// The pre-table implementation, copied verbatim from index.html so the two can
// be compared. Do not "clean this up" — being a literal copy is the whole value.
function referenceDistToGoal(ctx, er, ec) {
  const GOAL = ctx.__S.GOAL;
  const GOAL_ER = GOAL[0], GOAL_EC = GOAL[1];
  if (er === GOAL_ER && ec === GOAL_EC) return 0;
  const visited = new Set();
  const queue = [[er, ec, 0]];
  visited.add(`${er},${ec}`);
  while (queue.length) {
    const [r, c, d] = queue.shift();
    for (const [dr, dc] of [[-1,0],[1,0],[0,-1],[0,1]]) {
      const nr = r+dr, nc = c+dc;
      if (nr===GOAL_ER && nc===GOAL_EC) return d+1;
      const k = `${nr},${nc}`;
      if (!visited.has(k) && ctx.isWalkable(nr,nc)) {
        visited.add(k);
        queue.push([nr, nc, d+1]);
      }
    }
  }
  return 999;
}

console.log('\n1. distToGoal: table vs. the original per-call BFS\n');
for (const board of ['classic', 'duel']) {
  const h = boot({ seed: 1 });
  const { ctx, S } = h;
  ctx.setBoard(board);
  const cells = Object.values(S.CELL_MAP);
  let mismatches = 0, first = null;
  for (const { er, ec } of cells) {
    const got = ctx.distToGoal(er, ec);
    const want = referenceDistToGoal(ctx, er, ec);
    if (got !== want) {
      mismatches++;
      if (!first) first = `(${er},${ec}) got ${got} want ${want}`;
    }
  }
  // Also probe off-board cells, which the old BFS tolerated (it never required
  // its own start cell to be walkable).
  let offMismatch = 0;
  for (let er = -2; er < 22; er++) {
    for (let ec = -2; ec < 22; ec++) {
      if (ctx.isWalkable(er, ec)) continue;
      if (ctx.distToGoal(er, ec) !== referenceDistToGoal(ctx, er, ec)) offMismatch++;
    }
  }
  check(`${board}: ${cells.length} board cells`, mismatches === 0,
        mismatches ? first : 'all identical');
  check(`${board}: off-board cells`, offMismatch === 0,
        offMismatch ? `${offMismatch} mismatches` : 'all identical');
}

console.log('\n2. Softlock: CPU barricade placement onto a mined cell\n');
for (const board of ['classic', 'duel']) {
  const h = boot({ seed: 3 });
  const { ctx, S } = h;
  ctx.setBoard(board);
  S.numPlayers = 2; S.cpuMode = 'some'; S.powerupsEnabled = true;
  ctx.isCPU = () => true;
  ctx.initGame();
  S.cpuDiff = 'hard';          // argmax: deterministic, so it re-picks forever
  S.currentPlayer = 1;

  // Put a couple of pawns out so bestBarricade() has real threats to score.
  S.pawns[1][0].onBoard = true; S.pawns[1][0].er = S.BOTTOM_ROW - 3; S.pawns[1][0].ec = S.GOAL[1];
  S.pawns[2][0].onBoard = true; S.pawns[2][0].er = S.BOTTOM_ROW - 4; S.pawns[2][0].ec = S.GOAL[1];

  const pick = ctx.bestBarricade();
  if (!pick) { check(`${board}: had a candidate cell`, false, 'bestBarricade returned null'); continue; }

  // Mine exactly the cell it wants. placeBarricade() refuses mined cells.
  S.traps.push({ er: pick.er, ec: pick.ec, player: 2 });

  // Confirm the rejection is real before testing the fix, so a passing result
  // can't come from the trap simply being ignored.
  S.phase = 'place-barricade';
  const barsBefore = S.barricades.length;
  ctx.placeBarricade(pick.er, pick.ec);
  const rejected = (S.phase === 'place-barricade' && S.barricades.length === barsBefore);
  check(`${board}: placeBarricade rejects the mined cell`, rejected,
        rejected ? `cell (${pick.er},${pick.ec})` : 'it was accepted — repro invalid');

  // Now the real test: the CPU's own placement path must still end the turn.
  // On a tree without the fix, fall back to exactly what finishMove() used to
  // do, so this script reproduces the bug on origin/main rather than crashing.
  S.phase = 'place-barricade';
  S.currentPlayer = 1;
  const fixed = typeof ctx.cpuPlaceBarricade === 'function';
  if (fixed) {
    ctx.cpuPlaceBarricade();
  } else {
    const pl = ctx.bestBarricade();
    if (pl) ctx.placeBarricade(pl.er, pl.ec); else ctx.nextTurn();
  }
  const advanced = S.phase !== 'place-barricade';
  check(`${board}: CPU placement still advances the turn${fixed ? '' : ' (pre-fix path)'}`,
        advanced,
        advanced ? `phase -> ${S.phase}` : 'STUCK in place-barricade — game is dead');
}

console.log('\n3. Full-board mining: every candidate rejected\n');
{
  const h = boot({ seed: 5 });
  const { ctx, S } = h;
  ctx.setBoard('duel');
  S.numPlayers = 2; S.cpuMode = 'some'; S.powerupsEnabled = true;
  ctx.isCPU = () => true;
  ctx.initGame();
  S.cpuDiff = 'hard';
  S.currentPlayer = 1;
  S.pawns[1][0].onBoard = true; S.pawns[1][0].er = S.BOTTOM_ROW - 3; S.pawns[1][0].ec = S.GOAL[1];
  // Mine every single cell, so no placement can ever succeed.
  for (const { er, ec } of Object.values(S.CELL_MAP)) S.traps.push({ er, ec, player: 2 });
  S.phase = 'place-barricade';
  if (typeof ctx.cpuPlaceBarricade === 'function') {
    ctx.cpuPlaceBarricade();
  } else {
    const pl = ctx.bestBarricade();
    if (pl) ctx.placeBarricade(pl.er, pl.ec); else ctx.nextTurn();
  }
  check('duel: falls through to nextTurn when nothing is placeable',
        S.phase !== 'place-barricade', `phase -> ${S.phase}`);
}

console.log(`\n${failures ? failures + ' FAILURE(S)' : 'all checks passed'}\n`);
process.exit(failures ? 1 : 0);
