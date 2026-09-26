/* YouTube Shquared — WebRTC-synced watch party (PeerJS data channels) */

const DRIFT_SEC = 0.75;
const HOST_TICK_MS = 2000;
const DEFAULT_VIDEO = 'dQw4w9WgXcQ';
const HOST_SESSION_KEY = 'ys-host-session';
const HOST_RECOVER_MS = 2500; // give refreshing hosts time to reclaim their Peer id
const HOWTO_DISMISS_KEY = 'ys-howto-dismissed';
const PERSIST_ROOMS_KEY = 'ys-persist-rooms-v1';
const DIR_HEARTBEAT_MS = 8000;
const DIR_STALE_MS = 28000;
const DIR_PRUNE_MS = 5000;
const DIR_RECONNECT_MS = 4000;
const DIR_LOCAL_KEY = 'ys-dir-rooms-v1';
const DIR_BC_NAME = 'ys-dir-rooms-v1';

const els = {
  lobby: document.getElementById('lobby'),
  room: document.getElementById('room'),
  status: document.getElementById('status-pill'),
  name: document.getElementById('name-input'),
  create: document.getElementById('create-btn'),
  join: document.getElementById('join-btn'),
  roomInput: document.getElementById('room-input'),
  passHostCreate: document.getElementById('pass-host-create'),
  persistEmptyCreate: document.getElementById('persist-empty-create'),
  recordSessionCreate: document.getElementById('record-session-create'),
  passHostToggle: document.getElementById('pass-host-toggle'),
  recordingModal: document.getElementById('recording-modal'),
  recordingModalOk: document.getElementById('recording-modal-ok'),
  sessionLogExport: document.getElementById('session-log-export'),
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
  chatLogCurrent: document.getElementById('chat-log-current'),
  chatLogPrevious: document.getElementById('chat-log-previous'),
  chatTabPrevious: document.getElementById('chat-tab-previous'),
  chatTabCurrent: document.getElementById('chat-tab-current'),
  chatTabs: document.querySelector('.chat-tabs'),
  chatForm: document.getElementById('chat-form'),
  chatInput: document.getElementById('chat-input'),
  toast: document.getElementById('toast'),
  hostLabel: document.getElementById('host-label'),
  exportLog: document.getElementById('export-log-btn'),
  loadSessionLobby: document.getElementById('load-session-input-lobby'),
  loadSessionRoom: document.getElementById('load-session-input-room'),
  playbackBar: document.getElementById('playback-bar'),
  replayPlay: document.getElementById('replay-play-btn'),
  replayPause: document.getElementById('replay-pause-btn'),
  replayRestart: document.getElementById('replay-restart-btn'),
  replaySkip: document.getElementById('replay-skip-btn'),
  replaySpeed: document.getElementById('replay-speed'),
  replayExit: document.getElementById('replay-exit-btn'),
  replayStatus: document.getElementById('replay-status'),
  replayMeta: document.getElementById('replay-meta'),
  replayEventList: document.getElementById('replay-event-list'),
  replayClock: document.getElementById('replay-clock'),
  mobileTabBar: document.getElementById('mobile-tab-bar'),
  mobilePanels: document.getElementById('mobile-panels'),
  peopleRenameForm: document.getElementById('people-rename-form'),
  peopleName: document.getElementById('people-name-input'),
  passHostToggleMobile: document.getElementById('pass-host-toggle-mobile'),
  sessionNameInput: document.getElementById('session-name-input'),
  sessionTitle: document.getElementById('session-title'),
  sessionsList: document.getElementById('sessions-list'),
  sessionsStatus: document.getElementById('sessions-status'),
  sessionsRefresh: document.getElementById('sessions-refresh-btn'),
  howtoBanner: document.getElementById('howto-banner'),
  howtoDismiss: document.getElementById('howto-dismiss-btn'),
};

const state = {
  role: null, // 'host' | 'guest'
  name: '',
  sessionName: '',
  peer: null,
  hostId: null,
  connections: new Map(), // peerId -> DataConnection
  peers: new Map(), // peerId -> { name, role }
  directory: {
    peer: null,
    conn: null,
    isBroker: false,
    connected: false,
    starting: false,
    rooms: new Map(), // roomId -> { roomId, sessionName, hostName, participants, updatedAt }
    clients: new Map(), // broker: peerId -> DataConnection
    announceTimer: null,
    pruneTimer: null,
    reconnectTimer: null,
    bc: null, // BroadcastChannel for same-origin multi-tab presence
  },
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
  persistWhenEmpty: false,
  recordingEnabled: true,
  recordingNoticeAcked: false,
  recordingSettingsReady: false,
  parked: false,
  acceptingConnections: false,
  recoveringHost: false,
  recoverTimer: null,
  sessionLog: [], // ring buffer of structured session events
  lastPlaybackLog: { type: null, at: 0 },
  chatTab: 'current', // 'previous' | 'current'
  mobileTab: 'queue', // 'queue' | 'chat' | 'people'
  replay: {
    active: false,
    events: [],
    index: 0,
    playing: false,
    speed: 1,
    t0: 0,
    timer: null,
    clockTimer: null,
    wallStart: 0,
    elapsedMs: 0,
    lobbyOnly: false,
    meta: null,
    statusNote: '',
    mediaApplySeq: 0,
    scrubbing: false,
  },
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


const SESSION_LOG_MAX = 2000;
const PLAYBACK_LOG_DEBOUNCE_MS = 300;

function clearSessionLog() {
  state.sessionLog = [];
  state.lastPlaybackLog = { type: null, at: 0 };
}

/** Record a structured room action. Host optionally syncs to guests via session-log. */
function logSession(type, detail = {}, opts = {}) {
  if (!type) return;
  if (!state.recordingEnabled) return null;
  const entry = {
    at: Date.now(),
    type: String(type),
    by: opts.by != null ? opts.by : state.name,
    peerId: opts.peerId !== undefined ? opts.peerId : (state.peer?.id || null),
    detail: detail && typeof detail === 'object' ? detail : {},
  };
  state.sessionLog.push(entry);
  if (state.sessionLog.length > SESSION_LOG_MAX) {
    state.sessionLog.splice(0, state.sessionLog.length - SESSION_LOG_MAX);
  }
  const shouldSync = opts.sync !== false && state.role === 'host';
  if (shouldSync) {
    broadcast({ type: 'session-log', event: entry });
  }
  return entry;
}

function ingestSessionLogEvent(event) {
  if (!event || !event.type) return;
  if (!state.recordingEnabled) return;
  // Own actions are already logged locally
  if (event.peerId && state.peer?.id && event.peerId === state.peer.id) return;
  const dup = state.sessionLog.some(
    (e) => e.at === event.at && e.type === event.type && e.peerId === event.peerId
  );
  if (dup) return;
  state.sessionLog.push({
    at: event.at || Date.now(),
    type: String(event.type),
    by: event.by || 'Someone',
    peerId: event.peerId || null,
    detail: event.detail && typeof event.detail === 'object' ? event.detail : {},
  });
  if (state.sessionLog.length > SESSION_LOG_MAX) {
    state.sessionLog.splice(0, state.sessionLog.length - SESSION_LOG_MAX);
  }
}

function logPlaybackTransition(ytState) {
  if (state.replay.active || state.role !== 'host' || state.applyingRemote) return;
  let type = null;
  if (ytState === YT.PlayerState.PLAYING) type = 'play';
  else if (ytState === YT.PlayerState.PAUSED) type = 'pause';
  else return;
  const now = Date.now();
  if (
    state.lastPlaybackLog.type === type
    && now - state.lastPlaybackLog.at < PLAYBACK_LOG_DEBOUNCE_MS
  ) {
    return;
  }
  state.lastPlaybackLog = { type, at: now };
  logSession(type, {
    videoId: state.videoId,
    title: state.videoTitle,
    time: getPlayerTimeSec(),
    rate: getPlayerRate(),
  });
}

/** Host-only: log YouTube playback rate changes (keyboard / context menu / UI). */
function logPlaybackRateChange(rate) {
  if (state.replay.active || state.role !== 'host' || state.applyingRemote) return;
  const r = Number(rate);
  logSession('rate', {
    videoId: state.videoId,
    title: state.videoTitle,
    rate: Number.isFinite(r) && r > 0 ? r : getPlayerRate(),
    time: getPlayerTimeSec(),
  });
}

function exportSessionLog() {
  if (!state.recordingEnabled) {
    toast('Recording is off for this room — nothing to export');
    return;
  }
  const roomId = state.hostId || state.peer?.id || 'unknown';
  const payload = {
    app: 'youtube-shquared',
    exportedAt: new Date().toISOString(),
    roomId,
    exporter: state.role || 'unknown',
    name: state.name || '',
    events: state.sessionLog.slice(),
  };
  const iso = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `youtube-shquared-session-${roomId}-${iso}.json`;
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast('Session log downloaded');
}




/* ── Session JSON playback (replay mode) ─────────────────────────── */

function formatReplayClock(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Format media position in seconds as m:ss for event labels. */
function formatMediaTime(sec) {
  const total = Math.max(0, Math.floor(Number(sec) || 0));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function getPlayerTimeSec() {
  try {
    if (state.player && typeof state.player.getCurrentTime === 'function') {
      return state.player.getCurrentTime() || 0;
    }
  } catch { /* ignore */ }
  return 0;
}

function getPlayerRate() {
  try {
    if (state.player && typeof state.player.getPlaybackRate === 'function') {
      const r = state.player.getPlaybackRate();
      if (Number.isFinite(r) && r > 0) return r;
    }
  } catch { /* ignore */ }
  return 1;
}

function syncPreviousChatAvailability() {
  const replayOn = !!(state.replay && state.replay.active);
  // Previous tab (and the tab strip) only while a playback session is loaded
  if (els.chatTabs) els.chatTabs.classList.toggle('hidden', !replayOn);
  if (els.chatTabPrevious) {
    els.chatTabPrevious.classList.toggle('hidden', !replayOn);
    els.chatTabPrevious.toggleAttribute('hidden', !replayOn);
    els.chatTabPrevious.disabled = !replayOn;
  }
  if (!replayOn) {
    state.chatTab = 'current';
    if (els.chatLogPrevious) els.chatLogPrevious.classList.add('hidden');
    if (els.chatLogCurrent) els.chatLogCurrent.classList.remove('hidden');
    if (els.chatTabCurrent) {
      els.chatTabCurrent.classList.add('active');
      els.chatTabCurrent.setAttribute('aria-selected', 'true');
    }
    if (els.chatTabPrevious) {
      els.chatTabPrevious.classList.remove('active');
      els.chatTabPrevious.setAttribute('aria-selected', 'false');
    }
  }
}

function setChatTab(tab) {
  const replayOn = !!(state.replay && state.replay.active);
  let next = tab === 'previous' ? 'previous' : 'current';
  if (next === 'previous' && !replayOn) next = 'current';
  state.chatTab = next;
  const showPrev = next === 'previous' && replayOn;
  syncPreviousChatAvailability();
  if (els.chatLogPrevious) els.chatLogPrevious.classList.toggle('hidden', !showPrev);
  if (els.chatLogCurrent) els.chatLogCurrent.classList.toggle('hidden', showPrev);
  if (els.chatTabPrevious) {
    els.chatTabPrevious.classList.toggle('active', showPrev);
    els.chatTabPrevious.setAttribute('aria-selected', showPrev ? 'true' : 'false');
  }
  if (els.chatTabCurrent) {
    els.chatTabCurrent.classList.toggle('active', !showPrev);
    els.chatTabCurrent.setAttribute('aria-selected', showPrev ? 'false' : 'true');
  }
}

function addPreviousChat(by, text) {
  if (!els.chatLogPrevious) return;
  const line = document.createElement('div');
  line.className = 'chat-line';
  line.innerHTML = `<span class="who">${escapeHtml(by || 'Someone')}</span><span>${escapeHtml(text || '')}</span>`;
  els.chatLogPrevious.appendChild(line);
  els.chatLogPrevious.scrollTop = els.chatLogPrevious.scrollHeight;
  // Stay on Current by default; user can open Previous while replaying
}

function clearPreviousChat() {
  if (els.chatLogPrevious) els.chatLogPrevious.innerHTML = '';
}

function replayTotalMs() {
  const r = state.replay;
  if (!r.events.length) return 0;
  if (r.events.length === 1) return 0;
  return Math.max(0, (r.events[r.events.length - 1].at || 0) - (r.events[0].at || 0));
}

function updateReplayClock() {
  if (!els.replayClock) return;
  const r = state.replay;
  if (!r.active || !r.events.length) {
    els.replayClock.textContent = '0:00 / 0:00';
    return;
  }
  const elapsed = Math.min(Math.max(0, replayElapsedMs()), replayTotalMs() || Infinity);
  const total = replayTotalMs();
  const shown = Number.isFinite(elapsed) ? elapsed : replayElapsedMs();
  let line = `${formatReplayClock(shown)} / ${formatReplayClock(total)}`;
  if (state.player) {
    const media = formatMediaTime(getPlayerTimeSec());
    const rate = getPlayerRate();
    const rateLabel = rate === 1 ? '1x' : `${rate}x`;
    line += ` · media ${media} · ${rateLabel}`;
  }
  els.replayClock.textContent = line;
}

function startReplayClockTicker() {
  stopReplayClockTicker();
  state.replay.clockTimer = setInterval(() => {
    if (!state.replay.playing) {
      stopReplayClockTicker();
      return;
    }
    updateReplayClock();
  }, 200);
}

function stopReplayClockTicker() {
  if (state.replay.clockTimer != null) {
    clearInterval(state.replay.clockTimer);
    state.replay.clockTimer = null;
  }
}

function replayEventLabel(ev) {
  if (!ev || !ev.type) return '(unknown)';
  const detail = ev.detail && typeof ev.detail === 'object' ? ev.detail : {};
  const by = ev.by || '';
  const clip = (s, n = 48) => {
    const t = String(s || '').trim();
    if (!t) return '';
    return t.length > n ? `${t.slice(0, n - 1)}…` : t;
  };
  switch (ev.type) {
    case 'chat':
      return `chat · ${clip(detail.text) || '(empty)'}`;
    case 'queue-add':
      return `queue-add · ${clip(detail.title || detail.videoId) || '?'}`;
    case 'queue-add-playlist': {
      const title = detail.playlistTitle || 'playlist';
      const count = detail.count != null ? detail.count : (Array.isArray(detail.videos) ? detail.videos.length : '?');
      return `queue-add-playlist · ${clip(title)} (${count})`;
    }
    case 'queue-remove':
      return `queue-remove · ${clip(detail.title || detail.videoId || detail.id) || '?'}`;
    case 'queue-reorder':
      return 'queue-reorder';
    case 'next':
    case 'last':
    case 'go':
      return `${ev.type} · ${clip(detail.title || detail.videoId) || (by || '—')}`;
    case 'play':
    case 'pause': {
      const title = clip(detail.title || detail.videoId) || (by || '—');
      const t = Number(detail.time);
      if (Number.isFinite(t) && t >= 0) {
        return `${ev.type} · ${title} @ ${formatMediaTime(t)}`;
      }
      return `${ev.type} · ${title}`;
    }
    case 'rate':
    case 'speed': {
      const r = Number(detail.rate != null ? detail.rate : detail.speed);
      const rateStr = Number.isFinite(r) ? `${r}x` : '?x';
      const t = Number(detail.time);
      if (Number.isFinite(t) && t >= 0) {
        return `speed · ${rateStr} @ ${formatMediaTime(t)}`;
      }
      return `speed · ${rateStr}`;
    }
    case 'room-create':
    case 'room-join':
    case 'room-leave':
    case 'become-host':
    case 'host-pass':
    case 'rename':
    case 'settings':
      return `${ev.type}${by ? ` · ${clip(by)}` : ''}${detail.name && detail.name !== by ? ` · ${clip(detail.name)}` : ''}`;
    default:
      return `${ev.type}${by ? ` · ${clip(by)}` : ''}`;
  }
}

function renderReplayEventList() {
  const list = els.replayEventList;
  if (!list) return;
  list.innerHTML = '';
  const r = state.replay;
  if (!r.active || !r.events.length) return;
  r.events.forEach((ev, i) => {
    const li = document.createElement('li');
    li.dataset.index = String(i);
    li.setAttribute('role', 'button');
    li.tabIndex = 0;
    const rel = formatReplayClock((ev.at || 0) - r.t0);
    li.innerHTML = `<span class="ev-time">${escapeHtml(rel)}</span><span class="ev-label">${escapeHtml(replayEventLabel(ev))}</span>`;
    li.addEventListener('click', () => seekReplayTo(i));
    li.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        seekReplayTo(i);
      }
    });
    list.appendChild(li);
  });
  highlightReplayEventList();
}

