'use strict';

const TEHRAN = [51.389, 35.6892]; // [lng, lat]
const IRAN_BOUNDS = [[42, 23.5], [65, 41.5]];
const MAX_ACCURACY_METERS = 50;
const MIN_STEP_METERS = 3;
const TRACK_KEY = 'ghalamro.track';

const state = {
  token: localStorage.getItem('ghalamro.token'),
  user: JSON.parse(localStorage.getItem('ghalamro.user') || 'null'),
  mode: 'run',
  config: { allowSimulation: false, rules: { closeDistanceMeters: 200 } },
  recording: null, // { points, watchId, timer, simulated }
  wakeLock: null,
};

const $ = (id) => document.getElementById(id);
const fa = (n, digits = 0) =>
  Number(n).toLocaleString('fa-IR', { maximumFractionDigits: digits, minimumFractionDigits: digits });

function formatArea(m2) {
  if (m2 >= 1_000_000) return `${fa(m2 / 1_000_000, 2)} کیلومتر مربع`;
  return `${fa(m2)} متر مربع`;
}

function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (v) => fa(v).padStart(2, '۰');
  return h ? `${fa(h)}:${pad(m)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`;
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

// Great-circle distance in meters between two { lat, lng } points.
function distance(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}

async function api(path, options = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  const res = await fetch(path, { ...options, headers: { ...headers, ...options.headers } });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401 && state.token) setSession(null, null);
  if (!res.ok) throw new Error(body.error || 'خطا در ارتباط با سرور');
  return body;
}

let toastTimer;
function toast(message, { error = false, duration = 5000 } = {}) {
  const el = $('toast');
  el.textContent = message;
  el.classList.toggle('error', error);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), duration);
}

// ---------- Map ----------

const pmtilesProtocol = new pmtiles.Protocol();
maplibregl.addProtocol('pmtiles', pmtilesProtocol.tile);
// Shapes Persian/Arabic labels and lays them out right-to-left.
maplibregl.setRTLTextPlugin('/vendor/rtl-text/mapbox-gl-rtl-text.js', true);

const EMPTY = { type: 'FeatureCollection', features: [] };
let map;
let mapReady;
let meMarker = null;

async function loadStyle() {
  const res = await fetch('/map/style.json');
  // Asset URLs in the style are relative to this server.
  return JSON.parse((await res.text()).replaceAll('{origin}', location.origin));
}

function createMap(style) {
  map = new maplibregl.Map({
    container: 'map',
    style,
    center: TEHRAN,
    zoom: 13,
    maxBounds: IRAN_BOUNDS,
    attributionControl: { compact: true },
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-left');

  mapReady = new Promise((resolve) =>
    map.on('load', () => {
      map.addSource('territories', { type: 'geojson', data: EMPTY });
      map.addLayer({
        id: 'territory-fill',
        type: 'fill',
        source: 'territories',
        paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.25 },
      });
      map.addLayer({
        id: 'territory-line',
        type: 'line',
        source: 'territories',
        paint: { 'line-color': ['get', 'color'], 'line-width': 1.5 },
      });
      map.addSource('start-zone', { type: 'geojson', data: EMPTY });
      map.addLayer({
        id: 'start-zone',
        type: 'line',
        source: 'start-zone',
        paint: { 'line-color': '#16a34a', 'line-width': 2, 'line-dasharray': [3, 3] },
      });
      map.addSource('track', { type: 'geojson', data: EMPTY });
      map.addLayer({
        id: 'track',
        type: 'line',
        source: 'track',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#f97316', 'line-width': 5 },
      });
      highlightOwnTerritory();
      resolve();
    }),
  );

  map.on('click', 'territory-fill', (e) => {
    if (state.recording) return;
    const p = e.features[0].properties;
    new maplibregl.Popup()
      .setLngLat(e.lngLat)
      .setHTML(`<strong>${escapeHtml(p.username)}</strong><br>${formatArea(p.area)}`)
      .addTo(map);
  });
  map.on('click', onSimClick);
  map.on('moveend', loadTerritories);
}

// Make the signed-in player's land stand out.
function highlightOwnTerritory() {
  if (!map?.getLayer('territory-fill')) return;
  const mine = ['==', ['get', 'userId'], state.user?.id ?? -1];
  map.setPaintProperty('territory-fill', 'fill-opacity', ['case', mine, 0.4, 0.25]);
  map.setPaintProperty('territory-line', 'line-width', ['case', mine, 3, 1.5]);
}

let loadTimer;
function loadTerritories() {
  clearTimeout(loadTimer);
  loadTimer = setTimeout(async () => {
    if (!map) return;
    await mapReady;
    const b = map.getBounds();
    const bbox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].join(',');
    try {
      map.getSource('territories').setData(await api(`/api/territories?mode=${state.mode}&bbox=${bbox}`));
    } catch (err) {
      toast(err.message, { error: true });
    }
  }, 250);
}

