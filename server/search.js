'use strict';

// Search engine. Note text lives in an FTS5 trigram index (substring matching
// that scales) and structured terms (deck:, tag:, is:, -negation) compile to
// SQL, so filtering, counting and paging all stay inside SQLite.
//
// Typos: when a query finds few exact hits, each word is spell-corrected
// against a dictionary of every indexed word (its own small trigram index),
// the corrected words are searched exactly, and hits are reranked with the
// shared fuzzy scorer (public/js/fuzzy.js). The dictionary grows with
// vocabulary, not with note count, so the typo pass stays cheap at scale.

const { renderCloze, plain, startOfDay, DAY_MS } = require('./util');
const fuzzy = require('../public/js/fuzzy.js');

// Bump whenever FTS_SCHEMA or indexed text changes; startup then rebuilds.
const INDEX_VERSION = 3;
const FUZZY_BELOW = 20; // fewer exact hits than this triggers the typo pass
const FUZZY_CANDIDATES = 300;
const FUZZY_MIN_SCORE = 0.5;
const RANKED_MAX = 2000; // exact hits beyond this are streamed newest-first, not bm25-ranked
const COUNT_CAP = 5000; // totals above this are reported as "5000+"
const QUICK_COUNT_CAP = 500;
const MAX_CORRECTIONS = 6; // per query word
const TERM_CANDIDATES = 200;

const FTS_SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
  front, back, tags, user_id UNINDEXED,
  tokenize = 'trigram remove_diacritics 1'
);
CREATE TABLE IF NOT EXISTS search_gen (user_id INTEGER PRIMARY KEY, gen INTEGER NOT NULL DEFAULT 0);
CREATE TRIGGER IF NOT EXISTS notes_fts_ad AFTER DELETE ON notes BEGIN
  DELETE FROM notes_fts WHERE rowid = old.id;
  INSERT INTO search_gen (user_id, gen) VALUES (old.user_id, 1)
    ON CONFLICT (user_id) DO UPDATE SET gen = gen + 1;
