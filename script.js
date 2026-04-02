const DB_NAME = 'offline-playlist-db';
const DB_VERSION = 2;
const STORE_VIDEOS = 'videos';
const STORE_PLAYLISTS = 'playlists';
const STORE_SHARED = 'sharedPlaylists';

let db;
let currentPlaylist = null;
let currentIndex = 0;
let playMode = 'order';
let shuffleOrder = [];
let videoListCache = {};
let currentObjectURL = null;

const fileInput = document.getElementById('fileInput');
const dropZone = document.getElementById('dropZone');
const playlistsEl = document.getElementById('playlists');
const newPlaylistName = document.getElementById('newPlaylistName');
const createPlaylistBtn = document.getElementById('createPlaylistBtn');
const trackListEl = document.getElementById('trackList');
const videoPlayer = document.getElementById('videoPlayer');
const playPauseBtn = document.getElementById('playPauseBtn');
const prevBtn = document.getElementById('prevBtn');
const nextBtn = document.getElementById('nextBtn');
const orderBtn = document.getElementById('orderBtn');
const shuffleBtn = document.getElementById('shuffleBtn');
const randomBtn = document.getElementById('randomBtn');
const speedSelect = document.getElementById('speedSelect');
const totalDurationEl = document.getElementById('totalDuration');
const exportMetaBtn = document.getElementById('exportMetaBtn');
const exportWithBlobsBtn = document.getElementById('exportWithBlobsBtn');
const importFile = document.getElementById('importFile');

const shareBtn = document.getElementById('shareBtn');
const shareURL = document.getElementById('shareURL');
const qrCodeEl = document.getElementById('qrCode');

const menuToggle = document.getElementById('menuToggle');
const sidebar = document.querySelector('.sidebar');
const overlay = document.getElementById('overlay');

async function loadAllPlaylists() {
  return await idbGetAll(STORE_PLAYLISTS);
}

function openDB() {
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = e => {
      const idb = e.target.result;

      if (!idb.objectStoreNames.contains(STORE_VIDEOS)) {
        idb.createObjectStore(STORE_VIDEOS, { keyPath: 'id' });
      }
      if (!idb.objectStoreNames.contains(STORE_PLAYLISTS)) {
        idb.createObjectStore(STORE_PLAYLISTS, { keyPath: 'name' });
      }
      if (!idb.objectStoreNames.contains(STORE_SHARED)) {
        idb.createObjectStore(STORE_SHARED, { keyPath: 'uuid' });
      }
    };

    req.onsuccess = e => {
      db = e.target.result;
      res(db);
    };

    req.onerror = e => rej(e);
  });
}

async function ensureDB() {
  if (db) return db;
  return await openDB();
}

function idbPut(store, value) {
  return new Promise((res, rej) => {
    if (!db) return rej(new Error('DB not initialized'));
    const tx = db.transaction(store, 'readwrite');
    const s = tx.objectStore(store);
    const r = s.put(value);
    r.onsuccess = () => res(r.result);
    r.onerror = e => rej(e);
  });
}

function idbGet(store, key) {
  return new Promise((res, rej) => {
    if (!db) return rej(new Error('DB not initialized'));
    const tx = db.transaction(store, 'readonly');
    const s = tx.objectStore(store);
    const r = s.get(key);
    r.onsuccess = () => res(r.result);
    r.onerror = e => rej(e);
  });
}

function idbGetAll(store) {
  return new Promise((res, rej) => {
    if (!db) return rej(new Error('DB not initialized'));
    const tx = db.transaction(store, 'readonly');
    const s = tx.objectStore(store);
    const r = s.getAll();
    r.onsuccess = () => res(r.result);
    r.onerror = e => rej(e);
  });
}

function idbDelete(store, key) {
  return new Promise((res, rej) => {
    if (!db) return rej(new Error('DB not initialized'));
    const tx = db.transaction(store, 'readwrite');
    const s = tx.objectStore(store);
    const r = s.delete(key);
    r.onsuccess = () => res();
    r.onerror = e => rej(e);
  });
}

