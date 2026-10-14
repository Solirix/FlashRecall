'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, client, registerUser } = require('./helpers');

async function seed(call) {
  await registerUser(call, 'tess');
  const deck = (await call('POST', '/api/decks', { name: 'Geo' })).data;
  const sub = (await call('POST', '/api/decks', { name: 'Capitals', parentId: deck.id })).data;
  const add = (deckId, body) => call('POST', '/api/notes', { deckId, type: 'basic', ...body });
  await add(deck.id, { front: 'Largest ocean?', back: '**Pacific**\nCovers about a third of Earth' });
  await add(deck.id, { front: 'Longest river?', back: 'Nile' });
  await add(sub.id, { front: 'Capital of France?', back: 'Paris' });
  await add(sub.id, { front: 'Capital of Japan?', back: 'Tokyo' });
  await add(sub.id, { front: 'Front only, no answer', back: '' });
  await call('POST', '/api/notes', {
    deckId: sub.id, type: 'cloze', front: '{{c1::Canberra}} is the capital of {{c2::Australia::country}}',
  });
  return { deck, sub };
}

test('practice test: items, subdecks, formats, cloze, filters', async () => {
  const app = await boot();
  try {
    const call = client(app.base);
    const { deck, sub } = await seed(call);

    // whole tree, written: front-only card is skipped (nothing to check against)
    let res = await call('GET', `/api/decks/${deck.id}/practice?count=50&format=written`);
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.equal(res.data.deck.name, 'Geo');
    assert.equal(res.data.available, 6);
    assert.equal(res.data.items.length, 6);
    assert.ok(res.data.items.every((i) => i.format === 'written' && !i.choices));
    const ocean = res.data.items.find((i) => i.prompt === 'Largest ocean?');
    assert.equal(ocean.expected, 'Pacific', 'first line of back, markdown stripped');
    assert.match(ocean.answer, /third of Earth/);

    const c1 = res.data.items.find((i) => i.type === 'cloze' && i.expected === 'Canberra');
    assert.equal(c1.prompt, '[…] is the capital of Australia');
    assert.equal(c1.answer, 'Canberra is the capital of Australia');
    const c2 = res.data.items.find((i) => i.type === 'cloze' && i.expected === 'Australia');
    assert.equal(c2.prompt, 'Canberra is the capital of [country]');

    // no count param -> default of 20, not 1
    res = await call('GET', `/api/decks/${deck.id}/practice`);
    assert.equal(res.data.items.length, 6);

    // without sub-decks, count limit honoured
    res = await call('GET', `/api/decks/${deck.id}/practice?count=1&subdecks=0`);
    assert.equal(res.data.available, 2);
    assert.equal(res.data.items.length, 1);

    // multiple choice: 4 distinct options including the right one
    res = await call('GET', `/api/decks/${sub.id}/practice?count=50&format=choice`);
    for (const item of res.data.items) {
      assert.equal(item.format, 'choice');
      assert.equal(item.choices.length, 4);
      assert.ok(item.choices.includes(item.expected));
      assert.equal(new Set(item.choices.map((c) => c.toLowerCase())).size, 4);
    }

    // studied-only: nothing studied yet
    res = await call('GET', `/api/decks/${deck.id}/practice?scope=studied`);
    assert.equal(res.data.available, 0);
    assert.deepEqual(res.data.items, []);

    // validation + ownership
    assert.equal((await call('GET', `/api/decks/${deck.id}/practice?format=bogus`)).status, 400);
    const other = client(app.base);
    await registerUser(other, 'mallory');
    assert.equal((await other('GET', `/api/decks/${deck.id}/practice`)).status, 404);
  } finally {
    await app.close();
  }
});
