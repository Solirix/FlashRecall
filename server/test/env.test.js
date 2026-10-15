'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { load } = require('../env');

function withEnvFile(contents, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-env-'));
  const file = path.join(dir, '.env');
  fs.writeFileSync(file, contents);
  try {
    fn(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('missing .env file is a no-op', () => {
  assert.doesNotThrow(() => load(path.join(os.tmpdir(), 'recall-no-such-file', '.env')));
});

test('parses KEY=VALUE, skips comments and blank lines', () => {
  withEnvFile('# comment\n\nRECALL_PORT=8080\nREGISTRATION_OPEN=false\n', (file) => {
    delete process.env.RECALL_PORT;
    delete process.env.REGISTRATION_OPEN;
    load(file);
    assert.strictEqual(process.env.RECALL_PORT, '8080');
    assert.strictEqual(process.env.REGISTRATION_OPEN, 'false');
    delete process.env.RECALL_PORT;
    delete process.env.REGISTRATION_OPEN;
  });
});

test('strips surrounding quotes and preserves = in values', () => {
  withEnvFile('QUOTED="hello world"\nSINGLE=\'x\'\nWITH_EQ=a=b=c\n', (file) => {
    for (const k of ['QUOTED', 'SINGLE', 'WITH_EQ']) delete process.env[k];
    load(file);
    assert.strictEqual(process.env.QUOTED, 'hello world');
    assert.strictEqual(process.env.SINGLE, 'x');
    assert.strictEqual(process.env.WITH_EQ, 'a=b=c');
    for (const k of ['QUOTED', 'SINGLE', 'WITH_EQ']) delete process.env[k];
  });
});

test('real environment variables win over .env', () => {
  withEnvFile('RECALL_PORT=9999\n', (file) => {
    process.env.RECALL_PORT = '1234';
    load(file);
    assert.strictEqual(process.env.RECALL_PORT, '1234');
    delete process.env.RECALL_PORT;
  });
});

test('ignores malformed lines and invalid keys', () => {
  withEnvFile('NO_EQUALS\n=BADKEY\n1BAD=1\nGOOD_KEY=ok\n', (file) => {
    delete process.env.GOOD_KEY;
    load(file);
    assert.strictEqual(process.env.GOOD_KEY, 'ok');
    assert.strictEqual(process.env.NO_EQUALS, undefined);
    assert.strictEqual(process.env['1BAD'], undefined);
    delete process.env.GOOD_KEY;
  });
});
