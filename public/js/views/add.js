// #/add — centered note form: deck picker, basic/cloze toggle, chip-ified tags,
// live cloze-card counter, ⌘↵ submit that keeps deck+tags for rapid entry.

import { api } from '../api.js';
import { el, icon, toast, tagsInput } from '../ui.js';
import { state, refreshDecks } from '../app.js';

function clozeCount(text) {
  const re = /\{\{c(\d+)::([^}]*?)\}\}/g;
  const ords = new Set();
  let m;
  while ((m = re.exec(text || ''))) if (parseInt(m[1], 10) > 0) ords.add(m[1]);
  return ords.size;
}

export async function render(main) {
  if (!state.decks.length) await refreshDecks().catch(() => {});

  let type = 'basic';

  // Deck dropdown grouped by parent.
  const deckSel = el('select', {});
  function fillDecks() {
    deckSel.innerHTML = '';
    const roots = state.decks.filter((d) => d.parentId == null);
    const kids = (pid) => state.decks.filter((d) => d.parentId === pid);
    for (const root of roots) {
      const group = el('optgroup', { label: root.name });
      group.append(el('option', { value: root.id, text: root.name }));
      for (const k of kids(root.id)) group.append(el('option', { value: k.id, text: `　${k.name}` }));
      deckSel.append(group);
    }
    const orphans = state.decks.filter((d) => d.parentId != null && !state.decks.some((p) => p.id === d.parentId));
    for (const o of orphans) deckSel.append(el('option', { value: o.id, text: o.name }));
    if (!state.decks.length) deckSel.append(el('option', { value: '', text: '(no decks yet)' }));
  }
  fillDecks();

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
      if (!deckId) { toast('Create a deck first', 'error'); return; }
      submitBtn.disabled = true;
      try {
        await api.post('/api/notes', {
          deckId, type,
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
  el('div', { class: 'field' }, el('label', { text: 'Deck' }), deckSel),
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
