const DB_NAME = 'playpocket-web-db';
const STORE_PLAYLISTS = 'playlists';
const STORE_VIDEOS = 'videos';
const MAX_FILES = 100;
const MAX_ITEMS = 500;
const MAX_PACKAGE_BYTES = 500 * 1024 * 1024;
const MAX_NAME = 80;

let db;
let currentPlaylistId = null;
let currentIndex = 0;
let currentUrl = null;
let playMode = 'order';

const $ = id => document.getElementById(id);
const el = {
  playlists: $('playlists'), newName: $('newPlaylistName'), create: $('createPlaylistBtn'), title: $('playlistTitle'), file: $('fileInput'), importFile: $('importFile'), drop: $('dropZone'), videoStage: $('videoStage'), empty: $('emptyState'), video: $('videoPlayer'), centerPlay: $('centerPlayBtn'), seek: $('seekBar'), now: $('currentTime'), duration: $('durationTime'), prev: $('prevBtn'), play: $('playPauseBtn'), next: $('nextBtn'), speed: $('speedSelect'), fullscreen: $('fullscreenBtn'), volume: $('volumeBar'), total: $('totalDuration'), order: $('orderBtn'), shuffle: $('shuffleBtn'), random: $('randomBtn'), tracks: $('trackList'), trackCount: $('trackCount'), exportMeta: $('exportMetaBtn'), exportFull: $('exportFullBtn'), share: $('sharePlaylistBtn'), modal: $('shareModal'), closeShare: $('closeShareBtn'), shareSummary: $('shareSummary'), createPackage: $('createSharePackageBtn'), copyCode: $('copyShareCodeBtn'), shareInput: $('shareCodeInput'), importCode: $('importShareCodeBtn'), shareStatus: $('shareStatus'), toast: $('toast')
};

function safeText(value, fallback = '') {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001F\u007F]/g, '').trim() : fallback;
}

function playlistName(value) {
  return safeText(value).slice(0, MAX_NAME);
}