async function idbRenamePlaylist(oldName, newName) {
  if (oldName === newName) return;
  const exists = await idbGet(STORE_PLAYLISTS, newName);
  if (exists) throw new Error('exists');
  const pl = await idbGet(STORE_PLAYLISTS, oldName);
  if (!pl) throw new Error('notfound');
  const newPl = { name: newName, items: pl.items.slice() };
  await idbPut(STORE_PLAYLISTS, newPl);
  await idbDelete(STORE_PLAYLISTS, oldName);
}

function uid() {
  return 'id-' + Math.random().toString(36).slice(2, 10);
}

function generateUUID() {
  return ([1e7] + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, c =>
    (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)
  );
}

function formatTime(sec) {
  if (!isFinite(sec)) return '00:00:00';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return [h, m, s].map(v => String(v).padStart(2, '0')).join(':');
}

function shuffleArray(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function getBaseUrl() {
  const url = new URL(location.href);
  url.hash = '';
  url.search = '';
  url.pathname = url.pathname.replace(/\/[^/]*$/, '/');
  return url.toString();
}

function downloadBlob(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function blobToBase64(blob) {
  return new Promise((res) => {
    const reader = new FileReader();
    reader.onload = () => res(reader.result.split(',')[1]);
    reader.readAsDataURL(blob);
  });
}

function base64ToBlob(base64, type) {
  const bin = atob(base64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type });
}

function base64ToText(base64) {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function textToBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

async function getVideoDuration(file) {
  return new Promise((res) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.src = url;
    v.onloadedmetadata = () => {
      const d = v.duration || 0;
      URL.revokeObjectURL(url);
      res(d);
    };
    v.onerror = () => {
      URL.revokeObjectURL(url);
      res(0);
    };
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

    v.addEventListener('loadeddata', () => {
      v.currentTime = 0.1;
    });

    v.addEventListener('seeked', () => {
      const canvas = document.createElement('canvas');
      canvas.width = 320;
      canvas.height = 180;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
      const data = canvas.toDataURL('image/jpeg', 0.7);
      URL.revokeObjectURL(url);
      res(data);
    });

    setTimeout(() => {
      try { URL.revokeObjectURL(url); } catch (e) {}
      res(null);
    }, 3000);
  });
}

async function ensureDefaultPlaylist() {
  const pls = await loadAllPlaylists();
  if (pls.length === 0) {
    await idbPut(STORE_PLAYLISTS, { name: 'Default', items: [] });
    currentPlaylist = 'Default';
  } else if (!currentPlaylist) {
    currentPlaylist = pls[0].name;
  }
}

async function addFiles(files) {
  await ensureDB();

  for (const f of files) {
    if (f.type !== 'video/mp4') continue;

    const id = uid();
    const duration = await getVideoDuration(f);
    const thumb = await generateThumbnail(f);
    const blob = f.slice(0, f.size, f.type);

    const meta = {
      id,
      name: f.name,
      duration,
      blob,
      thumbnail: thumb,
      size: f.size
    };

    await idbPut(STORE_VIDEOS, meta);
    videoListCache[id] = meta;

    if (!currentPlaylist) {
      await ensureDefaultPlaylist();
    }

    const pl = await idbGet(STORE_PLAYLISTS, currentPlaylist);
    if (pl) {
      pl.items.push(id);
      await idbPut(STORE_PLAYLISTS, pl);
    }
  }

  await refreshPlaylistsUI();
  await refreshTrackList();
  await updateTotalDuration();
}

async function refreshPlaylistsUI() {
  playlistsEl.innerHTML = '';
  const pls = await loadAllPlaylists();

  for (const p of pls) {
    const li = document.createElement('li');
    li.className = 'playlist-item';
    li.dataset.name = p.name;

    const nameSpan = document.createElement('span');
    nameSpan.textContent = p.name;
    nameSpan.className = 'playlist-name';
    nameSpan.title = 'ダブルクリックで名前変更';

    nameSpan.addEventListener('click', async () => {
      currentPlaylist = p.name;
      currentIndex = 0;
      await refreshPlaylistsUI();
      await refreshTrackList();
      await updateTotalDuration();
    });

    nameSpan.addEventListener('dblclick', async (e) => {
      e.stopPropagation();
      const newName = prompt('プレイリスト名を入力してください', p.name);
      if (!newName) return;
      const trimmed = newName.trim();
      if (!trimmed) return alert('無効な名前です');

      try {
        await idbRenamePlaylist(p.name, trimmed);
        if (currentPlaylist === p.name) currentPlaylist = trimmed;
        await refreshPlaylistsUI();
        await refreshTrackList();
      } catch (err) {
        if (err.message === 'exists') alert('同名のプレイリストが既に存在します');
        else alert('名前変更に失敗しました');
      }
    });

    const delBtn = document.createElement('button');
    delBtn.className = 'small-btn';
    delBtn.textContent = '削除';

    delBtn.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      if (!confirm(`プレイリスト「${p.name}」を削除しますか？`)) return;
      await idbDelete(STORE_PLAYLISTS, p.name);
      if (currentPlaylist === p.name) currentPlaylist = null;
      await ensureDefaultPlaylist();
      await refreshPlaylistsUI();
      await refreshTrackList();
      await updateTotalDuration();
    });

    li.appendChild(nameSpan);
    li.appendChild(delBtn);

    if (p.name === currentPlaylist) li.classList.add('active');
    playlistsEl.appendChild(li);
  }
}

