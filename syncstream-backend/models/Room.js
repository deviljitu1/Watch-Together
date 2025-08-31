const mongoose = require('mongoose');

const roomSchema = new mongoose.Schema({
  roomCode: { 
    type: String, 
    required: true, 
    unique: true,
    uppercase: true
  },
  videoId: String,
  currentTime: { 
    type: Number, 
    default: 0 
  },
  isPlaying: { 
    type: Boolean, 
    default: false 
  },
  host: { 
    type: String, 
    required: true 
  },
  users: [{
    socketId: String,
    username: String,
    isHost: Boolean
  }],
  createdAt: { 
    type: Date, 
    default: Date.now, 
    expires: 86400 // Auto-delete after 24 hours
  }
});

module.exports = mongoose.model('Room', roomSchema);