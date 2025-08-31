// ====== CONFIG ======
// Use relative path since frontend is served from same domain as backend
const BACKEND_URL = window.location.origin;

// ====== GLOBALS ======
let socket;
let isHost = false;
let username = 'User' + Math.floor(Math.random() * 1000);
let roomCodeGlobal = null;
let ytPlayer = null;

let ytReady = false;
let duration = 0;
let progressTimer = null;

// Flags to avoid event loops
let suppressOnStateEmit = false;
let emittedLocally = false;

// Queue incoming actions until YT API is ready
const pendingActions = [];

// ====== DOM ======
const roomSection = document.getElementById('roomSection');
const createRoomBtn = document.getElementById('createRoomBtn');
const joinRoomBtn = document.getElementById('joinRoomBtn');
const leaveRoomBtn = document.getElementById('leaveRoomBtn');
const roomCodeInput = document.getElementById('roomCodeInput');
const copyRoomCode = document.getElementById('copyRoomCode');

const playPauseBtn = document.getElementById('playPauseBtn');
const progressBar = document.getElementById('progressBar');
const progressClickable = document.getElementById('progressClickable');
const currentTimeElement = document.getElementById('currentTime');
const durationElement = document.getElementById('duration');

const youtubeUrl = document.getElementById('youtubeUrl');
const loadVideoBtn = document.getElementById('loadVideoBtn');

const chatInput = document.getElementById('chatInput');
const sendMessageBtn = document.getElementById('sendMessageBtn');
const chatMessages = document.getElementById('chatMessages');

const videoUpload = document.getElementById('videoUpload');
const uploadArea = document.getElementById('uploadArea');
const hostControls = document.getElementById('hostControls');

// ====== UTIL ======
function simulateNotification(message) {
  const n = document.createElement('div');
  n.textContent = message;
  Object.assign(n.style, {
    position:'fixed', bottom:'20px', right:'20px',
    background:'rgba(0,0,0,0.8)', color:'#fff',
    padding:'12px 20px', borderRadius:'50px', zIndex:'1000',
    boxShadow:'0 5px 15px rgba(0,0,0,0.3)', animation:'fadeIn .3s ease'
  });
  document.body.appendChild(n);
  setTimeout(()=>{ n.style.animation = 'fadeOut .3s ease'; setTimeout(()=>n.remove(),300); }, 2000);
}

function formatTime(s) {
  const m = Math.floor(s/60);
  const sec = Math.floor(s%60);
  return `${m}:${sec<10?'0':''}${sec}`;
}

function updatePlayPauseIcon(isPlaying) {
  playPauseBtn.innerHTML = `<i class="fas ${isPlaying ? 'fa-pause' : 'fa-play'}"></i>`;
}

function updateProgressUI() {
  const localV = document.getElementById('localVideo');
  if (localV) {
    const cur = localV.currentTime || 0;
    const dur = localV.duration || 0;
    progressBar.style.width = `${dur ? (cur / dur) * 100 : 0}%`;
    currentTimeElement.textContent = formatTime(cur);
    durationElement.textContent = formatTime(dur || 0);
    return;
  }

  if (!ytPlayer) return;
  const cur = ytPlayer.getCurrentTime?.() || 0;
  const dur = ytPlayer.getDuration?.() || 0;
  progressBar.style.width = `${dur ? (cur / dur) * 100 : 0}%`;
  currentTimeElement.textContent = formatTime(cur);
  durationElement.textContent = formatTime(dur || 0);
}

function startProgressTimer() {
  stopProgressTimer();
  progressTimer = setInterval(updateProgressUI, 500);
}

function stopProgressTimer() {
  if (progressTimer) clearInterval(progressTimer);
  progressTimer = null;
}

function extractYouTubeId(url) {
  try {
    const u = new URL(url);
    if (u.hostname.includes('youtu.be')) return u.pathname.slice(1);
    if (u.searchParams.get('v')) return u.searchParams.get('v');
    const paths = u.pathname.split('/').filter(Boolean);
    if (paths[0] === 'shorts' && paths[1]) return paths[1];
  } catch(_) {}
  return null;
}

