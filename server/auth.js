'use strict';

const crypto = require('node:crypto');
const { httpError } = require('./util');

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const COOKIE_NAME = 'recall_session';
const COOKIE_MAX_AGE = 2592000; // 30 days, seconds

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

function verifyPassword(password, salt, expectedHashHex) {
  const actual = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(expectedHashHex, 'hex');
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

function createSession(db, userId) {
  const token = crypto.randomBytes(32).toString('hex'); // 64 hex chars
  const now = Date.now();
  db.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(token, userId, now, now + SESSION_TTL_MS);
  // Lazy cleanup of expired sessions.
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
  return token;
}

function deleteSession(db, token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

function sessionCookie(token) {
  return `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${COOKIE_MAX_AGE}`;
}

function clearSessionCookie() {
  return `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}

function sessionTokenFrom(req) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === COOKIE_NAME) return part.slice(eq + 1).trim();
  }
  return null;
}

// Returns the user row for a valid session, or null. Rolling 30-day expiry.
function getUserBySession(db, req) {
  const token = sessionTokenFrom(req);
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
  const session = db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
  if (!session) return null;
  const now = Date.now();
  if (session.expires_at < now) {
    deleteSession(db, token);
    return null;
  }
  db.prepare('UPDATE sessions SET expires_at = ? WHERE token = ?').run(now + SESSION_TTL_MS, token);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(session.user_id) || null;
}

// REGISTRATION_OPEN=false closes sign-ups outright — even on an empty
// database — so the .env value is the single source of truth.
function registrationAllowed() {
  return process.env.REGISTRATION_OPEN !== 'false';
}

function requireAuth(req) {
  if (!req.user) throw httpError(401, 'unauthorized');
}

module.exports = {
  COOKIE_NAME,
  hashPassword,
  verifyPassword,
  createSession,
  deleteSession,
  sessionCookie,
  clearSessionCookie,
  sessionTokenFrom,
  getUserBySession,
  registrationAllowed,
  requireAuth,
};
