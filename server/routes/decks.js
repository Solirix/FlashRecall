'use strict';

const { json, httpError, badRequest, notFound, isNonEmptyString, intInRange, startOfDay, DAY_MS } = require('../util');

function deckJson(d) {
  return {
    id: d.id,
    parentId: d.parent_id,
    name: d.name,
    color: d.color,
    newPerDay: d.new_per_day,
    createdAt: d.created_at,
  };
}

function ownDeck(db, id, userId) {
  const deck = db.prepare('SELECT * FROM decks WHERE id = ? AND user_id = ?').get(id, userId);
  if (!deck) throw notFound('deck not found');
  return deck;
}

module.exports = function registerDeckRoutes(router, db) {
  router.get('/api/decks/tree', (req, res) => {
    const now = Date.now();
    const todayStart = startOfDay(now);
    const todayEnd = todayStart + DAY_MS;
    const decks = db.prepare('SELECT * FROM decks WHERE user_id = ? ORDER BY name COLLATE NOCASE, id').all(req.user.id);
    const countStmt = db.prepare(`
      SELECT
        SUM(CASE WHEN c.state = 'new' AND c.suspended = 0 THEN 1 ELSE 0 END) AS new_total,
        SUM(CASE WHEN c.state IN ('learning','relearning') AND c.suspended = 0 THEN 1 ELSE 0 END) AS learning_total,
        SUM(CASE WHEN c.state = 'review' AND c.suspended = 0 THEN 1 ELSE 0 END) AS review_total,
        SUM(CASE WHEN c.state IN ('learning','relearning') AND c.suspended = 0 AND c.buried = 0 AND c.due <= ? THEN 1 ELSE 0 END) AS learning_due,
        SUM(CASE WHEN c.state = 'review' AND c.suspended = 0 AND c.buried = 0 AND c.due < ? THEN 1 ELSE 0 END) AS review_due
      FROM cards c JOIN notes n ON n.id = c.note_id
      WHERE n.deck_id = ?`);
    const newDoneStmt = db.prepare(`
      SELECT COUNT(*) AS n FROM reviews r
      JOIN cards c ON c.id = r.card_id
      JOIN notes n ON n.id = c.note_id
      WHERE n.deck_id = ? AND r.state_before = 'new' AND r.reviewed_at >= ?`);
    const tree = decks.map((d) => {
      const counts = countStmt.get(now, todayEnd, d.id);
      const newDone = newDoneStmt.get(d.id, todayStart).n;
      const remainingNew = Math.max(0, d.new_per_day - newDone);
      const newCount = Math.min(remainingNew, counts.new_total || 0);
      return {
        id: d.id,
        parentId: d.parent_id,
        name: d.name,
        color: d.color,
        newPerDay: d.new_per_day,
        counts: {
          new: newCount,
          learning: counts.learning_total || 0,
          review: counts.review_total || 0,
          due: (counts.learning_due || 0) + (counts.review_due || 0),
        },
      };
    });
    json(res, tree);
  });

  router.post('/api/decks', (req, res, params, body) => {
    if (!isNonEmptyString(body.name, 100)) throw badRequest('name is required (1-100 chars)');
    let parentId = null;
    if (body.parentId != null) {
      const parent = db.prepare('SELECT * FROM decks WHERE id = ? AND user_id = ?').get(Number(body.parentId), req.user.id);
      if (!parent) throw notFound('parent deck not found');
      parentId = parent.id;
    }
    let color = null;
    if (body.color != null) {
      if (typeof body.color !== 'string' || body.color.length > 32) throw badRequest('invalid color');
      color = body.color;
    }
    let newPerDay = 20;
    if (body.newPerDay != null) {
      newPerDay = intInRange(body.newPerDay, 0, 9999);
      if (newPerDay == null) throw badRequest('newPerDay must be an integer 0-9999');
    }
    const now = Date.now();
    const info = db.prepare('INSERT INTO decks (user_id, parent_id, name, color, new_per_day, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(req.user.id, parentId, body.name.trim(), color, newPerDay, now);
    const deck = db.prepare('SELECT * FROM decks WHERE id = ?').get(Number(info.lastInsertRowid));
    json(res, deckJson(deck), 201);
  });

  router.patch('/api/decks/:id', (req, res, params, body) => {
    const deck = ownDeck(db, Number(params.id), req.user.id);
    let { name, parent_id, color, new_per_day } = deck;
    if (body.name !== undefined) {
      if (!isNonEmptyString(body.name, 100)) throw badRequest('name must be 1-100 chars');
      name = body.name.trim();
    }
    if (body.parentId !== undefined) {
      if (body.parentId === null) {
        parent_id = null;
      } else {
        const pid = Number(body.parentId);
        if (pid === deck.id) throw badRequest('deck cannot be its own parent');
        const parent = db.prepare('SELECT * FROM decks WHERE id = ? AND user_id = ?').get(pid, req.user.id);
        if (!parent) throw notFound('parent deck not found');
        parent_id = pid;
      }
    }
    if (body.color !== undefined) {
      if (body.color !== null && (typeof body.color !== 'string' || body.color.length > 32)) {
        throw badRequest('invalid color');
      }
      color = body.color;
    }
    if (body.newPerDay !== undefined) {
      const n = intInRange(body.newPerDay, 0, 9999);
      if (n == null) throw badRequest('newPerDay must be an integer 0-9999');
      new_per_day = n;
    }
    db.prepare('UPDATE decks SET name = ?, parent_id = ?, color = ?, new_per_day = ? WHERE id = ?')
      .run(name, parent_id, color, new_per_day, deck.id);
    json(res, deckJson(db.prepare('SELECT * FROM decks WHERE id = ?').get(deck.id)));
  });

  router.delete('/api/decks/:id', (req, res, params) => {
    const deck = ownDeck(db, Number(params.id), req.user.id);
    db.exec('BEGIN IMMEDIATE');
    try {
      // Children move up to the deleted deck's parent; notes/cards cascade.
      db.prepare('UPDATE decks SET parent_id = ? WHERE parent_id = ?').run(deck.parent_id, deck.id);
      db.prepare('DELETE FROM decks WHERE id = ?').run(deck.id);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    json(res, { ok: true });
  });
};

module.exports.deckJson = deckJson;
module.exports.ownDeck = ownDeck;
