// Deck management dialogs shared by the Decks page, sidebar, home and add views:
// create/edit (name, parent, colour, daily new cards), share, delete.

import { api } from './api.js';
import { el, toast, openModal } from './ui.js';
import { state, refreshDecks, deckById } from './app.js';

const SWATCHES = ['--teal', '--blue', '--violet', '--green', '--yellow', '--orange', '--red'];

// Decks in tree order with their depth, optionally skipping one deck's subtree.
export function flatDecks(excludeId = null) {
  const out = [];
  const walk = (pid, depth) => {
    for (const d of state.decks.filter((x) => (x.parentId ?? null) === pid)) {
      if (d.id === excludeId) continue;
      out.push({ deck: d, depth });
      walk(d.id, depth + 1);
    }
  };
  walk(null, 0);
  // Decks whose parent is missing would otherwise never be reached.
  for (const d of state.decks) {
    if (d.id !== excludeId && !out.some((o) => o.deck.id === d.id)
        && !(excludeId != null && isDescendant(d, excludeId))) out.push({ deck: d, depth: 0 });
  }
  return out;
}

function isDescendant(deck, ancestorId) {
  let cur = deck;
  for (let guard = 0; cur && guard < 100; guard++) {
    if (cur.parentId === ancestorId) return true;
    cur = cur.parentId != null ? deckById(cur.parentId) : null;
  }
  return false;
}

// Fill a <select> with indented deck options.
export function fillDeckSelect(select, { selected = null, excludeId = null, none = null } = {}) {
  select.innerHTML = '';
  if (none) select.append(el('option', { value: '', text: none }));
  for (const { deck, depth } of flatDecks(excludeId)) {
    select.append(el('option', {
      value: deck.id,
      text: `${'　'.repeat(depth)}${deck.name}`,
      selected: deck.id === Number(selected) || null,
    }));
  }
}

function swatchPicker(initial) {
  let value = initial || null;
  const custom = el('input', {
    type: 'color', title: 'Custom colour',
    value: initial && initial.startsWith('#') ? initial : '#7c6cff',
  });
  const row = el('div', { class: 'swatch-row' });
  const draw = () => {
    row.querySelectorAll('.swatch').forEach((b) => b.classList.toggle('on', (b.dataset.value || null) === value));
    custom.classList.toggle('on', !!value && value.startsWith('#'));
  };
  const swatch = (val, label, bg) => el('button', {
    type: 'button', class: 'swatch', title: label, 'aria-label': label,
    dataset: { value: val || '' },
    style: `background:${bg}`,
    onclick: () => { value = val; draw(); },
  });
  row.append(
    swatch(null, 'Automatic', 'conic-gradient(var(--teal), var(--blue), var(--violet), var(--orange), var(--teal))'),
    ...SWATCHES.map((v) => swatch(`var(${v})`, v.slice(2), `var(${v})`)),
    custom);
  custom.addEventListener('input', () => { value = custom.value; draw(); });
  draw();
  return { node: row, get: () => value };
}

