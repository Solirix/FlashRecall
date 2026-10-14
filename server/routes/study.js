'use strict';

const fsrs = require('../fsrs');
const {
  json, httpError, badRequest, notFound, mergeSettings, renderCloze, startOfDay, DAY_MS,
} = require('../util');

function cardJson(c) {
  return {
    id: c.id,
    noteId: c.note_id,
    ord: c.ord,
    state: c.state,
    due: c.due,
    stability: c.stability,
    difficulty: c.difficulty,
    reps: c.reps,
    lapses: c.lapses,
    step: c.step,
    suspended: !!c.suspended,
    buried: !!c.buried,
    flagged: !!c.flagged,
    lastReview: c.last_review,
  };
}

function toStudyCard(row, retention, now) {
  let front = row.front;
  let back = row.back;
  if (row.type === 'cloze') {
    front = renderCloze(row.front, row.ord, 'front');
    back = renderCloze(row.back, row.ord, 'back');
  }
  return {
    id: row.id,
    noteId: row.note_id,
    ord: row.ord,
    type: row.type,
    front,
    back,
    extra: row.extra,
    tags: row.tags,
    state: row.state,
    flagged: !!row.flagged,
    previews: fsrs.previewIntervals({
      state: row.state,
      step: row.step,
      stability: row.stability,
      difficulty: row.difficulty,
      last_review: row.last_review,
      due: row.due,
    }, retention, now),
  };
}

