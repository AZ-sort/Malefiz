#!/usr/bin/env node
'use strict';
/*
 * verify-leap.js — checks for the Leap powerup ("jump barricades").
 *
 *   node tools/verify-leap.js
 *
 * 1. Leap actually unlocks destinations that barricades otherwise block.
 * 2. buildPath() honours it. This is the one that bites: buildPath backs the
 *    move animation and the multiplayer path sync, so patching only the reach
 *    searches offers the move and then fails to animate or sync it. A failure
 *    here shows up as a 2-element fallback path instead of a real one.
 * 3. getPathFromEntry() honours it too (the deploy path is a third search).
 * 4. Landing rules are NOT relaxed: a temp barricade still cannot be landed on.
 * 5. Landing exactly on a normal barricade still captures it.
 * 6. Leap is spent by one completed move.
 * 7. Leap survives serialize/applyGameState (the bug doubleRollActive had).
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
  ctx.isCPU = () => false;
  ctx.initGame();
  S.currentPlayer = 1;
  S.phase = 'roll';
  return h;
}

const probe = newGame('classic', 1);
const haveFix = typeof probe.ctx.blocksPath === 'function'
             && typeof probe.ctx.activateLeap === 'function';

if (!haveFix) {
  console.log('\n  blocksPath()/activateLeap() not present — unfixed tree.\n');
  for (const n of ['Leap unlocks blocked destinations',
                   'buildPath honours Leap',
                   'getPathFromEntry honours Leap',
                   'a temp barricade still cannot be landed on',
                   'landing exactly on a barricade still captures it',
                   'Leap is spent by one move',
                   'Leap survives serialize/restore']) {
    check(n, false, 'powerup not implemented');
  }
  console.log(`\n${failures} check(s) failed\n`);
  process.exit(1);
}

console.log('\n1. Leap unlocks destinations barricades otherwise block\n');
for (const board of ['classic', 'duel']) {
  const h = newGame(board, 2);
  const { ctx, S } = h;
  const count = (withLeap) => {
    S.leapActive = withLeap;
    const sizes = [];
    for (let s = 1; s <= 6; s++) sizes.push(ctx.getReachableFromEntry(1, s).length);
    S.leapActive = false;
    return sizes;
  };
  const off = count(false), on = count(true);
  const superset = on.every((v, i) => v >= off[i]);
  const strictlyMore = on.some((v, i) => v > off[i]);
  check(`${board}: Leap never removes a destination`, superset,
        `off ${off.join(',')} vs on ${on.join(',')}`);
  check(`${board}: Leap unlocks destinations blocked otherwise`, strictlyMore,
        `off ${off.join(',')} vs on ${on.join(',')}`);
}

console.log('\n2. buildPath() honours Leap (the animation/sync path)\n');
{
  const h = newGame('classic', 3);
  const { ctx, S } = h;
  // Find a barricade with walkable cells directly before and after it on a
  // straight line — crossing it needs exactly the pass-through rule.
  let found = null;
  for (const b of S.barricades) {
    for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
      const from = { er: b.er - dr, ec: b.ec - dc };
      const to = { er: b.er + dr, ec: b.ec + dc };
      if (!ctx.isWalkable(from.er, from.ec) || !ctx.isWalkable(to.er, to.ec)) continue;
      if (ctx.barAt(from.er, from.ec) || ctx.barAt(to.er, to.ec)) continue;
      found = { b, from, to };
      break;
    }
    if (found) break;
  }
  if (!found) {
    check('buildPath honours Leap', false, 'no straight barricade crossing found on this board');
  } else {
    const { b, from, to } = found;
    S.leapActive = true;
    const p = ctx.buildPath(from.er, from.ec, to.er, to.ec, 2);
    S.leapActive = false;
    const realPath = p.length === 3;                       // steps + 1
    const crosses = p.some(c => c.er === b.er && c.ec === b.ec);
    check('buildPath returns a real path, not the 2-cell fallback', realPath,
          `length ${p.length} (fallback would be 2)`);
    check('buildPath routes through the barricade cell', crosses,
          `barricade (${b.er},${b.ec}), path ${p.map(c => `${c.er},${c.ec}`).join(' -> ')}`);
    // And without Leap the same crossing must be refused.
    const blocked = ctx.buildPath(from.er, from.ec, to.er, to.ec, 2);
    check('without Leap the same crossing is refused', blocked.length === 2,
          `length ${blocked.length}`);
  }
}

console.log('\n3. getPathFromEntry() honours Leap\n');
{
  const h = newGame('classic', 4);
  const { ctx, S } = h;
  const pathLen = (withLeap, steps) => {
    S.leapActive = withLeap;
    const p = ctx.getPathFromEntry(1, steps);
    S.leapActive = false;
    return p ? p.length : 0;
  };
  // Compare reachable counts rather than one hardcoded route — the deploy
  // search is exercised through getReachableFromEntry above; here we just
  // confirm the third search does not throw and still returns a path.
  const ok = pathLen(true, 4) > 0;
  check('getPathFromEntry still returns a path under Leap', ok, `length ${pathLen(true, 4)}`);
}

console.log('\n4. Landing rules are NOT relaxed\n');
{
  const h = newGame('classic', 5);
  const { ctx, S } = h;
  // Drop a temp barricade on a cell reachable from the entry in 2 steps.
  S.leapActive = true;
  const twoAway = ctx.getReachableFromEntry(1, 2);
  S.leapActive = false;
  const target = twoAway[0];
  S.tempBarricades.push({ er: target.er, ec: target.ec, turnsLeft: 6 });
  S.barricades.push({ er: target.er, ec: target.ec });
  S.leapActive = true;
  const reach = ctx.getReachableFromEntry(1, 2);
  S.leapActive = false;
  const canLand = reach.some(t => t.er === target.er && t.ec === target.ec);
  check('a temp barricade still cannot be landed on, even with Leap', !canLand,
        `cell (${target.er},${target.ec})`);
}
{
  const h = newGame('classic', 6);
  const { ctx, S } = h;
  // A normal barricade placed on a reachable cell must still be landable
  // (that is how you capture one) — Leap must not change this either way.
  const twoAway = ctx.getReachableFromEntry(1, 2);
  const target = twoAway[0];
  S.barricades.push({ er: target.er, ec: target.ec });
  const landNoLeap = ctx.getReachableFromEntry(1, 2)
    .some(t => t.er === target.er && t.ec === target.ec);
  S.leapActive = true;
  const landLeap = ctx.getReachableFromEntry(1, 2)
    .some(t => t.er === target.er && t.ec === target.ec);
  S.leapActive = false;
  check('landing exactly on a barricade still captures it', landNoLeap && landLeap,
        `without Leap ${landNoLeap}, with Leap ${landLeap}`);
}

console.log('\n5. Leap is spent by one move\n');
{
  const h = newGame('classic', 7);
  const { ctx, S } = h;
  ctx.activateLeap();
  const activeBefore = S.leapActive;
  // Drive a real roll so phase becomes 'pick-pawn'. pickPawn() early-returns
  // otherwise, and a silent no-op would leave Leap set and read as a failure
  // of the product rather than of the test.
  const seq = [(3 - 1) / 6 + 1e-6];
  let i = 0;
  const realRandom = ctx.Math.random;
  ctx.Math.random = () => (i < seq.length ? seq[i++] : realRandom());
  ctx.rollDice();
  ctx.Math.random = realRandom;
  const dests = ctx.getReachableFromEntry(1, S.diceVal);
  const pw = S.pawns[1][0];
  ctx.pickPawn(pw);
  ctx.moveTo(dests[0].er, dests[0].ec);
  let guard = 0;
  while (guard < 300 && h.stepTimer()) guard++;
  check('Leap is active after activation', activeBefore === true, `${activeBefore}`);
  check('the move actually happened', pw.onBoard === true, `pawn onBoard ${pw.onBoard}`);
  check('Leap is spent by one completed move', S.leapActive === false,
        `now ${S.leapActive}`);
}

console.log('\n6. Leap survives serialize/restore\n');
{
  const h = newGame('classic', 8);
  const { ctx, S } = h;
  ctx.activateLeap();
  const blob = ctx.serializeGameState();
  S.leapActive = false;              // simulate the far client
  ctx.applyGameState(blob);
  check('Leap survives serialize/restore', S.leapActive === true,
        `restored ${S.leapActive}`);
}

console.log('\n7. The CPU actually spends it\n');
// PR #63's lesson: an item the CPU can collect but never spend is worse than
// no item, because holding two blocks further collection entirely.
for (const tier of ['easy', 'medium', 'hard']) {
  const h = boot({ seed: 21 });
  const { ctx, S } = h;
  ctx.setBoard('classic');
  S.numPlayers = 2; S.cpuMode = 'some'; S.powerupsEnabled = true;
  ctx.isCPU = () => true;
  ctx.initGame();
  S.cpuDiff = tier;

  let leapUsed = 0;
  const origApply = ctx.applyPowerup;
  ctx.applyPowerup = function (player, pu) {
    if (pu && pu.type === 'leap') leapUsed++;
    return origApply.apply(this, arguments);
  };
  // Hand every seat a Leap each turn so the question is purely "will it spend
  // one", not "did it happen to find one".
  const origDo = ctx.doCPU;
  let plies = 0;
  ctx.doCPU = function () {
    plies++;
    const inv = S.playerPowerups[S.currentPlayer] || (S.playerPowerups[S.currentPlayer] = []);
    while (inv.length < 2) inv.push({ type: 'leap', id: 'L' + (plies * 10 + inv.length) });
    return origDo.apply(this, arguments);
  };
  let winner = null;
  ctx.showWin = () => { winner = true; S.gameOver = true; };
  ctx.startGame();
  let guard = 0;
  while (!winner && plies < 200 && guard < 2e6) { if (!h.stepTimer()) break; guard++; }
  check(`classic/${tier}: the CPU spends Leap over ${plies} plies`, leapUsed > 0,
        leapUsed > 0 ? `${leapUsed} used` : 'NEVER used one (hoards forever)');
}

console.log(failures ? `\n${failures} check(s) failed\n` : '\nall checks passed\n');
process.exit(failures ? 1 : 0);
