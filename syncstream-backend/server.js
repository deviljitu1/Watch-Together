require('dotenv').config();
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const path = require("path");
const mongoose = require("mongoose");

// Import models
const Room = require("./models/Room");
const Message = require("./models/Message");
const User = require("./models/User");

const app = express();
const server = http.createServer(app);

// Configure CORS
const io = new Server(server, {
  cors: {
    origin: process.env.NODE_ENV === "production" 
      ? [process.env.FRONTEND_URL] 
      : ["http://localhost:8000", "http://localhost:3000", "http://127.0.0.1:5500"],
    methods: ["GET", "POST"],
    credentials: true
  },
});

app.use(cors());
app.use(express.json());

// Serve static files from public directory
app.use(express.static(path.join(__dirname, "public")));

// MongoDB Connection
const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017/syncstream";

mongoose.connect(MONGODB_URI)
  .then(() => {
    console.log("✅ Connected to MongoDB");
  })
  .catch((err) => {
    console.error("❌ MongoDB connection error:", err);
  });

const PORT = process.env.PORT || 5000;

// --- Helper: generate 6-char room code
function generateRoomCode() {
  return Math.random().toString(36).substr(2, 6).toUpperCase();
}

// --- Socket.io logic ---
io.on("connection", async (socket) => {
  console.log("✅ User connected:", socket.id);

  // Create room
  socket.on("create_room", async ({ username }) => {
    try {
      const roomCode = generateRoomCode();
      
      // Create room in MongoDB
      const room = new Room({
        roomCode,
        videoId: null,
        currentTime: 0,
        isPlaying: false,
        host: socket.id,
        users: [{ socketId: socket.id, username, isHost: true }]
      });
      
      await room.save();
      
      socket.join(roomCode);
      socket.data.username = username;
      socket.data.roomCode = roomCode;
      socket.data.isHost = true;

      socket.emit("room_created", { roomCode });
      socket.emit("joined_room", { roomCode, isHost: true });
      io.to(roomCode).emit("participants", { count: 1 });
    } catch (error) {
      console.error("Error creating room:", error);
      socket.emit("error", { message: "Failed to create room" });
    }
  });

  // Join room
  socket.on("join_room", async ({ roomCode, username }) => {
    try {
      const room = await Room.findOne({ roomCode });
      if (!room) {
        return socket.emit("error", { message: "❌ Room not found" });
      }

      socket.join(roomCode);
      socket.data.username = username;
      socket.data.roomCode = roomCode;
      socket.data.isHost = false;

      // Add user to room
      room.users.push({ socketId: socket.id, username, isHost: false });
      await room.save();

      // Send current state to new user
      socket.emit("room_state", {
        videoId: room.videoId,
        currentTime: room.currentTime,
        isPlaying: room.isPlaying,
      });

      socket.emit("joined_room", { roomCode, isHost: false });
      io.to(roomCode).emit("participants", { count: room.users.length });
    } catch (error) {
      console.error("Error joining room:", error);
      socket.emit("error", { message: "Failed to join room" });
    }
  });

  // Load new video (host only)
  socket.on("load_video", async ({ roomCode, videoId, time }) => {
    try {
      const room = await Room.findOne({ roomCode });
      if (!room || room.host !== socket.id) {
        return socket.emit("error", { message: "Only the host can load videos" });
      }
      
      room.videoId = videoId;
      room.currentTime = time || 0;
      room.isPlaying = false;
      await room.save();
      
      socket.to(roomCode).emit("load_video", { videoId, time: time || 0 });
    } catch (error) {
      console.error("Error loading video:", error);
    }
  });

  // Play video (host only)
  socket.on("play", async ({ roomCode, time }) => {
    try {
      const room = await Room.findOne({ roomCode });
      if (!room || room.host !== socket.id) {
        return socket.emit("error", { message: "Only the host can control playback" });
      }
      
      room.isPlaying = true;
      room.currentTime = time;
      await room.save();
      
      socket.to(roomCode).emit("play", { time });
    } catch (error) {
      console.error("Error playing video:", error);
    }
  });

  // Pause video (host only)
  socket.on("pause", async ({ roomCode, time }) => {
    try {
      const room = await Room.findOne({ roomCode });
      if (!room || room.host !== socket.id) {
        return socket.emit("error", { message: "Only the host can control playback" });
      }
      
      room.isPlaying = false;
      room.currentTime = time;
      await room.save();
      
      socket.to(roomCode).emit("pause", { time });
    } catch (error) {
      console.error("Error pausing video:", error);
    }
  });

  // Seek video (host only)
  socket.on("seek", async ({ roomCode, time }) => {
    try {
      const room = await Room.findOne({ roomCode });
      if (!room || room.host !== socket.id) {
        return socket.emit("error", { message: "Only the host can control playback" });
      }
      
      room.currentTime = time;
      await room.save();
      
      socket.to(roomCode).emit("seek", { time });
    } catch (error) {
      console.error("Error seeking video:", error);
    }
  });

  // Chat message
  socket.on("chat_message", async ({ roomCode, sender, message }) => {
    try {
      // Save message to database
      const chatMessage = new Message({
        roomCode,
        sender,
        message,
        timestamp: new Date()
      });
      await chatMessage.save();
      
      // Broadcast to all clients in the room
      io.to(roomCode).emit("chat_message", { sender, message, timestamp: chatMessage.timestamp });
    } catch (error) {
      console.error("Error saving message:", error);
    }
  });

  // Get chat history
  socket.on("get_chat_history", async ({ roomCode }) => {
    try {
      const messages = await Message.find({ roomCode })
        .sort({ timestamp: 1 })
        .limit(50);
      
      socket.emit("chat_history", messages);
    } catch (error) {
      console.error("Error fetching chat history:", error);
    }
  });

  // Leave room
  socket.on("leave_room", async ({ roomCode, username }) => {
    try {
      const room = await Room.findOne({ roomCode });
      if (room) {
        // Remove user from room
        room.users = room.users.filter(u => u.socketId !== socket.id);
        
        // If host leaves, assign new host
        if (room.host === socket.id && room.users.length > 0) {
          room.host = room.users[0].socketId;
          room.users[0].isHost = true;
          io.to(room.users[0].socketId).emit("you_are_host");
        }
        
        // Delete room if empty
        if (room.users.length === 0) {
          await Room.deleteOne({ roomCode });
          // Also clean up old messages
          await Message.deleteMany({ roomCode });
        } else {
          await room.save();
          io.to(roomCode).emit("participants", { count: room.users.length });
        }
      }
      socket.leave(roomCode);
    } catch (error) {
      console.error("Error leaving room:", error);
    }
  });

  // Handle disconnect
  socket.on("disconnect", async () => {
    console.log("❌ User disconnected:", socket.id);

    try {
      const { roomCode } = socket.data;
      if (roomCode) {
        const room = await Room.findOne({ roomCode });
        if (room) {
          // Remove user from room
          room.users = room.users.filter(u => u.socketId !== socket.id);
          
          // If host disconnects, assign new host
          if (room.host === socket.id && room.users.length > 0) {
            room.host = room.users[0].socketId;
            room.users[0].isHost = true;
            io.to(room.users[0].socketId).emit("you_are_host");
          }
          
          // Delete room if empty
          if (room.users.length === 0) {
            await Room.deleteOne({ roomCode });
            await Message.deleteMany({ roomCode });
          } else {
            await room.save();
            io.to(roomCode).emit("participants", { count: room.users.length });
          }
        }
      }
    } catch (error) {
      console.error("Error handling disconnect:", error);
    }
  });
});

// API route to get room info (optional)
app.get("/api/room/:roomCode", async (req, res) => {
  try {
    const room = await Room.findOne({ roomCode: req.params.roomCode });
    if (!room) {
      return res.status(404).json({ error: "Room not found" });
    }
    res.json(room);
  } catch (error) {
    res.status(500).json({ error: "Server error" });
  }
});

// Serve frontend for all other routes
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});