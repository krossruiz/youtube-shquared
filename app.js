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
  passHostCreate: document.getElementById('pass-host-create'),
  passHostToggle: document.getElementById('pass-host-toggle'),
  copyLink: document.getElementById('copy-link-btn'),
  leave: document.getElementById('leave-btn'),
  renameForm: document.getElementById('rename-form'),
  roomName: document.getElementById('room-name-input'),
  renameBtn: document.getElementById('rename-btn'),
  hostControls: document.getElementById('host-controls'),
  guestNote: document.getElementById('guest-note'),
  videoInput: document.getElementById('video-input'),
  load: document.getElementById('load-btn'),
  queueForm: document.getElementById('queue-form'),
  queueInput: document.getElementById('queue-input'),
  queueList: document.getElementById('queue-list'),
  queueEmpty: document.getElementById('queue-empty'),
  nowPlaying: document.getElementById('now-playing'),
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
  videoTitle: 'Warm-up jam',
  queue: [], // [{ id, videoId, title, addedBy, addedByName }]
  applyingRemote: false,
  hostTick: null,
  toastTimer: null,
  advancing: false,
  passHostOnLeave: true,
  acceptingConnections: false,
  recoveringHost: false,
  recoverTimer: null,
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


function makeQueueItem(videoId, title, addedBy, addedByName) {
  return {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    videoId,
    title: title || videoId,
    addedBy: addedBy || null,
    addedByName: addedByName || 'Someone',
  };
}

async function fetchVideoTitle(videoId) {
  try {
    const url = `https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}&format=json`;
    const res = await fetch(url);
    if (!res.ok) return videoId;
    const data = await res.json();
    return (data && data.title) || videoId;
  } catch {
    return videoId;
  }
}

function queuePayload() {
  return { type: 'queue-sync', queue: state.queue, videoId: state.videoId, videoTitle: state.videoTitle };
}

function emitQueue() {
  if (state.role === 'host') broadcast(queuePayload());
}

function setNowPlayingLabel() {
  if (!els.nowPlaying) return;
  const title = state.videoTitle || state.videoId || '—';
  els.nowPlaying.textContent = `Now playing: ${title}`;
}

function renderQueue() {
  if (!els.queueList) return;
  els.queueList.innerHTML = '';
  const empty = !state.queue.length;
  if (els.queueEmpty) els.queueEmpty.classList.toggle('hidden', !empty);
  for (const item of state.queue) {
    const li = document.createElement('li');
    const canRemove = state.role === 'host' || item.addedBy === state.peer?.id;
    li.innerHTML = `
      <div class="meta">
        <span class="title" title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</span>
        <span class="by">added by ${escapeHtml(item.addedByName || 'Someone')}</span>
      </div>
      <button type="button" class="btn rm" data-qid="${escapeHtml(item.id)}" ${canRemove ? '' : 'disabled'}>✕</button>
    `;
    const btn = li.querySelector('button');
    if (canRemove) {
      btn.addEventListener('click', () => removeFromQueue(item.id));
    }
    els.queueList.appendChild(li);
  }
  setNowPlayingLabel();
}

function applyQueueSync(msg) {
  state.queue = Array.isArray(msg.queue) ? msg.queue : [];
  if (msg.videoTitle) state.videoTitle = msg.videoTitle;
  if (msg.videoId) state.videoId = msg.videoId;
  renderQueue();
}

function addToQueueLocal(item) {
  state.queue.push(item);
  renderQueue();
}

function removeFromQueueLocal(qid) {
  state.queue = state.queue.filter((q) => q.id !== qid);
  renderQueue();
}

function removeFromQueue(qid) {
  if (!qid) return;
  if (state.role === 'host') {
    removeFromQueueLocal(qid);
    emitQueue();
  } else {
    broadcast({ type: 'queue-remove', id: qid, peerId: state.peer?.id });
  }
}