function highlightReplayEventList() {
  const list = els.replayEventList;
  if (!list) return;
  const r = state.replay;
  const items = list.querySelectorAll('li');
  items.forEach((li) => {
    const i = Number(li.dataset.index);
    const played = r.index > i;
    const active = r.index > 0 ? r.index - 1 === i : false;
    // When paused after seek to index, last applied is index-1 → active
    // Next upcoming (at r.index) gets a soft cue via not played
    li.classList.toggle('played', played && !active);
    li.classList.toggle('active', active);
  });
  const activeEl = list.querySelector('li.active');
  if (activeEl) {
    const listRect = list.getBoundingClientRect();
    const rowRect = activeEl.getBoundingClientRect();
    if (rowRect.top < listRect.top || rowRect.bottom > listRect.bottom) {
      activeEl.scrollIntoView({ block: 'nearest' });
    }
  }
}

function seekReplayTo(index) {
  const r = state.replay;
  if (!r.active || !r.events.length) return;
  const i = Math.max(0, Math.min(Number(index), r.events.length - 1));
  if (!Number.isFinite(i)) return;
  stopReplayTimers();
  stopReplayClockTicker();
  r.playing = false;
  r.statusNote = '';
  // Scrub applies must cue/pause — never autoplay historical play/next/rate events.
  r.scrubbing = true;
  resetReplayMedia();
  try {
    for (let j = 0; j <= i; j += 1) {
      applyReplayEvent(r.events[j]);
    }
  } finally {
    r.scrubbing = false;
  }
  r.index = i + 1;
  r.elapsedMs = (r.events[i].at || 0) - r.t0;
  updateReplayStatus();
}

function updateReplayStatus() {
  if (!els.replayStatus) return;
  const r = state.replay;
  if (!r.active || !r.events.length) {
    els.replayStatus.textContent = 'No session loaded';
    if (els.replayMeta) els.replayMeta.textContent = '';
    updateReplayClock();
    highlightReplayEventList();
    return;
  }
  const total = r.events.length;
  const idx = Math.min(r.index, total);
  const cur = r.index > 0 ? r.events[r.index - 1] : null;
  const type = cur ? cur.type : '(start)';
  const rel = cur ? formatReplayClock(cur.at - r.t0) : '0:00';
  const note = r.statusNote ? ` · ${r.statusNote}` : '';
  const playLabel = r.playing ? 'Playing' : 'Paused';
  els.replayStatus.textContent = `${playLabel} · ${idx}/${total} · ${type} @ ${rel}${note}`;
  if (els.replayMeta && r.meta) {
    const bits = [];
    if (r.meta.name) bits.push(r.meta.name);
    if (r.meta.roomId) bits.push(`room ${String(r.meta.roomId).slice(0, 8)}…`);
    if (r.meta.exportedAt) bits.push(`exported ${r.meta.exportedAt}`);
    els.replayMeta.textContent = bits.join(' · ');
  }
  if (els.replayPlay) els.replayPlay.disabled = r.playing || r.index >= total;
  if (els.replayPause) els.replayPause.disabled = !r.playing;
  if (els.replaySkip) els.replaySkip.disabled = r.index >= total;
  updateReplayClock();
  highlightReplayEventList();
}

function stopReplayTimers() {
  if (state.replay.timer != null) {
    clearTimeout(state.replay.timer);
    state.replay.timer = null;
  }
}

function replayElapsedMs() {
  const r = state.replay;
  if (!r.playing) return r.elapsedMs;
  return r.elapsedMs + (performance.now() - r.wallStart) * r.speed;
}

function getYtPlayerStateSafe() {
  try {
    if (state.player && typeof state.player.getPlayerState === 'function') {
      return state.player.getPlayerState();
    }
  } catch { /* ignore */ }
  return typeof YT !== 'undefined' && YT.PlayerState ? YT.PlayerState.UNSTARTED : -1;
}

function getPlayerVideoIdSafe() {
  try {
    if (state.player && typeof state.player.getVideoData === 'function') {
      const d = state.player.getVideoData();
      if (d && d.video_id) return d.video_id;
    }
  } catch { /* ignore */ }
  return null;
}

/** Clamp media time to duration when known (past-EOF seeks flake on short clips). */
function clampReplayMediaTime(t) {
  const n = Number(t);
  if (!Number.isFinite(n) || n < 0) return 0;
  try {
    if (state.player && typeof state.player.getDuration === 'function') {
      const d = state.player.getDuration();
      if (Number.isFinite(d) && d > 0) {
        return Math.min(n, Math.max(0, d - 0.25));
      }
    }
  } catch { /* ignore */ }
  return n;
}

/**
 * Wait until YT player is not UNSTARTED (-1), or timeout (~3s), then run cb.
 * Used so seek/play/pause/rate are not issued against an unstarted iframe.
 */
function isYtPlayerMediaReady(st) {
  if (typeof YT === 'undefined' || !YT.PlayerState) {
    return st === 1 || st === 2 || st === 3 || st === 5;
  }
  // Never treat UNSTARTED (-1) or ENDED (0) as ready — seeks no-op there.
  return (
    st === YT.PlayerState.PLAYING
    || st === YT.PlayerState.PAUSED
    || st === YT.PlayerState.BUFFERING
    || st === YT.PlayerState.CUED
  );
}

function whenPlayerReady(cb, { timeoutMs = 3000 } = {}) {
  const started = performance.now();
  const tick = () => {
    const st = getYtPlayerStateSafe();
    if (isYtPlayerMediaReady(st)) {
      cb();
      return;
    }
    if (performance.now() - started >= timeoutMs) {
      cb();
      return;
    }
    setTimeout(tick, 50);
  };
  tick();
}

/**
 * Robust media apply for session replay: load/cue if needed, wait for readiness,
 * clamp time, seek, set rate, then play or pause. Stale applies are dropped via
 * mediaApplySeq (seekReplayTo fires many events in one loop).
 *
 * Expected seek sequence:
 * 1) If video changed OR player UNSTARTED/ENDED → cueVideoById (pause) or
 *    loadVideoById (play) with startSeconds
 * 2) whenPlayerReady → not -1 (CUED/PLAYING/PAUSED/BUFFERING) or ~3s timeout
 * 3) clamp time to max(0, duration-0.25); seekTo; setPlaybackRate; play/pause
 * 4) If play=false, re-pause shortly after (loadVideoById can autoplay)
 */
