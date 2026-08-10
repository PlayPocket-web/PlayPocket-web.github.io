const DB_NAME = 'offline-playlist-db';
const DB_VERSION = 1;
const STORE_VIDEOS = 'videos';
const STORE_PLAYLISTS = 'playlists';

const SETTINGS_KEY = 'playpocket:settings';
const RUNTIME_STATE_KEY = 'playpocket:runtimeState';
const PLAYER_VOLUME_KEY = 'playpocket:volume';

const MAX_PLAYLIST_NAME_LENGTH = 80;
const MAX_IMPORTED_ITEMS = 500;
const MAX_IMPORTED_JSON_BYTES = 50 * 1024 * 1024;
const MAX_SHARED_PACKAGE_BYTES = 500 * 1024 * 1024;
const MAX_VIDEO_FILES_PER_DROP = 100;
const SHARE_PACKAGE_EXTENSION = '.playpocket.json';

const ALLOWED_THUMB_PREFIXES = [
  'data:image/jpeg;base64,',
  'data:image/png;base64,',
  'data:image/webp;base64,',
  'data:image/gif;base64,'
];

const ALLOWED_VIDEO_TYPES = new Set([
  'video/mp4',
  'video/webm',
  'video/ogg',
  'video/x-matroska',
  'video/quicktime',
  'video/x-msvideo'
]);

const DEFAULT_APP_SETTINGS = {
  audioPreset: 'standard',
  restoreLastState: true,
  keyboardShortcutsEnabled: true
};

let db;
let currentPlaylist = null;
let currentIndex = 0;
let playMode = 'order';
let shuffleOrder = [];
let videoListCache = {};
let currentObjectUrl = null;
let appSettings = { ...DEFAULT_APP_SETTINGS };
let startupRuntimeState = null;
let currentPlaylistSnapshot = [];
let runtimeStateDirtyTimer = null;

const fileInput = document.getElementById('fileInput');
const dropZone = document.getElementById('dropZone');
const playlistsEl = document.getElementById('playlists');
const newPlaylistName = document.getElementById('newPlaylistName');
const createPlaylistBtn = document.getElementById('createPlaylistBtn');
const trackListEl = document.getElementById('trackList');
const videoPlayer = document.getElementById('videoPlayer');
const videoStage = document.getElementById('videoStage');
const centerPlayBtn = document.getElementById('centerPlayBtn');
const seekBar = document.getElementById('seekBar');
const currentTimeEl = document.getElementById('currentTime');
const durationTimeEl = document.getElementById('durationTime');
const playPauseBtn = document.getElementById('playPauseBtn');
const prevBtn = document.getElementById('prevBtn');
const nextBtn = document.getElementById('nextBtn');
const orderBtn = document.getElementById('orderBtn');
const shuffleBtn = document.getElementById('shuffleBtn');
const randomBtn = document.getElementById('randomBtn');
const speedSelect = document.getElementById('speedSelect');
const fullscreenBtn = document.getElementById('fullscreenBtn');
const totalDurationEl = document.getElementById('totalDuration');
const exportMetaBtn = document.getElementById('exportMetaBtn');
const exportWithBlobsBtn = document.getElementById('exportWithBlobsBtn');
const importFile = document.getElementById('importFile');
const sharePlaylistBtn = document.getElementById('sharePlaylistBtn');
const shareModal = document.getElementById('shareModal');
const closeShareBtn = document.getElementById('closeShareBtn');
const sharePlaylistSummary = document.getElementById('sharePlaylistSummary');
const downloadSharePackageBtn = document.getElementById('downloadSharePackageBtn');
const copyShareCodeBtn = document.getElementById('copyShareCodeBtn');
const shareCodeInput = document.getElementById('shareCodeInput');
const importShareCodeBtn = document.getElementById('importShareCodeBtn');
const shareStatus = document.getElementById('shareStatus');

const openSettingsBtn = document.getElementById('openSettingsBtn');
const closeSettingsBtn = document.getElementById('closeSettingsBtn');
const settingsModal = document.getElementById('settingsModal');

const audioPresetSelect = document.getElementById('audioPreset');
const restoreLastStateInput = document.getElementById('restoreLastState');
const keyboardShortcutsEnabledInput = document.getElementById('keyboardShortcutsEnabled');
const storageUsageFill = document.getElementById('storageUsageFill');
const storageUsageText = document.getElementById('storageUsageText');
const clearAllDataBtn = document.getElementById('clearAllDataBtn');

function safeText(value, fallback = '') {
  if (typeof value !== 'string') return fallback;
  return value.replace(/[\u0000-\u001F\u007F]/g, '').trim();
}

function normalizePlaylistName(name) {
  const n = safeText(name);
  if (!n) return '';
  return n.length > MAX_PLAYLIST_NAME_LENGTH ? n.slice(0, MAX_PLAYLIST_NAME_LENGTH) : n;
}

function clampNumber(n, fallback = 0) {
  return Number.isFinite(n) ? n : fallback;
}

function uid() {
  if (crypto && crypto.randomUUID) return `id-${crypto.randomUUID()}`;
  return 'id-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function formatTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '00:00:00';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return [h, m, s].map((v) => String(v).padStart(2, '0')).join(':');
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  const decimals = unitIndex === 0 || value >= 10 ? 0 : 1;
  return `${value.toFixed(decimals)} ${units[unitIndex]}`;
}

function sanitizeThumbnail(value) {
  if (typeof value !== 'string') return null;
  if (value === '') return null;
  if (value.length >= 2_000_000) return null;
  for (const prefix of ALLOWED_THUMB_PREFIXES) {
    if (value.startsWith(prefix)) return value;
  }
  return null;
}

function sanitizeMimeType(type) {
  if (typeof type === 'string' && ALLOWED_VIDEO_TYPES.has(type)) return type;
  return 'video/mp4';
}

function displayTitle(name) {
  const text = safeText(name) || 'video';
  return text.replace(/\.[^/.]+$/, '');
}

function syncSettingsUI() {
  if (audioPresetSelect) audioPresetSelect.value = appSettings.audioPreset || 'standard';
  if (restoreLastStateInput) restoreLastStateInput.checked = !!appSettings.restoreLastState;
  if (keyboardShortcutsEnabledInput) keyboardShortcutsEnabledInput.checked = !!appSettings.keyboardShortcutsEnabled;
}

function applyAudioPreset() {
  if (!videoPlayer) return;
  const preset = appSettings.audioPreset || 'standard';
  const preservePitch = preset !== 'low';

  videoPlayer.preload = preset === 'high' ? 'auto' : 'metadata';
  try { videoPlayer.preservesPitch = preservePitch; } catch {}
  try { videoPlayer.mozPreservesPitch = preservePitch; } catch {}
  try { videoPlayer.webkitPreservesPitch = preservePitch; } catch {}
}

function loadSettingsFromStorage() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_APP_SETTINGS };
    const parsed = JSON.parse(raw);
    return {
      audioPreset: ['standard', 'high', 'low'].includes(parsed?.audioPreset) ? parsed.audioPreset : DEFAULT_APP_SETTINGS.audioPreset,
      restoreLastState: typeof parsed?.restoreLastState === 'boolean' ? parsed.restoreLastState : DEFAULT_APP_SETTINGS.restoreLastState,
      keyboardShortcutsEnabled: typeof parsed?.keyboardShortcutsEnabled === 'boolean' ? parsed.keyboardShortcutsEnabled : DEFAULT_APP_SETTINGS.keyboardShortcutsEnabled
    };
  } catch {
    return { ...DEFAULT_APP_SETTINGS };
  }
}

