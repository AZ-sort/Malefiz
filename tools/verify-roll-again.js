#!/usr/bin/env node
'use strict';
/*
 * verify-roll-again.js — checks for "a 6 moves and rolls again".
 *
 *   node tools/verify-roll-again.js
 *
 * 1. A plain 6 gives the same player another roll instead of passing.
 * 2. Any other roll passes the turn exactly as before.
 * 3. The run is capped, so a turn always ends (this is what guarantees
 *    termination — without it a hot streak could in principle never stop).
 * 4. A Double Roll is excluded, even when it totals 6. It is two dice and
 *    already a big move; chaining extra rolls onto it would be swingy and
 *    impossible to state in one line.
 * 5. A 6 that captures a barricade places the barricade FIRST and then rolls
 *    again. This is the easy one to get wrong: capturing routes through the
 *    place-barricade phase, so hooking only finishMove() silently eats the
 *    bonus roll on exactly the turns it matters most.
 * 6. Being boxed in on a 6 costs the move but not the turn — you roll again
 *    rather than passing.
 * 7. Bonus rolls never carry across a turn boundary.
 *
 * Runs on an unfixed tree too, so it demonstrates the gap on origin/main.
 */

const { boot } = require('./aisim.js');

let failures = 0;
function check(name, ok, detail) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
}

function newGame(board, seed) {
  const h = boot({ seed });
  const { ctx, S } = h;
  ctx.setBoard(board);
  S.numPlayers = 2; S.cpuMode = 'none'; S.powerupsEnabled = true;
  ctx.isCPU = () => false;          // drive the human path throughout
  ctx.initGame();
  S.currentPlayer = 1;
  S.phase = 'roll';
  return h;
}

// Force the next die draws to exact faces, then hand control back to the
// seeded RNG. Each face f maps to a random value that floors to f-1.
function forceFaces(ctx, faces) {
  const seq = faces.map(f => (f - 1) / 6 + 1e-6);
  let i = 0;
  const real = ctx.Math.random;
  ctx.Math.random = () => (i < seq.length ? seq[i++] : real());
  return () => { ctx.Math.random = real; };
}

const haveFix = (() => {
  const h = newGame('classic', 1);
  return typeof h.ctx.endTurnOrRollAgain === 'function'
      && typeof h.ctx.rollsAgain === 'function';
})();

if (!haveFix) {
  console.log('\n  endTurnOrRollAgain()/rollsAgain() not present — unfixed tree.\n');
  for (const n of ['a plain 6 grants another roll',
                   'a non-6 passes the turn',
                   'the bonus run is capped',
                   'a Double Roll totalling 6 does not chain',
                   'a 6 that captures a barricade places then rolls again',
                   'stuck on a 6 rolls again instead of passing',
                   'bonus rolls reset across a turn boundary']) {
    check(n, false, 'rule not implemented');
  }
  console.log(`\n${failures} check(s) failed\n`);
  process.exit(1);
}

console.log('\n1. A plain 6 grants another roll\n');
{
  const h = newGame('classic', 3);
  const { ctx, S } = h;
  const restore = forceFaces(ctx, [6]);
  ctx.rollDice();
  restore();
  const rolled = S.diceVal, faces = (S.diceFaces || []).slice();
  const before = S.currentPlayer;
  ctx.endTurnOrRollAgain();
  check('a plain 6 grants another roll',
        S.currentPlayer === before && S.phase === 'roll' && S.bonusRolls === 1,
        `rolled ${rolled} (faces ${faces.join('+')}), player stays ${S.currentPlayer}, bonusRolls ${S.bonusRolls}`);
  check('the extra roll does not advance the turn counter',
        S.currentPlayer === before, `player ${before} -> ${S.currentPlayer}`);
}

console.log('\n2. Any other roll passes the turn\n');
for (const face of [1, 2, 3, 4, 5]) {
  const h = newGame('classic', 4);
  const { ctx, S } = h;
  const restore = forceFaces(ctx, [face]);
  ctx.rollDice();
  restore();
  const before = S.currentPlayer;
  ctx.endTurnOrRollAgain();
  check(`a roll of ${face} passes the turn`,
        S.currentPlayer !== before && S.bonusRolls === 0,
        `player ${before} -> ${S.currentPlayer}`);
}

console.log('\n3. The bonus run is capped (this is what guarantees a turn ends)\n');
{
  const h = newGame('classic', 5);
  const { ctx, S } = h;
  const start = S.currentPlayer;
  let grants = 0;
  for (let i = 0; i < 8; i++) {
    if (S.phase !== 'roll' || S.currentPlayer !== start) break;
    const restore = forceFaces(ctx, [6]);
    ctx.rollDice();
    restore();
    const before = S.currentPlayer;
    ctx.endTurnOrRollAgain();
    if (S.currentPlayer === before) grants++; else break;
  }
  check('three sixes in a row grant exactly three extra rolls', grants === 3,
        `${grants} granted`);
  check('the fourth six passes the turn', S.currentPlayer !== start,
        `player ${start} -> ${S.currentPlayer}`);
}

