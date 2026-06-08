const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingTimeout: 60000,
  pingInterval: 10000
});

app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ── Database ─────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
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

const JWT_SECRET = process.env.JWT_SECRET || 'malefiz-secret-key-change-in-prod';
const SALT_ROUNDS = 10;

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
app.post('/auth/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  if (username.length < 3 || username.length > 20) return res.status(400).json({ error: 'Username must be 3-20 characters' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
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

app.post('/auth/login', async (req, res) => {
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

function generateRoomCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// ── Rate limiting ─────────────────────────────────────────────────
const rateLimits = {};
const RATE_WINDOW_MS = 60 * 1000;
const MAX_ROOMS_PER_IP = 5;
const MAX_JOINS_PER_IP = 20;
const MAX_ACTIONS_PER_IP = 300;

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
const ROOM_MAX_AGE_MS = 30 * 60 * 1000;

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
    if (now - room.createdAt > ROOM_MAX_AGE_MS) {
      io.to(code).emit('room-expired', { message: 'Room closed after 30 minutes.' });
      delete rooms[code]; cleaned++;
    } else if (room.started && room.players.every(p => !p.connected) && now - (room.lastActivity || room.createdAt) > 5 * 60 * 1000) {
      delete rooms[code]; cleaned++;
    }
  }
  if (cleaned > 0) { console.log(`Cleaned ${cleaned} rooms`); broadcastLobby(); }
}, 5 * 60 * 1000);

io.on('connection', (socket) => {
  const ip = socket.handshake.headers['x-forwarded-for']?.split(',')[0]?.trim() || socket.handshake.address || 'unknown';

  socket.emit('lobby-update', { rooms: getRoomList(), online: io.engine.clientsCount });

  socket.on('create-room', ({ playerName, numPlayers, mode, isPublic }) => {
    if (!checkRate(ip, 'create', MAX_ROOMS_PER_IP)) { socket.emit('join-error', 'Too many rooms created. Please wait.'); return; }
    const code = generateRoomCode();
    const secret = Math.random().toString(36).substring(2, 12);
    const player = { id: socket.id, name: playerName, slot: 1, secret, connected: true };
    rooms[code] = { code, host: playerName, players: [player], numPlayers, mode, isPublic, started: false, createdAt: Date.now(), lastActivity: Date.now(), gameState: null, actionLog: [] };
    socket.join(code);
    socketRooms[socket.id] = code;
    socket.emit('room-created', { code, slot: 1, secret });
    broadcastLobby();
  });

  socket.on('join-room', ({ code, playerName }) => {
    if (!checkRate(ip, 'join', MAX_JOINS_PER_IP)) { socket.emit('join-error', 'Too many join attempts.'); return; }
    const room = rooms[code?.toUpperCase()];
    if (!room) { socket.emit('join-error', 'Room not found.'); return; }
    if (room.started) { socket.emit('join-error', 'Game already in progress.'); return; }
    if (room.players.length >= room.numPlayers) { socket.emit('join-error', 'Room is full.'); return; }
    const secret = Math.random().toString(36).substring(2, 12);
    const slot = room.players.length + 1;
    room.players.push({ id: socket.id, name: playerName, slot, secret, connected: true });
    room.lastActivity = Date.now();
    socket.join(code.toUpperCase());
    socketRooms[socket.id] = code.toUpperCase();
    socket.emit('room-joined', { code: code.toUpperCase(), slot, secret, players: room.players, mode: room.mode, numPlayers: room.numPlayers });
    io.to(code.toUpperCase()).emit('player-joined', { players: room.players });
    broadcastLobby();
    if (room.players.length === room.numPlayers) {
      room.started = true;
      broadcastLobby();
      setTimeout(() => io.to(code.toUpperCase()).emit('game-start', { players: room.players, mode: room.mode, numPlayers: room.numPlayers }), 1000);
    }
  });

  socket.on('reconnect-attempt', ({ code, secret }) => {
    const room = rooms[code];
    if (!room) { socket.emit('reconnect-failed', 'Room no longer exists.'); return; }
    const player = room.players.find(p => p.secret === secret);
    if (!player) { socket.emit('reconnect-failed', 'Could not verify identity.'); return; }
    player.id = socket.id;
    player.connected = true;
    room.lastActivity = Date.now();
    socket.join(code);
    socketRooms[socket.id] = code;
    socket.emit('reconnected', { slot: player.slot, players: room.players, gameState: room.gameState });
    socket.to(code).emit('player-reconnected', { slot: player.slot, name: player.name });
  });

  socket.on('request-state', ({ code, secret }) => {
    const room = rooms[code];
    if (!room) return;
    const player = room.players.find(p => p.secret === secret);
    if (!player) return;
    if (room.gameState) socket.emit('state-update', { gameState: room.gameState });
  });

  socket.on('game-action', (action) => {
    if (!checkRate(ip, 'action', MAX_ACTIONS_PER_IP)) return;
    const code = socketRooms[socket.id];
    if (!code || !rooms[code]) return;
    const room = rooms[code];
    room.lastActivity = Date.now();
    if (action.state) room.gameState = action.state;
    room.actionLog.push({ type: action.type, ts: Date.now() });
    if (room.actionLog.length > 200) room.actionLog.shift();
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
          setTimeout(() => {
            if (!player.connected && rooms[code]) {
              io.to(code).emit('player-left', { slot: player.slot, name: player.name });
              if (room.players.filter(p => p.connected).length === 0) delete rooms[code];
            }
          }, 60000);
        } else {
          room.players = room.players.filter(p => p.id !== socket.id);
          if (room.players.length === 0) delete rooms[code];
          else io.to(code).emit('player-joined', { players: room.players });
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

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Malefiz server on port ${PORT}`));
