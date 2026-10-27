'use strict';

const TEHRAN = [51.389, 35.6892]; // [lng, lat]
const IRAN_BOUNDS = [[42, 23.5], [65, 41.5]];
const MAX_ACCURACY_METERS = 50;
const MIN_STEP_METERS = 3;
const TRACK_KEY = 'bedo.track';
const INTRO_KEY = 'bedo.intro';
const LIME = '#45f03a';

const state = {
  token: localStorage.getItem('bedo.token'),
  user: JSON.parse(localStorage.getItem('bedo.user') || 'null'),
  mode: 'run',
  config: { allowSimulation: false, rules: { closeDistanceMeters: 200 } },
  recording: null, // { points, watchId, timer, startedAt, pausedAt, pausedMs }
  plan: null, // [{ lat, lng }]
  wakeLock: null,
  palette: [],
};

const MODES = {
  run: { icon: '👟', label: 'دویدن', noun: 'دویدن', fastest: 3 },
  ride: { icon: '🚲', label: 'دوچرخه', noun: 'رکاب', fastest: 7 },
};

const $ = (id) => document.getElementById(id);
const fa = (n, digits = 0) =>
  Number(n).toLocaleString('fa-IR', { maximumFractionDigits: digits, minimumFractionDigits: digits });

function formatArea(m2) {
  if (m2 >= 1_000_000) return `${fa(m2 / 1_000_000, 2)} کیلومتر²`;
  return `${fa(m2)} متر²`;
}

function formatDuration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (v) => fa(v).padStart(2, '۰');
  return h ? `${fa(h)}:${pad(m)}:${pad(s % 60)}` : `${fa(m)}:${pad(s % 60)}`;
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

function pathLength(points) {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += distance(points[i - 1], points[i]);
  return total;
}

// Estimated area enclosed if the path were closed now (the server computes
// the real claim, including figure-eights and rivals).
function loopArea(points) {
  if (points.length < 3) return 0;
  const lat0 = points[0].lat * (Math.PI / 180);
  const xy = points.map((p) => [p.lng * 111_320 * Math.cos(lat0), p.lat * 110_540]);
  let twice = 0;
  for (let i = 0; i < xy.length; i++) {
    const [x1, y1] = xy[i];
    const [x2, y2] = xy[(i + 1) % xy.length];
    twice += x1 * y2 - x2 * y1;
  }
  return Math.abs(twice) / 2;
}

function paceText(meters, ms) {
  if (meters < 20 || ms < 5000) return '–';
  if (state.mode === 'ride') return fa((meters / 1000) / (ms / 3_600_000), 1);
  const secPerKm = ms / 1000 / (meters / 1000);
  return formatDuration(secPerKm * 1000);
}

function paceLabels() {
  return state.mode === 'ride' ? ['سرعت', 'کیلومتر/ساعت'] : ['سرعت', 'دقیقه/کیلومتر'];
}

function defaultTitle() {
  const h = new Date().getHours();
  const part = h >= 5 && h < 11 ? 'صبحگاهی' : h < 15 ? 'ظهر' : h < 19 ? 'عصرگاهی' : 'شبانه';
  return `${MODES[state.mode].noun} ${part}`;
}

async function api(path, options = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  const res = await fetch(path, { ...options, headers: { ...headers, ...options.headers } });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401 && state.token) setSession(null, null);
  if (!res.ok) throw new Error(body.error || 'ارتباط با سرور برقرار نشد.');
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
let territories = EMPTY;

async function loadStyle() {
  const res = await fetch('/map/style.json');
  // Asset URLs in the style are relative to this server.
  return JSON.parse((await res.text()).replaceAll('{origin}', location.origin));
}