async function requestAddToQueue(raw) {
  const videoId = extractVideoId(raw);
  if (!videoId) {
    toast('Paste a valid YouTube URL or video ID');
    return;
  }
  const title = await fetchVideoTitle(videoId);
  const item = makeQueueItem(videoId, title, state.peer?.id, state.name);
  if (state.role === 'host') {
    addToQueueLocal(item);
    emitQueue();
    toast(`Queued: ${title}`);
    // If nothing meaningful is playing / ended, start it
    maybeAutoStartQueue();
  } else {
    broadcast({ type: 'queue-add', item });
    toast(`Requested: ${title}`);
  }
  if (els.queueInput) els.queueInput.value = '';
}

function maybeAutoStartQueue() {
  if (state.role !== 'host' || !state.player) return;
  try {
    const st = state.player.getPlayerState();
    if (st === YT.PlayerState.ENDED || st === YT.PlayerState.UNSTARTED || st === YT.PlayerState.CUED) {
      playNextFromQueue();
    }
  } catch { /* ignore */ }
}

function playNextFromQueue() {
  if (state.role !== 'host' || state.advancing) return;
  if (!state.queue.length) return;
  state.advancing = true;
  const next = state.queue.shift();
  renderQueue();
  emitQueue();
  state.videoTitle = next.title || next.videoId;
  setNowPlayingLabel();
  ensurePlayer(next.videoId, () => {
    try {
      state.player.seekTo(0, true);
      state.player.playVideo();
    } catch { /* ignore */ }
    emitState();
    state.advancing = false;
  });
  // safety if onReady never fires
  setTimeout(() => { state.advancing = false; }, 2000);
}


function settingsPayload() {
  return { type: 'settings', passHostOnLeave: !!state.passHostOnLeave };
}

function emitSettings() {
  if (state.role === 'host') broadcast(settingsPayload());
}

function syncPassHostUI() {
  if (els.passHostToggle) els.passHostToggle.checked = !!state.passHostOnLeave;
  if (els.passHostCreate && state.role !== 'host' && state.role !== 'guest') {
    // lobby only — leave create checkbox alone while in room
  }
}

function setPassHostOnLeave(on, { emit = true } = {}) {
  state.passHostOnLeave = !!on;
  syncPassHostUI();
  if (emit && state.role === 'host') emitSettings();
}

function candidateIdsExcluding(deadHostId) {
  const ids = new Set();
  if (state.peer?.id && state.peer.id !== deadHostId) ids.add(state.peer.id);
  for (const id of state.peers.keys()) {
    if (id && id !== deadHostId) ids.add(id);
  }
  for (const id of state.connections.keys()) {
    if (id && id !== deadHostId) ids.add(id);
  }
  return [...ids];
}

/** Deterministic pick so every peer elects the same successor without a coordinator. */
function electHostId(candidateIds, salt) {
  const sorted = [...new Set(candidateIds.filter(Boolean))].sort();
  if (!sorted.length) return null;
  let h = 0;
  const s = `${salt || ''}|${sorted.join(',')}`;
  for (let i = 0; i < s.length; i++) h = Math.imul(31, h) + s.charCodeAt(i) | 0;
  return sorted[Math.abs(h) % sorted.length];
}

function ensureAcceptingConnections() {
  if (!state.peer || state.acceptingConnections) return;
  state.acceptingConnections = true;
  state.peer.on('connection', (conn) => wireConnection(conn, 'guest'));
}

function becomeHost() {
  if (!state.peer?.id) return;
  clearTimeout(state.recoverTimer);
  state.recoverTimer = null;
  state.recoveringHost = false;
  const previousHost = state.hostId;
  state.role = 'host';
  state.hostId = state.peer.id;
  if (previousHost && previousHost !== state.peer.id) state.peers.delete(previousHost);
  // Demote everyone else in local roster
  for (const [id, info] of state.peers) {
    if (id === state.peer.id) continue;
    state.peers.set(id, { ...info, role: 'guest' });
  }
  ensureAcceptingConnections();
  showRoom();
  startHostTick();
  history.replaceState(null, '', roomUrl(state.peer.id));
  setStatus(state.connections.size ? `Host · ${state.connections.size} linked` : 'Host · waiting for reconnects', 'ok');
  toast('You’re the new host — share the updated link');
  // Push authoritative playback + queue as people reconnect (also on hello)
  emitState();
  emitQueue();
  emitSettings();
  renderPeers();
}

