const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingTimeout: 60000,
  pingInterval: 10000
});

app.use(express.static(path.join(__dirname)));

// ── Name generation ──────────────────────────────────────────────
const ADJECTIVES = ['Swift','Brave','Mighty','Shadow','Crimson','Golden','Silver','Iron','Wild','Frost','Storm','Thunder','Blazing','Silent','Cosmic','Neon','Phantom','Rogue','Savage','Stealth'];
const NOUNS = ['Fox','Wolf','Eagle','Tiger','Dragon','Falcon','Viper','Panda','Cobra','Hawk','Bear','Lynx','Raven','Shark','Panther','Jaguar','Manta','Raptor','Phoenix','Bison'];

function generateRoomCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// ── Rate limiting ────────────────────────────────────────────────
// Track requests per IP to prevent abuse
const rateLimits = {};
const RATE_WINDOW_MS = 60 * 1000;   // 1 minute window
const MAX_ROOMS_PER_IP = 5;          // max 5 room creations per minute per IP
const MAX_JOINS_PER_IP = 20;         // max 20 join attempts per minute per IP
const MAX_ACTIONS_PER_IP = 300;      // max 300 game actions per minute per IP

function getRateKey(ip, type) { return `${ip}:${type}`; }

function checkRate(ip, type, limit) {
  const key = getRateKey(ip, type);
  const now = Date.now();
  if (!rateLimits[key]) rateLimits[key] = { count: 0, resetAt: now + RATE_WINDOW_MS };
  if (now > rateLimits[key].resetAt) {
    rateLimits[key] = { count: 0, resetAt: now + RATE_WINDOW_MS };
  }
  rateLimits[key].count++;
  return rateLimits[key].count <= limit;
}

// Clean up rate limit entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const key of Object.keys(rateLimits)) {
    if (now > rateLimits[key].resetAt) delete rateLimits[key];
  }
}, 5 * 60 * 1000);

// ── Room storage ─────────────────────────────────────────────────
const rooms = {};
const socketRooms = {};
const ROOM_MAX_AGE_MS = 30 * 60 * 1000; // 30 minutes

function getRoomList() {
  return Object.values(rooms)
    .filter(r => r.isPublic && !r.started && r.players.length < r.numPlayers)
    .map(r => ({
      code: r.code,
      host: r.host,
      players: r.players.length,
      numPlayers: r.numPlayers,
      mode: r.mode,
    }));
}

function broadcastLobby() {
  const lobbyData = { rooms: getRoomList(), online: io.engine.clientsCount };
  io.emit('lobby-update', lobbyData);
}

// ── Auto-cleanup: delete stale rooms every 5 minutes ────────────
setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  for (const [code, room] of Object.entries(rooms)) {
    const age = now - room.createdAt;
    // Delete if older than 30 minutes
    if (age > ROOM_MAX_AGE_MS) {
      io.to(code).emit('room-expired', { message: 'Room closed — session expired after 30 minutes.' });
      delete rooms[code];
      cleaned++;
      continue;
    }
    // Also delete started games where everyone has disconnected for >5 minutes
    if (room.started) {
      const allGone = room.players.every(p => !p.connected);
      const lastActivity = now - (room.lastActivity || room.createdAt);
      if (allGone && lastActivity > 5 * 60 * 1000) {
        delete rooms[code];
        cleaned++;
      }
    }
  }
  if (cleaned > 0) {
    console.log(`Cleaned up ${cleaned} stale room(s). Active rooms: ${Object.keys(rooms).length}`);
    broadcastLobby();
  }
}, 5 * 60 * 1000);

