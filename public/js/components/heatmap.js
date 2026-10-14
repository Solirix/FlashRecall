// GitHub-style review heatmap — plain DOM grid, no canvas/libs.
// data: [{ date: 'YYYY-MM-DD', count }] (any range; last `weeks` weeks shown).

import { el } from '../ui.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function dayKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function renderHeatmap(container, data, { weeks = 24, legend = true } = {}) {
  const counts = new Map((data || []).map((d) => [d.date, d.count]));
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  // Align the grid so the last column ends on today, columns = weeks.
  const totalDays = weeks * 7;
  const startMs = today.getTime() - (totalDays - 1) * DAY_MS;

  let max = 0;
  let best = null;
  let total = 0;
  for (const [, count] of counts) {
    total += count;
    if (count > max) max = count;
  }
  for (const [date, count] of counts) {
    if (count === max && count > 0) best = { date, count };
  }

  const grid = el('div', { class: 'heatmap', role: 'img', 'aria-label': `Review heatmap, ${total} reviews` });
  for (let i = 0; i < totalDays; i++) {
    const ms = startMs + i * DAY_MS;
    const key = dayKey(ms);
    const count = counts.get(key) || 0;
    let level = 0;
    if (count > 0 && max > 0) level = Math.min(4, Math.max(1, Math.ceil((count / max) * 4)));
    grid.append(el('div', {
      class: `hm-cell${level ? ` l${level}` : ''}`,
      title: `${key}: ${count} review${count === 1 ? '' : 's'}`,
    }));
  }

  const wrap = el('div', { class: 'heatmap-scroll' }, grid);
  container.append(wrap);
  if (legend) {
    container.append(el('div', { class: 'hm-legend' },
      el('span', { text: 'Less' }),
      [0, 1, 2, 3, 4].map((l) => el('span', { class: `hm-cell${l ? ` l${l}` : ''}` })),
      el('span', { text: 'More' }),
      best ? el('span', { class: 'hm-best', text: `best day: ${best.count} cards` }) : null));
  }
  return { total, best };
}
