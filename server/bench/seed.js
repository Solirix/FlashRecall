'use strict';

// Deterministic synthetic collection for the search benchmark and perf tests:
// pseudo-word vocabulary (with accents), mixed basic/cloze notes, tags, decks.

const { rebuildIndex } = require('../search');

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SYLLABLES = ['ka', 'ri', 'mo', 'te', 'lu', 'san', 'pé', 'dor', 'vi', 'na', 'qua', 'zel', 'bré', 'tion', 'ex', 'ul', 'gra', 'fi', 'ço', 'ment'];

function vocabulary(rand, size) {
  const words = new Set();
  while (words.size < size) {
    let w = '';
    const n = 2 + Math.floor(rand() * 3);
    for (let i = 0; i < n; i++) w += SYLLABLES[Math.floor(rand() * SYLLABLES.length)];
    words.add(w);
  }
  return [...words];
}

// Inserts `notes` notes (and one card each) for `userId` directly, then rebuilds the index.
function seedCollection(db, userId, { notes = 20000, decks = 25, seed = 42 } = {}) {
  const rand = rng(seed);
  const vocab = vocabulary(rand, 4000);
  const pick = () => vocab[Math.floor(rand() * vocab.length)];
  const sentence = (n) => Array.from({ length: n }, pick).join(' ');
  const now = Date.now();
  const deckIds = [];
  const insDeck = db.prepare('INSERT INTO decks (user_id, name, created_at) VALUES (?, ?, ?)');
  const insNote = db.prepare(`INSERT INTO notes (user_id, deck_id, type, front, back, extra, tags, created_at, updated_at)
                              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insCard = db.prepare(`INSERT INTO cards (note_id, user_id, ord, state, due, created_at)
                              VALUES (?, ?, ?, ?, ?, ?)`);
  const states = ['new', 'learning', 'review', 'review', 'review'];
  db.exec('BEGIN');
  for (let i = 0; i < decks; i++) {
    deckIds.push(Number(insDeck.run(userId, `Deck ${i} ${pick()}`, now).lastInsertRowid));
  }
  for (let i = 0; i < notes; i++) {
    const cloze = rand() < 0.3;
    const front = cloze
      ? `${sentence(3)} {{c1::${pick()}}} ${sentence(4)}`
      : `${sentence(2 + Math.floor(rand() * 6))}?`;
    const back = cloze ? '' : sentence(1 + Math.floor(rand() * 12));
    const extra = rand() < 0.25 ? sentence(8) : '';
    const tags = Array.from({ length: Math.floor(rand() * 3) }, () => `t${Math.floor(rand() * 120)}`).join(' ');
    const id = Number(insNote.run(userId, deckIds[i % decks], cloze ? 'cloze' : 'basic',
      front, back, extra, tags, now - i * 1000, now).lastInsertRowid);
    insCard.run(id, userId, cloze ? 1 : 0, states[i % states.length], now + (i % 30) * 86400000, now);
  }
  db.exec('COMMIT');
  rebuildIndex(db);
  return { vocab, deckIds };
}

module.exports = { seedCollection, rng };