function line(coords) {
  return { type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: {} };
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

  mapReady = new Promise((resolve) =>
    map.on('load', () => {
      map.addSource('territories', { type: 'geojson', data: EMPTY });
      map.addLayer({
        id: 'territory-fill',
        type: 'fill',
        source: 'territories',
        paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.5 },
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
        paint: { 'line-color': LIME, 'line-width': 2, 'line-dasharray': [2, 2] },
      });
      for (const id of ['track', 'plan']) {
        map.addSource(id, { type: 'geojson', data: EMPTY });
        map.addLayer({
          id: `${id}-glow`,
          type: 'line',
          source: id,
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': LIME, 'line-width': 12, 'line-opacity': 0.25, 'line-blur': 6 },
        });
        map.addLayer({
          id,
          type: 'line',
          source: id,
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: {
            'line-color': LIME,
            'line-width': 5,
            ...(id === 'plan' ? { 'line-dasharray': [1.5, 1] } : {}),
          },
        });
      }
      map.addSource('plan-fill', { type: 'geojson', data: EMPTY });
      map.addLayer(
        { id: 'plan-fill', type: 'fill', source: 'plan-fill', paint: { 'fill-color': LIME, 'fill-opacity': 0.18 } },
        'plan-glow',
      );
      highlightOwnTerritory();
      resolve();
    }),
  );

  map.on('click', 'territory-fill', (e) => {
    if (state.recording || state.plan) return;
    const p = e.features[0].properties;
    new maplibregl.Popup({ closeButton: false })
      .setLngLat(e.lngLat)
      .setHTML(`<strong>${escapeHtml(p.username)}</strong><br>${formatArea(p.area)}`)
      .addTo(map);
  });
  map.on('click', onPlanClick);
  map.on('moveend', loadTerritories);
}

// The signed-in player's land is outlined more strongly.
function highlightOwnTerritory() {
  if (!map?.getLayer('territory-fill')) return;
  const mine = ['==', ['get', 'userId'], state.user?.id ?? -1];
  map.setPaintProperty('territory-line', 'line-width', ['case', mine, 3, 1.5]);
  map.setPaintProperty('territory-fill', 'fill-opacity', ['case', mine, 0.6, 0.5]);
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
      territories = await api(`/api/territories?mode=${state.mode}&bbox=${bbox}`);
      map.getSource('territories').setData(territories);
      updateRuler();
    } catch (err) {
      toast(err.message, { error: true });
    }
  }, 250);
}

// Largest territory among those in view.
function updateRuler() {
  const top = territories.features.reduce(
    (best, f) => (!best || f.properties.area > best.properties.area ? f : best),
    null,
  );
  $('ruler-name').textContent = top ? top.properties.username : 'هنوز کسی نیست';
  $('ruler-area').textContent = top ? `${formatArea(top.properties.area)} ·` : '';
}

async function refreshMyArea() {
  if (!state.user) {
    $('area-value').textContent = fa(0, 2);
    return;
  }
  try {
    const me = await api('/api/me');
    state.palette = me.palette;
    const held = me.held.find((h) => h.mode === state.mode)?.area ?? 0;
    $('area-value').textContent = fa(held / 1_000_000, 2);
  } catch {
    // Keep the last value.
  }
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
  map?.getSource('track')?.setData(line(points.map((p) => [p.lng, p.lat])));
  map?.getSource('start-zone')?.setData(
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

// Browsers only offer location on HTTPS (or localhost).
function gpsAvailable() {
  if (!window.isSecureContext) {
    toast('موقعیت‌یابی فقط روی آدرس امن کار می‌کند. سایت را با https:// باز کنید.', { error: true, duration: 9000 });
    return false;
  }
  if (!navigator.geolocation) {
    toast('مرورگر شما از موقعیت‌یابی پشتیبانی نمی‌کند.', { error: true });
    return false;
  }
  return true;
}

function gpsError(err) {
  const ios = /iPhone|iPad/.test(navigator.userAgent);
  const messages = {
    1: ios
      ? 'دسترسی به موقعیت داده نشده.\nتنظیمات ← حریم خصوصی ← خدمات مکان‌یابی ← وب‌سایت‌های Safari را روی «هنگام استفاده» بگذارید، سپس صفحه را دوباره باز کنید.'
      : 'دسترسی به موقعیت داده نشده. روی آیکن قفل کنار آدرس سایت بزنید، «مکان» را مجاز کنید و صفحه را دوباره باز کنید.',
    2: 'موقعیت پیدا نشد. GPS (موقعیت مکانی) گوشی روشن است؟ بیرون از ساختمان امتحان کنید.',
    3: 'سیگنال GPS دیر رسید. بیرون از ساختمان و زیر آسمان باز امتحان کنید.',
  };
  toast(messages[err.code] ?? 'موقعیت‌یابی کار نکرد.', { error: true, duration: 10000 });
}

$('locate-btn').addEventListener('click', () => {
  if (!gpsAvailable()) return;
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const lngLat = [pos.coords.longitude, pos.coords.latitude];
      showMe(lngLat);
      map.flyTo({ center: lngLat, zoom: 16 });
    },
    gpsError,
    { enableHighAccuracy: true, timeout: 20000 },
  );
});

