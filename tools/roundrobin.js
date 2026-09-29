#!/usr/bin/env node
'use strict';
/*
 * roundrobin.js — rank temperatures against each other, on one scoring function.
 *
 * Two things the earlier sweeps established, both worth stating plainly:
 *   - T=0 (pure argmax) is NOT the strongest setting. A greedy player here
 *     pushes its lead pawn relentlessly -- scoreTarget gives +10 for moving the
 *     most advanced pawn -- until that pawn is captured and the progress is
 *     gone. Noise develops several pawns and hedges that risk.
 *   - scoreTargetHard() (the extra threat/cluster/sacrifice layer) scored worse
 *     at EVERY temperature than plain scoreTarget() did. It looks more
 *     sophisticated; it does not play better.
 *
 * So rather than assume an ordering, play every temperature against every other
 * and rank them. --scoring hard runs the same tournament on scoreTargetHard so
 * the two can be compared on equal terms.
 *
 *   node tools/roundrobin.js --games 10
 *   node tools/roundrobin.js --games 10 --scoring hard
 */

const { boot } = require('./aisim.js');

const args = process.argv.slice(2);
const argOf = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const GAMES = Number(argOf('games', 10));
const SCORING = argOf('scoring', 'base');
const TEMPS = [0, 2, 4, 6, 8, 10, 14, 20, 30];
const CAP = 600;

function play(board, seed, tA, tB) {
  const h = boot({ seed });
  const { ctx, S } = h;
  ctx.setBoard(board);
  S.numPlayers = 2; S.cpuMode = 'some'; S.powerupsEnabled = false;
  ctx.isCPU = () => true;

  // Seat 1 gets tA, seat 2 gets tB, both on the same scoring function.
  const origPick = ctx.pickByTemperature;
  ctx.pickByTemperature = (cands) => origPick(cands, S.currentPlayer === 1 ? tA : tB);
  // Route every seat through the same scorer so temperature is the only variable.
  if (SCORING === 'base') {
    ctx.bestMoveHard = ctx.bestMove;
  } else {
    ctx.bestMove = ctx.bestMoveHard;
  }
  // No need to touch the blunder rate: every seat is pinned to the hard tier
  // below, whose blunder is 0, and temperature is supplied directly above.

  const origDoCPU = ctx.doCPU;
  let plies = 0;
  ctx.doCPU = function () { S.cpuDiff = 'hard'; plies++; return origDoCPU.apply(this, arguments); };
  let winner = null;
  ctx.showWin = (p) => { winner = p; S.gameOver = true; };

  ctx.startGame();
  let guard = 0;
  while (!winner && plies < CAP && guard < 4e6) { if (!h.stepTimer()) break; guard++; }
  return { winner, plies, finished: winner !== null };
}

console.log(`\nRound robin — scoring=${SCORING}, ${GAMES} games per ordered pair, cap ${CAP}\n`);

for (const board of ['classic', 'duel']) {
  const wins = {}, played = {}, fin = {}, tot = {};
  for (const t of TEMPS) { wins[t] = 0; played[t] = 0; fin[t] = 0; tot[t] = 0; }
  let games = 0, finished = 0, plieSum = 0;

  for (const a of TEMPS) {
    for (const b of TEMPS) {
      if (a === b) continue;
      for (let g = 0; g < GAMES; g++) {
        const r = play(board, 9000 + g, a, b);
        games++;
        played[a]++; played[b]++;
        if (r.finished) {
          finished++; plieSum += r.plies;
          if (r.winner === 1) wins[a]++; else wins[b]++;
        }
      }
    }
  }
  console.log(`${board}  (${games} games, ${Math.round(finished / games * 100)}% finished, avg ${Math.round(plieSum / Math.max(1, finished))} plies)`);
  const rows = TEMPS.map(t => ({ t, pct: played[t] ? wins[t] / played[t] * 100 : 0 }))
                    .sort((x, y) => y.pct - x.pct);
  for (const r of rows) {
    const bar = '#'.repeat(Math.round(r.pct / 2));
    console.log(`   T=${String(r.t).padStart(2)}  ${r.pct.toFixed(1).padStart(5)}%  ${bar}`);
  }
  console.log('');
}
console.log('% = games won out of games played, across every opponent temperature.\n');
