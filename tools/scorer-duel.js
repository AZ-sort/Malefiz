#!/usr/bin/env node
'use strict';
/*
 * scorer-duel.js — scoreTargetHard() vs scoreTarget(), head to head.
 *
 * The two round-robin tournaments each normalise within their own pool, so
 * their percentages are not comparable to each other. This puts the two
 * scoring functions on the same board at the same temperature and plays them
 * against each other directly, alternating seats so first-move advantage
 * cancels out.
 *
 * The question it answers: is the extra threat/cluster/sacrifice layer in
 * scoreTargetHard() actually worth anything? It has never been measured.
 *
 *   node tools/scorer-duel.js --games 30
 */

const { boot } = require('./aisim.js');

const args = process.argv.slice(2);
const argOf = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? Number(args[i + 1]) : d; };
const GAMES = argOf('games', 30);
const CAP = 600;

// hardSeat: which seat uses scoreTargetHard. The other uses scoreTarget.
function play(board, seed, T, hardSeat) {
  const h = boot({ seed });
  const { ctx, S } = h;
  ctx.setBoard(board);
  S.numPlayers = 2; S.cpuMode = 'some'; S.powerupsEnabled = false;
  ctx.isCPU = () => true;

  const origPick = ctx.pickByTemperature;
  ctx.pickByTemperature = (cands) => origPick(cands, T);
  // --no-filter isolates the SCORING function: bestMove applies the new
  // pointless-retreat filter and bestMoveHard does not, so leaving it on would
  // conflate the two changes.
  if (process.argv.includes('--no-filter')) ctx.withoutPointlessRetreats = (c) => c;

  const baseMove = ctx.bestMove;
  const hardMove = ctx.bestMoveHard;

  const origDoCPU = ctx.doCPU;
  let plies = 0;
  ctx.doCPU = function () {
    S.cpuDiff = 'hard';                       // route through bestMoveHard...
    // ...but swap what bestMoveHard actually is, per seat.
    ctx.bestMoveHard = (S.currentPlayer === hardSeat) ? hardMove : baseMove;
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

console.log(`\nscoreTargetHard vs scoreTarget — ${GAMES} games per seat assignment\n`);

for (const board of ['classic', 'duel']) {
  for (const T of [0, 2, 8]) {
    let hardWins = 0, baseWins = 0, fin = 0, plieSum = 0;
    for (const hardSeat of [1, 2]) {
      for (let g = 0; g < GAMES; g++) {
        const r = play(board, 11000 + g, T, hardSeat);
        if (!r.finished) continue;
        fin++; plieSum += r.plies;
        if (r.winner === hardSeat) hardWins++; else baseWins++;
      }
    }
    const pct = fin ? (hardWins / fin * 100) : 0;
    const verdict = pct > 55 ? 'hard scorer better'
                  : pct < 45 ? 'BASE scorer better'
                  : 'no clear difference';
    console.log(`  ${board.padEnd(8)} T=${String(T).padStart(2)}  ` +
      `scoreTargetHard ${String(hardWins).padStart(3)} - ${String(baseWins).padEnd(3)} scoreTarget   ` +
      `(${pct.toFixed(1).padStart(5)}%, ${fin}/${GAMES * 2} finished, avg ${Math.round(plieSum / Math.max(1, fin))} plies)  ${verdict}`);
  }
  console.log('');
}
console.log('% = share of finished games won by the scoreTargetHard side, seats alternated.\n');
