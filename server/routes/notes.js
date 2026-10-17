'use strict';

const {
  json, badRequest, notFound, parseClozeOrds, clampInt, startOfDay, DAY_MS,
} = require('../util');
const search = require('../search');

function noteJson(note, cards) {
  return {
    id: note.id,
    deckId: note.deck_id,
    type: note.type,
    front: note.front,
    back: note.back,
    extra: note.extra,
    tags: note.tags,
    createdAt: note.created_at,
    updatedAt: note.updated_at,
    cards: cards.map((c) => ({
      id: c.id,
      ord: c.ord,
      state: c.state,
      due: c.due,
      suspended: !!c.suspended,
      buried: !!c.buried,
      flagged: !!c.flagged,
      reps: c.reps,
      lapses: c.lapses,
    })),
  };
}

function ownNote(db, id, userId) {
  const note = db.prepare('SELECT * FROM notes WHERE id = ? AND user_id = ?').get(id, userId);
  if (!note) throw notFound('note not found');
  return note;
}

function desiredOrds(type, front) {
  if (type === 'cloze') return parseClozeOrds(front);
  return [0];
}

function insertCard(db, noteId, userId, ord, now) {
  db.prepare(`INSERT INTO cards (note_id, user_id, ord, state, due, created_at)
              VALUES (?, ?, ?, 'new', ?, ?)`).run(noteId, userId, ord, now, now);
}

// Sync a note's cards to the desired ord set: keep existing (preserving
// scheduling), create missing as new, delete removed.
function syncCards(db, note, ords, now) {
  const existing = db.prepare('SELECT * FROM cards WHERE note_id = ?').all(note.id);
  const keep = new Set(ords);
  for (const card of existing) {
    if (!keep.has(card.ord)) db.prepare('DELETE FROM cards WHERE id = ?').run(card.id);
  }
  const have = new Set(existing.filter((c) => keep.has(c.ord)).map((c) => c.ord));
  for (const ord of ords) {
    if (!have.has(ord)) insertCard(db, note.id, note.user_id, ord, now);
  }
}