function persistSettings(next) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(next)); } catch {}
}

async function loadAppSettings() {
  appSettings = loadSettingsFromStorage();
  syncSettingsUI();
  applyAudioPreset();
}

async function saveAppSettings(partial) {
  appSettings = { ...appSettings, ...partial };
  persistSettings(appSettings);
  syncSettingsUI();
  applyAudioPreset();
}

function loadRuntimeStateFromStorage() {
  try {
    const raw = localStorage.getItem(RUNTIME_STATE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function buildRuntimeState(extra = {}) {
  return {
    lastPlaylist: currentPlaylist,
    lastCurrentIndex: currentIndex,
    lastPlayMode: playMode,
    lastVolume: clampNumber(parseFloat(localStorage.getItem(PLAYER_VOLUME_KEY) || String(videoPlayer?.volume ?? 1)), 1),
    lastSpeed: clampNumber(parseFloat(speedSelect?.value || '1'), 1),
    lastTrackId: getCurrentTrackId(),
    lastTime: clampNumber(videoPlayer?.currentTime, 0),
    isPlaying: !!(videoPlayer && !videoPlayer.paused && !videoPlayer.ended),
    ...extra
  };
}

function persistRuntimeState(state) {
  try { localStorage.setItem(RUNTIME_STATE_KEY, JSON.stringify(state)); } catch {}
}

function scheduleRuntimeStateSave(extra = {}) {
  if (runtimeStateDirtyTimer) clearTimeout(runtimeStateDirtyTimer);
  runtimeStateDirtyTimer = setTimeout(() => {
    runtimeStateDirtyTimer = null;
    persistRuntimeState(buildRuntimeState(extra));
  }, 250);
}

function openSettings() {
  if (!settingsModal) return;
  settingsModal.classList.add('open');
  settingsModal.setAttribute('aria-hidden', 'false');
  updateStorageUsageUI();
}

function closeSettings() {
  if (!settingsModal) return;
  settingsModal.classList.remove('open');
  settingsModal.setAttribute('aria-hidden', 'true');
}

async function openDB() {
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (e) => {
      const idb = e.target.result;
      if (!idb.objectStoreNames.contains(STORE_VIDEOS)) {
        idb.createObjectStore(STORE_VIDEOS, { keyPath: 'id' });
      }
      if (!idb.objectStoreNames.contains(STORE_PLAYLISTS)) {
        idb.createObjectStore(STORE_PLAYLISTS, { keyPath: 'name' });
      }
    };

    req.onsuccess = (e) => { db = e.target.result; res(db); };
    req.onerror = () => rej(req.error || new Error('IndexedDB open failed'));
  });
}

function idbPut(store, value) {
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readwrite');
    const s = tx.objectStore(store);
    const r = s.put(value);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error || new Error('IndexedDB put failed'));
  });
}

function idbGet(store, key) {
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readonly');
    const s = tx.objectStore(store);
    const r = s.get(key);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error || new Error('IndexedDB get failed'));
  });
}

function idbGetAll(store) {
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readonly');
    const s = tx.objectStore(store);
    const r = s.getAll();
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error || new Error('IndexedDB getAll failed'));
  });
}

function idbDelete(store, key) {
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readwrite');
    const s = tx.objectStore(store);
    const r = s.delete(key);
    r.onsuccess = () => res();
    r.onerror = () => rej(r.error || new Error('IndexedDB delete failed'));
  });
}

async function loadAllPlaylists() {
  const pls = await idbGetAll(STORE_PLAYLISTS);
  return Array.isArray(pls) ? pls : [];
}

async function idbRenamePlaylist(oldName, newName) {
  const safeOld = normalizePlaylistName(oldName);
  const safeNew = normalizePlaylistName(newName);
  if (!safeOld || !safeNew) throw new Error('invalid');
  if (safeOld === safeNew) return;

  return new Promise((res, rej) => {
    let rejected = false;

    const tx = db.transaction(STORE_PLAYLISTS, 'readwrite');
    const store = tx.objectStore(STORE_PLAYLISTS);

    const getOld = store.get(safeOld);
    getOld.onsuccess = () => {
      if (!getOld.result || !Array.isArray(getOld.result.items)) {
        rejected = true;
        tx.abort();
        return rej(new Error('notfound'));
      }
      const items = getOld.result.items.slice();

      const checkNew = store.get(safeNew);
      checkNew.onsuccess = () => {
        if (checkNew.result) {
          rejected = true;
          tx.abort();
          return rej(new Error('exists'));
        }
        store.put({ name: safeNew, items });
        store.delete(safeOld);
      };
      checkNew.onerror = () => {
        rejected = true;
        rej(checkNew.error || new Error('lookup failed'));
      };
    };
    getOld.onerror = () => {
      rejected = true;
      rej(getOld.error || new Error('lookup failed'));
    };

    tx.oncomplete = () => { if (!rejected) res(); };
    tx.onerror = () => { if (!rejected) rej(tx.error || new Error('transaction failed')); };
    tx.onabort = () => {};
  });
}