END;
CREATE TABLE IF NOT EXISTS search_terms (id INTEGER PRIMARY KEY, term TEXT UNIQUE NOT NULL);
CREATE VIRTUAL TABLE IF NOT EXISTS search_terms_fts USING fts5(
  term, content = 'search_terms', content_rowid = 'id', tokenize = 'trigram'
);
`;
const DROP_SCHEMA = `
DROP TRIGGER IF EXISTS notes_fts_ad; DROP TABLE IF EXISTS notes_fts; DROP TABLE IF EXISTS search_gen;
DROP TABLE IF EXISTS search_terms_fts; DROP TABLE IF EXISTS search_terms;
`;
const WORDS = /[\p{L}\p{N}]{3,40}/gu;

const tagCache = new Map(); // userId -> { gen, tags }

// --- prepared statement cache ---

const stmtCache = new WeakMap();
function stmt(db, sql) {
  let m = stmtCache.get(db);
  if (!m) stmtCache.set(db, (m = new Map()));
  let s = m.get(sql);
  if (!s) m.set(sql, (s = db.prepare(sql)));
  return s;
}

// --- indexing ---

// Display text of a note: cloze markers unwrapped, markdown markers dropped.
function noteFields(note) {
  return {
    front: plain(renderCloze(note.front, 0, 'back')),
    back: plain([note.back, note.extra].filter((s) => s && s.trim()).join('\n')),
    tags: note.tags || '',
  };
}

function insertRow(db, note) {
  const f = noteFields(note);
  const front = fuzzy.fold(f.front);
  const back = fuzzy.fold(f.back);
  const tags = fuzzy.fold(f.tags);
  stmt(db, 'INSERT INTO notes_fts (rowid, front, back, tags, user_id) VALUES (?, ?, ?, ?, ?)')
    .run(note.id, front, back, tags, note.user_id);
  // Dictionary is append-only: a stale word costs one wasted lookup, nothing more.
  const addTerm = stmt(db, 'INSERT OR IGNORE INTO search_terms (term) VALUES (?)');
  const addTermFts = stmt(db, 'INSERT INTO search_terms_fts (rowid, term) VALUES (?, ?)');
  for (const w of new Set(`${front} ${back} ${tags}`.match(WORDS))) {
    const info = addTerm.run(w);
    if (info.changes) addTermFts.run(Number(info.lastInsertRowid), w);
  }
}

// Re-index one note after any write to it. Deletes are handled by the trigger.
function upsertNote(db, noteId) {
  stmt(db, 'DELETE FROM notes_fts WHERE rowid = ?').run(noteId);
  const note = stmt(db, 'SELECT * FROM notes WHERE id = ?').get(noteId);
  if (!note) return;
  insertRow(db, note);
  bumpGen(db, note.user_id);
}

// Per-user change counter (also bumped by the delete trigger) keying the tag cache.
function bumpGen(db, userId) {
  stmt(db, `INSERT INTO search_gen (user_id, gen) VALUES (?, 1)
            ON CONFLICT (user_id) DO UPDATE SET gen = gen + 1`).run(userId);
}

function rebuildIndex(db) {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec("DELETE FROM notes_fts; DELETE FROM search_terms; INSERT INTO search_terms_fts (search_terms_fts) VALUES ('delete-all');");
    for (const note of db.prepare('SELECT * FROM notes').iterate()) insertRow(db, note);
    db.exec("INSERT INTO notes_fts (notes_fts) VALUES ('optimize'); INSERT INTO search_terms_fts (search_terms_fts) VALUES ('optimize');");
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  tagCache.clear();
}

function ensureSearchIndex(db) {
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version !== INDEX_VERSION) db.exec(DROP_SCHEMA);
  db.exec(FTS_SCHEMA);
  const notes = db.prepare('SELECT COUNT(*) AS n FROM notes').get().n;
  const indexed = db.prepare('SELECT COUNT(*) AS n FROM notes_fts').get().n;
  if (version !== INDEX_VERSION || notes !== indexed) rebuildIndex(db);
  if (version !== INDEX_VERSION) db.exec(`PRAGMA user_version = ${INDEX_VERSION}`);
}

// --- query language ---

function tokenize(q) {
  const tokens = [];
  let cur = '';
  let inQuote = false;
  for (const ch of q) {
    if (ch === '"') {
      inQuote = !inQuote;
      continue;
    }
    if (!inQuote && /\s/.test(ch)) {
      if (cur) tokens.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur) tokens.push(cur);
  return tokens;
}

function parseQuery(q) {
  return tokenize(q).map((raw) => {
    let negated = false;
    let tok = raw;
    if (tok.startsWith('-') && tok.length > 1) {
      negated = true;
      tok = tok.slice(1);
    }
    const colon = tok.indexOf(':');
    if (colon > 0) {
      const key = tok.slice(0, colon).toLowerCase();
      const value = tok.slice(colon + 1);
      if (key === 'deck' || key === 'tag' || key === 'is') return { kind: key, value, negated };
    }
    return { kind: 'word', value: fuzzy.fold(tok).trim(), negated };
  }).filter((t) => t.value.length > 0);
}

const likeEscape = (s) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
const ftsPhrase = (s) => `"${s.replace(/"/g, '""')}"`;

// Dictionary words within typo distance of `w` (best first), plus `w` itself.
function corrections(db, w) {
  const out = [w];
  if (w.includes(' ')) return out;
  const grams = new Set();
  for (let i = 0; i + 3 <= w.length; i++) grams.add(ftsPhrase(w.slice(i, i + 3)));
  if (!grams.size) return out;
  const near = [];
  const rows = stmt(db, `SELECT term FROM search_terms_fts WHERE search_terms_fts MATCH ?
                         ORDER BY rank LIMIT ${TERM_CANDIDATES}`).all([...grams].join(' OR '));
  for (const { term } of rows) {
    if (term === w) continue;
    const m = fuzzy.nearWord(w, term);
    if (m) near.push({ term: m.len < term.length ? term.slice(0, m.len) : term, score: m.score });
  }
  near.sort((a, b) => b.score - a.score);
  for (const { term } of near) {
    if (out.length > MAX_CORRECTIONS) break;
    if (!out.includes(term)) out.push(term);
  }
  return out;
}

const DUE_SQL = `c.suspended = 0 AND c.buried = 0 AND (c.state = 'new'
  OR (c.state IN ('learning', 'relearning') AND c.due <= ?)
  OR (c.state = 'review' AND c.due < ?))`;
const IS_SQL = {
  new: "c.state = 'new'",
  learning: "c.state IN ('learning', 'relearning')",
  review: "c.state = 'review'",
  suspended: 'c.suspended = 1',
  flagged: 'c.flagged = 1',
  buried: 'c.buried = 1',
};

