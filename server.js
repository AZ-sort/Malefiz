const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const crypto = require('crypto');

const app = express();
// Railway sits in front of this app as a reverse proxy — without this,
// req.ip resolves to the proxy's address for every request, which would
// bucket all users worldwide into one rate-limit counter.
app.set('trust proxy', 1);
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingTimeout: 90000,      // tolerate longer network stalls before dropping
  pingInterval: 25000,     // fewer pings = less sensitive to brief hiccups
  connectionStateRecovery: {
    // Socket.io recovers session + missed events on brief drops (up to 2 min)
    maxDisconnectionDuration: 2 * 60 * 1000,
    skipMiddlewares: true
  }
});

app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});
// Baseline security headers for the API responses. CSP is skipped here —
// this origin only ever returns JSON, and the CSP that matters for the
// actual page (index.html, served from Vercel) lives in vercel.json instead.
app.use((req, res, next) => {
  res.header('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
  res.header('X-Content-Type-Options', 'nosniff');
  res.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});
// Block sensitive files before they ever reach express.static. This used to
// live inside static's setHeaders callback, calling res.status(403).end()
// after the response had already begun -- Express throws
// ERR_HTTP_HEADERS_SENT for that, uncaught, which killed the process on
// every single request for a blocked path (confirmed: GET /server.js took
// production down). Blocking here, before static even starts writing a
// response, avoids the double-send entirely.
app.use((req, res, next) => {
  if (/\.(js|json|env|md|lock)$/i.test(req.path) && !req.path.endsWith('socket.io.js')) {
    return res.status(403).send('Forbidden');
  }
  next();
});
// Only serve safe static assets — never .js/.env/source files
app.use(express.static(path.join(__dirname)));

// ── Database ─────────────────────────────────────────────────────
// TLS certificate verification is on. Confirmed against the real Railway
// Postgres instance: it presents a self-signed chain (no public CA), so
// PGSSLROOTCERT must be set to that CA's PEM in the deploy environment —
// without it, connections fail outright rather than silently degrading.
// Railway's proxy cert is also issued for CN=localhost regardless of the
// actual hostname you connect through, so hostname matching is skipped via
// checkServerIdentity while chain-of-trust verification (the part that
// actually stops a MITM without Railway's CA private key) still applies in
// full — equivalent to Postgres's sslmode=verify-ca.
const sslConfig = process.env.PGSSLROOTCERT
  ? { rejectUnauthorized: true, ca: process.env.PGSSLROOTCERT, checkServerIdentity: () => undefined }
  : { rejectUnauthorized: true };
if (!process.env.PGSSLROOTCERT) {
  console.warn('PGSSLROOTCERT is not set — DB connections will fail against a self-signed Postgres provider like Railway.');
}
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: sslConfig
});
// node-postgres docs: an error on an idle client with no 'error' listener
// crashes the process. Railway recycles idle DB connections, so this is a
// real (if unconfirmed-in-practice) exposure, not theoretical.
pool.on('error', (err) => {
  console.error('Postgres pool error (idle client):', err.message);
});

