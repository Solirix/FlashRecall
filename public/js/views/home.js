// #/home — dashboard: greeting, stat tiles, decks-due list, heatmap + forecast.

import { api } from '../api.js';
import { el, icon, toast, fmtDuration, fmtSecs, skeleton } from '../ui.js';
import { state, refreshDecks, deckColor, deckPath, deckDue, topDueDeck, navigate } from '../app.js';
import { renderHeatmap } from '../components/heatmap.js';
import { renderBarChart } from '../components/barchart.js';

export async function render(main) {
  main.append(
    el('div', { class: 'home-head' }, skeleton(34, 280), skeleton(40, 170)),
    el('div', { class: 'tiles' }, [0, 1, 2, 3].map(() => skeleton(86))),
    el('div', { class: 'home-grid' },
      el('div', { class: 'home-col' }, skeleton(300), skeleton(120)),
      el('div', { class: 'home-col' }, skeleton(220), skeleton(180))));

  let stats;
  try {
    [stats] = await Promise.all([
      api.get('/api/stats/summary?rangeDays=168'),
      refreshDecks(),
    ]);
  } catch (err) {
    if (err.status !== 401) toast(err.message || 'failed to load dashboard', 'error');
    throw err;
  }

  const decks = state.decks;
  const dueDecks = decks.filter((d) => deckDue(d) > 0).sort((a, b) => deckDue(b) - deckDue(a));
  const totalDue = dueDecks.reduce((s, d) => s + deckDue(d), 0);
  const totalNew = decks.reduce((s, d) => s + (d.counts?.new || 0), 0);
  const paceMs = stats.avgAnswerMs || 8000;
  const etaMin = Math.max(1, Math.round((totalDue * paceMs) / 60000));

  // Mature% for due decks (few; fetched in parallel).
  const matureByDeck = new Map();
  await Promise.all(dueDecks.slice(0, 8).map(async (d) => {
    try {
      const s = await api.get(`/api/stats/summary?deckId=${d.id}&rangeDays=30`);
      const cs = s.cardStates || {};
      const total = (cs.new || 0) + (cs.learning || 0) + (cs.young || 0) + (cs.mature || 0);
      matureByDeck.set(d.id, total > 0 ? Math.round(((cs.mature || 0) / total) * 100) : null);
    } catch { /* leave blank */ }
  }));

  const hour = new Date().getHours();
  const greet = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const name = state.user ? (state.user.displayName || state.user.username) : '';

  const tilesRow = el('div', { class: 'tiles' },
    tile('bolt', 'var(--accent)', String(totalDue), 'Due today', totalNew ? `${totalNew} new` : null),
    tile('target', 'var(--green)', stats.retention30d != null ? `${stats.retention30d}%` : '—', '30-day retention',
      stats.retention30d != null && stats.totalReviews ? `across ${stats.totalReviews} reviews` : null),
    tile('clock', 'var(--blue)', fmtDuration(stats.studiedMsWeek), 'Studied this week',
      stats.avgAnswerMs != null ? `avg ${fmtSecs(stats.avgAnswerMs)} per card` : null),
    tile('flame', 'var(--orange)', String(stats.streakDays || 0), 'Day streak',
      stats.bestStreak ? `personal best ${stats.bestStreak}` : null));

  const decksList = el('div', { class: 'home-col' },
    el('div', { class: 'section-label', text: 'Decks due' }),
    dueDecks.length === 0
      ? el('div', { class: 'card all-caught-up' }, el('span', { html: icon('check', 16) }), 'All caught up — nothing due')
      : dueDecks.map((d) => {
        const c = d.counts || {};
        const cardCount = (c.new || 0) + (c.learning || 0) + (c.review || 0);
        const mature = matureByDeck.get(d.id);
        return el('div', { class: 'deck-row' },
          el('span', { class: 'dot', style: `background:${deckColor(d)}` }),
          el('div', { class: 'deck-meta' },
            el('div', { class: 'deck-name', text: d.name }),
            el('div', {
              class: 'deck-path',
              text: [deckPath(d), `${cardCount} cards`, mature != null ? `${mature}% mature` : null]
                .filter(Boolean).join(' · '),
            })),
          el('div', { class: 'deck-chips' },
            c.new ? el('span', { class: 'chip c-new', text: `${c.new} new` }) : null,
            c.learning ? el('span', { class: 'chip c-lrn', text: `${c.learning} lrn` }) : null,
            c.due ? el('span', { class: 'chip c-rev', text: `${c.due} rev` }) : null),
          el('button', { class: 'btn', onclick: () => navigate(`#/study/${d.id}`) }, 'Study'));
      }));

  const heatmapCard = el('div', { class: 'card' },
    el('div', { class: 'card-head' },
      el('div', {}, el('h3', { text: 'Review heatmap' }),
        el('div', { class: 'card-sub', text: `past 24 weeks · ${(stats.heatmap || []).reduce((s, h) => s + h.count, 0)} reviews` }))));
  renderHeatmap(heatmapCard, stats.heatmap, { weeks: 24 });

  const forecastCard = el('div', { class: 'card' });
  const head = el('div', { class: 'card-head' },
    el('div', {}, el('h3', { text: 'Upcoming load' }), el('div', { class: 'card-sub', text: 'next 14 days' })));
  forecastCard.append(head);
  const { peak } = renderBarChart(forecastCard, stats.forecast, { days: 14 });
  if (peak) head.append(el('span', { class: 'callout', text: `peak ${peak.count} · ${peak.label}` }));

  main.innerHTML = '';
  main.append(
    el('div', { class: 'home-head' },
      el('div', {},
        el('h1', { class: 'home-greet', text: `${greet}, ${name}.` }),
        el('p', {
          class: 'home-sub',
          text: totalDue > 0
            ? `${totalDue} cards due across ${dueDecks.length} deck${dueDecks.length === 1 ? '' : 's'} · about ${etaMin} minute${etaMin === 1 ? '' : 's'} at your pace`
            : 'Nothing due right now — all caught up.',
        })),
      totalDue > 0
        ? el('button', {
          class: 'btn btn-primary', onclick: () => {
            const d = topDueDeck();
            if (d) navigate(`#/study/${d.id}`);
          },
        }, el('span', { html: icon('bolt', 15) }), 'Start Review', el('span', { class: 'kbd', text: 'space' }))
        : null),
    tilesRow,
    el('div', { class: 'home-grid' },
      decksList,
      el('div', { class: 'home-col' },
        el('div', { class: 'section-label', text: 'Activity' }),
        heatmapCard, forecastCard)));

  // Space starts review from the dashboard.
  const onKey = (e) => {
    if (e.key !== ' ' || (e.target instanceof Element && e.target.closest('input, textarea, select'))) return;
    if (document.body.dataset.view !== 'home') return;
    const d = topDueDeck();
    if (!d) return;
    e.preventDefault();
    navigate(`#/study/${d.id}`);
  };
  document.addEventListener('keydown', onKey);
  window.addEventListener('recall:route-leave', () => document.removeEventListener('keydown', onKey), { once: true });
}

function tile(iconName, color, num, label, sub) {
  return el('div', { class: 'tile' },
    el('div', {
      class: 'tile-icon',
      style: `color:${color};background:color-mix(in srgb, ${color} 14%, transparent)`,
      html: icon(iconName, 16),
    }),
    el('div', { class: 'tile-num', text: num }),
    el('div', { class: 'tile-label', text: label }),
    sub ? el('div', { class: 'tile-sub', text: sub }) : null);
}