function rejoinNewHost(newHostId) {
  if (!state.peer || !newHostId) return;
  clearTimeout(state.recoverTimer);
  state.recoverTimer = null;
  state.recoveringHost = false;
  const previousHost = state.hostId;
  state.role = 'guest';
  state.hostId = newHostId;

  for (const conn of state.connections.values()) {
    try { conn.close(); } catch { /* ignore */ }
  }
  state.connections.clear();

  // Refresh roles in roster (never keep the departed host)
  const next = new Map();
  for (const [id, info] of state.peers) {
    if (!id || id === state.peer.id) continue;
    if (previousHost && id === previousHost && id !== newHostId) continue;
    if (id === newHostId) next.set(id, { ...info, role: 'host' });
    else next.set(id, { ...info, role: 'guest' });
  }
  if (!next.has(newHostId)) next.set(newHostId, { name: 'Host', role: 'host' });
  state.peers = next;

  showRoom();
  history.replaceState(null, '', roomUrl(newHostId));
  setStatus('Reconnecting to new host…', 'warn');
  toast('Host left — rejoining the new host…');

  const conn = state.peer.connect(newHostId, { reliable: true });
  wireConnection(conn, 'host');
  renderPeers();
}

function handleHostPass(newHostId, { reason = 'pass' } = {}) {
  if (!newHostId || !state.peer?.id) return;
  const oldHostId = state.hostId;
  if (oldHostId && oldHostId !== newHostId && oldHostId !== state.peer.id) {
    state.peers.delete(oldHostId);
  }
  if (newHostId === state.peer.id) becomeHost();
  else rejoinNewHost(newHostId);
}

function dropPeerFromRoster(peerId) {
  if (!peerId) return;
  state.peers.delete(peerId);
  state.connections.delete(peerId);
  renderPeers();
}

function beginHostRecovery(deadHostId) {
  if (state.role !== 'guest') return;
  // Always remove the departed host from People immediately.
  dropPeerFromRoster(deadHostId);

  if (!state.passHostOnLeave) {
    setStatus('Host left', 'err');
    toast('Host left — session ended');
    destroySession();
    return;
  }
  if (state.recoveringHost) return;
  state.recoveringHost = true;
  clearTimeout(state.recoverTimer);
  // Brief wait so an in-flight host-pass can win; then elect locally.
  state.recoverTimer = setTimeout(() => {
    state.recoverTimer = null;
    // Already took over / rejoined?
    if (state.role === 'host' || (state.hostId && state.hostId !== deadHostId && state.connections.size)) {
      state.recoveringHost = false;
      dropPeerFromRoster(deadHostId);
      return;
    }
    const candidates = candidateIdsExcluding(deadHostId);
    const elected = electHostId(candidates, deadHostId);
    state.recoveringHost = false;
    if (!elected) {
      setStatus('Host disconnected', 'err');
      toast('Host left — nobody left to take over');
      destroySession();
      return;
    }
    handleHostPass(elected, { reason: 'recover' });
    dropPeerFromRoster(deadHostId);
  }, 500);
}

function transferHostThenLeave() {
  const deadHostId = state.peer?.id;
  const candidates = [...state.connections.keys()];
  const elected = electHostId(candidates, deadHostId);
  if (!elected) {
    destroySession();
    return;
  }
  broadcast({ type: 'host-pass', newHostId: elected, passHostOnLeave: state.passHostOnLeave });
  setStatus('Passing host…', 'warn');
  toast('Passing host to a guest…');
  setTimeout(() => destroySession(), 450);
}