createPlaylistBtn.addEventListener('click', async () => {
  await ensureDB();
  const name = newPlaylistName.value.trim();
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
});

async function refreshTrackList() {
  trackListEl.innerHTML = '';
  if (!currentPlaylist) return;

  const pl = await idbGet(STORE_PLAYLISTS, currentPlaylist);
  if (!pl) return;

  for (const id of pl.items) {
    if (!videoListCache[id]) {
      const v = await idbGet(STORE_VIDEOS, id);
      if (v) videoListCache[id] = v;
    }
  }

  for (let i = 0; i < pl.items.length; i++) {
    const id = pl.items[i];
    const meta = videoListCache[id];
    if (!meta) continue;

    const li = document.createElement('li');
    li.className = 'track-item';
    if (i === currentIndex) li.classList.add('playing');
    li.dataset.index = i;
    li.dataset.id = id;
    li.draggable = true;

    li.innerHTML = `
      <img class="thumb" src="${meta.thumbnail || ''}" alt="thumb" />
      <div class="meta">
        <div class="title">${meta.name}</div>
        <div class="sub">${formatTime(meta.duration)} • ${Math.round(meta.size / 1024 / 1024)} MB</div>
      </div>
      <div class="track-actions">
        <button class="small-btn play-now">再生</button>
        <button class="small-btn remove">削除</button>
      </div>
    `;

    li.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', i.toString());
      li.classList.add('dragging');
    });

    li.addEventListener('dragend', () => {
      li.classList.remove('dragging');
    });

    li.addEventListener('dragover', (e) => {
      e.preventDefault();
      li.classList.add('drag-over');
    });

    li.addEventListener('dragleave', () => {
      li.classList.remove('drag-over');
    });

    li.addEventListener('drop', async (e) => {
      e.preventDefault();
      li.classList.remove('drag-over');

      const fromIndex = parseInt(e.dataTransfer.getData('text/plain'), 10);
      const toIndex = i;
      if (isNaN(fromIndex)) return;
      if (fromIndex === toIndex) return;

      const pl2 = await idbGet(STORE_PLAYLISTS, currentPlaylist);
      if (!pl2) return;

      const item = pl2.items.splice(fromIndex, 1)[0];
      pl2.items.splice(toIndex, 0, item);
      await idbPut(STORE_PLAYLISTS, pl2);

      if (currentIndex === fromIndex) currentIndex = toIndex;
      else if (fromIndex < currentIndex && toIndex >= currentIndex) currentIndex--;
      else if (fromIndex > currentIndex && toIndex <= currentIndex) currentIndex++;

      await refreshTrackList();
    });

    li.querySelector('.play-now').addEventListener('click', async () => {
      currentIndex = i;
      await playCurrent();
      await refreshTrackList();
    });

    li.querySelector('.remove').addEventListener('click', async () => {
      const pl2 = await idbGet(STORE_PLAYLISTS, currentPlaylist);
      if (!pl2) return;
      pl2.items.splice(i, 1);
      await idbPut(STORE_PLAYLISTS, pl2);
      if (currentIndex >= pl2.items.length) currentIndex = Math.max(0, pl2.items.length - 1);
      await refreshTrackList();
      await updateTotalDuration();
    });

    trackListEl.appendChild(li);
  }
}

