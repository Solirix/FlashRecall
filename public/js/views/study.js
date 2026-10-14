// #/study/:deckId — full-focus review session.

import { api } from '../api.js';
import { el, icon, toast, openModal, mdBlocks, mdInline, fmtClock, fmtSecs } from '../ui.js';
import { state, navigate, refreshDecks } from '../app.js';

const GRADES = [
  { g: 1, name: 'Again', cls: 'g1', key: 'again' },
  { g: 2, name: 'Hard', cls: 'g2', key: 'hard' },
  { g: 3, name: 'Good', cls: 'g3', key: 'good' },
  { g: 4, name: 'Easy', cls: 'g4', key: 'easy' },
];

// Mirrors server renderCloze so edits to cloze notes redraw correctly in-session.
function renderCloze(text, ord, side) {
  return String(text || '').replace(/\{\{c(\d+)::([^}]*?)\}\}/g, (m, n, inner) => {
    const sep = inner.indexOf('::');
    const clozeText = sep === -1 ? inner : inner.slice(0, sep);
    const hint = sep === -1 ? null : inner.slice(sep + 2);
    if (side === 'front' && parseInt(n, 10) === ord) return hint ? `[${hint}]` : '[…]';
    return clozeText;
  });
}

export async function render(main, params) {
  const deckId = Number(params[0]);
  main.append(el('div', { class: 'spinner' }));

  let queue;
  try {
    queue = await api.get(`/api/study/${deckId}/queue`);
  } catch (err) {
    main.innerHTML = '';
    main.append(el('div', { class: 'view-empty', text: err.message || 'failed to load queue' }));
    return;
  }

  const cards = queue.cards || [];
  const session = {
    startedAt: Date.now(),
    answered: 0,
    grades: [],
    durations: [],
    history: [], // { card, idx } for undo
  };
  const flagState = new Map(); // noteId → bool; seeded from the queue, updated on toggle
  for (const c of cards) if (!flagState.has(c.noteId)) flagState.set(c.noteId, !!c.flagged);
  const total = queue.total || cards.length;
  let idx = 0;
  let revealed = false;
  let revealedAt = 0;
  let busy = false;

  // ---------- chrome ----------

  const progressText = el('div', { class: 'study-progress-text' });
  const progressFill = el('div', { style: 'width:0%' });
  const paceLine = el('span', {});
  const etaLine = el('span', {});
  const sessionLine = el('div', { class: 'study-session-line' });
  const stage = el('div', { class: 'study-stage' });
  const flagBtn = el('button', { class: 'icon-btn', title: 'Flag note', html: icon('flag', 17) });
  const stateChip = el('span', { class: 'chip c-accent', text: 'REVIEW' });

  const shell = el('div', { class: 'study-shell' },
    el('div', { class: 'study-header' },
      el('button', { class: 'icon-btn', title: 'Back', html: icon('back', 18), onclick: () => navigate('#/home') }),
      el('div', { class: 'study-title' },
        el('span', { html: icon('layers', 18), style: 'color:var(--accent-2);display:grid' }),
        el('span', { text: queue.deck.name }),
        stateChip),
      progressText,
      el('div', { class: 'study-actions' },
        el('button', {
          class: 'icon-btn', title: 'Undo (ctrl+z)', html: icon('undo', 17),
          onclick: () => undo(),
        }),
        flagBtn,
        el('button', { class: 'icon-btn', title: 'Edit (e)', html: icon('pencil', 17), onclick: () => editCurrent() }),
        el('button', { class: 'icon-btn', title: 'Close', html: icon('close', 18), onclick: () => navigate('#/home') }))),
    el('div', { class: 'study-bar' }, progressFill),
    el('div', { class: 'study-sub' }, paceLine, etaLine),
    stage,
    el('div', { class: 'study-footer' },
      el('div', { class: 'legend' },
        el('span', { text: '1 again' }), el('span', { text: '2 hard' }),
        el('span', { text: '3 good' }), el('span', { text: '4 easy' }),
        el('span', { text: '·' }), el('span', { text: 'space reveal' }),
        el('span', { text: 'e edit' }), el('span', { text: '- suspend' }),
        el('span', { text: 'ctrl+z undo' })),
      sessionLine));

  main.innerHTML = '';
  main.append(shell);

  const timer = setInterval(updateMeta, 1000);
  const cleanup = () => {
    clearInterval(timer);
    document.removeEventListener('keydown', onKey);
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
  };
  window.addEventListener('recall:route-leave', cleanup, { once: true });

  document.addEventListener('keydown', onKey);

  if (cards.length === 0) {
    showSummary(true);
    return;
  }
  showCard();

  // ---------- session logic ----------

  function current() { return cards[idx] || null; }

  function avgPace() {
    if (!session.durations.length) return null;
    return session.durations.reduce((a, b) => a + b, 0) / session.durations.length;
  }

  function updateMeta() {
    const done = session.answered;
    progressText.textContent = `${Math.min(done + (revealed || idx < cards.length ? 1 : 0), Math.max(total, cards.length))} / ${Math.max(total, cards.length)}`;
    progressFill.style.width = `${Math.min(100, (done / Math.max(total, 1)) * 100)}%`;
    const pace = avgPace();
    paceLine.textContent = pace != null ? `${fmtSecs(pace)} per card · on pace` : '— per card';
    const remaining = cards.length - idx;
    etaLine.textContent = pace != null && remaining > 0
      ? `ETA ${Math.max(1, Math.round((remaining * pace) / 60000))} min`
      : remaining > 0 ? 'ETA —' : '';
    sessionLine.textContent = `session ${fmtClock(Date.now() - session.startedAt)} · ${done} answered`;
  }

  function showCard() {
    const card = current();
    if (!card) { showSummary(false); return; }
    revealed = false;
    revealedAt = 0;
    busy = false;
    flagBtn.classList.toggle('on', flagState.get(card.noteId) === true);
    stateChip.textContent = card.state === 'new' ? 'NEW'
      : card.state === 'review' ? 'REVIEW' : 'LEARNING';
    updateMeta();

    const tags = (card.tags || '').split(/\s+/).filter(Boolean);
    stage.innerHTML = '';
    stage.append(
      el('div', { class: 'study-card' },
        el('div', { class: 'card-top' },
          el('span', { class: 'chip', text: (card.type || 'basic').toUpperCase() }),
          el('div', { class: 'tags-row' }, tags.map((t) => el('span', { class: 'tag-chip', text: `#${t}` })))),
        el('div', { class: 'study-front', html: mdBlocks(card.front) }),
        el('div', { class: 'study-hint', text: hintFor(card) }),
        el('div', { class: 'study-source', text: [queue.deck.name, card.extra && firstLine(card.extra)].filter(Boolean).join(' · ') })),
      el('button', { class: 'btn btn-primary', onclick: reveal },
        'Show Answer', el('span', { class: 'kbd', text: 'space' })));
  }

  function hintFor(card) {
    return card.state === 'new' ? 'new card · try to recall the answer' : '';
  }

  function firstLine(s) {
    const line = String(s).split('\n')[0].trim();
    return line.length > 80 ? `${line.slice(0, 80)}…` : line;
  }

  function reveal() {
    const card = current();
    if (!card || revealed || busy) return;
    revealed = true;
    revealedAt = Date.now();

    const backParas = String(card.back || '').split(/\n+/).filter((l) => l.trim());
    const [answer, ...rest] = backParas;
    const tags = (card.tags || '').split(/\s+/).filter(Boolean);

    const canSpeak = 'speechSynthesis' in window && typeof window.SpeechSynthesisUtterance === 'function';
    const playBtn = canSpeak
      ? el('button', {
        class: 'btn play-btn', onclick: () => {
          try {
            window.speechSynthesis.cancel();
            const u = new SpeechSynthesisUtterance(String(card.front || '').replace(/\*\*|__|`|\*/g, ''));
            window.speechSynthesis.speak(u);
          } catch { toast('speech playback unavailable', 'error'); }
        },
      }, el('span', { html: icon('speaker', 14) }), 'Play')
      : null;

    stage.innerHTML = '';
    stage.append(
      el('div', { class: 'study-card' },
        el('div', { class: 'card-top' },
          el('span', { class: 'chip', text: (card.type || 'basic').toUpperCase() }),
          el('div', { class: 'tags-row' }, tags.map((t) => el('span', { class: 'tag-chip', text: `#${t}` })))),
        el('div', { style: 'position:relative' },
          el('div', { class: 'study-front small', html: mdBlocks(card.front) }),
          playBtn),
        el('hr', { class: 'study-divider' }),
        answer ? el('div', { class: 'answer-section' },
          el('span', { class: 'section-label', text: 'Answer' }),
          el('div', { class: 'answer-reading', html: mdBlocks(answer) })) : null,
        rest.length ? el('div', { class: 'answer-section' },
          el('span', { class: 'section-label', text: 'Details' }),
          el('div', { class: 'answer-body', html: rest.map((p) => `<p>${mdInline(p)}</p>`).join('') })) : null,
        card.extra ? el('div', { class: 'answer-extra' },
          el('span', { class: 'section-label', text: 'Extra' }),
          el('div', { class: 'ex-main', html: mdBlocks(card.extra.split(/\n+/)[0]) }),
          card.extra.split(/\n+/).length > 1
            ? el('div', { class: 'ex-note', html: mdBlocks(card.extra.split(/\n+/).slice(1).join('\n')) })
            : null) : null),
      el('div', {},
        el('div', { class: 'grade-row' }, GRADES.map(({ g, name, cls, key }) =>
          el('button', { class: `grade-btn ${cls}`, onclick: () => grade(g) },
            el('span', { class: 'g-key', text: String(g) }),
            el('div', { class: 'g-name', text: name }),
            el('div', { class: 'g-ivl', text: (card.previews && card.previews[key]) || '…' })))),
        el('div', { class: 'study-caption', style: 'margin-top:10px' },
          `press 3 · this card returns in ${(card.previews && card.previews.good) || '…'} · desired retention ${(state.settings?.desiredRetention ?? 0.9).toFixed(2)}`)));
    updateMeta();
  }

  async function grade(g) {
    const card = current();
    if (!card || !revealed || busy) return;
    busy = true;
    const durationMs = Math.max(0, Date.now() - revealedAt);
    try {
      const res = await api.post('/api/study/answer', { cardId: card.id, grade: g, durationMs });
      session.history.push({ card, idx });
      session.answered += 1;
      session.grades.push(g);
      session.durations.push(durationMs);
      if (res.leech) toast('Marked as leech (tag added)', 'error');
      if (g === 1) cards.push(card); // again: see it once more this session
      idx += 1;
      showCard();
    } catch (err) {
      busy = false;
      toast(err.message || 'answer failed', 'error');
    }
  }

  async function undo() {
    if (busy) return;
    const last = session.history.pop();
    if (!last) { toast('Nothing to undo'); return; }
    busy = true;
    try {
      await api.post('/api/study/undo');
      session.answered -= 1;
      session.grades.pop();
      session.durations.pop();
      // Remove any re-queued copy (grade 1), then rewind to the card's old slot.
      for (let i = cards.length - 1; i > last.idx; i--) {
        if (cards[i].id === last.card.id) { cards.splice(i, 1); break; }
      }
      idx = Math.min(last.idx, cards.length - 1);
      showCard();
      toast('Undone', 'success');
    } catch (err) {
      busy = false;
      toast(err.message || 'undo failed', 'error');
    }
  }

  async function suspendCurrent() {
    const card = current();
    if (!card || busy) return;
    busy = true;
    try {
      await api.post(`/api/notes/${card.noteId}/suspend`, { suspended: true });
      toast('Card suspended', 'success');
      idx += 1;
      showCard();
    } catch (err) {
      busy = false;
      toast(err.message || 'suspend failed', 'error');
    }
  }

  async function toggleFlag() {
    const card = current();
    if (!card || busy) return;
    busy = true;
    try {
      const flagged = !flagState.get(card.noteId);
      await api.post(`/api/notes/${card.noteId}/flag`, { flagged });
      flagState.set(card.noteId, flagged);
      flagBtn.classList.toggle('on', flagged);
      toast(flagged ? 'Flagged' : 'Flag removed', 'success');
    } catch (err) {
      toast(err.message || 'flag failed', 'error');
    } finally {
      busy = false;
    }
  }

  async function editCurrent() {
    const card = current();
    if (!card) return;
    // Cloze cards arrive pre-rendered; fetch the raw note so {{cN::…}} markers are editable.
    let note = null;
    try {
      note = await api.get(`/api/notes/${card.noteId}`);
    } catch (err) {
      toast(err.message || 'could not load note', 'error');
      return;
    }
    const front = el('textarea', { rows: 3 }, note.front);
    const back = el('textarea', { rows: 3 }, note.back);
    const extra = el('textarea', { rows: 2 }, note.extra || '');
    const tags = el('input', { type: 'text', value: note.tags || '' });
    openModal({
      title: 'Edit note',
      content: el('div', {},
        el('div', { class: 'field' }, el('label', { text: 'Front' }), front),
        el('div', { class: 'field' }, el('label', { text: 'Back' }), back),
        el('div', { class: 'field' }, el('label', { text: 'Extra' }), extra),
        el('div', { class: 'field' }, el('label', { text: 'Tags (space separated)' }), tags)),
      actions: [
        { label: 'Cancel' },
        {
          label: 'Save', class: 'btn-primary',
          onClick: async (close) => {
            try {
              await api.patch(`/api/notes/${card.noteId}`, {
                front: front.value, back: back.value, extra: extra.value, tags: tags.value.trim(),
              });
              if (card.type === 'cloze') {
                card.front = renderCloze(front.value, card.ord, 'front');
                card.back = renderCloze(back.value, card.ord, 'back');
              } else {
                card.front = front.value;
                card.back = back.value;
              }
              card.extra = extra.value;
              card.tags = tags.value.trim();
              close();
              toast('Saved', 'success');
              if (revealed) { revealed = false; showCard(); reveal(); } else showCard();
            } catch (err) {
              toast(err.message || 'save failed', 'error');
            }
          },
        },
      ],
    });
  }

  function showSummary(caughtUp) {
    updateMeta();
    const mins = Date.now() - session.startedAt;
    const pace = avgPace();
    const retention = session.grades.length
      ? Math.round((session.grades.filter((g) => g > 1).length / session.grades.length) * 100)
      : null;
    stage.innerHTML = '';
    stage.append(el('div', { class: 'card summary-card' },
      el('div', { style: 'color:var(--green);margin-bottom:10px', html: icon('check', 30) }),
      el('h3', { text: caughtUp ? 'All caught up' : 'Session complete', style: 'font-size:17px' }),
      caughtUp ? el('p', { class: 'card-sub', text: 'Nothing due in this deck right now.' }) : null,
      session.answered > 0 ? el('div', { class: 'summary-stats' },
        el('div', {}, el('div', { class: 'big', text: String(session.answered) }), el('div', { class: 'tile-label', text: 'Cards done' })),
        el('div', {}, el('div', { class: 'big', text: fmtClock(mins) }), el('div', { class: 'tile-label', text: 'Time' })),
        el('div', {}, el('div', { class: 'big', text: pace != null ? fmtSecs(pace) : '—' }), el('div', { class: 'tile-label', text: 'Avg pace' })),
        el('div', {}, el('div', { class: 'big', text: retention != null ? `${retention}%` : '—' }), el('div', { class: 'tile-label', text: 'Retention' }))) : null,
      el('button', { class: 'btn btn-primary', onclick: () => navigate('#/home') }, 'Back home')));
    refreshDecks().catch(() => {});
  }

  function onKey(e) {
    if (e.target instanceof Element && e.target.closest('input, textarea, select')) return;
    if (document.querySelector('.modal-overlay')) return;
    if (e.key === ' ') {
      e.preventDefault();
      if (!revealed) reveal();
      return;
    }
    if (revealed && ['1', '2', '3', '4'].includes(e.key)) { grade(Number(e.key)); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); return; }
    if (e.key.toLowerCase() === 'u' && !e.ctrlKey && !e.metaKey) { undo(); return; }
    if (e.key.toLowerCase() === 'e') { editCurrent(); return; }
    if (e.key === '-') { suspendCurrent(); }
  }

  flagBtn.addEventListener('click', toggleFlag);
  updateMeta();
}