// ---------- Mode ----------

function setMode(mode) {
  state.mode = mode;
  $('mode-icon').textContent = MODES[mode].icon;
  $('mode-label').textContent = MODES[mode].label;
  $('start-btn').textContent = `${MODES[mode].icon} شروع`;
  document.querySelectorAll('#mode-menu button, #ranks-mode button').forEach((b) =>
    b.classList.toggle('active', b.dataset.mode === mode),
  );
  loadTerritories();
  refreshMyArea();
  if ($('view-ranks').classList.contains('active')) loadRanks();
}

$('mode-btn').addEventListener('click', () => {
  if (state.recording) return;
  $('mode-menu').hidden = !$('mode-menu').hidden;
});
document.querySelectorAll('#mode-menu button').forEach((b) =>
  b.addEventListener('click', () => {
    $('mode-menu').hidden = true;
    setMode(b.dataset.mode);
  }),
);
document.querySelectorAll('#ranks-mode button').forEach((b) =>
  b.addEventListener('click', () => setMode(b.dataset.mode)),
);

// ---------- Screens on the map ----------

function showPanel(name) {
  $('dock').hidden = name !== 'idle';
  $('live-sheet').hidden = name !== 'live';
  $('summary-sheet').hidden = name !== 'summary';
  $('plan-sheet').hidden = name !== 'plan';
  $('plan-head').hidden = name !== 'plan';
  $('play-head').hidden = name === 'plan';
  document.querySelector('.map-overlay').hidden = name === 'plan' || name === 'summary';
  document.querySelector('.tabbar').hidden = name !== 'idle';
  $('mode-menu').hidden = true;
  if (name !== 'idle') document.querySelectorAll('.maplibregl-popup').forEach((p) => p.remove());
  map?.resize();
}

// ---------- Recording ----------

function activeMs(rec) {
  const end = rec.pausedAt ?? Date.now();
  return rec.startedAt ? end - rec.startedAt - rec.pausedMs : 0;
}

function updateLiveStats() {
  const rec = state.recording;
  if (!rec) return;
  const pts = rec.points;
  const meters = pathLength(pts);
  const ms = activeMs(rec);
  $('live-area').textContent = fa(Math.round(loopArea(pts)));
  $('live-distance').textContent = fa(meters / 1000, 2);
  $('live-time').textContent = formatDuration(ms);
  $('live-pace').textContent = paceText(meters, ms);
  const [label, unit] = paceLabels();
  $('live-pace-label').textContent = label;
  $('live-pace-unit').textContent = unit;

  const status = $('live-status');
  const gap = pts.length > 1 ? distance(pts[0], pts.at(-1)) : 0;
  const ready = pts.length > 3 && gap <= state.config.rules.closeDistanceMeters && meters > 100;
  status.className = 'status';
  if (rec.pausedAt) {
    status.textContent = '❚❚ متوقف شده';
    status.classList.add('paused');
  } else if (rec.accuracy == null) {
    status.textContent = '📡 در حال پیدا کردن GPS…';
    status.classList.add('paused');
  } else if (rec.accuracy > MAX_ACCURACY_METERS) {
    status.textContent = `📡 سیگنال GPS ضعیف (دقت ${fa(Math.round(rec.accuracy))} متر)؛ به فضای باز برو`;
    status.classList.add('paused');
  } else if (ready) {
    status.textContent = '✓ حلقه بسته شد؛ آماده‌ی تصرف';
    status.classList.add('ready');
  } else if (pts.length > 1 && meters > 100) {
    status.textContent = `◌ در حال تصرف · ${fa(Math.round(gap))} متر تا نقطه‌ی شروع`;
  } else {
    status.textContent = '◌ در حال تصرف';
  }
}

