const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  color TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);
-- One merged territory per player per mode (run and ride are separate maps).
CREATE TABLE IF NOT EXISTS territories (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mode TEXT NOT NULL,
  geometry TEXT NOT NULL,
  area REAL NOT NULL,
  min_lng REAL NOT NULL, min_lat REAL NOT NULL,
  max_lng REAL NOT NULL, max_lat REAL NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, mode)
);
CREATE TABLE IF NOT EXISTS activities (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mode TEXT NOT NULL,
  distance REAL NOT NULL,
  duration_ms INTEGER NOT NULL,
  claimed_area REAL NOT NULL,
  simulated INTEGER NOT NULL DEFAULT 0,
  track TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS captures (
  id INTEGER PRIMARY KEY,
  activity_id INTEGER NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  attacker_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  victim_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mode TEXT NOT NULL,
  area REAL NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS territories_bbox ON territories (mode, min_lng, max_lng, min_lat, max_lat);
CREATE INDEX IF NOT EXISTS activities_user ON activities (user_id, created_at);
CREATE INDEX IF NOT EXISTS captures_time ON captures (created_at);
`;

function openDatabase(path) {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  // Databases created before activities had a title and note.
  const columns = db.prepare('PRAGMA table_info(activities)').all().map((c) => c.name);
  for (const name of ['title', 'note']) {
    if (!columns.includes(name)) db.exec(`ALTER TABLE activities ADD COLUMN ${name} TEXT NOT NULL DEFAULT ''`);
  }
  return db;
}

function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

module.exports = { openDatabase, transaction };
