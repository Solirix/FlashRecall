'use strict';

const { json, notFound, mergeSettings, startOfDay, dayKey, DAY_MS, clampInt } = require('../util');

module.exports = function registerStatsRoutes(router, db) {
  router.get('/api/stats/summary', (req, res) => {
    const settings = mergeSettings(req.user);
    const now = Date.now();
    const todayStart = startOfDay(now);
    const todayEnd = todayStart + DAY_MS;
    const rangeDays = clampInt(req.query.get('rangeDays'), 90, 1, 3650);
    const rangeStart = todayStart - (rangeDays - 1) * DAY_MS;

    // Optional deck scoping with ownership check.
    let deckId = null;
    if (req.query.get('deckId')) {
      deckId = Number(req.query.get('deckId'));
      const deck = db.prepare('SELECT id FROM decks WHERE id = ? AND user_id = ?').get(deckId, req.user.id);
      if (!deck) throw notFound('deck not found');
    }

    const cardScope = deckId == null
      ? { sql: 'WHERE c.user_id = ?', args: [req.user.id] }
      : { sql: 'WHERE c.user_id = ? AND n.deck_id = ?', args: [req.user.id, deckId] };
    const cardFrom = deckId == null
      ? 'FROM cards c'
      : 'FROM cards c JOIN notes n ON n.id = c.note_id';
    const reviewScope = deckId == null
      ? { sql: 'WHERE r.user_id = ?', args: [req.user.id] }
      : { sql: 'WHERE r.user_id = ? AND n.deck_id = ?', args: [req.user.id, deckId] };
    const reviewFrom = deckId == null
      ? 'FROM reviews r'
      : 'FROM reviews r JOIN cards c ON c.id = r.card_id JOIN notes n ON n.id = c.note_id';

    const dueRow = db.prepare(`
      SELECT
        SUM(CASE WHEN c.state IN ('learning','relearning') AND c.due <= ? THEN 1 ELSE 0 END) AS learning_due,
        SUM(CASE WHEN c.state = 'review' AND c.due < ? THEN 1 ELSE 0 END) AS review_due,
        SUM(CASE WHEN c.state = 'new' THEN 1 ELSE 0 END) AS new_total
      ${cardFrom} ${cardScope.sql} AND c.suspended = 0 AND c.buried = 0`)
      .get(now, todayEnd, ...cardScope.args);

    const retentionRow = db.prepare(`
      SELECT COUNT(*) AS n, SUM(CASE WHEN r.grade > 1 THEN 1 ELSE 0 END) AS good
      ${reviewFrom} ${reviewScope.sql} AND r.reviewed_at >= ?`)
      .get(...reviewScope.args, todayStart - 30 * DAY_MS);
    const retention30d = retentionRow.n > 0
      ? Math.round((retentionRow.good / retentionRow.n) * 1000) / 10
      : null;

    const totalReviews = db.prepare(`SELECT COUNT(*) AS n ${reviewFrom} ${reviewScope.sql}`)
      .get(...reviewScope.args).n;

    const avgRow = db.prepare(`
      SELECT AVG(r.duration_ms) AS avg_ms, COUNT(*) AS n ${reviewFrom}
      ${reviewScope.sql} AND r.reviewed_at >= ?`).get(...reviewScope.args, rangeStart);
    const avgAnswerMs = avgRow.n > 0 ? Math.round(avgRow.avg_ms) : null;

    const studiedMsWeek = db.prepare(`
      SELECT COALESCE(SUM(r.duration_ms), 0) AS ms ${reviewFrom}
      ${reviewScope.sql} AND r.reviewed_at >= ?`).get(...reviewScope.args, todayStart - 6 * DAY_MS).ms;

    // Streaks over distinct review days (all time).
    const reviewDays = db.prepare(`
      SELECT DISTINCT r.reviewed_at AS ts ${reviewFrom} ${reviewScope.sql} ORDER BY r.reviewed_at`)
      .all(...reviewScope.args)
      .map((r) => startOfDay(r.ts));
    const uniqueDays = [...new Set(reviewDays)].sort((a, b) => a - b);
    const daySet = new Set(uniqueDays);
    let streakDays = 0;
    {
      let cursor = daySet.has(todayStart) ? todayStart
        : daySet.has(todayStart - DAY_MS) ? todayStart - DAY_MS
        : null;
      while (cursor != null && daySet.has(cursor)) {
        streakDays += 1;
        cursor -= DAY_MS;
      }
    }
    let bestStreak = 0;
    {
      let run = 0;
      let prev = null;
      for (const d of uniqueDays) {
        run = prev != null && d - prev === DAY_MS ? run + 1 : 1;
        if (run > bestStreak) bestStreak = run;
        prev = d;
      }
    }

    const heatmapRows = db.prepare(`
      SELECT r.reviewed_at AS ts ${reviewFrom} ${reviewScope.sql} AND r.reviewed_at >= ?`)
      .all(...reviewScope.args, rangeStart);
    const heatmapCounts = new Map();
    for (const r of heatmapRows) {
      const key = dayKey(r.ts);
      heatmapCounts.set(key, (heatmapCounts.get(key) || 0) + 1);
    }
    const heatmap = [];
    for (let i = rangeDays - 1; i >= 0; i--) {
      const dayMs = todayStart - i * DAY_MS;
      heatmap.push({ date: dayKey(dayMs), count: heatmapCounts.get(dayKey(dayMs)) || 0 });
    }

    const forecastRows = db.prepare(`
      SELECT c.due AS due ${cardFrom} ${cardScope.sql}
        AND c.state = 'review' AND c.suspended = 0
        AND c.due >= ? AND c.due < ?`)
      .all(...cardScope.args, todayStart, todayStart + 30 * DAY_MS);
    const forecastCounts = new Map();
    for (const r of forecastRows) {
      const key = dayKey(startOfDay(r.due));
      forecastCounts.set(key, (forecastCounts.get(key) || 0) + 1);
    }
    const forecast = [];
    for (let i = 0; i < 30; i++) {
      const dayMs = todayStart + i * DAY_MS;
      forecast.push({ date: dayKey(dayMs), count: forecastCounts.get(dayKey(dayMs)) || 0 });
    }

    const stateRow = db.prepare(`
      SELECT
        SUM(CASE WHEN c.state = 'new' THEN 1 ELSE 0 END) AS new_count,
        SUM(CASE WHEN c.state IN ('learning','relearning') THEN 1 ELSE 0 END) AS learning_count,
        SUM(CASE WHEN c.state = 'review' AND COALESCE(c.stability, 0) < 21 THEN 1 ELSE 0 END) AS young,
        SUM(CASE WHEN c.state = 'review' AND COALESCE(c.stability, 0) >= 21 THEN 1 ELSE 0 END) AS mature
      ${cardFrom} ${cardScope.sql}`).get(...cardScope.args);

    const gradeRows = db.prepare(`
      SELECT r.grade AS grade, COUNT(*) AS n ${reviewFrom}
      ${reviewScope.sql} AND r.reviewed_at >= ? GROUP BY r.grade`)
      .all(...reviewScope.args, rangeStart);
    const gradeTotal = gradeRows.reduce((acc, r) => acc + r.n, 0);
    const retentionByGrade = {};
    for (let g = 1; g <= 4; g++) {
      const row = gradeRows.find((r) => r.grade === g);
      const count = row ? row.n : 0;
      retentionByGrade[g] = {
        count,
        pct: gradeTotal > 0 ? Math.round((count / gradeTotal) * 1000) / 10 : 0,
      };
    }

    const avgStability = db.prepare(`
      SELECT AVG(c.stability) AS s ${cardFrom} ${cardScope.sql} AND c.state = 'review' AND c.stability IS NOT NULL`)
      .get(...cardScope.args).s;

    json(res, {
      dueToday: (dueRow.learning_due || 0) + (dueRow.review_due || 0),
      newToday: dueRow.new_total || 0,
      retention30d,
      totalReviews,
      avgAnswerMs,
      studiedMsWeek,
      streakDays,
      bestStreak,
      heatmap,
      forecast,
      cardStates: {
        new: stateRow.new_count || 0,
        learning: stateRow.learning_count || 0,
        young: stateRow.young || 0,
        mature: stateRow.mature || 0,
      },
      retentionByGrade,
      fsrs: {
        desiredRetention: settings.desiredRetention,
        avgStability: avgStability == null ? null : Math.round(avgStability * 100) / 100,
        leechThreshold: settings.leechThreshold,
      },
    });
  });
};
