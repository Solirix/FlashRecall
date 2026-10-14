'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const { openDatabase } = require('./db');
const { Router } = require('./router');
const { json, badRequest, httpError } = require('./util');
const auth = require('./auth');
const { meJson } = require('./routes/settings');

const PUBLIC_ROOT = path.join(__dirname, '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.map': 'application/json',
};

const USERNAME_RE = /^[a-zA-Z0-9_-]{3,32}$/;

function setSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
}

function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    res.end();
    return;
  }
  const rel = pathname === '/' ? '/index.html' : pathname;
  let filePath;
  try {
    filePath = path.resolve(PUBLIC_ROOT, '.' + decodeURIComponent(rel));
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bad request');
    return;
  }
  if (!filePath.startsWith(PUBLIC_ROOT + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'max-age=3600',
      'Content-Length': data.length,
    });
    if (req.method === 'HEAD') res.end();
    else res.end(data);
  });
}

function registerAuthRoutes(router, db) {
  router.post('/api/register', (req, res, params, body) => {
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    if (!USERNAME_RE.test(username)) {
      throw badRequest('username must be 3-32 chars of letters, digits, _ or -');
    }
    if (typeof body.password !== 'string' || body.password.length < 8) {
      throw badRequest('password must be at least 8 chars');
    }
    const displayName = typeof body.displayName === 'string' && body.displayName.trim()
      ? body.displayName.trim().slice(0, 64)
      : null;
    if (!auth.registrationAllowed(db)) {
      throw httpError(403, 'registration is closed');
    }
    const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
    if (existing) {
      throw httpError(409, 'username is taken');
    }
    const { salt, hash } = auth.hashPassword(body.password);
    const now = Date.now();
    const info = db.prepare('INSERT INTO users (username, pass_hash, salt, display_name, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(username, hash, salt, displayName, now);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(info.lastInsertRowid));
    const token = auth.createSession(db, user.id);
    res.setHeader('Set-Cookie', auth.sessionCookie(token));
    json(res, meJson(user), 201);
  });

  router.post('/api/login', (req, res, params, body) => {
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!user || !auth.verifyPassword(password, user.salt, user.pass_hash)) {
      throw httpError(401, 'invalid credentials');
    }
    const token = auth.createSession(db, user.id);
    res.setHeader('Set-Cookie', auth.sessionCookie(token));
    json(res, meJson(user));
  });

  router.post('/api/logout', (req, res) => {
    auth.deleteSession(db, auth.sessionTokenFrom(req));
    res.setHeader('Set-Cookie', auth.clearSessionCookie());
    json(res, { ok: true });
  });

  router.get('/api/me', (req, res) => {
    json(res, meJson(req.user));
  });
}

function createServer({ dataDir } = {}) {
  const db = openDatabase(dataDir);
  const router = new Router();
  const ctx = { undoStacks: new Map() };

  registerAuthRoutes(router, db);
  require('./routes/decks')(router, db);
  require('./routes/notes')(router, db);
  require('./routes/study')(router, db, ctx);
  require('./routes/stats')(router, db);
  require('./routes/shares')(router, db);
  require('./routes/settings')(router, db);

  const publicPaths = new Set(['/api/register', '/api/login']);

  const server = http.createServer((req, res) => {
    // Defense in depth: no handler rejection may crash the process.
    handleRequest(req, res).catch((err) => {
      console.error('Unhandled request error:', err);
      try {
        if (!res.headersSent) json(res, { error: 'internal server error' }, 500);
        else if (!res.writableEnded) res.end();
      } catch {
        // socket already gone
      }
    });
  });

  return { server, db };

  async function handleRequest(req, res) {
    setSecurityHeaders(res);
    let pathname;
    try {
      const url = new URL(req.url, 'http://localhost');
      pathname = url.pathname;
      req.query = url.searchParams;
    } catch {
      json(res, { error: 'bad request' }, 400);
      return;
    }

    if (pathname.startsWith('/api/')) {
      if (!publicPaths.has(pathname)) {
        const user = auth.getUserBySession(db, req);
        if (!user) {
          json(res, { error: 'unauthorized' }, 401);
          return;
        }
        req.user = user;
        req.sessionToken = auth.sessionTokenFrom(req);
      }
      const handled = await router.dispatch(req, res, pathname);
      if (!handled) json(res, { error: 'not found' }, 404);
      return;
    }

    serveStatic(req, res, pathname);
  }
}

if (require.main === module) {
  const { server, db } = createServer({});
  const port = Number(process.env.PORT) || 3000;
  server.listen(port, () => {
    console.log(`FlashRecall listening on http://localhost:${port}`);
  });
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    server.close(() => {
      db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

module.exports = { createServer };
