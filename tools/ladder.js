#!/usr/bin/env node
'use strict';
/*
 * ladder.js — is easy < medium < hard actually true?
 *
 * The matrix report always seats the first-named tier as player 1, and moving
 * first is worth something here, so it cannot settle an ordering on its own.
 * This plays every tier pair from BOTH seats and reports the combined rate.
 *
 *   node tools/ladder.js --games 30
 */

const { boot } = require('./aisim.js');

const args = process.argv.slice(2);
const argOf = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? Number(args[i + 1]) : d; };
const GAMES = argOf('games', 30);
const CAP = argOf('cap', 400);

function play(board, seed, seat1, seat2, powerups) {
  const h = boot({ seed });
  const { ctx, S } = h;
  ctx.setBoard(board);
  S.numPlayers = 2; S.cpuMode = 'some'; S.powerupsEnabled = !!powerups;
  ctx.isCPU = () => true;
  const origDoCPU = ctx.doCPU;
  let plies = 0;
  ctx.doCPU = function () {
    S.cpuDiff = S.currentPlayer === 1 ? seat1 : seat2;
    plies++;
    return origDoCPU.apply(this, arguments);
  };
  let winner = null;
  ctx.showWin = (p) => { winner = p; S.gameOver = true; };
  ctx.startGame();
  let guard = 0;
  while (!winner && plies < CAP && guard < 4e6) { if (!h.stepTimer()) break; guard++; }
  return { winner, plies, finished: winner !== null };
}

// Returns how often `strong` beat `weak` with seats alternated.
function duel(board, strong, weak, powerups) {
  let sw = 0, fin = 0, plieSum = 0, unfinished = 0;
  for (const strongSeat of [1, 2]) {
    for (let g = 0; g < GAMES; g++) {
      const a = strongSeat === 1 ? strong : weak;
      const b = strongSeat === 1 ? weak : strong;
      const r = play(board, 21000 + g, a, b, powerups);
      if (!r.finished) { unfinished++; continue; }
      fin++; plieSum += r.plies;
      if (r.winner === strongSeat) sw++;
    }
  }
  return { pct: fin ? sw / fin * 100 : 0, fin, total: GAMES * 2, unfinished,
           avgPlies: fin ? Math.round(plieSum / fin) : 0 };
}

const PAIRS = [['hard', 'easy'], ['hard', 'medium'], ['medium', 'easy']];

for (const powerups of [false, true]) {
  console.log(`\n${powerups ? 'WITH powerups' : 'no powerups'} — ${GAMES} games per seat assignment, cap ${CAP}\n`);
  for (const board of ['classic', 'duel']) {
    for (const [a, b] of PAIRS) {
      const r = duel(board, a, b, powerups);
      const ok = r.pct >= 60 ? 'ok ' : r.pct >= 50 ? '~  ' : 'BAD';
      console.log(`  ${ok} ${board.padEnd(8)} ${a.padEnd(6)} beats ${b.padEnd(6)} ` +
        `${r.pct.toFixed(1).padStart(5)}%   ` +
        `finished ${r.fin}/${r.total}${r.unfinished ? '  (' + r.unfinished + ' UNFINISHED)' : ''}   avg ${r.avgPlies} plies`);
    }
  }
}
console.log('\nSeats alternated, so this is skill and not first-move advantage.');
console.log('A correct ladder needs every line >= 60%.\n');