// Create users table if it doesn't exist
async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(30) UNIQUE NOT NULL,
        password_hash VARCHAR(100) NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    // Added for account-linked avatars, so a logged-in player's chosen
    // character follows them across devices instead of living only in
    // localStorage. IF NOT EXISTS keeps this idempotent against the
    // existing table on every boot, same pattern as CREATE TABLE above.
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar VARCHAR(24)`);
    // Server-side growth funnel (Phase 0 Layer 2). Client-side analytics
    // (Vercel Web Analytics) can say how many people visited; it can't say
    // how many actually played, because a bounce never opens a socket. This
    // table is the only layer that can answer that, from events server.js
    // already sees at each of the four handlers below.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS funnel_events (
        id SERIAL PRIMARY KEY,
        event_type VARCHAR(20) NOT NULL,
        room_code VARCHAR(10),
        num_players INTEGER,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('Database ready');
  } catch(e) {
    console.error('DB init error:', e.message);
  }
}
initDB();

// Fire-and-forget funnel logging. Deliberately never awaited or thrown from
// a socket handler -- a logging failure must never take the backend down,
// per the uncaughtException/pool.on('error') backstops elsewhere in this
// file. num_players is optional context (e.g. seated count at game-start).
function logEvent(eventType, roomCode, numPlayers) {
  pool.query(
    'INSERT INTO funnel_events (event_type, room_code, num_players) VALUES ($1, $2, $3)',
    [eventType, roomCode || null, numPlayers ?? null]
  ).catch(e => console.error('funnel_events insert failed:', e.message));
}

if (!process.env.JWT_SECRET && process.env.NODE_ENV === 'production') {
  console.error('FATAL: JWT_SECRET is not set. Refusing to start with a guessable fallback secret in production.');
  process.exit(1);
}
if (!process.env.JWT_SECRET) {
  console.warn('JWT_SECRET is not set — using an ephemeral development secret. Set JWT_SECRET before deploying.');
}
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
const SALT_ROUNDS = 10;

// Rate-limit constants for the two HTTP auth routes. `checkRate()` (defined
// further below, alongside the socket rate limits it also serves) is a
// hoisted function declaration so calling it from these routes is safe even
// though it's defined later in the file — only these two constants need to
// live above their first use, since they're evaluated at route-registration
// time, not request time.
const MAX_LOGINS_PER_IP = 10;    // per 60s window
const MAX_REGISTERS_PER_IP = 5;  // per 60s window

// ── Auth middleware ───────────────────────────────────────────────
function verifyToken(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch(e) {
    res.status(401).json({ error: 'Invalid token' });
  }
}

// ── Auth routes ───────────────────────────────────────────────────
function authRateLimit(type, limit) {
  return (req, res, next) => {
    if (!checkRate(req.ip, type, limit)) {
      return res.status(429).json({ error: 'Too many attempts. Please wait and try again.' });
    }
    next();
  };
}

app.post('/auth/register', authRateLimit('register', MAX_REGISTERS_PER_IP), async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  if (username.length < 3 || username.length > 20) return res.status(400).json({ error: 'Username must be 3-20 characters' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  if (!/^[a-zA-Z0-9_]+$/.test(username)) return res.status(400).json({ error: 'Username can only contain letters, numbers and underscores' });
  try {
    const existing = await pool.query('SELECT id FROM users WHERE LOWER(username) = LOWER($1)', [username]);
    if (existing.rows.length > 0) return res.status(400).json({ error: 'Username already taken' });
    const hash = await bcrypt.hash(password, SALT_ROUNDS);
    const result = await pool.query(
      'INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id, username',
      [username, hash]
    );
    const user = result.rows[0];
    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, username: user.username, avatar: null });
  } catch(e) {
    console.error('Register error:', e.message);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/auth/login', authRateLimit('login', MAX_LOGINS_PER_IP), async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  try {
    const result = await pool.query('SELECT * FROM users WHERE LOWER(username) = LOWER($1)', [username]);
    if (result.rows.length === 0) return res.status(400).json({ error: 'Invalid username or password' });
    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(400).json({ error: 'Invalid username or password' });
    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, username: user.username, avatar: user.avatar || null });
  } catch(e) {
    console.error('Login error:', e.message);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/auth/me', verifyToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT avatar FROM users WHERE id = $1', [req.user.id]);
    res.json({ username: req.user.username, avatar: result.rows[0]?.avatar || null });
  } catch(e) {
    console.error('/auth/me error:', e.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// Save the account-linked avatar. Reuses cleanIcon's charset+length
// allowlist (defined below, alongside its socket-side sibling) since this
// value flows through the exact same `href="#${id}"` interpolation client-
// side. Rate-limited on the existing 'register' bucket rather than a new
// one -- an authenticated route already needs a valid JWT, so abuse
// potential here is much lower than the unauthenticated auth routes it
// shares a limiter family with.
app.put('/auth/avatar', verifyToken, authRateLimit('avatar', MAX_REGISTERS_PER_IP), async (req, res) => {
  const avatar = cleanIcon(req.body?.avatar);
  if (!avatar) return res.status(400).json({ error: 'Invalid avatar' });
  try {
    await pool.query('UPDATE users SET avatar = $1 WHERE id = $2', [avatar, req.user.id]);
    res.json({ avatar });
  } catch(e) {
    console.error('/auth/avatar error:', e.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Name generation (fallback for guests) ────────────────────────
const ADJECTIVES = ['Swift','Brave','Mighty','Shadow','Crimson','Golden','Silver','Iron','Wild','Frost','Storm','Thunder','Blazing','Silent','Cosmic','Neon','Phantom','Rogue','Savage','Stealth'];
const NOUNS = ['Fox','Wolf','Eagle','Tiger','Dragon','Falcon','Viper','Panda','Cobra','Hawk','Bear','Lynx','Raven','Shark','Panther','Jaguar','Manta','Raptor','Phoenix','Bison'];


// ── Input sanitization ────────────────────────────────────────────
function cleanName(name) {
  if (typeof name !== 'string') return 'Player';
  // Strip angle brackets/quotes to prevent stored XSS in clients, cap length
  const cleaned = name.replace(/[<>"'`]/g, '').trim().slice(0, 20);
  return cleaned.length >= 1 ? cleaned : 'Player';
}
function validNumPlayers(n) {
  const v = parseInt(n, 10);
  return (v >= 2 && v <= 4) ? v : 2;
}
// Avatar ids are sprite-symbol references (e.g. "avatar-fox"), interpolated
// client-side into `href="#${id}"` -- so this is a hard allowlist-shaped
// boundary, not just a length cap. The 8-char slice this replaces silently
// truncated more than half the shipped marking ids (mark-diamond,
// mark-cross, mark-moon, mark-bolt, mark-ring all exceed 8 chars), which
// broke the truncated id's <use> reference on every OTHER client in the
// room. A charset+length regex avoids duplicating the client's icon
// catalogue here (which would drift), while still rejecting anything that
// isn't a plausible symbol id.
function cleanIcon(icon) {
  if (typeof icon !== 'string') return '';
  return /^[a-z0-9_-]{1,24}$/.test(icon) ? icon : '';
}