function shuffleArray(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function downloadBlob(blob, filename) {
  const a = document.createElement('a');
  const url = URL.createObjectURL(blob);
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function sanitizeFilename(value, fallback = 'playlist') {
  const filename = safeText(value).replace(/[<>:"/\\|?*]/g, '-').replace(/\.+$/g, '');
  return filename || fallback;
}

function setShareStatus(message = '', tone = '') {
  if (!shareStatus) return;
  shareStatus.textContent = message;
  shareStatus.className = `share-status${tone ? ` ${tone}` : ''}`;
}

async function openShareModal() {
  if (!shareModal) return;
  const playlist = await getCurrentPlaylist();
  const name = playlist?.name || currentPlaylist || 'プレイリスト';
  const count = Array.isArray(playlist?.items) ? playlist.items.length : 0;
  if (sharePlaylistSummary) {
    sharePlaylistSummary.textContent = `「${name}」を共有します。${count} 本の動画が含まれています。`;
  }
  setShareStatus();
  shareModal.classList.add('open');
  shareModal.setAttribute('aria-hidden', 'false');
}

function closeShareModal() {
  if (!shareModal) return;
  shareModal.classList.remove('open');
  shareModal.setAttribute('aria-hidden', 'true');
}

async function buildPlaylistExport(includeBlobs = false) {
  const pl = await getCurrentPlaylist();
  if (!pl) throw new Error('playlist-not-found');

  const items = [];
  for (const id of pl.items) {
    const meta = await idbGet(STORE_VIDEOS, id);
    if (!meta) continue;
    const item = {
      id: safeText(String(meta.id || '')) || uid(),
      name: safeText(meta.name) || 'video',
      duration: clampNumber(Number(meta.duration), 0),
      mimeType: sanitizeMimeType(meta.mimeType),
      size: clampNumber(Number(meta.size), 0),
      thumbnail: sanitizeThumbnail(meta.thumbnail)
    };
    if (includeBlobs && meta.blob) item.blobBase64 = await blobToBase64(meta.blob);
    items.push(item);
  }

  return { name: pl.name, items };
}

async function getUniquePlaylistName(baseName, suffix) {
  const normalized = normalizePlaylistName(baseName) || 'プレイリスト';
  const makeName = (tail) => {
    const available = Math.max(1, MAX_PLAYLIST_NAME_LENGTH - tail.length);
    return `${normalized.slice(0, available)}${tail}`;
  };
  const initial = makeName(suffix);
  if (!await idbGet(STORE_PLAYLISTS, initial)) return initial;

  for (let index = 2; index <= 999; index++) {
    const candidate = makeName(`${suffix} ${index}`);
    if (candidate && !await idbGet(STORE_PLAYLISTS, candidate)) return candidate;
  }
  throw new Error('playlist-name-unavailable');
}

async function importPlaylistPayload(payload, suffix) {
  const baseName = normalizePlaylistName(payload?.name);
  if (!baseName || !Array.isArray(payload?.items)) throw new Error('invalid');

  const name = await getUniquePlaylistName(baseName, suffix);
  const items = [];

  for (const it of payload.items.slice(0, MAX_IMPORTED_ITEMS)) {
    if (!it || typeof it !== 'object') continue;

    const id = uid();
    const metaName = normalizePlaylistName(it.name) || 'video';
    const duration = clampNumber(Number(it.duration), 0);
    const size = clampNumber(Number(it.size), 0);
    const thumbnail = sanitizeThumbnail(it.thumbnail);
    const mimeType = sanitizeMimeType(it.mimeType);
    let blob = null;

    if (typeof it.blobBase64 === 'string' && it.blobBase64.length > 0) {
      blob = base64ToBlob(it.blobBase64, mimeType);
    }

    const meta = { id, name: metaName, duration, mimeType, blob, thumbnail, size };
    await idbPut(STORE_VIDEOS, meta);
    videoListCache[id] = meta;
    items.push(id);
  }

  await idbPut(STORE_PLAYLISTS, { name, items });
  currentPlaylist = name;
  currentIndex = 0;
  await refreshPlaylistsUI();
  await refreshTrackList();
  await updateTotalDuration();
  updateSeekUI();
  scheduleRuntimeStateSave();
  updateStorageUsageUI();
  return { name, itemCount: items.length };
}

function blobToBase64(blob) {
  return new Promise((res, rej) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const result = String(reader.result || '');
        const comma = result.indexOf(',');
        res(comma >= 0 ? result.slice(comma + 1) : '');
      } catch (e) {
        rej(e);
      }
    };
    reader.onerror = () => rej(reader.error || new Error('FileReader error'));
    reader.readAsDataURL(blob);
  });
}

function base64ToBlob(base64, type) {
  if (typeof base64 !== 'string' || !base64) throw new Error('invalid base64');
  let bin;
  try {
    bin = atob(base64);
  } catch {
    throw new Error('invalid base64');
  }
  const len = bin.length;
  const arr = new Uint8Array(len);
  for (let i = 0; i < len; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: sanitizeMimeType(type) });
}

function getVideoDuration(file) {
  return new Promise((res) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.src = url;
    v.onloadedmetadata = () => {
      const d = Number.isFinite(v.duration) ? v.duration : 0;
      URL.revokeObjectURL(url);
      res(d);
    };
    v.onerror = () => { URL.revokeObjectURL(url); res(0); };
  });
}

async function generateThumbnail(file) {
  return new Promise((res) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.src = url;
    v.muted = true;
    v.playsInline = true;

    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      try { URL.revokeObjectURL(url); } catch {}
      res(value);
    };

    v.addEventListener('loadeddata', () => {
      try { v.currentTime = 0.1; } catch { finish(null); }
    });

    v.addEventListener('seeked', () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = 320;
        canvas.height = 180;
        const ctx = canvas.getContext('2d');
        if (!ctx) return finish(null);
        ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
        finish(canvas.toDataURL('image/jpeg', 0.7));
      } catch {
        finish(null);
      }
    });

    v.onerror = () => finish(null);
    setTimeout(() => finish(null), 3000);
  });
}

function isSupportedVideoFile(file) {
  return file instanceof File &&
    typeof file.type === 'string' &&
    file.type.startsWith('video/');
}

async function addFiles(files) {
  const accepted = Array.from(files)
    .filter(isSupportedVideoFile)
    .slice(0, MAX_VIDEO_FILES_PER_DROP);
  if (accepted.length === 0) return;

  for (const f of accepted) {
    const id = uid();
    const duration = await getVideoDuration(f);
    const thumb = await generateThumbnail(f);
    const blob = f.slice(0, f.size, f.type);

    const meta = {
      id,
      name: safeText(f.name) || 'video',
      duration: clampNumber(duration, 0),
      mimeType: f.type,
      blob,
      thumbnail: thumb,
      size: f.size
    };

    await idbPut(STORE_VIDEOS, meta);
    videoListCache[id] = meta;

    if (currentPlaylist) {
      const pl = await idbGet(STORE_PLAYLISTS, currentPlaylist);
      if (pl && Array.isArray(pl.items)) {
        pl.items.push(id);
        await idbPut(STORE_PLAYLISTS, pl);
      }
    } else {
      const defaultName = 'Default';
      let pl = await idbGet(STORE_PLAYLISTS, defaultName);
      if (!pl) {
        pl = { name: defaultName, items: [] };
        await idbPut(STORE_PLAYLISTS, pl);
      }
      pl.items.push(id);
      await idbPut(STORE_PLAYLISTS, pl);
      currentPlaylist = defaultName;
      currentIndex = 0;
    }
  }

  await refreshPlaylistsUI();
  await refreshTrackList();
  await updateTotalDuration();
  scheduleRuntimeStateSave();
  updateStorageUsageUI();
}

function getCurrentPlaylist() {
  if (!currentPlaylist) return Promise.resolve(null);
  return idbGet(STORE_PLAYLISTS, currentPlaylist).then((pl) => {
    if (!pl || !Array.isArray(pl.items)) return null;
    currentPlaylistSnapshot = pl.items.slice();
    return pl;
  });
}

async function deleteOrphanedVideo(id) {
  if (!id) return;
  const allPlaylists = await loadAllPlaylists();
  const stillReferenced = allPlaylists.some(
    (p) => Array.isArray(p.items) && p.items.includes(id)
  );
  if (!stillReferenced) {
    await idbDelete(STORE_VIDEOS, id);
    delete videoListCache[id];
  }
}

function renderEmptyHint(text) {
  const li = document.createElement('li');
  li.className = 'empty-hint';
  li.textContent = text;
  return li;
}

async function reorderCurrentPlaylist(fromIndex, toIndex) {
  if (!Number.isInteger(fromIndex) || !Number.isInteger(toIndex) || fromIndex === toIndex) return;

  const pl = await getCurrentPlaylist();
  if (!pl) return;
  if (fromIndex < 0 || fromIndex >= pl.items.length || toIndex < 0 || toIndex >= pl.items.length) return;

  const item = pl.items.splice(fromIndex, 1)[0];
  if (typeof item === 'undefined') return;

  pl.items.splice(toIndex, 0, item);
  await idbPut(STORE_PLAYLISTS, pl);

  if (currentIndex === fromIndex) currentIndex = toIndex;
  else if (fromIndex < currentIndex && toIndex >= currentIndex) currentIndex--;
  else if (fromIndex > currentIndex && toIndex <= currentIndex) currentIndex++;

  await refreshTrackList();
  updateSeekUI();
  scheduleRuntimeStateSave();
}

