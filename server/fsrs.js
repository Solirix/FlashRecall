'use strict';

// FSRS-4.5 scheduler. Pure functions only — no DB or IO imports.

const W = [0.4072, 1.1829, 3.1262, 15.4722, 7.2102, 0.5316, 1.0651, 0.0589,
           1.533, 0.1544, 0.9997, 0.9259, 0.02, 0.145, 1.0, 0.12, 1.55, 0.15, 0.35];
const DECAY = -0.5;
const FACTOR = 19 / 81;
const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
// Learning steps in minutes: grade 1 -> 1, grade 2 -> 5, grade 3 -> 10.
const STEP_MINUTES = [1, 5, 10];
const LAPSE_STEP_MINUTES = 10;

function clamp(x, lo, hi) {
  return Math.min(hi, Math.max(lo, x));
}

function startOfDay(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// Retrievability after t days for a card with stability S.
function retrievability(elapsedDays, stability) {
  if (!stability || stability <= 0) return 0;
  return Math.pow(1 + (FACTOR * elapsedDays) / stability, DECAY);
}

function initDifficulty(grade) {
  return clamp(W[4] - Math.exp((grade - 1) * W[5]) + 1, 1, 10);
}

function initCard(grade) {
  return { stability: W[grade - 1], difficulty: initDifficulty(grade) };
}

function nextDifficulty(d, grade) {
  const dpp = clamp(d - W[6] * (grade - 3), 1, 10);
  return clamp(W[7] * (W[4] - Math.exp(3 * W[5]) + 1) + (1 - W[7]) * dpp, 1, 10);
}

function nextStabilityRecall(d, s, r, grade) {
  return s * (1 + Math.exp(W[8]) * (11 - d) * Math.pow(s, -W[9])
    * (Math.exp((1 - r) * W[10]) - 1)
    * (grade === 2 ? W[15] : 1)
    * (grade === 4 ? W[16] : 1));
}

function nextStabilityLapse(d, s, r) {
  return W[11] * Math.pow(d, -W[12]) * (Math.pow(s + 1, W[13]) - 1) * Math.exp((1 - r) * W[14]);
}

// Interval in days for target retention, clamped to [1, 36500], rounded,
// with +/-5% fuzz for intervals over 3 days. rng may be injected for tests
// (rng() === 0.5 disables fuzz).
function nextInterval(stability, retention, rng = Math.random) {
  const days = (stability / FACTOR) * (Math.pow(retention, 1 / DECAY) - 1);
  let ivl = clamp(Math.round(days), 1, 36500);
  if (ivl > 3) {
    ivl = clamp(Math.round(ivl * (1 + (rng() * 0.1 - 0.05))), 1, 36500);
  }
  return ivl;
}

// card: {state, due, stability, difficulty, reps, lapses, step, last_review}
// returns the same fields updated for the given grade (1-4).
function answer(card, grade, nowMs, retention = 0.9, rng = Math.random) {
  const next = { ...card };
  next.reps = (card.reps || 0) + 1;
  next.last_review = nowMs;

  if (card.state === 'review') {
    const s = card.stability || 1;
    const d = card.difficulty || 5;
    const elapsedDays = card.last_review
      ? Math.max(0, (nowMs - card.last_review) / DAY_MS)
      : 0;
    const r = retrievability(elapsedDays, s);
    if (grade === 1) {
      next.state = 'relearning';
      next.step = 0;
      next.due = nowMs + LAPSE_STEP_MINUTES * MINUTE_MS;
      next.lapses = (card.lapses || 0) + 1;
      next.difficulty = nextDifficulty(d, 1);
      next.stability = nextStabilityLapse(d, s, r);
    } else {
      next.difficulty = nextDifficulty(d, grade);
      next.stability = nextStabilityRecall(d, s, r, grade);
      const ivl = nextInterval(next.stability, retention, rng);
      next.state = 'review';
      next.step = 0;
      next.due = startOfDay(nowMs) + ivl * DAY_MS;
    }
    return next;
  }

  // new / learning / relearning: step-based scheduling
  const currentStep = card.step || 0;
  const stayState = card.state === 'new' ? 'learning' : card.state;

  if (grade === 1) {
    next.state = stayState;
    next.step = 0;
    next.due = nowMs + STEP_MINUTES[0] * MINUTE_MS;
    return next;
  }
  if (grade === 2) {
    next.state = stayState;
    next.step = Math.max(1, Math.min(currentStep, 2));
    next.due = nowMs + STEP_MINUTES[1] * MINUTE_MS;
    return next;
  }

  const graduating = grade === 4 || currentStep >= 2;
  if (!graduating) {
    next.state = stayState;
    next.step = 2;
    next.due = nowMs + STEP_MINUTES[2] * MINUTE_MS;
    return next;
  }

  // Graduate to review.
  if (card.state === 'relearning' && card.stability != null) {
    next.stability = card.stability;
    next.difficulty = card.difficulty;
  } else {
    const init = initCard(grade === 4 ? 4 : 3);
    next.stability = init.stability;
    next.difficulty = init.difficulty;
  }
  let ivl = nextInterval(next.stability, retention, rng);
  if (grade === 4) ivl = Math.max(4, ivl);
  next.state = 'review';
  next.step = 0;
  next.due = startOfDay(nowMs) + ivl * DAY_MS;
  return next;
}

// Raw preview values in minutes (fuzz-free), for formatting and tests.
function previewMinutes(card, retention = 0.9, nowMs = Date.now()) {
  const noFuzz = () => 0.5;
  if (card.state === 'review') {
    const s = card.stability || 1;
    const d = card.difficulty || 5;
    const elapsedDays = card.last_review
      ? Math.max(0, (nowMs - card.last_review) / DAY_MS)
      : 0;
    const r = retrievability(elapsedDays, s);
    const perDay = DAY_MS / MINUTE_MS;
    return {
      again: LAPSE_STEP_MINUTES,
      hard: nextInterval(nextStabilityRecall(d, s, r, 2), retention, noFuzz) * perDay,
      good: nextInterval(nextStabilityRecall(d, s, r, 3), retention, noFuzz) * perDay,
      easy: nextInterval(nextStabilityRecall(d, s, r, 4), retention, noFuzz) * perDay,
    };
  }
  const step = card.step || 0;
  const perDay = DAY_MS / MINUTE_MS;
  return {
    again: STEP_MINUTES[0],
    hard: STEP_MINUTES[1],
    good: step >= 2 ? nextInterval(initCard(3).stability, retention, noFuzz) * perDay : STEP_MINUTES[2],
    easy: Math.max(4, nextInterval(initCard(4).stability, retention, noFuzz)) * perDay,
  };
}

function trimDecimal(x) {
  return x.toFixed(1).replace(/\.0$/, '');
}

function formatMinutes(m) {
  if (m < 1) return '<1m';
  if (m < 60) return `${Math.round(m)}m`;
  if (m < 60 * 24) return `${Math.round(m / 60)}h`;
  const days = m / (60 * 24);
  if (days < 30) return `${Math.round(days)}d`;
  if (days < 365) return `${trimDecimal(days / 30)}mo`;
  return `${trimDecimal(days / 365)}y`;
}

// Human labels: {again, hard, good, easy} like '<1m', '10m', '2d', '1.2mo'.
function previewIntervals(card, retention = 0.9, nowMs = Date.now()) {
  const mins = previewMinutes(card, retention, nowMs);
  return {
    again: formatMinutes(mins.again),
    hard: formatMinutes(mins.hard),
    good: formatMinutes(mins.good),
    easy: formatMinutes(mins.easy),
  };
}

module.exports = {
  W,
  DECAY,
  FACTOR,
  DAY_MS,
  retrievability,
  initCard,
  nextDifficulty,
  nextStabilityRecall,
  nextStabilityLapse,
  nextInterval,
  answer,
  previewMinutes,
  previewIntervals,
  formatMinutes,
  startOfDay,
};
