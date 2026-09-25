/* YouTube Shquared — WebRTC-synced watch party (PeerJS data channels) */

const DRIFT_SEC = 0.75;
const HOST_TICK_MS = 2000;
const DEFAULT_VIDEO = 'dQw4w9WgXcQ';
const HOST_SESSION_KEY = 'ys-host-session';
const HOST_RECOVER_MS = 2500; // give refreshing hosts time to reclaim their Peer id

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
  jumpForm: document.getElementById('jump-form'),
  prevBtn: document.getElementById('prev-btn'),
  playToggle: document.getElementById('play-toggle-btn'),
  playToggleLabel: document.getElementById('play-toggle-label'),
  nextBtn: document.getElementById('next-btn'),
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
  hostLabel: document.getElementById('host-label'),
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
  history: [], // [{ id?, videoId, title }] previously played (for Last)
  selectedQueue: null, // { kind: 'played'|'upcoming', id }
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



function extractPlaylistId(input) {
  if (!input) return null;
  const s = String(input).trim();
  // Raw playlist / channel-uploads / liked / mix ids
  if (/^(PL|UU|LL|OL)[a-zA-Z0-9_-]{10,}$/.test(s)) return s;
  try {
    const u = new URL(s);
    if (!u.hostname.includes('youtube.com') && !u.hostname.includes('youtu.be')) return null;
    const list = u.searchParams.get('list');
    if (!list) return null;
    // watch?v=…&list=… → single video only (keep current behavior)
    const v = u.searchParams.get('v');
    if (v && /^[a-zA-Z0-9_-]{11}$/.test(v)) return null;
    // /playlist?list=… or list= without a video id
    if (u.pathname.includes('/playlist') || !v) return list;
    return null;
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
  return {
    type: 'queue-sync',
    queue: state.queue,
    history: state.history,
    videoId: state.videoId,
    videoTitle: state.videoTitle,
  };
}

function emitQueue() {
  if (state.role === 'host') broadcast(queuePayload());
}

function setNowPlayingLabel() {
  if (!els.nowPlaying) return;
  const title = state.videoTitle || state.videoId || '—';
  els.nowPlaying.textContent = `Now playing: ${title}`;
}

function listForKind(kind) {
  return kind === 'played' ? state.history : state.queue;
}

function applyQueueOrder(history, queue, { emit = true } = {}) {
  state.history = Array.isArray(history) ? history : [];
  state.queue = Array.isArray(queue) ? queue : [];
  if (state.selectedQueue?.id) {
    const id = state.selectedQueue.id;
    if (state.queue.some((q) => q.id === id)) state.selectedQueue = { kind: 'upcoming', id };
    else if (state.history.some((h) => h.id === id)) state.selectedQueue = { kind: 'played', id };
    else state.selectedQueue = null;
  }
  renderQueue();
  if (emit) {
    if (state.role === 'host') emitQueue();
    else broadcast({ type: 'queue-reorder', history: state.history, queue: state.queue });
  }
}

function normalizeMovedItem(item, toKind) {
  if (toKind === 'upcoming') {
    return {
      id: item.id || `h2q-${Date.now().toString(36)}`,
      videoId: item.videoId,
      title: item.title || item.videoId,
      addedBy: item.addedBy || state.peer?.id || null,
      addedByName: item.addedByName || state.name || 'Someone',
    };
  }
  return {
    id: item.id || `q2h-${Date.now().toString(36)}`,
    videoId: item.videoId,
    title: item.title || item.videoId,
  };
}

function moveQueueItem(fromKind, fromIndex, toKind, toIndex) {
  if (fromKind !== 'played' && fromKind !== 'upcoming') return;
  if (toKind !== 'played' && toKind !== 'upcoming') return;
  const fromList = listForKind(fromKind);
  if (fromIndex < 0 || fromIndex >= fromList.length) return;

  let insertAt = Math.max(0, toIndex | 0);
  const nextHistory = state.history.slice();
  const nextQueue = state.queue.slice();
  const src = fromKind === 'played' ? nextHistory : nextQueue;
  const dst = toKind === 'played' ? nextHistory : nextQueue;

  const [item] = src.splice(fromIndex, 1);
  if (!item) return;

  if (fromKind === toKind) {
    if (insertAt > fromIndex) insertAt -= 1;
    insertAt = Math.max(0, Math.min(insertAt, src.length));
    if (insertAt === fromIndex) {
      // no-op restore
      src.splice(fromIndex, 0, item);
      return;
    }
    src.splice(insertAt, 0, item);
  } else {
    insertAt = Math.max(0, Math.min(insertAt, dst.length));
    dst.splice(insertAt, 0, normalizeMovedItem(item, toKind));
  }

  applyQueueOrder(nextHistory, nextQueue, { emit: true });
}

/** Move one Played/Next row up (-1) or down (+1). Crosses Now into the other list. */
function nudgeQueueItem(kind, index, dir) {
  if (kind !== 'played' && kind !== 'upcoming') return;
  if (dir !== -1 && dir !== 1) return;
  const list = listForKind(kind);
  if (index < 0 || index >= list.length) return;
  const item = list[index];
  if (item?.id) state.selectedQueue = { kind, id: item.id };

  const target = index + dir;
  if (target >= 0 && target < list.length) {
    // Same list: moveQueueItem insertAt uses pre-splice index; down needs +2
    const toIndex = dir > 0 ? index + 2 : index - 1;
    moveQueueItem(kind, index, kind, toIndex);
    return;
  }
  if (kind === 'upcoming' && dir === -1 && index === 0) {
    moveQueueItem('upcoming', 0, 'played', state.history.length);
    return;
  }
  if (kind === 'played' && dir === 1 && index === list.length - 1) {
    moveQueueItem('played', index, 'upcoming', 0);
  }
}

function selectQueueRow(kind, id) {
  state.selectedQueue = { kind, id };
  renderQueue();
}

function wireQueueRow(li, kind, index, itemId) {
  li.dataset.kind = kind;
  li.dataset.index = String(index);
  li.dataset.id = itemId || '';
  if (state.selectedQueue && state.selectedQueue.kind === kind && state.selectedQueue.id === itemId) {
    li.classList.add('selected');
  }
  li.addEventListener('click', (e) => {
    if (e.target.closest && e.target.closest('button')) return;
    selectQueueRow(kind, itemId);
  });
  const up = li.querySelector('button.move-up');
  const down = li.querySelector('button.move-down');
  if (up) {
    up.disabled = kind === 'played' ? index === 0 : false;
    // upcoming index 0 can still move up into Played
    up.addEventListener('click', (e) => {
      e.stopPropagation();
      selectQueueRow(kind, itemId);
      nudgeQueueItem(kind, index, -1);
    });
  }
  if (down) {
    down.disabled = kind === 'upcoming' && index >= state.queue.length - 1;
    down.addEventListener('click', (e) => {
      e.stopPropagation();
      selectQueueRow(kind, itemId);
      nudgeQueueItem(kind, index, 1);
    });
  }
}

function renderQueue() {
  if (!els.queueList) return;
  els.queueList.innerHTML = '';
  const hasHistory = state.history.length > 0;
  const hasUpcoming = state.queue.length > 0;
  const hasNow = !!(state.videoId || state.videoTitle);
  const empty = !hasHistory && !hasUpcoming && !hasNow;
  if (els.queueEmpty) els.queueEmpty.classList.toggle('hidden', !empty);

  // Oldest played first, then now, then upcoming — full session timeline
  state.history.forEach((item, index) => {
    const li = document.createElement('li');
    li.className = 'played';
    li.innerHTML = `
      <span class="badge">Played</span>
      <div class="meta">
        <span class="title" title="${escapeHtml(item.title || item.videoId)}">${escapeHtml(item.title || item.videoId)}</span>
        <span class="by">earlier in the room · arrows to reorder</span>
      </div>
      <div class="move-btns">
        <button type="button" class="btn move-up" aria-label="Move up">▲</button>
        <button type="button" class="btn move-down" aria-label="Move down">▼</button>
      </div>
    `;
    wireQueueRow(li, 'played', index, item.id);
    els.queueList.appendChild(li);
  });

  if (hasNow) {
    const li = document.createElement('li');
    li.className = 'now';
    li.innerHTML = `
      <span class="badge">Now</span>
      <div class="meta">
        <span class="title" title="${escapeHtml(state.videoTitle || state.videoId)}">${escapeHtml(state.videoTitle || state.videoId || '—')}</span>
        <span class="by">playing now</span>
      </div>
    `;
    els.queueList.appendChild(li);
  }

  state.queue.forEach((item, index) => {
    const li = document.createElement('li');
    li.className = 'upcoming';
    const canRemove = state.role === 'host' || item.addedBy === state.peer?.id;
    li.innerHTML = `
      <span class="badge">Next</span>
      <div class="meta">
        <span class="title" title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</span>
        <span class="by">added by ${escapeHtml(item.addedByName || 'Someone')} · arrows to reorder</span>
      </div>
      <div class="move-btns">
        <button type="button" class="btn move-up" aria-label="Move up">▲</button>
        <button type="button" class="btn move-down" aria-label="Move down">▼</button>
      </div>
      <button type="button" class="btn rm" data-qid="${escapeHtml(item.id)}" ${canRemove ? '' : 'disabled'}>✕</button>
    `;
    const rm = li.querySelector('button.rm');
    if (canRemove) {
      rm.addEventListener('click', (e) => {
        e.stopPropagation();
        removeFromQueue(item.id);
      });
    }
    wireQueueRow(li, 'upcoming', index, item.id);
    els.queueList.appendChild(li);
  });

  setNowPlayingLabel();
  syncTransportUI();
}

function applyQueueSync(msg) {
  state.queue = Array.isArray(msg.queue) ? msg.queue : [];
  state.history = Array.isArray(msg.history) ? msg.history : [];
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
  const playlistId = extractPlaylistId(raw);
  if (playlistId) {
    await requestAddPlaylistToQueue(playlistId);
    return;
  }
  const videoId = extractVideoId(raw);
  if (!videoId) {
    toast('Paste a valid YouTube URL, playlist link, or video ID');
    return;
  }
  const title = await fetchVideoTitle(videoId);
  // Duplicates are allowed — each add is its own queue row (unique item id).
  const alreadyQueued = state.queue.some((q) => q.videoId === videoId)
    || state.videoId === videoId
    || state.history.some((h) => h.videoId === videoId);
  const item = makeQueueItem(videoId, title, state.peer?.id, state.name);
  if (state.role === 'host') {
    addToQueueLocal(item);
    emitQueue();
    toast(alreadyQueued ? `Queued again: ${title}` : `Queued: ${title}`);
    // If nothing meaningful is playing / ended, start it
    maybeAutoStartQueue();
  } else {
    broadcast({ type: 'queue-add', item });
    toast(alreadyQueued ? `Requested again: ${title}` : `Requested: ${title}`);
  }
  if (els.queueInput) els.queueInput.value = '';
}

async function requestAddPlaylistToQueue(playlistId) {
  toast('Loading playlist…', 4000);
  let data;
  try {
    const res = await fetch(`/api/playlist?list=${encodeURIComponent(playlistId)}`);
    data = await res.json().catch(() => null);
    if (!res.ok || !data || !data.ok) {
      toast((data && data.error) || 'Could not load playlist');
      return;
    }
  } catch {
    toast('Could not load playlist');
    return;
  }
  const videos = Array.isArray(data.videos) ? data.videos : [];
  if (!videos.length) {
    toast('Playlist is empty');
    return;
  }
  const plTitle = data.title || 'Playlist';
  const items = videos.map((v) =>
    makeQueueItem(v.videoId, v.title || v.videoId, state.peer?.id, state.name)
  );
  if (state.role === 'host') {
    for (const item of items) state.queue.push(item);
    renderQueue();
    emitQueue();
    toast(`Queued ${items.length} from ${plTitle}`);
    maybeAutoStartQueue();
  } else {
    broadcast({ type: 'queue-add-many', items });
    toast(`Requested ${items.length} from ${plTitle}`);
  }
  if (els.queueInput) els.queueInput.value = '';
}

function maybeAutoStartQueue() {
  // Only auto-advance when the current video actually ended.
  // Do NOT treat CUED/UNSTARTED (warm-up sitting idle) as a reason to
  // immediately consume the first queued add — that made the queue feel broken.
  if (state.role !== 'host' || !state.player) return;
  try {
    if (state.player.getPlayerState() === YT.PlayerState.ENDED) {
      playNextFromQueue();
    }
  } catch { /* ignore */ }
}

function pushHistoryCurrent() {
  if (!state.videoId) return;
  const last = state.history[state.history.length - 1];
  if (last && last.videoId === state.videoId) return;
  state.history.push({
    id: `h-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    videoId: state.videoId,
    title: state.videoTitle || state.videoId,
  });
  // Cap history so it doesn't grow forever
  if (state.history.length > 40) state.history.splice(0, state.history.length - 40);
}

function syncTransportUI() {
  if (els.prevBtn) els.prevBtn.disabled = state.role !== 'host' || state.history.length === 0;
  if (els.nextBtn) els.nextBtn.disabled = state.role !== 'host' || state.queue.length === 0;
  let playing = false;
  try {
    playing = !!(state.player && state.player.getPlayerState() === YT.PlayerState.PLAYING);
  } catch { /* ignore */ }
  if (els.playToggle) {
    els.playToggle.classList.toggle('is-playing', playing);
    els.playToggle.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    const playIcon = els.playToggle.querySelector('.icon-play');
    const pauseIcon = els.playToggle.querySelector('.icon-pause');
    if (playIcon) playIcon.classList.toggle('hidden', playing);
    if (pauseIcon) pauseIcon.classList.toggle('hidden', !playing);
  }
  if (els.playToggleLabel) els.playToggleLabel.textContent = playing ? 'Pause' : 'Play';
}

function playVideoNow(videoId, title, { pushHistory = true } = {}) {
  if (state.role !== 'host' || !videoId || state.advancing) return;
  if (pushHistory && state.videoId && state.videoId !== videoId) pushHistoryCurrent();
  state.advancing = true;
  state.videoId = videoId;
  state.videoTitle = title || videoId;
  setNowPlayingLabel();
  // Refresh the queue Now row immediately — do not wait for the player callback
  renderQueue();
  emitQueue();
  ensurePlayer(videoId, () => {
    try {
      state.player.seekTo(0, true);
      state.player.playVideo();
    } catch { /* ignore */ }
    emitState();
    emitQueue();
    syncTransportUI();
    state.advancing = false;
  });
  setTimeout(() => { state.advancing = false; syncTransportUI(); }, 2000);
}

function playNextFromQueue() {
  if (state.role !== 'host' || state.advancing) return;
  if (!state.queue.length) {
    toast('Queue is empty');
    syncTransportUI();
    return;
  }
  const next = state.queue.shift();
  playVideoNow(next.videoId, next.title || next.videoId, { pushHistory: true });
}

function playPreviousFromHistory() {
  if (state.role !== 'host' || state.advancing) return;
  if (!state.history.length) {
    toast('No earlier video');
    syncTransportUI();
    return;
  }
  // Save current into the front of the queue so Next can return to it
  if (state.videoId) {
    const current = makeQueueItem(state.videoId, state.videoTitle, state.peer?.id, state.name);
    state.queue.unshift(current);
  }
  const prev = state.history.pop();
  playVideoNow(prev.videoId, prev.title, { pushHistory: false });
}

function togglePlayPause() {
  if (state.role !== 'host' || !state.player) return;
  try {
    const st = state.player.getPlayerState();
    if (st === YT.PlayerState.PLAYING) state.player.pauseVideo();
    else state.player.playVideo();
  } catch { /* ignore */ }
  emitState();
  // YT onStateChange will refresh the stamp; nudge UI immediately
  setTimeout(syncTransportUI, 80);
}

async function jumpToPastedVideo(raw) {
  if (state.role !== 'host') return;
  const id = extractVideoId(raw);
  if (!id) {
    toast('Paste a valid YouTube URL or 11-character video ID');
    return;
  }
  const title = await fetchVideoTitle(id);
  playVideoNow(id, title, { pushHistory: true });
  if (els.videoInput) els.videoInput.value = '';
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
  if (state.role === 'host') saveHostSession();
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
  saveHostSession();
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
  }, HOST_RECOVER_MS);
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
  // Intentional leave — don't reclaim this room on refresh
  clearHostSession();
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

function updateHostLabel() {
  if (!els.hostLabel) return;
  let name = '—';
  if (state.role === 'host') {
    name = state.name || 'Host';
  } else if (state.hostId) {
    if (state.peer?.id === state.hostId) name = state.name || 'Host';
    else name = state.peers.get(state.hostId)?.name || 'Host';
  }
  els.hostLabel.textContent = `Host: ${name}`;
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
  updateHostLabel();
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
        syncTransportUI();
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
    case 'queue-add-many': {
      if (state.role === 'host' && Array.isArray(msg.items)) {
        const guestName = state.peers.get(fromId)?.name || 'Guest';
        for (const raw of msg.items) {
          if (!raw || !raw.videoId) continue;
          const item = {
            id: raw.id || makeQueueItem(raw.videoId).id,
            videoId: raw.videoId,
            title: raw.title || raw.videoId,
            addedBy: raw.addedBy || fromId,
            addedByName: raw.addedByName || guestName,
          };
          state.queue.push(item);
        }
        renderQueue();
        emitQueue();
        maybeAutoStartQueue();
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
    case 'queue-reorder': {
      if (state.role === 'host') {
        applyQueueOrder(msg.history, msg.queue, { emit: true });
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
  syncTransportUI();
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
  state.history = [];
  state.videoTitle = 'Warm-up jam';
  renderQueue();
  syncTransportUI();
  els.room.classList.add('hidden');
  els.lobby.classList.remove('hidden');
  setStatus('Idle');
  const u = new URL(location.href);
  u.searchParams.delete('room');
  history.replaceState(null, '', u.pathname + u.search);
}


function loadHostSession() {
  try {
    const raw = sessionStorage.getItem(HOST_SESSION_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data || !data.roomId) return null;
    return data;
  } catch {
    return null;
  }
}

function saveHostSession() {
  if (state.role !== 'host' || !state.hostId) return;
  try {
    sessionStorage.setItem(HOST_SESSION_KEY, JSON.stringify({
      roomId: state.hostId,
      name: state.name,
      passHostOnLeave: !!state.passHostOnLeave,
      savedAt: Date.now(),
    }));
  } catch { /* ignore quota */ }
}

function clearHostSession() {
  try { sessionStorage.removeItem(HOST_SESSION_KEY); } catch { /* ignore */ }
}

function createPeer(preferredId = null) {
  return new Promise((resolve, reject) => {
    const opts = {
      debug: 1,
      config: {
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:global.stun.twilio.com:3478' },
        ],
      },
    };
    const peer = preferredId ? new Peer(String(preferredId), opts) : new Peer(opts);
    const fail = (err) => {
      try { peer.destroy(); } catch { /* ignore */ }
      reject(err);
    };
    peer.on('error', fail);
    peer.on('open', (id) => {
      peer.off('error', fail);
      resolve({ peer, id });
    });
  });
}

async function createRoomAsHost(preferredId = null, { toastMsg = 'Room created — share the link', quiet = false } = {}) {
  state.name = (els.name.value || '').trim() || randomName();
  els.name.value = state.name;
  if (!quiet) setStatus(preferredId ? 'Reclaiming host…' : 'Connecting…', 'warn');
  const { peer, id } = await createPeer(preferredId);
  state.peer = peer;
  state.role = 'host';
  state.hostId = id;
  if (preferredId == null) {
    state.passHostOnLeave = els.passHostCreate ? !!els.passHostCreate.checked : true;
  }
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
  saveHostSession();
  if (toastMsg) toast(toastMsg);
}

async function createRoom() {
  try {
    await createRoomAsHost(null);
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
  clearHostSession();
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
      const missing = err?.type === 'peer-unavailable';
      toast(missing ? 'Room not found' : (err?.message || 'Peer error'));
      setStatus('Error', 'err');
      if (missing) {
        // Drop phantom host row and bounce to lobby
        state.peers.delete(code);
        renderPeers();
        setTimeout(() => destroySession(), 600);
      }
    });
    const conn = peer.connect(code, { reliable: true });
    wireConnection(conn, 'host');
    // Don't invent a Host row until hello confirms a live host
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

/** On ?room= load: reclaim host if this tab previously hosted that room, else join as guest. */
async function enterRoomFromUrl(roomCode) {
  const code = (roomCode || '').trim();
  if (!code) return;
  const saved = loadHostSession();
  if (saved && saved.roomId === code) {
    if (saved.name) {
      state.name = saved.name;
      els.name.value = saved.name;
    }
    if (typeof saved.passHostOnLeave === 'boolean') {
      state.passHostOnLeave = saved.passHostOnLeave;
      if (els.passHostCreate) els.passHostCreate.checked = saved.passHostOnLeave;
    }
    try {
      await createRoomAsHost(code, { toastMsg: 'Welcome back — you’re still the host' });
      return;
    } catch (err) {
      console.warn('host reclaim failed, joining as guest', err);
      clearHostSession();
      toast('Couldn’t reclaim host — joining as guest');
    }
  }
  await joinRoom(code);
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

els.jumpForm?.addEventListener('submit', (e) => {
  e.preventDefault();
  jumpToPastedVideo(els.videoInput?.value);
});
els.prevBtn?.addEventListener('click', () => playPreviousFromHistory());
els.playToggle?.addEventListener('click', () => togglePlayPause());
els.nextBtn?.addEventListener('click', () => playNextFromQueue());

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
  // Wait a tick so YT API can start loading; reclaim host if this tab hosted before
  setTimeout(() => enterRoomFromUrl(autoRoom), 300);
}
