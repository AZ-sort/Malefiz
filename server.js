const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

// Serve the game files
app.use(express.static(path.join(__dirname)));

// Room storage
const rooms = {};

function generateRoomCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

io.on('connection', (socket) => {
  console.log('Player connected:', socket.id);

  // Create a new room
  socket.on('create-room', ({ playerName, numPlayers }) => {
    const code = generateRoomCode();
    rooms[code] = {
      code,
      players: [{ id: socket.id, name: playerName, slot: 1 }],
      numPlayers,
      gameState: null,
      started: false
    };
    socket.join(code);
    socket.roomCode = code;
    socket.emit('room-created', { code, slot: 1 });
    console.log(`Room ${code} created by ${playerName}`);
  });

  // Join an existing room
  socket.on('join-room', ({ code, playerName }) => {
    const room = rooms[code.toUpperCase()];
    if (!room) {
      socket.emit('join-error', 'Room not found');
      return;
    }
    if (room.started) {
      socket.emit('join-error', 'Game already started');
      return;
    }
    if (room.players.length >= room.numPlayers) {
      socket.emit('join-error', 'Room is full');
      return;
    }
    const slot = room.players.length + 1;
    room.players.push({ id: socket.id, name: playerName, slot });
    socket.join(code.toUpperCase());
    socket.roomCode = code.toUpperCase();
    socket.emit('room-joined', { code: code.toUpperCase(), slot, players: room.players });
    io.to(code.toUpperCase()).emit('player-joined', { players: room.players });
    console.log(`${playerName} joined room ${code.toUpperCase()}`);

    // Auto-start when room is full
    if (room.players.length === room.numPlayers) {
      room.started = true;
      io.to(code.toUpperCase()).emit('game-start', { players: room.players });
      console.log(`Room ${code.toUpperCase()} game started`);
    }
  });

  // Sync a game action to all other players in the room
  socket.on('game-action', (action) => {
    const code = socket.roomCode;
    if (!code || !rooms[code]) return;
    socket.to(code).emit('game-action', action);
  });

  // Handle disconnect
  socket.on('disconnect', () => {
    const code = socket.roomCode;
    if (code && rooms[code]) {
      io.to(code).emit('player-disconnected');
      delete rooms[code];
      console.log(`Room ${code} closed — player disconnected`);
    }
    console.log('Player disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Malefiz server running on port ${PORT}`);
});