// FlashRecall app entry: hash router, auth gate, shell (sidebar/topbar/bottomnav),
// theming, global keys, sync indicator.

import { api, setUnauthorizedHandler } from './api.js';
import { el, icon, toast, initials, relTime } from './ui.js';

export const state = {
  user: null,
  decks: [],
  settings: null,
  lastSync: null,
  route: { name: 'home', params: [], query: new URLSearchParams() },
};

const DECK_PALETTE = ['--teal', '--yellow', '--blue', '--violet', '--green', '--orange', '--red'];

// ---------- theming ----------

export function cacheSettings(patch) {
  let cached = {};
  try { cached = JSON.parse(localStorage.getItem('recall.settings') || '{}'); } catch { /* fresh */ }
  const merged = { ...cached, ...patch };
  localStorage.setItem('recall.settings', JSON.stringify(merged));
  return merged;
}

export function applyTheme(settings) {
  if (!settings) return;
  const root = document.documentElement;
  const cached = cacheSettings(settings);
  root.dataset.theme = settings.theme || 'recall-dark';
  if (settings.accent) root.style.setProperty('--accent', settings.accent);
  else root.style.removeProperty('--accent');
  root.style.setProperty('--font-size', `${settings.fontSize || 16}px`);
  root.style.setProperty('--radius', `${settings.borderRadius ?? 12}px`);
  if (cached.tint) root.style.setProperty('--tint', cached.tint);
  else root.style.removeProperty('--tint');
  if (settings.reducedMotion) root.dataset.motion = 'reduced';
  else delete root.dataset.motion;
}

// ---------- deck helpers ----------

