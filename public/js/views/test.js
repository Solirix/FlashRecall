// #/test — practice tests and study guides generated from a deck.
// Setup -> fill out every question -> submit -> instant auto-check with
// per-question override ("I was right" / "Mark wrong") and a live score.
// Practice tests never touch spaced-repetition scheduling.

import { api } from '../api.js';
import { el, icon, toast, openModal, mdBlocks, fmtClock } from '../ui.js';
import { state, refreshDecks, navigate, deckById } from '../app.js';
import { fillDeckSelect } from '../deckdialogs.js';
import { checkAnswer } from '../answercheck.js';

const COUNTS = [{ label: '10', value: 10 }, { label: '20', value: 20 }, { label: '50', value: 50 }, { label: 'All', value: 500 }];
const FORMATS = [{ label: 'Written', value: 'written' }, { label: 'Multiple choice', value: 'choice' }, { label: 'Mixed', value: 'mixed' }];
const SCOPES = [{ label: 'All cards', value: 'all' }, { label: 'Studied only', value: 'studied' }];
const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];

// Remembered between visits in this tab.
const prefs = { count: 20, format: 'written', scope: 'all', subdecks: true };

function segmented(options, current, onPick) {
  const seg = el('div', { class: 'segmented' });
  for (const o of options) {
    seg.append(el('button', {
      type: 'button', class: o.value === current ? 'active' : '',
      onclick: (e) => {
        seg.querySelectorAll('button').forEach((b) => b.classList.remove('active'));
        e.currentTarget.classList.add('active');
        onPick(o.value);
      },
    }, o.label));
  }
  return seg;
}