function renderTrackItem(meta, index, isPlaying, total) {
  const li = document.createElement('li');
  li.className = 'track-item';
  li.dataset.index = String(index);
  li.dataset.id = meta.id;
  li.draggable = true;
  if (isPlaying) li.classList.add('playing');

  const img = document.createElement('img');
  img.className = 'thumb';
  img.alt = 'サムネイル';
  img.referrerPolicy = 'no-referrer';
  img.src = sanitizeThumbnail(meta.thumbnail) ?? '';

  const metaWrap = document.createElement('div');
  metaWrap.className = 'meta';

  const title = document.createElement('div');
  title.className = 'title';
  title.textContent = displayTitle(meta.name);

  const sub = document.createElement('div');
  sub.className = 'sub';
  const sizeMB = Number.isFinite(meta.size) ? Math.round(meta.size / 1024 / 1024) : 0;
  sub.textContent = `${formatTime(meta.duration)} • ${sizeMB} MB`;

  metaWrap.appendChild(title);
  metaWrap.appendChild(sub);

  const actions = document.createElement('div');
  actions.className = 'track-actions';

  const playNowBtn = document.createElement('button');
  playNowBtn.className = 'small-btn play-now';
  playNowBtn.type = 'button';
  playNowBtn.textContent = '再生';

  const reorderRow = document.createElement('div');
  reorderRow.className = 'track-reorder-row';

  const moveUpBtn = document.createElement('button');
  moveUpBtn.className = 'small-btn move-up';
  moveUpBtn.type = 'button';
  moveUpBtn.textContent = '↑';
  moveUpBtn.setAttribute('aria-label', '上に移動');
  moveUpBtn.title = '上に移動';
  moveUpBtn.disabled = index <= 0;

  const moveDownBtn = document.createElement('button');
  moveDownBtn.className = 'small-btn move-down';
  moveDownBtn.type = 'button';
  moveDownBtn.textContent = '↓';
  moveDownBtn.setAttribute('aria-label', '下に移動');
  moveDownBtn.title = '下に移動';
  moveDownBtn.disabled = Number.isFinite(total) ? index >= total - 1 : false;

  reorderRow.appendChild(moveUpBtn);
  reorderRow.appendChild(moveDownBtn);

  const removeBtn = document.createElement('button');
  removeBtn.className = 'small-btn remove';
  removeBtn.type = 'button';
  removeBtn.textContent = '削除';

  actions.appendChild(playNowBtn);
  actions.appendChild(reorderRow);
  actions.appendChild(removeBtn);

  li.appendChild(img);
  li.appendChild(metaWrap);
  li.appendChild(actions);

  li.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/plain', String(index));
    li.classList.add('dragging');
  });
  li.addEventListener('dragend', () => li.classList.remove('dragging'));
  li.addEventListener('dragover', (e) => { e.preventDefault(); li.classList.add('drag-over'); });
  li.addEventListener('dragleave', () => li.classList.remove('drag-over'));

  li.addEventListener('drop', async (e) => {
    e.preventDefault();
    li.classList.remove('drag-over');

    const fromIndex = parseInt(e.dataTransfer.getData('text/plain'), 10);
    const toIndex = index;
    await reorderCurrentPlaylist(fromIndex, toIndex);
  });

  moveUpBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    await reorderCurrentPlaylist(index, index - 1);
  });

  moveDownBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    await reorderCurrentPlaylist(index, index + 1);
  });

  playNowBtn.addEventListener('click', async () => {
    currentIndex = index;
    await playCurrent({ autoplay: true, seekTime: 0 });
    await refreshTrackList();
    scheduleRuntimeStateSave();
  });

  removeBtn.addEventListener('click', async () => {
    if (!currentPlaylist) return;
    const pl = await getCurrentPlaylist();
    if (!pl) return;

    const removedId = pl.items[index];
    pl.items.splice(index, 1);
    await idbPut(STORE_PLAYLISTS, pl);

    if (removedId) {
      await deleteOrphanedVideo(removedId);
    }

    if (currentIndex >= pl.items.length) currentIndex = Math.max(0, pl.items.length - 1);
    await refreshTrackList();
    await updateTotalDuration();
    updateSeekUI();
    scheduleRuntimeStateSave();
    updateStorageUsageUI();
  });

  return li;
}

async function renamePlaylistByPrompt(currentName) {
  const input = prompt('プレイリスト名を入力してください', currentName);
  if (input == null) return;

  const trimmed = normalizePlaylistName(input);
  if (!trimmed) {
    alert('無効な名前です');
    return;
  }

  if (trimmed === currentName) return;

  try {
    await idbRenamePlaylist(currentName, trimmed);
    if (currentPlaylist === currentName) currentPlaylist = trimmed;
    await refreshPlaylistsUI();
    await refreshTrackList();
    await updateTotalDuration();
    updateSeekUI();
    scheduleRuntimeStateSave();
  } catch (err) {
    if (err?.message === 'exists') alert('同名のプレイリストが既に存在します');
    else alert('名前変更に失敗しました');
  }
}

async function refreshPlaylistsUI() {
  playlistsEl.replaceChildren();
  const pls = await loadAllPlaylists();

  if (pls.length === 0) {
    playlistsEl.appendChild(renderEmptyHint('プレイリストがありません。上のフォームから作成してください。'));
    return;
  }

  for (const p of pls) {
    const name = normalizePlaylistName(p?.name);
    if (!name) continue;

    const li = document.createElement('li');
    li.className = 'playlist-item';
    li.dataset.name = name;
    if (name === currentPlaylist) li.classList.add('active');

    const nameSpan = document.createElement('span');
    nameSpan.className = 'playlist-name';
    nameSpan.textContent = name;
    nameSpan.title = 'クリックで選択 / 右クリックで名前変更';

    nameSpan.addEventListener('click', async (e) => {
      e.stopPropagation();
      currentPlaylist = name;
      currentIndex = 0;
      await refreshPlaylistsUI();
      await refreshTrackList();
      await updateTotalDuration();
      updateSeekUI();
      scheduleRuntimeStateSave();
    });

    nameSpan.addEventListener('contextmenu', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      await renamePlaylistByPrompt(name);
    });

    const delBtn = document.createElement('button');
    delBtn.className = 'small-btn';
    delBtn.type = 'button';
    delBtn.textContent = '削除';

    delBtn.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      if (!confirm(`プレイリスト「${name}」を削除しますか？`)) return;

      const targetPl = await idbGet(STORE_PLAYLISTS, name);
      const itemIds = (targetPl && Array.isArray(targetPl.items)) ? targetPl.items.slice() : [];

      await idbDelete(STORE_PLAYLISTS, name);

      for (const id of itemIds) {
        await deleteOrphanedVideo(id);
      }

      if (currentPlaylist === name) {
        const plsAfter = await loadAllPlaylists();
        currentPlaylist = plsAfter[0]?.name || null;
        currentIndex = 0;
      }

      await refreshPlaylistsUI();
      await refreshTrackList();
      await updateTotalDuration();
      updateSeekUI();
      scheduleRuntimeStateSave();
      updateStorageUsageUI();
    });

    li.appendChild(nameSpan);
    li.appendChild(delBtn);
    playlistsEl.appendChild(li);
  }
}