export function deckColor(deck) {
  if (deck.color) return deck.color;
  let h = 0;
  for (const ch of String(deck.id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `var(${DECK_PALETTE[h % DECK_PALETTE.length]})`;
}

export function deckById(id) {
  return state.decks.find((d) => d.id === Number(id)) || null;
}

export function deckPath(deck) {
  const parts = [];
  let cur = deck;
  let guard = 0;
  while (cur && guard++ < 20) {
    parts.unshift(cur.name);
    cur = cur.parentId != null ? deckById(cur.parentId) : null;
  }
  return parts.join(' / ');
}

export function deckDue(deck) {
  const c = deck.counts || { new: 0, due: 0 };
  return (c.new || 0) + (c.due || 0);
}

export function topDueDeck() {
  let best = null;
  for (const d of state.decks) {
    if (deckDue(d) > 0 && (!best || deckDue(d) > deckDue(best))) best = d;
  }
  return best;
}

export async function refreshDecks() {
  state.decks = await api.get('/api/decks/tree');
  renderSidebarDecks();
  return state.decks;
}

// ---------- sync indicator ----------

export function markSynced() {
  state.lastSync = Date.now();
  updateSyncLabels();
}

function updateSyncLabels() {
  const label = `Synced · ${state.lastSync ? relTime(state.lastSync) : '—'}`;
  for (const n of document.querySelectorAll('[data-sync-label]')) n.textContent = label;
}

// ---------- shell ----------

const NAV = [
  { name: 'home', label: 'Home', icon: 'home', hash: '#/home' },
  { name: 'study', label: 'Study', icon: 'layers', hash: null }, // resolves to top-due deck
  { name: 'decks', label: 'Decks', icon: 'cards', hash: '#/decks' },
  { name: 'browse', label: 'Browse', icon: 'grid', hash: '#/browse' },
  { name: 'add', label: 'Add card', icon: 'plus', hash: '#/add' },
  { name: 'stats', label: 'Stats', icon: 'chart', hash: '#/stats' },
];

export function navigate(hash) {
  if (location.hash === hash) route();
  else location.hash = hash;
}

function goStudy() {
  const deck = topDueDeck();
  if (deck) navigate(`#/study/${deck.id}`);
  else {
    toast('All caught up — nothing due', 'success');
    navigate('#/home');
  }
}

function navHandler(item) {
  return (e) => {
    e.preventDefault();
    document.body.classList.remove('nav-open');
    if (item.name === 'study') goStudy();
    else navigate(item.hash);
  };
}

function renderSidebar() {
  const brand = el('div', { class: 'brand' },
    el('div', { class: 'brand-logo', html: icon('bolt', 17) }),
    el('div', {},
      el('div', { class: 'brand-name', text: 'RECALL' }),
      el('div', { class: 'brand-tag', text: 'flashcards, fast' })));

  const menu = el('div', { class: 'side-section' },
    el('div', { class: 'side-label', text: 'Menu' }),
    NAV.map((item) => el('a', {
      class: `side-item${state.route.name === item.name ? ' active' : ''}`,
      href: item.hash || '#/study',
      dataset: { nav: item.name },
      onclick: navHandler(item),
      html: icon(item.icon, 16),
    }, el('span', { text: item.label }))));

  const deckSection = el('div', { class: 'side-section', id: 'side-decks' },
    el('div', { class: 'side-label' },
      el('a', { class: 'side-label-link', href: '#/decks', text: 'Decks', title: 'Manage decks' }),
      el('span', { class: 'side-label-right' },
        el('span', { text: 'Due' }),
        el('a', {
          class: 'side-add', href: '#/decks?new=1', title: 'New deck', 'aria-label': 'New deck',
          html: icon('plus', 13), onclick: () => document.body.classList.remove('nav-open'),
        }))));

  const user = state.user;
  const bottom = el('div', { class: 'side-bottom' },
    el('div', { class: 'sync-line' },
      el('span', { class: 'sync-dot' }),
      el('span', { 'data-sync-label': '', text: 'Synced · —' }),
      el('button', {
        title: 'Refresh decks', html: icon('sync', 14),
        onclick: async () => { await refreshDecks().catch(() => {}); markSynced(); route(); },
      })),
    el('div', { class: 'user-chip' },
      el('span', { class: 'avatar', text: initials(user ? user.displayName || user.username : '?') }),
      el('span', { class: 'user-name', text: user ? (user.displayName || user.username) : '' }),
      el('a', { class: 'gear', href: '#/settings', title: 'Settings', html: icon('gear', 16) })));

  const sidebar = el('aside', { id: 'sidebar' }, brand, menu, deckSection, bottom);
  renderSidebarDecks(sidebar.querySelector('#side-decks'));
  return sidebar;
}

function renderSidebarDecks(container) {
  const host = container || document.getElementById('side-decks');
  if (!host) return;
  host.querySelectorAll('.deck-tree').forEach((n) => n.remove());
  const tree = el('div', { class: 'deck-tree' });
  const childrenOf = (pid) => state.decks.filter((d) => (d.parentId ?? null) === pid);
  const addNodes = (parentEl, pid) => {
    for (const deck of childrenOf(pid)) {
      const kids = childrenOf(deck.id);
      const due = deckDue(deck);
      const caret = kids.length
        ? el('button', {
          class: 'deck-caret', html: icon('caret', 12),
          onclick: (e) => {
            e.preventDefault(); e.stopPropagation();
            e.currentTarget.classList.toggle('open');
            childBox.classList.toggle('collapsed');
          },
        })
        : el('span', { class: 'dot', style: `background:${deckColor(deck)}` });
      const childBox = el('div', { class: 'deck-children collapsed' });
      const node = el('div', { class: 'deck-node' },
        el('a', {
          class: 'side-item', href: `#/study/${deck.id}`,
          onclick: () => document.body.classList.remove('nav-open'),
        },
        caret,
        kids.length ? el('span', { class: 'dot', style: `background:${deckColor(deck)}` }) : null,
        el('span', { text: deck.name, style: 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }),
        el('span', { class: `count-badge${due ? '' : ' zero'}`, text: String(due) })),
        childBox);
      parentEl.append(node);
      addNodes(childBox, deck.id);
    }
  };
  addNodes(tree, null);
  if (!state.decks.length) {
    tree.append(el('a', {
      class: 'side-item side-empty', href: '#/decks?new=1',
      onclick: () => document.body.classList.remove('nav-open'),
      html: icon('plus', 14),
    }, el('span', { text: 'Create a deck' })));
  }
  host.append(tree);
  updateSyncLabels();
}

function renderTopbar() {
  const searchInput = el('input', {
    id: 'global-search', type: 'text', placeholder: 'Search cards, decks, tags…',
    onkeydown: (e) => {
      if (e.key === 'Enter') {
        const q = searchInput.value.trim();
        navigate(`#/browse${q ? `?q=${encodeURIComponent(q)}` : ''}`);
        searchInput.blur();
      }
    },
  });
  return el('header', { id: 'topbar' },
    el('button', {
      class: 'hamburger', html: icon('menu', 20), 'aria-label': 'Menu',
      onclick: () => {
        document.body.classList.toggle('nav-open');
        if (document.body.classList.contains('nav-open')) {
          const scrim = el('div', {
            class: 'nav-scrim',
            onclick: () => { document.body.classList.remove('nav-open'); scrim.remove(); },
          });
          document.getElementById('app').append(scrim);
        } else {
          document.querySelector('.nav-scrim')?.remove();
        }
      },
    }),
    el('div', { class: 'search-box' },
      el('span', { html: icon('search', 15) }), searchInput, el('span', { class: 'kbd', text: '⌘K' })),
    el('div', { class: 'topbar-right' },
      el('span', { class: 'sync-pill' },
        el('span', { html: icon('sync', 12) }),
        el('span', { class: 'sync-pill-text', 'data-sync-label': '', text: 'Synced' })),
      el('span', {
        class: 'avatar',
        text: initials(state.user ? state.user.displayName || state.user.username : '?'),
      }),
      el('a', { class: 'add-fab', href: '#/add', title: 'Add card', html: icon('plus', 17) })));
}

function renderBottomnav() {
  return el('nav', { id: 'bottomnav' }, NAV.map((item) => el('a', {
    class: `bn-item${state.route.name === item.name ? ' active' : ''}`,
    href: item.hash || '#/study',
    dataset: { nav: item.name },
    onclick: navHandler(item),
    html: icon(item.icon, 19),
  }, el('span', { text: item.label }))));
}

let shellUser = null; // user the current shell was rendered for

function renderShell() {
  const app = document.getElementById('app');
  app.innerHTML = '';
  shellUser = state.user;
  document.querySelector('.nav-scrim')?.remove();
  document.body.classList.remove('nav-open');
  const wrap = el('div', { class: 'main-wrap' }, renderTopbar(), el('main', { id: 'main' }));
  app.append(renderSidebar(), wrap, renderBottomnav());
  markSynced();
}

// ---------- router ----------

const ROUTES = [
  { re: /^login$/, name: 'auth', view: 'auth' },
  { re: /^home$/, name: 'home', view: 'home' },
  { re: /^study\/(\d+)$/, name: 'study', view: 'study' },
  { re: /^decks$/, name: 'decks', view: 'decks' },
  { re: /^browse$/, name: 'browse', view: 'browse' },
  { re: /^add$/, name: 'add', view: 'add' },
  { re: /^stats$/, name: 'stats', view: 'stats' },
  { re: /^settings$/, name: 'settings', view: 'settings' },
];

const viewCache = {};
async function loadView(name) {
  if (!viewCache[name]) viewCache[name] = await import(`./views/${name}.js`);
  return viewCache[name];
}

let routeToken = 0;

export async function route() {
  const token = ++routeToken;
  const raw = (location.hash || '#/home').slice(1);
  const [pathPart, queryPart] = raw.split('?');
  const path = pathPart.replace(/^\//, '') || 'home';
  const query = new URLSearchParams(queryPart || '');

  if (!state.user) {
    if (path !== 'login') { location.hash = '#/login'; return; }
  } else if (path === 'login') {
    location.hash = '#/home';
    return;
  }

  let matched = null;
  let params = [];
  for (const r of ROUTES) {
    const m = r.re.exec(path);
    if (m) { matched = r; params = m.slice(1); break; }
  }
  if (!matched) { location.hash = state.user ? '#/home' : '#/login'; return; }

  state.route = { name: matched.name, params, query };
  document.body.dataset.view = matched.name === 'auth' ? 'auth' : matched.name;

  if (matched.name === 'auth' || !document.getElementById('main') || shellUser !== state.user) renderShell();
  document.querySelectorAll('#sidebar .side-item[data-nav], #bottomnav .bn-item[data-nav]').forEach((n) => {
    n.classList.toggle('active', n.dataset.nav === matched.name);
  });
  document.querySelectorAll('#side-decks .side-item').forEach((n) => {
    n.classList.toggle('active',
      matched.name === 'study' && n.getAttribute('href') === `#/study/${params[0]}`);
  });

  const main = document.getElementById('main');
  window.dispatchEvent(new CustomEvent('recall:route-leave')); // views clean up listeners/timers here
  main.innerHTML = '';
  try {
    const mod = await loadView(matched.view);
    if (token !== routeToken) return; // superseded by a newer navigation
    await mod.render(main, params, query);
  } catch (err) {
    if (token !== routeToken) return;
    if (err && err.status === 401) return; // handler redirects to login
    console.error(err);
    main.append(el('div', { class: 'view-empty', text: (err && err.message) || 'Something went wrong' }));
  }
}

// ---------- global keys ----------

document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    const input = document.getElementById('global-search');
    if (input) { input.focus(); input.select(); }
  }
});

// ---------- boot ----------

async function boot() {
  setUnauthorizedHandler(() => {
    if (state.user) {
      state.user = null;
      toast('Session expired — please sign in again', 'error');
    }
    navigate('#/login');
  });
  window.addEventListener('hashchange', route);
  window.addEventListener('recall:write', markSynced);
  setInterval(updateSyncLabels, 30000);

  try {
    const me = await api.get('/api/me');
    state.user = me;
    state.settings = me.settings;
    applyTheme(me.settings);
    await refreshDecks().catch(() => {});
  } catch {
    state.user = null;
  }
  if (!location.hash) location.hash = state.user ? '#/home' : '#/login';
  await route();
}

boot();
