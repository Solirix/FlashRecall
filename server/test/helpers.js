'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('../index');

async function boot() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-test-'));
  const { server, db } = createServer({ dataDir });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    server,
    db,
    base,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      db.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

// Minimal fetch wrapper with a manual cookie jar.
function client(base) {
  let cookie = null;
  const call = async function (method, p, body) {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (cookie) headers.Cookie = cookie;
    const res = await fetch(base + p, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* static/plain responses */ }
    return { status: res.status, data, text };
  };
  call.cookie = () => cookie;
  return call;
}

async function registerUser(call, username) {
  const res = await call('POST', '/api/register', { username, password: 'password123' });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  return res.data;
}

module.exports = { boot, client, registerUser };
