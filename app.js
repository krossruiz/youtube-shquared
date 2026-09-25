/* YouTube Shquared — WebRTC-synced watch party (PeerJS data channels) */

const DRIFT_SEC = 0.75;
const HOST_TICK_MS = 2000;
const DEFAULT_VIDEO = 'dQw4w9WgXcQ';

const els = {
  lobby: document.getElementById('lobby'),
  room: document.getElementById('room'),
  status: document.getElementById('status-pill'),
  name: document.getElementById('name-input'),
  create: document.getElementById('create-btn'),
  join: document.getElementById('join-btn'),
  roomInput: document.getElementById('room-input'),
  roomCode: document.getElementById('room-code'),
  copyLink: document.getElementById('copy-link-btn'),
  leave: document.getElementById('leave-btn'),
  hostControls: document.getElementById('host-controls'),
  guestNote: document.getElementById('guest-note'),
  videoInput: document.getElementById('video-input'),
  load: document.getElementById('load-btn'),
  play: document.getElementById('play-btn'),
  pause: document.getElementById('pause-btn'),
  peerList: document.getElementById('peer-list'),
  chatLog: document.getElementById('chat-log'),
  chatForm: document.getElementById('chat-form'),
  chatInput: document.getElementById('chat-input'),
  toast: document.getElementById('toast'),
};

const state = {
  role: null, // 'host' | 'guest'
  name: '',
  peer: null,
  hostId: null,
  connections: new Map(), // peerId -> DataConnection
  peers: new Map(), // peerId -> { name, role }
  player: null,
  ytReady: false,
  videoId: DEFAULT_VIDEO,
  applyingRemote: false,
  hostTick: null,
  toastTimer: null,
};

function randomName() {
  const n = Math.floor(Math.random() * 900) + 100;
  return `Viewer${n}`;
}

function setStatus(text, kind = '') {
  els.status.textContent = text;
  els.status.className = `pill${kind ? ` ${kind}` : ''}`;
}

function toast(msg, ms = 2800) {
  els.toast.textContent = msg;
  els.toast.classList.remove('hidden');
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => els.toast.classList.add('hidden'), ms);
}

function extractVideoId(input) {
  if (!input) return null;
  const s = String(input).trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(s)) return s;
  try {
    const u = new URL(s);
    if (u.hostname.includes('youtu.be')) {
      const id = u.pathname.split('/').filter(Boolean)[0];
      return id && id.length === 11 ? id : null;
    }
    if (u.hostname.includes('youtube.com')) {
      const v = u.searchParams.get('v');
      if (v && v.length === 11) return v;
      const parts = u.pathname.split('/');
      const embed = parts.indexOf('embed');
      if (embed >= 0 && parts[embed + 1]?.length === 11) return parts[embed + 1];
      const shorts = parts.indexOf('shorts');
      if (shorts >= 0 && parts[shorts + 1]?.length === 11) return parts[shorts + 1];
    }
  } catch { /* not a URL */ }
  return null;
}

function roomUrl(id) {
  const u = new URL(location.href);
  u.searchParams.set('room', id);
  return u.toString();
}

function broadcast(msg, exceptId = null) {
  const data = JSON.stringify(msg);
  for (const [id, conn] of state.connections) {
    if (exceptId && id === exceptId) continue;
    if (conn.open) conn.send(data);
  }
}

function sendTo(conn, msg) {
  if (conn?.open) conn.send(JSON.stringify(msg));
}

function currentPlayback() {
  if (!state.player || typeof state.player.getCurrentTime !== 'function') {
    return { videoId: state.videoId, playing: false, time: 0, updatedAt: Date.now() };
  }
  const playing = state.player.getPlayerState() === YT.PlayerState.PLAYING;
  let time = 0;
  try { time = state.player.getCurrentTime() || 0; } catch { /* ignore */ }
  return {
    videoId: state.videoId,
    playing,
    time,
    updatedAt: Date.now(),
  };
}

function emitState() {
  if (state.role !== 'host') return;
  broadcast({ type: 'state', ...currentPlayback() });
}