function id() {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function number(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

function formatTime(seconds) {
  const value = Math.max(0, Math.floor(number(seconds)));
  return [Math.floor(value / 3600), Math.floor(value % 3600 / 60), value % 60].map(part => String(part).padStart(2, '0')).join(':');
}

function fileSize(bytes) {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(bytes >= 100 * 1024 * 1024 ? 0 : 1)} MB`;
}

function safeFilename(value) {
  return (safeText(value, 'playlist').replace(/[<>:"/\\|?*]/g, '-').replace(/\.+$/, '') || 'playlist').slice(0, 80);
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      database.createObjectStore(STORE_PLAYLISTS, { keyPath: 'id' });
      database.createObjectStore(STORE_VIDEOS, { keyPath: 'id' });
    };
    request.onsuccess = () => { db = request.result; resolve(); };
    request.onerror = () => reject(request.error);
  });
}

function store(name, mode = 'readonly') {
  return db.transaction(name, mode).objectStore(name);
}

function get(name, key) {
  return new Promise((resolve, reject) => {
    const request = store(name).get(key);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

function getAll(name) {
  return new Promise((resolve, reject) => {
    const request = store(name).getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

function put(name, value) {
  return new Promise((resolve, reject) => {
    const request = store(name, 'readwrite').put(value);
    request.onsuccess = () => resolve(value);
    request.onerror = () => reject(request.error);
  });
}

function remove(name, key) {
  return new Promise((resolve, reject) => {
    const request = store(name, 'readwrite').delete(key);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

function toast(message) {
  el.toast.textContent = message;
  el.toast.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.toast.classList.remove('show'), 3600);
}

function setShareStatus(message = '', type = '') {
  el.shareStatus.textContent = message;
  el.shareStatus.className = `status-message${type ? ` ${type}` : ''}`;
}

async function currentPlaylist() {
  return currentPlaylistId ? get(STORE_PLAYLISTS, currentPlaylistId) : null;
}

async function playlistVideos(playlist) {
  if (!playlist?.items?.length) return [];
  const records = await Promise.all(playlist.items.map(videoId => get(STORE_VIDEOS, videoId)));
  return records.filter(Boolean);
}

async function ensureDefaultPlaylist() {
  const playlists = await getAll(STORE_PLAYLISTS);
  if (playlists.length) return playlists;
  const defaultPlaylist = { id: id(), name: 'My Playlist', items: [], createdAt: Date.now() };
  await put(STORE_PLAYLISTS, defaultPlaylist);
  return [defaultPlaylist];
}

async function renderPlaylists() {
  const playlists = (await getAll(STORE_PLAYLISTS)).sort((a, b) => a.createdAt - b.createdAt);
  el.playlists.replaceChildren();
  for (const playlist of playlists) {
    const row = document.createElement('li');
    row.className = `playlist-row${playlist.id === currentPlaylistId ? ' active' : ''}`;
    const select = document.createElement('button');
    select.className = 'playlist-select';
    select.type = 'button';
    select.textContent = playlist.name;
    select.title = 'クリックで選択、ダブルクリックで名前を変更';
    select.addEventListener('click', async () => selectPlaylist(playlist.id));
    select.addEventListener('dblclick', async () => {
      const name = playlistName(prompt('プレイリスト名', playlist.name));
      if (!name || name === playlist.name) return;
      playlist.name = name;
      await put(STORE_PLAYLISTS, playlist);
      await renderPlaylists();
      await renderCurrentPlaylist();
    });
    const deleteButton = document.createElement('button');
    deleteButton.className = 'playlist-delete';
    deleteButton.type = 'button';
    deleteButton.textContent = '×';
    deleteButton.setAttribute('aria-label', `${playlist.name}を削除`);
    deleteButton.addEventListener('click', async event => {
      event.stopPropagation();
      if (!confirm(`「${playlist.name}」を削除しますか？`)) return;
      await remove(STORE_PLAYLISTS, playlist.id);
      const remaining = await ensureDefaultPlaylist();
      if (currentPlaylistId === playlist.id) currentPlaylistId = remaining[0].id;
      await garbageCollectVideos();
      await renderPlaylists();
      await renderCurrentPlaylist();
    });
    row.append(select, deleteButton);
    el.playlists.appendChild(row);
  }
}

async function selectPlaylist(playlistId) {
  currentPlaylistId = playlistId;
  currentIndex = 0;
  localStorage.setItem('playpocket-web.current-playlist', playlistId);
  unloadVideo();
  await renderPlaylists();
  await renderCurrentPlaylist();
}

function unloadVideo() {
  el.video.pause();
  if (currentUrl) URL.revokeObjectURL(currentUrl);
  currentUrl = null;
  el.video.removeAttribute('src');
  el.video.load();
  el.videoStage.classList.remove('has-video');
  el.videoStage.classList.add('paused');
  updateTime();
}

async function renderCurrentPlaylist() {
  const playlist = await currentPlaylist();
  if (!playlist) return;
  el.title.textContent = playlist.name;
  const videos = await playlistVideos(playlist);
  if (currentIndex >= videos.length) currentIndex = Math.max(0, videos.length - 1);
  el.trackCount.textContent = `${videos.length} 本`;
  el.total.textContent = formatTime(videos.reduce((sum, video) => sum + number(video.duration), 0));
  el.tracks.replaceChildren();
  videos.forEach((video, index) => el.tracks.appendChild(trackElement(video, index, index === currentIndex && Boolean(currentUrl))));
}

function trackElement(video, index, selected) {
  const item = document.createElement('li');
  item.className = `track${selected ? ' playing' : ''}`;
  const thumb = document.createElement('div');
  thumb.className = 'track-thumb';
  if (video.thumbnail) {
    const image = document.createElement('img');
    image.src = video.thumbnail;
    image.alt = '';
    thumb.appendChild(image);
  } else thumb.textContent = '▶';
  const info = document.createElement('div');
  info.className = 'track-info';
  const title = document.createElement('div');
  title.className = 'track-name';
  title.textContent = video.name.replace(/\.[^/.]+$/, '');
  const meta = document.createElement('div');
  meta.className = 'track-meta';
  meta.textContent = `${formatTime(video.duration)} · ${fileSize(video.size)}`;
  info.append(title, meta);
  const removeButton = document.createElement('button');
  removeButton.className = 'track-remove';
  removeButton.type = 'button';
  removeButton.textContent = '×';
  removeButton.setAttribute('aria-label', `${video.name}をリストから削除`);
  item.addEventListener('click', () => playAt(index));
  removeButton.addEventListener('click', async event => {
    event.stopPropagation();
    await removeTrack(index);
  });
  item.append(thumb, info, removeButton);
  return item;
}

function updateTime() {
  const duration = number(el.video.duration);
  const current = number(el.video.currentTime);
  el.now.textContent = formatTime(current);
  el.duration.textContent = formatTime(duration);
  el.seek.value = duration ? String(Math.round(current / duration * 1000)) : '0';
  el.play.textContent = el.video.paused ? '▶' : 'Ⅱ';
  el.videoStage.classList.toggle('paused', el.video.paused);
}

async function playAt(index, autoplay = true) {
  const playlist = await currentPlaylist();
  const videos = await playlistVideos(playlist);
  const video = videos[index];
  if (!video?.blob) return toast('この動画ファイルはこのブラウザにありません。');
  currentIndex = index;
  if (currentUrl) URL.revokeObjectURL(currentUrl);
  currentUrl = URL.createObjectURL(video.blob);
  el.video.src = currentUrl;
  el.video.playbackRate = Number(el.speed.value) || 1;
  el.videoStage.classList.add('has-video');
  if (autoplay) {
    try { await el.video.play(); } catch {}
  }
  updateTime();
  await renderCurrentPlaylist();
}

async function togglePlay() {
  if (!currentUrl) return playAt(currentIndex, true);
  if (el.video.paused) {
    try { await el.video.play(); } catch {}
  } else el.video.pause();
  updateTime();
}

async function next(step = 1) {
  const playlist = await currentPlaylist();
  const videos = await playlistVideos(playlist);
  if (!videos.length) return;
  const target = playMode === 'random' ? Math.floor(Math.random() * videos.length) : (currentIndex + step + videos.length) % videos.length;
  await playAt(target, true);
}

async function removeTrack(index) {
  const playlist = await currentPlaylist();
  if (!playlist) return;
  playlist.items.splice(index, 1);
  await put(STORE_PLAYLISTS, playlist);
  if (index === currentIndex) unloadVideo();
  if (index < currentIndex) currentIndex--;
  await garbageCollectVideos();
  await renderCurrentPlaylist();
}

async function garbageCollectVideos() {
  const playlists = await getAll(STORE_PLAYLISTS);
  const used = new Set(playlists.flatMap(playlist => playlist.items));
  for (const video of await getAll(STORE_VIDEOS)) if (!used.has(video.id)) await remove(STORE_VIDEOS, video.id);
}

function videoDuration(file) {
  return new Promise(resolve => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.onloadedmetadata = () => { URL.revokeObjectURL(url); resolve(number(video.duration)); };
    video.onerror = () => { URL.revokeObjectURL(url); resolve(0); };
    video.src = url;
  });
}

function thumbnail(file) {
  return new Promise(resolve => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    let done = false;
    const finish = value => { if (!done) { done = true; URL.revokeObjectURL(url); resolve(value); } };
    video.muted = true;
    video.preload = 'metadata';
    video.onloadeddata = () => { try { video.currentTime = Math.min(.1, number(video.duration) / 2); } catch { finish(null); } };
    video.onseeked = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = 320;
        canvas.height = 180;
        canvas.getContext('2d').drawImage(video, 0, 0, 320, 180);
        finish(canvas.toDataURL('image/jpeg', .7));
      } catch { finish(null); }
    };
    video.onerror = () => finish(null);
    video.src = url;
    setTimeout(() => finish(null), 3500);
  });
}

async function addFiles(files) {
  const accepted = Array.from(files).filter(file => file.type.startsWith('video/')).slice(0, MAX_FILES);
  if (!accepted.length) return toast('対応している動画ファイルを選択してください。');
  const playlist = await currentPlaylist();
  for (const file of accepted) {
    const record = { id: id(), name: safeText(file.name, 'video'), type: file.type || 'video/mp4', size: file.size, duration: await videoDuration(file), thumbnail: await thumbnail(file), blob: file.slice(0, file.size, file.type) };
    await put(STORE_VIDEOS, record);
    playlist.items.push(record.id);
  }
  await put(STORE_PLAYLISTS, playlist);
  await renderCurrentPlaylist();
  toast(`${accepted.length} 本の動画を追加しました。`);
}

function download(blob, filename) {
  const anchor = document.createElement('a');
  const url = URL.createObjectURL(blob);
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function blobBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function base64Blob(value, type) {
  const binary = atob(value);
  return new Blob([Uint8Array.from(binary, char => char.charCodeAt(0))], { type: type || 'video/mp4' });
}

async function exportPlaylist(includeVideos) {
  const playlist = await currentPlaylist();
  const videos = await playlistVideos(playlist);
  const items = [];
  for (const video of videos) {
    const item = { name: video.name, type: video.type, size: video.size, duration: video.duration, thumbnail: video.thumbnail };
    if (includeVideos && video.blob) item.blobBase64 = await blobBase64(video.blob);
    items.push(item);
  }
  return { format: 'playpocket-web', version: 1, mediaIncluded: includeVideos, name: playlist.name, items };
}

async function uniqueName(name, suffix) {
  const existing = new Set((await getAll(STORE_PLAYLISTS)).map(playlist => playlist.name));
  for (let n = 1; n < 1000; n++) {
    const tail = n === 1 ? suffix : `${suffix} ${n}`;
    const candidate = `${playlistName(name).slice(0, MAX_NAME - tail.length)}${tail}`;
    if (!existing.has(candidate)) return candidate;
  }
  throw new Error('playlist-name-unavailable');
}

async function importPlaylist(payload, suffix = ' (import)') {
  if (!payload || !Array.isArray(payload.items) || !playlistName(payload.name)) throw new Error('invalid-playlist');
  const playlist = { id: id(), name: await uniqueName(payload.name, suffix), items: [], createdAt: Date.now() };
  const records = [];
  for (const item of payload.items.slice(0, MAX_ITEMS)) {
    if (!item || typeof item !== 'object') continue;
    let blob = null;
    if (typeof item.blobBase64 === 'string' && item.blobBase64) blob = base64Blob(item.blobBase64, item.type);
    const record = { id: id(), name: safeText(item.name, 'video'), type: safeText(item.type, 'video/mp4'), size: number(item.size), duration: number(item.duration), thumbnail: typeof item.thumbnail === 'string' && item.thumbnail.startsWith('data:image/') ? item.thumbnail : null, blob };
    records.push(record);
    playlist.items.push(record.id);
  }
  for (const record of records) await put(STORE_VIDEOS, record);
  await put(STORE_PLAYLISTS, playlist);
  await selectPlaylist(playlist.id);
  return playlist;
}

async function openShare() {
  const playlist = await currentPlaylist();
  el.shareSummary.textContent = `「${playlist.name}」を共有します。${playlist.items.length} 本の動画が含まれています。`;
  setShareStatus();
  el.modal.classList.add('open');
  el.modal.setAttribute('aria-hidden', 'false');
}

function closeShare() {
  el.modal.classList.remove('open');
  el.modal.setAttribute('aria-hidden', 'true');
}

async function createSharePackage() {
  try {
    el.createPackage.disabled = true;
    setShareStatus('共有ファイルを作成しています。動画の容量によっては時間がかかります。');
    const payload = await exportPlaylist(true);
    const packageBlob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
    if (packageBlob.size > MAX_PACKAGE_BYTES) throw new Error('package-too-large');
    download(packageBlob, `${safeFilename(payload.name)}.playpocket.json`);
    setShareStatus('共有ファイルを作成しました。ダウンロードしたファイルを相手に送ってください。', 'success');
  } catch (error) {
    setShareStatus(error.message === 'package-too-large' ? '共有ファイルは500MBまでです。動画を減らしてください。' : '共有ファイルを作成できませんでした。', 'error');
  } finally { el.createPackage.disabled = false; }
}

async function copyShareCode() {
  try {
    const payload = await exportPlaylist(false);
    payload.items = payload.items.map(({ name, type, size, duration }) => ({ name, type, size, duration }));
    await PlayPocketShare.copyText(PlayPocketShare.createCode({ version: 1, kind: 'playlist-metadata', playlist: payload }));
    setShareStatus('共有コードをコピーしました。動画データは含まれません。', 'success');
  } catch { setShareStatus('共有コードをコピーできませんでした。', 'error'); }
}

async function importShareCode() {
  try {
    const payload = PlayPocketShare.parseCode(el.shareInput.value);
    if (payload?.version !== 1 || payload?.kind !== 'playlist-metadata') throw new Error('invalid-share-code');
    const playlist = await importPlaylist(payload.playlist, ' (shared)');
    el.shareInput.value = '';
    setShareStatus(`「${playlist.name}」を読み込みました。動画データは含まれません。`, 'success');
  } catch { setShareStatus('共有コードを読み込めませんでした。コード全体を貼り付けてください。', 'error'); }
}

async function importFile(file) {
  try {
    if (file.size > MAX_PACKAGE_BYTES) throw new Error('file-too-large');
    const playlist = await importPlaylist(JSON.parse(await file.text()));
    toast(`「${playlist.name}」を読み込みました。`);
  } catch { toast('プレイリストを読み込めませんでした。'); }
}

async function initialize() {
  await openDatabase();
  const playlists = await ensureDefaultPlaylist();
  const saved = localStorage.getItem('playpocket-web.current-playlist');
  currentPlaylistId = playlists.some(playlist => playlist.id === saved) ? saved : playlists[0].id;
  const volume = Number(localStorage.getItem('playpocket-web.volume'));
  el.volume.value = String(Number.isFinite(volume) ? volume : 1);
  el.video.volume = Number(el.volume.value);
  await renderPlaylists();
  await renderCurrentPlaylist();
}

el.create.addEventListener('click', async () => {
  const name = playlistName(el.newName.value);
  if (!name) return;
  const playlist = { id: id(), name: await uniqueName(name, ''), items: [], createdAt: Date.now() };
  await put(STORE_PLAYLISTS, playlist);
  el.newName.value = '';
  await selectPlaylist(playlist.id);
});
el.newName.addEventListener('keydown', event => { if (event.key === 'Enter') el.create.click(); });
el.file.addEventListener('change', async event => { await addFiles(event.target.files); event.target.value = ''; });
el.drop.addEventListener('dragover', event => { event.preventDefault(); el.drop.classList.add('drag'); });
el.drop.addEventListener('dragleave', () => el.drop.classList.remove('drag'));
el.drop.addEventListener('drop', async event => { event.preventDefault(); el.drop.classList.remove('drag'); await addFiles(event.dataTransfer.files); });
el.play.addEventListener('click', togglePlay);
el.centerPlay.addEventListener('click', togglePlay);
el.prev.addEventListener('click', () => next(-1));
el.next.addEventListener('click', () => next(1));
el.video.addEventListener('timeupdate', updateTime);
el.video.addEventListener('loadedmetadata', updateTime);
el.video.addEventListener('play', updateTime);
el.video.addEventListener('pause', updateTime);
el.video.addEventListener('ended', () => next(1));
el.seek.addEventListener('input', () => { if (el.video.duration) el.video.currentTime = el.video.duration * Number(el.seek.value) / 1000; });
el.speed.addEventListener('change', () => { el.video.playbackRate = Number(el.speed.value); });
el.volume.addEventListener('input', () => { el.video.volume = Number(el.volume.value); localStorage.setItem('playpocket-web.volume', el.volume.value); });
el.fullscreen.addEventListener('click', async () => { try { if (document.fullscreenElement) await document.exitFullscreen(); else await el.videoStage.requestFullscreen(); } catch {} });
for (const [button, mode] of [[el.order, 'order'], [el.shuffle, 'shuffle'], [el.random, 'random']]) button.addEventListener('click', () => { playMode = mode; for (const candidate of [el.order, el.shuffle, el.random]) candidate.classList.toggle('active', candidate === button); });
el.exportMeta.addEventListener('click', async () => { const payload = await exportPlaylist(false); download(new Blob([JSON.stringify(payload)], { type: 'application/json' }), `${safeFilename(payload.name)}.playlist.json`); });
el.exportFull.addEventListener('click', createSharePackage);
el.importFile.addEventListener('change', async event => { if (event.target.files[0]) await importFile(event.target.files[0]); event.target.value = ''; });
el.share.addEventListener('click', openShare);
el.closeShare.addEventListener('click', closeShare);
el.modal.addEventListener('click', event => { if (event.target === el.modal) closeShare(); });
el.createPackage.addEventListener('click', createSharePackage);
el.copyCode.addEventListener('click', copyShareCode);
el.importCode.addEventListener('click', importShareCode);
window.addEventListener('keydown', event => { if (event.key === 'Escape') closeShare(); if (event.target.matches('input,textarea,select')) return; if (event.code === 'Space') { event.preventDefault(); togglePlay(); } if (event.code === 'ArrowLeft') el.video.currentTime = Math.max(0, el.video.currentTime - 5); if (event.code === 'ArrowRight') el.video.currentTime += 5; });
window.addEventListener('beforeunload', () => { if (currentUrl) URL.revokeObjectURL(currentUrl); });
initialize().catch(() => toast('ブラウザの保存領域を初期化できませんでした。'));
