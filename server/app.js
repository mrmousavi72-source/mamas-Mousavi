const path = require('node:path');
const express = require('express');
const { transaction } = require('./db');
const auth = require('./auth');
const territory = require('./territory');

const USERNAME_PATTERN = /^[\p{L}\p{N}_.-]{3,24}$/u;

function createApp(db, { allowSimulation = false } = {}) {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  const publicDir = path.join(__dirname, '..', 'public');
  const modules = path.join(__dirname, '..', 'node_modules');
  app.use(express.static(publicDir));
  app.use('/vendor/leaflet', express.static(path.join(modules, 'leaflet', 'dist')));
  app.use('/vendor/vazirmatn', express.static(path.join(modules, 'vazirmatn')));

  function requireUser(req, res, next) {
    const header = req.get('authorization') ?? '';
    const user = auth.userForToken(db, header.replace(/^Bearer\s+/i, ''));
    if (!user) return res.status(401).json({ error: 'ابتدا وارد شوید.' });
    req.user = user;
    next();
  }

  function parseMode(value) {
    return territory.MODES.includes(value) ? value : 'run';
  }

  app.get('/api/config', (req, res) => {
    res.json({
      allowSimulation,
      rules: {
        closeDistanceMeters: territory.RULES.closeDistanceMeters,
        minAreaSqMeters: territory.RULES.minAreaSqMeters,
      },
    });
  });

  app.post('/api/register', (req, res) => {
    const { username, password } = req.body ?? {};
    if (typeof username !== 'string' || !USERNAME_PATTERN.test(username)) {
      return res.status(400).json({ error: 'نام کاربری باید ۳ تا ۲۴ حرف یا عدد باشد.' });
    }
    if (typeof password !== 'string' || password.length < 8) {
      return res.status(400).json({ error: 'رمز عبور باید حداقل ۸ کاراکتر باشد.' });
    }
    if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) {
      return res.status(409).json({ error: 'این نام کاربری قبلاً ثبت شده است.' });
    }
    const count = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
    const color = auth.colorForUser(count + 1);
    const { lastInsertRowid } = db
      .prepare('INSERT INTO users (username, password_hash, color, created_at) VALUES (?, ?, ?, ?)')
      .run(username, auth.hashPassword(password), color, Date.now());
    const id = Number(lastInsertRowid);
    res.status(201).json({ token: auth.createSession(db, id), user: { id, username, color } });
  });

  app.post('/api/login', (req, res) => {
    const { username, password } = req.body ?? {};
    const row =
      typeof username === 'string'
        ? db.prepare('SELECT * FROM users WHERE username = ?').get(username)
        : null;
    if (!row || typeof password !== 'string' || !auth.verifyPassword(password, row.password_hash)) {
      return res.status(401).json({ error: 'نام کاربری یا رمز عبور اشتباه است.' });
    }
    res.json({
      token: auth.createSession(db, row.id),
      user: { id: row.id, username: row.username, color: row.color },
    });
  });

  app.post('/api/logout', requireUser, (req, res) => {
    const token = req.get('authorization').replace(/^Bearer\s+/i, '');
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(auth.hashToken(token));
    res.json({ ok: true });
  });

  app.get('/api/me', requireUser, (req, res) => {
    const stats = db
      .prepare(
        `SELECT mode, COUNT(*) AS activities, SUM(distance) AS distance
         FROM activities WHERE user_id = ? GROUP BY mode`,
      )
      .all(req.user.id);
    const held = db.prepare('SELECT mode, area FROM territories WHERE user_id = ?').all(req.user.id);
    res.json({ user: req.user, stats, held });
  });

  // Territories intersecting the visible map area.
  app.get('/api/territories', (req, res) => {
    const mode = parseMode(req.query.mode);
    const [w, s, e, n] = String(req.query.bbox ?? '')
      .split(',')
      .map(Number);
    const hasBbox = [w, s, e, n].every(Number.isFinite);
    const rows = hasBbox
      ? db
          .prepare(
            `SELECT t.*, u.username, u.color FROM territories t JOIN users u ON u.id = t.user_id
             WHERE t.mode = ? AND t.max_lng >= ? AND t.min_lng <= ? AND t.max_lat >= ? AND t.min_lat <= ?`,
          )
          .all(mode, w, e, s, n)
      : db
          .prepare(
            `SELECT t.*, u.username, u.color FROM territories t JOIN users u ON u.id = t.user_id
             WHERE t.mode = ?`,
          )
          .all(mode);
    res.json({
      type: 'FeatureCollection',
      features: rows.map((r) => ({
        type: 'Feature',
        geometry: JSON.parse(r.geometry),
        properties: { userId: r.user_id, username: r.username, color: r.color, area: r.area },
      })),
    });
  });

  app.post('/api/activities', requireUser, (req, res) => {
    const { mode, points, simulated } = req.body ?? {};
    if (simulated && !allowSimulation) {
      return res.status(403).json({ error: 'حالت آزمایشی روی این سرور غیرفعال است.' });
    }

    let claim;
    let coords;
    try {
      coords = territory.validateTrack(points, mode);
      claim = territory.loopToPolygon(coords);
    } catch (err) {
      if (err instanceof territory.ClaimError) {
        return res.status(422).json({ error: err.message, code: err.code });
      }
      throw err;
    }

    const now = Date.now();
    const result = transaction(db, () => {
      const [w, s, e, n] = territory.bboxOf(claim.geometry);
      const own = db
        .prepare('SELECT geometry FROM territories WHERE user_id = ? AND mode = ?')
        .get(req.user.id, mode);
      const rivals = db
        .prepare(
          `SELECT user_id, geometry FROM territories
           WHERE mode = ? AND user_id != ? AND max_lng >= ? AND min_lng <= ? AND max_lat >= ? AND min_lat <= ?`,
        )
        .all(mode, req.user.id, w, e, s, n)
        .map((r) => ({ userId: r.user_id, geometry: JSON.parse(r.geometry) }));

      const ownBefore = own ? territory.areaOf(JSON.parse(own.geometry)) : 0;
      const { geometry, losses } = territory.resolveCapture(
        claim,
        own ? JSON.parse(own.geometry) : null,
        rivals,
      );
      const gained = territory.areaOf(geometry) - ownBefore;

      const activity = db
        .prepare(
          `INSERT INTO activities (user_id, mode, distance, duration_ms, claimed_area, simulated, track, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          req.user.id,
          mode,
          territory.trackLengthMeters(coords),
          points[points.length - 1].t - points[0].t,
          gained,
          simulated ? 1 : 0,
          JSON.stringify(coords),
          now,
        );
      const activityId = Number(activity.lastInsertRowid);

      saveTerritory(req.user.id, mode, geometry, now);
      const insertCapture = db.prepare(
        `INSERT INTO captures (activity_id, attacker_id, victim_id, mode, area, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      for (const loss of losses) {
        saveTerritory(loss.userId, mode, loss.geometry, now);
        insertCapture.run(activityId, req.user.id, loss.userId, mode, loss.takenSqMeters, now);
      }

      const names = db.prepare('SELECT username FROM users WHERE id = ?');
      return {
        activityId,
        gainedSqMeters: gained,
        totalSqMeters: territory.areaOf(geometry),
        captured: losses.map((l) => ({
          username: names.get(l.userId).username,
          areaSqMeters: l.takenSqMeters,
        })),
      };
    });
    res.status(201).json(result);
  });

  function saveTerritory(userId, mode, geometry, now) {
    if (!geometry) {
      db.prepare('DELETE FROM territories WHERE user_id = ? AND mode = ?').run(userId, mode);
      return;
    }
    const [w, s, e, n] = territory.bboxOf(geometry);
    db.prepare(
      `INSERT INTO territories (user_id, mode, geometry, area, min_lng, min_lat, max_lng, max_lat, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id, mode) DO UPDATE SET geometry = excluded.geometry, area = excluded.area,
         min_lng = excluded.min_lng, min_lat = excluded.min_lat, max_lng = excluded.max_lng,
         max_lat = excluded.max_lat, updated_at = excluded.updated_at`,
    ).run(userId, mode, JSON.stringify(geometry), territory.areaOf(geometry), w, s, e, n, now);
  }

  app.get('/api/leaderboard', (req, res) => {
    const mode = parseMode(req.query.mode);
    const rows = db
      .prepare(
        `SELECT u.id, u.username, u.color, t.area FROM territories t JOIN users u ON u.id = t.user_id
         WHERE t.mode = ? ORDER BY t.area DESC LIMIT 50`,
      )
      .all(mode);
    res.json(rows);
  });

  app.get('/api/feed', (req, res) => {
    const mode = parseMode(req.query.mode);
    const rows = db
      .prepare(
        `SELECT c.area, c.created_at, a.username AS attacker, v.username AS victim
         FROM captures c JOIN users a ON a.id = c.attacker_id JOIN users v ON v.id = c.victim_id
         WHERE c.mode = ? ORDER BY c.created_at DESC LIMIT 30`,
      )
      .all(mode);
    res.json(rows);
  });

  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ error: 'خطای داخلی سرور.' });
  });

  return app;
}

module.exports = { createApp };