async function getPlaylistLength() {
  const pl = await idbGet(STORE_PLAYLISTS, currentPlaylist);
  return pl ? pl.items.length : 0;
}

async function loadAndPlayById(id) {
  const meta = await idbGet(STORE_VIDEOS, id);
  if (!meta) return;
  if (!meta.blob) {
    alert('この動画はプレースホルダです。元ファイルを再追加してください。');
    return;
  }

  if (currentObjectURL) {
    try { URL.revokeObjectURL(currentObjectURL); } catch (e) {}
    currentObjectURL = null;
  }

  currentObjectURL = URL.createObjectURL(meta.blob);
  videoPlayer.src = currentObjectURL;
  videoPlayer.playbackRate = parseFloat(speedSelect.value);

  const vol = parseFloat(localStorage.getItem('playerVolume') || '1');
  videoPlayer.volume = isFinite(vol) ? vol : 1;

  try {
    await videoPlayer.play();
  } catch (e) {}

  if (window.electronAPI) {
    const cleanTitle = meta.name.replace(/\.[^/.]+$/, '');
    window.electronAPI.setRPC({
      title: cleanTitle,
      playlist: currentPlaylist,
      startTimestamp: Date.now(),
      endTimestamp: Date.now() + (meta.duration * 1000),
      paused: false
    });
  }

  videoPlayer.onended = async () => {
    const len = await getPlaylistLength();
    if (len > 0) {
      currentIndex = (currentIndex + 1) % len;
      await playCurrent();
    }
  };
}

async function playCurrent() {
  if (!currentPlaylist) return;
  const pl = await idbGet(STORE_PLAYLISTS, currentPlaylist);
  if (!pl || pl.items.length === 0) return;

  let id;
  if (playMode === 'shuffle') {
    if (shuffleOrder.length !== pl.items.length) shuffleOrder = shuffleArray(pl.items.slice());
    id = shuffleOrder[currentIndex % shuffleOrder.length];
  } else if (playMode === 'random') {
    id = pl.items[Math.floor(Math.random() * pl.items.length)];
  } else {
    id = pl.items[currentIndex % pl.items.length];
  }

  await loadAndPlayById(id);
  await refreshTrackList();
}

function setMode(m) {
  playMode = m;
  orderBtn.classList.toggle('active', m === 'order');
  shuffleBtn.classList.toggle('active', m === 'shuffle');
  randomBtn.classList.toggle('active', m === 'random');
  if (m === 'shuffle') shuffleOrder = [];
}