createPlaylistBtn.addEventListener('click', async () => {
  const name = normalizePlaylistName(newPlaylistName.value);
  if (!name) return;

  const exists = await idbGet(STORE_PLAYLISTS, name);
  if (exists) {
    alert('同名のプレイリストが既に存在します');
    return;
  }

  await idbPut(STORE_PLAYLISTS, { name, items: [] });
  newPlaylistName.value = '';
  currentPlaylist = name;
  currentIndex = 0;
  await refreshPlaylistsUI();
  await refreshTrackList();
  await updateTotalDuration();
  updateSeekUI();
  scheduleRuntimeStateSave();
});

async function refreshTrackList() {
  trackListEl.replaceChildren();

  const pl = await getCurrentPlaylist();
  currentPlaylistSnapshot = pl && Array.isArray(pl.items) ? pl.items.slice() : [];
  if (!pl) {
    trackListEl.appendChild(renderEmptyHint('プレイリストを選択するか、新しく作成してください。'));
    return;
  }

  for (const id of pl.items) {
    if (!videoListCache[id]) {
      const v = await idbGet(STORE_VIDEOS, id);
      if (v) videoListCache[id] = v;
    }
  }

  if (pl.items.length === 0) {
    trackListEl.appendChild(renderEmptyHint('このプレイリストにはまだ動画がありません。左のパネルから追加してください。'));
    return;
  }

  pl.items.forEach((id, i) => {
    const meta = videoListCache[id];
    if (!meta) return;
    trackListEl.appendChild(renderTrackItem(meta, i, i === currentIndex, pl.items.length));
  });
}

function getPlaylistLength(pl) {
  return pl && Array.isArray(pl.items) ? pl.items.length : 0;
}

function getCurrentTrackId() {
  const items = Array.isArray(currentPlaylistSnapshot) ? currentPlaylistSnapshot : [];
  if (items.length === 0) return null;

  if (playMode === 'shuffle' && shuffleOrder.length > 0) {
    return shuffleOrder[currentIndex % shuffleOrder.length] || null;
  }

  const index = Math.min(items.length - 1, Math.max(0, currentIndex));
  return items[index] || null;
}

function setPlayerUIState() {
  const paused = videoPlayer.paused || videoPlayer.ended;
  if (videoStage) videoStage.classList.toggle('paused', paused);
  if (centerPlayBtn) centerPlayBtn.textContent = paused ? '▶' : 'Ⅱ';
  if (playPauseBtn) playPauseBtn.textContent = paused ? '▶' : 'Ⅱ';
  if ('mediaSession' in navigator) {
    try { navigator.mediaSession.playbackState = paused ? 'paused' : 'playing'; } catch {}
  }
}

function updateSeekUI() {
  const duration = Number.isFinite(videoPlayer.duration) ? videoPlayer.duration : 0;
  const current = Number.isFinite(videoPlayer.currentTime) ? videoPlayer.currentTime : 0;

  if (durationTimeEl) durationTimeEl.textContent = formatTime(duration);
  if (currentTimeEl) currentTimeEl.textContent = formatTime(current);

  if (seekBar && duration > 0) {
    const ratio = Math.min(1, Math.max(0, current / duration));
    if (!seekBar.matches(':active')) {
      seekBar.value = String(Math.round(ratio * 1000));
    }
  } else if (seekBar && duration <= 0) {
    seekBar.value = '0';
  }
}

function seekFromBar() {
  const duration = Number.isFinite(videoPlayer.duration) ? videoPlayer.duration : 0;
  if (!seekBar || duration <= 0) return;

  const ratio = Math.min(1, Math.max(0, parseFloat(seekBar.value) / 1000));
  videoPlayer.currentTime = duration * ratio;
  updateSeekUI();
  scheduleRuntimeStateSave();
}

function updateMediaSessionMetadata(meta) {
  if (!('mediaSession' in navigator) || !meta || typeof MediaMetadata === 'undefined') return;
  const thumb = sanitizeThumbnail(meta.thumbnail);
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: displayTitle(meta.name),
      artist: 'PlayPocket',
      album: currentPlaylist || '',
      artwork: thumb ? [{ src: thumb, sizes: '320x180', type: 'image/jpeg' }] : []
    });
  } catch {}
}

async function loadAndPlayById(id, options = {}) {
  const meta = await idbGet(STORE_VIDEOS, id);
  if (!meta || !meta.blob) {
    alert('この動画はプレースホルダです。元ファイルを再追加してください。');
    return false;
  }

  if (currentObjectUrl) {
    try { URL.revokeObjectURL(currentObjectUrl); } catch {}
    currentObjectUrl = null;
  }

  const seekTime = Number.isFinite(options.seekTime) ? Math.max(0, options.seekTime) : 0;
  const autoplay = options.autoplay !== false;

  currentObjectUrl = URL.createObjectURL(meta.blob);
  videoPlayer.src = currentObjectUrl;
  videoPlayer.load();
  videoPlayer.playbackRate = parseFloat(speedSelect.value) || 1;
  applyAudioPreset();

  const vol = parseFloat(localStorage.getItem(PLAYER_VOLUME_KEY) || '1');
  videoPlayer.volume = Number.isFinite(vol) ? vol : 1;

  await new Promise((resolve) => {
    const done = () => resolve();
    videoPlayer.addEventListener('loadedmetadata', done, { once: true });
    videoPlayer.addEventListener('error', done, { once: true });
  });

  if (Number.isFinite(seekTime) && seekTime > 0 && Number.isFinite(videoPlayer.duration) && videoPlayer.duration > 0) {
    const target = Math.min(seekTime, Math.max(0, videoPlayer.duration - 0.1));
    try { videoPlayer.currentTime = target; } catch {}
  }

  if (autoplay) {
    try {
      await videoPlayer.play();
    } catch (err) {
      if (err.name !== 'AbortError') {
        console.warn('videoPlayer.play() failed:', err);
      }
    }
  } else {
    videoPlayer.pause();
  }

  setPlayerUIState();
  updateSeekUI();
  updateMediaSessionMetadata(meta);
  scheduleRuntimeStateSave({ lastTrackId: meta.id });
  return true;
}

async function playCurrent(options = {}) {
  const pl = await getCurrentPlaylist();
  currentPlaylistSnapshot = pl && Array.isArray(pl.items) ? pl.items.slice() : [];
  if (!pl || pl.items.length === 0) return false;

  let id = null;

  if (playMode === 'shuffle') {
    if (shuffleOrder.length !== pl.items.length ||
      !shuffleOrder.every((x) => pl.items.includes(x))) {
      shuffleOrder = shuffleArray(pl.items.slice());
      currentIndex = 0;
    }
    id = shuffleOrder[currentIndex % shuffleOrder.length];
  } else if (playMode === 'random') {
    id = pl.items[Math.floor(Math.random() * pl.items.length)];
    currentIndex = pl.items.indexOf(id);
  } else {
    currentIndex = ((currentIndex % pl.items.length) + pl.items.length) % pl.items.length;
    id = pl.items[currentIndex];
  }

  if (!id) return false;
  await loadAndPlayById(id, options);
  await refreshTrackList();
  return true;
}