function circlePolygon(center, radiusMeters, steps = 64) {
  const ring = [];
  const dLat = radiusMeters / 111_320;
  const dLng = dLat / Math.cos((center.lat * Math.PI) / 180);
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * 2 * Math.PI;
    ring.push([center.lng + dLng * Math.cos(a), center.lat + dLat * Math.sin(a)]);
  }
  return { type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring] }, properties: {} };
}

function drawTrack(points) {
  map.getSource('track')?.setData({
    type: 'Feature',
    geometry: { type: 'LineString', coordinates: points.map((p) => [p.lng, p.lat]) },
    properties: {},
  });
  map.getSource('start-zone')?.setData(
    points.length ? circlePolygon(points[0], state.config.rules.closeDistanceMeters) : EMPTY,
  );
}

function showMe(lngLat) {
  if (!meMarker) {
    const el = document.createElement('div');
    el.className = 'me-marker';
    meMarker = new maplibregl.Marker({ element: el }).setLngLat(lngLat).addTo(map);
  } else {
    meMarker.setLngLat(lngLat);
  }
}

$('locate-btn').addEventListener('click', () => {
  if (!navigator.geolocation) return toast('مرورگر شما از موقعیت‌یابی پشتیبانی نمی‌کند.', { error: true });
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const lngLat = [pos.coords.longitude, pos.coords.latitude];
      showMe(lngLat);
      map.flyTo({ center: lngLat, zoom: 16 });
    },
    () => toast('دسترسی به موقعیت مکانی داده نشد.', { error: true }),
    { enableHighAccuracy: true, timeout: 15000 },
  );
});

// ---------- Recording ----------

function setRecordingUi(active) {
  $('start-btn').hidden = active;
  $('finish-btn').hidden = !active;
  $('cancel-btn').hidden = !active;
  $('live-stats').hidden = !active;
  $('sim-btn').hidden = active;
  $('sim-hint').hidden = !(active && state.recording?.simulated);
  document.querySelectorAll('.mode-toggle button').forEach((b) => (b.disabled = active));
  if (active) document.querySelectorAll('.maplibregl-popup').forEach((p) => p.remove());
}

function updateLiveStats() {
  const rec = state.recording;
  if (!rec) return;
  const pts = rec.points;
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += distance(pts[i - 1], pts[i]);
  $('stat-distance').textContent = fa(total / 1000, 2);
  const elapsed = pts.length ? (rec.simulated ? pts.at(-1).t - pts[0].t : Date.now() - pts[0].t) : 0;
  $('stat-time').textContent = formatDuration(elapsed);

  const gapEl = $('stat-gap');
  if (pts.length > 1) {
    const gap = distance(pts[0], pts.at(-1));
    gapEl.textContent = `${fa(gap)} م`;
    gapEl.classList.toggle('ok', gap <= state.config.rules.closeDistanceMeters && pts.length > 3);
  } else {
    gapEl.textContent = '–';
  }
}

function addPoint(point) {
  const rec = state.recording;
  const last = rec.points.at(-1);
  if (last && distance(last, point) < MIN_STEP_METERS) return;
  rec.points.push(point);
  drawTrack(rec.points);
  if (!rec.simulated) {
    localStorage.setItem(TRACK_KEY, JSON.stringify({ mode: state.mode, points: rec.points }));
  }
  updateLiveStats();
}

async function requestWakeLock() {
  try {
    state.wakeLock = await navigator.wakeLock?.request('screen');
  } catch {
    // Not critical: the screen may just turn off.
  }
}

function startRecording({ simulated = false, resume = null } = {}) {
  if (!state.user) return openAuth();
  state.recording = { points: [], watchId: null, timer: null, simulated };
  drawTrack([]);
  setRecordingUi(true);
  if (simulated) return;

  if (!navigator.geolocation) {
    stopRecording();
    return toast('مرورگر شما از موقعیت‌یابی پشتیبانی نمی‌کند.', { error: true });
  }
  resume?.forEach(addPoint);
  state.recording.watchId = navigator.geolocation.watchPosition(
    (pos) => {
      const lngLat = [pos.coords.longitude, pos.coords.latitude];
      showMe(lngLat);
      if (pos.coords.accuracy > MAX_ACCURACY_METERS) return;
      if (state.recording.points.length === 0) map.flyTo({ center: lngLat, zoom: 16 });
      addPoint({ lat: lngLat[1], lng: lngLat[0], t: pos.timestamp });
    },
    () => toast('دسترسی به موقعیت مکانی داده نشد.', { error: true }),
    { enableHighAccuracy: true, maximumAge: 0 },
  );
  state.recording.timer = setInterval(updateLiveStats, 1000);
  requestWakeLock();
}