io.on('connection', (socket) => {
  const ip = socket.handshake.headers['x-forwarded-for']?.split(',')[0]?.trim()
            || socket.handshake.address
            || 'unknown';
  console.log(`Connected: ${socket.id} (${ip})`);

  socket.emit('lobby-update', { rooms: getRoomList(), online: io.engine.clientsCount });

  // ── Create room ────────────────────────────────────────────────
  socket.on('create-room', ({ playerName, numPlayers, mode, isPublic }) => {
    // Rate limit: max 5 rooms per IP per minute
    if (!checkRate(ip, 'create', MAX_ROOMS_PER_IP)) {
      socket.emit('join-error', 'Too many rooms created. Please wait a minute.');
      return;
    }
    const code = generateRoomCode();
    const secret = Math.random().toString(36).substring(2, 12);
    const player = { id: socket.id, name: playerName, slot: 1, secret, connected: true };
    rooms[code] = {
      code,
      host: playerName,
      players: [player],
      numPlayers,
      mode,
      isPublic,
      started: false,
      createdAt: Date.now(),
      lastActivity: Date.now(),
      gameState: null,
      actionLog: []
    };
    socket.join(code);
    socketRooms[socket.id] = code;
    socket.emit('room-created', { code, slot: 1, secret });
    broadcastLobby();
    console.log(`Room ${code} created by ${playerName} (${ip})`);
  });

  // ── Join room ──────────────────────────────────────────────────
  socket.on('join-room', ({ code, playerName }) => {
    // Rate limit: max 20 join attempts per IP per minute
    if (!checkRate(ip, 'join', MAX_JOINS_PER_IP)) {
      socket.emit('join-error', 'Too many join attempts. Please wait a moment.');
      return;
    }
    const room = rooms[code?.toUpperCase()];
    if (!room) { socket.emit('join-error', 'Room not found. Check the code and try again.'); return; }
    if (room.started) { socket.emit('join-error', 'Game already in progress.'); return; }
    if (room.players.length >= room.numPlayers) { socket.emit('join-error', 'Room is full.'); return; }

    const secret = Math.random().toString(36).substring(2, 12);
    const slot = room.players.length + 1;
    const player = { id: socket.id, name: playerName, slot, secret, connected: true };
    room.players.push(player);
    room.lastActivity = Date.now();
    socket.join(code.toUpperCase());
    socketRooms[socket.id] = code.toUpperCase();
    socket.emit('room-joined', { code: code.toUpperCase(), slot, secret, players: room.players, mode: room.mode, numPlayers: room.numPlayers });
    io.to(code.toUpperCase()).emit('player-joined', { players: room.players });
    broadcastLobby();

    if (room.players.length === room.numPlayers) {
      room.started = true;
      broadcastLobby();
      setTimeout(() => {
        io.to(code.toUpperCase()).emit('game-start', {
          players: room.players,
          mode: room.mode,
          numPlayers: room.numPlayers
        });
      }, 1000);
    }
  });

  // ── Reconnect ──────────────────────────────────────────────────
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
    console.log(`${player.name} reconnected to ${code}`);
  });

  // ── Request state ──────────────────────────────────────────────
  socket.on('request-state', ({ code, secret }) => {
    const room = rooms[code];
    if (!room) return;
    const player = room.players.find(p => p.secret === secret);
    if (!player) return;
    if (room.gameState) socket.emit('state-update', { gameState: room.gameState });
  });

  // ── Game actions ───────────────────────────────────────────────
  socket.on('game-action', (action) => {
    // Rate limit: max 300 actions per IP per minute
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

  // ── Disconnect ─────────────────────────────────────────────────
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
              const connected = room.players.filter(p => p.connected).length;
              if (connected === 0) delete rooms[code];
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
    console.log(`Disconnected: ${socket.id} (${ip})`);
  });

  // ── Get lobby ──────────────────────────────────────────────────
  socket.on('get-lobby', () => {
    socket.emit('lobby-update', { rooms: getRoomList(), online: io.engine.clientsCount });
  });
});

// ── Handle room-expired on client ────────────────────────────────
// (client already has handler for player-left/player-disconnected)

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Malefiz server running on port ${PORT}`);
  console.log(`Rate limits: ${MAX_ROOMS_PER_IP} rooms/min, ${MAX_JOINS_PER_IP} joins/min, ${MAX_ACTIONS_PER_IP} actions/min`);
  console.log(`Room auto-cleanup: every 5 minutes, max age 30 minutes`);
});
