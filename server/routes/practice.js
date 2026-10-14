'use strict';

// Practice tests: a shuffled set of questions drawn from a deck (optionally its
// sub-decks). Answers are included — grading happens client-side so the
// checker is instant and the user can override it. Never touches scheduling.

const crypto = require('node:crypto');
const { json, badRequest, clampInt, renderCloze } = require('../util');
const { ownDeck } = require('./decks');

const FORMATS = new Set(['written', 'choice', 'mixed']);
const SCOPES = new Set(['all', 'studied']);

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function plain(s) {
  return String(s || '').replace(/\*\*|__|`|\*/g, '').trim();
}

// Hidden text of every deletion with this ordinal, e.g. {{c1::Paris::city}} -> Paris.
function clozeAnswer(text, ord) {
  const parts = [];
  const re = /\{\{c(\d+)::([^}]*?)\}\}/g;
  let m;
  while ((m = re.exec(text || ''))) {
    if (parseInt(m[1], 10) !== ord) continue;
    const sep = m[2].indexOf('::');
    parts.push(sep === -1 ? m[2] : m[2].slice(0, sep));
  }
  return parts.join(', ');
}

function toItem(row) {
  if (row.type === 'cloze') {
    const expected = plain(clozeAnswer(row.front, row.ord));
    if (!expected) return null;
    const full = renderCloze(row.front, row.ord, 'back');
    return {
      cardId: row.id,
      noteId: row.note_id,
      type: 'cloze',
      prompt: renderCloze(row.front, row.ord, 'front'),
      expected,
      answer: row.back && row.back.trim() ? `${full}\n${row.back}` : full,
      extra: row.extra || '',
    };
  }
  const firstLine = String(row.back || '').split('\n').find((l) => l.trim()) || '';
  const expected = plain(firstLine);
  if (!expected) return null;
  return {
    cardId: row.id,
    noteId: row.note_id,
    type: 'basic',
    prompt: row.front,
    expected,
    answer: row.back,
    extra: row.extra || '',
  };
}

module.exports = function registerPracticeRoutes(router, db) {
  router.get('/api/decks/:id/practice', (req, res, params) => {
    const deck = ownDeck(db, Number(params.id), req.user.id);
    const format = req.query.get('format') || 'written';
    const scope = req.query.get('scope') || 'all';
    if (!FORMATS.has(format)) throw badRequest('format must be written, choice or mixed');
    if (!SCOPES.has(scope)) throw badRequest('scope must be all or studied');
    const count = clampInt(req.query.get('count'), 20, 1, 500);
    const withSubdecks = req.query.get('subdecks') !== '0';

    const deckIds = [deck.id];
    if (withSubdecks) {
      const kids = db.prepare('SELECT id FROM decks WHERE parent_id = ? AND user_id = ?');
      for (let i = 0; i < deckIds.length && deckIds.length < 10000; i++) {
        for (const k of kids.all(deckIds[i], req.user.id)) deckIds.push(k.id);
      }
    }

    const rows = db.prepare(`
      SELECT c.id, c.ord, c.state, c.note_id, n.type, n.front, n.back, n.extra
      FROM cards c JOIN notes n ON n.id = c.note_id
      WHERE n.user_id = ? AND c.suspended = 0
        AND n.deck_id IN (${deckIds.map(() => '?').join(',')})
        ${scope === 'studied' ? "AND c.state != 'new'" : ''}`).all(req.user.id, ...deckIds);

    const pool = rows.map(toItem).filter(Boolean);
    const items = shuffle([...pool]).slice(0, count);

    // Distractors come from the other answers in the whole pool.
    if (format !== 'written') {
      const answers = [...new Map(pool.map((p) => [p.expected.toLowerCase(), p.expected])).values()];
      for (const item of items) {
        const wrong = shuffle(answers.filter((a) => a.toLowerCase() !== item.expected.toLowerCase())).slice(0, 3);
        const useChoice = wrong.length === 3 && (format === 'choice' || crypto.randomInt(2) === 0);
        item.format = useChoice ? 'choice' : 'written';
        if (useChoice) item.choices = shuffle([item.expected, ...wrong]);
      }
    } else {
      for (const item of items) item.format = 'written';
    }

    json(res, { deck: { id: deck.id, name: deck.name }, available: pool.length, items });
  });
};
