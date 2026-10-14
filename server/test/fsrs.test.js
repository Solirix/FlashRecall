'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fsrs = require('../fsrs');

const DAY_MS = 86400000;
const noFuzz = () => 0.5;

test('init difficulty decreases as grade improves', () => {
  const ds = [1, 2, 3, 4].map((g) => fsrs.initCard(g).difficulty);
  for (let i = 0; i < 3; i++) assert.ok(ds[i] > ds[i + 1], `${ds}`);
  for (const d of ds) assert.ok(d >= 1 && d <= 10);
});

test('init stability increases as grade improves and matches weights', () => {
  for (let g = 1; g <= 4; g++) {
    assert.equal(fsrs.initCard(g).stability, fsrs.W[g - 1]);
  }
  const ss = [1, 2, 3, 4].map((g) => fsrs.initCard(g).stability);
  for (let i = 0; i < 3; i++) assert.ok(ss[i] < ss[i + 1]);
});

test('recall stability grows', () => {
  const next = fsrs.nextStabilityRecall(5, 10, 0.9, 3);
  assert.ok(next > 10, `expected > 10, got ${next}`);
});

test('lapse stability is below recall stability', () => {
  const lapse = fsrs.nextStabilityLapse(5, 10, 0.9);
  const recall = fsrs.nextStabilityRecall(5, 10, 0.9, 3);
  assert.ok(lapse < recall, `${lapse} !< ${recall}`);
});

test('interval at retention 0.9 matches the formula', () => {
  for (const s of [0.5, 2, 3, 50, 400]) {
    const expected = Math.max(1, Math.round((s / fsrs.FACTOR) * (Math.pow(0.9, 1 / fsrs.DECAY) - 1)));
    assert.equal(fsrs.nextInterval(s, 0.9, noFuzz), expected, `stability ${s}`);
  }
});

test('interval is clamped to [1, 36500]', () => {
  assert.equal(fsrs.nextInterval(0.001, 0.99, noFuzz), 1);
  assert.equal(fsrs.nextInterval(1e9, 0.8, noFuzz), 36500);
});

test('preview intervals are monotonic for a mature card (again<hard<good<easy)', () => {
  const now = Date.now();
  const card = {
    state: 'review', stability: 30, difficulty: 5, step: 0,
    last_review: now - 10 * DAY_MS, due: now,
  };
  const v = fsrs.previewMinutes(card, 0.9, now);
  assert.ok(v.again < v.hard, JSON.stringify(v));
  assert.ok(v.hard < v.good, JSON.stringify(v));
  assert.ok(v.good < v.easy, JSON.stringify(v));
  const labels = fsrs.previewIntervals(card, 0.9, now);
  for (const key of ['again', 'hard', 'good', 'easy']) {
    assert.equal(typeof labels[key], 'string');
  }
  assert.equal(labels.again, '10m');
});

test('preview for a new card uses learning steps', () => {
  const labels = fsrs.previewIntervals({ state: 'new', step: 0 }, 0.9);
  assert.equal(labels.again, '1m');
  assert.equal(labels.hard, '5m');
  assert.equal(labels.good, '10m');
  assert.ok(labels.easy.endsWith('d'));
});

test('grade 1 from review goes to relearning with lapses + 1', () => {
  const now = Date.now();
  const card = {
    state: 'review', stability: 20, difficulty: 5, reps: 5, lapses: 0,
    step: 0, due: now, last_review: now - 5 * DAY_MS,
  };
  const next = fsrs.answer(card, 1, now, 0.9, noFuzz);
  assert.equal(next.state, 'relearning');
  assert.equal(next.lapses, 1);
  assert.equal(next.step, 0);
  assert.equal(next.due, now + 10 * 60000);
  assert.equal(next.last_review, now);
  assert.equal(next.reps, 6);
  assert.ok(next.stability < card.stability);
});

test('easy on a new card graduates immediately to review', () => {
  const now = Date.now();
  const card = { state: 'new', step: 0, reps: 0, lapses: 0, due: now, last_review: null };
  const next = fsrs.answer(card, 4, now, 0.9, noFuzz);
  assert.equal(next.state, 'review');
  assert.equal(next.stability, fsrs.W[3]);
  const ivlDays = Math.round((next.due - fsrs.startOfDay(now)) / DAY_MS);
  assert.ok(ivlDays >= 4, `interval ${ivlDays}d`);
});

test('new card walkthrough: good -> learning step, good again -> graduates', () => {
  const now = Date.now();
  let card = { state: 'new', step: 0, reps: 0, lapses: 0, due: now, last_review: null };
  card = fsrs.answer(card, 3, now, 0.9, noFuzz);
  assert.equal(card.state, 'learning');
  assert.equal(card.step, 2);
  assert.equal(card.due, now + 10 * 60000);
  card = fsrs.answer(card, 3, now + 10 * 60000, 0.9, noFuzz);
  assert.equal(card.state, 'review');
  assert.equal(card.stability, fsrs.W[2]);
  assert.ok(card.due >= fsrs.startOfDay(now) + DAY_MS);
});

test('nextDifficulty mean-reverts toward init difficulty of grade 4', () => {
  const initD4 = fsrs.initCard(4).difficulty;
  const afterEasy = fsrs.nextDifficulty(8, 4);
  assert.ok(afterEasy < 8 && afterEasy >= 1);
  const afterAgain = fsrs.nextDifficulty(3, 1);
  assert.ok(afterAgain > 3 && afterAgain <= 10);
  // stays within [1,10] and pulled toward initD4 over repeated good grades
  let d = 9;
  for (let i = 0; i < 100; i++) d = fsrs.nextDifficulty(d, 3);
  assert.ok(Math.abs(d - initD4) < 0.5, `d=${d} vs ${initD4}`);
});