// Apply a room state (used on join / when receiving room_state)
function applyRoomState({ videoId, currentTime = 0, isPlaying = false }) {
  if (!videoId) return;
  
  if (!ytPlayer) {
    createPlayer(videoId, currentTime);
  } else {
    const currentVid = ytPlayer.getVideoData ? ytPlayer.getVideoData().video_id : null;
    suppressOnStateEmit = true;
    try {
      if (!currentVid || currentVid !== videoId) {
        ytPlayer.loadVideoById({ videoId, startSeconds: currentTime });
      } else {
        ytPlayer.seekTo(currentTime, true);
      }
    } catch (e) {
      createPlayer(videoId, currentTime);
    }
  }

  setTimeout(() => {
    if (!ytPlayer) return;
    suppressOnStateEmit = true;
    if (isPlaying) {
      try { ytPlayer.seekTo(currentTime, true); } catch(_) {}
      ytPlayer.playVideo();
      updatePlayPauseIcon(true);
    } else {
      try { ytPlayer.seekTo(currentTime, true); } catch(_) {}
      ytPlayer.pauseVideo();
      updatePlayPauseIcon(false);
    }
    startProgressTimer();
  }, 400);
}

// ====== YT IFRAME API ======
window.onYouTubeIframeAPIReady = function() {
  ytReady = true;
  if (!ytPlayer) createPlayer();
  while (pendingActions.length) {
    const act = pendingActions.shift();
    try { act(); } catch(e) { console.error('pending action failed', e); }
  }
};

function createPlayer(videoId = null, startSeconds = 0) {
  const container = document.getElementById('playerPlaceholder');
  container.innerHTML = '<div id="yt-player"></div>';
  ytPlayer = new YT.Player('yt-player', {
    videoId: videoId || undefined,
    playerVars: {
      rel: 0,
      modestbranding: 1,
      origin: window.location.origin,
      controls: 0
    },
    events: {
      onReady: () => {
        if (startSeconds) {
          try { ytPlayer.seekTo(startSeconds, true); } catch(e) {}
        }
        updateProgressUI();
        startProgressTimer();
        const state = ytPlayer.getPlayerState();
        updatePlayPauseIcon(state === 1); // 1 = PLAYING
      },
      onStateChange: (e) => {
        if (!roomCodeGlobal) return;
        if (suppressOnStateEmit) { suppressOnStateEmit = false; return; }
        if (emittedLocally) { emittedLocally = false; return; }

        const t = ytPlayer.getCurrentTime?.() || 0;
        if (e.data === 1) { // PLAYING
          if (socket && roomCodeGlobal) socket.emit('play', { roomCode: roomCodeGlobal, time: t });
          updatePlayPauseIcon(true);
        } else if (e.data === 2) { // PAUSED
          if (socket && roomCodeGlobal) socket.emit('pause', { roomCode: roomCodeGlobal, time: t });
          updatePlayPauseIcon(false);
        }
      }
    }
  });
}

