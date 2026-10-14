'use strict';

const DAY_MS = 24 * 60 * 60 * 1000;

const DEFAULT_SETTINGS = {
  theme: 'recall-dark',
  accent: null,
  fontSize: 16,
  borderRadius: 12,
  reducedMotion: false,
  desiredRetention: 0.90,
  newPerDayDefault: 20,
  reviewCap: 9999,
  leechThreshold: 8,
};

function json(res, obj, status = 200) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function httpError(status, message) {
  return { status, message };
}

function badRequest(message) {
  return httpError(400, message);
}

function notFound(message = 'not found') {
  return httpError(404, message);
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    // Reject upfront when Content-Length already exceeds the limit.
    const contentLength = Number(req.headers['content-length']);
    if (Number.isFinite(contentLength) && contentLength > limit) {
      settled = true;
      req.resume(); // drain without destroying the socket
      reject(httpError(413, 'request body too large'));
      return;
    }
    req.on('data', (chunk) => {
      if (settled) return; // keep draining; response flushes normally
      size += chunk.length;
      if (size > limit) {
        settled = true;
        reject(httpError(413, 'request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!settled) resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (err) => {
      if (!settled) reject(err);
    });
  });
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function isNonEmptyString(v, max = 1000) {
  return typeof v === 'string' && v.trim().length > 0 && v.length <= max;
}

function intInRange(v, min, max) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) return null;
  return n;
}

function clampInt(v, fallback, min, max) {
  if (v == null || v === '') return fallback;
  const n = Number(v);
  if (!Number.isInteger(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function startOfDay(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function dayKey(ms) {
  const d = new Date(ms);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

function mergeSettings(user) {
  let stored = {};
  try {
    stored = JSON.parse(user.settings_json || '{}');
  } catch {
    stored = {};
  }
  return { ...DEFAULT_SETTINGS, ...stored };
}

// Matches {{cN::text}} and {{cN::text::hint}}; returns sorted distinct indices.
function parseClozeOrds(text) {
  const re = /\{\{c(\d+)::([^}]*?)\}\}/g;
  const ords = new Set();
  let m;
  while ((m = re.exec(text || ''))) {
    const n = parseInt(m[1], 10);
    if (n > 0) ords.add(n);
  }
  return [...ords].sort((a, b) => a - b);
}

// side 'front': active ord becomes […] or [hint], other ords show their text.
// side 'back': all markers stripped, text shown.
function renderCloze(text, ord, side) {
  return String(text || '').replace(/\{\{c(\d+)::([^}]*?)\}\}/g, (match, n, inner) => {
    const sep = inner.indexOf('::');
    const clozeText = sep === -1 ? inner : inner.slice(0, sep);
    const hint = sep === -1 ? null : inner.slice(sep + 2);
    if (side === 'front' && parseInt(n, 10) === ord) {
      return hint ? `[${hint}]` : '[…]';
    }
    if (side === 'reveal' && parseInt(n, 10) === ord) return `**${clozeText}**`;
    return clozeText;
  });
}

module.exports = {
  DAY_MS,
  DEFAULT_SETTINGS,
  json,
  httpError,
  badRequest,
  notFound,
  readBody,
  escapeHtml,
  isNonEmptyString,
  intInRange,
  clampInt,
  startOfDay,
  dayKey,
  mergeSettings,
  parseClozeOrds,
  renderCloze,
};