function createVolumeControls() {
  const playerControls = document.querySelector('.player-controls');
  if (!playerControls) return;
  if (document.querySelector('.volume-controls')) return;

  const volWrap = document.createElement('div');
  volWrap.className = 'volume-controls';
  volWrap.style.display = 'flex';
  volWrap.style.alignItems = 'center';
  volWrap.style.gap = '8px';
  volWrap.style.marginLeft = '8px';

  const muteBtn = document.createElement('button');
  muteBtn.className = 'small-btn';
  muteBtn.textContent = '🔊';
  muteBtn.title = 'ミュート/ミュート解除';

  const volSlider = document.createElement('input');
  volSlider.type = 'range';
  volSlider.min = 0;
  volSlider.max = 1;
  volSlider.step = 0.01;
  volSlider.style.width = '120px';

  const volLabel = document.createElement('div');
  volLabel.style.color = 'var(--muted)';
  volLabel.style.fontSize = '13px';

  const saved = parseFloat(localStorage.getItem('playerVolume'));
  const initVol = isFinite(saved) ? saved : 1;
  volSlider.value = String(initVol);
  volLabel.textContent = Math.round(initVol * 100) + '%';
  videoPlayer.volume = initVol;
  muteBtn.textContent = initVol > 0 ? '🔊' : '🔇';

  volSlider.addEventListener('input', () => {
    const v = parseFloat(volSlider.value);
    videoPlayer.volume = v;
    localStorage.setItem('playerVolume', String(v));
    volLabel.textContent = Math.round(v * 100) + '%';
    muteBtn.textContent = v > 0 ? '🔊' : '🔇';
  });

  muteBtn.addEventListener('click', () => {
    if (videoPlayer.volume > 0) {
      volSlider.dataset.prev = volSlider.value;
      volSlider.value = 0;
      videoPlayer.volume = 0;
      localStorage.setItem('playerVolume', '0');
      volLabel.textContent = '0%';
      muteBtn.textContent = '🔇';
    } else {
      const prev = parseFloat(volSlider.dataset.prev || '1');
      volSlider.value = String(prev);
      videoPlayer.volume = prev;
      localStorage.setItem('playerVolume', String(prev));
      volLabel.textContent = Math.round(prev * 100) + '%';
      muteBtn.textContent = '🔊';
    }
  });

  volWrap.appendChild(muteBtn);
  volWrap.appendChild(volSlider);
  volWrap.appendChild(volLabel);
  playerControls.appendChild(volWrap);
}

function generateQRCode(url, targetEl) {
  if (!targetEl || typeof QRCode === 'undefined') return;
  targetEl.innerHTML = '';
  new QRCode(targetEl, {
    text: url,
    width: 180,
    height: 180,
    colorDark: '#1db954',
    colorLight: '#121212',
    correctLevel: QRCode.CorrectLevel.H
  });
}

async function updateTotalDuration() {
  if (!currentPlaylist) {
    totalDurationEl.textContent = '00:00:00';
    return;
  }

  const pl = await idbGet(STORE_PLAYLISTS, currentPlaylist);
  if (!pl) {
    totalDurationEl.textContent = '00:00:00';
    return;
  }

  let total = 0;
  for (const id of pl.items) {
    const meta = await idbGet(STORE_VIDEOS, id);
    if (meta && meta.duration) total += meta.duration;
  }

  totalDurationEl.textContent = formatTime(total);
}

function ensureUniquePlaylistName(baseName) {
  return new Promise(async (resolve) => {
    const pls = await loadAllPlaylists();
    const names = new Set(pls.map(p => p.name));

    if (!names.has(baseName)) {
      resolve(baseName);
      return;
    }

    let i = 2;
    while (names.has(`${baseName} (${i})`)) i++;
    resolve(`${baseName} (${i})`);
  });
}

async function buildSharePayload(playlistName) {
  const pl = await idbGet(STORE_PLAYLISTS, playlistName);
  if (!pl) return null;

  const items = [];
  for (const id of pl.items) {
    const meta = await idbGet(STORE_VIDEOS, id);
    if (!meta) continue;

    const item = {
      id: meta.id,
      name: meta.name,
      duration: meta.duration || 0,
      size: meta.size || 0,
      thumbnail: meta.thumbnail || null,
      blobBase64: meta.blob ? await blobToBase64(meta.blob) : null
    };

    items.push(item);
  }

  return {
    name: pl.name,
    items
  };
}

async function savePlaylistForSharing(playlistName) {
  await ensureDB();

  const payload = await buildSharePayload(playlistName);
  if (!payload) return null;

  const uuid = generateUUID();
  await idbPut(STORE_SHARED, {
    uuid,
    data: textToBase64(JSON.stringify(payload)),
    createdAt: Date.now()
  });

  return uuid;
}

