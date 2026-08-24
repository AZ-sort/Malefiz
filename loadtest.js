// Load test for the Railway backend before a community launch.
//
// Nobody has measured this Hobby-plan instance above ~3 concurrent players.
// A front-paged Reddit post is hundreds of concurrent sockets. This script
// ramps 50 -> 100 -> 200 -> 400 concurrent sockets, paired into 2-player
// private rooms, driving create-room -> join-room -> start-game -> a
// trickle of game-action, and reports connect success rate + round-trip
// latency at each step. All rooms are private, so the live public lobby
// is never touched.
//
// The gotcha this script deliberately works around: server.js rate-limits
// are per-IP (MAX_ROOMS_PER_IP=5, MAX_JOINS_PER_IP=20, MAX_ACTIONS_PER_IP=300
// per 60s). Run from one machine/IP, this test would measure checkRate(),
// not server capacity -- every pair beyond the first ~2-3 would get
// "Too many rooms created" and the test would look like a capacity failure
// that isn't one. Each client sends a distinct X-Forwarded-For value in its
// handshake headers to get a distinct rate-limit bucket. NOTE: as found
// while verifying PR #25's XFF hardening, Railway's edge appears to already
// overwrite/strip inbound client-supplied XFF rather than trusting it --
// if that holds here too, every client will bucket under the SAME real IP
// regardless of this header, and you'll hit rate limits (not capacity
// limits) well before 400. Read the failure messages: "Too many rooms
// created" / "Too many join attempts" means rate limiting, not capacity.
// If that happens, temporarily raise the MAX_*_PER_IP constants in
// server.js for the duration of this test, or run from multiple real
// source IPs (e.g. a few machines/regions).
//
// Usage: node loadtest.js [url] [maxConcurrent]
//   node loadtest.js https://malefiz-production.up.railway.app 400

const { io } = require('socket.io-client');

const URL = process.argv[2] || 'https://malefiz-production.up.railway.app';
const MAX = parseInt(process.argv[3] || '400', 10);
const STEPS = [50, 100, 200, 400].filter(n => n <= MAX);
if (STEPS.length === 0) STEPS.push(MAX); // small custom MAX (e.g. a sanity run) -- use it as the sole step
const ACTIONS_PER_ROOM = 5;
const ACTION_INTERVAL_MS = 2000;

function connectOne(id) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const socket = io(URL, {
      transports: ['websocket'],
      extraHeaders: { 'x-forwarded-for': `198.51.100.${id % 250}` },
      forceNew: true,
      reconnection: false,
      timeout: 15000,
    });
    let settled = false;
    const done = (ok, info) => { if (!settled) { settled = true; resolve({ id, ok, info, connectMs: Date.now() - t0, socket }); } };
    socket.on('connect', () => done(true, 'connected'));
    socket.on('connect_error', (e) => done(false, `connect_error: ${e.message}`));
    setTimeout(() => done(false, 'connect timeout'), 16000);
  });
}

function createRoom(socket) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let settled = false;
    const done = (ok, info) => { if (!settled) { settled = true; resolve({ ok, info, ms: Date.now() - t0 }); } };
    socket.once('room-created', (d) => done(true, d.code));
    socket.once('join-error', (msg) => done(false, msg));
    socket.emit('create-room', { playerName: 'LoadHost', numPlayers: 2, mode: 'classic', isPublic: false });
    setTimeout(() => done(false, 'timeout'), 10000);
  });
}

function joinRoom(socket, code) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let settled = false;
    const done = (ok, info) => { if (!settled) { settled = true; resolve({ ok, info, ms: Date.now() - t0 }); } };
    socket.once('room-joined', () => done(true, 'joined'));
    socket.once('join-error', (msg) => done(false, msg));
    socket.emit('join-room', { code, playerName: 'LoadGuest' });
    setTimeout(() => done(false, 'timeout'), 10000);
  });
}

function startGame(hostSocket) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let settled = false;
    const done = (ok, info) => { if (!settled) { settled = true; resolve({ ok, info, ms: Date.now() - t0 }); } };
    hostSocket.once('game-start', () => done(true, 'started'));
    hostSocket.emit('start-game');
    setTimeout(() => done(false, 'timeout'), 10000);
  });
}