function applyPlayerMedia({ videoId, time, rate, play } = {}) {
  const seq = ++state.replay.mediaApplySeq;
  const vid = videoId || state.videoId || DEFAULT_VIDEO;
  const hasTime = Number.isFinite(Number(time)) && Number(time) >= 0;
  const rawTime = hasTime ? Number(time) : undefined;
  const hasRate = Number.isFinite(Number(rate)) && Number(rate) > 0;
  const wantRate = hasRate ? Number(rate) : undefined;
  const scrubbing = !!(state.replay && state.replay.scrubbing);
  const wantPlay = scrubbing ? false : !!play;

  const stillCurrent = () => seq === state.replay.mediaApplySeq;

  const finish = () => {
    if (!stillCurrent() || !state.player) return;
    try {
      let t = rawTime;
      if (t != null) {
        t = clampReplayMediaTime(t);
        state.player.seekTo(t, true);
      }
      if (wantRate != null && typeof state.player.setPlaybackRate === 'function') {
        state.player.setPlaybackRate(wantRate);
      }
      if (wantPlay) state.player.playVideo();
      else state.player.pauseVideo();
    } catch { /* ignore */ }
    syncTransportUI();
    updateReplayClock();
    // YouTube often autoplays after loadVideoById — stick the pause
    if (!wantPlay) {
      setTimeout(() => {
        if (!stillCurrent() || !state.player) return;
        try {
          const st = getYtPlayerStateSafe();
          if (st === YT.PlayerState.PLAYING || st === YT.PlayerState.BUFFERING) {
            state.player.pauseVideo();
          }
        } catch { /* ignore */ }
        syncTransportUI();
        updateReplayClock();
      }, 120);
    }
  };

  const unstarted = typeof YT !== 'undefined' && YT.PlayerState
    ? YT.PlayerState.UNSTARTED
    : -1;
  const ended = typeof YT !== 'undefined' && YT.PlayerState
    ? YT.PlayerState.ENDED
    : 0;
  const st = getYtPlayerStateSafe();
  // Prefer the iframe's actual video_id — callers may already have updated state.videoId.
  // If getVideoData is unavailable, treat as changed so we still cue/load with startSeconds.
  const loadedVid = getPlayerVideoIdSafe();
  const videoChanged = !!(vid && (!loadedVid || loadedVid !== vid));
  const needsLoad = !state.player || videoChanged || st === unstarted || st === ended;

  const startSeconds = rawTime != null ? Math.max(0, rawTime) : 0;

  const afterReady = () => {
    if (!stillCurrent()) return;
    whenPlayerReady(() => {
      if (!stillCurrent()) return;
      finish();
    });
  };

  if (vid) {
    state.videoId = vid;
  }

  if (!state.player) {
    ensurePlayer(vid, afterReady, {
      startSeconds,
      cue: !wantPlay,
      waitReady: true,
    });
    return;
  }

  if (needsLoad) {
    state.applyingRemote = true;
    try {
      if (wantPlay) {
        state.player.loadVideoById({ videoId: vid, startSeconds });
      } else if (typeof state.player.cueVideoById === 'function') {
        state.player.cueVideoById({ videoId: vid, startSeconds });
      } else {
        state.player.loadVideoById({ videoId: vid, startSeconds });
      }
    } catch { /* ignore */ }
    setTimeout(() => { state.applyingRemote = false; }, 400);
    afterReady();
    return;
  }

  // Same video, player already past unstarted — seek/rate/transport directly
  finish();
}

function applyReplayVideo(videoId, title, { pushHistory = true, startSeconds = 0 } = {}) {
  if (!videoId) return;
  if (pushHistory && state.videoId && state.videoId !== videoId) pushHistoryCurrent();
  state.videoId = videoId;
  state.videoTitle = title || videoId;
  setNowPlayingLabel();
  renderQueue();
  const start = Number.isFinite(Number(startSeconds)) ? Math.max(0, Number(startSeconds)) : 0;
  const shouldPlay = !!(state.replay && state.replay.active && state.replay.playing && !state.replay.scrubbing);
  applyPlayerMedia({ videoId, time: start, rate: 1, play: shouldPlay });
}

/** Seek (and optionally set rate) then play or pause during session replay. */
function applyReplayPlayPause(detail, { play }) {
  if (detail.videoId && detail.videoId !== state.videoId) {
    state.videoTitle = detail.title || detail.videoId;
    setNowPlayingLabel();
    renderQueue();
  } else if (detail.title && detail.videoId) {
    state.videoTitle = detail.title;
    setNowPlayingLabel();
  }
  const rate = detail.rate != null ? Number(detail.rate) : NaN;
  applyPlayerMedia({
    videoId: detail.videoId || state.videoId,
    time: detail.time,
    rate: Number.isFinite(rate) && rate > 0 ? rate : undefined,
    play,
  });
}

function applyReplayEvent(ev) {
  if (!ev || !ev.type) return;
  const detail = ev.detail && typeof ev.detail === 'object' ? ev.detail : {};
  const by = ev.by || 'Someone';
  state.replay.statusNote = '';

  switch (ev.type) {
    case 'queue-add': {
      const ytId = detail.videoId;
      if (!ytId) {
        state.replay.statusNote = 'queue-add missing videoId';
        break;
      }
      const item = {
        id: detail.id || makeQueueItem(ytId).id,
        videoId: ytId,
        title: detail.title || ytId,
        addedBy: ev.peerId || null,
        addedByName: by,
      };
      state.queue.push(item);
      renderQueue();
      break;
    }
    case 'queue-add-playlist': {
      if (Array.isArray(detail.videos) && detail.videos.length) {
        for (const v of detail.videos) {
          if (!v || !v.videoId) continue;
          state.queue.push(makeQueueItem(v.videoId, v.title || v.videoId, ev.peerId, by));
        }
        renderQueue();
      } else {
        const count = detail.count != null ? detail.count : '?';
        const title = detail.playlistTitle || 'playlist';
        state.replay.statusNote = `playlist skipped (${count} from ${title})`;
        toast(`Replay: playlist videos not in log — skipped ${title}`);
      }
      break;
    }
    case 'queue-remove': {
      if (detail.id) {
        state.queue = state.queue.filter((q) => q.id !== detail.id);
        renderQueue();
      } else if (detail.videoId) {
        const idx = state.queue.findIndex((q) => q.videoId === detail.videoId);
        if (idx >= 0) {
          state.queue.splice(idx, 1);
          renderQueue();
        }
      }
      break;
    }
    case 'queue-reorder': {
      if (Array.isArray(detail.history) || Array.isArray(detail.queue)) {
        applyQueueOrder(detail.history || state.history, detail.queue || state.queue, { emit: false });
      } else {
        state.replay.statusNote = 'queue-reorder skipped (no order payload)';
      }
      break;
    }
    case 'next': {
      const vid = detail.videoId;
      if (vid) {
        const idx = state.queue.findIndex((q) => q.videoId === vid);
        if (idx >= 0) state.queue.splice(idx, 1);
        else if (state.queue.length) state.queue.shift();
      } else if (state.queue.length) {
        state.queue.shift();
      }
      if (vid) applyReplayVideo(vid, detail.title || vid, { pushHistory: true });
      else renderQueue();
      break;
    }
    case 'last': {
      if (state.videoId) {
        const current = makeQueueItem(state.videoId, state.videoTitle, ev.peerId, by);
        state.queue.unshift(current);
      }
      if (state.history.length) state.history.pop();
      if (detail.videoId) {
        applyReplayVideo(detail.videoId, detail.title || detail.videoId, { pushHistory: false });
      } else {
        renderQueue();
      }
      break;
    }
    case 'go': {
      if (detail.videoId) {
        applyReplayVideo(detail.videoId, detail.title || detail.videoId, { pushHistory: true });
      }
      break;
    }
    case 'play': {
      applyReplayPlayPause(detail, { play: true });
      break;
    }
    case 'pause': {
      applyReplayPlayPause(detail, { play: false });
      break;
    }
    case 'rate':
    case 'speed': {
      const rate = Number(detail.rate != null ? detail.rate : detail.speed);
      if (!Number.isFinite(rate) || rate <= 0) {
        state.replay.statusNote = 'rate/speed missing rate';
        break;
      }
      const keepPlaying = !!(state.replay.playing && !state.replay.scrubbing);
      applyReplayPlayPause({ ...detail, rate }, { play: keepPlaying });
      break;
    }
    case 'chat': {
      addPreviousChat(by, detail.text || '');
      break;
    }
    case 'rename':
    case 'room-create':
    case 'room-join':
    case 'become-host':
    case 'host-pass':
    case 'settings':
    case 'room-leave': {
      const bits = [ev.type];
      if (by) bits.push(`by ${by}`);
      if (detail.name) bits.push(detail.name);
      if (detail.role) bits.push(`(${detail.role})`);
      if (typeof detail.passHostOnLeave === 'boolean') {
        bits.push(`passHost=${detail.passHostOnLeave}`);
      }
      if (detail.newHostId) bits.push(`→ ${String(detail.newHostId).slice(0, 8)}`);
      state.replay.statusNote = bits.join(' ');
      if (ev.type === 'become-host' || ev.type === 'host-pass' || ev.type === 'room-create') {
        if (els.hostLabel && by) els.hostLabel.textContent = `Host: ${by} (replay)`;
      }
      break;
    }
    default:
      state.replay.statusNote = `ignored ${ev.type}`;
      break;
  }
}

function scheduleNextReplayEvent() {
  stopReplayTimers();
  const r = state.replay;
  if (!r.active || !r.playing) return;
  if (r.index >= r.events.length) {
    r.playing = false;
    r.elapsedMs = replayElapsedMs();
    stopReplayClockTicker();
    updateReplayStatus();
    toast('Replay finished');
    return;
  }
  const ev = r.events[r.index];
  const targetTimeline = ev.at - r.t0;
  const currentTimeline = r.elapsedMs + (performance.now() - r.wallStart) * r.speed;
  const waitWall = Math.max(0, (targetTimeline - currentTimeline) / r.speed);
  r.timer = setTimeout(() => {
    r.timer = null;
    r.elapsedMs = targetTimeline;
    r.wallStart = performance.now();
    r.index += 1;
    applyReplayEvent(ev);
    updateReplayStatus();
    scheduleNextReplayEvent();
  }, waitWall);
}

function pauseReplay() {
  const r = state.replay;
  if (!r.active || !r.playing) return;
  r.elapsedMs = replayElapsedMs();
  r.playing = false;
  stopReplayTimers();
  stopReplayClockTicker();
  updateReplayStatus();
}

function playReplay() {
  const r = state.replay;
  if (!r.active || !r.events.length) return;
  if (r.index >= r.events.length) {
    restartReplay({ autoplay: true });
    return;
  }
  if (r.playing) return;
  r.playing = true;
  r.wallStart = performance.now();
  updateReplayStatus();
  startReplayClockTicker();
  scheduleNextReplayEvent();
}

function skipReplayEvent() {
  const r = state.replay;
  if (!r.active || r.index >= r.events.length) return;
  const wasPlaying = r.playing;
  pauseReplay();
  const ev = r.events[r.index];
  r.index += 1;
  r.elapsedMs = ev.at - r.t0;
  applyReplayEvent(ev);
  updateReplayStatus();
  if (wasPlaying) playReplay();
}

function resetReplayMedia() {
  state.queue = [];
  state.history = [];
  state.selectedQueue = null;
  state.videoId = DEFAULT_VIDEO;
  state.videoTitle = 'Warm-up jam';
  state.advancing = false;
  clearPreviousChat();
  setNowPlayingLabel();
  renderQueue();
  syncTransportUI();
  if (state.player) {
    try { state.player.pauseVideo(); } catch { /* ignore */ }
  }
}

function restartReplay({ autoplay = false } = {}) {
  const r = state.replay;
  if (!r.active || !r.events.length) return;
  pauseReplay();
  r.index = 0;
  r.elapsedMs = 0;
  r.statusNote = '';
  resetReplayMedia();
  updateReplayStatus();
  if (autoplay) playReplay();
}

function enterReplayViewer() {
  // Show room UI without PeerJS for lobby-only replay
  els.lobby.classList.add('hidden');
  els.room.classList.remove('hidden');
  setRoomActive(true);
  if (els.hostControls) els.hostControls.classList.add('hidden');
  if (els.guestNote) {
    els.guestNote.classList.remove('hidden');
    els.guestNote.textContent = 'Replay mode — watching a recorded session (no live peers).';
  }
  syncMobileNameInputs();
  setMobileTab(state.mobileTab || 'queue');
  syncPassHostUI();
  renderPeers();
  renderQueue();
  syncTransportUI();
  if (!state.player) ensurePlayer(DEFAULT_VIDEO);
}

function leaveReplayViewer() {
  if (state.player) {
    try { state.player.destroy(); } catch { /* ignore */ }
    state.player = null;
    state.ytReady = false;
    const mount = document.getElementById('yt-player');
    if (mount) mount.innerHTML = '';
  }
  state.queue = [];
  state.history = [];
  state.videoId = DEFAULT_VIDEO;
  state.videoTitle = 'Warm-up jam';
  if (els.chatLogPrevious) els.chatLogPrevious.innerHTML = '';
  if (els.guestNote) {
    els.guestNote.textContent = 'You’re a guest — playback follows the host. Anyone can add to the queue!';
  }
  els.room.classList.add('hidden');
  els.lobby.classList.remove('hidden');
  setRoomActive(false);
  setStatus('Idle');
  renderQueue();
}

