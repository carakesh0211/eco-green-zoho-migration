import { test } from 'node:test';
import assert from 'node:assert/strict';
import { log, redact } from '../src/core/log.js';

test('redact: masks keys matching the sensitive pattern, recursively', () => {
  const input = {
    token: 'abc',
    access_token: 'abc',
    secret: 'xyz',
    client_secret: 'xyz',
    password: 'p',
    Authorization: 'Bearer xyz',
    refresh_token: 'r',
    nested: { password: 'deep', ok: 'fine' },
    list: [{ secret: 'in-array' }, 'plain'],
    fine: 'kept',
  };
  const out = redact(input);
  assert.equal(out.token, '[REDACTED]');
  assert.equal(out.access_token, '[REDACTED]');
  assert.equal(out.secret, '[REDACTED]');
  assert.equal(out.client_secret, '[REDACTED]');
  assert.equal(out.password, '[REDACTED]');
  assert.equal(out.Authorization, '[REDACTED]');
  assert.equal(out.refresh_token, '[REDACTED]');
  assert.equal(out.nested.password, '[REDACTED]');
  assert.equal(out.nested.ok, 'fine');
  assert.equal(out.list[0].secret, '[REDACTED]');
  assert.equal(out.list[1], 'plain');
  assert.equal(out.fine, 'kept');
});

test('redact: leaves non-sensitive primitives, null and undefined alone', () => {
  assert.equal(redact(null), null);
  assert.equal(redact(undefined), undefined);
  assert.equal(redact(42), 42);
  assert.equal(redact('hello'), 'hello');
  assert.deepEqual(redact([1, 2, 3]), [1, 2, 3]);
});

test('redact: handles BigInt without throwing', () => {
  const out = redact({ amount: 12345n, secret: 'x' });
  assert.equal(out.amount, '12345');
  assert.equal(out.secret, '[REDACTED]');
});

test('redact: never throws on a circular structure', () => {
  const obj = { a: 1 };
  obj.self = obj;
  assert.doesNotThrow(() => redact(obj));
});

test('log: writes one JSON line to stdout with redacted fields', () => {
  const lines = [];
  const original = console.log;
  console.log = (line) => lines.push(line);
  try {
    log('info', 'something happened', { token: 'secret-value', ok: true });
  } finally {
    console.log = original;
  }
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.level, 'info');
  assert.equal(parsed.msg, 'something happened');
  assert.equal(parsed.token, '[REDACTED]');
  assert.equal(parsed.ok, true);
  assert.ok(parsed.ts);
});

test('log: never throws even when fields are unserializable or malformed', () => {
  const original = console.log;
  console.log = () => {};
  try {
    const circular = {};
    circular.self = circular;
    assert.doesNotThrow(() => log('error', 'circular', circular));
    assert.doesNotThrow(() => log('error', 'no fields'));
    assert.doesNotThrow(() => log('error', 'bigint', { amount: 5n }));
    assert.doesNotThrow(() => log(undefined, undefined, undefined));
  } finally {
    console.log = original;
  }
});