async function generateShareLink(playlistName) {
  const uuid = await savePlaylistForSharing(playlistName);
  if (!uuid) return null;

  const base = getBaseUrl();
  return `${base}playlist/${uuid}`;
}

async function importSharedPayload(payload) {
  if (!payload || !Array.isArray(payload.items)) return false;

  const playlistName = await ensureUniquePlaylistName(payload.name || 'Shared');
  const items = [];

  for (const it of payload.items) {
    const id = it.id || uid();

    let blob = null;
    if (it.blobBase64) {
      blob = base64ToBlob(it.blobBase64, 'video/mp4');
    }

    const meta = {
      id,
      name: it.name || 'video',
      duration: it.duration || 0,
      blob,
      thumbnail: it.thumbnail || null,
      size: it.size || 0
    };

    await idbPut(STORE_VIDEOS, meta);
    videoListCache[id] = meta;
    items.push(id);
  }

  await idbPut(STORE_PLAYLISTS, { name: playlistName, items });
  currentPlaylist = playlistName;
  currentIndex = 0;

  return true;
}

function getSharedUUIDFromLocation() {
  const segments = location.pathname.split('/').filter(Boolean);
  const idx = segments.indexOf('playlist');
  if (idx !== -1 && segments[idx + 1]) return segments[idx + 1];

  const hashMatch = location.hash.match(/^#share=([^&]+)/);
  if (hashMatch) return hashMatch[1];

  return null;
}

async function loadPlaylistFromUUID(uuid) {
  await ensureDB();

  const rec = await idbGet(STORE_SHARED, uuid);
  if (!rec) return false;

  const payload = JSON.parse(base64ToText(rec.data));
  const ok = await importSharedPayload(payload);
  if (!ok) return false;

  await refreshPlaylistsUI();
  await refreshTrackList();
  await updateTotalDuration();

  return true;
}

if (shareBtn) {
  shareBtn.addEventListener('click', async () => {
    try {
      if (!currentPlaylist) return alert('プレイリストを選択してください');

      const url = await generateShareLink(currentPlaylist);
      if (!url) return alert('共有に失敗しました');

      if (shareURL) shareURL.textContent = url;
      if (qrCodeEl) generateQRCode(url, qrCodeEl);

      try {
        await navigator.clipboard.writeText(url);
      } catch (e) {}
    } catch (err) {
      alert('共有に失敗しました');
      console.error(err);
    }
  });
}

playPauseBtn.addEventListener('click', () => {
  if (videoPlayer.paused) {
    videoPlayer.play();
  } else {
    videoPlayer.pause();
    if (window.electronAPI) {
      window.electronAPI.setRPC({ paused: true });
    }
  }
});

prevBtn.addEventListener('click', async () => {
  const len = await getPlaylistLength();
  if (len <= 0) return;

  if (playMode === 'random') {
    await playCurrent();
    return;
  }

  currentIndex = (currentIndex - 1 + len) % len;
  await playCurrent();
});

nextBtn.addEventListener('click', async () => {
  const len = await getPlaylistLength();
  if (len <= 0) return;

  if (playMode === 'random') {
    await playCurrent();
    return;
  }

  currentIndex = (currentIndex + 1) % len;
  await playCurrent();
});

orderBtn.addEventListener('click', () => setMode('order'));
shuffleBtn.addEventListener('click', () => setMode('shuffle'));
randomBtn.addEventListener('click', () => setMode('random'));

speedSelect.addEventListener('change', () => {
  videoPlayer.playbackRate = parseFloat(speedSelect.value);
});

dropZone.addEventListener('dragover', e => {
  e.preventDefault();
  dropZone.classList.add('drag');
});

dropZone.addEventListener('dragleave', () => {
  dropZone.classList.remove('drag');
});

dropZone.addEventListener('drop', async e => {
  e.preventDefault();
  dropZone.classList.remove('drag');
  const files = Array.from(e.dataTransfer.files);
  await addFiles(files);
});

fileInput.addEventListener('change', async e => {
  const files = Array.from(e.target.files);
  await addFiles(files);
  fileInput.value = '';
});

exportMetaBtn.addEventListener('click', async () => {
  if (!currentPlaylist) return alert('プレイリストを選択してください');
  const pl = await idbGet(STORE_PLAYLISTS, currentPlaylist);
  if (!pl) return;

  const exportObj = { name: pl.name, items: [] };
  for (const id of pl.items) {
    const meta = await idbGet(STORE_VIDEOS, id);
    if (meta) {
      exportObj.items.push({
        id: meta.id,
        name: meta.name,
        duration: meta.duration,
        size: meta.size,
        thumbnail: meta.thumbnail
      });
    }
  }

  const blob = new Blob([JSON.stringify(exportObj)], { type: 'application/json' });
  downloadBlob(blob, `${pl.name}.playlist.json`);
});

exportWithBlobsBtn.addEventListener('click', async () => {
  if (!currentPlaylist) return alert('プレイリストを選択してください');
  const pl = await idbGet(STORE_PLAYLISTS, currentPlaylist);
  if (!pl) return;

  const exportObj = { name: pl.name, items: [] };
  for (const id of pl.items) {
    const meta = await idbGet(STORE_VIDEOS, id);
    if (meta) {
      exportObj.items.push({
        id: meta.id,
        name: meta.name,
        duration: meta.duration,
        size: meta.size,
        thumbnail: meta.thumbnail,
        blobBase64: meta.blob ? await blobToBase64(meta.blob) : null
      });
    }
  }

  const blob = new Blob([JSON.stringify(exportObj)], { type: 'application/json' });
  downloadBlob(blob, `${pl.name}.playlist.full.json`);
});

importFile.addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (!f) return;

  const txt = await f.text();

  try {
    const obj = JSON.parse(txt);
    if (!obj.name || !Array.isArray(obj.items)) throw new Error('invalid');

    const name = await ensureUniquePlaylistName(obj.name + ' (import)');
    const items = [];

    for (const it of obj.items) {
      const id = it.id || uid();

      let blob = null;
      if (it.blobBase64) {
        blob = base64ToBlob(it.blobBase64, 'video/mp4');
      }

      const meta = {
        id,
        name: it.name || 'video',
        duration: it.duration || 0,
        blob,
        thumbnail: it.thumbnail || null,
        size: it.size || 0
      };

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
  } catch (err) {
    alert('インポートに失敗しました');
  }

  importFile.value = '';
});

