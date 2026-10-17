// #/browse — three panes: decks+tags, card list, edit panel. Query mini-language
// is evaluated server-side (deck:"Name" tag:x is:due …).

import { api } from '../api.js';
import { el, icon, toast, openModal, mdInline, fmtDate, skeleton, tagsInput } from '../ui.js';
import { state, navigate, refreshDecks, deckColor } from '../app.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function dueClass(label) {
  if (label === 'Today') return 'd-today';
  if (label === 'New') return 'd-new';
  if (label === 'Learning') return 'd-learning';
  if (label === 'Susp.' || label === 'Buried') return 'd-susp';
  return 'd-later';
}

function wrapSelection(textarea, before, after = before) {
  const { selectionStart: s, selectionEnd: e, value } = textarea;
  const sel = value.slice(s, e) || '';
  textarea.value = value.slice(0, s) + before + sel + after + value.slice(e);
  textarea.focus();
  textarea.selectionStart = s + before.length;
  textarea.selectionEnd = s + before.length + sel.length;
  textarea.dispatchEvent(new Event('input'));
}

export async function render(main, params, query) {
  const q = query.get('q') || '';

  const queryInput = el('input', { type: 'text', value: q, placeholder: 'deck:"Name" tag:x is:due -is:suspended …', spellcheck: 'false' });
  const headStats = el('span', { class: 'head-stats', text: '…' });
  const decksPane = el('div', { class: 'pane browse-decks pane-active' });
  const listPane = el('div', { class: 'pane' });
  const editPane = el('div', { class: 'pane edit-panel' }, el('div', { class: 'edit-empty', text: 'Select a card to edit' }));
  const grid = el('div', { class: 'browse-grid' }, decksPane, listPane, editPane);

  const tabs = el('div', { class: 'pane-tabs' }, ['Decks', 'Cards', 'Edit'].map((label, i) =>
    el('button', {
      class: `btn ${i === 1 ? '' : 'btn-ghost'}`, style: 'flex:1',
      onclick: (e) => {
        [decksPane, listPane, editPane].forEach((p, j) => p.classList.toggle('pane-active', j === i));
        tabs.querySelectorAll('.btn').forEach((b) => b.classList.add('btn-ghost'));
        e.currentTarget.classList.remove('btn-ghost');
      },
    }, label)));

  main.append(
    el('div', { class: 'browse-head' },
      el('h2', { text: 'Browse' }),
      headStats,
      el('button', { class: 'btn btn-primary', onclick: () => navigate('#/add') },
        el('span', { html: icon('plus', 14) }), 'Add card')),
    el('div', { class: 'browse-query' },
      el('span', { html: icon('search', 15) }), queryInput,
      el('button', { class: 'btn', style: 'min-height:28px;padding:3px 14px', onclick: () => submitQuery() }, 'Search')),
    tabs, grid);

  listPane.append(skeleton(300));
  decksPane.append(skeleton(200));

  function submitQuery() {
    const v = queryInput.value.trim();
    navigate(`#/browse${v ? `?q=${encodeURIComponent(v)}` : ''}`);
  }
  queryInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitQuery(); });

  if (!state.decks.length) await refreshDecks().catch(() => {});

  let data;
  try {
    data = await api.get(`/api/browse?q=${encodeURIComponent(q)}&limit=200`);
  } catch (err) {
    if (err.status !== 401) toast(err.message || 'browse failed', 'error');
    listPane.innerHTML = '';
    listPane.append(el('div', { class: 'view-empty', text: err.message || 'failed to load' }));
    return;
  }

  const notes = data.notes || [];
  const totalLabel = `${data.total.toLocaleString()}${data.capped ? '+' : ''}`;
  const dueCount = notes.filter((n) => n.due === 'Today' || n.due === 'Learning').length;
  const leechCount = notes.filter((n) => (n.tags || '').split(/\s+/).includes('leech')).length;
  headStats.textContent = `${totalLabel} notes · ${dueCount} due · ${leechCount} leeches`;

  // ---- left pane: decks + tags ----
  decksPane.innerHTML = '';
  decksPane.append(el('div', { class: 'section-label', style: 'margin-bottom:6px', text: 'Decks' }));
  for (const d of state.decks.filter((dk) => dk.parentId == null)) {
    decksPane.append(deckQueryItem(d, 0));
    for (const k of state.decks.filter((dk) => dk.parentId === d.id)) decksPane.append(deckQueryItem(k, 1));
  }
  const allTags = new Map();
  for (const n of notes) {
    for (const t of (n.tags || '').split(/\s+/).filter(Boolean)) allTags.set(t, (allTags.get(t) || 0) + 1);
  }
  if (allTags.size) {
    decksPane.append(el('div', { class: 'section-label', style: 'margin:14px 0 6px', text: 'Tags' }));
    decksPane.append(el('div', { class: 'browse-tags' },
      [...allTags.entries()].sort((a, b) => b[1] - a[1]).slice(0, 24).map(([t, n]) =>
        el('button', {
          class: `tag-chip${t === 'leech' ? ' leech' : ''}`,
          onclick: () => {
            const term = `tag:${t}`;
            if (!queryInput.value.includes(term)) {
              queryInput.value = `${queryInput.value.trim()} ${term}`.trim();
              submitQuery();
            }
          },
        }, `#${t}`, n > 1 ? ` ${n}` : ''))));
    decksPane.append(el('p', { class: 'pane-note', text: 'Tags are shared across decks. Click one to filter.' }));
  }

  function deckQueryItem(d, depth) {
    const c = d.counts || {};
    const total = (c.new || 0) + (c.due || 0);
    return el('button', {
      class: 'side-item', style: depth ? 'padding-left:22px' : '',
      onclick: () => {
        queryInput.value = `deck:"${d.name}"`;
        submitQuery();
      },
    },
    el('span', { class: 'dot', style: `background:${deckColor(d)}` }),
    el('span', { text: d.name, style: 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }),
    el('span', { class: `count-badge${total ? '' : ' zero'}`, text: String(total) }));
  }

  // ---- middle pane: card rows ----
  listPane.innerHTML = '';
  listPane.append(el('div', { class: 'card-head', style: 'margin-bottom:6px' },
    el('span', { class: 'section-label', text: 'Front' }),
    el('span', { class: 'section-label', text: 'Due' })));
  const list = el('div', { class: 'card-list' });
  if (!notes.length) {
    list.append(el('div', { class: 'view-empty', text: 'No notes match this query.' }));
  }
  for (const n of notes) {
    const rowEl = el('div', { class: 'card-row', tabindex: '0', role: 'button' });
    rowEl.addEventListener('click', () => selectNote(n, rowEl));
    rowEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') selectNote(n, rowEl); });
    rowEl.append(
      el('input', { type: 'checkbox', 'aria-label': 'select', onclick: (e) => { e.stopPropagation(); selectNote(n, rowEl); } }),
      el('span', { class: 'row-front', html: mdInline(n.front.split('\n')[0]) }),
      el('span', { class: `row-due ${dueClass(n.due)}`, text: n.due }),
      ...(n.flagged ? [el('span', { class: 'row-flag', html: icon('flag', 13) })] : []));
    list.append(rowEl);
  }
  listPane.append(list,
    el('div', { class: 'list-foot', text: `${notes.length} of ${totalLabel} shown · ${data.sort === 'relevance' ? 'best match first' : 'newest first'}` }));

  // deep link from the search palette: #/browse?q=…&note=ID
  const focusId = Number(query.get('note'));
  if (focusId) {
    const idx = notes.findIndex((n) => n.id === focusId);
    const rowEl = idx === -1 ? null : list.children[idx];
    selectNote(idx === -1 ? { id: focusId } : notes[idx], rowEl);
    if (rowEl) rowEl.scrollIntoView({ block: 'center' });
    if (window.matchMedia('(max-width: 640px)').matches) tabs.children[2].click();
  }

  function selectNote(n, rowEl) {
    list.querySelectorAll('.card-row').forEach((r) => r.classList.remove('selected'));
    if (rowEl) rowEl.classList.add('selected');
    renderEdit(n);
  }

  // ---- right pane: edit ----

  async function renderEdit(row) {
    editPane.innerHTML = '';
    editPane.append(el('div', { class: 'spinner', style: 'margin:30px auto' }));
    let note;
    try {
      note = await api.get(`/api/notes/${row.id}`);
    } catch (err) {
      editPane.innerHTML = '';
      editPane.append(el('div', { class: 'view-empty', text: err.message || 'failed to load note' }));
      return;
    }

    const deckSel = el('select', {},
      state.decks.map((d) => el('option', { value: d.id, text: d.name, selected: d.id === note.deckId || null })));
    const typeSel = el('select', {},
      el('option', { value: 'basic', text: 'Basic', selected: note.type === 'basic' || null }),
      el('option', { value: 'cloze', text: 'Cloze', selected: note.type === 'cloze' || null }));
    const front = el('textarea', { rows: 4 }, note.front);
    const back = el('textarea', { rows: 5 }, note.back);
    const tags = tagsInput((note.tags || '').split(/\s+/).filter(Boolean));

    const clozeBtn = el('button', {
      class: 'cloze-btn', type: 'button',
      onclick: () => {
        const n = (String(front.value).match(/\{\{c(\d+)::/g) || [])
          .map((m) => parseInt(m.slice(3, -2), 10));
        const next = n.length ? Math.max(...n) + 1 : 1;
        wrapSelection(front, `{{c${next}::`, '}}');
      },
    }, '{{c1::…}} cloze');

    const reps = (note.cards || []).reduce((s, c) => s + (c.reps || 0), 0);
    const firstCard = (note.cards || [])[0];
    const ivlDays = firstCard ? Math.max(0, Math.round((firstCard.due - Date.now()) / DAY_MS)) : 0;
    const anySuspended = (note.cards || []).some((c) => c.suspended);

    const save = async () => {
      try {
        await api.patch(`/api/notes/${note.id}`, {
          deckId: Number(deckSel.value), type: typeSel.value,
          front: front.value, back: back.value, tags: tags.getTags().join(' '),
        });
        toast('Saved', 'success');
        submitQuery();
      } catch (err) {
        toast(err.message || 'save failed', 'error');
      }
    };

    const panel = el('div', {},
      el('div', { class: 'edit-head' },
        el('h3', { text: 'Edit note' }),
        el('div', { style: 'display:flex;gap:2px' },
          el('button', {
            class: 'icon-btn', title: 'Delete note', html: icon('trash', 15),
            onclick: () => openModal({
              title: 'Delete note?',
              content: el('p', { text: 'This deletes the note and all its cards. This cannot be undone.', style: 'font-size:13px;color:var(--text-dim)' }),
              actions: [
                { label: 'Cancel' },
                {
                  label: 'Delete', class: 'btn-danger',
                  onClick: async (close) => {
                    try {
                      await api.del(`/api/notes/${note.id}`);
                      close();
                      toast('Note deleted', 'success');
                      submitQuery();
                    } catch (err) {
                      toast(err.message || 'delete failed', 'error');
                    }
                  },
                },
              ],
            }),
          }),
          el('button', { class: 'icon-btn', title: 'More', html: icon('more', 15), onclick: () => toast('No additional actions') }))),
      el('div', { class: 'edit-row' }, deckSel, typeSel),
      el('div', { class: 'toolbar' },
        el('button', { class: 'icon-btn', type: 'button', title: 'Bold', text: 'B', onclick: () => wrapSelection(front, '**') }),
        el('button', { class: 'icon-btn', type: 'button', title: 'Italic', text: 'I', style: 'font-style:italic', onclick: () => wrapSelection(front, '*') }),
        el('button', { class: 'icon-btn', type: 'button', title: 'Underline', text: 'U', style: 'text-decoration:underline', onclick: () => wrapSelection(front, '__') }),
        el('button', { class: 'icon-btn', type: 'button', title: 'Image (not available)', html: icon('image', 14), onclick: () => toast('Images not supported in this build') }),
        el('button', { class: 'icon-btn', type: 'button', title: 'Audio (not available)', html: icon('mic', 14), onclick: () => toast('Audio recording not supported in this build') }),
        clozeBtn),
      el('div', { class: 'field-label', text: 'Front' }), front,
      el('div', { class: 'field-label', text: 'Back' }), back,
      el('div', { class: 'field-label', text: 'Tags' }), tags.node,
      el('div', { class: 'edit-actions' },
        el('button', {
          class: 'btn', onclick: async () => {
            try {
              await api.post(`/api/notes/${note.id}/suspend`, { suspended: !anySuspended });
              toast(anySuspended ? 'Unsuspended' : 'Suspended', 'success');
              submitQuery();
            } catch (err) { toast(err.message || 'failed', 'error'); }
          },
        }, anySuspended ? 'Unsuspend' : 'Suspend'),
        el('button', {
          class: 'btn', onclick: async () => {
            try {
              await api.post(`/api/notes/${note.id}/bury`);
              toast('Buried until tomorrow', 'success');
              submitQuery();
            } catch (err) { toast(err.message || 'failed', 'error'); }
          },
        }, 'Bury'),
        el('span', { class: 'spacer' }),
        el('button', { class: 'btn btn-primary', onclick: save }, 'Save ', el('span', { class: 'kbd', text: '⌘↵' }))),
      el('div', { class: 'edit-foot', text: `note ${note.id} · created ${fmtDate(note.createdAt)} · ${reps} reviews · ivl ${ivlDays}d` }));

    panel.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); save(); }
    });

    editPane.innerHTML = '';
    editPane.append(panel);
  }
}
