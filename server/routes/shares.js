'use strict';

const {
  json, badRequest, notFound, parseClozeOrds,
} = require('../util');
const search = require('../search');

module.exports = function registerShareRoutes(router, db) {
  router.post('/api/shares', (req, res, params, body) => {
    const deckId = Number(body.deckId);
    const deck = db.prepare('SELECT * FROM decks WHERE id = ? AND user_id = ?').get(deckId, req.user.id);
    if (!deck) throw notFound('deck not found');
    const toUsername = typeof body.toUsername === 'string' ? body.toUsername.trim() : '';
    if (!toUsername) throw badRequest('toUsername is required');
    const target = db.prepare('SELECT * FROM users WHERE username = ?').get(toUsername);
    if (!target) throw notFound('user not found');
    if (target.id === req.user.id) throw badRequest('cannot share with yourself');
    const existing = db.prepare(
      "SELECT id FROM shares WHERE deck_id = ? AND to_user_id = ? AND status = 'pending'"
    ).get(deck.id, target.id);
    if (existing) {
      const err = { status: 409, message: 'share already pending for that user' };
      throw err;
    }
    const now = Date.now();
    const info = db.prepare('INSERT INTO shares (deck_id, from_user_id, to_user_id, status, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(deck.id, req.user.id, target.id, 'pending', now);
    json(res, {
      id: Number(info.lastInsertRowid),
      deckId: deck.id,
      deckName: deck.name,
      fromUsername: req.user.username,
      toUsername: target.username,
      status: 'pending',
      createdAt: now,
    }, 201);
  });

  router.get('/api/shares', (req, res) => {
    const incoming = db.prepare(`
      SELECT s.id, s.created_at, d.name AS deck_name, u.username AS from_username
      FROM shares s
      JOIN decks d ON d.id = s.deck_id
      JOIN users u ON u.id = s.from_user_id
      WHERE s.to_user_id = ? AND s.status = 'pending'
      ORDER BY s.created_at DESC`).all(req.user.id)
      .map((r) => ({ id: r.id, deckName: r.deck_name, fromUsername: r.from_username, createdAt: r.created_at }));
    const sent = db.prepare(`
      SELECT s.id, s.status, s.created_at, d.name AS deck_name, u.username AS to_username
      FROM shares s
      JOIN decks d ON d.id = s.deck_id
      JOIN users u ON u.id = s.to_user_id
      WHERE s.from_user_id = ?
      ORDER BY s.created_at DESC`).all(req.user.id)
      .map((r) => ({ id: r.id, deckName: r.deck_name, toUsername: r.to_username, status: r.status, createdAt: r.created_at }));
    json(res, { incoming, sent });
  });

  function ownIncomingShare(id, userId) {
    const share = db.prepare('SELECT * FROM shares WHERE id = ?').get(id);
    if (!share || share.to_user_id !== userId) throw notFound('share not found');
    if (share.status !== 'pending') throw badRequest(`share already ${share.status}`);
    return share;
  }

  router.post('/api/shares/:id/accept', (req, res, params) => {
    const share = ownIncomingShare(Number(params.id), req.user.id);
    const deck = db.prepare('SELECT * FROM decks WHERE id = ?').get(share.deck_id);
    if (!deck) throw notFound('deck no longer exists');
    const fromUser = db.prepare('SELECT * FROM users WHERE id = ?').get(share.from_user_id);

    let name = deck.name;
    const collision = db.prepare('SELECT 1 AS x FROM decks WHERE user_id = ? AND name = ?')
      .get(req.user.id, name);
    if (collision) name = `${deck.name} (from ${fromUser.username})`;

    const now = Date.now();
    let noteCount = 0;
    let cardCount = 0;
    let newDeckId;
    db.exec('BEGIN IMMEDIATE');
    try {
      const deckInfo = db.prepare('INSERT INTO decks (user_id, parent_id, name, color, new_per_day, created_at) VALUES (?, NULL, ?, ?, ?, ?)')
        .run(req.user.id, name, deck.color, deck.new_per_day, now);
      newDeckId = Number(deckInfo.lastInsertRowid);
      const notes = db.prepare('SELECT * FROM notes WHERE deck_id = ? ORDER BY id').all(deck.id);
      const insertNote = db.prepare(`INSERT INTO notes (user_id, deck_id, type, front, back, extra, tags, created_at, updated_at)
                                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      const insertCard = db.prepare(`INSERT INTO cards (note_id, user_id, ord, state, due, created_at)
                                     VALUES (?, ?, ?, 'new', ?, ?)`);
      for (const note of notes) {
        const noteInfo = insertNote.run(req.user.id, newDeckId, note.type, note.front, note.back, note.extra, note.tags, now, now);
        const newNoteId = Number(noteInfo.lastInsertRowid);
        search.upsertNote(db, newNoteId);
        noteCount += 1;
        const ords = note.type === 'cloze' ? parseClozeOrds(note.front) : [0];
        for (const ord of ords) {
          insertCard.run(newNoteId, req.user.id, ord, now, now);
          cardCount += 1;
        }
      }
      db.prepare("UPDATE shares SET status = 'accepted' WHERE id = ?").run(share.id);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    json(res, { deckId: newDeckId, deckName: name, notes: noteCount, cards: cardCount });
  });

  router.post('/api/shares/:id/decline', (req, res, params) => {
    const share = ownIncomingShare(Number(params.id), req.user.id);
    db.prepare("UPDATE shares SET status = 'declined' WHERE id = ?").run(share.id);
    json(res, { ok: true, status: 'declined' });
  });
};