function leaveRoom() {
  if (state.role === 'host' && state.passHostOnLeave && state.connections.size > 0) {
    transferHostThenLeave();
    return;
  }
  if (state.role === 'host' && state.connections.size > 0) {
    broadcast({ type: 'host-gone', id: state.peer?.id });
    setStatus('Leaving…', 'warn');
    setTimeout(() => destroySession(), 250);
    return;
  }
  destroySession();
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

function addChat(name, text, peerId) {
  const line = document.createElement('div');
  line.className = 'chat-line';
  if (peerId) line.dataset.peerId = peerId;
  line.innerHTML = `<span class="who">${escapeHtml(name)}</span><span>${escapeHtml(text)}</span>`;
  els.chatLog.appendChild(line);
  els.chatLog.scrollTop = els.chatLog.scrollHeight;
}

function rewriteChatNames(peerId, newName) {
  if (!peerId) return;
  const lines = els.chatLog.querySelectorAll(`.chat-line[data-peer-id="${CSS.escape(peerId)}"] .who`);
  for (const who of lines) who.textContent = newName;
}

function applyRename(peerId, newName) {
  const name = String(newName || '').trim().slice(0, 24);
  if (!peerId || !name) return;
  if (peerId === state.peer?.id) {
    state.name = name;
    els.name.value = name;
    if (els.roomName) els.roomName.value = name;
  } else if (state.peers.has(peerId)) {
    const info = state.peers.get(peerId);
    state.peers.set(peerId, { ...info, name });
  } else {
    state.peers.set(peerId, { name, role: 'guest' });
  }
  rewriteChatNames(peerId, name);
  renderPeers();
}

function renameSelf(rawName) {
  const name = String(rawName || '').trim().slice(0, 24);
  if (!name) {
    toast('Enter a name');
    return;
  }
  if (!state.peer?.id) return;
  if (name === state.name) {
    toast('That is already your name');
    return;
  }
  const oldName = state.name;
  applyRename(state.peer.id, name);
  broadcast({ type: 'rename', peerId: state.peer.id, name, oldName });
  toast(`Renamed to ${name}`);
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
        if (e.data === YT.PlayerState.ENDED) {
          playNextFromQueue();
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
        sendTo(conn, queuePayload());
        sendTo(conn, settingsPayload());
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
        const conn = state.connections.get(fromId);
        sendTo(conn, { type: 'state', ...currentPlayback() });
        sendTo(conn, queuePayload());
      }
      break;
    }
    case 'state':
      applyRemoteState(msg);
      break;
    case 'chat': {
      const pid = msg.peerId || fromId;
      addChat(msg.name || 'Someone', msg.text || '', pid);
      // Host relays so all guests see each other (star topology).
      if (state.role === 'host') broadcast({ type: 'chat', peerId: pid, name: msg.name, text: msg.text, at: msg.at }, fromId);
      break;
    }
    case 'rename': {
      const pid = msg.peerId || fromId;
      applyRename(pid, msg.name);
      if (state.role === 'host') {
        broadcast({ type: 'rename', peerId: pid, name: msg.name, oldName: msg.oldName }, fromId);
      }
      break;
    }
    case 'queue-sync':
      applyQueueSync(msg);
      break;
    case 'queue-add': {
      if (state.role === 'host' && msg.item && msg.item.videoId) {
        const item = {
          ...msg.item,
          addedBy: msg.item.addedBy || fromId,
          addedByName: msg.item.addedByName || state.peers.get(fromId)?.name || 'Guest',
        };
        addToQueueLocal(item);
        emitQueue();
        maybeAutoStartQueue();
      } else if (state.role !== 'host') {
        // Relayed copy for display if host echoed — ignore; wait for queue-sync
      }
      break;
    }
    case 'queue-remove': {
      if (state.role === 'host' && msg.id) {
        const item = state.queue.find((q) => q.id === msg.id);
        if (item && item.addedBy === fromId) {
          removeFromQueueLocal(msg.id);
          emitQueue();
        }
      }
      break;
    }
    case 'settings': {
      if (typeof msg.passHostOnLeave === 'boolean') {
        state.passHostOnLeave = msg.passHostOnLeave;
        syncPassHostUI();
      }
      break;
    }
    case 'host-pass': {
      if (msg.newHostId) {
        if (typeof msg.passHostOnLeave === 'boolean') state.passHostOnLeave = msg.passHostOnLeave;
        clearTimeout(state.recoverTimer);
        state.recoverTimer = null;
        state.recoveringHost = false;
        const oldHost = state.hostId || fromId;
        handleHostPass(msg.newHostId, { reason: 'pass' });
        dropPeerFromRoster(oldHost);
      }
      break;
    }
    case 'host-gone': {
      const deadId = msg.id || fromId;
      dropPeerFromRoster(deadId);
      if (state.role === 'guest' && (deadId === state.hostId || fromId === state.hostId)) {
        beginHostRecovery(deadId || state.hostId);
      }
      break;
    }
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
    const wasHostConn = state.role === 'guest' && conn.peer === state.hostId;
    const deadId = conn.peer;
    state.connections.delete(conn.peer);
    state.peers.delete(conn.peer);
    if (state.role === 'host') broadcast({ type: 'peer-leave', id: conn.peer });
    renderPeers();
    if (wasHostConn) {
      beginHostRecovery(deadId);
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
  const isHost = state.role === 'host';
  els.hostControls.classList.toggle('hidden', !isHost);
  els.guestNote.classList.toggle('hidden', isHost);
  if (els.roomName) els.roomName.value = state.name;
  syncPassHostUI();
  renderPeers();
  renderQueue();
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
  state.acceptingConnections = false;
  state.recoveringHost = false;
  clearTimeout(state.recoverTimer);
  state.recoverTimer = null;
  state.passHostOnLeave = els.passHostCreate ? !!els.passHostCreate.checked : true;
  syncPassHostUI();
  if (state.player) {
    try { state.player.destroy(); } catch { /* ignore */ }
    state.player = null;
    state.ytReady = false;
    const mount = document.getElementById('yt-player');
    if (mount) mount.innerHTML = '';
  }
  els.chatLog.innerHTML = '';
  state.queue = [];
  state.videoTitle = 'Warm-up jam';
  renderQueue();
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
    state.passHostOnLeave = els.passHostCreate ? !!els.passHostCreate.checked : true;
    syncPassHostUI();
    ensureAcceptingConnections();
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
els.leave.addEventListener('click', () => leaveRoom());
els.passHostToggle?.addEventListener('change', () => {
  if (state.role !== 'host') {
    syncPassHostUI();
    return;
  }
  setPassHostOnLeave(!!els.passHostToggle.checked, { emit: true });
  toast(state.passHostOnLeave ? 'Host will pass to a guest on leave' : 'Room ends if you leave');
});
els.passHostCreate?.addEventListener('change', () => {
  // Only affects the next room you create; mirrored into state on createRoom.
});
els.copyLink.addEventListener('click', async () => {
  const url = roomUrl(state.hostId || state.peer?.id);
  try {
    await navigator.clipboard.writeText(url);
    toast('Room link copied — share it!');
  } catch {
    prompt('Copy this link', url);
  }
});

els.load.addEventListener('click', async () => {
  if (state.role !== 'host') return;
  const id = extractVideoId(els.videoInput.value);
  if (!id) {
    toast('Paste a valid YouTube URL or 11-character video ID');
    return;
  }
  const title = await fetchVideoTitle(id);
  state.videoTitle = title;
  setNowPlayingLabel();
  ensurePlayer(id, () => {
    state.player.seekTo(0, true);
    state.player.playVideo();
    emitState();
    emitQueue();
  });
});

els.queueForm?.addEventListener('submit', (e) => {
  e.preventDefault();
  requestAddToQueue(els.queueInput?.value);
});


els.chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = (els.chatInput.value || '').trim();
  if (!text) return;
  els.chatInput.value = '';
  addChat(state.name, text, state.peer?.id);
  broadcast({ type: 'chat', peerId: state.peer?.id, name: state.name, text, at: Date.now() });
});

els.renameForm?.addEventListener('submit', (e) => {
  e.preventDefault();
  renameSelf(els.roomName?.value);
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