export async function render(main, params, query) {
  if (!state.decks.length) await refreshDecks().catch(() => {});
  let timer = null;
  window.addEventListener('recall:route-leave', () => clearInterval(timer), { once: true });

  const swap = (...nodes) => {
    main.innerHTML = '';
    main.append(...nodes);
    window.scrollTo(0, 0);
  };

  // ---------------- setup ----------------

  function showSetup() {
    if (!state.decks.length) {
      swap(el('div', { class: 'card deck-empty' },
        el('div', { class: 'deck-empty-icon', html: icon('clipboard', 28) }),
        el('h3', { text: 'No decks to test yet' }),
        el('p', { text: 'Create a deck and add some cards, then come back to generate a practice test.' }),
        el('button', { class: 'btn btn-primary', onclick: () => navigate('#/decks?new=1') }, 'Create a deck')));
      return;
    }
    const deckSel = el('select', {});
    fillDeckSelect(deckSel, { selected: query.get('deck') || prefs.deckId || state.decks[0].id });
    const subToggle = el('input', {
      type: 'checkbox', class: 'switch', checked: prefs.subdecks || null,
      onchange: (e) => { prefs.subdecks = e.target.checked; },
    });
    const busyBtns = [];
    const go = async (mode) => {
      prefs.deckId = Number(deckSel.value);
      busyBtns.forEach((b) => { b.disabled = true; });
      try {
        const count = mode === 'guide' ? 500 : prefs.count;
        const format = mode === 'guide' ? 'written' : prefs.format;
        const qs = new URLSearchParams({
          count, format, scope: prefs.scope, subdecks: prefs.subdecks ? '1' : '0',
        });
        const data = await api.get(`/api/decks/${prefs.deckId}/practice?${qs}`);
        if (!data.items.length) {
          toast(prefs.scope === 'studied'
            ? 'No studied cards with answers in this deck yet — try “All cards”.'
            : 'No cards with answers in this deck yet.', 'error');
          return;
        }
        if (mode === 'guide') showGuide(data);
        else startTest(data.deck, data.items);
      } catch (err) {
        if (err.status !== 401) toast(err.message || 'could not build test', 'error');
      } finally {
        busyBtns.forEach((b) => { b.disabled = false; });
      }
    };
    const startBtn = el('button', { class: 'btn btn-primary', type: 'submit' },
      el('span', { html: icon('clipboard', 15) }), 'Start test');
    const guideBtn = el('button', { class: 'btn', type: 'button', onclick: () => go('guide') },
      el('span', { html: icon('book', 15) }), 'Study guide');
    busyBtns.push(startBtn, guideBtn);

    swap(el('form', {
      class: 'card form-card test-setup',
      onsubmit: (e) => { e.preventDefault(); go('test'); },
    },
    el('h2', { text: 'Practice test' }),
    el('p', {
      class: 'modal-text',
      text: 'Answer every question, then submit to see what you got right. Answers are checked automatically — you can overrule the checker on any question. Tests don’t affect your review schedule.',
    }),
    el('div', { class: 'field' }, el('label', { text: 'Deck' }), deckSel),
    el('div', { class: 'field test-inline' },
      el('label', { text: 'Include sub-decks' }), subToggle),
    el('div', { class: 'field' }, el('label', { text: 'Questions' }),
      segmented(COUNTS, prefs.count, (v) => { prefs.count = v; })),
    el('div', { class: 'field' }, el('label', { text: 'Question type' }),
      segmented(FORMATS, prefs.format, (v) => { prefs.format = v; }),
      el('div', { class: 'field-hint', text: 'Multiple choice uses other answers from the deck as wrong options (needs 4+ cards).' })),
    el('div', { class: 'field' }, el('label', { text: 'Cards' }),
      segmented(SCOPES, prefs.scope, (v) => { prefs.scope = v; })),
    el('div', { class: 'test-setup-actions' }, guideBtn, startBtn)));
  }

  // ---------------- taking the test ----------------

  function startTest(deck, items) {
    const answers = items.map(() => '');
    const startedAt = Date.now();
    const clock = el('span', { class: 'test-clock', text: '00:00' });
    const answeredText = el('span', {});
    const bar = el('div', { style: 'width:0%' });
    clearInterval(timer);
    timer = setInterval(() => { clock.textContent = fmtClock(Date.now() - startedAt); }, 1000);

    const inputs = [];
    const updateProgress = () => {
      const n = answers.filter((a) => a.trim()).length;
      answeredText.textContent = `${n} / ${items.length} answered`;
      bar.style.width = `${(n / items.length) * 100}%`;
    };

    const focusNext = (i) => {
      const next = inputs[i + 1];
      if (next) { next.focus(); next.scrollIntoView({ block: 'center', behavior: 'smooth' }); } else submitBtn.focus();
    };

    const list = el('div', { class: 'test-list stagger' }, items.map((item, i) => {
      let field;
      if (item.format === 'choice') {
        field = el('div', { class: 'choice-list', role: 'radiogroup' }, item.choices.map((c, k) => {
          const radio = el('input', {
            type: 'radio', name: `q${i}`, value: c,
            onchange: () => { answers[i] = c; updateProgress(); },
          });
          if (k === 0) inputs[i] = radio;
          return el('label', { class: 'choice' }, radio,
            el('span', { class: 'choice-key', text: LETTERS[k] }),
            el('span', { class: 'choice-text', html: mdBlocks(c) }));
        }));
      } else {
        field = el('input', {
          type: 'text', class: 'test-input', placeholder: 'Your answer…', autocomplete: 'off',
          autocapitalize: 'off', spellcheck: 'false',
          oninput: (e) => { answers[i] = e.target.value; updateProgress(); },
          onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); focusNext(i); } },
        });
        inputs[i] = field;
      }
      return el('div', { class: 'test-q' },
        el('div', { class: 'test-q-head' },
          el('span', { class: 'test-num', text: String(i + 1) }),
          el('span', { class: 'chip', text: item.format === 'choice' ? 'MULTIPLE CHOICE' : item.type === 'cloze' ? 'FILL THE BLANK' : 'WRITTEN' })),
        el('div', { class: 'test-prompt', html: mdBlocks(item.prompt) }),
        field);
    }));

    const submit = () => {
      const blank = answers.filter((a) => !a.trim()).length;
      if (!blank) { finish(); return; }
      openModal({
        title: 'Submit test?',
        content: el('p', {
          class: 'modal-text',
          text: `${blank} question${blank === 1 ? ' is' : 's are'} still blank and will be marked wrong.`,
        }),
        actions: [{ label: 'Keep going' }, { label: 'Submit anyway', class: 'btn-primary', onClick: (close) => { close(); finish(); } }],
      });
    };
    const finish = () => {
      clearInterval(timer);
      const results = items.map((item, i) => {
        const given = answers[i];
        const auto = item.format === 'choice'
          ? (given
            ? { correct: given === item.expected, reason: given === item.expected ? 'Correct choice' : 'Wrong choice', sure: true }
            : { correct: false, reason: 'No answer', sure: true })
          : checkAnswer(given, item.expected);
        return { item, given, auto, override: null };
      });
      showResults(deck, results, Date.now() - startedAt);
    };

    const submitBtn = el('button', { class: 'btn btn-primary', onclick: submit },
      el('span', { html: icon('check', 15) }), 'Submit test');

    swap(
      el('div', { class: 'test-head no-print' },
        el('div', {},
          el('h2', { text: 'Practice test' }),
          el('div', { class: 'card-sub', text: `${deckLabel(deck)} · ${items.length} questions` })),
        el('div', { class: 'test-head-meta' }, answeredText, clock)),
      el('div', { class: 'test-progress no-print' }, bar),
      list,
      el('div', { class: 'test-submit-bar no-print' },
        el('button', {
          class: 'btn btn-ghost', onclick: () => openModal({
            title: 'Quit this test?',
            content: el('p', { class: 'modal-text', text: 'Your answers so far will be lost.' }),
            actions: [{ label: 'Keep going' }, { label: 'Quit', class: 'btn-danger-solid', onClick: (close) => { close(); showSetup(); } }],
          }),
        }, 'Quit'),
        submitBtn));
    updateProgress();
    setTimeout(() => inputs[0]?.focus({ preventScroll: true }), 350);
  }

  // ---------------- results ----------------

  function showResults(deck, results, elapsedMs) {
    let filter = 'all';
    const verdict = (r) => (r.override != null ? r.override : r.auto.correct);
    const score = () => results.filter(verdict).length;

    const { svg: ring, fg: ringFg } = svgRing();
    const pctText = el('div', { class: 'score-pct', text: '0%' });
    const countText = el('div', { class: 'score-count' });
    const unsureText = el('div', { class: 'score-note' });
    let shownPct = 0;

    const updateScore = () => {
      const s = score();
      const pct = Math.round((s / results.length) * 100);
      countText.textContent = `${s} of ${results.length} correct · ${fmtClock(elapsedMs)}`;
      ringFg.style.strokeDashoffset = String(CIRC * (1 - pct / 100));
      ring.style.setProperty('--score-color', pct >= 80 ? 'var(--green)' : pct >= 60 ? 'var(--yellow)' : 'var(--red)');
      countUp(pctText, shownPct, pct);
      shownPct = pct;
      const unsure = results.filter((r) => r.override == null && !r.auto.sure && r.item.format !== 'choice').length;
      unsureText.textContent = unsure
        ? `${unsure} answer${unsure === 1 ? ' was' : 's were'} a judgement call — worth a quick look.`
        : 'Disagree with the checker? Use “I was right” or “Mark wrong” on any answer.';
      retakeBtn.disabled = results.length - s === 0;
      retakeBtn.lastChild.textContent = `Retake missed (${results.length - s})`;
    };

    const list = el('div', { class: 'test-list' });
    const drawList = () => {
      list.innerHTML = '';
      list.classList.remove('stagger');
      void list.offsetWidth;
      list.classList.add('stagger');
      results.forEach((r, i) => {
        if (filter === 'wrong' && verdict(r)) return;
        if (filter === 'check' && (r.override != null || r.auto.sure || r.item.format === 'choice')) return;
        list.append(resultCard(r, i));
      });
      if (!list.childElementCount) list.append(el('div', { class: 'empty-line', text: 'Nothing here.' }));
    };

    function resultCard(r, i) {
      const ok = verdict(r);
      const node = el('div', { class: `test-q result ${ok ? 'is-right' : 'is-wrong'}` });
      const chipText = r.override != null ? (ok ? '✓ Correct (you)' : '✗ Wrong (you)')
        : ok ? (r.auto.sure ? '✓ Correct' : '≈ Accepted') : '✗ Incorrect';
      const overrideBtn = r.item.format === 'choice' ? null : el('button', {
        class: 'btn override-btn',
        onclick: () => {
          const wasRight = verdict(r);
          r.override = r.override == null ? !r.auto.correct : null; // a second click reverts to the checker
          node.replaceWith(resultCard(r, i));
          updateScore();
          toast(wasRight ? 'Marked wrong' : 'Marked correct', 'success', 1600);
        },
      }, r.override != null ? 'Undo override' : ok ? 'Mark wrong' : 'I was right');

      const fullAnswer = String(r.item.answer || '').trim();
      const showFull = fullAnswer && fullAnswer.replace(/\*\*|__|`|\*/g, '').trim() !== r.item.expected;
      node.append(...[
        el('div', { class: 'test-q-head' },
          el('span', { class: 'test-num', text: String(i + 1) }),
          el('span', { class: `chip verdict ${ok ? 'c-rev' : 'c-lrn'}`, text: chipText }),
          el('span', { class: 'verdict-reason', text: r.override != null ? 'overridden' : r.auto.reason }),
          overrideBtn),
        el('div', { class: 'test-prompt', html: mdBlocks(r.item.prompt) }),
        el('div', { class: 'answer-compare' },
          el('div', {},
            el('span', { class: 'section-label', text: 'Your answer' }),
            el('div', { class: `given ${r.given.trim() ? '' : 'blank'}`, text: r.given.trim() || '(blank)' })),
          el('div', {},
            el('span', { class: 'section-label', text: 'Correct answer' }),
            el('div', { class: 'expected', html: mdBlocks(r.item.expected) }))),
        showFull ? el('div', { class: 'answer-more', html: mdBlocks(fullAnswer) }) : null,
        r.item.extra ? el('div', { class: 'answer-more extra', html: mdBlocks(r.item.extra) }) : null,
      ].filter(Boolean));
      return node;
    }

    const retakeBtn = el('button', {
      class: 'btn', onclick: () => {
        const missed = results.filter((r) => !verdict(r)).map((r) => r.item);
        startTest(deck, shuffle(missed));
      },
    }, el('span', { html: icon('undo', 15) }), el('span', { text: 'Retake missed' }));

    swap(
      el('div', { class: 'card score-card' },
        el('div', { class: 'score-ring' }, ring, pctText),
        el('div', { class: 'score-meta' },
          el('h2', { text: 'Results' }),
          el('div', { class: 'card-sub', text: deckLabel(deck) }),
          countText,
          unsureText,
          el('div', { class: 'score-actions no-print' },
            retakeBtn,
            el('button', { class: 'btn', onclick: () => showSetup() },
              el('span', { html: icon('plus', 15) }), 'New test'),
            el('button', { class: 'btn', onclick: () => window.print() },
              el('span', { html: icon('print', 15) }), 'Print')))),
      el('div', { class: 'test-filter no-print' }, segmented(
        [{ label: 'All', value: 'all' }, { label: 'Incorrect', value: 'wrong' }, { label: 'Needs a look', value: 'check' }],
        filter, (v) => { filter = v; drawList(); })),
      list);
    drawList();
    requestAnimationFrame(() => requestAnimationFrame(updateScore));
  }

  // ---------------- study guide ----------------

  function showGuide(data) {
    const items = [...data.items].sort((a, b) => a.cardId - b.cardId);
    swap(
      el('div', { class: 'test-head' },
        el('div', {},
          el('h2', { text: 'Study guide' }),
          el('div', { class: 'card-sub', text: `${deckLabel(data.deck)} · ${items.length} items` })),
        el('div', { class: 'test-head-meta no-print' },
          el('button', { class: 'btn', onclick: () => showSetup() }, 'Back'),
          el('button', { class: 'btn btn-primary', onclick: () => window.print() },
            el('span', { html: icon('print', 15) }), 'Print'))),
      el('div', { class: 'guide-list stagger' }, items.map((item, i) => el('div', { class: 'guide-item' },
        el('div', { class: 'guide-q' },
          el('span', { class: 'test-num', text: String(i + 1) }),
          el('div', { html: mdBlocks(item.prompt) })),
        el('div', { class: 'guide-a', html: mdBlocks(item.answer || item.expected) }),
        item.extra ? el('div', { class: 'guide-extra', html: mdBlocks(item.extra) }) : null))));
  }

  showSetup();
}

// ---------------- helpers ----------------

const CIRC = 2 * Math.PI * 52;

function svgRing() {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 120 120');
  svg.setAttribute('class', 'ring-svg');
  const mk = (cls) => {
    const c = document.createElementNS(NS, 'circle');
    c.setAttribute('cx', '60'); c.setAttribute('cy', '60'); c.setAttribute('r', '52');
    c.setAttribute('class', cls);
    return c;
  };
  const bg = mk('ring-bg');
  const front = mk('ring-fg');
  front.style.strokeDasharray = String(CIRC);
  front.style.strokeDashoffset = String(CIRC);
  svg.append(bg, front);
  return { svg, fg: front };
}

function countUp(node, from, to) {
  const start = performance.now();
  const dur = document.documentElement.dataset.motion === 'reduced' ? 0 : 700;
  const step = (t) => {
    const k = dur ? Math.min(1, (t - start) / dur) : 1;
    const eased = 1 - (1 - k) ** 3;
    node.textContent = `${Math.round(from + (to - from) * eased)}%`;
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function deckLabel(deck) {
  return deckById(deck.id)?.name || deck.name;
}