async function updateTotalDuration() {
  const pl = await getCurrentPlaylist();
  if (!pl) {
    totalDurationEl.textContent = '00:00:00';
    return;
  }

  let total = 0;
  for (const id of pl.items) {
    const meta = await idbGet(STORE_VIDEOS, id);
    if (meta && Number.isFinite(meta.duration)) total += meta.duration;
  }
  totalDurationEl.textContent = formatTime(total);
}

function createVolumeControls() {
  const playerControls = document.querySelector('.player-controls');
  if (!playerControls) return;
  if (playerControls.querySelector('.volume-controls')) return;

  const volWrap = document.createElement('div');
  volWrap.className = 'volume-controls';
  Object.assign(volWrap.style, { display: 'flex', alignItems: 'center', gap: '8px', marginLeft: '8px' });

  const muteBtn = document.createElement('button');
  muteBtn.className = 'small-btn';
  muteBtn.type = 'button';
  muteBtn.title = 'ミュート/ミュート解除';
  muteBtn.textContent = '🔊';

  const volSlider = document.createElement('input');
  volSlider.type = 'range';
  volSlider.min = 0;
  volSlider.max = 1;
  volSlider.step = 0.01;
  volSlider.style.width = '120px';

  const volLabel = document.createElement('div');
  volLabel.style.color = 'var(--muted)';
  volLabel.style.fontSize = '13px';

  const saved = parseFloat(localStorage.getItem(PLAYER_VOLUME_KEY) || '1');
  const initVol = Number.isFinite(saved) ? Math.min(1, Math.max(0, saved)) : 1;
  volSlider.value = String(initVol);
  volLabel.textContent = `${Math.round(initVol * 100)}%`;
  videoPlayer.volume = initVol;
  muteBtn.textContent = initVol > 0 ? '🔊' : '🔇';

  volSlider.addEventListener('input', () => {
    const v = Math.min(1, Math.max(0, parseFloat(volSlider.value) || 0));
    videoPlayer.volume = v;
    localStorage.setItem(PLAYER_VOLUME_KEY, String(v));
    volLabel.textContent = `${Math.round(v * 100)}%`;
    muteBtn.textContent = v > 0 ? '🔊' : '🔇';
    scheduleRuntimeStateSave();
  });

  muteBtn.addEventListener('click', () => {
    if (videoPlayer.volume > 0) {
      volSlider.dataset.prev = volSlider.value;
      volSlider.value = '0';
      videoPlayer.volume = 0;
      localStorage.setItem(PLAYER_VOLUME_KEY, '0');
      volLabel.textContent = '0%';
      muteBtn.textContent = '🔇';
    } else {
      const prev = Math.min(1, Math.max(0, parseFloat(volSlider.dataset.prev || '1') || 1));
      volSlider.value = String(prev);
      videoPlayer.volume = prev;
      localStorage.setItem(PLAYER_VOLUME_KEY, String(prev));
      volLabel.textContent = `${Math.round(prev * 100)}%`;
      muteBtn.textContent = '🔊';
    }
    scheduleRuntimeStateSave();
  });

  volWrap.appendChild(muteBtn);
  volWrap.appendChild(volSlider);
  volWrap.appendChild(volLabel);
  playerControls.appendChild(volWrap);
}

function setMode(m) {
  playMode = m;
  orderBtn.classList.toggle('active', m === 'order');
  shuffleBtn.classList.toggle('active', m === 'shuffle');
  randomBtn.classList.toggle('active', m === 'random');
  if (m === 'shuffle') shuffleOrder = [];
  scheduleRuntimeStateSave();
}

function isEditableTarget(target) {
  if (!target) return false;
  const tag = String(target.tagName || '').toLowerCase();
  return target.isContentEditable || tag === 'input' || tag === 'textarea' || tag === 'select';
}

async function togglePlayPause() {
  if (videoPlayer.paused) {
    try {
      await videoPlayer.play();
    } catch (err) {
      if (err.name !== 'AbortError') {
        console.warn('togglePlayPause play() failed:', err);
      }
    }
  } else {
    videoPlayer.pause();
  }
  setPlayerUIState();
  scheduleRuntimeStateSave();
}

async function seekBy(seconds) {
  const duration = Number.isFinite(videoPlayer.duration) ? videoPlayer.duration : 0;
  if (duration <= 0) return;
  const next = Math.min(duration, Math.max(0, (Number.isFinite(videoPlayer.currentTime) ? videoPlayer.currentTime : 0) + seconds));
  videoPlayer.currentTime = next;
  updateSeekUI();
  scheduleRuntimeStateSave();
}

async function toggleFullscreen() {
  try {
    const target = document.querySelector('.video-shell') || videoStage || document.documentElement;
    if (!document.fullscreenElement) {
      if (target.requestFullscreen) {
        await target.requestFullscreen();
      } else if (videoPlayer.webkitEnterFullscreen) {
        videoPlayer.webkitEnterFullscreen();
      }
    } else if (document.exitFullscreen) {
      await document.exitFullscreen();
    }
  } catch {}
}

function setupMediaSession() {
  if (!('mediaSession' in navigator)) return;
  try { navigator.mediaSession.setActionHandler('play', () => togglePlayPause()); } catch {}
  try { navigator.mediaSession.setActionHandler('pause', () => togglePlayPause()); } catch {}
  try { navigator.mediaSession.setActionHandler('previoustrack', () => prevBtn?.click()); } catch {}
  try { navigator.mediaSession.setActionHandler('nexttrack', () => nextBtn?.click()); } catch {}
  try { navigator.mediaSession.setActionHandler('seekbackward', () => seekBy(-10)); } catch {}
  try { navigator.mediaSession.setActionHandler('seekforward', () => seekBy(10)); } catch {}
}

async function requestPersistentStorageIfPossible() {
  try {
    if (navigator.storage?.persist) await navigator.storage.persist();
  } catch {}
}

async function updateStorageUsageUI() {
  if (!storageUsageFill || !storageUsageText) return;
  if (!navigator.storage?.estimate) {
    storageUsageText.textContent = 'このブラウザではストレージ使用量を取得できません';
    return;
  }
  try {
    const { usage = 0, quota = 0 } = await navigator.storage.estimate();
    const ratio = quota > 0 ? Math.min(1, usage / quota) : 0;
    storageUsageFill.style.width = `${Math.round(ratio * 100)}%`;
    storageUsageText.textContent = `${formatBytes(usage)} / ${formatBytes(quota)} 使用中`;
  } catch {
    storageUsageText.textContent = 'ストレージ使用量を取得できませんでした';
  }
}

clearAllDataBtn?.addEventListener('click', async () => {
  if (!confirm('保存されているすべてのプレイリストと動画データを削除します。この操作は取り消せません。よろしいですか？')) return;

  try {
    if (db) {
      try { db.close(); } catch {}
      db = undefined;
    }

    await new Promise((resolve, reject) => {
      const req = indexedDB.deleteDatabase(DB_NAME);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error || new Error('delete failed'));
      req.onblocked = () => resolve();
    });

    localStorage.removeItem(RUNTIME_STATE_KEY);
    localStorage.removeItem(PLAYER_VOLUME_KEY);

    if ('caches' in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key)));
    }

    alert('データを削除しました。ページを再読み込みします。');
    location.reload();
  } catch {
    alert('データの削除に失敗しました。');
  }
});