// Colors are claimed independently of seat (slot) -- see 'claim-color'
// below. Assigns the lowest 1-4 not already held by another connected/
// pending player in the room, honoring `preferred` if it's free.
function assignColor(room, preferred) {
  const taken = new Set(room.players.filter(p => !p.departed).map(p => p.color));
  if (preferred >= 1 && preferred <= 4 && !taken.has(preferred)) return preferred;
  for (let c = 1; c <= 4; c++) if (!taken.has(c)) return c;
  return 1; // unreachable in practice (rooms cap at 4 players) but never leave color undefined
}

// Strip reconnect secrets before a players array is broadcast to a room —
// `secret` is a credential and must only ever be sent to the player it belongs to.
// Also stamps isHost so clients can gate host-only UI without the server
// exposing hostId (a raw socket id) directly.
function publicPlayers(players, hostId) {
  return players.map(({ secret, ...rest }) => ({ ...rest, isHost: rest.id === hostId }));
}

// Room-code alphabet excludes visually ambiguous characters (0/O, 1/I) since
// codes are read aloud and typed by hand.
const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateRoomCode() {
  let code;
  let attempts = 0;
  do {
    const bytes = crypto.randomBytes(6);
    code = Array.from(bytes, b => ROOM_CODE_ALPHABET[b % ROOM_CODE_ALPHABET.length]).join('');
    attempts++;
  } while (rooms[code] && attempts < 20);
  return code;
}

