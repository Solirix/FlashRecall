'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { boot, client, registerUser } = require('./helpers');
const { openDatabase } = require('../db');
const { seedCollection } = require('../bench/seed');

const enc = encodeURIComponent;
const indexedCount = (db) => db.prepare('SELECT COUNT(*) AS n FROM notes_fts').get().n;
const noteCount = (db) => db.prepare('SELECT COUNT(*) AS n FROM notes').get().n;

async function setup(app, username = 'sam') {
  const call = client(app.base);
  await registerUser(call, username);
  const deck = (await call('POST', '/api/decks', { name: 'Geography' })).data;
  const sub = (await call('POST', '/api/decks', { name: 'Capitals', parentId: deck.id })).data;
  const add = async (body) => (await call('POST', '/api/notes', { deckId: sub.id, type: 'basic', ...body })).data;
  return { call, deck, sub, add };
}

test('search: typos, accents, cloze text, extra, tags, ranking', async () => {
  const app = await boot();
  try {
    const { call, add } = await setup(app);
    const capital = await add({ front: 'Capital of **France**?', back: 'Paris', tags: 'europe' });
    const cafe = await add({ front: 'Where to get a café crème', back: 'Le Marais' });
    const cloze = await add({ type: 'cloze', front: '{{c1::Canberra::city}} is in Australia' });
    const extra = await add({ front: 'Longest river', back: 'Nile', extra: 'mnemonic: crocodile smile' });
    await add({ front: 'Capitalism basics', back: 'markets' });

    const q = async (s) => (await call('GET', `/api/search?q=${enc(s)}`)).data;

    // exact substring beats fuzzy; markdown stripped from titles
    let r = await q('capital');
    assert.equal(r.notes[0].id, capital.id);
    assert.equal(r.notes[0].title, 'Capital of France?');
    assert.deepEqual(r.notes[0].titleMatches, [[0, 7]]);

    // typo tolerance
    r = await q('capitl');
    assert.ok(r.notes.some((n) => n.id === capital.id), 'capitl finds Capital');
    r = await q('austrlia');
    assert.ok(r.notes.some((n) => n.id === cloze.id), 'typo inside cloze note');

    // accents both ways, highlight mapped to the original string
    r = await q('cafe creme');
    assert.equal(r.notes[0].id, cafe.id);
    assert.deepEqual(r.notes[0].titleMatches, [[15, 19], [20, 25]]);

    // cloze answer text is searchable, hint is not
    assert.ok((await q('canberra')).notes.some((n) => n.id === cloze.id));
    assert.ok(!(await q('city')).notes.some((n) => n.id === cloze.id));

    // extra field and tags
    assert.equal((await q('crocodile')).notes[0].id, extra.id);
    r = await q('europ');
    assert.ok(r.notes.some((n) => n.id === capital.id));
    assert.deepEqual(r.tags.map((t) => t.name), ['europe']);

    // short words fall back to LIKE; garbage finds nothing
    assert.ok((await q('ni')).notes.some((n) => n.id === extra.id));
    assert.equal((await q('qqqzzzxx')).notes.length, 0);
    assert.equal(typeof r.tookMs, 'number');
  } finally {
    await app.close();
  }
});

test('browse: filters compile to SQL, deck includes sub-decks, paging', async () => {
  const app = await boot();
  try {
    const { call, deck, add } = await setup(app);
    const top = (await call('POST', '/api/notes', { deckId: deck.id, front: 'Top-level river', back: 'x' })).data;
    for (let i = 0; i < 5; i++) await add({ front: `River ${i}`, back: 'y', tags: i % 2 ? 'odd' : 'even' });

    const b = async (s, extra = '') => (await call('GET', `/api/browse?q=${enc(s)}${extra}`)).data;
    assert.equal((await b('deck:geography')).total, 6, 'parent deck includes sub-deck notes');
    assert.equal((await b('deck:Capitals')).total, 5);
    assert.equal((await b('tag:odd')).total, 2);
    assert.equal((await b('river -tag:odd')).total, 4);
    assert.equal((await b('river -deck:capitals')).notes[0].id, top.id);
    assert.equal((await b('is:new river')).total, 6);
    assert.equal((await b('is:bogus')).total, 0);

    const page1 = await b('', '&limit=4');
    const page2 = await b('', '&limit=4&offset=4');
    assert.equal(page1.total, 6);
    assert.equal(page1.notes.length, 4);
    assert.equal(page2.notes.length, 2);
    assert.ok(!page2.notes.some((n) => page1.notes.find((m) => m.id === n.id)));
  } finally {
    await app.close();
  }
});