function gameActionRoundTrip(hostSocket, guestSocket) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let settled = false;
    const done = (ok, ms) => { if (!settled) { settled = true; resolve({ ok, ms }); } };
    guestSocket.once('game-action', () => done(true, Date.now() - t0));
    hostSocket.emit('game-action', { type: 'chat', data: { text: 'loadtest ping' } });
    setTimeout(() => done(false, -1), 5000);
  });
}

async function runPair(id) {
  const result = { id, connectOk: 0, createOk: false, joinOk: false, startOk: false, actionLatencies: [], errors: [] };
  const [host, guest] = await Promise.all([connectOne(id * 2), connectOne(id * 2 + 1)]);
  result.connectOk = (host.ok ? 1 : 0) + (guest.ok ? 1 : 0);
  if (!host.ok || !guest.ok) { result.errors.push(`connect: host=${host.info} guest=${guest.info}`); return cleanup(); }

  const created = await createRoom(host.socket);
  if (!created.ok) { result.errors.push(`create-room: ${created.info}`); return cleanup(); }
  result.createOk = true;

  const joined = await joinRoom(guest.socket, created.info);
  if (!joined.ok) { result.errors.push(`join-room: ${joined.info}`); return cleanup(); }
  result.joinOk = true;

  const started = await startGame(host.socket);
  if (!started.ok) { result.errors.push(`start-game: ${started.info}`); return cleanup(); }
  result.startOk = true;

  for (let i = 0; i < ACTIONS_PER_ROOM; i++) {
    const rt = await gameActionRoundTrip(host.socket, guest.socket);
    if (rt.ok) result.actionLatencies.push(rt.ms); else result.errors.push('game-action timeout');
    await new Promise(r => setTimeout(r, ACTION_INTERVAL_MS));
  }

  return cleanup();

  function cleanup() {
    host.socket && host.socket.disconnect();
    guest.socket && guest.socket.disconnect();
    return result;
  }
}

function summarize(step, results) {
  const pairs = results.length;
  const connectOk = results.filter(r => r.connectOk === 2).length;
  const createOk = results.filter(r => r.createOk).length;
  const joinOk = results.filter(r => r.joinOk).length;
  const startOk = results.filter(r => r.startOk).length;
  const allLatencies = results.flatMap(r => r.actionLatencies);
  const avgLatency = allLatencies.length ? (allLatencies.reduce((a, b) => a + b, 0) / allLatencies.length).toFixed(0) : 'n/a';
  const p95 = allLatencies.length ? allLatencies.sort((a, b) => a - b)[Math.floor(allLatencies.length * 0.95)] : 'n/a';
  const sampleErrors = [...new Set(results.flatMap(r => r.errors))].slice(0, 5);

  console.log(`\n=== ${step} concurrent (${pairs} pairs, ${pairs * 2} sockets) ===`);
  console.log(`  both-connected: ${connectOk}/${pairs}`);
  console.log(`  create-room ok: ${createOk}/${pairs}`);
  console.log(`  join-room ok:   ${joinOk}/${pairs}`);
  console.log(`  start-game ok:  ${startOk}/${pairs}`);
  console.log(`  game-action avg latency: ${avgLatency}ms, p95: ${p95}ms (${allLatencies.length} samples)`);
  if (sampleErrors.length) console.log(`  sample errors: ${JSON.stringify(sampleErrors)}`);
}

(async () => {
  console.log(`Load testing ${URL}`);
  console.log(`Steps: ${STEPS.join(' -> ')} concurrent sockets (each step = STEP/2 room pairs)\n`);
  for (const step of STEPS) {
    const pairs = Math.floor(step / 2);
    const t0 = Date.now();
    // Launch all pairs for this step concurrently.
    const results = await Promise.all(Array.from({ length: pairs }, (_, i) => runPair(i)));
    summarize(step, results);
    console.log(`  wall time: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    // Brief pause between steps so one step's cleanup doesn't bleed into the next's ramp.
    await new Promise(r => setTimeout(r, 3000));
  }
  console.log('\nDone. Cross-reference with `railway logs --service Malefiz` for the same window --');
  console.log('watch for memory pressure, restarts, or errors that these client-side numbers alone would miss.');
  process.exit(0);
})();
