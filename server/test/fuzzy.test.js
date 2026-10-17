'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fuzzy = require('../../public/js/fuzzy.js');

test('fuzzy: exact, word-boundary and accent-folded matches', () => {
  assert.deepEqual(fuzzy.scoreText('paris', 'Paris is lovely').ranges, [[0, 5]]);
  assert.ok(fuzzy.scoreText('cap', 'Capital').score > fuzzy.scoreText('pit', 'Capital').score, 'word start beats mid-word');
  assert.deepEqual(fuzzy.scoreText('creme', 'café crème').ranges, [[5, 10]]);
  assert.deepEqual(fuzzy.scoreText('ÉCOLE', 'une ecole').ranges, [[4, 9]]);
  // decomposed input: highlight covers the combining mark
  assert.deepEqual(fuzzy.scoreText('e', 'e\u0301').ranges, [[0, 2]]);
});

test('fuzzy: typos and half-typed words', () => {
  assert.ok(fuzzy.scoreText('capitl', 'Capital of France'));
  assert.ok(fuzzy.scoreText('captial', 'capital'), 'transposition');
  assert.ok(fuzzy.scoreText('missisipi', 'Mississippi'), 'two edits on long words');
  assert.equal(fuzzy.scoreText('cta', 'cat'), null, 'no typo tolerance under 4 chars');
  assert.ok(fuzzy.scoreText('capitl', 'Capital').score < fuzzy.scoreText('capita', 'Capital').score, 'exact prefix beats typo');
  assert.equal(fuzzy.scoreText('zzzz', 'Capital'), null);
});

test('fuzzy: every term must match; subsequence only when asked', () => {
  assert.equal(fuzzy.scoreText('paris berlin', 'Paris'), null);
  assert.equal(fuzzy.scoreText('gyc', 'Geography Capitals'), null);
  assert.ok(fuzzy.scoreText('gyc', 'Geography Capitals', { subseq: true }));
  const r = fuzzy.scoreFields(['nile', 'river'], [{ text: 'Longest river' }, { text: 'Nile' }]);
  assert.deepEqual(r.ranges, [[[8, 13]], [[0, 4]]]);
});

test('fuzzy: highlight and parts', () => {
  const ranges = fuzzy.highlight(['ca', 'ta'], 'cat tail');
  assert.deepEqual(ranges, [[0, 2], [4, 6]]);
  assert.deepEqual(fuzzy.parts('cat tail', ranges).map((p) => p.hit), [true, false, true, false]);
});
