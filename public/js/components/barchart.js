// Forecast / upcoming-load bar chart — plain DOM bars, no canvas/libs.
// data: [{ date: 'YYYY-MM-DD', count }] starting at today.

import { el } from '../ui.js';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function renderBarChart(container, data, { days = 14, ticks = null, footer = true } = {}) {
  const slice = (data || []).slice(0, days);
  const max = slice.reduce((m, d) => Math.max(m, d.count), 0);
  const total = slice.reduce((s, d) => s + d.count, 0);
  let peakIdx = -1;
  slice.forEach((d, i) => { if (d.count === max && max > 0 && peakIdx === -1) peakIdx = i; });
  const peak = peakIdx >= 0
    ? { date: slice[peakIdx].date, count: max, label: WEEKDAYS[new Date(`${slice[peakIdx].date}T12:00:00`).getDay()] }
    : null;

  const chart = el('div', { class: 'barchart', role: 'img', 'aria-label': `Forecast, ${total} reviews scheduled` });
  for (let i = 0; i < days; i++) {
    const d = slice[i] || { date: '', count: 0 };
    const pct = max > 0 ? Math.max(2, Math.round((d.count / max) * 100)) : 2;
    const cls = i === 0 ? 'today' : i === peakIdx ? 'peak' : '';
    chart.append(el('div', { class: 'bc-bar-wrap', title: `${d.date}: ${d.count} due` },
      el('div', { class: `bc-bar ${cls}`, style: `height:${pct}%` })));
  }
  container.append(chart);

  const tickDays = ticks || [0, ...[7, 14, 21, 28].filter((t) => t < days)];
  container.append(el('div', { class: 'bc-ticks' },
    tickDays.map((t) => el('span', { text: t === 0 ? 'today' : `+${t}d` }))));

  if (footer) {
    container.append(el('div', {
      class: 'bc-foot',
      text: `${total} review${total === 1 ? '' : 's'} scheduled · ${days} days`,
    }));
  }
  return { total, peak, max };
}
