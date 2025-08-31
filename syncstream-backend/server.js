const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*", // in production, set your frontend URL instead of "*"
    methods: ["GET", "POST"],
  },
});

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 5000;

// In-memory store for rooms
const activeRooms = new Map();

// --- Helper: generate 6-char room code
function generateRoomCode() {
  return Math.random().toString(36).substr(2, 6).toUpperCase();
}

// --- Socket.io logic ---
io.on("connection", (socket) => {
  console.log("✅ User connected:", socket.id);

  // Create room
  socket.on("create_room", ({ username }) => {
    const roomCode = generateRoomCode();
    socket.join(roomCode);

    socket.data.username = username;
    socket.data.roomCode = roomCode;
    socket.data.isHost = true;

    activeRooms.set(roomCode, {
      users: [{ id: socket.id, username, isHost: true }],
      host: socket.id,
      videoId: null,
      currentTime: 0,
      isPlaying: false,
    });

    socket.emit("room_created", { roomCode });
    socket.emit("joined_room", { roomCode, isHost: true });
    io.to(roomCode).emit("participants", { count: 1 });
  });

  // Join room
  socket.on("join_room", ({ roomCode, username }) => {
    const room = activeRooms.get(roomCode);
    if (!room) {
      return socket.emit("error", { message: "❌ Room not found" });
    }

    socket.join(roomCode);
    socket.data.username = username;
    socket.data.roomCode = roomCode;
    socket.data.isHost = false;

    room.users.push({ id: socket.id, username, isHost: false });

    // Send current state to new user
    socket.emit("room_state", {
      videoId: room.videoId,
      currentTime: room.currentTime,
      isPlaying: room.isPlaying,
    });

    socket.emit("joined_room", { roomCode, isHost: false });
    io.to(roomCode).emit("participants", { count: room.users.length });
  });

  // Load new video (host only)
  socket.on("load_video", ({ roomCode, videoId, time }) => {
    const room = activeRooms.get(roomCode);
    if (!room) return;
    
    // Verify this user is the host
    if (room.host !== socket.id) {
      return socket.emit("error", { message: "Only the host can load videos" });
    }
    
    room.videoId = videoId;
    room.currentTime = time || 0;
    room.isPlaying = false;
    
    // Broadcast to all clients in the room except the sender
    socket.to(roomCode).emit("load_video", { videoId, time: time || 0 });
  });

  // Play video (host only)
  socket.on("play", ({ roomCode, time }) => {
    const room = activeRooms.get(roomCode);
    if (!room) return;
    
    // Verify this user is the host
    if (room.host !== socket.id) {
      return socket.emit("error", { message: "Only the host can control playback" });
    }
    
    room.isPlaying = true;
    room.currentTime = time;
    
    // Broadcast to all clients in the room except the sender
    socket.to(roomCode).emit("play", { time });
  });

  // Pause video (host only)
  socket.on("pause", ({ roomCode, time }) => {
    const room = activeRooms.get(roomCode);
    if (!room) return;
    
    // Verify this user is the host
    if (room.host !== socket.id) {
      return socket.emit("error", { message: "Only the host can control playback" });
    }
    
    room.isPlaying = false;
    room.currentTime = time;
    
    // Broadcast to all clients in the room except the sender
    socket.to(roomCode).emit("pause", { time });
  });

  // Seek video (host only)
  socket.on("seek", ({ roomCode, time }) => {
    const room = activeRooms.get(roomCode);
    if (!room) return;
    
    // Verify this user is the host
    if (room.host !== socket.id) {
      return socket.emit("error", { message: "Only the host can control playback" });
    }
    
    room.currentTime = time;
    
    // Broadcast to all clients in the room except the sender
    socket.to(roomCode).emit("seek", { time });
  });

  // Chat message
  socket.on("chat_message", ({ roomCode, sender, message }) => {
    // Broadcast to all clients in the room including the sender
    io.to(roomCode).emit("chat_message", { sender, message });
  });

  // Leave room
  socket.on("leave_room", ({ roomCode, username }) => {
    if (roomCode && activeRooms.has(roomCode)) {
      const room = activeRooms.get(roomCode);
      room.users = room.users.filter((u) => u.id !== socket.id);
      
      // If host leaves, assign new host or delete room
      if (room.host === socket.id && room.users.length > 0) {
        room.host = room.users[0].id;
        room.users[0].isHost = true;
        io.to(room.users[0].id).emit("you_are_host");
      }
      
      if (room.users.length === 0) {
        activeRooms.delete(roomCode);
      } else {
        io.to(roomCode).emit("participants", { count: room.users.length });
      }
    }
    socket.leave(roomCode);
  });

  // Handle disconnect
  socket.on("disconnect", () => {
    console.log("❌ User disconnected:", socket.id);

    const { roomCode } = socket.data;
    if (roomCode && activeRooms.has(roomCode)) {
      const room = activeRooms.get(roomCode);
      room.users = room.users.filter((u) => u.id !== socket.id);
      
      // If host disconnects, assign new host or delete room
      if (room.host === socket.id && room.users.length > 0) {
        room.host = room.users[0].id;
        room.users[0].isHost = true;
        io.to(room.users[0].id).emit("you_are_host");
      }
      
      if (room.users.length === 0) {
        activeRooms.delete(roomCode);
      } else {
        io.to(roomCode).emit("participants", { count: room.users.length });
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});