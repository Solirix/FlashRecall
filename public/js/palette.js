// ⌘K command palette: one search box for decks, cards, tags, pages and actions.
// Decks and pages match instantly in the browser (shared fuzzy scorer); cards
// and tags come from GET /api/search, debounced, abortable, and cached so
// backspacing is instant. Mounted as a .modal-overlay so view key handlers
// (study, home) stand down while it is open.

import { api } from './api.js';
import { el, icon, motionOK } from './ui.js';
import * as fuzzy from './fuzzy.js';
import {
  state, navigate, deckPath, deckColor, deckDue, NAV, goStudy,
} from './app.js';

const DEBOUNCE_MS = 90;
const RECENT_KEY = 'recall.recentSearches';
const FILTER_RE = /(^|\s)-?(deck|tag|is):/i;
const SCOPES = ['all', 'decks', 'cards', 'tags'];
const SCOPE_LABEL = { all: 'All', decks: 'Decks', cards: 'Cards', tags: 'Tags' };

// Built lazily: app.js imports this module, so NAV is not initialised at load time.
let commandsCache = null;
const commands = () => commandsCache || (commandsCache = [
  ...NAV.map((n) => ({
    label: n.label, icon: n.icon, hint: n.name === 'study' ? 'Top due deck' : 'Page',
    keywords: { home: 'dashboard', study: 'review due learn', decks: 'manage', browse: 'cards edit list', test: 'quiz exam practice test', add: 'new card create note', stats: 'statistics heatmap progress' }[n.name] || '',
    run: () => (n.name === 'study' ? goStudy() : navigate(n.hash)),
  })),
  { label: 'New deck', icon: 'plus', hint: 'Action', keywords: 'create deck', run: () => navigate('#/decks?new=1') },
  { label: 'Settings', icon: 'gear', hint: 'Page', keywords: 'preferences theme account accent motion', run: () => navigate('#/settings') },
].map((c) => ({ ...c, fields: [{ text: c.label }, { text: c.keywords, weight: 0.7 }] })));

const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
export const shortcutLabel = isMac ? ['⌘', 'K'] : ['Ctrl', 'K'];

const cache = new Map(); // query -> /api/search response (small LRU)
function remember(q, data) {
  cache.set(q, data);
  if (cache.size > 40) cache.delete(cache.keys().next().value);
}

