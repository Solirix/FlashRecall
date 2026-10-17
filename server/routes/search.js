'use strict';

// Quick search for the command palette. Decks and pages are matched client-side
// (already in memory there); this returns notes and tags.

const { json, clampInt } = require('../util');
const search = require('../search');

module.exports = function registerSearchRoutes(router, db) {
  router.get('/api/search', (req, res) => {
    const q = (req.query.get('q') || '').trim().slice(0, 200);
    const limit = clampInt(req.query.get('limit'), 8, 1, 30);
    if (!q) {
      json(res, { total: 0, notes: [], tags: [], tookMs: 0 });
      return;
    }
    json(res, search.quickSearch(db, req.user.id, q, { limit }));
  });
};