test('search is scoped per user', async () => {
  const app = await boot();
  try {
    const a = await setup(app, 'alpha');
    const b = await setup(app, 'bravo');
    await a.add({ front: 'secret walrus fact', back: 'tusks', tags: 'walrus' });
    const r = (await b.call('GET', '/api/search?q=walrus')).data;
    assert.equal(r.notes.length, 0);
    assert.equal(r.tags.length, 0);
    assert.equal((await b.call('GET', '/api/browse?q=walrus')).data.total, 0);
    assert.equal((await a.call('GET', '/api/browse?q=walrus')).data.total, 1);
  } finally {
    await app.close();
  }
});

test('index stays consistent through edits, deletes, shares and leech tagging', async () => {
  const app = await boot();
  try {
    const { call, sub, add } = await setup(app, 'carol');
    const hits = async (s) => (await call('GET', `/api/browse?q=${enc(s)}`)).data.total;

    const n = await add({ front: 'zebra stripes', back: 'camouflage' });
    assert.equal(await hits('zebra'), 1);
    await call('PATCH', `/api/notes/${n.id}`, { front: 'okapi stripes' });
    assert.equal(await hits('zebra'), 0);
    assert.equal(await hits('okapi'), 1);
    await call('DELETE', `/api/notes/${n.id}`);
    assert.equal(await hits('okapi'), 0);
    assert.equal(indexedCount(app.db), noteCount(app.db));

    // leech tag added by the scheduler is searchable
    const l = await add({ front: 'leechy card', back: 'hard' });
    const card = app.db.prepare('SELECT * FROM cards WHERE note_id = ?').get(l.id);
    app.db.prepare("UPDATE cards SET state = 'review', lapses = 50, due = 0, stability = 1, difficulty = 5, reps = 60 WHERE id = ?").run(card.id);
    const ans = await call('POST', '/api/study/answer', { cardId: card.id, grade: 1, durationMs: 1000 });
    assert.equal(ans.data.leech, true);
    assert.equal(await hits('tag:leech leechy'), 1);
    assert.ok((await call('GET', '/api/search?q=leech')).data.tags.some((t) => t.name === 'leech'));

    // share accept indexes the recipient's copies
    const other = client(app.base);
    await registerUser(other, 'dave');
    const share = (await call('POST', '/api/shares', { deckId: sub.id, toUsername: 'dave' })).data;
    await other('POST', `/api/shares/${share.id}/accept`);
    assert.equal((await other('GET', '/api/browse?q=leechy')).data.total, 1);

    // deck delete cascades through the trigger
    await call('DELETE', `/api/decks/${sub.id}`);
    assert.equal(await hits('leechy'), 0);
    assert.equal(indexedCount(app.db), noteCount(app.db));
  } finally {
    await app.close();
  }
});

test('index is backfilled for databases created before it existed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-backfill-'));
  try {
    let db = openDatabase(dir);
    db.exec("INSERT INTO users (username, pass_hash, salt) VALUES ('old', 'x', 'y')");
    db.exec("INSERT INTO decks (user_id, name) VALUES (1, 'Old')");
    db.exec("INSERT INTO notes (user_id, deck_id, front, back) VALUES (1, 1, 'ancient note', 'b')");
    // simulate a pre-index database
    db.exec('DROP TRIGGER notes_fts_ad; DROP TABLE notes_fts; PRAGMA user_version = 0');
    db.close();
    db = openDatabase(dir);
    assert.equal(indexedCount(db), 1);
    assert.equal(db.prepare("SELECT rowid FROM notes_fts WHERE notes_fts MATCH '\"ancient\"'").get().rowid, 1);
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('perf budget: search stays fast on a 20k-note collection', { skip: process.env.RECALL_SKIP_PERF === '1' }, async () => {
  const app = await boot();
  try {
    const call = client(app.base);
    await registerUser(call, 'perf');
    const { vocab } = seedCollection(app.db, 1, { notes: 20000 });
    const p95 = async (urls) => {
      const times = [];
      for (const u of urls) {
        const t = performance.now();
        const res = await call('GET', u);
        times.push(performance.now() - t);
        assert.equal(res.status, 200);
      }
      times.sort((a, b) => a - b);
      return times[Math.floor(times.length * 0.95)];
    };
    const words = vocab.slice(0, 40);
    const typo = (w) => w.slice(0, 2) + w.slice(3); // drop a letter
    const searchP95 = await p95([...words.map((w) => `/api/search?q=${enc(w)}`),
      ...words.map((w) => `/api/search?q=${enc(typo(w))}`)]);
    const browseP95 = await p95(words.map((w, i) => `/api/browse?q=${enc(`${w} is:review -tag:t${i}`)}&limit=50`));
    assert.ok(searchP95 < 40, `search p95 ${searchP95.toFixed(1)}ms`);
    assert.ok(browseP95 < 60, `browse p95 ${browseP95.toFixed(1)}ms`);
  } finally {
    await app.close();
  }
});