playPauseBtn.addEventListener('click', async () => {
  await togglePlayPause();
});

centerPlayBtn?.addEventListener('click', async (e) => {
  e.stopPropagation();
  await togglePlayPause();
});

videoStage?.addEventListener('click', (e) => {
  if (e.target === centerPlayBtn) return;
  togglePlayPause();
});

seekBar?.addEventListener('input', () => {
  updateSeekUI();
});

seekBar?.addEventListener('change', () => {
  seekFromBar();
});

fullscreenBtn?.addEventListener('click', async () => {
  await toggleFullscreen();
});

prevBtn.addEventListener('click', async () => {
  const pl = await getCurrentPlaylist();
  const len = getPlaylistLength(pl);
  if (!len) return;
  if (playMode === 'random') { await playCurrent(); return; }
  currentIndex = (currentIndex - 1 + len) % len;
  await playCurrent();
  scheduleRuntimeStateSave();
});

nextBtn.addEventListener('click', async () => {
  const pl = await getCurrentPlaylist();
  const len = getPlaylistLength(pl);
  if (!len) return;
  if (playMode === 'random') { await playCurrent(); return; }
  currentIndex = (currentIndex + 1) % len;
  await playCurrent();
  scheduleRuntimeStateSave();
});

orderBtn.addEventListener('click', () => setMode('order'));
shuffleBtn.addEventListener('click', () => setMode('shuffle'));
randomBtn.addEventListener('click', () => setMode('random'));

speedSelect.addEventListener('change', () => {
  videoPlayer.playbackRate = parseFloat(speedSelect.value) || 1;
  scheduleRuntimeStateSave();
});

dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('drag'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag'));
dropZone.addEventListener('drop', async (e) => {
  e.preventDefault();
  dropZone.classList.remove('drag');
  await addFiles(e.dataTransfer.files);
});

fileInput.addEventListener('change', async (e) => {
  await addFiles(e.target.files);
  fileInput.value = '';
});

sharePlaylistBtn?.addEventListener('click', async () => {
  if (!currentPlaylist) {
    alert('共有するプレイリストを選択してください');
    return;
  }
  await openShareModal();
});

closeShareBtn?.addEventListener('click', closeShareModal);

shareModal?.addEventListener('click', (event) => {
  if (event.target === shareModal) closeShareModal();
});

downloadSharePackageBtn?.addEventListener('click', async () => {
  try {
    setShareStatus('共有ファイルを作成しています。動画の容量によっては時間がかかります。');
    downloadSharePackageBtn.disabled = true;
    const playlist = await buildPlaylistExport(true);
    const sharePackage = {
      format: 'playpocket-share',
      version: 1,
      mediaIncluded: true,
      ...playlist
    };
    const packageBlob = new Blob([JSON.stringify(sharePackage)], { type: 'application/json' });
    if (packageBlob.size > MAX_SHARED_PACKAGE_BYTES) throw new Error('share-package-too-large');
    downloadBlob(packageBlob, `${sanitizeFilename(playlist.name)}${SHARE_PACKAGE_EXTENSION}`);
    setShareStatus('共有ファイルを作成しました。ダウンロードしたファイルを相手に送ってください。', 'success');
  } catch (error) {
    console.error(error);
    const message = error?.message === 'share-package-too-large'
      ? '共有ファイルは 500MB までです。動画を減らして、もう一度試してください。'
      : '共有ファイルを作成できませんでした。動画の容量を確認して、もう一度試してください。';
    setShareStatus(message, 'error');
  } finally {
    downloadSharePackageBtn.disabled = false;
  }
});

copyShareCodeBtn?.addEventListener('click', async () => {
  try {
    const playlist = await buildPlaylistExport(false);
    const codePlaylist = {
      name: playlist.name,
      items: playlist.items.map(({ name, duration, mimeType, size }) => ({ name, duration, mimeType, size }))
    };
    const code = window.PlayPocketShare.createCode({
      version: 1,
      kind: 'playlist-metadata',
      playlist: codePlaylist
    });
    await window.PlayPocketShare.copyText(code);
    setShareStatus('共有コードをコピーしました。動画データは含まれません。', 'success');
  } catch (error) {
    console.error(error);
    setShareStatus('共有コードをコピーできませんでした。プレイリストを短くして、もう一度試してください。', 'error');
  }
});

importShareCodeBtn?.addEventListener('click', async () => {
  try {
    const decoded = window.PlayPocketShare.parseCode(shareCodeInput?.value || '');
    if (decoded?.version !== 1 || decoded?.kind !== 'playlist-metadata') throw new Error('invalid-share-code');
    const imported = await importPlaylistPayload(decoded.playlist, ' (shared)');
    if (shareCodeInput) shareCodeInput.value = '';
    setShareStatus(`「${imported.name}」を読み込みました。動画データは含まれません。`, 'success');
  } catch (error) {
    console.error(error);
    setShareStatus('共有コードを読み込めませんでした。コード全体を貼り付けてください。', 'error');
  }
});

exportMetaBtn.addEventListener('click', async () => {
  if (!currentPlaylist) return alert('プレイリストを選択してください');
  const exportObj = await buildPlaylistExport(false);
  const blob = new Blob([JSON.stringify(exportObj)], { type: 'application/json' });
  downloadBlob(blob, `${sanitizeFilename(exportObj.name)}.playlist.json`);
});

exportWithBlobsBtn.addEventListener('click', async () => {
  if (!currentPlaylist) return alert('プレイリストを選択してください');
  const exportObj = await buildPlaylistExport(true);
  const blob = new Blob([JSON.stringify(exportObj)], { type: 'application/json' });
  downloadBlob(blob, `${sanitizeFilename(exportObj.name)}.playlist.full.json`);
});

importFile.addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (!f) return;

  try {
    const maxBytes = f.name.toLowerCase().endsWith(SHARE_PACKAGE_EXTENSION)
      ? MAX_SHARED_PACKAGE_BYTES
      : MAX_IMPORTED_JSON_BYTES;
    if (f.size > maxBytes) throw new Error('file-too-large');

    const txt = await f.text();
    const obj = JSON.parse(txt);
    if (!obj || typeof obj !== 'object') throw new Error('invalid');

    await importPlaylistPayload(obj, ' (import)');
  } catch {
    alert('インポートに失敗しました');
  }

  importFile.value = '';
});

videoPlayer.addEventListener('loadedmetadata', () => {
  updateSeekUI();
  setPlayerUIState();
});

videoPlayer.addEventListener('timeupdate', () => {
  updateSeekUI();
});

videoPlayer.addEventListener('durationchange', updateSeekUI);

videoPlayer.addEventListener('ended', async () => {
  const pl = await getCurrentPlaylist();
  currentPlaylistSnapshot = pl && Array.isArray(pl.items) ? pl.items.slice() : [];
  if (!pl || pl.items.length === 0) return;
  if (playMode === 'random') { await playCurrent(); return; }
  currentIndex = (currentIndex + 1) % pl.items.length;
  await playCurrent();
  scheduleRuntimeStateSave();
});