videoPlayer.addEventListener('play', async () => {
  if (!currentPlaylist) return;
  const pl = await idbGet(STORE_PLAYLISTS, currentPlaylist);
  if (!pl) return;
  const id = pl.items[currentIndex];
  const meta = await idbGet(STORE_VIDEOS, id);
  if (meta && !meta.blob) {
    alert('この動画はプレースホルダです。元ファイルを再追加してください。');
    videoPlayer.pause();
  }
});

if (menuToggle) {
  menuToggle.addEventListener('click', () => {
    sidebar.classList.toggle('open');
    overlay.classList.toggle('active');
  });
}

if (overlay) {
  overlay.addEventListener('click', () => {
    sidebar.classList.remove('open');
    overlay.classList.remove('active');
  });
}

(async function init() {
  await ensureDB();

  const vids = await idbGetAll(STORE_VIDEOS);
  vids.forEach(v => videoListCache[v.id] = v);

  await ensureDefaultPlaylist();

  createVolumeControls();
  await refreshPlaylistsUI();
  await refreshTrackList();
  await updateTotalDuration();

  const uuid = getSharedUUIDFromLocation();
  if (uuid) {
    const loaded = await loadPlaylistFromUUID(uuid);
    if (loaded) {
      await refreshPlaylistsUI();
      await refreshTrackList();
      await updateTotalDuration();
    }
  }
})();
