// #/stats — tiles, big heatmap, forecast, card states, retention by grade, FSRS.

import { api } from '../api.js';
import { el, icon, toast, fmtSecs, fmtDate, skeleton } from '../ui.js';
import { state, refreshDecks } from '../app.js';
import { renderHeatmap } from '../components/heatmap.js';
import { renderBarChart } from '../components/barchart.js';

const RANGES = [
  { label: '1m', days: 30 },
  { label: '3m', days: 90 },
  { label: '1y', days: 365 },
];

export async function render(main) {
  if (!state.decks.length) await refreshDecks().catch(() => {});

  let deckId = null;
  let rangeDays = 90;

  const deckSel = el('select', {
    onchange: () => { deckId = deckSel.value ? Number(deckSel.value) : null; load(); },
  },
  el('option', { value: '', text: 'All decks' }),
  state.decks.map((d) => el('option', { value: d.id, text: d.name })));

  const seg = el('div', { class: 'segmented' }, RANGES.map((r) =>
    el('button', {
      class: r.days === rangeDays ? 'active' : '',
      onclick: (e) => {
        rangeDays = r.days;
        seg.querySelectorAll('button').forEach((b) => b.classList.remove('active'));
        e.currentTarget.classList.add('active');
        load();
      },
    }, r.label)));

  const tilesEl = el('div', { class: 'tiles' });
  const gridEl = el('div', { class: 'stats-grid' });

  main.append(
    el('div', { class: 'stats-head' },
      el('h2', { text: 'Statistics' }),
      el('span', { class: 'spacer' }),
      deckSel, seg),
    tilesEl, gridEl);

  function tile(iconName, color, num, label, sub) {
    return el('div', { class: 'tile' },
      el('div', {
        class: 'tile-icon',
        style: `color:${color};background:color-mix(in srgb, ${color} 14%, transparent)`,
        html: icon(iconName, 16),
      }),
      el('div', { class: 'tile-num', text: num }),
      el('div', { class: 'tile-label', text: label }),
      sub ? el('div', { class: 'tile-sub', html: sub }) : null);
  }

  async function load() {
    tilesEl.innerHTML = '';
    tilesEl.append(...[0, 1, 2, 3].map(() => skeleton(86)));
    gridEl.innerHTML = '';
    gridEl.append(skeleton(300), skeleton(300));

    let s;
    try {
      const qs = `rangeDays=${rangeDays}${deckId ? `&deckId=${deckId}` : ''}`;
      s = await api.get(`/api/stats/summary?${qs}`);
    } catch (err) {
      if (err.status !== 401) toast(err.message || 'stats failed', 'error');
      return;
    }

    const heat = s.heatmap || [];
    const todayCount = heat.length ? heat[heat.length - 1].count : 0;
    const yestCount = heat.length > 1 ? heat[heat.length - 2].count : 0;
    const delta = todayCount - yestCount;
    const deltaHtml = delta === 0 ? 'same as yesterday'
      : `<span class="${delta > 0 ? 'up' : 'down'}">${delta > 0 ? '↑' : '↓'} ${Math.abs(delta)}</span> vs yesterday`;
    const firstDay = heat.find((h) => h.count > 0);

    tilesEl.innerHTML = '';
    tilesEl.append(
      tile('bolt', 'var(--accent)', String(todayCount), 'Reviews today', deltaHtml),
      tile('target', 'var(--green)', s.retention30d != null ? `${s.retention30d}%` : '—', 'Retention · 30d', 'true retention, young+mature'),
      tile('layers', 'var(--blue)', String(s.totalReviews || 0), 'Total reviews',
        firstDay ? `since ${fmtDate(new Date(`${firstDay.date}T12:00:00`).getTime())}` : 'no reviews in range'),
      tile('clock', 'var(--orange)', s.avgAnswerMs != null ? fmtSecs(s.avgAnswerMs) : '—', 'Avg answer time', `last ${rangeDays} days`));

    // --- left column: heatmap + forecast ---
    const weeks = Math.min(52, Math.ceil(rangeDays / 7));
    const heatCard = el('div', { class: 'card' },
      el('div', { class: 'card-head' },
        el('div', {}, el('h3', { text: 'Review heatmap' }),
          el('div', { class: 'card-sub', text: `past ${weeks} weeks · ${heat.reduce((a, h) => a + h.count, 0)} reviews` }))));
    renderHeatmap(heatCard, heat, { weeks });

    const forecastCard = el('div', { class: 'card' });
    const fHead = el('div', { class: 'card-head' },
      el('div', {}, el('h3', { text: 'Forecast' }),
        el('div', { class: 'card-sub', text: `next 30 days · ${(s.forecast || []).reduce((a, f) => a + f.count, 0)} reviews scheduled` })));
    forecastCard.append(fHead);
    const { peak } = renderBarChart(forecastCard, s.forecast, { days: 30, ticks: [0, 7, 14, 21, 28] });
    if (peak) fHead.append(el('span', { class: 'callout', text: `peak ${peak.count} · ${peak.label}` }));

    // --- right column: card states, retention by grade, FSRS ---
    const cs = s.cardStates || { new: 0, learning: 0, young: 0, mature: 0 };
    const csTotal = cs.new + cs.learning + cs.young + cs.mature;
    const segBar = el('div', { class: 'seg-bar' },
      [['--blue', cs.new], ['--orange', cs.learning], ['--violet', cs.young], ['--green', cs.mature]]
        .map(([v, n]) => el('div', {
          style: `width:${csTotal ? (n / csTotal) * 100 : 0}%;background:var(${v})`,
          title: String(n),
        })));
    const statesCard = el('div', { class: 'card' },
      el('div', { class: 'card-head' },
        el('div', {}, el('h3', { text: 'Card states' }), el('div', { class: 'card-sub', text: `${csTotal} cards total` }))),
      segBar,
      el('div', { class: 'legend-grid' },
        legendItem('var(--blue)', 'New', cs.new),
        legendItem('var(--orange)', 'Learning', cs.learning),
        legendItem('var(--violet)', 'Young', cs.young),
        legendItem('var(--green)', 'Mature', cs.mature)),
      el('p', { class: 'card-sub', style: 'margin-top:10px' },
        s.retention30d != null ? `mature cards retained at ${s.retention30d}%` : 'no review data yet'));

    const rbg = s.retentionByGrade || {};
    const maxShare = Math.max(1, ...[1, 2, 3, 4].map((g) => rbg[g]?.pct || 0));
    const gradesCard = el('div', { class: 'card' },
      el('div', { class: 'card-head' }, el('div', {}, el('h3', { text: 'True retention by grade' }))),
      [['Again', 1, 'var(--red)'], ['Hard', 2, 'var(--orange)'], ['Good', 3, 'var(--green)'], ['Easy', 4, 'var(--blue)']]
        .map(([name, g, color]) => {
          const d = rbg[g] || { count: 0, pct: 0 };
          return el('div', { class: 'grade-bar-row' },
            el('span', { text: name }),
            el('div', { class: 'gb-track' },
              el('div', { class: 'gb-fill', style: `width:${(d.pct / maxShare) * 100}%;background:${color}` })),
            el('span', { class: 'gb-n', text: `${d.count}` }));
        }));

    const fsrsCard = el('div', { class: 'card' },
      el('div', { class: 'card-head' }, el('div', {}, el('h3', { text: 'FSRS scheduler' }))),
      el('div', { class: 'kv-row' }, el('span', { text: 'Desired retention' }), el('span', { class: 'v', text: (s.fsrs?.desiredRetention ?? 0.9).toFixed(2) })),
      el('div', { class: 'kv-row' }, el('span', { text: 'Avg stability' }), el('span', { class: 'v', text: s.fsrs?.avgStability != null ? `${s.fsrs.avgStability} d` : '—' })),
      el('div', { class: 'kv-row' }, el('span', { text: 'Leech threshold' }), el('span', { class: 'v', text: `${s.fsrs?.leechThreshold ?? 8} lapses` })),
      el('button', {
        class: 'btn', style: 'width:100%;margin-top:10px',
        onclick: () => toast('Using default FSRS parameters — optimization not available in this build'),
      }, 'Re-optimize'));

    gridEl.innerHTML = '';
    gridEl.append(
      el('div', { class: 'stats-col' }, heatCard, forecastCard),
      el('div', { class: 'stats-col' }, statesCard, gradesCard, fsrsCard));
  }

  function legendItem(color, label, n) {
    return el('div', { class: 'lg' },
      el('span', { class: 'dot', style: `background:${color}` }),
      el('span', { text: label }),
      el('span', { class: 'n', text: String(n) }));
  }

  await load();
}