videoPlayer.addEventListener('play', async () => {
  const pl = await getCurrentPlaylist();
  currentPlaylistSnapshot = pl && Array.isArray(pl.items) ? pl.items.slice() : [];
  if (!pl || pl.items.length === 0) return;
  const id = pl.items[currentIndex];
  const meta = await idbGet(STORE_VIDEOS, id);
  if (meta && !meta.blob) {
    alert('この動画はプレースホルダです。元ファイルを再追加してください。');
    videoPlayer.pause();
  }
  setPlayerUIState();
  updateSeekUI();
  scheduleRuntimeStateSave({ isPlaying: true });
});

videoPlayer.addEventListener('pause', () => {
  setPlayerUIState();
  updateSeekUI();
  scheduleRuntimeStateSave({ isPlaying: false });
});

videoPlayer.addEventListener('volumechange', () => {
  const v = Math.min(1, Math.max(0, videoPlayer.volume || 0));
  localStorage.setItem(PLAYER_VOLUME_KEY, String(v));
  scheduleRuntimeStateSave({ lastVolume: v });
});

openSettingsBtn?.addEventListener('click', openSettings);
closeSettingsBtn?.addEventListener('click', closeSettings);

settingsModal?.addEventListener('click', (e) => {
  if (e.target === settingsModal) closeSettings();
});

audioPresetSelect?.addEventListener('change', async () => {
  await saveAppSettings({ audioPreset: audioPresetSelect.value });
});

restoreLastStateInput?.addEventListener('change', async () => {
  await saveAppSettings({ restoreLastState: restoreLastStateInput.checked });
});

keyboardShortcutsEnabledInput?.addEventListener('change', async () => {
  await saveAppSettings({ keyboardShortcutsEnabled: keyboardShortcutsEnabledInput.checked });
});

window.addEventListener('keydown', async (e) => {
  if (!appSettings.keyboardShortcutsEnabled) return;
  if (isEditableTarget(e.target)) return;

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
    nextBtn?.click();
    return;
  }
  if (e.code === 'KeyP') {
    e.preventDefault();
    prevBtn?.click();
    return;
  }
  if (e.code === 'KeyF') {
    e.preventDefault();
    await toggleFullscreen();
    return;
  }
});

window.addEventListener('beforeunload', () => {
  if (runtimeStateDirtyTimer) {
    clearTimeout(runtimeStateDirtyTimer);
    runtimeStateDirtyTimer = null;
  }

  if (currentObjectUrl) {
    try { URL.revokeObjectURL(currentObjectUrl); } catch {}
  }

  try {
    persistRuntimeState(buildRuntimeState());
  } catch {}
});

async function restoreFromRuntimeState() {
  if (!appSettings.restoreLastState || !startupRuntimeState) return;

  if (startupRuntimeState.lastPlayMode && ['order', 'shuffle', 'random'].includes(startupRuntimeState.lastPlayMode)) {
    playMode = startupRuntimeState.lastPlayMode;
    setMode(playMode);
  }

  if (Number.isFinite(startupRuntimeState.lastSpeed)) {
    const speed = Math.min(4, Math.max(0.25, startupRuntimeState.lastSpeed));
    if (speedSelect) speedSelect.value = String(speed);
    if (videoPlayer) videoPlayer.playbackRate = speed;
  }

  if (Number.isFinite(startupRuntimeState.lastVolume)) {
    const vol = Math.min(1, Math.max(0, startupRuntimeState.lastVolume));
    localStorage.setItem(PLAYER_VOLUME_KEY, String(vol));
    if (videoPlayer) videoPlayer.volume = vol;
  }

  if (startupRuntimeState.lastPlaylist && currentPlaylist !== startupRuntimeState.lastPlaylist) {
    const pl = await idbGet(STORE_PLAYLISTS, startupRuntimeState.lastPlaylist);
    if (pl && Array.isArray(pl.items)) {
      currentPlaylist = startupRuntimeState.lastPlaylist;
    }
  }

  await refreshPlaylistsUI();
  await refreshTrackList();
  await updateTotalDuration();

  const pl = await getCurrentPlaylist();
  currentPlaylistSnapshot = pl && Array.isArray(pl.items) ? pl.items.slice() : [];
  if (!pl || pl.items.length === 0) return;

  let targetId = null;
  if (startupRuntimeState.lastTrackId && pl.items.includes(startupRuntimeState.lastTrackId)) {
    targetId = startupRuntimeState.lastTrackId;
    currentIndex = pl.items.indexOf(targetId);
  } else if (Number.isFinite(startupRuntimeState.lastCurrentIndex)) {
    currentIndex = Math.min(pl.items.length - 1, Math.max(0, Math.floor(startupRuntimeState.lastCurrentIndex)));
    targetId = pl.items[currentIndex];
  } else {
    currentIndex = 0;
    targetId = pl.items[0];
  }

  if (targetId) {
    await loadAndPlayById(targetId, {
      autoplay: !!startupRuntimeState.isPlaying,
      seekTime: Number.isFinite(startupRuntimeState.lastTime) ? startupRuntimeState.lastTime : 0
    });
    if (!startupRuntimeState.isPlaying) {
      videoPlayer.pause();
    }
    await refreshTrackList();
    updateSeekUI();
  }
}

async function init() {
  await openDB();

  const vids = await idbGetAll(STORE_VIDEOS);
  vids.forEach((v) => { if (v && v.id) videoListCache[v.id] = v; });

  const pls = await loadAllPlaylists();
  if (pls.length === 0) {
    await idbPut(STORE_PLAYLISTS, { name: 'Default', items: [] });
    currentPlaylist = 'Default';
  } else {
    currentPlaylist = normalizePlaylistName(pls[0]?.name) || pls[0].name;
  }

  await loadAppSettings();
  startupRuntimeState = loadRuntimeStateFromStorage();

  setupMediaSession();
  createVolumeControls();
  requestPersistentStorageIfPossible();
  updateStorageUsageUI();

  if (startupRuntimeState && appSettings.restoreLastState && Number.isFinite(startupRuntimeState.lastVolume)) {
    const vol = Math.min(1, Math.max(0, startupRuntimeState.lastVolume));
    localStorage.setItem(PLAYER_VOLUME_KEY, String(vol));
    videoPlayer.volume = vol;
  }

  if (startupRuntimeState && appSettings.restoreLastState && Number.isFinite(startupRuntimeState.lastSpeed)) {
    const speed = Math.min(4, Math.max(0.25, startupRuntimeState.lastSpeed));
    speedSelect.value = String(speed);
    videoPlayer.playbackRate = speed;
  }

  if (startupRuntimeState && appSettings.restoreLastState && startupRuntimeState.lastPlaylist) {
    const match = pls.find((p) => p?.name === startupRuntimeState.lastPlaylist);
    if (match) currentPlaylist = normalizePlaylistName(match.name) || match.name;
  }

  if (startupRuntimeState && appSettings.restoreLastState && ['order', 'shuffle', 'random'].includes(startupRuntimeState.lastPlayMode)) {
    setMode(startupRuntimeState.lastPlayMode);
  } else {
    setMode('order');
  }

  await refreshPlaylistsUI();
  await refreshTrackList();
  await updateTotalDuration();
  setPlayerUIState();
  updateSeekUI();

  if (appSettings.restoreLastState && startupRuntimeState?.lastPlaylist) {
    await restoreFromRuntimeState();
  }
}

init().catch((err) => {
  console.error(err);
  alert('初期化に失敗しました');
});