function exitReplay() {
  const lobbyOnly = state.replay.lobbyOnly;
  pauseReplay();
  stopReplayClockTicker();
  state.replay.active = false;
  state.replay.events = [];
  state.replay.index = 0;
  state.replay.meta = null;
  state.replay.lobbyOnly = false;
  state.replay.statusNote = '';
  document.body.classList.remove('replay-active');
  if (els.playbackBar) els.playbackBar.classList.add('hidden');
  if (els.replayEventList) els.replayEventList.innerHTML = '';
  clearPreviousChat();
  setChatTab('current');
  updateReplayStatus();
  if (lobbyOnly && !state.role) {
    leaveReplayViewer();
  } else if (state.role === 'guest' && state.hostId) {
    // Refresh live state from host after leaving replay overlay
    for (const conn of state.connections.values()) {
      sendTo(conn, { type: 'request-state' });
      break;
    }
  } else if (state.role) {
    showRoom();
  }
  toast('Exited replay');
}

function loadSessionForPlayback(data) {
  if (!data || data.app !== 'youtube-shquared') {
    toast('Not a youtube-shquared session file');
    return;
  }
  const events = Array.isArray(data.events) ? data.events.slice() : [];
  events.sort((a, b) => (a.at || 0) - (b.at || 0));
  if (!events.length) {
    toast('Session has no events');
    return;
  }

  pauseReplay();
  const lobbyOnly = !state.role;
  state.replay.active = true;
  state.replay.lobbyOnly = lobbyOnly;
  state.replay.events = events;
  state.replay.index = 0;
  state.replay.elapsedMs = 0;
  state.replay.speed = Number(els.replaySpeed?.value) || 1;
  state.replay.t0 = events[0].at || 0;
  state.replay.meta = {
    name: data.name || '',
    roomId: data.roomId || '',
    exportedAt: data.exportedAt || '',
    exporter: data.exporter || '',
  };
  state.replay.statusNote = '';
  document.body.classList.add('replay-active');
  if (els.playbackBar) {
    els.playbackBar.classList.remove('hidden');
    collapsePlaybackEventsForMobile();
  }

  resetReplayMedia();
  if (lobbyOnly) enterReplayViewer();
  else {
    // Keep live Current chat; just reset local player/queue for replay overlay
    if (els.hostLabel && data.name) {
      els.hostLabel.textContent = `Host: ${data.name} (replay)`;
    }
  }

  setChatTab('current');
  renderReplayEventList();
  updateReplayStatus();
  toast(`Loaded ${events.length} events — press Play`);
}

function onSessionFileSelected(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(String(reader.result || ''));
      loadSessionForPlayback(data);
    } catch (err) {
      console.warn(err);
      toast('Could not parse session JSON');
    }
  };
  reader.onerror = () => toast('Could not read file');
  reader.readAsText(file);
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
  if (state.role === 'host') {
    broadcast(queuePayload());
    if (state.persistWhenEmpty) saveHostSession();
  }
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
  let moved = false;
  if (target >= 0 && target < list.length) {
    // Same list: moveQueueItem insertAt uses pre-splice index; down needs +2
    const toIndex = dir > 0 ? index + 2 : index - 1;
    moveQueueItem(kind, index, kind, toIndex);
    moved = true;
  } else if (kind === 'upcoming' && dir === -1 && index === 0) {
    moveQueueItem('upcoming', 0, 'played', state.history.length);
    moved = true;
  } else if (kind === 'played' && dir === 1 && index === list.length - 1) {
    moveQueueItem('played', index, 'upcoming', 0);
    moved = true;
  }
  if (moved) {
    logSession('queue-reorder', {
      kind,
      index,
      dir: dir < 0 ? 'up' : 'down',
      title: item?.title || item?.videoId || null,
      videoId: item?.videoId || null,
    });
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
  if (state.replay.active) return;
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
  const item = state.queue.find((q) => q.id === qid);
  if (state.role === 'host') {
    removeFromQueueLocal(qid);
    emitQueue();
    logSession('queue-remove', {
      id: qid,
      title: item?.title || null,
      videoId: item?.videoId || null,
    });
  } else {
    broadcast({ type: 'queue-remove', id: qid, peerId: state.peer?.id });
    logSession('queue-remove', {
      id: qid,
      title: item?.title || null,
      videoId: item?.videoId || null,
      requested: true,
    }, { sync: false });
  }
}

async function requestAddToQueue(raw) {
  if (state.replay.active) { toast('Pause or exit replay to edit the queue'); return; }
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
    logSession('queue-add', {
      id: item.id,
      videoId: item.videoId,
      title: item.title,
      duplicate: !!alreadyQueued,
    });
    toast(alreadyQueued ? `Queued again: ${title}` : `Queued: ${title}`);
    // If nothing meaningful is playing / ended, start it
    maybeAutoStartQueue();
  } else {
    broadcast({ type: 'queue-add', item });
    logSession('queue-add', {
      id: item.id,
      videoId: item.videoId,
      title: item.title,
      duplicate: !!alreadyQueued,
      requested: true,
    }, { sync: false });
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
    logSession('queue-add-playlist', {
      count: items.length,
      playlistTitle: plTitle,
      playlistId,
    });
    toast(`Queued ${items.length} from ${plTitle}`);
    maybeAutoStartQueue();
  } else {
    broadcast({ type: 'queue-add-many', items, playlistTitle: plTitle });
    logSession('queue-add-playlist', {
      count: items.length,
      playlistTitle: plTitle,
      playlistId,
      requested: true,
    }, { sync: false });
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
  if (state.replay.active) { toast('Pause or exit replay to control live playback'); return; }
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

function playNextFromQueue({ auto = false } = {}) {
  if (state.replay.active) return;
  if (state.role !== 'host' || state.advancing) return;
  if (!state.queue.length) {
    toast('Queue is empty');
    syncTransportUI();
    return;
  }
  const next = state.queue.shift();
  logSession('next', {
    videoId: next.videoId,
    title: next.title || next.videoId,
    auto: !!auto,
  });
  playVideoNow(next.videoId, next.title || next.videoId, { pushHistory: true });
}

function playPreviousFromHistory() {
  if (state.replay.active) { toast('Pause or exit replay to control live playback'); return; }
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
  logSession('last', {
    videoId: prev.videoId,
    title: prev.title,
  });
  playVideoNow(prev.videoId, prev.title, { pushHistory: false });
}

function togglePlayPause() {
  if (state.replay.active) { toast('Pause or exit replay to control live playback'); return; }
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
  if (state.replay.active) { toast('Pause or exit replay to control live playback'); return; }
  if (state.role !== 'host') return;
  const id = extractVideoId(raw);
  if (!id) {
    toast('Paste a valid YouTube URL or 11-character video ID');
    return;
  }
  const title = await fetchVideoTitle(id);
  logSession('go', { videoId: id, title });
  playVideoNow(id, title, { pushHistory: true });
  if (els.videoInput) els.videoInput.value = '';
}


function settingsPayload() {
  return {
    type: 'settings',
    passHostOnLeave: !!state.passHostOnLeave,
    persistWhenEmpty: !!state.persistWhenEmpty,
    recordingEnabled: !!state.recordingEnabled,
    sessionName: state.sessionName || defaultSessionName(),
  };
}

function emitSettings() {
  if (state.role === 'host') broadcast(settingsPayload());
}

function syncPassHostUI() {
  if (els.passHostToggle) els.passHostToggle.checked = !!state.passHostOnLeave;
  if (els.passHostToggleMobile) els.passHostToggleMobile.checked = !!state.passHostOnLeave;
  if (els.passHostCreate && state.role !== 'host' && state.role !== 'guest') {
    // lobby only — leave create checkbox alone while in room
  }
  if (els.room) els.room.classList.toggle('is-host', state.role === 'host');
}

function setPassHostOnLeave(on, { emit = true } = {}) {
  const next = !!on;
  const changed = next !== !!state.passHostOnLeave;
  state.passHostOnLeave = next;
  syncPassHostUI();
  if (state.role === 'host') saveHostSession();
  if (emit && state.role === 'host') emitSettings();
  if (changed && state.role === 'host' && emit) {
    logSession('settings', { passHostOnLeave: next });
  }
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
  logSession('become-host', { previousHost: previousHost || null });
  // Push authoritative playback + queue as people reconnect (also on hello)
  emitState();
  emitQueue();
  emitSettings();
  renderPeers();
  announceRoomNow();
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
    if (state.persistWhenEmpty) {
      parkSession();
      return;
    }
    destroySession();
    return;
  }
  broadcast({
    type: 'host-pass',
    newHostId: elected,
    passHostOnLeave: state.passHostOnLeave,
    persistWhenEmpty: state.persistWhenEmpty,
    recordingEnabled: state.recordingEnabled,
  });
  logSession('host-pass', { newHostId: elected }, { sync: false });
  setStatus('Passing host…', 'warn');
  toast('Passing host to a guest…');
  setTimeout(() => destroySession(), 450);
}

