'use strict';

// The checker ships to the browser as an ES module; load it the same way here.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = () => import(pathToFileURL(path.join(__dirname, '../../public/js/answercheck.js')).href);

test('checkAnswer accepts equivalent answers', async () => {
  const { checkAnswer } = await load();
  const ok = (given, expected) => assert.equal(checkAnswer(given, expected).correct, true, `${given} vs ${expected}`);
  ok('Paris', 'Paris');
  ok('  paris. ', 'Paris');
  ok('the Pacific', 'Pacific');
  ok('Pacific Ocean', 'Pacific Ocean');
  ok('Pacfic', 'Pacific'); // typo
  ok('Tokyo', '**Tokyo**');
  ok('color', 'colour / color');
  ok('colour', 'colour or color');
  ok('Paris', 'Paris (France)');
  ok('el nino', 'el niño');
  ok('cancion', 'canción');
  ok('green, red', 'red, green');
  ok('1000', '1,000');
  ok("dont", 'don’t');
  ok('shakespeare', 'William Shakespeare'); // most of the answer, nothing extra
  ok('Pacific', 'Pacific Ocean');
  ok('mitochondria produce energy for the cell as ATP',
    'The mitochondria produce ATP, the energy currency of the cell');
});

test('checkAnswer rejects wrong answers', async () => {
  const { checkAnswer } = await load();
  const no = (given, expected) => assert.equal(checkAnswer(given, expected).correct, false, `${given} vs ${expected}`);
  no('', 'Paris');
  no('   ', 'Paris');
  no('London', 'Paris');
  no('cat', 'car'); // short words need to be exact
  no('red', 'red, green'); // only part of a list
  no('william', 'William Shakespeare Jr the Third');
  no('Atlantic', 'Pacific');
  no('ribosomes make proteins', 'The mitochondria produce ATP, the energy currency of the cell');
  assert.equal(checkAnswer('', 'x').reason, 'No answer');
});

test('checkAnswer flags fuzzy verdicts as unsure', async () => {
  const { checkAnswer } = await load();
  assert.equal(checkAnswer('Paris', 'Paris').sure, true);
  assert.equal(checkAnswer('1000', '1,000').reason, 'Exact match');
  assert.equal(checkAnswer('Pacfic', 'Pacific').sure, false);
  assert.equal(checkAnswer('shakespeare', 'William Shakespeare').sure, false);
});
