'use strict';

const test = require('node:test');
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
      await new Promise((resolve) => server.close(resolve));
      db.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

// Minimal fetch wrapper with a manual cookie jar.
function client(base) {
  let cookie = null;
  return async function call(method, p, body) {
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
}

async function registerUser(call, username) {
  const res = await call('POST', '/api/register', { username, password: 'password123' });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  return res.data;
}

test('register -> me, duplicate register 409, login wrong password 401', async () => {
  const app = await boot();
  try {
    const call = client(app.base);
    const me = await registerUser(call, 'alice');
    assert.equal(me.username, 'alice');
    assert.equal(me.settings.desiredRetention, 0.9);

    const meRes = await call('GET', '/api/me');
    assert.equal(meRes.status, 200);
    assert.equal(meRes.data.username, 'alice');

    // duplicate username
    const other = client(app.base);
    const dup = await other('POST', '/api/register', { username: 'alice', password: 'password123' });
    assert.equal(dup.status, 409);
    assert.ok(dup.data.error);

    // validation
    const bad = await other('POST', '/api/register', { username: 'x', password: 'password123' });
    assert.equal(bad.status, 400);

    // logout then wrong-password login
    await call('POST', '/api/logout');
    const noAuth = await call('GET', '/api/me');
    assert.equal(noAuth.status, 401);
    assert.equal(noAuth.data.error, 'unauthorized');

    const wrong = await call('POST', '/api/login', { username: 'alice', password: 'wrongpassword' });
    assert.equal(wrong.status, 401);
    const right = await call('POST', '/api/login', { username: 'alice', password: 'password123' });
    assert.equal(right.status, 200);
    assert.equal(right.data.username, 'alice');
  } finally {
    await app.close();
  }
});

test('decks, notes, queue, answer, undo, browse, stats', async () => {
  const app = await boot();
  try {
    const call = client(app.base);
    await registerUser(call, 'bob');

    // unauthenticated guard sanity: a fresh client gets 401 on API
    const anon = client(app.base);
    assert.equal((await anon('GET', '/api/decks/tree')).status, 401);

    // create deck -> tree shows it
    const deck = (await call('POST', '/api/decks', { name: 'Test Deck', color: '#7aa2f7' })).data;
    assert.ok(deck.id);
    let tree = (await call('GET', '/api/decks/tree')).data;
    assert.equal(tree.length, 1);
    assert.equal(tree[0].name, 'Test Deck');
    assert.deepEqual(tree[0].counts, { new: 0, learning: 0, review: 0, due: 0 });

    // basic note + cloze note with 2 clozes -> 3 cards
    const basic = await call('POST', '/api/notes', {
      deckId: deck.id, type: 'basic', front: 'Capital of France?', back: 'Paris', tags: 'geo',
    });
    assert.equal(basic.status, 201);
    assert.equal(basic.data.cards.length, 1);

    const cloze = await call('POST', '/api/notes', {
      deckId: deck.id, type: 'cloze',
      front: '{{c1::Paris}} is the capital of {{c2::France::country}}', tags: 'geo europe',
    });
    assert.equal(cloze.status, 201);
    assert.equal(cloze.data.cards.length, 2);

    const cardCount = app.db.prepare('SELECT COUNT(*) AS n FROM cards').get().n;
    assert.equal(cardCount, 3);

    // queue contains them with rendered cloze text
    const queue = (await call('GET', `/api/study/${deck.id}/queue`)).data;
    assert.equal(queue.total, 3);
    assert.deepEqual(queue.counts, { new: 3, learning: 0, review: 0 });
    assert.equal(queue.deck.name, 'Test Deck');
    const c1 = queue.cards.find((c) => c.type === 'cloze' && c.ord === 1);
    assert.equal(c1.front, '[…] is the capital of France');
    const c2 = queue.cards.find((c) => c.type === 'cloze' && c.ord === 2);
    assert.equal(c2.front, 'Paris is the capital of [country]');
    assert.ok(c1.previews.again && c1.previews.easy);

    // answer grade 3 -> scheduled + review row
    const card = queue.cards[0];
    const answer = await call('POST', '/api/study/answer', { cardId: card.id, grade: 3, durationMs: 4200 });
    assert.equal(answer.status, 200);
    assert.equal(answer.data.leech, false);
    assert.equal(answer.data.card.state, 'learning'); // grade 3 on a new card -> step 2
    assert.equal(answer.data.card.reps, 1);
    assert.ok(answer.data.card.due > Date.now());
    const reviewCount = app.db.prepare('SELECT COUNT(*) AS n FROM reviews').get().n;
    assert.equal(reviewCount, 1);
    const review = app.db.prepare('SELECT * FROM reviews').get();
    assert.equal(review.grade, 3);
    assert.equal(review.duration_ms, 4200);
    assert.equal(review.state_before, 'new');

    // bad grade rejected
    assert.equal((await call('POST', '/api/study/answer', { cardId: card.id, grade: 7 })).status, 400);

    // undo restores the card and removes the review row
    const undo = await call('POST', '/api/study/undo');
    assert.equal(undo.status, 200);
    assert.equal(undo.data.card.state, 'new');
    assert.equal(undo.data.card.reps, 0);
    assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM reviews').get().n, 0);
    assert.equal((await call('POST', '/api/study/undo')).status, 400);

    // browse query language
    const browse = await call('GET', `/api/browse?q=${encodeURIComponent('deck:"Test Deck" is:new')}`);
    assert.equal(browse.status, 200);
    assert.equal(browse.data.total, 2);
    assert.ok(browse.data.notes.every((n) => n.deckName === 'Test Deck'));
    const browseNeg = await call('GET', `/api/browse?q=${encodeURIComponent('deck:"Test Deck" -is:new')}`);
    assert.equal(browseNeg.data.total, 0);
    const browseWord = await call('GET', `/api/browse?q=${encodeURIComponent('capital')}`);
    assert.ok(browseWord.data.total >= 1);
    const browseTag = await call('GET', `/api/browse?q=${encodeURIComponent('tag:europe')}`);
    assert.equal(browseTag.data.total, 1);

    // note patch re-syncs cloze cards
    const clozeId = cloze.data.id;
    const patched = await call('PATCH', `/api/notes/${clozeId}`, {
      front: '{{c1::Paris}} is the capital of {{c2::France}} and {{c3::Europe}}',
    });
    assert.equal(patched.status, 200);
    assert.equal(patched.data.cards.length, 3);
    const patchedBack = await call('PATCH', `/api/notes/${clozeId}`, { front: '{{c1::Paris}} only' });
    assert.equal(patchedBack.data.cards.length, 1);

    // suspend/flag/bury endpoints
    assert.equal((await call('POST', `/api/notes/${basic.data.id}/suspend`, { suspended: true })).status, 200);
    assert.equal((await call('POST', `/api/notes/${basic.data.id}/suspend`, { suspended: false })).status, 200);
    assert.equal((await call('POST', `/api/notes/${basic.data.id}/flag`, { flagged: true })).status, 200);
    assert.equal((await call('POST', `/api/notes/${basic.data.id}/bury`)).status, 200);

    // stats summary shape
    const stats = await call('GET', `/api/stats/summary?deckId=${deck.id}&rangeDays=30`);
    assert.equal(stats.status, 200);
    for (const key of ['dueToday', 'newToday', 'retention30d', 'totalReviews', 'avgAnswerMs',
                       'studiedMsWeek', 'streakDays', 'bestStreak', 'heatmap', 'forecast',
                       'cardStates', 'retentionByGrade', 'fsrs']) {
      assert.ok(key in stats.data, `missing stats key ${key}`);
    }
    assert.equal(stats.data.heatmap.length, 30);
    assert.equal(stats.data.forecast.length, 30);
    assert.deepEqual(Object.keys(stats.data.cardStates), ['new', 'learning', 'young', 'mature']);
    assert.equal(stats.data.fsrs.desiredRetention, 0.9);

    // deck patch + delete
    const renamed = await call('PATCH', `/api/decks/${deck.id}`, { name: 'Renamed' });
    assert.equal(renamed.data.name, 'Renamed');
    const del = await call('DELETE', `/api/decks/${deck.id}`);
    assert.equal(del.status, 200);
    tree = (await call('GET', '/api/decks/tree')).data;
    assert.equal(tree.length, 0);
    assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM notes').get().n, 0);
    assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM cards').get().n, 0);
  } finally {
    await app.close();
  }
});

test('second user cannot see first user\'s deck (404)', async () => {
  const app = await boot();
  try {
    const a = client(app.base);
    const b = client(app.base);
    await registerUser(a, 'carol');
    await registerUser(b, 'dave');
    const deck = (await a('POST', '/api/decks', { name: 'Private' })).data;
    const note = (await a('POST', '/api/notes', { deckId: deck.id, type: 'basic', front: 'q', back: 'a' })).data;

    assert.equal((await b('GET', `/api/study/${deck.id}/queue`)).status, 404);
    assert.equal((await b('GET', `/api/notes/${note.id}`)).status, 404);
    assert.equal((await b('PATCH', `/api/decks/${deck.id}`, { name: 'hijack' })).status, 404);
    assert.equal((await b('DELETE', `/api/decks/${deck.id}`)).status, 404);
    assert.equal((await b('GET', `/api/stats/summary?deckId=${deck.id}`)).status, 404);
    const tree = (await b('GET', '/api/decks/tree')).data;
    assert.equal(tree.length, 0);
  } finally {
    await app.close();
  }
});

test('share flow: A shares to B, B accepts, gets fresh copy', async () => {
  const app = await boot();
  try {
    const a = client(app.base);
    const b = client(app.base);
    await registerUser(a, 'erin');
    await registerUser(b, 'frank');

    const deck = (await a('POST', '/api/decks', { name: 'Shared Deck' })).data;
    await a('POST', '/api/notes', { deckId: deck.id, type: 'basic', front: 'q1', back: 'a1' });
    await a('POST', '/api/notes', {
      deckId: deck.id, type: 'cloze', front: '{{c1::x}} and {{c2::y}}',
    });

    // sharing with self -> 400, unknown user -> 404
    assert.equal((await a('POST', '/api/shares', { deckId: deck.id, toUsername: 'erin' })).status, 400);
    assert.equal((await a('POST', '/api/shares', { deckId: deck.id, toUsername: 'ghost' })).status, 404);

    const share = await a('POST', '/api/shares', { deckId: deck.id, toUsername: 'frank' });
    assert.equal(share.status, 201);
    assert.equal(share.data.deckName, 'Shared Deck');
    assert.equal(share.data.fromUsername, 'erin');

    // duplicate pending share -> 409
    assert.equal((await a('POST', '/api/shares', { deckId: deck.id, toUsername: 'frank' })).status, 409);

    // B inbox shows the share; A cannot accept it
    const inbox = await b('GET', '/api/shares');
    assert.equal(inbox.data.incoming.length, 1);
    assert.equal(inbox.data.incoming[0].deckName, 'Shared Deck');
    assert.equal(inbox.data.incoming[0].fromUsername, 'erin');
    assert.equal((await a('POST', `/api/shares/${share.data.id}/accept`)).status, 404);

    // B accepts -> copy with fresh new cards
    const accepted = await b('POST', `/api/shares/${share.data.id}/accept`);
    assert.equal(accepted.status, 200);
    assert.equal(accepted.data.deckName, 'Shared Deck'); // no name collision for frank
    assert.equal(accepted.data.notes, 2);
    assert.equal(accepted.data.cards, 3);

    const bTree = (await b('GET', '/api/decks/tree')).data;
    assert.equal(bTree.length, 1);
    const bQueue = (await b('GET', `/api/study/${accepted.data.deckId}/queue`)).data;
    assert.equal(bQueue.total, 3);
    assert.ok(bQueue.cards.every((c) => c.state === 'new'));

    // original owner untouched
    const aQueue = (await a('GET', `/api/study/${deck.id}/queue`)).data;
    assert.equal(aQueue.total, 3);

    // accepting twice rejected
    assert.equal((await b('POST', `/api/shares/${share.data.id}/accept`)).status, 400);

    // sent list shows accepted status
    const sent = await a('GET', '/api/shares');
    assert.equal(sent.data.sent.length, 1);
    assert.equal(sent.data.sent[0].status, 'accepted');
  } finally {
    await app.close();
  }
});

test('share name collision gets suffixed; decline works', async () => {
  const app = await boot();
  try {
    const a = client(app.base);
    const b = client(app.base);
    await registerUser(a, 'gwen');
    await registerUser(b, 'hank');
    const deck = (await a('POST', '/api/decks', { name: 'Dup' })).data;
    await a('POST', '/api/notes', { deckId: deck.id, type: 'basic', front: 'q', back: 'a' });
    await b('POST', '/api/decks', { name: 'Dup' }); // hank already has a deck named Dup

    const s1 = (await a('POST', '/api/shares', { deckId: deck.id, toUsername: 'hank' })).data;
    const accepted = await b('POST', `/api/shares/${s1.id}/accept`);
    assert.equal(accepted.data.deckName, 'Dup (from gwen)');

    // a second share can be declined
    const s2 = (await a('POST', '/api/shares', { deckId: deck.id, toUsername: 'hank' })).data;
    const declined = await b('POST', `/api/shares/${s2.id}/decline`);
    assert.equal(declined.status, 200);
    assert.equal((await b('GET', '/api/shares')).data.incoming.length, 0);
  } finally {
    await app.close();
  }
});

test('settings validation and account update', async () => {
  const app = await boot();
  try {
    const call = client(app.base);
    await registerUser(call, 'ivy');

    const defaults = await call('GET', '/api/settings');
    assert.equal(defaults.data.theme, 'recall-dark');
    assert.equal(defaults.data.desiredRetention, 0.9);

    assert.equal((await call('PUT', '/api/settings', { desiredRetention: 0.5 })).status, 400);
    assert.equal((await call('PUT', '/api/settings', { desiredRetention: 0.98 })).status, 400);
    assert.equal((await call('PUT', '/api/settings', { accent: 'blue' })).status, 400);
    assert.equal((await call('PUT', '/api/settings', { fontSize: 30 })).status, 400);
    assert.equal((await call('PUT', '/api/settings', { leechThreshold: 2 })).status, 400);

    const ok = await call('PUT', '/api/settings', { desiredRetention: 0.95, accent: '#a1b2c3', fontSize: 18 });
    assert.equal(ok.status, 200);
    assert.equal(ok.data.desiredRetention, 0.95);
    assert.equal((await call('GET', '/api/settings')).data.accent, '#a1b2c3');

    // PATCH /api/me
    const me = await call('PATCH', '/api/me', { displayName: 'Ivy L.' });
    assert.equal(me.data.displayName, 'Ivy L.');
    assert.equal((await call('PATCH', '/api/me', { newPassword: 'newpassword1' })).status, 401);
    const pw = await call('PATCH', '/api/me', { currentPassword: 'password123', newPassword: 'newpassword1' });
    assert.equal(pw.status, 200);
    const relogin = await call('POST', '/api/login', { username: 'ivy', password: 'newpassword1' });
    assert.equal(relogin.status, 200);
  } finally {
    await app.close();
  }
});

test('static serving and security headers', async () => {
  const app = await boot();
  try {
    const res = await fetch(`${app.base}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.equal(res.headers.get('referrer-policy'), 'same-origin');
    assert.equal(res.headers.get('cache-control'), 'no-cache');
    const body = await res.text();
    assert.match(body, /FlashRecall/);

    const notFound = await fetch(`${app.base}/nope.js`);
    assert.equal(notFound.status, 404);

    const traversal = await fetch(`${app.base}/../server/index.js`);
    assert.ok([403, 404].includes(traversal.status));
  } finally {
    await app.close();
  }
});