function leaveRoom() {
  logSession('room-leave', { role: state.role, roomId: state.hostId || state.peer?.id }, { sync: false });
  // Empty host leave with "keep open" — park peer + queue, stay discoverable
  if (state.role === 'host' && state.persistWhenEmpty && state.connections.size === 0) {
    parkSession();
    return;
  }
  // Intentional leave — don't reclaim this room on refresh (unless parked above)
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
  if (state.replay.active || state.role !== 'host') return;
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

function addChat(name, text, peerId, { log = true } = {}) {
  const line = document.createElement('div');
  line.className = 'chat-line';
  if (peerId) line.dataset.peerId = peerId;
  line.innerHTML = `<span class="who">${escapeHtml(name)}</span><span>${escapeHtml(text)}</span>`;
  els.chatLogCurrent.appendChild(line);
  els.chatLogCurrent.scrollTop = els.chatLogCurrent.scrollHeight;
  if (log && text) {
    logSession('chat', { text }, {
      by: name,
      peerId: peerId || null,
      sync: false,
    });
  }
}

function rewriteChatNames(peerId, newName) {
  if (!peerId) return;
  const lines = els.chatLogCurrent.querySelectorAll(`.chat-line[data-peer-id="${CSS.escape(peerId)}"] .who`);
  for (const who of lines) who.textContent = newName;
}

function applyRename(peerId, newName) {
  const name = String(newName || '').trim().slice(0, 24);
  if (!peerId || !name) return;
  if (peerId === state.peer?.id) {
    state.name = name;
    els.name.value = name;
    if (els.roomName) els.roomName.value = name;
    if (els.peopleName) els.peopleName.value = name;
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
  logSession('rename', { oldName, name }, { sync: false });
  if (state.role === 'host') {
    saveHostSession();
    announceRoomNow();
  }
  toast(`Renamed to ${name}`);
}

function ensurePlayer(videoId, onReady, opts = {}) {
  state.videoId = videoId;
  const startRaw = opts.startSeconds;
  const startSeconds = Number.isFinite(Number(startRaw)) ? Math.max(0, Number(startRaw)) : undefined;
  const useCue = !!opts.cue;
  const waitReady = !!opts.waitReady;
  const invokeReady = () => {
    if (waitReady) whenPlayerReady(() => onReady?.());
    else onReady?.();
  };
  if (state.player) {
    state.applyingRemote = true;
    try {
      if (useCue && typeof state.player.cueVideoById === 'function') {
        if (startSeconds != null) state.player.cueVideoById({ videoId, startSeconds });
        else state.player.cueVideoById(videoId);
      } else if (startSeconds != null) {
        state.player.loadVideoById({ videoId, startSeconds });
      } else {
        state.player.loadVideoById(videoId);
      }
    } catch { /* ignore */ }
    setTimeout(() => { state.applyingRemote = false; }, 400);
    // Existing-player load/cue is async — optionally wait past UNSTARTED (-1)
    invokeReady();
    return;
  }
  const playerVars = {
    autoplay: 0,
    modestbranding: 1,
    rel: 0,
    playsinline: 1,
    enablejsapi: 1,
    origin: location.origin,
  };
  if (startSeconds != null) playerVars.start = Math.floor(startSeconds);
  state.player = new YT.Player('yt-player', {
    videoId,
    playerVars,
    events: {
      onReady: () => {
        state.ytReady = true;
        // Fresh player: optionally cue to startSeconds without autoplay
        if (useCue && startSeconds != null && typeof state.player.cueVideoById === 'function') {
          try {
            state.player.cueVideoById({ videoId, startSeconds });
          } catch { /* ignore */ }
        }
        invokeReady();
      },
      onStateChange: (e) => {
        syncTransportUI();
        if (state.replay && state.replay.active) updateReplayClock();
        if (state.role === 'host' && !state.applyingRemote && !state.replay.active) {
          logPlaybackTransition(e.data);
        }
        if (state.replay.active || state.role !== 'host' || state.applyingRemote) return;
        if (e.data === YT.PlayerState.PLAYING || e.data === YT.PlayerState.PAUSED || e.data === YT.PlayerState.BUFFERING) {
          emitState();
        }
        if (e.data === YT.PlayerState.ENDED) {
          if (state.replay.active) return;
          playNextFromQueue({ auto: true });
        }
      },
      onPlaybackRateChange: (e) => {
        if (state.role === 'host' && !state.applyingRemote && !state.replay.active) {
          logPlaybackRateChange(e.data);
        }
      },
    },
  });
}

function applyRemoteState(msg) {
  if (state.replay.active || state.role === 'host') return;
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
        logSession('room-join', {
          role: msg.role || 'guest',
          name: msg.name || 'Guest',
          roomId: state.hostId,
        }, { by: msg.name || 'Guest', peerId: fromId, sync: false });
        announceRoomNow();
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
        logSession('room-join', {
          role: msg.role || 'guest',
          name: msg.name || 'Guest',
          roomId: state.hostId,
        }, { by: msg.name || 'Guest', peerId: msg.id, sync: false });
      }
      break;
    }
    case 'peer-leave': {
      if (msg.id) {
        const left = state.peers.get(msg.id);
        state.peers.delete(msg.id);
        renderPeers();
        logSession('room-leave', {
          role: left?.role || 'guest',
          name: left?.name || 'Guest',
          roomId: state.hostId,
        }, { by: left?.name || 'Guest', peerId: msg.id, sync: false });
      }
      break;
    }
    case 'request-state': {
      if (state.role === 'host') {
        const conn = state.connections.get(fromId);
        sendTo(conn, { type: 'state', ...currentPlayback() });
        sendTo(conn, queuePayload());
        sendTo(conn, settingsPayload());
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
      // Self rename already logged in renameSelf; host syncs guest renames
      if (pid !== state.peer?.id) {
        logSession('rename', {
          oldName: msg.oldName || null,
          name: msg.name,
        }, {
          by: msg.name,
          peerId: pid,
          sync: false,
        });
      }
      if (state.role === 'host') {
        broadcast({ type: 'rename', peerId: pid, name: msg.name, oldName: msg.oldName }, fromId);
        announceRoomNow();
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
        logSession('queue-add', {
          id: item.id,
          videoId: item.videoId,
          title: item.title,
        }, { by: item.addedByName, peerId: item.addedBy });
        maybeAutoStartQueue();
      } else if (state.role !== 'host') {
        // Relayed copy for display if host echoed — ignore; wait for queue-sync
      }
      break;
    }
    case 'queue-add-many': {
      if (state.role === 'host' && Array.isArray(msg.items)) {
        const guestName = state.peers.get(fromId)?.name || 'Guest';
        let added = 0;
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
          added += 1;
        }
        renderQueue();
        emitQueue();
        if (added) {
          logSession('queue-add-playlist', {
            count: added,
            playlistTitle: msg.playlistTitle || null,
          }, { by: guestName, peerId: fromId });
        }
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
          const who = state.peers.get(fromId)?.name || item.addedByName || 'Guest';
          logSession('queue-remove', {
            id: msg.id,
            title: item.title || null,
            videoId: item.videoId || null,
          }, { by: who, peerId: fromId });
        }
      }
      break;
    }
    case 'queue-reorder': {
      if (state.role === 'host') {
        applyQueueOrder(msg.history, msg.queue, { emit: true });
        const who = state.peers.get(fromId)?.name || 'Guest';
        logSession('queue-reorder', { fromGuest: true }, { by: who, peerId: fromId });
      }
      break;
    }
    case 'settings': {
      if (typeof msg.passHostOnLeave === 'boolean') {
        state.passHostOnLeave = msg.passHostOnLeave;
        syncPassHostUI();
        // Host already broadcasts session-log for settings; guests ingest that.
      }
      if (typeof msg.persistWhenEmpty === 'boolean') {
        state.persistWhenEmpty = msg.persistWhenEmpty;
      }
      if (typeof msg.recordingEnabled === 'boolean') {
        applyRecordingEnabled(msg.recordingEnabled, { fromRemote: true });
      }
      if (typeof msg.sessionName === 'string' && msg.sessionName.trim()) {
        state.sessionName = msg.sessionName.trim().slice(0, 40);
        updateSessionTitle();
      }
      break;
    }
    case 'host-pass': {
      if (msg.newHostId) {
        if (typeof msg.passHostOnLeave === 'boolean') state.passHostOnLeave = msg.passHostOnLeave;
        if (typeof msg.persistWhenEmpty === 'boolean') state.persistWhenEmpty = msg.persistWhenEmpty;
        if (typeof msg.recordingEnabled === 'boolean') {
          applyRecordingEnabled(msg.recordingEnabled, { fromRemote: true });
        }
        clearTimeout(state.recoverTimer);
        state.recoverTimer = null;
        state.recoveringHost = false;
        const oldHost = state.hostId || fromId;
        logSession('host-pass', {
          newHostId: msg.newHostId,
          previousHost: oldHost,
        }, { sync: false });
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
    case 'session-log': {
      if (msg.event) ingestSessionLogEvent(msg.event);
      break;
    }
    default:
      break;
  }
}

function wireConnection(conn, remoteRoleHint = 'guest') {
  conn.on('open', () => {
    state.connections.set(conn.peer, conn);
    if (state.role === 'host' && state.parked) {
      unparkSession({ toastMsg: 'Someone hopped in — room resumed!' });
    }
    sendTo(conn, { type: 'hello', role: state.role, peerId: state.peer.id, name: state.name });
    if (state.role === 'guest') sendTo(conn, { type: 'request-state' });
    renderPeers();
    setStatus(state.role === 'host' ? `Host · ${state.connections.size} linked` : 'Connected', 'ok');
  });

  conn.on('data', (data) => handleMessage(conn.peer, data));

  conn.on('close', () => {
    const wasHostConn = state.role === 'guest' && conn.peer === state.hostId;
    const deadId = conn.peer;
    const left = state.peers.get(conn.peer);
    state.connections.delete(conn.peer);
    state.peers.delete(conn.peer);
    if (state.role === 'host') {
      broadcast({ type: 'peer-leave', id: conn.peer });
      logSession('room-leave', {
        role: left?.role || 'guest',
        name: left?.name || 'Guest',
        roomId: state.hostId,
      }, { by: left?.name || 'Guest', peerId: deadId, sync: false });
      announceRoomNow();
    }
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


const MOBILE_TABS = ['queue', 'chat', 'people'];


function collapsePlaybackEventsForMobile() {
  const disc = document.querySelector('.playback-events-disclosure');
  if (!disc) return;
  const narrow = window.matchMedia && window.matchMedia('(max-width: 900px)').matches;
  if (narrow) disc.open = false;
  else disc.open = true;
}

function setRoomActive(on) {
  document.body.classList.toggle('room-active', !!on);
  if (els.mobileTabBar) {
    if (on) els.mobileTabBar.removeAttribute('hidden');
    else els.mobileTabBar.setAttribute('hidden', '');
  }
}

function setMobileTab(tab) {
  const next = MOBILE_TABS.includes(tab) ? tab : 'queue';
  state.mobileTab = next;
  if (els.room) {
    els.room.classList.remove('tab-queue', 'tab-chat', 'tab-people');
    els.room.classList.add(`tab-${next}`);
  }
  if (els.mobileTabBar) {
    for (const btn of els.mobileTabBar.querySelectorAll('.mobile-tab')) {
      const active = btn.getAttribute('data-mobile-tab') === next;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
    }
  }
}

function syncMobileNameInputs() {
  const name = state.name || '';
  if (els.roomName && document.activeElement !== els.roomName) els.roomName.value = name;
  if (els.peopleName && document.activeElement !== els.peopleName) els.peopleName.value = name;
}

function wireMobileTabs() {
  if (els.mobileTabBar) {
    els.mobileTabBar.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-mobile-tab]');
      if (!btn || !els.mobileTabBar.contains(btn)) return;
      setMobileTab(btn.getAttribute('data-mobile-tab'));
    });
  }

  const panels = els.mobilePanels;
  if (!panels) return;
  let startX = 0;
  let startY = 0;
  let tracking = false;

  panels.addEventListener('touchstart', (e) => {
    if (!e.changedTouches || !e.changedTouches[0]) return;
    // Ignore swipes that begin on form fields
    const t = e.target;
    if (t && (t.closest('input, textarea, select, button, a, summary'))) return;
    tracking = true;
    startX = e.changedTouches[0].clientX;
    startY = e.changedTouches[0].clientY;
  }, { passive: true });

  panels.addEventListener('touchend', (e) => {
    if (!tracking || !e.changedTouches || !e.changedTouches[0]) return;
    tracking = false;
    const dx = e.changedTouches[0].clientX - startX;
    const dy = e.changedTouches[0].clientY - startY;
    if (Math.abs(dx) < 40 || Math.abs(dx) < Math.abs(dy)) return;
    const idx = MOBILE_TABS.indexOf(state.mobileTab);
    if (idx < 0) return;
    if (dx < 0 && idx < MOBILE_TABS.length - 1) setMobileTab(MOBILE_TABS[idx + 1]);
    else if (dx > 0 && idx > 0) setMobileTab(MOBILE_TABS[idx - 1]);
  }, { passive: true });

  panels.addEventListener('touchcancel', () => { tracking = false; }, { passive: true });
}

function syncRecordingUI() {
  const on = !!state.recordingEnabled;
  document.body.classList.toggle('recording-off', !on);
  if (els.sessionLogExport) {
    els.sessionLogExport.classList.toggle('hidden', !on);
    els.sessionLogExport.hidden = !on;
    // Keep load-for-playback available only when recording is on (exportable log)
    const loadLabel = els.sessionLogExport.querySelector('label.load-session-btn, label[for="load-session-input-room"]');
    const loadInput = els.loadSessionRoom;
    if (loadLabel) loadLabel.classList.toggle('hidden', !on);
    if (loadInput) loadInput.disabled = !on;
  }
  if (els.exportLog) {
    els.exportLog.disabled = !on;
    els.exportLog.title = on
      ? 'Download this visit’s action log'
      : 'Recording is off for this room';
  }
}

function applyRecordingEnabled(on, { fromRemote = false } = {}) {
  const next = !!on;
  const changed = next !== !!state.recordingEnabled;
  state.recordingEnabled = next;
  state.recordingSettingsReady = true;
  if (!next) {
    clearSessionLog();
    hideRecordingNotice();
  }
  syncRecordingUI();
  if (next && (state.role === 'host' || state.role === 'guest') && !state.parked) {
    // Entering / learning recording is on — require ack unless already dismissed this visit
    if (changed || fromRemote) state.recordingNoticeAcked = false;
    maybeShowRecordingNotice();
  }
  if (!fromRemote && state.role === 'host') {
    saveHostSession();
    emitSettings();
  }
}

function showRecordingNotice() {
  const modal = els.recordingModal;
  if (!modal) return;
  modal.classList.remove('hidden');
  modal.hidden = false;
  document.body.classList.add('modal-open');
  // Prefer focusing the dismiss button for a11y
  setTimeout(() => els.recordingModalOk?.focus(), 30);
}

function hideRecordingNotice() {
  const modal = els.recordingModal;
  if (!modal) return;
  modal.classList.add('hidden');
  modal.hidden = true;
  document.body.classList.remove('modal-open');
}

function ackRecordingNotice() {
  state.recordingNoticeAcked = true;
  hideRecordingNotice();
}