// Simulated track: each click is a point reached at a jogging pace.
function onSimClick(e) {
  if (!state.recording?.simulated) return;
  const pts = state.recording.points;
  const point = { lat: e.lngLat.lat, lng: e.lngLat.lng, t: Date.now() };
  if (pts.length) point.t = pts.at(-1).t + (distance(pts.at(-1), point) / (state.mode === 'run' ? 3 : 7)) * 1000;
  addPoint(point);
}

function stopRecording() {
  const rec = state.recording;
  if (rec?.watchId != null) navigator.geolocation.clearWatch(rec.watchId);
  if (rec?.timer) clearInterval(rec.timer);
  state.wakeLock?.release().catch(() => {});
  state.wakeLock = null;
  state.recording = null;
  localStorage.removeItem(TRACK_KEY);
  drawTrack([]);
  setRecordingUi(false);
}

async function finishRecording() {
  const rec = state.recording;
  const points = rec.points.slice();
  // A simulated loop is closed by returning to the first click.
  if (rec.simulated && points.length > 2) {
    const first = points[0];
    const last = points.at(-1);
    points.push({ lat: first.lat, lng: first.lng, t: last.t + (distance(last, first) / 3) * 1000 });
  }

  $('finish-btn').disabled = true;
  try {
    const result = await api('/api/activities', {
      method: 'POST',
      body: JSON.stringify({ mode: state.mode, points, simulated: rec.simulated }),
    });
    stopRecording();
    let message = `🎉 ${formatArea(result.gainedSqMeters)} به قلمروی شما اضافه شد.`;
    for (const c of result.captured) {
      message += `\n⚔️ ${formatArea(c.areaSqMeters)} از ${c.username} تصرف شد.`;
    }
    toast(message, { duration: 8000 });
    loadTerritories();
  } catch (err) {
    toast(err.message, { error: true });
  } finally {
    $('finish-btn').disabled = false;
  }
}

$('start-btn').addEventListener('click', () => startRecording());
$('sim-btn').addEventListener('click', () => startRecording({ simulated: true }));
$('finish-btn').addEventListener('click', finishRecording);
$('cancel-btn').addEventListener('click', () => {
  if (confirm('فعالیت فعلی لغو شود؟')) stopRecording();
});

document.querySelectorAll('.mode-toggle button').forEach((btn) =>
  btn.addEventListener('click', () => {
    state.mode = btn.dataset.mode;
    document.querySelectorAll('.mode-toggle button').forEach((b) => b.classList.toggle('active', b === btn));
    loadTerritories();
    if ($('view-leaders').classList.contains('active')) loadLeaders();
    if ($('view-profile').classList.contains('active')) loadProfile();
  }),
);

// ---------- Views ----------