console.log('\n4. A Double Roll is excluded, even when it totals 6\n');
{
  const h = newGame('classic', 6);
  const { ctx, S } = h;
  ctx.activateDoubleRoll();
  const restore = forceFaces(ctx, [3, 3]);   // 3 + 3 = 6
  ctx.rollDice();                            // routes through applyDoubleRoll
  restore();
  // Capture before the call: endTurnOrRollAgain() -> nextTurn() nulls diceVal.
  const faces = (S.diceFaces || []).slice();
  const total = S.diceVal;
  const before = S.currentPlayer;
  ctx.endTurnOrRollAgain();
  check('a Double Roll totalling 6 does not chain',
        total === 6 && faces.length === 2 && S.currentPlayer !== before && S.bonusRolls === 0,
        `total ${total} from ${faces.join(' + ')}, player ${before} -> ${S.currentPlayer}`);
}

console.log('\n5. A 6 that captures a barricade places FIRST, then rolls again\n');
{
  const h = newGame('classic', 7);
  const { ctx, S } = h;
  const restore = forceFaces(ctx, [6]);
  ctx.rollDice();                            // diceVal 6, diceFaces [6]
  restore();
  const before = S.currentPlayer;
  // Stand where finishMove() leaves a player who just cleared a barricade.
  S.phase = 'place-barricade';
  const target = (() => {
    for (const key of Object.keys(S.CELL_MAP)) {
      const [er, ec] = key.split(',').map(Number);
      if (er >= S.BOTTOM_ROW) continue;
      if (er === S.GOAL[0] && ec === S.GOAL[1]) continue;
      if (ctx.barAt(er, ec) || ctx.pawnAt(er, ec)) continue;
      return { er, ec };
    }
    return null;
  })();
  const barsBefore = S.barricades.length;
  ctx.placeBarricade(target.er, target.ec);
  const placed = S.barricades.length === barsBefore + 1;
  check('the barricade is actually placed', placed,
        `cell (${target.er},${target.ec}), ${barsBefore} -> ${S.barricades.length}`);
  check('a 6 that captures a barricade places then rolls again',
        placed && S.currentPlayer === before && S.phase === 'roll' && S.bonusRolls === 1,
        `player stays ${S.currentPlayer}, phase ${S.phase}, bonusRolls ${S.bonusRolls}`);
}

console.log('\n6. Boxed in on a 6 — roll again, do not pass\n');
{
  const h = newGame('classic', 8);
  const { ctx, S } = h;
  ctx.hasAnyLegalMove = () => false;         // every pawn genuinely stuck
  const before = S.currentPlayer;
  const restore = forceFaces(ctx, [6]);
  ctx.rollDice();                            // fires checkNoLegalMove()
  restore();
  let guard = 0;
  while (guard < 500 && S.phase !== 'roll' && h.stepTimer()) guard++;
  check('stuck on a 6 rolls again instead of passing',
        S.currentPlayer === before && S.phase === 'roll' && S.bonusRolls === 1,
        `player stays ${S.currentPlayer}, phase ${S.phase}, bonusRolls ${S.bonusRolls}`);
}
{
  const h = newGame('classic', 9);
  const { ctx, S } = h;
  ctx.hasAnyLegalMove = () => false;
  const before = S.currentPlayer;
  const restore = forceFaces(ctx, [4]);      // stuck on a non-6 still passes
  ctx.rollDice();
  restore();
  let guard = 0;
  while (guard < 500 && S.currentPlayer === before && h.stepTimer()) guard++;
  check('stuck on a non-6 still passes the turn', S.currentPlayer !== before,
        `player ${before} -> ${S.currentPlayer}`);
}

console.log('\n7. Bonus rolls never carry across a turn boundary\n');
{
  const h = newGame('classic', 10);
  const { ctx, S } = h;
  const restore = forceFaces(ctx, [6]);
  ctx.rollDice();
  restore();
  ctx.endTurnOrRollAgain();
  const mid = S.bonusRolls;
  ctx.nextTurn();
  check('bonus rolls reset across a turn boundary', mid === 1 && S.bonusRolls === 0,
        `${mid} -> ${S.bonusRolls}`);
}

console.log(failures ? `\n${failures} check(s) failed\n` : '\nall checks passed\n');
process.exit(failures ? 1 : 0);