// One structured term (or short / negated word) as a SQL predicate on `n`.
function predicate(term, userId, now, todayEnd) {
  switch (term.kind) {
    case 'deck':
      // the deck and all its sub-decks
      return [`n.deck_id IN (WITH RECURSIVE sub(id) AS (
          SELECT id FROM decks WHERE user_id = ? AND name = ? COLLATE NOCASE
          UNION SELECT d.id FROM decks d JOIN sub ON d.parent_id = sub.id)
        SELECT id FROM sub)`, [userId, term.value]];
    case 'tag':
      return [`(' ' || replace(replace(n.tags, char(10), ' '), char(9), ' ') || ' ') LIKE ? ESCAPE '\\'`,
        [`% ${likeEscape(term.value)} %`]];
    case 'is': {
      const v = term.value.toLowerCase();
      if (v === 'due') return [`EXISTS (SELECT 1 FROM cards c WHERE c.note_id = n.id AND ${DUE_SQL})`, [now, todayEnd]];
      if (IS_SQL[v]) return [`EXISTS (SELECT 1 FROM cards c WHERE c.note_id = n.id AND ${IS_SQL[v]})`, []];
      return ['0', []];
    }
    default: {
      if (term.value.length >= 3) {
        return ['n.id IN (SELECT rowid FROM notes_fts WHERE notes_fts MATCH ?)', [ftsPhrase(term.value)]];
      }
      // too short for trigrams: per-row LIKE, reached via rowid
      const pat = `%${likeEscape(term.value)}%`;
      return [`EXISTS (SELECT 1 FROM notes_fts s WHERE s.rowid = n.id
        AND (s.front LIKE ? ESCAPE '\\' OR s.back LIKE ? ESCAPE '\\' OR s.tags LIKE ? ESCAPE '\\'))`, [pat, pat, pat]];
    }
  }
}