function renderPeers() {
  els.peerList.innerHTML = '';
  const rows = [];
  if (state.peer?.id) rows.push({ id: state.peer.id, name: state.name, role: state.role });
  for (const [id, info] of state.peers) {
    if (id === state.peer?.id) continue;
    rows.push({ id, name: info.name, role: info.role });
  }
  const seen = new Set();
  for (const p of rows) {
    if (!p.id || seen.has(p.id)) continue;
    seen.add(p.id);
    const li = document.createElement('li');
    const you = p.id === state.peer?.id ? ' · you' : '';
    li.innerHTML = `<span>${escapeHtml(p.name || 'Someone')}</span><span class="role">${p.role === 'host' ? 'Host' : 'Guest'}${you}</span>`;
    els.peerList.appendChild(li);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function addChat(name, text) {
  const line = document.createElement('div');
  line.className = 'chat-line';
  line.innerHTML = `<span class="who">${escapeHtml(name)}</span><span>${escapeHtml(text)}</span>`;
  els.chatLog.appendChild(line);
  els.chatLog.scrollTop = els.chatLog.scrollHeight;
}

function ensurePlayer(videoId, onReady) {
  state.videoId = videoId;
  if (state.player) {
    state.applyingRemote = true;
    state.player.loadVideoById(videoId);
    setTimeout(() => { state.applyingRemote = false; }, 400);
    onReady?.();
    return;
  }
  state.player = new YT.Player('yt-player', {
    videoId,
    playerVars: {
      autoplay: 0,
      modestbranding: 1,
      rel: 0,
      playsinline: 1,
      enablejsapi: 1,
      origin: location.origin,
    },
    events: {
      onReady: () => {
        state.ytReady = true;
        onReady?.();
      },
      onStateChange: (e) => {
        if (state.role !== 'host' || state.applyingRemote) return;
        if (e.data === YT.PlayerState.PLAYING || e.data === YT.PlayerState.PAUSED || e.data === YT.PlayerState.BUFFERING) {
          emitState();
        }
      },
    },
  });
}

function applyRemoteState(msg) {
  if (state.role === 'host') return;
  const { videoId, playing, time, updatedAt } = msg;
  const age = Math.max(0, (Date.now() - (updatedAt || Date.now())) / 1000);
  const target = (time || 0) + (playing ? age : 0);

  const run = () => {
    state.applyingRemote = true;
    try {
      if (videoId && videoId !== state.videoId) {
        state.videoId = videoId;
        state.player.loadVideoById({ videoId, startSeconds: target });
      } else {
        const now = state.player.getCurrentTime() || 0;
        if (Math.abs(now - target) > DRIFT_SEC) {
          state.player.seekTo(target, true);
        }
      }
      if (playing) {
        if (state.player.getPlayerState() !== YT.PlayerState.PLAYING) state.player.playVideo();
      } else if (state.player.getPlayerState() === YT.PlayerState.PLAYING) {
        state.player.pauseVideo();
      }
    } catch (err) {
      console.warn('applyRemoteState', err);
    }
    setTimeout(() => { state.applyingRemote = false; }, 500);
  };

  if (!state.player) ensurePlayer(videoId || DEFAULT_VIDEO, run);
  else if (!state.ytReady) setTimeout(() => applyRemoteState(msg), 200);
  else run();
}

function handleMessage(fromId, raw) {
  let msg;
  try { msg = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return; }
  if (!msg || !msg.type) return;

  switch (msg.type) {
    case 'hello': {
      state.peers.set(fromId, { name: msg.name || 'Guest', role: msg.role || 'guest' });
      renderPeers();
      if (state.role === 'host') {
        const conn = state.connections.get(fromId);
        sendTo(conn, { type: 'roster', peers: [
          { id: state.peer.id, name: state.name, role: 'host' },
          ...[...state.peers.entries()].map(([id, info]) => ({ id, ...info })),
        ]});
        sendTo(conn, { type: 'state', ...currentPlayback() });
        broadcast({ type: 'peer-join', id: fromId, name: msg.name, role: msg.role }, fromId);
      }
      break;
    }
    case 'roster': {
      state.peers.clear();
      for (const p of msg.peers || []) {
        if (p.id === state.peer?.id) continue;
        state.peers.set(p.id, { name: p.name, role: p.role });
      }
      renderPeers();
      break;
    }
    case 'peer-join': {
      if (msg.id && msg.id !== state.peer?.id) {
        state.peers.set(msg.id, { name: msg.name || 'Guest', role: msg.role || 'guest' });
        renderPeers();
      }
      break;
    }
    case 'peer-leave': {
      if (msg.id) {
        state.peers.delete(msg.id);
        renderPeers();
      }
      break;
    }
    case 'request-state': {
      if (state.role === 'host') {
        sendTo(state.connections.get(fromId), { type: 'state', ...currentPlayback() });
      }
      break;
    }
    case 'state':
      applyRemoteState(msg);
      break;
    case 'chat':
      addChat(msg.name || 'Someone', msg.text || '');
      break;
    default:
      break;
  }
}

function wireConnection(conn, remoteRoleHint = 'guest') {
  conn.on('open', () => {
    state.connections.set(conn.peer, conn);
    sendTo(conn, { type: 'hello', role: state.role, peerId: state.peer.id, name: state.name });
    if (state.role === 'guest') sendTo(conn, { type: 'request-state' });
    renderPeers();
    setStatus(state.role === 'host' ? `Host · ${state.connections.size} linked` : 'Connected', 'ok');
  });

  conn.on('data', (data) => handleMessage(conn.peer, data));

  conn.on('close', () => {
    state.connections.delete(conn.peer);
    state.peers.delete(conn.peer);
    if (state.role === 'host') broadcast({ type: 'peer-leave', id: conn.peer });
    renderPeers();
    if (state.role === 'guest' && conn.peer === state.hostId) {
      setStatus('Host disconnected', 'err');
      toast('Host left the room');
    } else {
      setStatus(state.role === 'host' ? `Host · ${state.connections.size} linked` : 'Connected', 'ok');
    }
  });

  conn.on('error', (err) => {
    console.error(err);
    toast(err?.message || 'Connection error');
  });

  // If already open (rare), mark immediately
  if (conn.open) {
    state.connections.set(conn.peer, conn);
    state.peers.set(conn.peer, { name: 'Peer', role: remoteRoleHint });
  }
}

function startHostTick() {
  clearInterval(state.hostTick);
  state.hostTick = setInterval(() => {
    if (state.role !== 'host' || !state.player) return;
    try {
      if (state.player.getPlayerState() === YT.PlayerState.PLAYING) emitState();
    } catch { /* ignore */ }
  }, HOST_TICK_MS);
}

function showRoom() {
  els.lobby.classList.add('hidden');
  els.room.classList.remove('hidden');
  els.roomCode.textContent = state.hostId || state.peer.id;
  const isHost = state.role === 'host';
  els.hostControls.classList.toggle('hidden', !isHost);
  els.guestNote.classList.toggle('hidden', isHost);
  renderPeers();
}

function destroySession() {
  clearInterval(state.hostTick);
  state.hostTick = null;
  for (const conn of state.connections.values()) {
    try { conn.close(); } catch { /* ignore */ }
  }
  state.connections.clear();
  state.peers.clear();
  if (state.peer) {
    try { state.peer.destroy(); } catch { /* ignore */ }
  }
  state.peer = null;
  state.role = null;
  state.hostId = null;
  if (state.player) {
    try { state.player.destroy(); } catch { /* ignore */ }
    state.player = null;
    state.ytReady = false;
    const mount = document.getElementById('yt-player');
    if (mount) mount.innerHTML = '';
  }
  els.chatLog.innerHTML = '';
  els.room.classList.add('hidden');
  els.lobby.classList.remove('hidden');
  setStatus('Idle');
  const u = new URL(location.href);
  u.searchParams.delete('room');
  history.replaceState(null, '', u.pathname + u.search);
}

function createPeer() {
  return new Promise((resolve, reject) => {
    const peer = new Peer({
      debug: 1,
      config: {
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:global.stun.twilio.com:3478' },
        ],
      },
    });
    const fail = (err) => {
      peer.destroy();
      reject(err);
    };
    peer.on('error', fail);
    peer.on('open', (id) => {
      peer.off('error', fail);
      resolve({ peer, id });
    });
  });
}

async function createRoom() {
  state.name = (els.name.value || '').trim() || randomName();
  els.name.value = state.name;
  setStatus('Connecting…', 'warn');
  try {
    const { peer, id } = await createPeer();
    state.peer = peer;
    state.role = 'host';
    state.hostId = id;
    peer.on('connection', (conn) => wireConnection(conn, 'guest'));
    peer.on('error', (err) => {
      console.error(err);
      toast(err?.message || 'Peer error');
      setStatus('Error', 'err');
    });
    showRoom();
    ensurePlayer(DEFAULT_VIDEO);
    startHostTick();
    setStatus('Host · waiting', 'ok');
    history.replaceState(null, '', roomUrl(id));
    toast('Room created — share the link');
  } catch (err) {
    console.error(err);
    setStatus('Failed', 'err');
    toast(err?.message || 'Could not create room');
  }
}

async function joinRoom(roomCode) {
  const code = (roomCode || '').trim();
  if (!code) {
    toast('Enter a room code');
    return;
  }
  state.name = (els.name.value || '').trim() || randomName();
  els.name.value = state.name;
  setStatus('Connecting…', 'warn');
  try {
    const { peer } = await createPeer();
    state.peer = peer;
    state.role = 'guest';
    state.hostId = code;
    peer.on('error', (err) => {
      console.error(err);
      toast(err?.type === 'peer-unavailable' ? 'Room not found' : (err?.message || 'Peer error'));
      setStatus('Error', 'err');
    });
    const conn = peer.connect(code, { reliable: true });
    wireConnection(conn, 'host');
    state.peers.set(code, { name: 'Host', role: 'host' });
    showRoom();
    ensurePlayer(DEFAULT_VIDEO);
    history.replaceState(null, '', roomUrl(code));
    setStatus('Connecting to host…', 'warn');
  } catch (err) {
    console.error(err);
    setStatus('Failed', 'err');
    toast(err?.message || 'Could not join room');
  }
}

// UI events
els.create.addEventListener('click', () => createRoom());
els.join.addEventListener('click', () => joinRoom(els.roomInput.value));
els.roomInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') joinRoom(els.roomInput.value);
});
els.leave.addEventListener('click', () => destroySession());
els.copyLink.addEventListener('click', async () => {
  const url = roomUrl(state.hostId || state.peer?.id);
  try {
    await navigator.clipboard.writeText(url);
    toast('Link copied');
  } catch {
    prompt('Copy this link', url);
  }
});

els.load.addEventListener('click', () => {
  if (state.role !== 'host') return;
  const id = extractVideoId(els.videoInput.value);
  if (!id) {
    toast('Paste a valid YouTube URL or 11-character video ID');
    return;
  }
  ensurePlayer(id, () => {
    state.player.seekTo(0, true);
    state.player.playVideo();
    emitState();
  });
});

els.play.addEventListener('click', () => {
  if (state.role !== 'host' || !state.player) return;
  state.player.playVideo();
  emitState();
});

els.pause.addEventListener('click', () => {
  if (state.role !== 'host' || !state.player) return;
  state.player.pauseVideo();
  emitState();
});

els.chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = (els.chatInput.value || '').trim();
  if (!text) return;
  els.chatInput.value = '';
  addChat(state.name, text);
  broadcast({ type: 'chat', name: state.name, text, at: Date.now() });
});

// Boot
els.name.value = randomName();
window.onYouTubeIframeAPIReady = () => {
  state.ytReady = true;
};

const params = new URLSearchParams(location.search);
const autoRoom = params.get('room');
if (autoRoom) {
  els.roomInput.value = autoRoom;
  // Wait a tick so YT API can start loading; join still creates player later
  setTimeout(() => joinRoom(autoRoom), 300);
}