function maybeShowRecordingNotice() {
  if (!state.recordingEnabled) {
    hideRecordingNotice();
    return;
  }
  if (!state.recordingSettingsReady) return;
  if (state.parked) return;
  if (state.role !== 'host' && state.role !== 'guest') return;
  if (state.recordingNoticeAcked) return;
  showRecordingNotice();
}

function showRoom() {
  els.lobby.classList.add('hidden');
  els.room.classList.remove('hidden');
  setRoomActive(true);
  const isHost = state.role === 'host';
  els.hostControls.classList.toggle('hidden', !isHost);
  els.guestNote.classList.toggle('hidden', isHost);
  syncMobileNameInputs();
  setMobileTab(state.mobileTab || 'queue');
  syncPassHostUI();
  syncTransportUI();
  updateSessionTitle();
  syncHowtoBanner();
  syncRecordingUI();
  renderPeers();
  renderQueue();
  maybeShowRecordingNotice();
}

function readPersistRoomsStore() {
  try {
    const raw = localStorage.getItem(PERSIST_ROOMS_KEY);
    if (!raw) return {};
    const data = JSON.parse(raw);
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

function writePersistRoomsStore(map) {
  try {
    localStorage.setItem(PERSIST_ROOMS_KEY, JSON.stringify(map));
  } catch { /* ignore quota */ }
}

function snapshotPersistableMedia() {
  return {
    queue: (state.queue || []).map((q) => ({
      id: q.id,
      videoId: q.videoId,
      title: q.title,
      addedBy: q.addedBy || null,
      addedByName: q.addedByName || null,
    })),
    history: (state.history || []).map((h) => ({
      id: h.id,
      videoId: h.videoId,
      title: h.title,
    })),
    videoId: state.videoId || DEFAULT_VIDEO,
    videoTitle: state.videoTitle || 'Warm-up jam',
  };
}

function applyPersistedMedia(snap) {
  if (!snap || typeof snap !== 'object') return;
  if (Array.isArray(snap.queue)) state.queue = snap.queue.slice();
  if (Array.isArray(snap.history)) state.history = snap.history.slice();
  if (typeof snap.videoId === 'string' && snap.videoId) state.videoId = snap.videoId;
  if (typeof snap.videoTitle === 'string' && snap.videoTitle) state.videoTitle = snap.videoTitle;
  renderQueue();
  syncTransportUI();
}

function savePersistedRoom(roomId = null) {
  const id = roomId || state.hostId || state.peer?.id;
  if (!id || !state.persistWhenEmpty) return;
  const store = readPersistRoomsStore();
  store[id] = {
    roomId: id,
    sessionName: state.sessionName || defaultSessionName(),
    name: state.name || '',
    passHostOnLeave: !!state.passHostOnLeave,
    persistWhenEmpty: true,
    ...snapshotPersistableMedia(),
    savedAt: Date.now(),
  };
  writePersistRoomsStore(store);
}

function loadPersistedRoom(roomId) {
  if (!roomId) return null;
  const store = readPersistRoomsStore();
  const row = store[roomId];
  if (!row || typeof row !== 'object') return null;
  return row;
}

function clearPersistedRoom(roomId) {
  if (!roomId) return;
  const store = readPersistRoomsStore();
  if (store[roomId]) {
    delete store[roomId];
    writePersistRoomsStore(store);
  }
}

/** Soft-leave: keep PeerJS peer + queue alive, return to lobby, stay discoverable. */
function parkSession() {
  if (state.role !== 'host' || !state.peer?.id) {
    destroySession();
    return;
  }
  state.parked = true;
  state.persistWhenEmpty = true;
  hideRecordingNotice();
  saveHostSession();
  savePersistedRoom();
  // Drop UI into lobby while peer keeps accepting joins
  els.room.classList.add('hidden');
  els.lobby.classList.remove('hidden');
  setRoomActive(false);
  setStatus('Parked · room still open', 'ok');
  announceRoomNow();
  renderActiveSessions();
  logSession('room-park', {
    roomId: state.hostId || state.peer.id,
    queueCount: state.queue.length,
  }, { sync: false });
  toast('Lights stay on! Room is empty but the queue sticks around 🎨');
}

function unparkSession({ toastMsg = 'Welcome back — room resumed' } = {}) {
  if (!state.parked) return;
  state.parked = false;
  state.recordingNoticeAcked = false;
  showRoom();
  ensurePlayer(state.videoId || DEFAULT_VIDEO);
  startHostTick();
  saveHostSession();
  savePersistedRoom();
  announceRoomNow();
  setStatus(state.connections.size ? `Host · ${state.connections.size} linked` : 'Host · waiting', 'ok');
  if (toastMsg) toast(toastMsg);
}

function resumeParkedRoom() {
  if (state.role === 'host' && state.parked) {
    unparkSession();
    return true;
  }
  return false;
}

function destroySession() {
  const leavingRoomId = state.role === 'host' ? (state.hostId || state.peer?.id) : null;
  if (leavingRoomId) {
    unannounceRoom(leavingRoomId);
    clearPersistedRoom(leavingRoomId);
  }
  stopReplayTimers();
  state.replay.active = false;
  state.replay.lobbyOnly = false;
  state.replay.events = [];
  state.replay.index = 0;
  state.replay.meta = null;
  document.body.classList.remove('replay-active');
  if (els.playbackBar) els.playbackBar.classList.add('hidden');
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
  state.sessionName = '';
  updateSessionTitle();
  state.acceptingConnections = false;
  state.recoveringHost = false;
  clearTimeout(state.recoverTimer);
  state.recoverTimer = null;
  state.passHostOnLeave = els.passHostCreate ? !!els.passHostCreate.checked : true;
  state.persistWhenEmpty = els.persistEmptyCreate ? !!els.persistEmptyCreate.checked : false;
  state.recordingEnabled = els.recordSessionCreate ? !!els.recordSessionCreate.checked : true;
  state.recordingNoticeAcked = false;
  state.recordingSettingsReady = false;
  state.parked = false;
  hideRecordingNotice();
  syncPassHostUI();
  syncRecordingUI();
  if (state.player) {
    try { state.player.destroy(); } catch { /* ignore */ }
    state.player = null;
    state.ytReady = false;
    const mount = document.getElementById('yt-player');
    if (mount) mount.innerHTML = '';
  }
  if (els.chatLogCurrent) els.chatLogCurrent.innerHTML = '';
  if (els.chatLogPrevious) els.chatLogPrevious.innerHTML = '';
  state.queue = [];
  state.history = [];
  state.videoTitle = 'Warm-up jam';
  clearSessionLog();
  renderQueue();
  syncTransportUI();
  els.room.classList.add('hidden');
  els.lobby.classList.remove('hidden');
  setRoomActive(false);
  setStatus('Idle');
  const u = new URL(location.href);
  u.searchParams.delete('room');
  history.replaceState(null, '', u.pathname + u.search);
  renderActiveSessions();
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
      sessionName: state.sessionName || '',
      passHostOnLeave: !!state.passHostOnLeave,
      persistWhenEmpty: !!state.persistWhenEmpty,
      recordingEnabled: !!state.recordingEnabled,
      parked: !!state.parked,
      ...snapshotPersistableMedia(),
      savedAt: Date.now(),
    }));
  } catch { /* ignore quota */ }
  if (state.persistWhenEmpty) savePersistedRoom(state.hostId);
}

function clearHostSession() {
  try { sessionStorage.removeItem(HOST_SESSION_KEY); } catch { /* ignore */ }
}

function directoryPeerId() {
  // Scope by origin so local/prod lobbies don't mix on the shared PeerJS cloud.
  const raw = (location.origin || 'local').replace(/[^a-zA-Z0-9]/g, '');
  const key = (raw.slice(-36) || 'local').toLowerCase();
  return (`ysqdir${key}`).slice(0, 60);
}

function defaultSessionName() {
  const n = (state.name || els.name?.value || 'Jam').trim() || 'Jam';
  return `${n}'s room`;
}

function readSessionNameInput() {
  const raw = (els.sessionNameInput?.value || '').trim();
  return raw.slice(0, 40);
}

function setSessionName(name, { emit = false } = {}) {
  const next = String(name || '').trim().slice(0, 40) || defaultSessionName();
  state.sessionName = next;
  if (els.sessionNameInput && document.activeElement !== els.sessionNameInput) {
    // Keep lobby field in sync when returning from a room
  }
  updateSessionTitle();
  if (emit && state.role === 'host') {
    emitSettings();
    announceRoomNow();
  }
}

function updateSessionTitle() {
  if (!els.sessionTitle) return;
  const label = state.sessionName || '—';
  els.sessionTitle.textContent = `Session: ${label}`;
  els.sessionTitle.title = label;
}

function isHowtoDismissed() {
  try { return localStorage.getItem(HOWTO_DISMISS_KEY) === '1'; } catch { return false; }
}

function syncHowtoBanner() {
  if (!els.howtoBanner) return;
  const show = !isHowtoDismissed();
  els.howtoBanner.classList.toggle('hidden', !show);
}

function dismissHowto() {
  try { localStorage.setItem(HOWTO_DISMISS_KEY, '1'); } catch { /* ignore */ }
  syncHowtoBanner();
}

function participantSnapshot() {
  const rows = [];
  if (state.peer?.id) {
    rows.push({ name: state.name || 'Someone', role: state.role || 'guest' });
  }
  for (const [id, info] of state.peers) {
    if (id === state.peer?.id) continue;
    rows.push({ name: info.name || 'Someone', role: info.role || 'guest' });
  }
  return rows;
}

function roomDirectoryEntry() {
  const roomId = state.hostId || state.peer?.id;
  if (!roomId || state.role !== 'host') return null;
  let hostName = state.name || 'Host';
  const participants = state.parked ? [] : participantSnapshot();
  return {
    roomId,
    sessionName: state.sessionName || defaultSessionName(),
    hostName,
    participants,
    persistWhenEmpty: !!state.persistWhenEmpty,
    empty: !!state.parked || state.connections.size === 0,
    queueCount: (state.queue || []).length,
    updatedAt: Date.now(),
  };
}

function upsertDirectoryRoom(entry) {
  if (!entry || !entry.roomId) return;
  state.directory.rooms.set(entry.roomId, {
    roomId: entry.roomId,
    sessionName: String(entry.sessionName || 'Untitled jam').slice(0, 40),
    hostName: String(entry.hostName || 'Host').slice(0, 24),
    participants: Array.isArray(entry.participants) ? entry.participants.slice(0, 24) : [],
    persistWhenEmpty: !!entry.persistWhenEmpty,
    empty: !!entry.empty,
    queueCount: Number(entry.queueCount) || 0,
    updatedAt: Number(entry.updatedAt) || Date.now(),
  });
}

function removeDirectoryRoom(roomId) {
  if (!roomId) return;
  state.directory.rooms.delete(roomId);
}

function pruneDirectoryRooms() {
  const now = Date.now();
  for (const [id, room] of state.directory.rooms) {
    if (now - (room.updatedAt || 0) > DIR_STALE_MS) state.directory.rooms.delete(id);
  }
}

function directoryListPayload() {
  pruneDirectoryRooms();
  return {
    type: 'dir-list',
    rooms: [...state.directory.rooms.values()],
  };
}

function broadcastDirectoryList() {
  if (!state.directory.isBroker) return;
  const payload = JSON.stringify(directoryListPayload());
  for (const conn of state.directory.clients.values()) {
    if (conn.open) {
      try { conn.send(payload); } catch { /* ignore */ }
    }
  }
}

function applyDirectoryList(rooms) {
  state.directory.rooms.clear();
  for (const r of rooms || []) upsertDirectoryRoom(r);
  pruneDirectoryRooms();
  renderActiveSessions();
}

function setDirectoryStatus(text) {
  if (els.sessionsStatus) els.sessionsStatus.textContent = text;
}

