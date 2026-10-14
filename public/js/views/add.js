// #/add — centered note form: deck picker, basic/cloze toggle, chip-ified tags,
// live cloze-card counter, ⌘↵ submit that keeps deck+tags for rapid entry.

import { api } from '../api.js';
import { el, icon, toast, tagsInput } from '../ui.js';
import { state, refreshDecks } from '../app.js';
import { fillDeckSelect, openDeckEditor } from '../deckdialogs.js';

function clozeCount(text) {
  const re = /\{\{c(\d+)::([^}]*?)\}\}/g;
  const ords = new Set();
  let m;
  while ((m = re.exec(text || ''))) if (parseInt(m[1], 10) > 0) ords.add(m[1]);
  return ords.size;
}

export async function render(main, params, query) {
  if (!state.decks.length) await refreshDecks().catch(() => {});

  let type = 'basic';

  const deckSel = el('select', {});
  const noDeckHint = el('div', { class: 'field-hint', style: 'color:var(--orange)' },
    'You need a deck before adding cards — create one with “New deck”.');
  function fillDecks(selected = deckSel.value || query.get('deck')) {
    fillDeckSelect(deckSel, { selected, none: state.decks.length ? null : '(no decks yet)' });
    noDeckHint.style.display = state.decks.length ? 'none' : '';
  }
  fillDecks();
  const newDeckBtn = el('button', {
    type: 'button', class: 'btn', title: 'Create a new deck',
    onclick: async () => {
      const deck = await openDeckEditor();
      if (deck) fillDecks(deck.id);
    },
  }, el('span', { html: icon('plus', 14) }), 'New deck');

  const typeSeg = el('div', { class: 'segmented' },
    el('button', { type: 'button', class: 'active', onclick: () => setType('basic') }, 'Basic'),
    el('button', { type: 'button', onclick: () => setType('cloze') }, 'Cloze'));

  const front = el('textarea', { rows: 4, placeholder: 'Front…' });
  const clozeHint = el('div', { class: 'field-hint', style: 'display:none' });
  const back = el('textarea', { rows: 4, placeholder: 'Back…' });
  const backField = el('div', { class: 'field' }, el('label', { text: 'Back' }), back);
  const extra = el('textarea', { rows: 2, placeholder: 'Example sentence, source, mnemonics…' });
  const tags = tagsInput();

  function setType(t) {
    type = t;
    typeSeg.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.textContent.toLowerCase() === t));
    clozeHint.style.display = t === 'cloze' ? '' : 'none';
    backField.style.display = t === 'cloze' ? 'none' : '';
    updateClozeHint();
  }

  function updateClozeHint() {
    if (type !== 'cloze') return;
    const n = clozeCount(front.value);
    clozeHint.textContent = n > 0
      ? `Creates ${n} card${n === 1 ? '' : 's'} · use {{c1::…}}, {{c2::…}}`
      : 'Wrap hidden text like {{c1::Paris}} — no markers yet';
    clozeHint.style.color = n > 0 ? 'var(--green)' : 'var(--orange)';
  }
  front.addEventListener('input', updateClozeHint);

  const submitBtn = el('button', { class: 'btn btn-primary', type: 'submit' },
    el('span', { html: icon('plus', 15) }), 'Add card', el('span', { class: 'kbd', text: '⌘↵' }));

  const form = el('form', {
    class: 'card form-card',
    onsubmit: async (e) => {
      e.preventDefault();
      const deckId = Number(deckSel.value);
      if (!deckId) {
        const deck = await openDeckEditor();
        if (!deck) return;
        fillDecks(deck.id);
      }
      submitBtn.disabled = true;
      try {
        await api.post('/api/notes', {
          deckId: Number(deckSel.value), type,
          front: front.value, back: type === 'cloze' ? '' : back.value,
          extra: extra.value, tags: tags.getTags().join(' '),
        });
        toast('Added', 'success');
        front.value = '';
        back.value = '';
        extra.value = '';
        updateClozeHint();
        front.focus();
      } catch (err) {
        toast(err.message || 'add failed', 'error');
      } finally {
        submitBtn.disabled = false;
      }
    },
  },
  el('h2', { text: 'Add card' }),
  el('div', { class: 'field' }, el('label', { text: 'Deck' }),
    el('div', { style: 'display:flex;gap:8px' }, el('div', { style: 'flex:1;min-width:0' }, deckSel), newDeckBtn),
    noDeckHint),
  el('div', { class: 'field' }, el('label', { text: 'Type' }), el('div', {}, typeSeg)),
  el('div', { class: 'field' }, el('label', { text: 'Front' }), front, clozeHint),
  backField,
  el('div', { class: 'field' }, el('label', { text: 'Extra (optional)' }), extra),
  el('div', { class: 'field' }, el('label', { text: 'Tags' }), tags.node),
  el('div', { style: 'display:flex;justify-content:flex-end' }, submitBtn));

  form.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') form.requestSubmit();
  });

  main.append(form);
  setType('basic');
}