function loadRecent() {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]').slice(0, 5); } catch { return []; }
}
function saveRecent(q) {
  try {
    const list = [q, ...loadRecent().filter((x) => x !== q)].slice(0, 5);
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch { /* private mode: no history */ }
}

// Text with <mark> around ranges, built as DOM (never innerHTML).
function marked(text, ranges, cls) {
  return el('span', { class: cls }, fuzzy.parts(text, ranges).map((p) => (p.hit ? el('mark', {}, p.text) : p.text)));
}

function dueClass(label) {
  if (label === 'Today') return 'd-today';
  if (label === 'New') return 'd-new';
  if (label === 'Learning') return 'd-learning';
  if (label === 'Susp.' || label === 'Buried') return 'd-susp';
  return 'd-later';
}

let current = null;

export function isPaletteOpen() {
  return !!current;
}

export function togglePalette() {
  if (current) current.close();
  else openPalette();
}

export function openPalette(initial = '') {
  if (current) { current.input.focus(); return current; }
  const returnFocus = document.activeElement;
  let scope = 'all';
  let items = [];
  let active = 0;
  let seq = 0;
  let timer = null;
  let inflight = null;
  let server = null; // latest /api/search response for the current query
  let closed = false;

  const input = el('input', {
    type: 'text', class: 'palette-input', value: initial, spellcheck: 'false', autocomplete: 'off',
    placeholder: 'Search decks, cards, tags, pages…',
    role: 'combobox', 'aria-expanded': 'true', 'aria-controls': 'palette-list', 'aria-autocomplete': 'list',
  });
  const glyph = el('span', { class: 'palette-glyph', html: icon('search', 19) });
  const ms = el('span', { class: 'palette-ms', 'aria-hidden': 'true' });
  const filterChip = el('span', { class: 'palette-filter', text: 'filters', hidden: true });
  const tabs = el('div', { class: 'palette-tabs', role: 'tablist' }, SCOPES.map((s) => el('button', {
    class: `palette-tab${s === scope ? ' on' : ''}`, type: 'button', role: 'tab', tabindex: '-1', dataset: { scope: s },
    onmousedown: (e) => e.preventDefault(),
    onclick: () => setScope(s),
  }, SCOPE_LABEL[s])));
  const cursor = el('div', { class: 'palette-cursor', 'aria-hidden': 'true' });
  const list = el('div', { class: 'palette-list', id: 'palette-list', role: 'listbox' });
  const body = el('div', { class: 'palette-body' }, cursor, list);
  const status = el('span', { class: 'palette-status', role: 'status', 'aria-live': 'polite' });
  const foot = el('div', { class: 'palette-foot' },
    el('span', { class: 'palette-keys' },
      el('span', {}, el('kbd', { class: 'kbd', text: '↑' }), el('kbd', { class: 'kbd', text: '↓' }), ' move'),
      el('span', {}, el('kbd', { class: 'kbd', text: '↵' }), ' open'),
      el('span', {}, el('kbd', { class: 'kbd', text: 'tab' }), ' filter'),
      el('span', { class: 'palette-alt-hint' }, el('kbd', { class: 'kbd', text: isMac ? '⌥↵' : 'Alt ↵' }), ' deck in browse')),
    status);
  const panel = el('div', { class: 'palette', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Search' },
    el('div', { class: 'palette-head' }, glyph, input, filterChip, ms,
      el('kbd', { class: 'kbd palette-esc', text: 'esc' }),
      el('div', { class: 'palette-scan', 'aria-hidden': 'true' })),
    tabs, body, foot);
  const overlay = el('div', {
    class: 'modal-overlay palette-overlay',
    onmousedown: (e) => { if (e.target === overlay) close(); },
  }, panel);

  function close({ restore = true } = {}) {
    if (closed) return;
    closed = true;
    current = null;
    clearTimeout(timer);
    if (inflight) inflight.abort();
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('recall:route-leave', onLeave);
    if (restore && returnFocus && returnFocus.isConnected) returnFocus.focus();
    if (!motionOK()) { overlay.remove(); return; }
    overlay.classList.add('closing');
    setTimeout(() => overlay.remove(), 160);
  }
  const onLeave = () => close({ restore: false });

  function setScope(s) {
    scope = s;
    tabs.querySelectorAll('.palette-tab').forEach((t) => t.classList.toggle('on', t.dataset.scope === s));
    render(false);
  }

  // ---- results ----

  function freeText(q) {
    return q.split(/\s+/).filter((t) => t && !/^-?(deck|tag|is):/i.test(t)).join(' ');
  }

  function deckItems(qterms) {
    if (!qterms.length) return [];
    return state.decks
      .map((d) => {
        const path = deckPath(d);
        const r = fuzzy.scoreText(qterms, path, { subseq: true, min: 0.45 });
        return r && { d, path, r };
      })
      .filter(Boolean)
      .sort((a, b) => b.r.score - a.r.score || deckDue(b.d) - deckDue(a.d))
      .slice(0, scope === 'decks' ? 12 : 5)
      .map(({ d, path, r }) => ({
        group: 'Decks',
        score: r.score,
        node: () => el('div', { class: 'palette-row' },
          el('span', { class: 'palette-row-icon' }, el('span', { class: 'dot', style: `background:${deckColor(d)}` })),
          el('span', { class: 'palette-row-main' }, marked(path, r.ranges, 'palette-row-title')),
          deckDue(d) ? el('span', { class: 'count-badge', text: `${deckDue(d)} due` }) : null,
          el('span', { class: 'palette-row-go', text: 'Study' })),
        run: (alt) => navigate(alt ? `#/browse?q=${encodeURIComponent(`deck:"${d.name}"`)}` : `#/study/${d.id}`),
      }));
  }

  function commandItems(qterms) {
    const scored = qterms.length
      ? commands().map((c) => ({ c, r: fuzzy.scoreFields(qterms, c.fields, { subseq: true, min: 0.45 }) }))
        .filter((x) => x.r).sort((a, b) => b.r.score - a.r.score).slice(0, 4)
      : commands().map((c) => ({ c, r: null }));
    return scored.map(({ c, r }) => ({
      group: qterms.length ? 'Pages & actions' : 'Jump to',
      score: r ? r.score : 0,
      node: () => el('div', { class: 'palette-row' },
        el('span', { class: 'palette-row-icon', html: icon(c.icon, 15) }),
        el('span', { class: 'palette-row-main' }, marked(c.label, r ? r.ranges[0] : [], 'palette-row-title')),
        el('span', { class: 'palette-row-hint', text: c.hint })),
      run: () => c.run(),
    }));
  }

  function cardItems(q) {
    if (!server) return [];
    return server.notes.map((n) => ({
      group: 'Cards',
      node: () => el('div', { class: 'palette-row palette-row-card' },
        el('span', { class: 'palette-row-icon', html: icon(n.type === 'cloze' ? 'book' : 'cards', 15) }),
        el('span', { class: 'palette-row-main' },
          marked(n.title, n.titleMatches, 'palette-row-title'),
          n.snippet ? marked(n.snippet, n.snippetMatches, 'palette-row-sub') : null),
        el('span', { class: 'palette-row-deck', text: n.deckName }),
        el('span', { class: `row-due ${dueClass(n.due)}`, text: n.due })),
      run: () => navigate(`#/browse?q=${encodeURIComponent(q)}&note=${n.id}`),
    }));
  }

  function tagItems() {
    if (!server) return [];
    return server.tags.map((t) => ({
      group: 'Tags',
      node: () => el('div', { class: 'palette-row' },
        el('span', { class: 'palette-row-icon palette-hash', text: '#' }),
        el('span', { class: 'palette-row-main' }, marked(t.name, t.matches, 'palette-row-title')),
        el('span', { class: 'palette-row-hint', text: `${t.count} card${t.count === 1 ? '' : 's'}` })),
      run: () => navigate(`#/browse?q=${encodeURIComponent(`tag:${t.name}`)}`),
    }));
  }

  function recentItems() {
    return loadRecent().map((r) => ({
      group: 'Recent',
      node: () => el('div', { class: 'palette-row' },
        el('span', { class: 'palette-row-icon', html: icon('clock', 15) }),
        el('span', { class: 'palette-row-main' }, el('span', { class: 'palette-row-title', text: r })),
        el('span', { class: 'palette-row-hint', text: 'Search again' })),
      keep: true,
      run: () => { input.value = r; onInput(); },
    }));
  }

  function render(animate) {
    const q = input.value.trim();
    const qterms = fuzzy.terms(freeText(q));
    filterChip.hidden = !FILTER_RE.test(q);
    panel.classList.toggle('has-query', !!q);

    let groups;
    if (!q) {
      groups = [recentItems(), commandItems([])];
    } else {
      const decks = scope === 'all' || scope === 'decks' ? deckItems(qterms) : [];
      const cards = scope === 'all' || scope === 'cards' ? cardItems(q) : [];
      const tags = scope === 'all' || scope === 'tags' ? tagItems() : [];
      const cmds = scope === 'all' ? commandItems(qterms) : [];
      // a page that matches by its name jumps the queue ("stats" -> Stats)
      groups = cmds.length && cmds[0].score >= 1.1 ? [cmds, decks, cards, tags] : [decks, cards, tags, cmds];
      const total = server ? server.total : 0;
      groups.push([{
        group: '',
        node: () => el('div', { class: 'palette-row palette-row-all' },
          el('span', { class: 'palette-row-icon', html: icon('grid', 15) }),
          el('span', { class: 'palette-row-main' }, el('span', { class: 'palette-row-title' },
            'Open ', el('strong', { text: `“${q}”` }), ' in Browse')),
          server ? el('span', { class: 'palette-row-hint', text: `${total}${server.capped ? '+' : ''} card${total === 1 ? '' : 's'}` }) : null,
          el('span', { class: 'palette-row-go', html: icon('caret', 13) })),
        run: () => navigate(`#/browse?q=${encodeURIComponent(q)}`),
      }]);
    }

    items = groups.flat();
    list.innerHTML = '';
    list.classList.toggle('animate', !!animate && motionOK());
    let lastGroup = null;
    let n = 0;
    items.forEach((item, i) => {
      if (item.group && item.group !== lastGroup) {
        list.append(el('div', { class: 'palette-group', role: 'presentation', text: item.group }));
      }
      lastGroup = item.group;
      const row = item.node();
      row.id = `palette-opt-${i}`;
      row.setAttribute('role', 'option');
      row.style.setProperty('--i', String(Math.min(n++, 10)));
      row.addEventListener('mousemove', () => { if (active !== i) setActive(i, false); });
      row.addEventListener('click', (e) => choose(i, e.altKey));
      item.el = row;
      list.append(row);
    });

    const empty = q && !items.some((it) => it.group) && !panel.classList.contains('searching');
    panel.classList.toggle('empty', !!empty);
    if (empty) {
      list.prepend(el('div', { class: 'palette-empty' },
        el('div', { class: 'palette-empty-title', text: 'Nothing matches that — yet' }),
        el('div', { class: 'palette-empty-sub', text: 'Try fewer letters, or filters like deck:"Name", tag:x, is:due.' })));
    }
    status.textContent = q && server ? `${server.notes.length} cards · ${server.tags.length} tags` : '';
    setActive(Math.min(active, Math.max(0, items.length - 1)), false, true);
  }

  function setActive(i, scroll = true, instant = false) {
    active = i;
    items.forEach((it, j) => it.el && it.el.setAttribute('aria-selected', String(j === i)));
    const row = items[i] && items[i].el;
    if (!row) { cursor.style.opacity = '0'; input.removeAttribute('aria-activedescendant'); return; }
    input.setAttribute('aria-activedescendant', row.id);
    cursor.classList.toggle('instant', instant);
    cursor.style.opacity = '1';
    cursor.style.transform = `translateY(${row.offsetTop}px)`;
    cursor.style.height = `${row.offsetHeight}px`;
    if (scroll) row.scrollIntoView({ block: 'nearest' });
  }

  function choose(i, alt = false) {
    const item = items[i];
    if (!item) return;
    const q = input.value.trim();
    if (q && !item.keep) saveRecent(q);
    if (item.keep) { item.run(alt); return; }
    close({ restore: false });
    item.run(alt);
  }

  // ---- fetching ----

  function onInput() {
    const q = input.value.trim();
    active = 0;
    clearTimeout(timer);
    if (inflight) { inflight.abort(); inflight = null; }
    if (!q) {
      server = null;
      panel.classList.remove('searching');
      ms.textContent = '';
      render(true);
      return;
    }
    if (cache.has(q)) {
      server = cache.get(q);
      panel.classList.remove('searching');
      showMs(server.tookMs, true);
      render(true);
      return;
    }
    server = null;
    panel.classList.add('searching');
    render(true); // decks and pages show up instantly
    const mySeq = ++seq;
    timer = setTimeout(async () => {
      const ctrl = new AbortController();
      inflight = ctrl;
      try {
        const data = await api.get(`/api/search?q=${encodeURIComponent(q)}&limit=8`, { signal: ctrl.signal });
        if (mySeq !== seq || closed) return;
        remember(q, data);
        server = data;
        showMs(data.tookMs, false);
      } catch (err) {
        if (ctrl.signal.aborted || mySeq !== seq) return;
        server = { total: 0, notes: [], tags: [] };
        status.textContent = err.message || 'search failed';
      } finally {
        if (mySeq === seq && !closed) {
          inflight = null;
          panel.classList.remove('searching');
          render(false);
        }
      }
    }, DEBOUNCE_MS);
  }

  function showMs(took, cached) {
    ms.textContent = cached ? 'cached' : `${took < 1 ? '<1' : Math.round(took)}ms`;
    ms.classList.remove('tick');
    void ms.offsetWidth; // restart the animation
    ms.classList.add('tick');
  }

  // ---- keys ----

  function onKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault(); e.stopPropagation();
      if (input.value) { input.value = ''; onInput(); } else close();
      return;
    }
    if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) {
      e.preventDefault();
      if (items.length) setActive((active + 1) % items.length);
    } else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) {
      e.preventDefault();
      if (items.length) setActive((active - 1 + items.length) % items.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(active, e.altKey);
    } else if (e.key === 'Tab') {
      e.preventDefault(); // also keeps focus trapped in the palette
      const next = (SCOPES.indexOf(scope) + (e.shiftKey ? SCOPES.length - 1 : 1)) % SCOPES.length;
      setScope(SCOPES[next]);
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault(); e.stopPropagation();
      close();
    }
  }

  input.addEventListener('input', onInput);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('recall:route-leave', onLeave);
  document.getElementById('modal-root').append(overlay);
  current = { close, input };
  input.focus();
  input.select();
  onInput();
  return current;
}
