'use strict';

// Search benchmark: seeds a temp collection and reports latency percentiles
// for the engine directly (no HTTP). Usage: npm run bench [-- <notes>]

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDatabase } = require('../db');
const search = require('../search');
const { seedCollection, rng } = require('./seed');

const NOTES = Number(process.argv[2]) || 50000;
const RUNS = 200;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-bench-'));
try {
  const db = openDatabase(dir);
  db.exec("INSERT INTO users (username, pass_hash, salt) VALUES ('bench', 'x', 'y')");
  let t = performance.now();
  const { vocab } = seedCollection(db, 1, { notes: NOTES });
  console.log(`seed + index ${NOTES} notes: ${(performance.now() - t).toFixed(0)}ms`);
  t = performance.now();
  search.rebuildIndex(db);
  console.log(`rebuild index: ${(performance.now() - t).toFixed(0)}ms\n`);

  const rand = rng(7);
  const word = () => vocab[Math.floor(rand() * vocab.length)];
  const typo = (w) => { const i = 1 + Math.floor(rand() * (w.length - 2)); return w.slice(0, i) + w.slice(i + 1); };
  const cases = {
    'quick: exact word': () => search.quickSearch(db, 1, word()),
    'quick: typo': () => search.quickSearch(db, 1, typo(word())),
    'quick: two words': () => search.quickSearch(db, 1, `${word()} ${word().slice(0, 4)}`),
    'quick: prefix (3 chars)': () => search.quickSearch(db, 1, word().slice(0, 3)),
    'browse: word + filters': () => search.browse(db, 1, `${word()} is:review -tag:t3`, { limit: 50, offset: 0 }),
    'browse: filters only': () => search.browse(db, 1, 'is:due -tag:t3', { limit: 50, offset: 0 }),
    'browse: deck page 10': () => search.browse(db, 1, 'deck:"Deck 3"', { limit: 50, offset: 500 }),
  };
  console.log('case'.padEnd(26), 'p50'.padStart(8), 'p95'.padStart(8), 'max'.padStart(8));
  for (const [name, fn] of Object.entries(cases)) {
    for (let i = 0; i < 10; i++) fn(); // warm up
    const times = [];
    for (let i = 0; i < RUNS; i++) {
      const s = performance.now();
      fn();
      times.push(performance.now() - s);
    }
    times.sort((a, b) => a - b);
    const at = (p) => `${times[Math.floor(times.length * p)].toFixed(2)}ms`.padStart(8);
    console.log(name.padEnd(26), at(0.5), at(0.95), at(0.999));
  }
  db.close();
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
