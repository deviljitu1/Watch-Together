const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema({
  roomCode: { 
    type: String, 
    required: true,
    uppercase: true
  },
  sender: { 
    type: String, 
    required: true 
  },
  message: { 
    type: String, 
    required: true 
  },
  timestamp: { 
    type: Date, 
    default: Date.now 
  }
});

// Create index for faster queries
messageSchema.index({ roomCode: 1, timestamp: 1 });

module.exports = mongoose.model('Message', messageSchema);