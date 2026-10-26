const crypto = require('node:crypto');

const KEY_LENGTH = 64;

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, KEY_LENGTH);
  return `${salt.toString('hex')}:${key.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [saltHex, keyHex] = stored.split(':');
  const expected = Buffer.from(keyHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), KEY_LENGTH);
  return crypto.timingSafeEqual(expected, actual);
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function createSession(db, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions (token_hash, user_id, created_at) VALUES (?, ?, ?)').run(
    hashToken(token),
    userId,
    Date.now(),
  );
  return token;
}

function userForToken(db, token) {
  if (!token) return null;
  return (
    db
      .prepare(
        `SELECT u.id, u.username, u.color FROM sessions s
         JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`,
      )
      .get(hashToken(token)) ?? null
  );
}

// Territory colours a player can pick; they read clearly on the night map.
const PALETTE = ['#2fd27a', '#e5484d', '#1f5bff', '#e8c22e', '#a442e0', '#aab4c8', '#ee6a1f', '#6cc3b6'];

function colorForUser(seed) {
  return PALETTE[seed % PALETTE.length];
}

module.exports = {
  hashPassword,
  verifyPassword,
  createSession,
  userForToken,
  hashToken,
  colorForUser,
  PALETTE,
};
