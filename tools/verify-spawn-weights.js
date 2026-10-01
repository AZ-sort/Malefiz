#!/usr/bin/env node
'use strict';
/*
 * verify-spawn-weights.js — checks the weighted powerup spawn table.
 *
 *   node tools/verify-spawn-weights.js
 *
 * Spawn type used to be a uniform pick over POWERUP_TYPES, which coupled "how
 * often a type appears" to "how many types exist" — so adding Leap alone cut
 * temp barricades from 25% of spawns to 20%, the opposite of what the playtest
 * asked for.
 *
 * 1. Every registered type can still spawn (a weight of 0 or a broken loop
 *    would silently make one unspawnable, which no other test would catch).
 * 2. Observed frequencies match the declared weights.
 * 3. Temp barricades are strictly the most common type — the actual request.
 * 4. A type with no declared weight still spawns (defaults to 1), so adding a
 *    type later cannot silently remove it from the pool.
 *
 * Runs on an unfixed tree too, so it demonstrates the gap on origin/main.
 */

const { boot } = require('./aisim.js');

let failures = 0;
function check(name, ok, detail) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
}

const h = boot({ seed: 5 });
const { ctx, S } = h;
ctx.setBoard('classic');

if (typeof ctx.pickPowerupType !== 'function') {
  console.log('\n  pickPowerupType() not present — unfixed tree (uniform pick).\n');
  for (const n of ['every registered type can spawn',
                   'observed frequencies match declared weights',
                   'temp barricades are the most common type',
                   'a type with no declared weight still spawns']) {
    check(n, false, 'weighted spawn table not implemented');
  }
  console.log(`\n${failures} check(s) failed\n`);
  process.exit(1);
}

const TYPES = S.POWERUP_TYPES;
const names = Object.keys(TYPES);
const N = 60000;

const counts = {};
for (const t of names) counts[t] = 0;
for (let i = 0; i < N; i++) counts[ctx.pickPowerupType()]++;

console.log('\n1. Every registered type can spawn\n');
for (const t of names) {
  check(`${t} appears`, counts[t] > 0, `${counts[t]} of ${N}`);
}

console.log('\n2. Observed frequencies match declared weights\n');
let total = 0;
for (const t of names) total += (TYPES[t].weight ?? 1);
for (const t of names) {
  const expected = (TYPES[t].weight ?? 1) / total;
  const actual = counts[t] / N;
  // 60k draws: a 2 percentage-point band is far outside sampling noise but
  // tight enough to catch a weight that is wired up wrong.
  const ok = Math.abs(actual - expected) < 0.02;
  check(`${t}: weight ${TYPES[t].weight ?? 1}/${total}`, ok,
        `expected ${(expected * 100).toFixed(1)}%, got ${(actual * 100).toFixed(1)}%`);
}

console.log('\n3. Temp barricades are the most common type\n');
{
  const others = names.filter(t => t !== 'tempbar');
  const beatsAll = others.every(t => counts.tempbar > counts[t]);
  check('tempbar is strictly the most common spawn', beatsAll,
        names.map(t => `${t} ${(counts[t] / N * 100).toFixed(1)}%`).join(', '));

  // The actual ask: more temp barricades than before, not merely "not fewer".
  // Uniform over 5 types would be 20%.
  const uniform = 1 / names.length;
  check('tempbar beats what a uniform pick would give', counts.tempbar / N > uniform + 0.05,
        `${(counts.tempbar / N * 100).toFixed(1)}% vs uniform ${(uniform * 100).toFixed(1)}%`);
}

console.log('\n4. A type with no declared weight still spawns\n');
{
  TYPES.__probe = { icon: '?', name: 'Probe', desc: 'test only' }; // no weight
  let seen = 0;
  for (let i = 0; i < 20000; i++) if (ctx.pickPowerupType() === '__probe') seen++;
  delete TYPES.__probe;
  check('an unweighted type defaults to weight 1 and still spawns', seen > 0,
        `${seen} of 20000`);
}

console.log(failures ? `\n${failures} check(s) failed\n` : '\nall checks passed\n');
process.exit(failures ? 1 : 0);