function renderActiveSessions() {
  pruneDirectoryRooms();
  const list = els.sessionsList;
  if (!list) return;
  list.innerHTML = '';
  const rooms = [...state.directory.rooms.values()]
    .filter((r) => Date.now() - (r.updatedAt || 0) <= DIR_STALE_MS)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

  // Hide our own live (non-parked) room; parked own rooms stay visible so host can Resume
  const selfId = state.role === 'host' ? (state.hostId || state.peer?.id) : null;
  const visible = rooms.filter((r) => {
    if (r.roomId !== selfId) return true;
    return !!state.parked;
  });

  if (!visible.length) {
    // Local BC/storage counts as "online" even when PeerJS directory is down
    if (state.directory.connected || state.directory.isBroker || state.directory.bc) {
      setDirectoryStatus('No live rooms yet — create one and stamp a session name on it!');
    } else if (state.directory.starting) {
      setDirectoryStatus('Looking for live rooms…');
    } else {
      setDirectoryStatus('Directory offline — try Refresh, or join with a room code.');
    }
    return;
  }

  setDirectoryStatus(`${visible.length} live session${visible.length === 1 ? '' : 's'} — tap Join to hop in:`);

  for (const room of visible) {
    const li = document.createElement('li');
    li.className = 'session-card';
    const isOwnParked = selfId && room.roomId === selfId && state.parked;
    const names = (room.participants || [])
      .map((p) => (p && p.name ? String(p.name) : ''))
      .filter(Boolean);
    const emptyOpen = !!room.empty || !!room.persistWhenEmpty && !names.length;
    const people = names.length
      ? names.map((n) => escapeHtml(n)).join(', ')
      : (emptyOpen ? 'empty — queue waiting' : escapeHtml(room.hostName || 'Host'));
    const title = escapeHtml(room.sessionName || 'Untitled jam');
    const host = escapeHtml(room.hostName || 'Host');
    const badge = (room.persistWhenEmpty || emptyOpen)
      ? `<span class="session-pill">${room.queueCount ? `${room.queueCount} queued` : 'open when empty'}</span>`
      : '';
    const actionLabel = isOwnParked ? 'Resume' : 'Join';
    const endBtn = isOwnParked
      ? `<button class="btn danger" type="button" data-end-parked="${escapeHtml(room.roomId)}">End</button>`
      : '';
    li.innerHTML = `
      <div class="session-card-main">
        <p class="session-card-title">${title}${badge}</p>
        <p class="session-card-meta">Host <span class="who">${host}</span> · ${people}</p>
      </div>
      <div class="session-card-actions">
        <button class="btn primary" type="button" data-join-room="${escapeHtml(room.roomId)}">${actionLabel}</button>
        ${endBtn}
      </div>
    `;
    const btn = li.querySelector('button[data-join-room]');
    if (btn) {
      btn.addEventListener('click', () => {
        const code = btn.getAttribute('data-join-room');
        if (isOwnParked) {
          resumeParkedRoom();
          return;
        }
        if (els.roomInput) els.roomInput.value = code;
        joinRoom(code);
      });
    }
    const end = li.querySelector('button[data-end-parked]');
    if (end) {
      end.addEventListener('click', () => {
        clearHostSession();
        destroySession();
        toast('Parked room ended');
      });
    }
    list.appendChild(li);
  }
}

function sendDir(conn, msg) {
  if (conn?.open) {
    try { conn.send(JSON.stringify(msg)); } catch { /* ignore */ }
  }
}

function handleDirectoryMessage(fromId, raw, conn) {
  let msg;
  try { msg = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return; }
  if (!msg || !msg.type) return;

  if (state.directory.isBroker) {
    switch (msg.type) {
      case 'dir-announce': {
        upsertDirectoryRoom({
          roomId: msg.roomId,
          sessionName: msg.sessionName,
          hostName: msg.hostName,
          participants: msg.participants,
          persistWhenEmpty: msg.persistWhenEmpty,
          empty: msg.empty,
          queueCount: msg.queueCount,
          updatedAt: Date.now(),
        });
        broadcastDirectoryList();
        renderActiveSessions();
        break;
      }
      case 'dir-unannounce': {
        removeDirectoryRoom(msg.roomId);
        broadcastDirectoryList();
        renderActiveSessions();
        break;
      }
      case 'dir-hello':
      case 'dir-request': {
        sendDir(conn, directoryListPayload());
        break;
      }
      default:
        break;
    }
    return;
  }

  // Client of the directory broker
  if (msg.type === 'dir-list') {
    applyDirectoryList(msg.rooms);
    state.directory.connected = true;
  }
}

function wireDirectoryConnection(conn) {
  const onOpen = () => {
    if (state.directory.isBroker) {
      state.directory.clients.set(conn.peer, conn);
      sendDir(conn, directoryListPayload());
    } else {
      state.directory.conn = conn;
      state.directory.connected = true;
      setDirectoryStatus('Looking for live rooms…');
      sendDir(conn, { type: 'dir-hello' });
      // If we are hosting, announce immediately
      announceRoomNow();
    }
    renderActiveSessions();
  };
  conn.on('open', onOpen);
  conn.on('data', (data) => handleDirectoryMessage(conn.peer, data, conn));
  conn.on('close', () => {
    if (state.directory.isBroker) {
      state.directory.clients.delete(conn.peer);
    } else if (state.directory.conn === conn) {
      state.directory.conn = null;
      state.directory.connected = false;
      scheduleDirectoryReconnect('Directory peer left — reconnecting…');
    }
  });
  conn.on('error', () => {
    /* reconnect path handles drop */
  });
  if (conn.open) onOpen();
}

function clearDirectoryTimers() {
  clearInterval(state.directory.announceTimer);
  clearInterval(state.directory.pruneTimer);
  clearTimeout(state.directory.reconnectTimer);
  state.directory.announceTimer = null;
  state.directory.pruneTimer = null;
  state.directory.reconnectTimer = null;
}

function destroyDirectoryPeer() {
  clearDirectoryTimers();
  if (state.directory.conn) {
    try { state.directory.conn.close(); } catch { /* ignore */ }
  }
  for (const c of state.directory.clients.values()) {
    try { c.close(); } catch { /* ignore */ }
  }
  state.directory.clients.clear();
  state.directory.conn = null;
  if (state.directory.peer) {
    try { state.directory.peer.destroy(); } catch { /* ignore */ }
  }
  state.directory.peer = null;
  state.directory.isBroker = false;
  state.directory.connected = false;
  state.directory.starting = false;
}

function startDirectoryPruneLoop() {
  clearInterval(state.directory.pruneTimer);
  state.directory.pruneTimer = setInterval(() => {
    const before = state.directory.rooms.size;
    mergeLocalDirectoryIntoState();
    pruneDirectoryRooms();
    if (state.directory.rooms.size !== before) {
      if (state.directory.isBroker) broadcastDirectoryList();
      renderActiveSessions();
    } else {
      renderActiveSessions();
    }
  }, DIR_PRUNE_MS);
}

function startAnnounceLoop() {
  clearInterval(state.directory.announceTimer);
  state.directory.announceTimer = setInterval(() => {
    if (state.role === 'host') announceRoomNow();
  }, DIR_HEARTBEAT_MS);
}


function readLocalDirectoryStore() {
  try {
    const raw = localStorage.getItem(DIR_LOCAL_KEY);
    if (!raw) return {};
    const data = JSON.parse(raw);
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

function writeLocalDirectoryStore(map) {
  try {
    localStorage.setItem(DIR_LOCAL_KEY, JSON.stringify(map));
  } catch { /* ignore quota */ }
}

function mergeLocalDirectoryIntoState() {
  const store = readLocalDirectoryStore();
  const now = Date.now();
  let changed = false;
  for (const [roomId, entry] of Object.entries(store)) {
    if (!entry || !roomId) continue;
    if (now - (entry.updatedAt || 0) > DIR_STALE_MS) continue;
    const prev = state.directory.rooms.get(roomId);
    if (!prev || (entry.updatedAt || 0) >= (prev.updatedAt || 0)) {
      upsertDirectoryRoom(entry);
      changed = true;
    }
  }
  return changed;
}

function publishLocalDirectory(entry) {
  if (!entry || !entry.roomId) return;
  const store = readLocalDirectoryStore();
  store[entry.roomId] = {
    roomId: entry.roomId,
    sessionName: entry.sessionName,
    hostName: entry.hostName,
    participants: entry.participants || [],
    persistWhenEmpty: !!entry.persistWhenEmpty,
    empty: !!entry.empty,
    queueCount: Number(entry.queueCount) || 0,
    updatedAt: entry.updatedAt || Date.now(),
  };
  // Drop stale while writing
  const now = Date.now();
  for (const [id, row] of Object.entries(store)) {
    if (now - (row.updatedAt || 0) > DIR_STALE_MS) delete store[id];
  }
  writeLocalDirectoryStore(store);
  try {
    state.directory.bc?.postMessage({ type: 'dir-announce', room: store[entry.roomId] });
  } catch { /* ignore */ }
}

function retractLocalDirectory(roomId) {
  if (!roomId) return;
  const store = readLocalDirectoryStore();
  if (store[roomId]) {
    delete store[roomId];
    writeLocalDirectoryStore(store);
  }
  try {
    state.directory.bc?.postMessage({ type: 'dir-unannounce', roomId });
  } catch { /* ignore */ }
}

function onLocalDirectoryMessage(msg) {
  if (!msg || !msg.type) return;
  if (msg.type === 'dir-announce' && msg.room) {
    upsertDirectoryRoom(msg.room);
    renderActiveSessions();
  } else if (msg.type === 'dir-unannounce' && msg.roomId) {
    removeDirectoryRoom(msg.roomId);
    renderActiveSessions();
  } else if (msg.type === 'dir-request') {
    // Hosts re-publish so the asker sees us via BC + storage
    if (state.role === 'host') announceRoomNow();
  } else if (msg.type === 'dir-sync' && Array.isArray(msg.rooms)) {
    for (const r of msg.rooms) upsertDirectoryRoom(r);
    renderActiveSessions();
  }
}

function startLocalDirectoryPresence() {
  mergeLocalDirectoryIntoState();
  renderActiveSessions();
  if (typeof BroadcastChannel === 'undefined') return;
  if (state.directory.bc) return;
  try {
    const bc = new BroadcastChannel(DIR_BC_NAME);
    state.directory.bc = bc;
    bc.onmessage = (ev) => onLocalDirectoryMessage(ev.data);
    // Ask other tabs to re-announce
    bc.postMessage({ type: 'dir-request' });
  } catch (err) {
    console.warn('BroadcastChannel unavailable', err);
  }
}

function announceRoomNow() {
  const entry = roomDirectoryEntry();
  if (!entry) return;

  // Always publish on same-origin tabs (BroadcastChannel + localStorage).
  // PeerJS directory is best-effort for cross-browser / cross-device.
  upsertDirectoryRoom(entry);
  publishLocalDirectory(entry);

  if (state.directory.isBroker) {
    broadcastDirectoryList();
    renderActiveSessions();
    return;
  }
  if (state.directory.conn?.open) {
    sendDir(state.directory.conn, { type: 'dir-announce', ...entry });
  }
  renderActiveSessions();
}

function unannounceRoom(roomId) {
  const id = roomId || state.hostId || state.peer?.id;
  if (!id) return;
  removeDirectoryRoom(id);
  retractLocalDirectory(id);
  if (state.directory.isBroker) {
    broadcastDirectoryList();
  } else if (state.directory.conn?.open) {
    sendDir(state.directory.conn, { type: 'dir-unannounce', roomId: id });
  }
  renderActiveSessions();
}

function scheduleDirectoryReconnect(statusText) {
  if (state.directory.reconnectTimer) return;
  if (statusText) setDirectoryStatus(statusText);
  state.directory.reconnectTimer = setTimeout(() => {
    state.directory.reconnectTimer = null;
    startDirectoryPresence({ force: true });
  }, DIR_RECONNECT_MS);
}

async function becomeDirectoryBroker() {
  const dirId = directoryPeerId();
  destroyDirectoryPeer();
  state.directory.starting = true;
  setDirectoryStatus('Starting session directory…');
  try {
    const { peer } = await createPeer(dirId);
    state.directory.peer = peer;
    state.directory.isBroker = true;
    state.directory.connected = true;
    state.directory.starting = false;
    peer.on('connection', (conn) => wireDirectoryConnection(conn));
    peer.on('error', (err) => {
      console.warn('directory broker error', err);
      destroyDirectoryPeer();
      scheduleDirectoryReconnect('Directory hiccup — retrying…');
    });
    peer.on('disconnected', () => {
      try { peer.reconnect(); } catch { /* ignore */ }
    });
    startDirectoryPruneLoop();
    startAnnounceLoop();
    // If we are already hosting, publish ourselves
    announceRoomNow();
    setDirectoryStatus('No live rooms yet — create one and stamp a session name on it!');
    renderActiveSessions();
  } catch (err) {
    console.warn('could not claim directory id', err);
    state.directory.starting = false;
    // Someone else holds the broker — retry as client shortly (avoid tight claim loops)
    scheduleDirectoryReconnect('Directory busy — rejoining as client…');
  }
}

async function connectDirectoryAsClient() {
  const dirId = directoryPeerId();
  destroyDirectoryPeer();
  state.directory.starting = true;
  setDirectoryStatus('Looking for live rooms…');
  try {
    const { peer } = await createPeer();
    state.directory.peer = peer;
    state.directory.isBroker = false;

    let settled = false;
    const failTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      // Broker missing or unreachable — try to become it (local list still works via BC)
      try { peer.destroy(); } catch { /* ignore */ }
      state.directory.peer = null;
      becomeDirectoryBroker();
    }, 8000);

    peer.on('error', (err) => {
      const missing = err?.type === 'peer-unavailable';
      if (missing && !settled) {
        settled = true;
        clearTimeout(failTimer);
        try { peer.destroy(); } catch { /* ignore */ }
        state.directory.peer = null;
        becomeDirectoryBroker();
        return;
      }
      // After open, peer-unavailable on connect already handled; other errors reconnect
      if (settled) {
        console.warn('directory client error', err);
        destroyDirectoryPeer();
        scheduleDirectoryReconnect('Directory offline — retrying…');
      }
    });

    const conn = peer.connect(dirId, { reliable: true });
    wireDirectoryConnection(conn);
    conn.on('open', () => {
      if (settled && state.directory.conn && state.directory.conn !== conn) return;
      settled = true;
      clearTimeout(failTimer);
      state.directory.starting = false;
    });

    peer.on('disconnected', () => {
      try { peer.reconnect(); } catch { /* ignore */ }
    });

    startDirectoryPruneLoop();
    startAnnounceLoop();
  } catch (err) {
    console.warn('directory client failed', err);
    state.directory.starting = false;
    scheduleDirectoryReconnect('Directory offline — retrying…');
  }
}

