// #/decks — manage decks: create, nest, rename/recolour, share, delete, study.

import { el, icon } from '../ui.js';
import { state, navigate, refreshDecks, deckColor } from '../app.js';
import { flatDecks, openDeckEditor, openShareDialog, confirmDeleteDeck } from '../deckdialogs.js';

export async function render(main, params, query) {
  await refreshDecks().catch(() => {});

  const list = el('div', { class: 'deck-manage-list' });
  const headStats = el('span', { class: 'head-stats' });

  const createDeck = async (parentId = null) => {
    if (await openDeckEditor(null, { parentId })) draw();
  };

  function draw() {
    list.innerHTML = '';
    const rows = flatDecks();
    const totalCards = state.decks.reduce((s, d) => {
      const c = d.counts || {};
      return s + (c.new || 0) + (c.learning || 0) + (c.review || 0);
    }, 0);
    headStats.textContent = `${state.decks.length} deck${state.decks.length === 1 ? '' : 's'} · ${totalCards} cards`;

    if (!rows.length) {
      list.append(el('div', { class: 'card deck-empty' },
        el('div', { class: 'deck-empty-icon', html: icon('cards', 28) }),
        el('h3', { text: 'No decks yet' }),
        el('p', { text: 'A deck holds a set of cards you study together — one per subject works well. Nest decks to group them.' }),
        el('button', { class: 'btn btn-primary', onclick: () => createDeck() },
          el('span', { html: icon('plus', 15) }), 'Create your first deck')));
      return;
    }

    for (const { deck, depth } of rows) {
      const c = deck.counts || {};
      const cards = (c.new || 0) + (c.learning || 0) + (c.review || 0);
      const due = (c.new || 0) + (c.due || 0);
      list.append(el('div', { class: 'deck-row deck-manage-row', style: `--depth:${depth}` },
        el('span', { class: 'dot', style: `background:${deckColor(deck)}` }),
        el('div', { class: 'deck-meta' },
          el('div', { class: 'deck-name', text: deck.name }),
          el('div', {
            class: 'deck-path',
            text: `${cards} card${cards === 1 ? '' : 's'} · ${deck.newPerDay} new/day`,
          })),
        el('div', { class: 'deck-chips' },
          c.new ? el('span', { class: 'chip c-new', text: `${c.new} new` }) : null,
          c.learning ? el('span', { class: 'chip c-lrn', text: `${c.learning} lrn` }) : null,
          c.due ? el('span', { class: 'chip c-rev', text: `${c.due} rev` }) : null),
        el('div', { class: 'deck-actions' },
          el('button', {
            class: 'btn', disabled: !due || null, title: due ? 'Study now' : 'Nothing due',
            onclick: () => navigate(`#/study/${deck.id}`),
          }, 'Study'),
          el('button', {
            class: 'icon-btn', title: 'Add cards', 'aria-label': `Add cards to ${deck.name}`,
            html: icon('plus', 16), onclick: () => navigate(`#/add?deck=${deck.id}`),
          }),
          el('button', {
            class: 'icon-btn', title: 'New sub-deck', 'aria-label': `New sub-deck in ${deck.name}`,
            html: icon('layers', 16), onclick: () => createDeck(deck.id),
          }),
          el('button', {
            class: 'icon-btn', title: 'Edit deck', 'aria-label': `Edit ${deck.name}`,
            html: icon('pencil', 16), onclick: async () => { if (await openDeckEditor(deck)) draw(); },
          }),
          el('button', {
            class: 'icon-btn', title: 'Share with another user', 'aria-label': `Share ${deck.name}`,
            html: icon('share', 16), onclick: () => openShareDialog(deck),
          }),
          el('button', {
            class: 'icon-btn icon-danger', title: 'Delete deck', 'aria-label': `Delete ${deck.name}`,
            html: icon('trash', 16), onclick: async () => { if (await confirmDeleteDeck(deck)) draw(); },
          }))));
    }
  }

  main.append(
    el('div', { class: 'browse-head' },
      el('h2', { text: 'Decks' }),
      headStats,
      el('button', { class: 'btn btn-primary', onclick: () => createDeck() },
        el('span', { html: icon('plus', 15) }), 'New deck')),
    list);
  draw();

  // Sidebar "+" and other entry points land here with ?new=1.
  if (query.get('new')) {
    history.replaceState(null, '', '#/decks');
    createDeck();
  }
}
