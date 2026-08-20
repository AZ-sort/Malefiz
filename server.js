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
    console.log('Database ready');
  } catch(e) {
    console.error('DB init error:', e.message);
  }
}
initDB();

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
    res.json({ token, username: user.username });
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
    res.json({ token, username: user.username });
  } catch(e) {
    console.error('Login error:', e.message);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/auth/me', verifyToken, (req, res) => {
  res.json({ username: req.user.username });
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
function cleanIcon(icon) {
  if (typeof icon !== 'string') return '';
  // Same sanitization approach as cleanName() for consistency, even though
  // the 8-char cap alone makes this low-impact in practice.
  return icon.replace(/[<>"'`]/g, '').slice(0, 8);
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
const MAX_ROOMS_PER_IP = 5;
const MAX_JOINS_PER_IP = 20;
const MAX_ACTIONS_PER_IP = 300;
const MAX_SETTINGS_PER_IP = 30;

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
  const ip = socket.handshake.headers['x-forwarded-for']?.split(',')[0]?.trim() || socket.handshake.address || 'unknown';

  socket.emit('lobby-update', { rooms: getRoomList(), online: io.engine.clientsCount });

  socket.on('create-room', ({ playerName, numPlayers, mode, isPublic, pawnIcon } = {}) => {
    if (!checkRate(ip, 'create', MAX_ROOMS_PER_IP)) { socket.emit('join-error', 'Too many rooms created. Please wait.'); return; }
    const name = cleanName(playerName);
    const np = validNumPlayers(numPlayers);
    // mode used to be echoed back only, so any value was harmless. PR #18
    // made it load-bearing (room.mode.startsWith('duel') in
    // update-room-settings below), so an unwhitelisted mode -- null,
    // a number, an object -- now throws there. Whitelist at creation too,
    // not just on update.
    const roomMode = VALID_MODES.includes(mode) ? mode : 'classic';
    const code = generateRoomCode();
    const secret = generateSecret();
    const player = { id: socket.id, name, slot: 1, secret, connected: true, pawnIcon: cleanIcon(pawnIcon) };
    rooms[code] = { code, host: name, hostId: socket.id, players: [player], numPlayers: np, mode: roomMode, isPublic: !!isPublic, started: false, createdAt: Date.now(), lastActivity: Date.now(), gameState: null, actionLog: [] };
    socket.join(code);
    socketRooms[socket.id] = code;
    socket.emit('room-created', { code, slot: 1, secret });
    broadcastLobby();
  });

  socket.on('join-room', ({ code, playerName, pawnIcon } = {}) => {
    if (!checkRate(ip, 'join', MAX_JOINS_PER_IP)) { socket.emit('join-error', 'Too many join attempts.'); return; }
    const room = getRoom(code);
    if (!room) { socket.emit('join-error', 'Room not found.'); return; }
    if (room.started) { socket.emit('join-error', 'Game already in progress.'); return; }
    if (room.players.length >= room.numPlayers) { socket.emit('join-error', 'Room is full.'); return; }
    const secret = generateSecret();
    const slot = room.players.length + 1;
    room.players.push({ id: socket.id, name: cleanName(playerName), slot, secret, connected: true, pawnIcon: cleanIcon(pawnIcon) });
    room.lastActivity = Date.now();
    socket.join(code.toUpperCase());
    socketRooms[socket.id] = code.toUpperCase();
    socket.emit('room-joined', { code: code.toUpperCase(), slot, secret, players: publicPlayers(room.players, room.hostId), mode: room.mode, numPlayers: room.numPlayers, isPublic: room.isPublic });
    io.to(code.toUpperCase()).emit('player-joined', { players: publicPlayers(room.players, room.hostId), mode: room.mode, numPlayers: room.numPlayers, isPublic: room.isPublic });
    broadcastLobby();
    // Games no longer auto-start on fill — the host starts explicitly via
    // 'start-game' (below), watching players arrive Gartic-Phone style and
    // adjusting settings first. numPlayers is now a cap, not a target.
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
    if (VALID_MODES.includes(mode)) room.mode = mode;
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
    room.started = true;
    room.lastActivity = Date.now();
    io.to(code).emit('game-start', { players: publicPlayers(room.players, room.hostId), mode: room.mode, numPlayers: room.numPlayers });
    broadcastLobby();
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