function addPoint(point) {
  const rec = state.recording;
  if (rec.pausedAt) return;
  const last = rec.points.at(-1);
  if (last && distance(last, point) < MIN_STEP_METERS) return;
  rec.points.push(point);
  rec.startedAt ??= point.t;
  drawTrack(rec.points);
  localStorage.setItem(TRACK_KEY, JSON.stringify({ mode: state.mode, rec: { ...rec, watchId: null, timer: null } }));
  updateLiveStats();
}

async function requestWakeLock() {
  try {
    state.wakeLock = await navigator.wakeLock?.request('screen');
  } catch {
    // Not critical: the screen may just turn off.
  }
}

function watchGps() {
  const rec = state.recording;
  rec.watchId = navigator.geolocation.watchPosition(
    (pos) => {
      const lngLat = [pos.coords.longitude, pos.coords.latitude];
      showMe(lngLat);
      if (rec.accuracy == null) map.flyTo({ center: lngLat, zoom: 16 });
      rec.accuracy = pos.coords.accuracy;
      if (pos.coords.accuracy > MAX_ACCURACY_METERS) return updateLiveStats();
      addPoint({ lat: lngLat[1], lng: lngLat[0], t: pos.timestamp });
    },
    gpsError,
    { enableHighAccuracy: true, maximumAge: 0 },
  );
  clearInterval(rec.timer);
  rec.timer = setInterval(updateLiveStats, 1000);
  requestWakeLock();
}

function stopGps() {
  const rec = state.recording;
  if (rec?.watchId != null) navigator.geolocation.clearWatch(rec.watchId);
  if (rec?.timer) clearInterval(rec.timer);
  if (rec) rec.watchId = rec.timer = null;
  state.wakeLock?.release().catch(() => {});
  state.wakeLock = null;
}

function startRecording(resumed = null) {
  if (!state.user) return openAuth();
  if (!gpsAvailable()) return;
  state.recording = resumed ?? { points: [], startedAt: null, pausedAt: null, pausedMs: 0 };
  state.recording.accuracy = null;
  drawTrack(state.recording.points);
  showPanel('live');
  updateLiveStats();
  watchGps();
}

function togglePause() {
  const rec = state.recording;
  if (rec.pausedAt) {
    rec.pausedMs += Date.now() - rec.pausedAt;
    rec.pausedAt = null;
    $('pause-btn').textContent = '❚❚ توقف';
  } else {
    rec.pausedAt = Date.now();
    $('pause-btn').textContent = '▶ ادامه';
  }
  updateLiveStats();
}

function openSummary() {
  const rec = state.recording;
  stopGps();
  rec.pausedAt ??= Date.now();
  const meters = pathLength(rec.points);
  const ms = activeMs(rec);
  const gap = rec.points.length > 1 ? distance(rec.points[0], rec.points.at(-1)) : Infinity;
  const closed = rec.points.length > 3 && gap <= state.config.rules.closeDistanceMeters;
  $('sum-area').textContent = fa(Math.round(closed ? loopArea(rec.points) : 0));
  $('sum-status').textContent = closed ? '✓ حلقه بسته است' : 'حلقه بسته نشده؛ زمینی تصرف نمی‌شود';
  $('sum-status').className = closed ? 'status ready' : 'status paused';
  $('sum-title').value ||= defaultTitle();
  $('sum-distance').textContent = fa(meters / 1000, 2);
  $('sum-time').textContent = formatDuration(ms);
  $('sum-pace').textContent = paceText(meters, ms);
  const [label, unit] = paceLabels();
  $('sum-pace-label').textContent = label;
  $('sum-pace-unit').textContent = unit;
  $('discard-confirm').hidden = true;
  showPanel('summary');
}

function resumeRecording() {
  const rec = state.recording;
  rec.pausedMs += Date.now() - rec.pausedAt;
  rec.pausedAt = null;
  $('pause-btn').textContent = '❚❚ توقف';
  showPanel('live');
  watchGps();
}