// Runs a query -> { total, capped, rows, words, sort }. rows are notes joined with
// deck_name, in relevance order when there is free text (newest first otherwise).
function run(db, userId, q, { limit = 50, offset = 0, now = Date.now(), countCap = COUNT_CAP } = {}) {
  const todayEnd = startOfDay(now) + DAY_MS;
  const parsed = parseQuery(q);
  const ftsWords = parsed.filter((t) => t.kind === 'word' && !t.negated && t.value.length >= 3).map((t) => t.value);
  const allWords = parsed.filter((t) => t.kind === 'word' && !t.negated).map((t) => t.value);

  const where = ['n.user_id = ?'];
  const params = [userId];
  for (const t of parsed) {
    if (t.kind === 'word' && !t.negated && t.value.length >= 3) continue; // drives the FTS MATCH
    const [sql, p] = predicate(t, userId, now, todayEnd);
    where.push(t.negated ? `NOT (${sql})` : sql);
    params.push(...p);
  }
  const whereSql = where.join(' AND ');
  const select = 'SELECT n.*, d.name AS deck_name';
  // Counting is the only step that must visit every match, so it stops at a cap.
  const count = (fromSql, args) => {
    const n = stmt(db, `SELECT COUNT(*) AS n FROM (SELECT 1 ${fromSql} LIMIT ${countCap + 1})`).get(...args).n;
    return { total: Math.min(n, countCap), capped: n > countCap };
  };

  if (!ftsWords.length) {
    const c = count(`FROM notes n WHERE ${whereSql}`, params);
    const rows = stmt(db, `${select} FROM notes n JOIN decks d ON d.id = n.deck_id WHERE ${whereSql}
                           ORDER BY n.created_at DESC, n.id DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
    return { ...c, rows, words: allWords, sort: 'newest' };
  }

  const exactMatch = ftsWords.map(ftsPhrase).join(' AND ');
  // FTS drives every query below: CROSS JOIN pins the join order, otherwise the
  // planner may scan all notes and evaluate MATCH or the filters per row.
  const streamFrom = `FROM notes_fts f CROSS JOIN notes n ON n.id = f.rowid
    WHERE notes_fts MATCH ? AND f.user_id = ? AND ${whereSql}`;
  const rawHits = (expr) => stmt(db, 'SELECT COUNT(*) AS n FROM notes_fts WHERE notes_fts MATCH ?').get(expr).n;
  // Too unselective to rank (bm25 would score every hit): stream newest-first
  // straight off the index, which stops at LIMIT; callers rerank the slice.
  const streamed = `${select} FROM notes_fts f CROSS JOIN notes n ON n.id = f.rowid JOIN decks d ON d.id = n.deck_id
    WHERE notes_fts MATCH ? AND f.user_id = ? AND ${whereSql} ORDER BY f.rowid DESC LIMIT ? OFFSET ?`;

  if (rawHits(exactMatch) > RANKED_MAX) {
    const c = count(streamFrom, [exactMatch, userId, ...params]);
    const rows = stmt(db, streamed).all(exactMatch, userId, ...params, limit, offset);
    return { ...c, rows, words: allWords, sort: 'newest' };
  }

  const ranked = (cap) => `WITH hits AS MATERIALIZED (
      SELECT rowid AS id, bm25(notes_fts, 3.0, 1.0, 1.5) AS score FROM notes_fts
      WHERE notes_fts MATCH ? AND user_id = ? ${cap ? `ORDER BY score LIMIT ${cap}` : ''})
    ${select} FROM hits CROSS JOIN notes n ON n.id = hits.id JOIN decks d ON d.id = n.deck_id
    WHERE ${whereSql} ORDER BY hits.score, n.id DESC`;
  const exactCount = count(streamFrom, [exactMatch, userId, ...params]).total;

  if (exactCount >= FUZZY_BELOW) {
    const rows = stmt(db, `${ranked(0)} LIMIT ? OFFSET ?`).all(exactMatch, userId, ...params, limit, offset);
    return { total: exactCount, capped: false, rows, words: allWords, sort: 'relevance' };
  }

  // Few exact hits: append typo-tolerant matches, best first. Only words that
  // are rare in the index get spell-corrected; well-attested ones stay as typed.
  const exact = exactCount ? stmt(db, ranked(0)).all(exactMatch, userId, ...params) : [];
  const groups = ftsWords.map((w) => (rawHits(ftsPhrase(w)) >= FUZZY_BELOW ? [w] : corrections(db, w)));
  if (groups.every((g) => g.length === 1)) {
    return {
      total: exact.length, capped: false, rows: exact.slice(offset, offset + limit), words: allWords, sort: 'relevance',
    };
  }
  const seen = new Set(exact.map((r) => r.id));
  const fuzzyExpr = groups.map((g) => `(${g.map(ftsPhrase).join(' OR ')})`).join(' AND ');
  const candidates = rawHits(fuzzyExpr) > RANKED_MAX
    ? stmt(db, streamed).all(fuzzyExpr, userId, ...params, FUZZY_CANDIDATES, 0)
    : stmt(db, ranked(FUZZY_CANDIDATES)).all(fuzzyExpr, userId, ...params);
  const fuzzyRows = [];
  for (const row of candidates) {
    if (seen.has(row.id)) continue;
    const r = scoreNote(allWords, row);
    if (r && r.score >= FUZZY_MIN_SCORE) fuzzyRows.push({ row, score: r.score });
  }
  fuzzyRows.sort((a, b) => b.score - a.score);
  const merged = exact.concat(fuzzyRows.map((x) => x.row));
  return {
    total: merged.length, capped: false, rows: merged.slice(offset, offset + limit), words: allWords, sort: 'relevance',
  };
}

function scoreNote(words, note, fields = noteFields(note)) {
  return fuzzy.scoreFields(words, [
    { text: fields.front, weight: 1 },
    { text: fields.back, weight: 0.85 },
    { text: fields.tags, weight: 0.9 },
  ]);
}

// --- result shaping ---

function cardsFor(db, ids) {
  const byNote = new Map(ids.map((id) => [id, []]));
  if (!ids.length) return byNote;
  const rows = db.prepare(`SELECT * FROM cards WHERE note_id IN (${ids.map(() => '?').join(',')})
                           ORDER BY note_id, ord, id`).all(...ids);
  for (const c of rows) byNote.get(c.note_id).push(c);
  return byNote;
}

function dueLabel(cards, now, todayEnd) {
  if (!cards.length) return 'New';
  const c = cards[0];
  if (c.suspended) return 'Susp.';
  if (c.buried) return 'Buried';
  if (c.state === 'new') return 'New';
  if (c.state === 'learning' || c.state === 'relearning') return 'Learning';
  if (c.due < todayEnd) return 'Today';
  const days = Math.max(1, Math.ceil((c.due - now) / DAY_MS));
  return `in ${days}d`;
}

// GET /api/browse payload.
function browse(db, userId, q, { limit, offset }) {
  const now = Date.now();
  const todayEnd = startOfDay(now) + DAY_MS;
  const { total, capped, rows, sort } = run(db, userId, q, { limit, offset, now });
  const cards = cardsFor(db, rows.map((r) => r.id));
  return {
    total,
    capped,
    sort,
    notes: rows.map((note) => {
      const cs = cards.get(note.id);
      return {
        id: note.id,
        deckId: note.deck_id,
        deckName: note.deck_name,
        type: note.type,
        front: note.front,
        back: note.back,
        tags: note.tags,
        due: dueLabel(cs, now, todayEnd),
        flagged: cs.some((c) => c.flagged),
        suspended: cs.some((c) => c.suspended),
        created: note.created_at,
      };
    }),
  };
}

const firstLine = (s) => (s.split('\n').find((l) => l.trim()) || '').trim();

function clip(text, words, width) {
  if (text.length <= width) return text;
  const hit = fuzzy.highlight(words, text)[0];
  const start = hit ? Math.max(0, hit[0] - Math.floor(width / 3)) : 0;
  const end = Math.min(text.length, start + width);
  return `${start ? '…' : ''}${text.slice(start, end).trim()}${end < text.length ? '…' : ''}`;
}

// Distinct tags with counts, cached per user until one of their notes changes.
function userTags(db, userId) {
  const row = stmt(db, 'SELECT gen FROM search_gen WHERE user_id = ?').get(userId);
  const gen = row ? row.gen : 0;
  const hit = tagCache.get(userId);
  if (hit && hit.gen === gen) return hit.tags;
  const counts = new Map();
  for (const { tags } of stmt(db, "SELECT tags FROM notes WHERE user_id = ? AND tags != ''").all(userId)) {
    for (const t of new Set(tags.split(/\s+/).filter(Boolean))) counts.set(t, (counts.get(t) || 0) + 1);
  }
  const list = [...counts].map(([name, count]) => ({ name, count, p: fuzzy.prepare(name) }));
  tagCache.set(userId, { gen, tags: list });
  return list;
}

// GET /api/search payload: top notes (reranked, with highlight ranges) and tags.
function quickSearch(db, userId, q, { limit = 8 } = {}) {
  const started = performance.now();
  const now = Date.now();
  const todayEnd = startOfDay(now) + DAY_MS;
  const { total, capped, rows, words } = run(db, userId, q, {
    limit: Math.max(limit * 8, 64), offset: 0, now, countCap: QUICK_COUNT_CAP,
  });

  const scored = rows.map((row, i) => {
    const fields = noteFields(row);
    const r = words.length ? scoreNote(words, row, fields) : null;
    return { row, fields, score: r ? r.score : 0, i };
  });
  if (words.length) scored.sort((a, b) => b.score - a.score || a.i - b.i);
  const top = scored.slice(0, limit);
  const cards = cardsFor(db, top.map((x) => x.row.id));

  const notes = top.map(({ row, fields }) => {
    const title = clip(firstLine(fields.front) || firstLine(fields.back) || '(empty)', words, 120);
    const snippetSrc = fields.front.includes('\n') ? `${fields.front.split('\n').slice(1).join(' ')} ${fields.back}` : fields.back;
    const snippet = clip(snippetSrc.replace(/\s+/g, ' ').trim(), words, 110);
    return {
      id: row.id,
      deckId: row.deck_id,
      deckName: row.deck_name,
      type: row.type,
      title,
      titleMatches: fuzzy.highlight(words, title),
      snippet,
      snippetMatches: fuzzy.highlight(words, snippet),
      due: dueLabel(cards.get(row.id), now, todayEnd),
    };
  });

  let tags = [];
  if (words.length) {
    tags = userTags(db, userId)
      .map((t) => ({ t, r: fuzzy.scoreFields(words, [{ prepared: t.p }], { subseq: true, min: 0.45 }) }))
      .filter((x) => x.r)
      .sort((a, b) => b.r.score - a.r.score || b.t.count - a.t.count)
      .slice(0, 6)
      .map(({ t, r }) => ({ name: t.name, count: t.count, matches: r.ranges[0] }));
  }

  return { total, capped, notes, tags, tookMs: Math.round((performance.now() - started) * 10) / 10 };
}

module.exports = {
  INDEX_VERSION,
  ensureSearchIndex,
  rebuildIndex,
  upsertNote,
  parseQuery,
  run,
  browse,
  quickSearch,
};