module.exports = function registerStudyRoutes(router, db, ctx) {
  router.get('/api/study/:deckId/queue', (req, res, params) => {
    const deck = db.prepare('SELECT * FROM decks WHERE id = ? AND user_id = ?')
      .get(Number(params.deckId), req.user.id);
    if (!deck) throw notFound('deck not found');

    const now = Date.now();
    const todayStart = startOfDay(now);
    const todayEnd = todayStart + DAY_MS;
    const settings = mergeSettings(req.user);

    // Unbury cards whose buried-until day has arrived.
    db.prepare('UPDATE cards SET buried = 0 WHERE user_id = ? AND buried = 1 AND due <= ?')
      .run(req.user.id, now);

    const base = `
      FROM cards c JOIN notes n ON n.id = c.note_id
      WHERE n.deck_id = ? AND c.suspended = 0 AND c.buried = 0`;
    const cols = 'c.*, n.type AS type, n.front AS front, n.back AS back, n.extra AS extra, n.tags AS tags';

    const learning = db.prepare(
      `SELECT ${cols} ${base} AND c.state IN ('learning','relearning') AND c.due <= ? ORDER BY c.due, c.id`
    ).all(deck.id, now);

    const reviewDoneToday = db.prepare(`
      SELECT COUNT(*) AS n FROM reviews r
      JOIN cards c ON c.id = r.card_id
      JOIN notes n ON n.id = c.note_id
      WHERE n.deck_id = ? AND r.state_before = 'review' AND r.reviewed_at >= ?`).get(deck.id, todayStart).n;
    const reviewLimit = Math.max(0, settings.reviewCap - reviewDoneToday);
    const review = db.prepare(
      `SELECT ${cols} ${base} AND c.state = 'review' AND c.due < ? ORDER BY c.due, c.id LIMIT ?`
    ).all(deck.id, todayEnd, reviewLimit);

    const newDoneToday = db.prepare(`
      SELECT COUNT(*) AS n FROM reviews r
      JOIN cards c ON c.id = r.card_id
      JOIN notes n ON n.id = c.note_id
      WHERE n.deck_id = ? AND r.state_before = 'new' AND r.reviewed_at >= ?`).get(deck.id, todayStart).n;
    const newLimit = Math.max(0, deck.new_per_day - newDoneToday);
    const fresh = db.prepare(
      `SELECT ${cols} ${base} AND c.state = 'new' ORDER BY c.due, c.id LIMIT ?`
    ).all(deck.id, newLimit);

    const rows = [...learning, ...review, ...fresh];
    const cards = rows.map((row) => toStudyCard(row, settings.desiredRetention, now));
    json(res, {
      deck: { id: deck.id, name: deck.name },
      total: cards.length,
      counts: { new: fresh.length, learning: learning.length, review: review.length },
      cards,
    });
  });

  router.post('/api/study/answer', (req, res, params, body) => {
    const cardId = Number(body.cardId);
    const grade = Number(body.grade);
    const durationMs = Math.max(0, Math.floor(Number(body.durationMs) || 0));
    if (!Number.isInteger(cardId)) throw badRequest('cardId is required');
    if (!Number.isInteger(grade) || grade < 1 || grade > 4) throw badRequest('grade must be an integer 1-4');

    const card = db.prepare('SELECT * FROM cards WHERE id = ? AND user_id = ?').get(cardId, req.user.id);
    if (!card) throw notFound('card not found');

    const settings = mergeSettings(req.user);
    const now = Date.now();
    const next = fsrs.answer(card, grade, now, settings.desiredRetention);

    db.exec('BEGIN IMMEDIATE');
    let updated;
    let leech = false;
    try {
      db.prepare(`UPDATE cards SET state = ?, due = ?, stability = ?, difficulty = ?, reps = ?,
                  lapses = ?, step = ?, last_review = ? WHERE id = ?`)
        .run(next.state, next.due, next.stability, next.difficulty, next.reps,
             next.lapses, next.step, next.last_review, card.id);
      const info = db.prepare(`INSERT INTO reviews (card_id, user_id, grade, duration_ms, state_before, reviewed_at)
                               VALUES (?, ?, ?, ?, ?, ?)`)
        .run(card.id, req.user.id, grade, durationMs, card.state, now);
      if (grade === 1 && next.lapses >= settings.leechThreshold) {
        const note = db.prepare('SELECT * FROM notes WHERE id = ?').get(card.note_id);
        const tags = (note.tags || '').split(/\s+/).filter(Boolean);
        if (!tags.includes('leech')) {
          tags.push('leech');
          db.prepare('UPDATE notes SET tags = ?, updated_at = ? WHERE id = ?')
            .run(tags.join(' '), now, note.id);
          leech = true;
        }
      }
      ctx.undoStacks.set(req.user.id, { cardBefore: card, reviewId: Number(info.lastInsertRowid) });
      updated = db.prepare('SELECT * FROM cards WHERE id = ?').get(card.id);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    json(res, { card: cardJson(updated), leech });
  });

  router.post('/api/study/undo', (req, res) => {
    const entry = ctx.undoStacks.get(req.user.id);
    if (!entry) throw badRequest('nothing to undo');
    const { cardBefore, reviewId } = entry;
    const card = db.prepare('SELECT * FROM cards WHERE id = ? AND user_id = ?').get(cardBefore.id, req.user.id);
    if (!card) {
      ctx.undoStacks.delete(req.user.id);
      throw notFound('card not found');
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(`UPDATE cards SET state = ?, due = ?, stability = ?, difficulty = ?, reps = ?,
                  lapses = ?, step = ?, suspended = ?, buried = ?, flagged = ?, last_review = ?
                  WHERE id = ?`)
        .run(cardBefore.state, cardBefore.due, cardBefore.stability, cardBefore.difficulty,
             cardBefore.reps, cardBefore.lapses, cardBefore.step, cardBefore.suspended,
             cardBefore.buried, cardBefore.flagged, cardBefore.last_review, cardBefore.id);
      db.prepare('DELETE FROM reviews WHERE id = ? AND user_id = ?').run(reviewId, req.user.id);
      ctx.undoStacks.delete(req.user.id);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    const restored = db.prepare('SELECT * FROM cards WHERE id = ?').get(cardBefore.id);
    json(res, { card: cardJson(restored) });
  });
};

module.exports.cardJson = cardJson;
