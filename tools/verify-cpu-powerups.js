#!/usr/bin/env node
'use strict';
/*
 * verify-cpu-powerups.js — checks for "let the CPU use powerups".
 *
 *   node tools/verify-cpu-powerups.js
 *
 * 1. The CPU actually spends items instead of hoarding two forever.
 * 2. Double Roll works for the CPU at all. It never did: the flag is only read
 *    by applyDoubleRoll(), only called from rollDice(), which early-returns for
 *    CPU seats -- and doCPU does its own rolling.
 * 3. Neither placement powerup can strand the turn. placeTempBarricade() and
 *    placeTrap() silently return on an illegal cell, exactly like
 *    placeBarricade() did before the softlock fix.
 *
 * Runs on an unfixed tree too, so it demonstrates the gap on origin/main.
 */

const { boot } = require('./aisim.js');

let failures = 0;
function check(name, ok, detail) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
}

function newGame(board, tier, seed) {
  const h = boot({ seed });
  const { ctx, S } = h;
  ctx.setBoard(board);
  S.numPlayers = 2; S.cpuMode = 'some'; S.powerupsEnabled = true;
  ctx.isCPU = () => true;
  ctx.initGame();
  S.cpuDiff = tier;
  return h;
}

console.log('\n1. Does the CPU spend powerups at all?\n');
for (const board of ['classic', 'duel']) {
  for (const tier of ['easy', 'medium', 'hard']) {
    const h = newGame(board, tier, 11);
    const { ctx, S } = h;
    let used = 0;
    const orig = ctx.applyPowerup;
    if (typeof orig === 'function') {
      ctx.applyPowerup = function () { used++; return orig.apply(this, arguments); };
    }
    // Hand each seat a full inventory every turn so the question is purely
    // "will it spend them", not "did it find any".
    const origDo = ctx.doCPU;
    let plies = 0;
    ctx.doCPU = function () {
      plies++;
      const inv = S.playerPowerups[S.currentPlayer] || (S.playerPowerups[S.currentPlayer] = []);
      while (inv.length < 2) {
        inv.push({ type: ['double', 'tempbar', 'shield', 'trap'][inv.length % 4], id: 'x' + (plies * 10 + inv.length) });
      }
      return origDo.apply(this, arguments);
    };
    let winner = null;
    ctx.showWin = (p) => { winner = p; S.gameOver = true; };
    ctx.startGame();
    let guard = 0;
    while (!winner && plies < 200 && guard < 2e6) { if (!h.stepTimer()) break; guard++; }
    check(`${board}/${tier}: spends items over ${plies} plies`, used > 0,
          used > 0 ? `${used} used` : 'NEVER used one (hoards forever)');
  }
}

console.log('\n2. Double Roll reaches the CPU\n');
{
  const h = newGame('classic', 'hard', 5);
  const { ctx, S } = h;
  let doubled = false;
  const origGlog = ctx.glog;
  ctx.glog = function (m) { if (typeof m === 'string' && m.includes('× 2')) doubled = true; };
  if (typeof ctx.activateDoubleRoll === 'function') ctx.activateDoubleRoll();
  S.currentPlayer = 1;
  S.phase = 'roll';
  ctx.doCPU();
  // Let the queued pick/move steps run.
  let guard = 0;
  while (guard < 200 && h.stepTimer()) guard++;
  ctx.glog = origGlog;
  check('a CPU turn with doubleRollActive actually doubles', doubled,
        doubled ? 'rolled n x 2' : 'flag ignored — Double Roll is a no-op for the CPU');
}

console.log('\n3. Placement powerups cannot strand the turn\n');
for (const [label, activate, phaseName] of [
  ['temp barricade', 'activateTempBarricade', 'place-temp-barricade'],
  ['trap', 'activateTrap', 'place-trap'],
]) {
  const h = newGame('classic', 'hard', 9);
  const { ctx, S } = h;
  S.currentPlayer = 1;
  S.pawns[1][0].onBoard = true; S.pawns[1][0].er = S.BOTTOM_ROW - 3; S.pawns[1][0].ec = S.GOAL[1];
  S.pawns[2][0].onBoard = true; S.pawns[2][0].er = S.BOTTOM_ROW - 4; S.pawns[2][0].ec = S.GOAL[1];
  S.phase = 'roll';

  // Mine every cell so no placement can ever succeed -- the worst case.
  for (const { er, ec } of Object.values(S.CELL_MAP)) S.traps.push({ er, ec, player: 2 });

  ctx[activate]();
  if (typeof ctx.cpuPlaceFrom === 'function') {
    if (phaseName === 'place-temp-barricade') {
      ctx.cpuPlaceFrom(ctx.bestBarricade(true), ctx.placeTempBarricade, phaseName);
    } else {
      const c = ctx.cpuBestTrapCell ? ctx.cpuBestTrapCell() : null;
      ctx.cpuPlaceFrom(c ? [c] : [], ctx.placeTrap, phaseName);
    }
  } else {
    // Pre-fix shape: one unchecked call, no fallback.
    const pl = ctx.bestBarricade();
    if (pl) ctx[phaseName === 'place-trap' ? 'placeTrap' : 'placeTempBarricade'](pl.er, pl.ec);
  }
  check(`${label}: turn still usable when every cell is illegal`,
        S.phase !== phaseName,
        S.phase !== phaseName ? `phase -> ${S.phase}` : `STUCK in ${phaseName}`);
}

console.log(`\n${failures ? failures + ' FAILURE(S)' : 'all checks passed'}\n`);
process.exit(failures ? 1 : 0);