// ====== SOCKET / ROOM FLOW ======
function ensureSocket() {
  if (socket) return socket;
  socket = io(BACKEND_URL, {
    transports: ['websocket'],
    withCredentials: true
  });

  socket.on('connect', () => {
    simulateNotification('Connected to server');
    console.log('socket connected', socket.id);
  });

  socket.on('room_created', ({ roomCode }) => {
    roomCodeGlobal = roomCode;
    document.getElementById('roomCode').textContent = roomCode;
    simulateNotification(`Room created: ${roomCode}`);
  });

  socket.on('joined_room', ({ roomCode, isHost: hostFlag }) => {
    roomCodeGlobal = roomCode;
    isHost = hostFlag;
    hostControls.style.display = isHost ? 'block' : 'none';
    simulateNotification(`Joined room ${roomCode}`);
  });

  // ADD THIS MISSING HANDLER
  socket.on('you_are_host', () => {
    isHost = true;
    hostControls.style.display = 'block';
    simulateNotification('You are now the host');
  });

  socket.on('participants', ({ count }) => {
    document.getElementById('participantCount').textContent = `${count} participant${count>1?'s':''}`;
  });

  // ADD THIS MISSING HANDLER
  socket.on('error', ({ message }) => {
    simulateNotification(message);
  });

  socket.on('room_state', ({ videoId, currentTime = 0, isPlaying = false }) => {
    const action = () => applyRoomState({ videoId, currentTime, isPlaying });
    if (!ytReady) pendingActions.push(action);
    else action();
  });

  socket.on('load_video', ({ videoId, time = 0 }) => {
    const action = () => {
      suppressOnStateEmit = true;
      applyRoomState({ videoId, currentTime: time, isPlaying: false });
    };
    if (!ytReady) pendingActions.push(action); else action();
  });

  socket.on('play', ({ time }) => {
    const action = () => {
      const localV = document.getElementById('localVideo');
      if (localV) return;
      if (!ytPlayer) return;
      suppressOnStateEmit = true;
      try { ytPlayer.seekTo(time, true); } catch(_) {}
      ytPlayer.playVideo();
      updatePlayPauseIcon(true);
    };
    if (!ytReady) pendingActions.push(action); else action();
  });

  socket.on('pause', ({ time }) => {
    const action = () => {
      const localV = document.getElementById('localVideo');
      if (localV) return;
      if (!ytPlayer) return;
      suppressOnStateEmit = true;
      try { ytPlayer.seekTo(time, true); } catch(_) {}
      ytPlayer.pauseVideo();
      updatePlayPauseIcon(false);
    };
    if (!ytReady) pendingActions.push(action); else action();
  });

  socket.on('seek', ({ time }) => {
    const action = () => {
      const localV = document.getElementById('localVideo');
      if (localV) {
        localV.currentTime = time;
        updateProgressUI();
        return;
      }
      if (!ytPlayer) return;
      suppressOnStateEmit = true;
      ytPlayer.seekTo(time, true);
    };
    if (!ytReady) pendingActions.push(action); else action();
  });

  socket.on('chat_message', ({ sender, message }) => {
    addMessageToChat(sender, message, sender === username);
  });

  socket.on('connect_error', (err) => {
    console.error('socket connect error', err);
    simulateNotification('Socket connection error (check backend)');
  });

  return socket;
}

// ====== UI HANDLERS ======
// ... (keep your existing UI handlers as they are) ...