// Reconnect secret: a CSPRNG credential, not just an unguessable-looking string.
function generateSecret() {
  return crypto.randomBytes(32).toString('hex');
}

// ── Rate limiting ─────────────────────────────────────────────────
const rateLimits = {};
const RATE_WINDOW_MS = 60 * 1000;
// Overridable via env for load-test windows only — e.g. `railway variables --set
// MAX_ACTIONS_PER_IP=3000` before a ramp, then `--set MAX_ACTIONS_PER_IP=` (or the
// dashboard's delete) to restore the default afterward. Defaults are unchanged from
// before this override existed; a bad/missing env value falls back to the default,
// it never silently disables the limit (Number('') and Number(undefined) are NaN,
// and NaN || default evaluates to default).
const MAX_ROOMS_PER_IP = Number(process.env.MAX_ROOMS_PER_IP) || 5;
const MAX_JOINS_PER_IP = Number(process.env.MAX_JOINS_PER_IP) || 20;
const MAX_ACTIONS_PER_IP = Number(process.env.MAX_ACTIONS_PER_IP) || 300;
const MAX_SETTINGS_PER_IP = Number(process.env.MAX_SETTINGS_PER_IP) || 30;

// Settings a host is allowed to send via update-room-settings — whitelisted
// rather than relayed raw, since (unlike at create time) this value is now
// mutable and re-broadcast to every player in the room.
const VALID_MODES = ['classic', 'classic-powerups', 'duel', 'duel-powerups'];

function checkRate(ip, type, limit) {
  const key = `${ip}:${type}`;
  const now = Date.now();
  if (!rateLimits[key]) rateLimits[key] = { count: 0, resetAt: now + RATE_WINDOW_MS };
  if (now > rateLimits[key].resetAt) rateLimits[key] = { count: 0, resetAt: now + RATE_WINDOW_MS };
  rateLimits[key].count++;
  return rateLimits[key].count <= limit;
}

setInterval(() => {
  const now = Date.now();
  for (const key of Object.keys(rateLimits)) {
    if (now > rateLimits[key].resetAt) delete rateLimits[key];
  }
}, 5 * 60 * 1000);

// ── Room storage ──────────────────────────────────────────────────
const rooms = {};
const socketRooms = {};
const ROOM_MAX_AGE_MS = 3 * 60 * 60 * 1000; // 3 hours

// Safe lookup for client-supplied room codes. A plain rooms[code] is
// exploitable: rooms['__proto__'] resolves to Object.prototype, which is
// truthy, so a naive `if (!room)` guard passes and the next
// room.players.find(...) throws on undefined -- confirmed to kill the
// process. hasOwnProperty rules that out, and normalizing case here
// (rather than relying on each call site to remember .toUpperCase())
// means a lowercase code from a client can still reconnect.
function getRoom(code) {
  if (typeof code !== 'string') return null;
  const upper = code.toUpperCase();
  return Object.prototype.hasOwnProperty.call(rooms, upper) ? rooms[upper] : null;
}

function getRoomList() {
  return Object.values(rooms)
    .filter(r => r.isPublic && !r.started && r.players.length < r.numPlayers)
    .map(r => ({ code: r.code, host: r.host, players: r.players.length, numPlayers: r.numPlayers, mode: r.mode }));
}

function broadcastLobby() {
  const lobbyData = { rooms: getRoomList(), online: io.engine.clientsCount };
  io.emit('lobby-update', lobbyData);
}

