const DB_NAME = 'playpocket-web-db';
const DB_VERSION = 1;
const STORE_VIDEOS = 'videos';
const STORE_PLAYLISTS = 'playlists';
const MAX_PLAYLIST_NAME_LENGTH = 80;
const MAX_IMPORTED_ITEMS = 500;
const MAX_IMPORTED_JSON_BYTES = 50 * 1024 * 1024;
const MAX_FILES_PER_DROP = 100;

const DEFAULT_SETTINGS = {
  restoreLastState: true,
  autoAdvance: true,
  showThumbnails: true,
  compactMode: false,
  theme: 'dark'
};

let db = null;
let currentPlaylist = null;
let currentIndex = 0;
let playMode = 'order';
let shuffleOrder = [];
let currentObjectUrl = null;
let currentMeta = null;
let videoCache = new Map();
let runtimeSaveTimer = null;
let uiRefreshTimer = null;
let searchQuery = '';
let settings = loadSettings();
let restoreSnapshot = loadRuntimeState();
let lastSeekWasManual = false;

const els = {
  playlists: document.getElementById('playlists'),
  trackList: document.getElementById('trackList'),
  fileInput: document.getElementById('fileInput'),
  importFile: document.getElementById('importFile'),
  newPlaylistName: document.getElementById('newPlaylistName'),
  createPlaylistBtn: document.getElementById('createPlaylistBtn'),
  exportMetaBtn: document.getElementById('exportMetaBtn'),
  exportWithBlobsBtn: document.getElementById('exportWithBlobsBtn'),
  dropZone: document.getElementById('dropZone'),
  videoPlayer: document.getElementById('videoPlayer'),
  videoShell: document.getElementById('videoShell'),
  centerPlayBtn: document.getElementById('centerPlayBtn'),
  seekBar: document.getElementById('seekBar'),
  currentTime: document.getElementById('currentTime'),
  durationTime: document.getElementById('durationTime'),
  playPauseBtn: document.getElementById('playPauseBtn'),
  prevBtn: document.getElementById('prevBtn'),
  nextBtn: document.getElementById('nextBtn'),
  fullscreenBtn: document.getElementById('fullscreenBtn'),
  speedSelect: document.getElementById('speedSelect'),
  muteBtn: document.getElementById('muteBtn'),
  volumeSlider: document.getElementById('volumeSlider'),
  volumeLabel: document.getElementById('volumeLabel'),
  orderBtn: document.getElementById('orderBtn'),
  shuffleBtn: document.getElementById('shuffleBtn'),
  randomBtn: document.getElementById('randomBtn'),
  openSettingsBtn: document.getElementById('openSettingsBtn'),
  closeSettingsBtn: document.getElementById('closeSettingsBtn'),
  settingsModal: document.getElementById('settingsModal'),
  restoreLastState: document.getElementById('restoreLastState'),
  autoAdvance: document.getElementById('autoAdvance'),
  showThumbnails: document.getElementById('showThumbnails'),
  compactMode: document.getElementById('compactMode'),
  themeSelect: document.getElementById('themeSelect'),
  resetSettingsBtn: document.getElementById('resetSettingsBtn'),
  clearAllBtn: document.getElementById('clearAllBtn'),
  renamePlaylistBtn: document.getElementById('renamePlaylistBtn'),
  deletePlaylistBtn: document.getElementById('deletePlaylistBtn'),
  statusText: document.getElementById('statusText'),
  currentPlaylistLabel: document.getElementById('currentPlaylistLabel'),
  trackMetaText: document.getElementById('trackMetaText'),
  trackPanelSub: document.getElementById('trackPanelSub'),
  totalDuration: document.getElementById('totalDuration'),
  playlistCount: document.getElementById('playlistCount'),
  trackCount: document.getElementById('trackCount'),
  libraryDuration: document.getElementById('libraryDuration'),
  trackSearch: document.getElementById('trackSearch'),
  toastArea: document.getElementById('toastArea')
};