module.exports = function registerNoteRoutes(router, db) {
  router.post('/api/notes', (req, res, params, body) => {
    const deckId = Number(body.deckId);
    const deck = db.prepare('SELECT * FROM decks WHERE id = ? AND user_id = ?').get(deckId, req.user.id);
    if (!deck) throw notFound('deck not found');
    const type = body.type === undefined ? 'basic' : String(body.type);
    if (type !== 'basic' && type !== 'cloze') throw badRequest("type must be 'basic' or 'cloze'");
    const front = typeof body.front === 'string' ? body.front : '';
    const back = typeof body.back === 'string' ? body.back : '';
    const extra = typeof body.extra === 'string' ? body.extra : '';
    const tags = typeof body.tags === 'string' ? body.tags : '';
    if (type === 'basic' && !front.trim() && !back.trim()) throw badRequest('front or back required');
    const ords = desiredOrds(type, front);
    if (type === 'cloze' && ords.length === 0) {
      throw badRequest('cloze note has no {{cN::...}} markers');
    }
    const now = Date.now();
    db.exec('BEGIN IMMEDIATE');
    let note;
    try {
      const info = db.prepare(`INSERT INTO notes (user_id, deck_id, type, front, back, extra, tags, created_at, updated_at)
                               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(req.user.id, deck.id, type, front, back, extra, tags, now, now);
      note = db.prepare('SELECT * FROM notes WHERE id = ?').get(Number(info.lastInsertRowid));
      for (const ord of ords) insertCard(db, note.id, req.user.id, ord, now);
      search.upsertNote(db, note.id);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    const cards = db.prepare('SELECT * FROM cards WHERE note_id = ? ORDER BY ord').all(note.id);
    json(res, noteJson(note, cards), 201);
  });

  router.get('/api/notes/:id', (req, res, params) => {
    const note = ownNote(db, Number(params.id), req.user.id);
    const cards = db.prepare('SELECT * FROM cards WHERE note_id = ? ORDER BY ord').all(note.id);
    json(res, noteJson(note, cards));
  });

  router.patch('/api/notes/:id', (req, res, params, body) => {
    const note = ownNote(db, Number(params.id), req.user.id);
    let { deck_id, type, front, back, extra, tags } = note;
    if (body.deckId !== undefined) {
      const deck = db.prepare('SELECT * FROM decks WHERE id = ? AND user_id = ?').get(Number(body.deckId), req.user.id);
      if (!deck) throw notFound('deck not found');
      deck_id = deck.id;
    }
    if (body.type !== undefined) {
      if (body.type !== 'basic' && body.type !== 'cloze') throw badRequest("type must be 'basic' or 'cloze'");
      type = body.type;
    }
    if (body.front !== undefined) {
      if (typeof body.front !== 'string') throw badRequest('front must be a string');
      front = body.front;
    }
    if (body.back !== undefined) {
      if (typeof body.back !== 'string') throw badRequest('back must be a string');
      back = body.back;
    }
    if (body.extra !== undefined) {
      if (typeof body.extra !== 'string') throw badRequest('extra must be a string');
      extra = body.extra;
    }
    if (body.tags !== undefined) {
      if (typeof body.tags !== 'string') throw badRequest('tags must be a string');
      tags = body.tags;
    }
    const ords = desiredOrds(type, front);
    if (type === 'cloze' && ords.length === 0) {
      throw badRequest('cloze note has no {{cN::...}} markers');
    }
    const now = Date.now();
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('UPDATE notes SET deck_id = ?, type = ?, front = ?, back = ?, extra = ?, tags = ?, updated_at = ? WHERE id = ?')
        .run(deck_id, type, front, back, extra, tags, now, note.id);
      if (front !== note.front || type !== note.type) {
        syncCards(db, note, ords, now);
      }
      search.upsertNote(db, note.id);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    const updated = db.prepare('SELECT * FROM notes WHERE id = ?').get(note.id);
    const cards = db.prepare('SELECT * FROM cards WHERE note_id = ? ORDER BY ord').all(note.id);
    json(res, noteJson(updated, cards));
  });

  router.delete('/api/notes/:id', (req, res, params) => {
    const note = ownNote(db, Number(params.id), req.user.id);
    db.prepare('DELETE FROM notes WHERE id = ?').run(note.id);
    json(res, { ok: true });
  });

  router.post('/api/notes/:id/suspend', (req, res, params, body) => {
    const note = ownNote(db, Number(params.id), req.user.id);
    if (typeof body.suspended !== 'boolean') throw badRequest('suspended must be a boolean');
    db.prepare('UPDATE cards SET suspended = ? WHERE note_id = ?').run(body.suspended ? 1 : 0, note.id);
    json(res, { ok: true, suspended: body.suspended });
  });

  router.post('/api/notes/:id/bury', (req, res, params) => {
    const note = ownNote(db, Number(params.id), req.user.id);
    const tomorrow = startOfDay(Date.now()) + DAY_MS;
    db.prepare('UPDATE cards SET buried = 1, due = ? WHERE note_id = ?').run(tomorrow, note.id);
    json(res, { ok: true, buried: true });
  });

  router.post('/api/notes/:id/flag', (req, res, params, body) => {
    const note = ownNote(db, Number(params.id), req.user.id);
    if (typeof body.flagged !== 'boolean') throw badRequest('flagged must be a boolean');
    db.prepare('UPDATE cards SET flagged = ? WHERE note_id = ?').run(body.flagged ? 1 : 0, note.id);
    json(res, { ok: true, flagged: body.flagged });
  });

  router.get('/api/browse', (req, res) => {
    const q = (req.query.get('q') || '').trim();
    const limit = clampInt(req.query.get('limit'), 50, 1, 200);
    const offset = clampInt(req.query.get('offset'), 0, 0, Number.MAX_SAFE_INTEGER);
    json(res, search.browse(db, req.user.id, q, { limit, offset }));
  });
};