// Auto-cleanup
setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  for (const [code, room] of Object.entries(rooms)) {
    // "3 hours of inactivity" should mean inactivity, not age — measure from
    // lastActivity (refreshed on every game-action) so a long-running live
    // game isn't reaped mid-play.
    if (now - (room.lastActivity || room.createdAt) > ROOM_MAX_AGE_MS) {
      io.to(code).emit('room-expired', { message: 'Room closed after 3 hours of inactivity.' });
      delete rooms[code]; cleaned++;
    } else if (room.started && room.players.every(p => !p.connected) && now - (room.lastActivity || room.createdAt) > 5 * 60 * 1000) {
      // `departed` (below) is only ever set while a player is already
      // disconnected, and is cleared the instant they reconnect — so it's
      // always a subset of !connected and doesn't need checking separately
      // here; "every player disconnected" already covers departed players.
      delete rooms[code]; cleaned++;
    }
  }
  if (cleaned > 0) { console.log(`Cleaned ${cleaned} rooms`); broadcastLobby(); }
}, 5 * 60 * 1000);

io.on('connection', (socket) => {
  // Hardening, not a fix for a confirmed live bypass -- checked both ways.
  // In general, XFF entries are appended by each proxy hop, so the LEFTMOST
  // entry is whatever the connecting client claimed, and a raw socket
  // handshake (unlike the HTTP routes above, which already get this right
  // via Express's own `trust proxy` handling for req.ip) lets any client
  // set that header. Taking [0] would trust client-controlled input for
  // every socket rate limit below (create/join/settings/action).
  // Reproduced against production first, per this project's standard: 8
  // create-room calls with a distinct forged leading XFF value each,
  // against the currently-deployed (pre-this-fix) backend. Only 5 of 8
  // succeeded -- the real limit -- so Railway's edge is evidently already
  // overwriting or stripping inbound client-supplied XFF rather than
  // appending to it, and the bypass does not reproduce live. Switching to
  // .pop() (the hop closest to this process, matching trust-proxy-1
  // semantics) is still strictly more correct and costs nothing if that
  // assumption about Railway's edge ever changes.
  const ip = socket.handshake.headers['x-forwarded-for']?.split(',').pop()?.trim() || socket.handshake.address || 'unknown';

  socket.emit('lobby-update', { rooms: getRoomList(), online: io.engine.clientsCount });

  socket.on('create-room', ({ playerName, numPlayers, mode, isPublic, pawnIcon, avatar, color } = {}) => {
    if (!checkRate(ip, 'create', MAX_ROOMS_PER_IP)) { socket.emit('join-error', 'Too many rooms created. Please wait.'); return; }
    const name = cleanName(playerName);
    // mode used to be echoed back only, so any value was harmless. PR #18
    // made it load-bearing (room.mode.startsWith('duel') in
    // update-room-settings below), so an unwhitelisted mode -- null,
    // a number, an object -- now throws there. Whitelist at creation too,
    // not just on update.
    const roomMode = VALID_MODES.includes(mode) ? mode : 'classic';
    // Duel is a 2-player board (BOARDS.duel in the client has only 2 entry
    // points) -- couple the cap to the mode here too, not just on
    // update-room-settings, so create-room can't hand back a duel room
    // with a 3-4 seat cap that join-room would then happily fill.
    const np = roomMode.startsWith('duel') ? 2 : validNumPlayers(numPlayers);
    const code = generateRoomCode();
    const secret = generateSecret();
    // Wire-compat during the deploy window between this server change and its
    // matching frontend change: an older client still sends `pawnIcon`, a
    // newer one sends `avatar` -- accept either, and write both keys so
    // either client version can read the field back out of the roster.
    const iconValue = cleanIcon(avatar ?? pawnIcon);
    const player = { id: socket.id, name, slot: 1, secret, connected: true, pawnIcon: iconValue, avatar: iconValue, color: assignColor({ players: [] }, parseInt(color, 10)) };
    rooms[code] = { code, host: name, hostId: socket.id, players: [player], numPlayers: np, mode: roomMode, isPublic: !!isPublic, started: false, createdAt: Date.now(), lastActivity: Date.now(), gameState: null, actionLog: [] };
    socket.join(code);
    socketRooms[socket.id] = code;
    socket.emit('room-created', { code, slot: 1, secret });
    broadcastLobby();
    logEvent('room_created', code);
  });

  socket.on('join-room', ({ code, playerName, pawnIcon, avatar, color } = {}) => {
    if (!checkRate(ip, 'join', MAX_JOINS_PER_IP)) { socket.emit('join-error', 'Too many join attempts.'); return; }
    const room = getRoom(code);
    if (!room) { socket.emit('join-error', 'Room not found.'); return; }
    if (room.started) { socket.emit('join-error', 'Game already in progress.'); return; }
    if (room.players.length >= room.numPlayers) { socket.emit('join-error', 'Room is full.'); return; }
    const secret = generateSecret();
    const slot = room.players.length + 1;
    const iconValue = cleanIcon(avatar ?? pawnIcon);
    room.players.push({ id: socket.id, name: cleanName(playerName), slot, secret, connected: true, pawnIcon: iconValue, avatar: iconValue, color: assignColor(room, parseInt(color, 10)) });
    room.lastActivity = Date.now();
    socket.join(code.toUpperCase());
    socketRooms[socket.id] = code.toUpperCase();
    socket.emit('room-joined', { code: code.toUpperCase(), slot, secret, players: publicPlayers(room.players, room.hostId), mode: room.mode, numPlayers: room.numPlayers, isPublic: room.isPublic });
    io.to(code.toUpperCase()).emit('player-joined', { players: publicPlayers(room.players, room.hostId), mode: room.mode, numPlayers: room.numPlayers, isPublic: room.isPublic });
    broadcastLobby();
    // Funnel milestone: the room stopped being a solo host waiting alone.
    // Gated on ===2 (not >=2) so a 3rd/4th joiner into a larger room, or a
    // re-join after a pre-start departure brings the room back through 2,
    // doesn't double-log the same milestone for the same room.
    if (room.players.length === 2) logEvent('second_player_joined', room.code);
    // Games no longer auto-start on fill — the host starts explicitly via
    // 'start-game' (below), watching players arrive Gartic-Phone style and
    // adjusting settings first. numPlayers is now a cap, not a target.
  });

  // Any seated player (not host-only): claim one of the 4 palette colors,
  // independent of seat/slot -- lets a player in slot 3 render as blue, say.
  // Only valid pre-start; rejects silently (no join-error) on any invalid
  // request since this is a cosmetic action a stale/racing UI can easily
  // retry, not a flow a player needs an error surfaced for.
  socket.on('claim-color', ({ color } = {}) => {
    if (!checkRate(ip, 'settings', MAX_SETTINGS_PER_IP)) return;
    const code = socketRooms[socket.id];
    const room = code && rooms[code];
    if (!room || room.started) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;
    const c = parseInt(color, 10);
    if (!(c >= 1 && c <= 4)) return;
    const heldBy = room.players.find(p => !p.departed && p.id !== socket.id && p.color === c);
    if (heldBy) return;
    player.color = c;
    room.lastActivity = Date.now();
    io.to(code).emit('player-joined', { players: publicPlayers(room.players, room.hostId), mode: room.mode, numPlayers: room.numPlayers, isPublic: room.isPublic });
  });

  // Host-only: change mode/powerups/max-players/public-private while the
  // room is still in its waiting lobby. Broadcast on the same 'player-joined'
  // event the roster already uses, so the client has one settings-sync path
  // instead of two.
  socket.on('update-room-settings', ({ mode, numPlayers, isPublic } = {}) => {
    if (!checkRate(ip, 'settings', MAX_SETTINGS_PER_IP)) return;
    const code = socketRooms[socket.id];
    const room = code && rooms[code];
    if (!room || room.started || socket.id !== room.hostId) return;
    // Validate the mode BEFORE committing it. Duel's board (client-side
    // BOARDS.duel) only has 2 entry points -- switching to duel with 3-4
    // already seated used to silently leave room.numPlayers unchanged
    // (the seat guard below is a "never shrink below seated" no-op, not a
    // clamp) while room.mode was already duel, orphaning players 3/4 with
    // no pawns, no turn, and no error. Reject the switch instead.
    const nextMode = VALID_MODES.includes(mode) ? mode : room.mode;
    const maxForMode = nextMode.startsWith('duel') ? 2 : 4;
    if (room.players.length > maxForMode) {
      socket.emit('join-error', `Duel supports 2 players. Remove ${room.players.length - maxForMode} to switch.`);
      return;
    }
    room.mode = nextMode;
    const isDuel = room.mode.startsWith('duel');
    let np = validNumPlayers(numPlayers);
    if (isDuel) np = 2;
    // Never shrink the cap below players already seated.
    if (np >= room.players.length) room.numPlayers = np;
    if (typeof isPublic === 'boolean') room.isPublic = isPublic;
    room.lastActivity = Date.now();
    io.to(code).emit('player-joined', { players: publicPlayers(room.players, room.hostId), mode: room.mode, numPlayers: room.numPlayers, isPublic: room.isPublic });
    broadcastLobby();
  });

  // Host-only: start the game early instead of waiting for the room to fill.
  socket.on('start-game', () => {
    const code = socketRooms[socket.id];
    const room = code && rooms[code];
    if (!room || room.started || socket.id !== room.hostId) return;
    if (room.players.length < 2) return;
    // Defence in depth: update-room-settings/create-room now reject a
    // mode/seat-count mismatch at the source, but a forged emit could
    // still reach here with room.mode and room.players.length desynced.
    const maxForMode = room.mode.startsWith('duel') ? 2 : 4;
    if (room.players.length > maxForMode) {
      socket.emit('join-error', 'Too many players for this game mode.');
      return;
    }
    room.started = true;
    room.lastActivity = Date.now();
    // Emit the actual seated count, not the lobby cap (room.numPlayers) --
    // a 4-cap room started with only 3 seated used to make every client
    // create a 4th pawn set for nobody, which turn rotation would then
    // stall on forever. Slots are contiguous 1..players.length: the
    // pre-start disconnect handler reindexes on removal (see 'disconnect'
    // below), so this is always the true seat count, not just the cap.
    io.to(code).emit('game-start', { players: publicPlayers(room.players, room.hostId), mode: room.mode, numPlayers: room.players.length });
    broadcastLobby();
    logEvent('game_started', code, room.players.length);
  });

  socket.on('reconnect-attempt', ({ code, secret } = {}) => {
    const room = getRoom(code);
    if (!room) { socket.emit('reconnect-failed', 'Room no longer exists.'); return; }
    const player = room.players.find(p => p.secret === secret);
    if (!player) { socket.emit('reconnect-failed', 'Could not verify identity.'); return; }
    player.id = socket.id;
    player.connected = true;
    player.departed = false;
    room.lastActivity = Date.now();
    // Use room.code (the canonical, already-uppercased key), not the raw
    // client-supplied code -- getRoom() normalizes case for lookup but a
    // client can still send lowercase, and joining a socket.io room keyed
    // by the wrong case would desync it from rooms[room.code].
    socket.join(room.code);
    socketRooms[socket.id] = room.code;
    socket.emit('reconnected', { slot: player.slot, players: publicPlayers(room.players, room.hostId), gameState: room.gameState, mode: room.mode, numPlayers: room.numPlayers, isPublic: room.isPublic });
    socket.to(room.code).emit('player-reconnected', { slot: player.slot, name: player.name });
  });

  socket.on('request-state', ({ code, secret } = {}) => {
    const room = getRoom(code);
    if (!room) return;
    const player = room.players.find(p => p.secret === secret);
    if (!player) return;
    if (room.gameState) socket.emit('state-update', { gameState: room.gameState });
  });

  socket.on('game-action', (action = {}) => {
    if (!checkRate(ip, 'action', MAX_ACTIONS_PER_IP)) return;
    const code = socketRooms[socket.id];
    if (!code || !rooms[code]) return;
    const room = rooms[code];
    room.lastActivity = Date.now();
    if (action.state) {
      // Cap serialized state size (~200KB) to prevent memory abuse
      const size = JSON.stringify(action.state).length;
      if (size < 200000) room.gameState = action.state;
    }
    room.actionLog.push({ type: action.type, ts: Date.now() });
    if (room.actionLog.length > 200) room.actionLog.shift();
    // Funnel milestone: the client already emits syncAction('game-over', ...)
    // on a real win, and game-action already relays every action type here,
    // so this needs no client change -- just reading a signal that already
    // exists. actionLog (above) would also show this, but isn't queryable
    // in SQL and isn't retained once a room is cleaned up.
    if (action.type === 'game-over') logEvent('game_finished', code);
    if (action.type === 'chat' && action.data) {
      // Never trust a client-supplied chat name — stamp the sender's own
      // server-sanitized name to prevent stored XSS and name spoofing.
      const sender = room.players.find(p => p.id === socket.id);
      action = { ...action, data: { ...action.data, name: sender ? sender.name : 'Player' } };
    }
    socket.to(code).emit('game-action', action);
  });

  socket.on('disconnect', () => {
    const code = socketRooms[socket.id];
    if (code && rooms[code]) {
      const room = rooms[code];
      const player = room.players.find(p => p.id === socket.id);
      if (player) {
        player.connected = false;
        if (room.started) {
          io.to(code).emit('player-disconnected', { slot: player.slot, name: player.name });
          // Capture this socket's id so a disconnect->reconnect->disconnect
          // sequence inside the 60s window doesn't let the *first*
          // disconnect's stale timer mark the player departed early — only
          // the timer belonging to the player's current (still-connected-at-
          // schedule-time) socket should ever fire.
          const disconnectedSocketId = socket.id;
          setTimeout(() => {
            if (rooms[code] && player.id === disconnectedSocketId && !player.connected) {
              player.departed = true;
              io.to(code).emit('player-left', { slot: player.slot, name: player.name });
              if (room.players.every(p => !p.connected)) delete rooms[code];
            }
          }, 60000);
        } else {
          const wasHost = socket.id === room.hostId;
          room.players = room.players.filter(p => p.id !== socket.id);
          if (room.players.length === 0) {
            delete rooms[code];
          } else {
            // Reindex to contiguous slots 1..N. Pre-start, there's no
            // reconnect-to-your-slot expectation (that only applies once
            // room.started, via the secret-keyed 60s grace window above),
            // so it's safe to renumber -- and necessary, since start-game
            // now sends room.players.length as the seat count and relies
            // on slots being contiguous 1..length.
            room.players.forEach((p, i) => { p.slot = i + 1; });
            // Promote the next remaining player if the host just left —
            // the room otherwise has no one who can start it or change settings.
            if (wasHost) room.hostId = room.players[0].id;
            io.to(code).emit('player-joined', { players: publicPlayers(room.players, room.hostId), mode: room.mode, numPlayers: room.numPlayers, isPublic: room.isPublic });
          }
          broadcastLobby();
        }
      }
    }
    delete socketRooms[socket.id];
  });

  socket.on('get-lobby', () => {
    socket.emit('lobby-update', { rooms: getRoomList(), online: io.engine.clientsCount });
  });
});

// Backstop, not a substitute for fixing the specific crash vectors above --
// this exists so an unforeseen throw logs and gets a chance to be diagnosed
// instead of silently killing the process the same way the confirmed bugs
// above did. Deliberately does not call process.exit(): the alternative,
// letting Node's default handler kill the process, is exactly the failure
// mode this file already had four live examples of.
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception (process kept alive):', err);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Malefiz server on port ${PORT}`));