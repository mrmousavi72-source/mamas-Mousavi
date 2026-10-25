const test = require('node:test');
const assert = require('node:assert/strict');
const { openDatabase } = require('../server/db');
const { createApp } = require('../server/app');
const { isInsideIran } = require('../server/iran');

// Square loop of `size` degrees around (lat, lng), walked at ~3 m/s.
function squareLoop(lat, lng, size, startTime = Date.now()) {
  const corners = [
    [lat, lng],
    [lat, lng + size],
    [lat + size, lng + size],
    [lat + size, lng],
    [lat, lng],
  ];
  const points = [];
  let t = startTime;
  for (let i = 0; i < corners.length - 1; i++) {
    const [aLat, aLng] = corners[i];
    const [bLat, bLng] = corners[i + 1];
    for (let s = 0; s < 10; s++) {
      points.push({ lat: aLat + ((bLat - aLat) * s) / 10, lng: aLng + ((bLng - aLng) * s) / 10, t });
      t += ((size * 111_000) / 10 / 3) * 1000;
    }
  }
  points.push({ lat, lng, t });
  return points;
}

async function withServer(fn, options = { allowSimulation: true }) {
  const app = createApp(openDatabase(':memory:'), options);
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, { token, body, method } = {}) => {
    const res = await fetch(base + path, {
      method: method ?? (body ? 'POST' : 'GET'),
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };
  try {
    await fn(call);
  } finally {
    server.close();
  }
}

async function register(call, username) {
  const res = await call('/api/register', { body: { username, password: 'password123' } });
  assert.equal(res.status, 201);
  return res.body.token;
}

test('Iran bounds include major cities and exclude neighbours', () => {
  const inside = {
    Tehran: [51.389, 35.689],
    Tabriz: [46.29, 38.08],
    Mashhad: [59.6, 36.3],
    Bandar_Abbas: [56.27, 27.18],
    Kish: [53.98, 26.53],
    Zahedan: [60.86, 29.5],
    Ahvaz: [48.67, 31.32],
    Rasht: [49.58, 37.28],
  };
  for (const [name, c] of Object.entries(inside)) assert.ok(isInsideIran(c), name);
  const outside = { Baghdad: [44.36, 33.31], Dubai: [55.27, 25.2], Baku: [49.87, 40.41], Kabul: [69.2, 34.55] };
  for (const [name, c] of Object.entries(outside)) assert.ok(!isInsideIran(c), name);
});

test('closing a loop claims territory', async () => {
  await withServer(async (call) => {
    const token = await register(call, 'ali');
    const res = await call('/api/activities', {
      token,
      body: { mode: 'run', points: squareLoop(35.7, 51.4, 0.005) },
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    // 0.005° square at this latitude is roughly 555 m × 450 m.
    assert.ok(res.body.gainedSqMeters > 200_000 && res.body.gainedSqMeters < 300_000);
    assert.deepEqual(res.body.captured, []);

    const map = await call('/api/territories?mode=run&bbox=51.3,35.6,51.5,35.8');
    assert.equal(map.body.features.length, 1);
    assert.equal(map.body.features[0].properties.username, 'ali');
    const rideMap = await call('/api/territories?mode=ride');
    assert.equal(rideMap.body.features.length, 0);
  });
});

test('overlapping loop steals area from a rival', async () => {
  await withServer(async (call) => {
    const ali = await register(call, 'ali');
    const sara = await register(call, 'sara');
    await call('/api/activities', { token: ali, body: { mode: 'run', points: squareLoop(35.7, 51.4, 0.005) } });

    // Sara's square overlaps the eastern half of Ali's.
    const res = await call('/api/activities', {
      token: sara,
      body: { mode: 'run', points: squareLoop(35.7, 51.4025, 0.005) },
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.captured.length, 1);
    assert.equal(res.body.captured[0].username, 'ali');
    const half = res.body.totalSqMeters / 2;
    assert.ok(Math.abs(res.body.captured[0].areaSqMeters - half) / half < 0.05);

    const board = await call('/api/leaderboard?mode=run');
    assert.deepEqual(board.body.map((r) => r.username), ['sara', 'ali']);
    const feed = await call('/api/feed?mode=run');
    assert.equal(feed.body[0].attacker, 'sara');
    assert.equal(feed.body[0].victim, 'ali');
  });
});

test('fully surrounded territory is removed', async () => {
  await withServer(async (call) => {
    const ali = await register(call, 'ali');
    const sara = await register(call, 'sara');
    await call('/api/activities', { token: ali, body: { mode: 'run', points: squareLoop(35.701, 51.401, 0.002) } });
    await call('/api/activities', { token: sara, body: { mode: 'run', points: squareLoop(35.7, 51.4, 0.005) } });
    const board = await call('/api/leaderboard?mode=run');
    assert.deepEqual(board.body.map((r) => r.username), ['sara']);
  });
});

test('rejects open loops, vehicle speeds, places outside Iran, and anonymous users', async () => {
  await withServer(async (call) => {
    const token = await register(call, 'ali');
    const open = squareLoop(35.7, 51.4, 0.005).slice(0, -12);
    let res = await call('/api/activities', { token, body: { mode: 'run', points: open } });
    assert.equal(res.body.code, 'not_closed');

    const fast = squareLoop(35.7, 51.4, 0.005).map((p, i) => ({ ...p, t: i * 1000 }));
    res = await call('/api/activities', { token, body: { mode: 'run', points: fast } });
    assert.equal(res.body.code, 'too_fast');

    res = await call('/api/activities', { token, body: { mode: 'run', points: squareLoop(25.2, 55.27, 0.005) } });
    assert.equal(res.body.code, 'outside_iran');

    res = await call('/api/activities', { body: { mode: 'run', points: squareLoop(35.7, 51.4, 0.005) } });
    assert.equal(res.status, 401);
  });
});

test('simulated activities are refused unless enabled', async () => {
  await withServer(
    async (call) => {
      const token = await register(call, 'ali');
      const res = await call('/api/activities', {
        token,
        body: { mode: 'run', simulated: true, points: squareLoop(35.7, 51.4, 0.005) },
      });
      assert.equal(res.status, 403);
    },
    { allowSimulation: false },
  );
});

test('figure-eight loops count both lobes', async () => {
  await withServer(async (call) => {
    const token = await register(call, 'ali');
    const s = 0.004;
    const corners = [
      [35.7, 51.4], [35.7 + s, 51.4 + s], [35.7 + s, 51.4 + 2 * s], [35.7, 51.4 + 2 * s],
      [35.7 + s, 51.4], [35.7, 51.4],
    ];
    const points = [];
    let t = 0;
    for (let i = 0; i < corners.length - 1; i++) {
      for (let k = 0; k < 10; k++) {
        const [a, b] = [corners[i], corners[i + 1]];
        points.push({ lat: a[0] + ((b[0] - a[0]) * k) / 10, lng: a[1] + ((b[1] - a[1]) * k) / 10, t });
        t += 60_000;
      }
    }
    points.push({ lat: 35.7, lng: 51.4, t });
    const res = await call('/api/activities', { token, body: { mode: 'run', points } });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.ok(res.body.gainedSqMeters > 100_000);
  });
});

test('loops that revisit a point keep only the enclosed area', () => {
  const { loopToPolygon, areaOf } = require('../server/territory');
  // Rectangle whose right half is cut by an out-and-back diagonal spur.
  const coords = [
    [51.4, 35.7], [51.405, 35.7], [51.41, 35.7], [51.41, 35.705], [51.405, 35.7],
    [51.405, 35.705], [51.4, 35.705], [51.4, 35.7],
  ];
  const rectangle = areaOf({ type: 'Polygon', coordinates: [[[51.4, 35.7], [51.41, 35.7], [51.41, 35.705], [51.4, 35.705], [51.4, 35.7]]] });
  const area = areaOf(loopToPolygon(coords).geometry);
  assert.ok(Math.abs(area - rectangle * 0.75) / area < 0.01);
});

test('login works and bad credentials fail', async () => {
  await withServer(async (call) => {
    await register(call, 'ali');
    let res = await call('/api/login', { body: { username: 'ALI', password: 'password123' } });
    assert.equal(res.status, 200);
    res = await call('/api/login', { body: { username: 'ali', password: 'wrong-pass' } });
    assert.equal(res.status, 401);
    res = await call('/api/register', { body: { username: 'علی_رضا', password: 'password123' } });
    assert.equal(res.status, 201);
  });
});