function endRecording() {
  stopGps();
  state.recording = null;
  localStorage.removeItem(TRACK_KEY);
  drawTrack([]);
  $('sum-title').value = '';
  $('sum-note').value = '';
  $('pause-btn').textContent = '❚❚ توقف';
  showPanel('idle');
}

function claimMessage(result) {
  let message = `🎉 ${formatArea(result.gainedSqMeters)} به قلمروی تو اضافه شد.`;
  for (const c of result.captured) message += `\n⚔️ ${formatArea(c.areaSqMeters)} از ${c.username} گرفتی.`;
  return message;
}

async function saveActivity() {
  const rec = state.recording;
  $('save-btn').disabled = true;
  try {
    const result = await api('/api/activities', {
      method: 'POST',
      body: JSON.stringify({
        mode: state.mode,
        points: rec.points,
        title: $('sum-title').value,
        note: $('sum-note').value,
      }),
    });
    endRecording();
    toast(claimMessage(result), { duration: 8000 });
    loadTerritories();
    refreshMyArea();
  } catch (err) {
    toast(err.message, { error: true });
  } finally {
    $('save-btn').disabled = false;
  }
}

$('start-btn').addEventListener('click', () => startRecording());
$('pause-btn').addEventListener('click', togglePause);
$('finish-btn').addEventListener('click', openSummary);
$('resume-btn').addEventListener('click', resumeRecording);
$('save-btn').addEventListener('click', saveActivity);
$('discard-btn').addEventListener('click', () => ($('discard-confirm').hidden = false));
$('discard-no').addEventListener('click', () => ($('discard-confirm').hidden = true));
$('discard-yes').addEventListener('click', endRecording);

// ---------- Route planning ----------

function drawPlan() {
  const pts = state.plan ?? [];
  map.getSource('plan')?.setData(line(pts.map((p) => [p.lng, p.lat])));
  map.getSource('plan-fill')?.setData(
    pts.length > 2
      ? {
          type: 'Feature',
          geometry: { type: 'Polygon', coordinates: [[...pts, pts[0]].map((p) => [p.lng, p.lat])] },
          properties: {},
        }
      : EMPTY,
  );
  const closed = [...pts, ...(pts.length > 2 ? [pts[0]] : [])];
  $('plan-distance').textContent = formatDistance(pathLength(closed));
  $('plan-area').textContent = formatArea(Math.round(loopArea(pts)));
  $('plan-claim').disabled = pts.length < 3;
}

function formatDistance(m) {
  return m >= 1000 ? `${fa(m / 1000, 2)} کیلومتر` : `${fa(Math.round(m))} متر`;
}

function enterPlan() {
  state.plan = [];
  $('plan-claim').hidden = !state.config.allowSimulation;
  showPanel('plan');
  drawPlan();
}

function exitPlan() {
  state.plan = null;
  map.getSource('plan')?.setData(EMPTY);
  map.getSource('plan-fill')?.setData(EMPTY);
  showPanel('idle');
}

function onPlanClick(e) {
  if (!state.plan) return;
  state.plan.push({ lat: e.lngLat.lat, lng: e.lngLat.lng });
  drawPlan();
}

// Test-only shortcut: submit the planned loop as if it had been run.
async function claimPlan() {
  if (!state.user) return openAuth();
  const pts = [...state.plan, state.plan[0]];
  const speed = MODES[state.mode].fastest;
  let t = Date.now();
  const points = pts.map((p, i) => {
    if (i) t += (distance(pts[i - 1], p) / speed) * 1000;
    return { ...p, t };
  });
  try {
    const result = await api('/api/activities', {
      method: 'POST',
      body: JSON.stringify({ mode: state.mode, points, simulated: true, title: 'مسیر آزمایشی' }),
    });
    exitPlan();
    toast(claimMessage(result), { duration: 8000 });
    loadTerritories();
    refreshMyArea();
  } catch (err) {
    toast(err.message, { error: true });
  }
}

$('plan-btn').addEventListener('click', enterPlan);
$('plan-back').addEventListener('click', exitPlan);
$('plan-undo').addEventListener('click', () => {
  state.plan.pop();
  drawPlan();
});
$('plan-clear').addEventListener('click', () => {
  state.plan = [];
  drawPlan();
});
$('plan-claim').addEventListener('click', claimPlan);