// Create (deck = null) or edit a deck. Resolves to the saved deck, or null if cancelled.
export function openDeckEditor(deck = null, { parentId = null } = {}) {
  return new Promise((resolve) => {
    let saved = null;
    const name = el('input', { type: 'text', value: deck ? deck.name : '', placeholder: 'e.g. Spanish vocab', maxlength: 100 });
    const parent = el('select', {});
    fillDeckSelect(parent, {
      selected: deck ? deck.parentId : parentId, excludeId: deck ? deck.id : null, none: '— none (top level) —',
    });
    const newPerDay = el('input', { type: 'number', min: 0, max: 9999, value: deck ? deck.newPerDay : 20 });
    const colour = swatchPicker(deck ? deck.color : null);
    const errBox = el('div', { class: 'form-error', role: 'alert' });

    const save = async (close) => {
      errBox.textContent = '';
      const body = {
        name: name.value.trim(),
        parentId: parent.value ? Number(parent.value) : null,
        color: colour.get(),
        newPerDay: Number(newPerDay.value),
      };
      if (!body.name) { errBox.textContent = 'Give the deck a name.'; name.focus(); return; }
      if (!Number.isInteger(body.newPerDay) || body.newPerDay < 0 || body.newPerDay > 9999) {
        errBox.textContent = 'New cards per day must be a whole number from 0 to 9999.'; return;
      }
      try {
        saved = deck
          ? await api.patch(`/api/decks/${deck.id}`, body)
          : await api.post('/api/decks', body);
        await refreshDecks();
        toast(deck ? 'Deck saved' : `Created “${saved.name}”`, 'success');
        close();
      } catch (err) {
        errBox.textContent = err.message || 'save failed';
      }
    };

    const form = el('form', { onsubmit: (e) => { e.preventDefault(); save(modal.close); } },
      el('div', { class: 'field' }, el('label', { text: 'Name' }), name),
      el('div', { class: 'field' }, el('label', { text: 'Inside deck' }), parent,
        el('div', { class: 'field-hint', text: 'Nest decks to group them, e.g. Languages › Spanish.' })),
      el('div', { class: 'field' }, el('label', { text: 'Colour' }), colour.node),
      el('div', { class: 'field' }, el('label', { text: 'New cards per day' }), newPerDay),
      errBox,
      el('button', { type: 'submit', hidden: true }));

    const modal = openModal({
      title: deck ? 'Edit deck' : 'New deck',
      content: form,
      actions: [
        { label: 'Cancel' },
        { label: deck ? 'Save' : 'Create deck', class: 'btn-primary', onClick: save },
      ],
      onClose: () => resolve(saved),
    });
    name.focus();
  });
}

export function openShareDialog(deck) {
  const user = el('input', { type: 'text', placeholder: 'their username', autocomplete: 'off' });
  const errBox = el('div', { class: 'form-error', role: 'alert' });
  const send = async (close) => {
    errBox.textContent = '';
    const toUsername = user.value.trim();
    if (!toUsername) { errBox.textContent = 'Enter a username.'; return; }
    try {
      await api.post('/api/shares', { deckId: deck.id, toUsername });
      toast(`Sent “${deck.name}” to ${toUsername}`, 'success');
      close();
    } catch (err) {
      errBox.textContent = err.message || 'share failed';
    }
  };
  const modal = openModal({
    title: `Share “${deck.name}”`,
    content: el('form', { onsubmit: (e) => { e.preventDefault(); send(modal.close); } },
      el('p', {
        class: 'modal-text',
        text: 'They get their own copy of this deck’s cards (with fresh scheduling) once they accept it under Settings › Sharing.',
      }),
      el('div', { class: 'field' }, el('label', { text: 'Send to' }), user),
      errBox,
      el('button', { type: 'submit', hidden: true })),
    actions: [{ label: 'Cancel' }, { label: 'Send copy', class: 'btn-primary', onClick: send }],
  });
  user.focus();
}

// Resolves true when the deck was deleted.
export function confirmDeleteDeck(deck) {
  return new Promise((resolve) => {
    let deleted = false;
    const c = deck.counts || {};
    const cards = (c.new || 0) + (c.learning || 0) + (c.review || 0);
    const kids = state.decks.filter((d) => d.parentId === deck.id).length;
    openModal({
      title: `Delete “${deck.name}”?`,
      content: el('div', {},
        el('p', {
          class: 'modal-text',
          text: `This permanently deletes the deck and its ${cards} card${cards === 1 ? '' : 's'}, including review history. This can’t be undone.`,
        }),
        kids ? el('p', {
          class: 'modal-text',
          text: `Its ${kids} sub-deck${kids === 1 ? '' : 's'} will be kept and moved up a level.`,
        }) : null),
      actions: [
        { label: 'Cancel' },
        {
          label: 'Delete deck', class: 'btn-danger-solid',
          onClick: async (close) => {
            try {
              await api.del(`/api/decks/${deck.id}`);
              deleted = true;
              await refreshDecks();
              toast(`Deleted “${deck.name}”`, 'success');
            } catch (err) {
              toast(err.message || 'delete failed', 'error');
            }
            close();
          },
        },
      ],
      onClose: () => resolve(deleted),
    });
  });
}

