const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingTimeout: 60000,
  pingInterval: 25000
});

app.use(express.static(path.join(__dirname)));

// ── Name generation ──────────────────────────────────────────────
const ADJECTIVES = ['Swift','Brave','Mighty','Shadow','Crimson','Golden','Silver','Iron','Wild','Frost','Storm','Thunder','Blazing','Silent','Cosmic','Neon','Phantom','Rogue','Savage','Stealth'];
const NOUNS = ['Fox','Wolf','Eagle','Tiger','Dragon','Falcon','Viper','Panda','Cobra','Hawk','Bear','Lynx','Raven','Shark','Panther','Jaguar','Falcon','Manta','Raptor','Phoenix'];

function generateName() {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  const num = String(Math.floor(Math.random() * 90) + 10);
  return adj + noun + num;
}

function generateRoomCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// ── Room storage ─────────────────────────────────────────────────
// rooms[code] = { code, host, players[], numPlayers, mode, isPublic, started, gameState }
const rooms = {};
// socketId -> roomCode mapping for reconnect
const socketRooms = {};
// disconnected players: { name, slot, roomCode, secret } waiting to reconnect
const disconnectedPlayers = {};

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

io.on('connection', (socket) => {
  console.log('Connected:', socket.id);

  // Send current lobby immediately on connect
  const lobbyData = { rooms: getRoomList(), online: io.engine.clientsCount };
  socket.emit('lobby-update', lobbyData);

  // ── Create room ────────────────────────────────────────────────
  socket.on('create-room', ({ playerName, numPlayers, mode, isPublic }) => {
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
      gameState: null
    };
    socket.join(code);
    socketRooms[socket.id] = code;
    socket.emit('room-created', { code, slot: 1, secret });
    broadcastLobby();
    console.log(`Room ${code} created by ${playerName} (${numPlayers}p, ${mode}, ${isPublic ? 'public' : 'private'})`);
  });

  // ── Join room ──────────────────────────────────────────────────
  socket.on('join-room', ({ code, playerName }) => {
    const room = rooms[code?.toUpperCase()];
    if (!room) { socket.emit('join-error', 'Room not found. Check the code and try again.'); return; }
    if (room.started) { socket.emit('join-error', 'Game already in progress.'); return; }
    if (room.players.length >= room.numPlayers) { socket.emit('join-error', 'Room is full.'); return; }

    const secret = Math.random().toString(36).substring(2, 12);
    const slot = room.players.length + 1;
    const player = { id: socket.id, name: playerName, slot, secret, connected: true };
    room.players.push(player);
    socket.join(code.toUpperCase());
    socketRooms[socket.id] = code.toUpperCase();
    socket.emit('room-joined', { code: code.toUpperCase(), slot, secret, players: room.players, mode: room.mode, numPlayers: room.numPlayers });
    io.to(code.toUpperCase()).emit('player-joined', { players: room.players });
    broadcastLobby();
    console.log(`${playerName} joined ${code.toUpperCase()} (slot ${slot})`);

    // Auto-start when full
    if (room.players.length === room.numPlayers) {
      room.started = true;
      broadcastLobby();
      setTimeout(() => {
        io.to(code.toUpperCase()).emit('game-start', {
          players: room.players,
          mode: room.mode,
          numPlayers: room.numPlayers
        });
        console.log(`Room ${code.toUpperCase()} started`);
      }, 1000);
    }
  });

  // ── Reconnect ──────────────────────────────────────────────────
  socket.on('reconnect-attempt', ({ code, secret }) => {
    const room = rooms[code];
    if (!room) { socket.emit('reconnect-failed', 'Room no longer exists.'); return; }
    const player = room.players.find(p => p.secret === secret);
    if (!player) { socket.emit('reconnect-failed', 'Could not verify identity.'); return; }
    // Update socket id
    player.id = socket.id;
    player.connected = true;
    socket.join(code);
    socketRooms[socket.id] = code;
    socket.emit('reconnected', { slot: player.slot, players: room.players, gameState: room.gameState });
    socket.to(code).emit('player-reconnected', { slot: player.slot, name: player.name });
    console.log(`${player.name} reconnected to ${code}`);
  });

  // ── Game actions ───────────────────────────────────────────────
  socket.on('game-action', (action) => {
    const code = socketRooms[socket.id];
    if (!code || !rooms[code]) return;
    // Store game state snapshot for reconnects
    if (action.type === 'state-sync') {
      rooms[code].gameState = action.state;
    }
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
          // Game in progress — give them 30s to reconnect
          io.to(code).emit('player-disconnected', { slot: player.slot, name: player.name });
          setTimeout(() => {
            if (!player.connected && rooms[code]) {
              io.to(code).emit('player-left', { slot: player.slot, name: player.name });
              // If only 1 player left, close room
              const connected = room.players.filter(p => p.connected).length;
              if (connected === 0) delete rooms[code];
            }
          }, 30000);
        } else {
          // Not started — remove player and update lobby
          room.players = room.players.filter(p => p.id !== socket.id);
          if (room.players.length === 0) {
            delete rooms[code];
          } else {
            io.to(code).emit('player-joined', { players: room.players });
          }
          broadcastLobby();
        }
      }
    }
    delete socketRooms[socket.id];
    console.log('Disconnected:', socket.id);
  });

  // ── Get lobby ──────────────────────────────────────────────────
  socket.on('get-lobby', () => {
    const lobbyData = { rooms: getRoomList(), online: io.engine.clientsCount };
    socket.emit('lobby-update', lobbyData);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Malefiz server running on port ${PORT}`);
});