// ---------- Views ----------

function showView(view) {
  document.querySelectorAll('.tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${view}`));
  if (view === 'play') map?.resize();
  if (view === 'ranks') loadRanks();
  if (view === 'me') loadProfile();
}

document.querySelectorAll('.tabbar button').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));
$('avatar-btn').addEventListener('click', () => (state.user ? showView('me') : openAuth()));

function badge(user, cls = 'badge') {
  return `<span class="${cls} badge" style="--user-color:${escapeHtml(user.color)}">${escapeHtml(
    [...user.username][0].toUpperCase(),
  )}</span>`;
}

function timeAgo(ts) {
  const minutes = Math.round((Date.now() - ts) / 60000);
  if (minutes < 1) return 'همین الان';
  if (minutes < 60) return `${fa(minutes)} دقیقه پیش`;
  if (minutes < 1440) return `${fa(Math.round(minutes / 60))} ساعت پیش`;
  return `${fa(Math.round(minutes / 1440))} روز پیش`;
}

async function loadRanks() {
  try {
    const [leaders, feed] = await Promise.all([
      api(`/api/leaderboard?mode=${state.mode}`),
      api(`/api/feed?mode=${state.mode}`),
    ]);
    // Right to left: second, first, third.
    const heights = { 1: 150, 2: 112, 3: 84 };
    $('podium').innerHTML = leaders.length
      ? [2, 1, 3]
          .map((place) => {
            const r = leaders[place - 1];
            if (!r) return '<div></div>';
            return `<div class="podium-col">
              <span class="crown">${place === 1 ? '👑' : ''}</span>
              ${badge(r, 'podium-badge')}
              <span class="name">${escapeHtml(r.username)}</span>
              <span class="area num">${formatArea(r.area)}</span>
              <div class="block num" style="height:${heights[place]}px;background:${escapeHtml(r.color)}">${fa(place)}</div>
            </div>`;
          })
          .join('')
      : '<p class="empty">هنوز کسی قلمرویی ندارد. اولین نفر باش!</p>';
    $('leaderboard').innerHTML = leaders
      .slice(3)
      .map(
        (r, i) => `<li><span class="rank-no num">${fa(i + 4)}#</span>${badge(r, 'rank-badge')}
          <span class="rank-name">${escapeHtml(r.username)}</span>
          <span class="rank-area num">${formatArea(r.area)}</span></li>`,
      )
      .join('');

    const you = $('you-row');
    if (state.user) {
      const idx = leaders.findIndex((r) => r.id === state.user.id);
      const area = idx >= 0 ? leaders[idx].area : 0;
      you.innerHTML = `<span class="rank-no num">${idx >= 0 ? `${fa(idx + 1)}#` : '–'}</span>${badge(
        state.user,
        'rank-badge',
      )}<span class="rank-name">تو</span><span class="rank-area num">${formatArea(area)}</span>`;
      you.hidden = false;
    } else {
      you.hidden = true;
    }

    $('feed').innerHTML = feed.length
      ? feed
          .map(
            (c) => `<li><span>⚔️ <b>${escapeHtml(c.attacker)}</b> ${formatArea(c.area)} از
              <b>${escapeHtml(c.victim)}</b> گرفت</span><time>${timeAgo(c.created_at)}</time></li>`,
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
    el.innerHTML = `<h2 class="display">بدو</h2><p>برای ساختن قلمروی خودت وارد شو.</p>
      <button class="btn btn-lime wide" id="profile-login">ورود / ثبت‌نام</button>`;
    $('profile-login').addEventListener('click', openAuth);
    return;
  }
  try {
    const me = await api('/api/me');
    state.palette = me.palette;
    const stats = me.stats.find((s) => s.mode === state.mode) ?? { activities: 0, distance: 0 };
    const held = me.held.find((h) => h.mode === state.mode)?.area ?? 0;
    el.innerHTML = `
      <div class="me-head">${badge(me.user)}<div><h2>${escapeHtml(me.user.username)}</h2>
        <p>${MODES[state.mode].label}</p></div></div>
      <div class="me-stats">
        <div><b class="num">${fa(held / 1_000_000, 2)}</b><small>کیلومتر² قلمرو</small></div>
        <div><b class="num">${fa(stats.activities)}</b><small>فعالیت</small></div>
        <div><b class="num">${fa((stats.distance ?? 0) / 1000, 1)}</b><small>کیلومتر</small></div>
      </div>
      <h3>رنگ قلمرو</h3>
      <div class="color-grid" id="me-colors"></div>
      <h3>فعالیت‌های اخیر</h3>
      <div>${
        me.recent.length
          ? me.recent
              .map(
                (a) => `<div class="activity"><span class="act-icon">${MODES[a.mode]?.icon ?? '👟'}</span>
                  <div class="act-main"><b>${escapeHtml(a.title || MODES[a.mode]?.noun || '')}</b>
                  <small>${fa(a.distance / 1000, 2)} کیلومتر · ${formatDuration(a.duration_ms)} · ${timeAgo(a.created_at)}</small></div>
                  <span class="act-area num">${formatArea(a.claimed_area)}</span></div>`,
              )
              .join('')
          : '<p class="empty">هنوز فعالیتی ثبت نکرده‌ای.</p>'
      }</div>
      <p><button class="btn btn-light wide" id="logout-btn">خروج از حساب</button></p>`;
    renderColors($('me-colors'));
    $('logout-btn').addEventListener('click', async () => {
      await api('/api/logout', { method: 'POST' }).catch(() => {});
      setSession(null, null);
      loadProfile();
    });
  } catch (err) {
    toast(err.message, { error: true });
  }
}

function renderColors(container) {
  container.innerHTML = state.palette
    .map(
      (c) => `<button type="button" class="swatch-btn${c === state.user?.color ? ' active' : ''}"
        style="background:${c}" data-color="${c}" aria-label="رنگ ${c}"></button>`,
    )
    .join('');
  container.querySelectorAll('button').forEach((b) =>
    b.addEventListener('click', async () => {
      try {
        const { user } = await api('/api/me', { method: 'PATCH', body: JSON.stringify({ color: b.dataset.color }) });
        setSession(state.token, user);
        container.querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
        document.querySelectorAll('#me-colors, #color-grid').forEach((g) => g !== container && renderColors(g));
      } catch (err) {
        toast(err.message, { error: true });
      }
    }),
  );
}

// ---------- Auth ----------

let registering = false;

function setSession(token, user) {
  state.token = token;
  state.user = user;
  if (token) {
    localStorage.setItem('bedo.token', token);
    localStorage.setItem('bedo.user', JSON.stringify(user));
  } else {
    localStorage.removeItem('bedo.token');
    localStorage.removeItem('bedo.user');
  }
  const btn = $('avatar-btn');
  btn.textContent = user ? [...user.username][0].toUpperCase() : 'ب';
  document.documentElement.style.setProperty('--user-color', user?.color ?? '#e5484d');
  highlightOwnTerritory();
  loadTerritories();
  refreshMyArea();
}

function setAuthMode(register) {
  registering = register;
  $('auth-title').textContent = register ? 'بیا تو بازی' : 'ورود';
  $('auth-submit').textContent = register ? 'ساخت حساب' : 'ورود';
  $('auth-switch').textContent = register ? 'حساب داری؟ ورود' : 'حساب نداری؟ ثبت‌نام';
  $('auth-form').password.autocomplete = register ? 'new-password' : 'current-password';
}

function openAuth() {
  setAuthMode(false);
  $('auth-error').hidden = true;
  $('auth-dialog').showModal();
}

$('auth-switch').addEventListener('click', () => setAuthMode(!registering));
$('auth-close').addEventListener('click', () => $('auth-dialog').close());
$('auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const wasRegistering = registering;
  try {
    const result = await api(registering ? '/api/register' : '/api/login', {
      method: 'POST',
      body: JSON.stringify({ username: form.username.value.trim(), password: form.password.value }),
    });
    setSession(result.token, result.user);
    form.reset();
    $('auth-dialog').close();
    if (wasRegistering) {
      await refreshMyArea();
      renderColors($('color-grid'));
      $('color-dialog').showModal();
    } else {
      toast(`خوش برگشتی ${result.user.username}!`);
    }
  } catch (err) {
    $('auth-error').textContent = err.message;
    $('auth-error').hidden = false;
  }
});

// ---------- First-run intro ----------

const INTRO = [
  {
    title: 'حلقه رو ببند',
    text: 'وقتی حرکت می‌کنی، مسیرت روی نقشه کشیده می‌شود. حلقه را ببند تا هر چه داخلش است مال تو شود.',
    art: `<path d="M70 120 L120 40 L230 50 L260 120 L180 150 Z" fill="${LIME}" fill-opacity=".25" stroke="${LIME}" stroke-width="5" stroke-linejoin="round"/>
          <circle cx="70" cy="120" r="9" fill="#2f6bff" stroke="#fff" stroke-width="3"/>`,
  },
  {
    title: 'بگیرش',
    text: 'از زمین بقیه رد شو و حلقه بزن تا مال تو شود. حواست باشد، آن‌ها هم می‌توانند زمینت را بگیرند.',
    art: `<rect x="60" y="30" width="130" height="100" fill="#e5484d" fill-opacity=".45" stroke="#e5484d" stroke-width="3"/>
          <path d="M140 60 L270 55 L265 150 L135 145 Z" fill="${LIME}" fill-opacity=".3" stroke="${LIME}" stroke-width="5" stroke-linejoin="round"/>`,
  },
  {
    title: 'قلمروت رو بزرگ کن',
    text: 'محله به محله یا یک‌جا. مسیر رفت‌وبرگشتی تقریباً هیچ زمینی نمی‌گیرد؛ دور بزن!',
    art: `<circle cx="110" cy="90" r="55" fill="${LIME}" fill-opacity=".25" stroke="${LIME}" stroke-width="5"/>
          <text x="110" y="97" fill="#fff" font-size="18" font-weight="800" text-anchor="middle" font-family="Vazirmatn">عالی</text>
          <path d="M250 25 L255 160" stroke="#e8c22e" stroke-width="6"/>
          <text x="225" y="100" fill="#e8c22e" font-size="16" font-weight="800" text-anchor="middle" font-family="Vazirmatn">نه!</text>`,
  },
];

let introStep = 0;
function renderIntro() {
  const step = INTRO[introStep];
  $('intro-art').innerHTML = `<svg viewBox="0 0 320 180" preserveAspectRatio="xMidYMid slice">
    <g stroke="#3a4047" stroke-width="6">${[30, 75, 120, 165].map((y) => `<path d="M0 ${y} H320"/>`).join('')}
    ${[40, 110, 180, 250].map((x) => `<path d="M${x} 0 V180"/>`).join('')}</g>${step.art}</svg>`;
  $('intro-title').textContent = step.title;
  $('intro-text').textContent = step.text;
  $('intro-dots').innerHTML = INTRO.map((_, i) => `<span class="${i === introStep ? 'on' : ''}"></span>`).join('');
  $('intro-next').textContent = introStep === INTRO.length - 1 ? 'بزن بریم' : 'بعدی';
}

function closeIntro() {
  localStorage.setItem(INTRO_KEY, '1');
  $('intro-dialog').close();
}

$('intro-next').addEventListener('click', () => {
  if (introStep === INTRO.length - 1) return closeIntro();
  introStep++;
  renderIntro();
});
$('intro-skip').addEventListener('click', closeIntro);

// ---------- Startup ----------

async function init() {
  createMap(await loadStyle());
  setSession(state.token, state.user);
  setMode('run');
  try {
    state.config = await api('/api/config');
  } catch {
    // Keep defaults.
  }

  // Resume a recording interrupted by a reload.
  const saved = JSON.parse(localStorage.getItem(TRACK_KEY) || 'null');
  if (saved?.rec?.points?.length && state.user && confirm('یک فعالیت نیمه‌کاره پیدا شد. ادامه می‌دهی؟')) {
    setMode(saved.mode);
    await mapReady;
    startRecording(saved.rec);
  } else {
    localStorage.removeItem(TRACK_KEY);
  }

  if (!localStorage.getItem(INTRO_KEY)) {
    renderIntro();
    $('intro-dialog').showModal();
  }

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
}

init();