function loadSettings() {
  try {
    const raw = localStorage.getItem('playpocket-settings');
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw);
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      restoreLastState: typeof parsed.restoreLastState === 'boolean' ? parsed.restoreLastState : DEFAULT_SETTINGS.restoreLastState,
      autoAdvance: typeof parsed.autoAdvance === 'boolean' ? parsed.autoAdvance : DEFAULT_SETTINGS.autoAdvance,
      showThumbnails: typeof parsed.showThumbnails === 'boolean' ? parsed.showThumbnails : DEFAULT_SETTINGS.showThumbnails,
      compactMode: typeof parsed.compactMode === 'boolean' ? parsed.compactMode : DEFAULT_SETTINGS.compactMode,
      theme: ['dark', 'light', 'system'].includes(parsed.theme) ? parsed.theme : DEFAULT_SETTINGS.theme
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings() {
  localStorage.setItem('playpocket-settings', JSON.stringify(settings));
  applySettingsToUI();
  scheduleStatsRefresh();
}

function loadRuntimeState() {
  try {
    const raw = localStorage.getItem('playpocket-runtime');
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function saveRuntimeStateNow(extra = {}) {
  const payload = {
    currentPlaylist,
    currentIndex,
    playMode,
    volume: Number(els.volumeSlider.value) / 100,
    speed: Number(els.speedSelect.value) || 1,
    time: Number.isFinite(els.videoPlayer.currentTime) ? els.videoPlayer.currentTime : 0,
    isPlaying: !els.videoPlayer.paused && !els.videoPlayer.ended,
    lastTrackId: currentMeta?.id ?? null,
    ...extra
  };
  localStorage.setItem('playpocket-runtime', JSON.stringify(payload));
}

function scheduleRuntimeSave(extra = {}) {
  if (runtimeSaveTimer) clearTimeout(runtimeSaveTimer);
  runtimeSaveTimer = setTimeout(() => {
    runtimeSaveTimer = null;
    saveRuntimeStateNow(extra);
  }, 180);
}

function uid() {
  if (crypto?.randomUUID) return `id-${crypto.randomUUID()}`;
  return `id-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
}

function safeText(value, fallback = '') {
  if (typeof value !== 'string') return fallback;
  return value.replace(/[\u0000-\u001F\u007F]/g, '').trim();
}

function normalizePlaylistName(name) {
  const next = safeText(name);
  if (!next) return '';
  return next.length > MAX_PLAYLIST_NAME_LENGTH ? next.slice(0, MAX_PLAYLIST_NAME_LENGTH) : next;
}

function formatTime(sec) {
  const n = Number(sec);
  if (!Number.isFinite(n) || n < 0) return '00:00:00';
  const h = Math.floor(n / 3600);
  const m = Math.floor((n % 3600) / 60);
  const s = Math.floor(n % 60);
  return [h, m, s].map((v) => String(v).padStart(2, '0')).join(':');
}

function formatSize(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = n;
  let idx = 0;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx++;
  }
  const fixed = idx === 0 ? Math.round(value) : value.toFixed(value >= 10 ? 1 : 2);
  return `${fixed} ${units[idx]}`;
}

function toast(message) {
  const div = document.createElement('div');
  div.className = 'toast';
  div.textContent = message;
  els.toastArea.appendChild(div);
  setTimeout(() => {
    div.style.opacity = '0';
    div.style.transform = 'translateY(6px)';
  }, 2400);
  setTimeout(() => div.remove(), 3000);
}

function showStatus(message) {
  els.statusText.textContent = message;
}

function setTheme(theme) {
  const resolved = theme === 'system'
    ? (window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
    : theme;
  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.colorScheme = resolved;
}

function applySettingsToUI() {
  if (els.restoreLastState) els.restoreLastState.checked = !!settings.restoreLastState;
  if (els.autoAdvance) els.autoAdvance.checked = !!settings.autoAdvance;
  if (els.showThumbnails) els.showThumbnails.checked = !!settings.showThumbnails;
  if (els.compactMode) els.compactMode.checked = !!settings.compactMode;
  if (els.themeSelect) els.themeSelect.value = settings.theme || 'dark';
  document.documentElement.dataset.compact = String(!!settings.compactMode);
  document.documentElement.dataset.showThumbs = String(!!settings.showThumbnails);
  setTheme(settings.theme || 'dark');
}

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const idb = e.target.result;
      if (!idb.objectStoreNames.contains(STORE_VIDEOS)) idb.createObjectStore(STORE_VIDEOS, { keyPath: 'id' });
      if (!idb.objectStoreNames.contains(STORE_PLAYLISTS)) idb.createObjectStore(STORE_PLAYLISTS, { keyPath: 'name' });
    };
    req.onsuccess = (e) => {
      db = e.target.result;
      resolve(db);
    };
    req.onerror = () => reject(req.error || new Error('IndexedDB failed'));
  });
}

function txStore(store, mode = 'readonly') {
  return db.transaction(store, mode).objectStore(store);
}

function idbGet(store, key) {
  return new Promise((resolve, reject) => {
    const req = txStore(store).get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error || new Error('IndexedDB get failed'));
  });
}

function idbGetAll(store) {
  return new Promise((resolve, reject) => {
    const req = txStore(store).getAll();
    req.onsuccess = () => resolve(Array.isArray(req.result) ? req.result : []);
    req.onerror = () => reject(req.error || new Error('IndexedDB getAll failed'));
  });
}

function idbPut(store, value) {
  return new Promise((resolve, reject) => {
    const req = txStore(store, 'readwrite').put(value);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB put failed'));
  });
}

function idbDelete(store, key) {
  return new Promise((resolve, reject) => {
    const req = txStore(store, 'readwrite').delete(key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error || new Error('IndexedDB delete failed'));
  });
}

async function idbClearAll() {
  const tx = db.transaction([STORE_VIDEOS, STORE_PLAYLISTS], 'readwrite');
  tx.objectStore(STORE_VIDEOS).clear();
  tx.objectStore(STORE_PLAYLISTS).clear();
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('IndexedDB clear failed'));
  });
}

function sanitizeThumbnail(value) {
  if (typeof value !== 'string') return null;
  if (!value.startsWith('data:image/')) return null;
  if (value.length > 2_000_000) return null;
  return value;
}

function sanitizeMimeType(type) {
  if (typeof type !== 'string') return 'video/mp4';
  return type.startsWith('video/') ? type : 'video/mp4';
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const result = String(reader.result || '');
        const comma = result.indexOf(',');
        resolve(comma >= 0 ? result.slice(comma + 1) : '');
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = () => reject(reader.error || new Error('FileReader error'));
    reader.readAsDataURL(blob);
  });
}

function base64ToBlob(base64, type) {
  const clean = typeof base64 === 'string' ? base64.trim() : '';
  if (!clean) throw new Error('invalid base64');
  let bin;
  try {
    bin = atob(clean);
  } catch {
    throw new Error('invalid base64');
  }
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: sanitizeMimeType(type) });
}

function downloadBlob(blob, filename) {
  const a = document.createElement('a');
  const url = URL.createObjectURL(blob);
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function isVideoFile(file) {
  return file instanceof File && typeof file.type === 'string' && file.type.startsWith('video/');
}

function getVideoDuration(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.src = url;
    video.onloadedmetadata = () => {
      const duration = Number.isFinite(video.duration) ? video.duration : 0;
      URL.revokeObjectURL(url);
      resolve(duration);
    };
    video.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(0);
    };
  });
}

function generateThumbnail(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.muted = true;
    video.playsInline = true;
    video.src = url;

    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      try { URL.revokeObjectURL(url); } catch {}
      resolve(value);
    };

    video.addEventListener('loadeddata', () => {
      try {
        video.currentTime = Math.min(0.12, (Number.isFinite(video.duration) ? video.duration : 0.12) / 4);
      } catch {
        finish(null);
      }
    });

    video.addEventListener('seeked', () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = 320;
        canvas.height = 180;
        const ctx = canvas.getContext('2d');
        if (!ctx) return finish(null);
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        finish(canvas.toDataURL('image/jpeg', 0.72));
      } catch {
        finish(null);
      }
    });

    video.onerror = () => finish(null);
    setTimeout(() => finish(null), 3000);
  });
}

function safeTrackTitle(name) {
  const text = safeText(name) || 'video';
  return text.replace(/\.[^/.]+$/, '');
}

function uniquePlaylistName(base) {
  const name = normalizePlaylistName(base);
  if (!name) return '';
  const existing = new Set();
  return name;
}

function setPlaylistMetaLine() {
  const total = getPlaylistLength(currentPlaylist);
  els.currentPlaylistLabel.textContent = currentPlaylist || '未選択';
  els.trackPanelSub.textContent = currentPlaylist ? `${total} 件の動画` : 'プレイリストを選んでください';
}

function getPlaylistLength(pl) {
  return pl && Array.isArray(pl.items) ? pl.items.length : 0;
}

async function loadAllPlaylists() {
  const pls = await idbGetAll(STORE_PLAYLISTS);
  return pls
    .filter((p) => p && typeof p.name === 'string' && Array.isArray(p.items))
    .map((p) => ({ name: normalizePlaylistName(p.name), items: p.items.slice() }))
    .filter((p) => p.name);
}

async function ensureDefaultPlaylist() {
  const pls = await loadAllPlaylists();
  if (pls.length === 0) {
    await idbPut(STORE_PLAYLISTS, { name: 'Default', items: [] });
    return 'Default';
  }
  return currentPlaylist && pls.some((p) => p.name === currentPlaylist) ? currentPlaylist : pls[0].name;
}

function matchesSearch(meta) {
  if (!searchQuery) return true;
  const hay = [
    meta?.name,
    meta?.mimeType,
    String(meta?.size ?? ''),
    String(meta?.duration ?? '')
  ].join(' ').toLowerCase();
  return hay.includes(searchQuery);
}

async function loadVideoMeta(id) {
  if (videoCache.has(id)) return videoCache.get(id);
  const meta = await idbGet(STORE_VIDEOS, id);
  if (meta) videoCache.set(id, meta);
  return meta;
}

async function refreshStats() {
  const pls = await loadAllPlaylists();
  const vids = await idbGetAll(STORE_VIDEOS);
  let duration = 0;
  for (const v of vids) duration += Number(v?.duration) || 0;
  els.playlistCount.textContent = String(pls.length);
  els.trackCount.textContent = String(vids.length);
  els.libraryDuration.textContent = formatTime(duration);
  const currentPl = await getCurrentPlaylist();
  els.totalDuration.textContent = formatTime(await getPlaylistDuration(currentPl));
  setPlaylistMetaLine();
}

function scheduleStatsRefresh() {
  if (uiRefreshTimer) clearTimeout(uiRefreshTimer);
  uiRefreshTimer = setTimeout(() => {
    uiRefreshTimer = null;
    refreshStats().catch(() => {});
  }, 100);
}
async function getPlaylistDuration(pl) {
  if (!pl || !Array.isArray(pl.items)) return 0;
  let total = 0;
  for (const id of pl.items) {
    const meta = await loadVideoMeta(id);
    total += Number(meta?.duration) || 0;
  }
  return total;
}

function currentTrackIds(pl) {
  return pl && Array.isArray(pl.items) ? pl.items.slice() : [];
}

function clearCurrentObjectUrl() {
  if (currentObjectUrl) {
    try { URL.revokeObjectURL(currentObjectUrl); } catch {}
    currentObjectUrl = null;
  }
}

async function loadAndPlayById(id, options = {}) {
  const meta = await loadVideoMeta(id);
  if (!meta || !meta.blob) {
    toast('この動画はメタ情報のみです。元ファイルを再追加してください。');
    return false;
  }

  clearCurrentObjectUrl();
  currentMeta = meta;
  const seekTime = Number(options.seekTime);
  const autoplay = options.autoplay !== false;
  const suppressSave = !!options.suppressSave;

  currentObjectUrl = URL.createObjectURL(meta.blob);
  els.videoPlayer.src = currentObjectUrl;
  els.videoPlayer.load();
  els.videoPlayer.playbackRate = Number(els.speedSelect.value) || 1;
  els.videoPlayer.volume = Number(els.volumeSlider.value) / 100;

  await new Promise((resolve) => {
    const done = () => resolve();
    els.videoPlayer.addEventListener('loadedmetadata', done, { once: true });
    els.videoPlayer.addEventListener('error', done, { once: true });
  });

  if (Number.isFinite(seekTime) && seekTime > 0 && Number.isFinite(els.videoPlayer.duration) && els.videoPlayer.duration > 0) {
    els.videoPlayer.currentTime = Math.min(seekTime, Math.max(0, els.videoPlayer.duration - 0.1));
  }

  if (autoplay) {
    try {
      await els.videoPlayer.play();
    } catch {}
  } else {
    els.videoPlayer.pause();
  }

  updatePlayerUI();
  updateSeekUI();
  updateTrackMeta();
  if (!suppressSave) scheduleRuntimeSave({ lastTrackId: meta.id });
  return true;
}

function getActivePlaylistItemId(pl) {
  const items = currentTrackIds(pl);
  if (items.length === 0) return null;
  if (playMode === 'shuffle') {
    if (shuffleOrder.length !== items.length || !shuffleOrder.every((id) => items.includes(id))) {
      shuffleOrder = items.slice();
      shuffleArray(shuffleOrder);
      currentIndex = Math.min(currentIndex, shuffleOrder.length - 1);
    }
    return shuffleOrder[Math.min(currentIndex, shuffleOrder.length - 1)] ?? null;
  }
  if (playMode === 'random') {
    return items[Math.min(currentIndex, items.length - 1)] ?? null;
  }
  currentIndex = Math.max(0, Math.min(currentIndex, items.length - 1));
  return items[currentIndex] ?? null;
}

function shuffleArray(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
}

async function playCurrent(options = {}) {
  const pl = await getCurrentPlaylist();
  const items = currentTrackIds(pl);
  if (items.length === 0) return false;

  let targetId = null;
  if (playMode === 'shuffle') {
    if (shuffleOrder.length !== items.length || !shuffleOrder.every((id) => items.includes(id))) {
      shuffleOrder = items.slice();
      shuffleArray(shuffleOrder);
      currentIndex = 0;
    }
    targetId = shuffleOrder[Math.min(currentIndex, shuffleOrder.length - 1)];
  } else if (playMode === 'random') {
    const idx = Math.floor(Math.random() * items.length);
    currentIndex = idx;
    targetId = items[idx];
  } else {
    currentIndex = Math.max(0, Math.min(currentIndex, items.length - 1));
    targetId = items[currentIndex];
  }

  if (!targetId) return false;
  await loadAndPlayById(targetId, options);
  await renderTrackList();
  return true;
}

function updatePlayerUI() {
  const paused = els.videoPlayer.paused || els.videoPlayer.ended;
  els.videoShell.classList.toggle('paused', paused);
  els.centerPlayBtn.textContent = paused ? '▶' : 'Ⅱ';
  els.playPauseBtn.textContent = paused ? '▶' : 'Ⅱ';
}

function updateSeekUI() {
  const duration = Number.isFinite(els.videoPlayer.duration) ? els.videoPlayer.duration : 0;
  const current = Number.isFinite(els.videoPlayer.currentTime) ? els.videoPlayer.currentTime : 0;
  els.currentTime.textContent = formatTime(current);
  els.durationTime.textContent = formatTime(duration);
  if (duration > 0 && !els.seekBar.matches(':active')) {
    const ratio = Math.max(0, Math.min(1, current / duration));
    els.seekBar.value = String(Math.round(ratio * 1000));
  }
}

function updateTrackMeta() {
  if (!currentMeta) {
    els.trackMetaText.textContent = '動画を追加して再生を開始できます';
    return;
  }
  const dur = formatTime(currentMeta.duration);
  const size = formatSize(currentMeta.size);
  els.trackMetaText.textContent = `${safeTrackTitle(currentMeta.name)} · ${dur} · ${size}`;
}

function applyPlaybackMode(mode) {
  playMode = mode;
  els.orderBtn.classList.toggle('active', mode === 'order');
  els.shuffleBtn.classList.toggle('active', mode === 'shuffle');
  els.randomBtn.classList.toggle('active', mode === 'random');
  if (mode !== 'shuffle') shuffleOrder = [];
  scheduleRuntimeSave();
}

async function refreshPlaylistList() {
  const pls = await loadAllPlaylists();
  if (!currentPlaylist || !pls.some((p) => p.name === currentPlaylist)) {
    currentPlaylist = pls[0]?.name || null;
  }

  els.playlists.replaceChildren();
  for (const pl of pls) {
    const li = document.createElement('li');
    li.className = 'playlist-item';
    if (pl.name === currentPlaylist) li.classList.add('active');

    const name = document.createElement('span');
    name.className = 'playlist-name';
    name.textContent = pl.name;
    name.title = 'クリックで選択 / ダブルクリックで名前変更';

    const actions = document.createElement('div');
    actions.className = 'playlist-actions';

    const countBadge = document.createElement('span');
    countBadge.className = 'mini-text';
    countBadge.textContent = `${pl.items.length}`;

    actions.appendChild(countBadge);

    li.appendChild(name);
    li.appendChild(actions);

    li.addEventListener('click', async () => {
      currentPlaylist = pl.name;
      currentIndex = 0;
      await renderAll();
      scheduleRuntimeSave();
    });

    li.addEventListener('dblclick', async (e) => {
      e.stopPropagation();
      const next = normalizePlaylistName(prompt('プレイリスト名を入力してください', pl.name) || '');
      if (!next) return;
      if (next === pl.name) return;
      const exists = pls.some((p) => p.name === next);
      if (exists) {
        toast('同名のプレイリストが既に存在します');
        return;
      }
      const current = await idbGet(STORE_PLAYLISTS, pl.name);
      if (!current) return;
      await idbPut(STORE_PLAYLISTS, { name: next, items: current.items.slice() });
      await idbDelete(STORE_PLAYLISTS, pl.name);
      if (currentPlaylist === pl.name) currentPlaylist = next;
      await renderAll();
      scheduleRuntimeSave();
      toast('名前を変更しました');
    });

    els.playlists.appendChild(li);
  }

  const count = pls.length;
  els.playlistCount.textContent = String(count);
  setPlaylistMetaLine();
  return pls;
}

async function deleteOrphanedVideo(id) {
  if (!id) return;
  const pls = await loadAllPlaylists();
  const stillUsed = pls.some((p) => Array.isArray(p.items) && p.items.includes(id));
  if (!stillUsed) {
    await idbDelete(STORE_VIDEOS, id);
    videoCache.delete(id);
  }
}

async function refreshStatsAndList() {
  await refreshPlaylistList();
  await refreshTrackList();
  await refreshStats();
}

function renderTrackItem(meta, index) {
  const li = document.createElement('li');
  li.className = 'track-item';
  li.dataset.index = String(index);
  li.dataset.id = meta.id;
  li.draggable = true;

  if (currentPlaylist && currentTrackIdsCache[index] === meta.id) {
    li.classList.add('active');
  }

  const thumb = document.createElement('img');
  thumb.className = 'thumb';
  thumb.alt = 'サムネイル';
  thumb.loading = 'lazy';
  thumb.src = settings.showThumbnails ? (sanitizeThumbnail(meta.thumbnail) || '') : '';

  const metaWrap = document.createElement('div');
  metaWrap.className = 'track-meta';

  const title = document.createElement('div');
  title.className = 'track-title';
  title.textContent = safeTrackTitle(meta.name);

  const sub = document.createElement('div');
  sub.className = 'track-sub';
  sub.textContent = `${formatTime(meta.duration)} · ${formatSize(meta.size)} · ${safeText(meta.mimeType || 'video/mp4')}`;

  metaWrap.appendChild(title);
  metaWrap.appendChild(sub);

  const actions = document.createElement('div');
  actions.className = 'track-actions';

  const playBtn = document.createElement('button');
  playBtn.className = 'btn btn-primary';
  playBtn.type = 'button';
  playBtn.textContent = '再生';

  const removeBtn = document.createElement('button');
  removeBtn.className = 'btn btn-danger';
  removeBtn.type = 'button';
  removeBtn.textContent = '削除';

  actions.appendChild(playBtn);
  actions.appendChild(removeBtn);

  li.appendChild(thumb);
  li.appendChild(metaWrap);
  li.appendChild(actions);

  li.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/plain', String(index));
    li.classList.add('dragging');
  });
  li.addEventListener('dragend', () => li.classList.remove('dragging'));
  li.addEventListener('dragover', (e) => {
    e.preventDefault();
    li.classList.add('drag-over');
  });
  li.addEventListener('dragleave', () => li.classList.remove('drag-over'));
  li.addEventListener('drop', async (e) => {
    e.preventDefault();
    li.classList.remove('drag-over');
    const fromIndex = Number.parseInt(e.dataTransfer.getData('text/plain'), 10);
    const toIndex = index;
    if (!Number.isInteger(fromIndex) || fromIndex === toIndex) return;
    const pl = await getCurrentPlaylist();
    if (!pl || !Array.isArray(pl.items)) return;
    const item = pl.items.splice(fromIndex, 1)[0];
    if (typeof item === 'undefined') return;
    pl.items.splice(toIndex, 0, item);
    await idbPut(STORE_PLAYLISTS, pl);
    if (currentPlaylist && pl.name === currentPlaylist) {
      if (currentIndex === fromIndex) currentIndex = toIndex;
      else if (fromIndex < currentIndex && toIndex >= currentIndex) currentIndex--;
      else if (fromIndex > currentIndex && toIndex <= currentIndex) currentIndex++;
    }
    await renderAll();
    scheduleRuntimeSave();
  });

  playBtn.addEventListener('click', async () => {
    currentIndex = index;
    await playCurrent({ autoplay: true, seekTime: 0 });
    await renderAll();
    scheduleRuntimeSave();
  });

  removeBtn.addEventListener('click', async () => {
    const pl = await getCurrentPlaylist();
    if (!pl || !Array.isArray(pl.items)) return;
    const removedId = pl.items[index];
    pl.items.splice(index, 1);
    await idbPut(STORE_PLAYLISTS, pl);
    await deleteOrphanedVideo(removedId);
    if (currentIndex >= pl.items.length) currentIndex = Math.max(0, pl.items.length - 1);
    await renderAll();
    scheduleRuntimeSave();
  });

  return li;
}

let currentTrackIdsCache = [];

async function refreshTrackList() {
  els.trackList.replaceChildren();
  const pl = await getCurrentPlaylist();
  currentTrackIdsCache = currentTrackIds(pl);
  if (!pl) {
    els.trackPanelSub.textContent = 'プレイリストを選んでください';
    els.totalDuration.textContent = '00:00:00';
    return;
  }

  const ids = currentTrackIdsCache;
  const rows = [];
  for (const id of ids) {
    const meta = await loadVideoMeta(id);
    if (!meta) continue;
    if (!matchesSearch(meta)) continue;
    rows.push(meta);
  }

  els.trackPanelSub.textContent = `${pl.name} · ${rows.length} 件表示`;
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    const meta = await loadVideoMeta(id);
    if (!meta) continue;
    if (!matchesSearch(meta)) continue;
    const item = renderTrackItem(meta, i);
    if (i === currentIndex) item.classList.add('active');
    els.trackList.appendChild(item);
  }
}

async function renderAll() {
  await refreshPlaylistList();
  await refreshTrackList();
  await refreshStats();
  updatePlayerUI();
  updateSeekUI();
  updateTrackMeta();
}

async function addFiles(files) {
  const accepted = Array.from(files).filter(isVideoFile).slice(0, MAX_FILES_PER_DROP);
  if (accepted.length === 0) {
    toast('動画ファイルを選んでください');
    return;
  }

  let pl = await getCurrentPlaylist();
  if (!pl) {
    currentPlaylist = await ensureDefaultPlaylist();
    pl = await getCurrentPlaylist();
  }
  if (!pl) return;

  for (const file of accepted) {
    const id = uid();
    const duration = await getVideoDuration(file);
    const thumbnail = await generateThumbnail(file);
    const blob = file.slice(0, file.size, file.type);

    const meta = {
      id,
      name: safeText(file.name) || 'video',
      duration: Number.isFinite(duration) ? duration : 0,
      mimeType: sanitizeMimeType(file.type),
      size: file.size,
      thumbnail,
      blob
    };

    await idbPut(STORE_VIDEOS, meta);
    videoCache.set(id, meta);
    pl.items.push(id);
  }

  await idbPut(STORE_PLAYLISTS, pl);
  currentPlaylist = pl.name;
  currentIndex = Math.max(0, pl.items.length - accepted.length);
  await renderAll();
  scheduleRuntimeSave();
  toast(`${accepted.length} 件を追加しました`);
}

function seekFromBar() {
  const duration = Number.isFinite(els.videoPlayer.duration) ? els.videoPlayer.duration : 0;
  if (duration <= 0) return;
  const ratio = Number(els.seekBar.value) / 1000;
  const next = Math.min(duration, Math.max(0, duration * ratio));
  els.videoPlayer.currentTime = next;
  lastSeekWasManual = true;
  updateSeekUI();
  scheduleRuntimeSave();
}

async function togglePlayPause() {
  if (els.videoPlayer.paused) {
    try {
      await els.videoPlayer.play();
    } catch {}
  } else {
    els.videoPlayer.pause();
  }
  updatePlayerUI();
  scheduleRuntimeSave();
}

async function seekBy(seconds) {
  const duration = Number.isFinite(els.videoPlayer.duration) ? els.videoPlayer.duration : 0;
  if (duration <= 0) return;
  const current = Number.isFinite(els.videoPlayer.currentTime) ? els.videoPlayer.currentTime : 0;
  els.videoPlayer.currentTime = Math.min(duration, Math.max(0, current + seconds));
  updateSeekUI();
  scheduleRuntimeSave();
}

async function toggleFullscreen() {
  try {
    const target = els.videoShell;
    if (!document.fullscreenElement) await target.requestFullscreen();
    else await document.exitFullscreen();
  } catch {}
}

function pickRandomDifferent(ids, currentId) {
  if (!ids.length) return null;
  if (ids.length === 1) return ids[0];
  let next = currentId;
  for (let i = 0; i < 12 && next === currentId; i++) {
    next = ids[Math.floor(Math.random() * ids.length)];
  }
  return next;
}

async function goNext() {
  const pl = await getCurrentPlaylist();
  const ids = currentTrackIds(pl);
  if (!ids.length) return;

  if (playMode === 'random') {
    const currentId = currentMeta?.id ?? ids[currentIndex] ?? null;
    const nextId = pickRandomDifferent(ids, currentId);
    if (!nextId) return;
    currentIndex = ids.indexOf(nextId);
    await loadAndPlayById(nextId, { autoplay: true, seekTime: 0 });
    await refreshTrackList();
    scheduleRuntimeSave();
    return;
  }

  if (playMode === 'shuffle') {
    if (shuffleOrder.length !== ids.length || !shuffleOrder.every((id) => ids.includes(id))) {
      shuffleOrder = ids.slice();
      shuffleArray(shuffleOrder);
      currentIndex = 0;
    } else {
      currentIndex = (currentIndex + 1) % shuffleOrder.length;
    }
    await playCurrent({ autoplay: true, seekTime: 0 });
    scheduleRuntimeSave();
    return;
  }

  currentIndex = (currentIndex + 1) % ids.length;
  await playCurrent({ autoplay: true, seekTime: 0 });
  scheduleRuntimeSave();
}

async function goPrev() {
  const pl = await getCurrentPlaylist();
  const ids = currentTrackIds(pl);
  if (!ids.length) return;

  if (playMode === 'random') {
    const currentId = currentMeta?.id ?? ids[currentIndex] ?? null;
    const nextId = pickRandomDifferent(ids, currentId);
    if (!nextId) return;
    currentIndex = ids.indexOf(nextId);
    await loadAndPlayById(nextId, { autoplay: true, seekTime: 0 });
    await refreshTrackList();
    scheduleRuntimeSave();
    return;
  }

  if (playMode === 'shuffle') {
    if (shuffleOrder.length !== ids.length || !shuffleOrder.every((id) => ids.includes(id))) {
      shuffleOrder = ids.slice();
      shuffleArray(shuffleOrder);
      currentIndex = 0;
    } else {
      currentIndex = (currentIndex - 1 + shuffleOrder.length) % shuffleOrder.length;
    }
    await playCurrent({ autoplay: true, seekTime: 0 });
    scheduleRuntimeSave();
    return;
  }

  currentIndex = (currentIndex - 1 + ids.length) % ids.length;
  await playCurrent({ autoplay: true, seekTime: 0 });
  scheduleRuntimeSave();
}

async function exportPlaylist(withBlobs) {
  const pl = await getCurrentPlaylist();
  if (!pl) {
    toast('プレイリストを選択してください');
    return;
  }
  const items = [];
  for (const id of pl.items) {
    const meta = await loadVideoMeta(id);
    if (!meta) continue;
    if (withBlobs && meta.blob) {
      const blobBase64 = await blobToBase64(meta.blob);
      items.push({
        id: meta.id,
        name: meta.name,
        duration: meta.duration,
        mimeType: meta.mimeType,
        size: meta.size,
        thumbnail: meta.thumbnail,
        blobBase64
      });
    } else {
      items.push({
        id: meta.id,
        name: meta.name,
        duration: meta.duration,
        mimeType: meta.mimeType,
        size: meta.size,
        thumbnail: meta.thumbnail
      });
    }
  }

  const exportObj = {
    format: 'playpocket-playlist',
    version: 2,
    name: pl.name,
    createdAt: new Date().toISOString(),
    items
  };

  const blob = new Blob([JSON.stringify(exportObj, null, 2)], { type: 'application/json' });
  downloadBlob(blob, `${pl.name}.${withBlobs ? 'full.' : ''}playlist.json`);
  toast(withBlobs ? '完全バックアップを書き出しました' : 'メタ付きで書き出しました');
}

function playlistNameForImport(baseName, existingNames) {
  const clean = normalizePlaylistName(baseName) || 'Imported';
  if (!existingNames.has(clean)) return clean;
  let i = 2;
  while (existingNames.has(`${clean} (${i})`)) i++;
  return `${clean} (${i})`;
}

async function importPlaylistFile(file) {
  if (!file) return;
  if (file.size > MAX_IMPORTED_JSON_BYTES) {
    toast('ファイルが大きすぎます');
    return;
  }

  try {
    const text = await file.text();
    const obj = JSON.parse(text);
    if (!obj || typeof obj !== 'object' || !Array.isArray(obj.items)) throw new Error('invalid');

    const existing = new Set((await loadAllPlaylists()).map((p) => p.name));
    const name = playlistNameForImport(obj.name || file.name.replace(/\.json$/i, ''), existing);
    const items = [];

    for (const item of obj.items.slice(0, MAX_IMPORTED_ITEMS)) {
      if (!item || typeof item !== 'object') continue;
      const id = safeText(String(item.id || '')) || uid();
      const meta = {
        id,
        name: safeText(item.name) || 'video',
        duration: Number.isFinite(Number(item.duration)) ? Math.max(0, Number(item.duration)) : 0,
        mimeType: sanitizeMimeType(item.mimeType),
        size: Number.isFinite(Number(item.size)) ? Math.max(0, Number(item.size)) : 0,
        thumbnail: sanitizeThumbnail(item.thumbnail),
        blob: null
      };

      if (typeof item.blobBase64 === 'string' && item.blobBase64.trim()) {
        try {
          meta.blob = base64ToBlob(item.blobBase64, meta.mimeType);
        } catch {
          meta.blob = null;
        }
      }

      await idbPut(STORE_VIDEOS, meta);
      videoCache.set(id, meta);
      items.push(id);
    }

    await idbPut(STORE_PLAYLISTS, { name, items });
    currentPlaylist = name;
    currentIndex = 0;
    await renderAll();
    scheduleRuntimeSave();
    toast('インポートしました');
  } catch {
    toast('インポートに失敗しました');
  }
}

async function createPlaylist() {
  const name = normalizePlaylistName(els.newPlaylistName.value);
  if (!name) return;
  const pls = await loadAllPlaylists();
  if (pls.some((p) => p.name === name)) {
    toast('同名のプレイリストが既に存在します');
    return;
  }
  await idbPut(STORE_PLAYLISTS, { name, items: [] });
  currentPlaylist = name;
  currentIndex = 0;
  els.newPlaylistName.value = '';
  await renderAll();
  scheduleRuntimeSave();
  toast('プレイリストを作成しました');
}

async function renameCurrentPlaylist() {
  const pl = await getCurrentPlaylist();
  if (!pl) return;
  const pls = await loadAllPlaylists();
  const next = normalizePlaylistName(prompt('新しいプレイリスト名', pl.name) || '');
  if (!next || next === pl.name) return;
  if (pls.some((p) => p.name === next)) {
    toast('同名のプレイリストが既に存在します');
    return;
  }
  await idbPut(STORE_PLAYLISTS, { name: next, items: pl.items.slice() });
  await idbDelete(STORE_PLAYLISTS, pl.name);
  if (currentPlaylist === pl.name) currentPlaylist = next;
  await renderAll();
  scheduleRuntimeSave();
  toast('名前を変更しました');
}

async function deleteCurrentPlaylist() {
  const pl = await getCurrentPlaylist();
  if (!pl) return;
  if (!confirm(`プレイリスト「${pl.name}」を削除しますか？`)) return;
  const itemIds = Array.isArray(pl.items) ? pl.items.slice() : [];
  await idbDelete(STORE_PLAYLISTS, pl.name);
  for (const id of itemIds) await deleteOrphanedVideo(id);
  const pls = await loadAllPlaylists();
  currentPlaylist = pls[0]?.name || null;
  currentIndex = 0;
  await renderAll();
  scheduleRuntimeSave();
  toast('プレイリストを削除しました');
}

async function restoreFromState() {
  if (!settings.restoreLastState || !restoreSnapshot) return;
  if (restoreSnapshot.playMode && ['order', 'shuffle', 'random'].includes(restoreSnapshot.playMode)) {
    applyPlaybackMode(restoreSnapshot.playMode);
  }
  if (Number.isFinite(restoreSnapshot.speed)) {
    els.speedSelect.value = String(Math.min(4, Math.max(0.25, Number(restoreSnapshot.speed))));
  }
  if (Number.isFinite(restoreSnapshot.volume)) {
    els.volumeSlider.value = String(Math.round(Math.min(1, Math.max(0, Number(restoreSnapshot.volume))) * 100));
    els.volumeLabel.textContent = `${els.volumeSlider.value}%`;
    els.videoPlayer.volume = Number(els.volumeSlider.value) / 100;
  }
  const pls = await loadAllPlaylists();
  const match = restoreSnapshot.currentPlaylist && pls.find((p) => p.name === restoreSnapshot.currentPlaylist);
  if (match) currentPlaylist = match.name;
  const pl = await getCurrentPlaylist();
  if (!pl || !Array.isArray(pl.items) || pl.items.length === 0) return;

  let targetIndex = 0;
  if (restoreSnapshot.lastTrackId && pl.items.includes(restoreSnapshot.lastTrackId)) {
    targetIndex = pl.items.indexOf(restoreSnapshot.lastTrackId);
  } else if (Number.isFinite(restoreSnapshot.currentIndex)) {
    targetIndex = Math.max(0, Math.min(pl.items.length - 1, Math.floor(Number(restoreSnapshot.currentIndex))));
  }
  currentIndex = targetIndex;
  const loaded = await loadAndPlayById(pl.items[targetIndex], {
    autoplay: !!restoreSnapshot.isPlaying,
    seekTime: Number.isFinite(restoreSnapshot.time) ? Number(restoreSnapshot.time) : 0,
    suppressSave: true
  });
  if (loaded && !restoreSnapshot.isPlaying) els.videoPlayer.pause();
  await renderAll();
  updatePlayerUI();
  updateSeekUI();
}

async function initFromStorage() {
  applySettingsToUI();
  els.trackSearch.value = '';
  searchQuery = '';
  els.speedSelect.value = '1';
  els.volumeSlider.value = String(Math.round((Number(localStorage.getItem('playpocket-volume') || '1') || 1) * 100));
  els.volumeLabel.textContent = `${els.volumeSlider.value}%`;
  els.videoPlayer.volume = Number(els.volumeSlider.value) / 100;
  els.videoPlayer.playbackRate = Number(els.speedSelect.value) || 1;
  applyPlaybackMode(playMode);
}

function wireEvents() {
  els.createPlaylistBtn.addEventListener('click', createPlaylist);
  els.newPlaylistName.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') createPlaylist();
  });

  els.fileInput.addEventListener('change', async (e) => {
    const files = e.target.files;
    if (files && files.length) await addFiles(files);
    els.fileInput.value = '';
  });

  els.dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    els.dropZone.classList.add('drag-over');
  });

  els.dropZone.addEventListener('dragleave', () => {
    els.dropZone.classList.remove('drag-over');
  });

  els.dropZone.addEventListener('drop', async (e) => {
    e.preventDefault();
    els.dropZone.classList.remove('drag-over');
    if (e.dataTransfer?.files?.length) {
      await addFiles(e.dataTransfer.files);
    }
  });

  els.exportMetaBtn.addEventListener('click', () => exportPlaylist(false));
  els.exportWithBlobsBtn.addEventListener('click', () => exportPlaylist(true));
  els.importFile.addEventListener('change', async (e) => {
    await importPlaylistFile(e.target.files?.[0]);
    els.importFile.value = '';
  });

  els.playPauseBtn.addEventListener('click', togglePlayPause);
  els.centerPlayBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    togglePlayPause();
  });
  els.videoShell.addEventListener('click', (e) => {
    if (e.target === els.centerPlayBtn) return;
    togglePlayPause();
  });

  els.prevBtn.addEventListener('click', goPrev);
  els.nextBtn.addEventListener('click', goNext);
  els.fullscreenBtn.addEventListener('click', toggleFullscreen);

  els.orderBtn.addEventListener('click', () => applyPlaybackMode('order'));
  els.shuffleBtn.addEventListener('click', () => applyPlaybackMode('shuffle'));
  els.randomBtn.addEventListener('click', () => applyPlaybackMode('random'));

  els.speedSelect.addEventListener('change', () => {
    els.videoPlayer.playbackRate = Number(els.speedSelect.value) || 1;
    scheduleRuntimeSave();
  });

  els.volumeSlider.addEventListener('input', () => {
    const vol = Number(els.volumeSlider.value) / 100;
    els.videoPlayer.volume = vol;
    els.volumeLabel.textContent = `${els.volumeSlider.value}%`;
    localStorage.setItem('playpocket-volume', String(vol));
    els.muteBtn.textContent = vol > 0 ? '🔊' : '🔇';
    scheduleRuntimeSave({ volume: vol });
  });

  els.muteBtn.addEventListener('click', () => {
    if (Number(els.volumeSlider.value) > 0) {
      els.volumeSlider.dataset.prev = els.volumeSlider.value;
      els.volumeSlider.value = '0';
      els.videoPlayer.volume = 0;
      els.volumeLabel.textContent = '0%';
      els.muteBtn.textContent = '🔇';
      localStorage.setItem('playpocket-volume', '0');
    } else {
      const prev = Math.min(100, Math.max(0, Number(els.volumeSlider.dataset.prev || '100') || 100));
      els.volumeSlider.value = String(prev);
      const vol = prev / 100;
      els.videoPlayer.volume = vol;
      els.volumeLabel.textContent = `${prev}%`;
      els.muteBtn.textContent = '🔊';
      localStorage.setItem('playpocket-volume', String(vol));
    }
    scheduleRuntimeSave();
  });

  els.seekBar.addEventListener('input', () => {
    updateSeekUI();
  });
  els.seekBar.addEventListener('change', seekFromBar);

  els.trackSearch.addEventListener('input', async () => {
    searchQuery = safeText(els.trackSearch.value).toLowerCase();
    await refreshTrackList();
  });

  els.openSettingsBtn.addEventListener('click', () => {
    els.settingsModal.classList.add('open');
    els.settingsModal.setAttribute('aria-hidden', 'false');
  });
  els.closeSettingsBtn.addEventListener('click', () => {
    els.settingsModal.classList.remove('open');
    els.settingsModal.setAttribute('aria-hidden', 'true');
  });
  els.settingsModal.addEventListener('click', (e) => {
    if (e.target === els.settingsModal) {
      els.settingsModal.classList.remove('open');
      els.settingsModal.setAttribute('aria-hidden', 'true');
    }
  });

  els.restoreLastState.addEventListener('change', () => {
    settings.restoreLastState = els.restoreLastState.checked;
    saveSettings();
  });
  els.autoAdvance.addEventListener('change', () => {
    settings.autoAdvance = els.autoAdvance.checked;
    saveSettings();
  });
  els.showThumbnails.addEventListener('change', () => {
    settings.showThumbnails = els.showThumbnails.checked;
    saveSettings();
    refreshTrackList();
  });
  els.compactMode.addEventListener('change', () => {
    settings.compactMode = els.compactMode.checked;
    saveSettings();
  });
  els.themeSelect.addEventListener('change', () => {
    settings.theme = els.themeSelect.value;
    saveSettings();
  });

  els.resetSettingsBtn.addEventListener('click', () => {
    settings = { ...DEFAULT_SETTINGS };
    saveSettings();
    toast('設定を初期化しました');
  });

  els.clearAllBtn.addEventListener('click', async () => {
    if (!confirm('全てのプレイリストと動画データを削除しますか？')) return;
    await idbClearAll();
    videoCache.clear();
    currentPlaylist = null;
    currentIndex = 0;
    shuffleOrder = [];
    clearCurrentObjectUrl();
    currentMeta = null;
    await idbPut(STORE_PLAYLISTS, { name: 'Default', items: [] });
    currentPlaylist = 'Default';
    await renderAll();
    scheduleRuntimeSave();
    toast('全データを削除しました');
  });

  els.renamePlaylistBtn.addEventListener('click', renameCurrentPlaylist);
  els.deletePlaylistBtn.addEventListener('click', deleteCurrentPlaylist);

  window.addEventListener('keydown', async (e) => {
    if (e.target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
    if (e.code === 'Space') {
      e.preventDefault();
      await togglePlayPause();
      return;
    }
    if (e.code === 'ArrowLeft') {
      e.preventDefault();
      await seekBy(e.shiftKey ? -10 : -5);
      return;
    }
    if (e.code === 'ArrowRight') {
      e.preventDefault();
      await seekBy(e.shiftKey ? 10 : 5);
      return;
    }
    if (e.code === 'KeyN') {
      e.preventDefault();
      await goNext();
      return;
    }
    if (e.code === 'KeyP') {
      e.preventDefault();
      await goPrev();
      return;
    }
    if (e.code === 'KeyF') {
      e.preventDefault();
      await toggleFullscreen();
    }
  });

  window.addEventListener('beforeunload', () => {
    if (runtimeSaveTimer) clearTimeout(runtimeSaveTimer);
    saveRuntimeStateNow();
    clearCurrentObjectUrl();
  });

  els.videoPlayer.addEventListener('loadedmetadata', () => {
    updateSeekUI();
    updatePlayerUI();
    updateTrackMeta();
  });

  els.videoPlayer.addEventListener('timeupdate', () => {
    updateSeekUI();
    scheduleRuntimeSave();
  });

  els.videoPlayer.addEventListener('durationchange', updateSeekUI);

  els.videoPlayer.addEventListener('play', () => {
    updatePlayerUI();
    scheduleRuntimeSave({ isPlaying: true });
  });

  els.videoPlayer.addEventListener('pause', () => {
    updatePlayerUI();
    scheduleRuntimeSave({ isPlaying: false });
  });

  els.videoPlayer.addEventListener('volumechange', () => {
    const vol = Math.min(1, Math.max(0, Number(els.videoPlayer.volume) || 0));
    els.volumeSlider.value = String(Math.round(vol * 100));
    els.volumeLabel.textContent = `${els.volumeSlider.value}%`;
    els.muteBtn.textContent = vol > 0 ? '🔊' : '🔇';
    localStorage.setItem('playpocket-volume', String(vol));
    scheduleRuntimeSave({ volume: vol });
  });

  els.videoPlayer.addEventListener('ended', async () => {
    if (!settings.autoAdvance) {
      updatePlayerUI();
      scheduleRuntimeSave({ isPlaying: false });
      return;
    }
    const pl = await getCurrentPlaylist();
    const ids = currentTrackIds(pl);
    if (!ids.length) return;
    if (playMode === 'random') {
      await goNext();
      return;
    }
    currentIndex = (currentIndex + 1) % ids.length;
    await playCurrent({ autoplay: true, seekTime: 0 });
    scheduleRuntimeSave();
  });
}

async function syncCurrentPlaylistSelection() {
  const pls = await loadAllPlaylists();
  if (pls.length === 0) {
    await idbPut(STORE_PLAYLISTS, { name: 'Default', items: [] });
    currentPlaylist = 'Default';
  } else if (!currentPlaylist || !pls.some((p) => p.name === currentPlaylist)) {
    currentPlaylist = pls[0].name;
  }
}

async function bootstrap() {
  await openDB();
  const vids = await idbGetAll(STORE_VIDEOS);
  for (const v of vids) {
    if (v?.id) videoCache.set(v.id, v);
  }
  await syncCurrentPlaylistSelection();
  applySettingsToUI();
  wireEvents();
  await renderAll();

  if (settings.restoreLastState && restoreSnapshot) {
    await restoreFromState();
  } else {
    const pl = await getCurrentPlaylist();
    if (pl && Array.isArray(pl.items) && pl.items.length) {
      await playCurrent({ autoplay: false, seekTime: 0, suppressSave: true });
      els.videoPlayer.pause();
    }
  }

  updatePlayerUI();
  updateSeekUI();
  updateTrackMeta();
  scheduleStatsRefresh();
  showStatus('準備完了');
}

async function getCurrentPlaylist() {
  if (!currentPlaylist) return null;
  return idbGet(STORE_PLAYLISTS, currentPlaylist);
}

window.addEventListener('DOMContentLoaded', () => {
  initFromStorage().then(() => {
    bootstrap().catch((err) => {
      console.error(err);
      showStatus('初期化に失敗しました');
      toast('初期化に失敗しました');
    });
  });
});

els.dropZone.addEventListener('click', () => els.fileInput.click());
els.videoShell.addEventListener('dblclick', toggleFullscreen);