async function startDirectoryPresence({ force = false } = {}) {
  startLocalDirectoryPresence();
  mergeLocalDirectoryIntoState();
  renderActiveSessions();
  if (state.directory.starting && !force) return;
  if (state.directory.peer && !force) return;
  if (force) destroyDirectoryPeer();
  // Prefer joining existing broker; fall back to claiming the id.
  // PeerJS path is best-effort — local BC/storage already lists same-origin rooms.
  await connectDirectoryAsClient();
}

function refreshDirectoryList() {
  mergeLocalDirectoryIntoState();
  try { state.directory.bc?.postMessage({ type: 'dir-request' }); } catch { /* ignore */ }
  if (state.directory.isBroker) {
    broadcastDirectoryList();
    renderActiveSessions();
    toast('Session list refreshed');
    return;
  }
  if (state.directory.conn?.open) {
    sendDir(state.directory.conn, { type: 'dir-request' });
    toast('Refreshing sessions…');
    return;
  }
  renderActiveSessions();
  // Soft reconnect PeerJS directory without wiping local list
  if (!state.directory.peer && !state.directory.starting) {
    startDirectoryPresence({ force: true });
    toast('Reconnecting to directory…');
  } else {
    toast('Session list refreshed');
  }
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
  clearSessionLog();
  state.name = (els.name.value || '').trim() || randomName();
  els.name.value = state.name;
  if (!preferredId) {
    setSessionName(readSessionNameInput() || defaultSessionName());
  } else if (!state.sessionName) {
    setSessionName(readSessionNameInput() || defaultSessionName());
  } else {
    updateSessionTitle();
  }
  if (!quiet) setStatus(preferredId ? 'Reclaiming host…' : 'Connecting…', 'warn');
  const { peer, id } = await createPeer(preferredId);
  state.peer = peer;
  state.role = 'host';
  state.hostId = id;
  if (preferredId == null) {
    state.passHostOnLeave = els.passHostCreate ? !!els.passHostCreate.checked : true;
    state.persistWhenEmpty = els.persistEmptyCreate ? !!els.persistEmptyCreate.checked : false;
    state.recordingEnabled = els.recordSessionCreate ? !!els.recordSessionCreate.checked : true;
  }
  state.parked = false;
  state.recordingNoticeAcked = false;
  state.recordingSettingsReady = true;
  syncPassHostUI();
  syncRecordingUI();
  ensureAcceptingConnections();
  peer.on('error', (err) => {
    console.error(err);
    toast(err?.message || 'Peer error');
    setStatus('Error', 'err');
  });
  showRoom();
  ensurePlayer(state.videoId || DEFAULT_VIDEO);
  startHostTick();
  setStatus('Host · waiting', 'ok');
  history.replaceState(null, '', roomUrl(id));
  saveHostSession();
  logSession(preferredId ? 'room-join' : 'room-create', {
    role: 'host',
    name: state.name,
    roomId: id,
    sessionName: state.sessionName,
    reclaimed: !!preferredId,
  }, { sync: false });
  announceRoomNow();
  if (toastMsg) toast(toastMsg);
}

async function createRoom() {
  try {
    if (state.parked || state.role === 'host' || state.role === 'guest') {
      clearHostSession();
      destroySession();
    }
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
  if (state.parked && (state.hostId === code || state.peer?.id === code)) {
    resumeParkedRoom();
    return;
  }
  if (state.parked || state.role === 'host' || state.role === 'guest') {
    clearHostSession();
    destroySession();
  }
  clearHostSession();
  clearSessionLog();
  state.recordingNoticeAcked = false;
  state.recordingSettingsReady = false;
  // Guests inherit recordingEnabled via settings; default true until host says otherwise
  state.recordingEnabled = true;
  state.name = (els.name.value || '').trim() || randomName();
  els.name.value = state.name;
  // Guests adopt the host's session name via settings; optional lobby field is a create hint.
  state.sessionName = readSessionNameInput() || 'Joining…';
  updateSessionTitle();
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
    logSession('room-join', {
      role: 'guest',
      name: state.name,
      roomId: code,
    }, { sync: false });
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
    if (saved.sessionName) {
      state.sessionName = String(saved.sessionName).slice(0, 40);
      if (els.sessionNameInput) els.sessionNameInput.value = state.sessionName;
      updateSessionTitle();
    }
    if (typeof saved.passHostOnLeave === 'boolean') {
      state.passHostOnLeave = saved.passHostOnLeave;
      if (els.passHostCreate) els.passHostCreate.checked = saved.passHostOnLeave;
    }
    if (typeof saved.persistWhenEmpty === 'boolean') {
      state.persistWhenEmpty = saved.persistWhenEmpty;
      if (els.persistEmptyCreate) els.persistEmptyCreate.checked = saved.persistWhenEmpty;
    }
    if (typeof saved.recordingEnabled === 'boolean') {
      state.recordingEnabled = saved.recordingEnabled;
      if (els.recordSessionCreate) els.recordSessionCreate.checked = saved.recordingEnabled;
    }
    applyPersistedMedia(saved);
    try {
      await createRoomAsHost(code, { toastMsg: 'Welcome back — you’re still the host' });
      if (saved.parked && state.persistWhenEmpty && state.connections.size === 0) {
        parkSession();
      }
      return;
    } catch (err) {
      console.warn('host reclaim failed, joining as guest', err);
      clearHostSession();
      toast('Couldn’t reclaim host — joining as guest');
    }
  }
  // Cross-refresh reclaim via localStorage snapshot (persist-when-empty rooms)
  const persisted = loadPersistedRoom(code);
  if (persisted) {
    if (persisted.name) {
      state.name = persisted.name;
      els.name.value = persisted.name;
    }
    if (persisted.sessionName) {
      state.sessionName = String(persisted.sessionName).slice(0, 40);
      if (els.sessionNameInput) els.sessionNameInput.value = state.sessionName;
      updateSessionTitle();
    }
    if (typeof persisted.passHostOnLeave === 'boolean') {
      state.passHostOnLeave = persisted.passHostOnLeave;
      if (els.passHostCreate) els.passHostCreate.checked = persisted.passHostOnLeave;
    }
    state.persistWhenEmpty = true;
    if (els.persistEmptyCreate) els.persistEmptyCreate.checked = true;
    applyPersistedMedia(persisted);
    try {
      await createRoomAsHost(code, { toastMsg: 'Room reopened — queue restored 🎨' });
      return;
    } catch (err) {
      console.warn('persisted room reclaim failed, joining as guest', err);
      toast('Couldn’t reopen parked room — joining as guest');
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
els.exportLog?.addEventListener('click', () => exportSessionLog());
els.loadSessionLobby?.addEventListener('change', (e) => {
  const file = e.target.files && e.target.files[0];
  onSessionFileSelected(file);
  e.target.value = '';
});
els.loadSessionRoom?.addEventListener('change', (e) => {
  const file = e.target.files && e.target.files[0];
  onSessionFileSelected(file);
  e.target.value = '';
});
els.replayPlay?.addEventListener('click', () => playReplay());
els.replayPause?.addEventListener('click', () => pauseReplay());
els.replayRestart?.addEventListener('click', () => restartReplay({ autoplay: false }));
els.replaySkip?.addEventListener('click', () => skipReplayEvent());
els.replayExit?.addEventListener('click', () => exitReplay());
els.replaySpeed?.addEventListener('change', () => {
  const wasPlaying = state.replay.playing;
  if (wasPlaying) pauseReplay();
  state.replay.speed = Number(els.replaySpeed.value) || 1;
  updateReplayStatus();
  if (wasPlaying) playReplay();
});
els.chatTabPrevious?.addEventListener('click', () => setChatTab('previous'));
els.chatTabCurrent?.addEventListener('click', () => setChatTab('current'));
function onPassHostToggleChange(checked) {
  if (state.role !== 'host') {
    syncPassHostUI();
    return;
  }
  setPassHostOnLeave(!!checked, { emit: true });
  toast(state.passHostOnLeave ? 'Host will pass to a guest on leave' : 'Room ends if you leave');
}
els.passHostToggle?.addEventListener('change', () => {
  onPassHostToggleChange(els.passHostToggle.checked);
});
els.passHostToggleMobile?.addEventListener('change', () => {
  onPassHostToggleChange(els.passHostToggleMobile.checked);
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
  syncMobileNameInputs();
});
els.peopleRenameForm?.addEventListener('submit', (e) => {
  e.preventDefault();
  renameSelf(els.peopleName?.value);
  syncMobileNameInputs();
});

els.recordingModalOk?.addEventListener('click', () => ackRecordingNotice());

// Boot
els.name.value = randomName();
syncPreviousChatAvailability();
setMobileTab('queue');
wireMobileTabs();
syncHowtoBanner();
updateSessionTitle();
els.howtoDismiss?.addEventListener('click', () => dismissHowto());
els.sessionsRefresh?.addEventListener('click', () => refreshDirectoryList());
startDirectoryPresence();
window.addEventListener('beforeunload', () => {
  if (state.role === 'host') {
    const id = state.hostId || state.peer?.id;
    if (state.persistWhenEmpty) {
      saveHostSession();
      savePersistedRoom(id);
    }
    if (id) unannounceRoom(id);
  }
});
window.__ysqSnapshot = () => {
  let playerState = null;
  try {
    if (state.player && typeof state.player.getPlayerState === 'function') {
      playerState = state.player.getPlayerState();
    }
  } catch { /* ignore */ }
  return {
    time: getPlayerTimeSec(),
    rate: getPlayerRate(),
    playerState,
    videoId: state.videoId,
    replay: {
      active: !!(state.replay && state.replay.active),
      playing: !!(state.replay && state.replay.playing),
      index: state.replay ? state.replay.index : 0,
      elapsedMs: state.replay ? replayElapsedMs() : 0,
      totalMs: state.replay ? replayTotalMs() : 0,
    },
  };
};

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