document.querySelectorAll('.tabbar button').forEach((btn) =>
  btn.addEventListener('click', () => {
    const view = btn.dataset.view;
    document.querySelectorAll('.tabbar button').forEach((b) => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${view}`));
    if (view === 'map') map?.resize();
    if (view === 'leaders') loadLeaders();
    if (view === 'profile') loadProfile();
  }),
);

function timeAgo(ts) {
  const minutes = Math.round((Date.now() - ts) / 60000);
  if (minutes < 1) return 'همین الان';
  if (minutes < 60) return `${fa(minutes)} دقیقه پیش`;
  if (minutes < 1440) return `${fa(Math.round(minutes / 60))} ساعت پیش`;
  return `${fa(Math.round(minutes / 1440))} روز پیش`;
}

async function loadLeaders() {
  try {
    const [leaders, feed] = await Promise.all([
      api(`/api/leaderboard?mode=${state.mode}`),
      api(`/api/feed?mode=${state.mode}`),
    ]);
    $('leaderboard').innerHTML = leaders.length
      ? leaders
          .map(
            (r, i) => `<li><span class="rank">${fa(i + 1)}</span>
              <span class="swatch" style="background:${escapeHtml(r.color)}"></span>
              <span>${escapeHtml(r.username)}</span>
              <span class="value">${formatArea(r.area)}</span></li>`,
          )
          .join('')
      : '<li class="empty">هنوز کسی قلمرویی ندارد. اولین نفر باشید!</li>';
    $('feed').innerHTML = feed.length
      ? feed
          .map(
            (c) => `<li>⚔️ <span><strong>${escapeHtml(c.attacker)}</strong> ${formatArea(c.area)} از
              <strong>${escapeHtml(c.victim)}</strong> گرفت</span>
              <span class="value hint">${timeAgo(c.created_at)}</span></li>`,
          )
          .join('')
      : '<li class="empty">هنوز نبردی ثبت نشده است.</li>';
  } catch (err) {
    toast(err.message, { error: true });
  }
}

async function loadProfile() {
  const el = $('profile');
  if (!state.user) {
    el.innerHTML = '<p>برای دیدن آمار خود وارد شوید.</p><button class="primary" id="profile-login">ورود / ثبت‌نام</button>';
    $('profile-login').addEventListener('click', openAuth);
    return;
  }
  try {
    const me = await api('/api/me');
    const stats = me.stats.find((s) => s.mode === state.mode) ?? { activities: 0, distance: 0 };
    const held = me.held.find((h) => h.mode === state.mode)?.area ?? 0;
    el.innerHTML = `
      <h2><span class="swatch" style="display:inline-block;width:14px;height:14px;border-radius:4px;background:${escapeHtml(me.user.color)}"></span>
        ${escapeHtml(me.user.username)}</h2>
      <div class="stat-cards">
        <div><strong>${formatArea(held)}</strong><small>قلمروی فعلی</small></div>
        <div><strong>${fa(stats.activities)}</strong><small>فعالیت</small></div>
        <div><strong>${fa((stats.distance ?? 0) / 1000, 1)} کیلومتر</strong><small>مسافت کل</small></div>
      </div>
      <p><button class="secondary" id="logout-btn">خروج از حساب</button></p>`;
    $('logout-btn').addEventListener('click', async () => {
      await api('/api/logout', { method: 'POST' }).catch(() => {});
      setSession(null, null);
      loadProfile();
    });
  } catch (err) {
    toast(err.message, { error: true });
  }
}

// ---------- Auth ----------

let registering = false;

function setSession(token, user) {
  state.token = token;
  state.user = user;
  if (token) {
    localStorage.setItem('ghalamro.token', token);
    localStorage.setItem('ghalamro.user', JSON.stringify(user));
  } else {
    localStorage.removeItem('ghalamro.token');
    localStorage.removeItem('ghalamro.user');
  }
  $('account-btn').textContent = user ? user.username : 'ورود';
  highlightOwnTerritory();
  loadTerritories();
}

function setAuthMode(register) {
  registering = register;
  $('auth-title').textContent = register ? 'ثبت‌نام' : 'ورود';
  $('auth-submit').textContent = register ? 'ساخت حساب' : 'ورود';
  $('auth-switch').textContent = register ? 'حساب دارید؟ ورود' : 'حساب ندارید؟ ثبت‌نام';
  $('auth-form').password.autocomplete = register ? 'new-password' : 'current-password';
}

function openAuth() {
  setAuthMode(false);
  $('auth-error').hidden = true;
  $('auth-dialog').showModal();
}

$('account-btn').addEventListener('click', () => {
  if (state.user) document.querySelector('.tabbar [data-view="profile"]').click();
  else openAuth();
});
$('auth-switch').addEventListener('click', () => setAuthMode(!registering));
$('auth-close').addEventListener('click', () => $('auth-dialog').close());
$('auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  try {
    const result = await api(registering ? '/api/register' : '/api/login', {
      method: 'POST',
      body: JSON.stringify({ username: form.username.value.trim(), password: form.password.value }),
    });
    setSession(result.token, result.user);
    form.reset();
    $('auth-dialog').close();
    toast(`خوش آمدید ${result.user.username}!`);
  } catch (err) {
    $('auth-error').textContent = err.message;
    $('auth-error').hidden = false;
  }
});

// ---------- Startup ----------

async function init() {
  createMap(await loadStyle());
  setSession(state.token, state.user);
  try {
    state.config = await api('/api/config');
  } catch {
    // Keep defaults.
  }
  $('sim-tools').hidden = !state.config.allowSimulation;

  // Resume a GPS recording interrupted by a reload.
  const saved = JSON.parse(localStorage.getItem(TRACK_KEY) || 'null');
  if (saved?.points?.length && state.user && confirm('یک فعالیت نیمه‌کاره پیدا شد. ادامه می‌دهید؟')) {
    state.mode = saved.mode;
    document.querySelectorAll('.mode-toggle button').forEach((b) =>
      b.classList.toggle('active', b.dataset.mode === saved.mode),
    );
    await mapReady;
    startRecording({ resume: saved.points });
  } else {
    localStorage.removeItem(TRACK_KEY);
  }

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
}

init();
