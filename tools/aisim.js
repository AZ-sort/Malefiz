#!/usr/bin/env node
'use strict';
/*
 * aisim.js — headless CPU-AI simulator for Play Sabotage.
 *
 * Dev tool only. Never served: this project has no build step and ships
 * index.html verbatim from the static root, so anything at the repo root is
 * publicly fetchable (see /server.js and /loadtest.js). Keep this under tools/.
 *
 * WHY THIS EXISTS
 * The AI is ~400 lines of heuristics inline in a 7,700-line HTML file with no
 * module exports. The only prior measurement of it was a manual play test that
 * could say "didn't finish in 400 turns" and nothing more. This runs real games
 * at full speed so AI changes can be judged on win rates and turn counts
 * instead of vibes.
 *
 * HOW IT DRIVES CODE THAT HAS NO EXPORTS
 *  1. Slice the game <script> body out of index.html and eval it in a vm context.
 *  2. Stub the DOM, because game logic writes to it directly (nextTurn() sets
 *     #dface.textContent, for one) rather than going through a render layer.
 *  3. Replace setTimeout with a virtual clock, so the real 700/430/480/200ms
 *     turn chain runs instantly but in the correct order. We exercise the real
 *     turn loop rather than a reimplementation of it.
 *  4. Top-level `let` bindings are lexical and never become context properties,
 *     so we append an accessor object to the *source string* to reach them.
 *     index.html itself is never modified.
 *  5. Top-level `function` declarations DO become context properties, so
 *     presentation is neutered by plain assignment (ctx.renderAll = noop).
 *     index.html already does exactly this to itself at ~6858-6957, where the
 *     multiplayer layer wraps rollDice/moveTo/nextTurn.
 *
 * USAGE
 *   node tools/aisim.js --matrix --seed 7
 *   node tools/aisim.js --board classic --pairing hard:hard --games 20 --cap 800
 *   node tools/aisim.js --forced-win --trials 500
 *   node tools/aisim.js --bench
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const INDEX = path.join(__dirname, '..', 'index.html');
const TIERS = ['easy', 'medium', 'hard'];

// ---------------------------------------------------------------- extraction

function extractGameSource() {
  const lines = fs.readFileSync(INDEX, 'utf8').split('\n');
  // The game script is the <script> immediately following the socket.io tag.
  // Located by content, not line number, so this survives edits above it.
  const ioIdx = lines.findIndex(l => l.includes('<script src="socket.io.js"'));
  if (ioIdx < 0) throw new Error('could not find the socket.io script tag');
  const openIdx = lines.findIndex((l, i) => i > ioIdx && l.trim() === '<script>');
  if (openIdx < 0) throw new Error('could not find the game <script> open tag');
  const closeIdx = lines.findIndex((l, i) => i > openIdx && l.trim() === '</script>');
  if (closeIdx < 0) throw new Error('could not find the game </script> close tag');
  return {
    src: lines.slice(openIdx + 1, closeIdx).join('\n'),
    firstLine: openIdx + 2,
    lastLine: closeIdx,
  };
}

// Reaches top-level `let` state, which is otherwise invisible from outside the
// script. Appended to the source string; index.html is not touched.
const STATE_EPILOGUE = `
;globalThis.__S = {
  get currentPlayer(){return currentPlayer}, get gameOver(){return gameOver},
  get pawns(){return pawns}, get barricades(){return barricades},
  get phase(){return phase}, get diceVal(){return diceVal},
  get diceFaces(){return diceFaces},
  get traps(){return traps}, get playerPowerups(){return playerPowerups},
  get turnCount(){return turnCount}, get activeBoard(){return activeBoard},
  get GOAL(){return GOAL}, get PAWNS_PER_PLAYER(){return PAWNS_PER_PLAYER},
  get BOTTOM_ROW(){return BOTTOM_ROW}, get CELL_MAP(){return CELL_MAP},
  get cpuDiff(){return cpuDiff}, set cpuDiff(v){cpuDiff=v},
  set cpuMode(v){cpuMode=v}, set numPlayers(v){numPlayers=v},
  set powerupsEnabled(v){powerupsEnabled=v},
  set currentPlayer(v){currentPlayer=v}, set phase(v){phase=v},
  set diceVal(v){diceVal=v}, set gameOver(v){gameOver=v},
};
`;

// ------------------------------------------------------------------ dom stub

function makeCanvasCtx() {
  return new Proxy({}, {
    get(_t, p) {
      if (p === 'canvas') return { width: 0, height: 0 };
      if (p === 'createLinearGradient' || p === 'createRadialGradient') {
        return () => ({ addColorStop() {} });
      }
      if (p === 'measureText') return () => ({ width: 0 });
      if (p === 'getImageData') return () => ({ data: new Uint8ClampedArray(4) });
      return () => undefined;
    },
    set() { return true; },
  });
}

function makeNode() {
  const node = {
    style: new Proxy({}, { get: () => '', set: () => true }),
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    dataset: {},
    children: [], childNodes: [], firstChild: null, parentNode: null,
    innerHTML: '', textContent: '', innerText: '', value: '', checked: false,
    offsetWidth: 0, offsetHeight: 0, clientWidth: 0, clientHeight: 0,
    scrollHeight: 0, scrollTop: 0, width: 0, height: 0, disabled: false,
    appendChild(c) { return c; },
    insertBefore(c) { return c; },
    removeChild(c) { return c; },
    replaceChild(c) { return c; },
    remove() {},
    addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
    setAttribute() {}, getAttribute() { return null; }, removeAttribute() {},
    hasAttribute() { return false; },
    querySelector() { return makeNode(); },
    querySelectorAll() { return []; },
    getElementsByClassName() { return []; },
    getBoundingClientRect() {
      return { width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, x: 0, y: 0 };
    },
    focus() {}, blur() {}, click() {}, select() {},
    closest() { return null; },
    scrollIntoView() {},
    getContext() { return makeCanvasCtx(); },
    animate() { return { cancel() {}, finish() {} }; },
  };
  return node;
}

function makeDocument() {
  const byId = new Map();
  return {
    getElementById(id) {
      if (!byId.has(id)) byId.set(id, makeNode());
      return byId.get(id);
    },
    createElement() { return makeNode(); },
    createElementNS() { return makeNode(); },
    createDocumentFragment() { return makeNode(); },
    createTextNode() { return makeNode(); },
    querySelector() { return makeNode(); },
    querySelectorAll() { return []; },
    getElementsByClassName() { return []; },
    getElementsByTagName() { return []; },
    addEventListener() {}, removeEventListener() {},
    body: makeNode(), documentElement: makeNode(), head: makeNode(),
    readyState: 'complete',
    visibilityState: 'visible',
    cookie: '',
  };
}

// ------------------------------------------------------------------- vm boot

function boot(opts = {}) {
  const { src } = extractGameSource();
  const rng = makeRng(opts.seed == null ? 1 : opts.seed);

  // Virtual clock. Ordering is (time, insertion seq) so same-deadline timers
  // fire in the order they were queued, matching browser behaviour.
  let now = 0, seq = 0;
  const timers = [];

  const ctx = {};
  ctx.globalThis = ctx;
  ctx.window = ctx;
  ctx.self = ctx;
  ctx.console = { log() {}, warn() {}, error() {}, info() {}, debug() {} };
  ctx.addEventListener = () => {};
  ctx.removeEventListener = () => {};
  ctx.dispatchEvent = () => true;

  ctx.document = makeDocument();
  ctx.navigator = { userAgent: 'aisim', language: 'en-US', languages: ['en-US'], maxTouchPoints: 0 };
  ctx.location = { href: 'http://localhost/', hostname: 'localhost', protocol: 'http:', search: '', pathname: '/' };
  ctx.history = { replaceState() {}, pushState() {} };
  ctx.localStorage = {
    _d: new Map(),
    getItem(k) { return this._d.has(k) ? this._d.get(k) : null; },
    setItem(k, v) { this._d.set(k, String(v)); },
    removeItem(k) { this._d.delete(k); },
    clear() { this._d.clear(); },
  };
  ctx.sessionStorage = ctx.localStorage;
  ctx.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  ctx.fetch = () => Promise.reject(new Error('offline'));
  ctx.MutationObserver = class { observe() {} disconnect() {} };
  ctx.ResizeObserver = class { observe() {} disconnect() {} unobserve() {} };
  ctx.IntersectionObserver = class { observe() {} disconnect() {} unobserve() {} };
  ctx.Image = class { set src(_v) {} addEventListener() {} };
  ctx.alert = () => {}; ctx.confirm = () => true; ctx.prompt = () => null;
  ctx.getComputedStyle = () => new Proxy({}, { get: () => '' });
  ctx.devicePixelRatio = 1;
  ctx.innerWidth = 1280; ctx.innerHeight = 800;
  ctx.scrollTo = () => {};
  // Deliberately left undefined: AudioContext (playSound already swallows the
  // throw) and `io` (connectSocket self-guards and falls back to local play).

  // rAF is a no-op: the homepage race-background loop would otherwise queue
  // work forever and the simulator never needs a rendered frame.
  ctx.requestAnimationFrame = () => 0;
  ctx.cancelAnimationFrame = () => {};

  ctx.setTimeout = (fn, ms) => {
    const id = ++seq;
    timers.push({ t: now + (Number(ms) || 0), seq: id, fn });
    return id;
  };
  ctx.clearTimeout = (id) => {
    const i = timers.findIndex(x => x.seq === id);
    if (i >= 0) timers.splice(i, 1);
  };
  // No-op rather than virtualised: nothing in the turn loop depends on an
  // interval, and a live one would never drain.
  ctx.setInterval = () => ++seq;
  ctx.clearInterval = () => {};
  ctx.queueMicrotask = (fn) => fn();

  // Seeded Math so an A/B run replays identical dice. Prototype chain keeps
  // Math.floor/min/max/abs intact.
  const seededMath = Object.create(Math);
  Object.defineProperty(seededMath, 'random', { value: rng, writable: true });
  ctx.Math = seededMath;

  vm.createContext(ctx);
  vm.runInContext(src + STATE_EPILOGUE, ctx, { filename: 'index.html:game', timeout: 60000 });

  const S = ctx.__S;

  // ---- neutralise presentation -------------------------------------------
  const noop = () => {};
  for (const fn of ['renderAll', 'renderBoard', 'renderSidebar', 'updateGlowOverlay',
                    'glog', 'animDice', 'playSound', 'scaleToFit', 'connectSocket',
                    'trapFlash', 'renderHomepage', 'refreshHpBgColors']) {
    if (typeof ctx[fn] === 'function') ctx[fn] = noop;
  }

  // ---- teleport instead of animating -------------------------------------
  // The only production logic restated here. Mirrors the final-cell assignment
  // in animatePawnAlongPath (~index.html:3145-3147); everything else about the
  // move — legality, capture, barricade clearing — still runs for real.
  ctx.animatePawnAlongPath = (pawn, pathArr, onDone) => {
    const last = pathArr[pathArr.length - 1];
    pawn.onBoard = true; pawn.er = last.er; pawn.ec = last.ec;
    if (onDone) onDone();
  };
  ctx.animateCapturedPawn = (_pawn, _player, onDone) => { if (onDone) onDone(); };

  return {
    ctx, S, rng,
    timerCount: () => timers.length,
    stepTimer() {
      if (!timers.length) return false;
      timers.sort((a, b) => (a.t - b.t) || (a.seq - b.seq));
      const t = timers.shift();
      now = t.t;
      t.fn();
      return true;
    },
    clock: () => now,
    flush() { timers.length = 0; },
  };
}

// Small deterministic PRNG (mulberry32) — we need reproducibility, not quality.
function makeRng(seed) {
  let a = (seed >>> 0) || 1;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// -------------------------------------------------------------- single game

function playGame({ board = 'classic', diffs, numPlayers = 2, powerups = false,
                    cap = 800, seed = 1 } = {}) {
  const h = boot({ seed });
  const { ctx, S } = h;

  ctx.setBoard(board);
  S.numPlayers = numPlayers;
  S.cpuMode = 'some';
  S.powerupsEnabled = powerups;

  // Every seat is a CPU. In the real game isCPU() excludes seat 1 (the human),
  // so this is the one behaviour we deliberately diverge on.
  ctx.isCPU = () => true;

  const stats = {
    plies: 0, winner: null, finished: false, stalled: false,
    barricadesPlaced: 0, bestDist: Infinity, decisionMs: {}, captures: 0,
  };
  for (const t of TIERS) stats.decisionMs[t] = { n: 0, total: 0 };

  // Per-ply tier switching gives us arbitrary pairings (hard vs easy, etc.).
  // Reassigning the context property works because internal `setTimeout(doCPU,
  // 700)` resolves the identifier through the global object at call time.
  const origDoCPU = ctx.doCPU;
  ctx.doCPU = function () {
    const seat = S.currentPlayer;
    S.cpuDiff = diffs[(seat - 1) % diffs.length];
    stats.plies++;
    return origDoCPU.apply(this, arguments);
  };

  // Time the decision functions, not doCPU: doCPU returns the instant it
  // queues its first setTimeout, so the real work happens later in the chain.
  for (const name of ['bestMove', 'bestMoveHard', 'bestBarricade']) {
    const orig = ctx[name];
    if (typeof orig !== 'function') continue;
    ctx[name] = function () {
      const t0 = process.hrtime.bigint();
      const r = orig.apply(this, arguments);
      const rec = stats.decisionMs[S.cpuDiff];
      if (rec) { rec.n++; rec.total += Number(process.hrtime.bigint() - t0) / 1e6; }
      return r;
    };
  }

  const origPlaceBarricade = ctx.placeBarricade;
  ctx.placeBarricade = function (er, ec) {
    const before = S.barricades.length;
    const r = origPlaceBarricade.apply(this, arguments);
    if (S.barricades.length > before) stats.barricadesPlaced++;
    return r;
  };

  ctx.showWin = (p) => { stats.winner = p; stats.finished = true; S.gameOver = true; };

  ctx.startGame();

  let guard = 0;
  const GUARD_MAX = 4e6;
  while (!stats.finished && stats.plies < cap && guard < GUARD_MAX) {
    if (!h.stepTimer()) {
      // No pending timers and nobody has won: the turn loop dropped the baton.
      stats.stalled = true;
      stats.stallPhase = S.phase;
      stats.stallPlayer = S.currentPlayer;
      break;
    }
    guard++;
    // Track the closest any pawn has come to the goal — the signal that
    // separates "long game" from "random walk that never approaches".
    if ((stats.plies & 15) === 0) {
      for (const p of Object.keys(S.pawns)) {
        for (const pw of S.pawns[p]) {
          if (!pw.onBoard) continue;
          const d = ctx.distToGoal(pw.er, pw.ec);
          if (d < stats.bestDist) stats.bestDist = d;
        }
      }
    }
  }
  if (!stats.finished && !stats.stalled) stats.cappedOut = true;
  if (stats.bestDist === Infinity) stats.bestDist = null;
  return stats;
}

// ------------------------------------------------------------------ reports

function fmt(n, d = 1) { return Number.isFinite(n) ? n.toFixed(d) : '—'; }

function runPairing(opts) {
  const games = opts.games || 10;
  const rows = [];
  for (let g = 0; g < games; g++) {
    rows.push(playGame({ ...opts, seed: (opts.seed || 1) * 1000 + g }));
  }
  const fin = rows.filter(r => r.finished);
  const wins = {};
  for (const r of fin) wins[r.winner] = (wins[r.winner] || 0) + 1;
  const plies = fin.map(r => r.plies).sort((a, b) => a - b);
  const dm = {};
  for (const t of TIERS) {
    const n = rows.reduce((s, r) => s + r.decisionMs[t].n, 0);
    const tot = rows.reduce((s, r) => s + r.decisionMs[t].total, 0);
    if (n) dm[t] = tot / n;
  }
  return {
    games, finished: fin.length,
    stalled: rows.filter(r => r.stalled).length,
    cappedOut: rows.filter(r => r.cappedOut).length,
    minPlies: plies[0], maxPlies: plies[plies.length - 1],
    avgPlies: plies.length ? plies.reduce((a, b) => a + b, 0) / plies.length : NaN,
    wins,
    avgBarricades: rows.reduce((s, r) => s + r.barricadesPlaced, 0) / rows.length,
    bestDist: Math.min(...rows.map(r => r.bestDist == null ? Infinity : r.bestDist)),
    decisionMs: dm,
    stallDetail: rows.find(r => r.stalled) || null,
  };
}

function printPairing(label, res) {
  const winStr = Object.keys(res.wins).length
    ? Object.entries(res.wins).map(([p, n]) => `P${p}:${n}`).join(' ')
    : '—';
  console.log(
    `  ${label.padEnd(20)} finished ${String(res.finished).padStart(3)}/${res.games}` +
    `  plies ${String(res.minPlies ?? '—').padStart(4)}-${String(res.maxPlies ?? '—').padEnd(4)}` +
    ` avg ${fmt(res.avgPlies, 0).padStart(4)}` +
    `  wins ${winStr.padEnd(12)}` +
    ` barr ${fmt(res.avgBarricades, 1).padStart(5)}` +
    ` bestDist ${res.bestDist === Infinity ? '—' : res.bestDist}` +
    (res.stalled ? `  ** STALLED ${res.stalled} **` : '')
  );
}

function cmdMatrix(argv) {
  const games = argv.games || 10;
  const cap = argv.cap || 800;
  const boards = argv.board ? [argv.board] : ['classic', 'duel'];
  const pairings = [
    ['easy', 'easy'], ['medium', 'medium'], ['hard', 'hard'],
    ['hard', 'easy'], ['medium', 'easy'], ['hard', 'medium'],
  ];
  console.log(`\nAI matrix — ${games} games/pairing, ply cap ${cap}, seed ${argv.seed || 1}\n`);
  const dmAll = {};
  for (const board of boards) {
    console.log(`${board}:`);
    for (const pr of pairings) {
      const res = runPairing({ board, diffs: pr, games, cap, seed: argv.seed || 1 });
      printPairing(`${pr[0]} v ${pr[1]}`, res);
      for (const [t, v] of Object.entries(res.decisionMs)) {
        (dmAll[t] = dmAll[t] || []).push(v);
      }
      if (res.stallDetail) {
        console.log(`      stall: phase=${res.stallDetail.stallPhase} player=${res.stallDetail.stallPlayer}`);
      }
    }
    console.log('');
  }
  console.log('mean ms per decision — bestMove/bestMoveHard/bestBarricade');
  console.log('(Node; a mid-range phone is ~3-5x slower. The CPU gives a move 430ms');
  console.log(' and a barricade 700ms, so >25ms here is a mobile latency risk.)');
  for (const t of TIERS) {
    if (dmAll[t]) {
      const v = dmAll[t].reduce((a, b) => a + b, 0) / dmAll[t].length;
      console.log(`  ${t.padEnd(8)} ${fmt(v, 2)} ms`);
    }
  }
  console.log('');
}

// Does the CPU take a win that is directly in front of it? Sets up a pawn one
// step from the goal with a roll of 1 and asks each tier to choose.
function cmdForcedWin(argv) {
  const trials = argv.trials || 500;
  console.log(`\nForced-win test — ${trials} trials/tier, classic\n`);
  for (const tier of TIERS) {
    const h = boot({ seed: argv.seed || 1 });
    const { ctx, S } = h;
    ctx.setBoard('classic');
    S.numPlayers = 2; S.cpuMode = 'some'; S.powerupsEnabled = false;
    ctx.isCPU = () => true;
    ctx.initGame();
    S.cpuDiff = tier;

    const goal = S.GOAL;
    // The goal's only neighbour on both boards is the cell directly below it.
    const approach = { er: goal[0] + 1, ec: goal[1] };
    let taken = 0, valid = 0;
    for (let i = 0; i < trials; i++) {
      ctx.initGame();
      S.cpuDiff = tier;
      S.currentPlayer = 1;
      const mine = S.pawns[1];
      mine[0].onBoard = true; mine[0].er = approach.er; mine[0].ec = approach.ec;
      // Clear any starting barricade sitting on the approach or the goal.
      const bars = S.barricades;
      for (let b = bars.length - 1; b >= 0; b--) {
        if ((bars[b].er === approach.er && bars[b].ec === approach.ec) ||
            (bars[b].er === goal[0] && bars[b].ec === goal[1])) bars.splice(b, 1);
      }
      S.diceVal = 1;
      S.phase = 'pick-pawn';
      // bestMoveHard() only exists on trees that still have the separate hard
      // scorer; every tier shares bestMove() once that layer is removed.
      const mv = (tier === 'hard' && typeof ctx.bestMoveHard === 'function')
        ? ctx.bestMoveHard() : ctx.bestMove();
      if (!mv) continue;
      valid++;
      if (mv.target.er === goal[0] && mv.target.ec === goal[1]) taken++;
    }
    const pct = valid ? (taken / valid * 100) : 0;
    console.log(`  ${tier.padEnd(8)} takes the win ${String(taken).padStart(4)}/${valid}  (${fmt(pct, 1)}%)`);
  }
  console.log('');
}

// Per-call cost of the two expensive AI entry points, mid-game.
function cmdBench(argv) {
  console.log('\nDecision cost (Node)\n');
  for (const board of ['classic', 'duel']) {
    const h = boot({ seed: argv.seed || 1 });
    const { ctx, S } = h;
    ctx.setBoard(board);
    S.numPlayers = 2; S.cpuMode = 'some';
    ctx.isCPU = () => true;
    ctx.startGame();
    // Advance into the midgame so the board is representative.
    let n = 0;
    while (n < 60 && h.stepTimer()) n++;
    S.currentPlayer = 1; S.diceVal = 4;

    const time = (fn, reps) => {
      fn();                                    // warm
      const t0 = process.hrtime.bigint();
      for (let i = 0; i < reps; i++) fn();
      return Number(process.hrtime.bigint() - t0) / 1e6 / reps;
    };
    S.cpuDiff = 'medium';
    const bm = time(() => ctx.bestMove(), 20);
    S.cpuDiff = 'hard';
    const bmh = time(() => ctx.bestMoveHard(), 20);
    const bb = time(() => ctx.bestBarricade(), 20);
    console.log(`  ${board}:`);
    console.log(`    bestMove()      ${fmt(bm, 2).padStart(7)} ms`);
    console.log(`    bestMoveHard()  ${fmt(bmh, 2).padStart(7)} ms`);
    console.log(`    bestBarricade() ${fmt(bb, 2).padStart(7)} ms`);
  }
  console.log('');
}

// ---------------------------------------------------------------------- cli

function parseArgv(args) {
  const out = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else { out[key] = /^-?\d+$/.test(next) ? Number(next) : next; i++; }
    } else out._.push(a);
  }
  return out;
}

function main() {
  const argv = parseArgv(process.argv.slice(2));
  if (argv.help) {
    console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(2, 40).join('\n'));
    return;
  }
  if (argv['forced-win']) return cmdForcedWin(argv);
  if (argv.bench) return cmdBench(argv);
  if (argv.matrix) return cmdMatrix(argv);

  if (argv.pairing) {
    const diffs = String(argv.pairing).split(':');
    for (const d of diffs) {
      if (!TIERS.includes(d)) throw new Error(`unknown tier "${d}" (expected ${TIERS.join('|')})`);
    }
    const res = runPairing({
      board: argv.board || 'classic',
      diffs,
      numPlayers: argv.players || diffs.length,
      powerups: !!argv.powerups,
      games: argv.games || 10,
      cap: argv.cap || 800,
      seed: argv.seed || 1,
    });
    console.log(`\n${argv.board || 'classic'} — ${diffs.join(' v ')}\n`);
    printPairing(diffs.join(' v '), res);
    if (res.stallDetail) {
      console.log(`  stall: phase=${res.stallDetail.stallPhase} player=${res.stallDetail.stallPlayer}`);
    }
    console.log('');
    return;
  }

  cmdMatrix(argv);
}

if (require.main === module) main();
module.exports = { boot, playGame, runPairing, extractGameSource };