// After fixing these issues, your app should work with your deployed backend!
  // ====== UI HANDLERS ======
  createRoomBtn.addEventListener('click', () => {
    ensureSocket();
    isHost = true;
    roomSection.style.display = 'block';
    document.querySelector('.hero').style.display = 'none';
    document.querySelector('.features').style.display = 'grid';
    hostControls.style.display = 'block';
    const roomNames = ['Movie Night','Watch Party','Hangout Room','Film Festival'];
    document.getElementById('roomName').textContent = roomNames[Math.floor(Math.random()*roomNames.length)];
    document.getElementById('participantCount').textContent = '1 participant';
    socket.emit('create_room', { username });
  });

  joinRoomBtn.addEventListener('click', () => {
    const code = roomCodeInput.value.trim().toUpperCase();
    if (!code) return simulateNotification('Please enter a room code');
    ensureSocket();
    isHost = false;
    roomSection.style.display = 'block';
    document.querySelector('.hero').style.display = 'none';
    document.querySelector('.features').style.display = 'grid';
    hostControls.style.display = 'none';
    document.getElementById('roomCode').textContent = code;
    socket.emit('join_room', { roomCode: code, username });
  });

  leaveRoomBtn.addEventListener('click', () => {
    if (socket && roomCodeGlobal) socket.emit('leave_room', { roomCode: roomCodeGlobal, username });
    roomSection.style.display = 'none';
    document.querySelector('.hero').style.display = 'block';
    document.querySelector('.features').style.display = 'grid';
    roomCodeInput.value = '';
    roomCodeGlobal = null;
    isHost = false;
    simulateNotification('Left the room');
  });

  copyRoomCode.addEventListener('click', () => {
    const code = document.getElementById('roomCode').textContent;
    navigator.clipboard.writeText(code).then(()=>simulateNotification('Room code copied'));
  });

  // Play/Pause
  playPauseBtn.addEventListener('click', () => {
    const localV = document.getElementById('localVideo');
    if (localV) {
      // local preview control
      if (!localV.paused) {
        localV.pause();
        updatePlayPauseIcon(false);
      } else {
        localV.play();
        updatePlayPauseIcon(true);
      }
      return;
    }

    if (!ytPlayer) return;
    const state = ytPlayer.getPlayerState();
    const time = ytPlayer.getCurrentTime?.() || 0;

    if (state === YT.PlayerState.PLAYING) {
      ytPlayer.pauseVideo();
      updatePlayPauseIcon(false);
      if (socket && roomCodeGlobal) {
        emittedLocally = true;
        socket.emit('pause', { roomCode: roomCodeGlobal, time });
      }
    } else {
      ytPlayer.playVideo();
      updatePlayPauseIcon(true);
      if (socket && roomCodeGlobal) {
        emittedLocally = true;
        socket.emit('play', { roomCode: roomCodeGlobal, time });
      }
    }
  });

  // Seek (click on progress bar)
  progressClickable.addEventListener('click', (e) => {
    const rect = progressClickable.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;

    const localV = document.getElementById('localVideo');
    if (localV) {
      const newTime = ratio * (localV.duration || 0);
      localV.currentTime = newTime;
      updateProgressUI();
      return;
    }

    if (!ytPlayer) return;
    const newTime = ratio * (ytPlayer.getDuration?.() || 0);
    ytPlayer.seekTo(newTime, true);
    updateProgressUI();
    if (socket && roomCodeGlobal) {
      emittedLocally = true;
      socket.emit('seek', { roomCode: roomCodeGlobal, time: newTime });
    }
  });

  // Fullscreen
  document.getElementById('fullscreenBtn').addEventListener('click', () => {
    const container = document.querySelector('.video-container');
    if (container.requestFullscreen) container.requestFullscreen();
  });

  // Load video (HOST)
  loadVideoBtn.addEventListener('click', () => {
    if (!isHost) return simulateNotification('Only host can load a video');
    const url = youtubeUrl.value.trim();
    if (!url) return simulateNotification('Please enter a YouTube URL');
    const vid = extractYouTubeId(url);
    if (!vid) return simulateNotification('Invalid YouTube URL');

    if (!ytReady) return simulateNotification('YouTube API not ready yet');
    if (!ytPlayer) createPlayer(vid);
    else {
      try { ytPlayer.loadVideoById({ videoId: vid, startSeconds: 0 }); }
      catch(e) { createPlayer(vid, 0); }
    }

    if (roomCodeGlobal) socket.emit('load_video', { roomCode: roomCodeGlobal, videoId: vid, time: 0 });
    simulateNotification('Video loaded');
  });

  // Upload (local preview only; won't sync across users)
  uploadArea.addEventListener('click', () => videoUpload.click());
  videoUpload.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.type !== 'video/mp4') return simulateNotification('Please upload an MP4');
    document.getElementById('playerPlaceholder').innerHTML = `<video id="localVideo" controls playsinline></video>`;
    const v = document.getElementById('localVideo');
    v.src = URL.createObjectURL(file);
    v.onloadedmetadata = () => {
      duration = v.duration || 0;
      durationElement.textContent = formatTime(duration);
      startProgressTimer();
    };
    // update icon when user uses native controls on local video
    v.onplay = () => updatePlayPauseIcon(true);
    v.onpause = () => updatePlayPauseIcon(false);
    simulateNotification('Local video loaded (not synced to guests)');
  });

  // Chat
  function addMessageToChat(sender, message, isOwn=false) {
    const div = document.createElement('div');
    div.classList.add('message', isOwn ? 'sent' : 'received');
    const a = sender.charAt(0).toUpperCase();
    div.innerHTML = `
      <div class="avatar">${a}</div>
      <div class="message-content">
        <div class="message-sender">${sender}</div>
        <div class="message-text">${message}</div>
      </div>`;
    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }
  sendMessageBtn.addEventListener('click', () => {
    const msg = chatInput.value.trim();
    if (!msg || !roomCodeGlobal) return;
    socket.emit('chat_message', { roomCode: roomCodeGlobal, sender: username, message: msg });
    chatInput.value = '';
  });
  chatInput.addEventListener('keypress', e => { if (e.key === 'Enter') sendMessageBtn.click(); });

  // Demo welcome messages
  setTimeout(()=> addMessageToChat('MovieFan92','Hey everyone! What are we watching?'), 800);
  setTimeout(()=> addMessageToChat('StreamQueen','I hope the host picks something good!'), 1800);
  setTimeout(()=> addMessageToChat('FilmBuff','This platform rocks.'), 2600);