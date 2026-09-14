import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyResponse, parseRetryAfterMs } from '../src/books/classify.js';

test('classifyResponse: 2xx statuses are SUCCESS', () => {
  for (const status of [200, 201, 204, 299]) {
    assert.equal(classifyResponse({ status }).class, 'SUCCESS', `status ${status}`);
  }
});

test('classifyResponse: 2xx with an unparseable body is UNKNOWN, not SUCCESS', () => {
  const result = classifyResponse({ status: 200, bodyParseError: true });
  assert.equal(result.class, 'UNKNOWN');
});

test('classifyResponse: 429 is RATE_LIMIT and parses Retry-After (seconds) into retry_after_ms', () => {
  const withHeader = classifyResponse({ status: 429, retryAfterHeader: '5' });
  assert.equal(withHeader.class, 'RATE_LIMIT');
  assert.equal(withHeader.retry_after_ms, 5000);

  const fractional = classifyResponse({ status: 429, retryAfterHeader: '2.5' });
  assert.equal(fractional.retry_after_ms, 2500);
});

test('classifyResponse: 429 without a Retry-After header has retry_after_ms null', () => {
  const result = classifyResponse({ status: 429 });
  assert.equal(result.class, 'RATE_LIMIT');
  assert.equal(result.retry_after_ms, null);
});

test('classifyResponse: 429 with a garbage Retry-After header falls back to null', () => {
  const result = classifyResponse({ status: 429, retryAfterHeader: 'not-a-number' });
  assert.equal(result.retry_after_ms, null);
});

test('classifyResponse: 500/502/503/504 are RETRYABLE', () => {
  for (const status of [500, 502, 503, 504]) {
    assert.equal(classifyResponse({ status }).class, 'RETRYABLE', `status ${status}`);
  }
});

test('classifyResponse: 401 and 403 are AUTH', () => {
  assert.equal(classifyResponse({ status: 401 }).class, 'AUTH');
  assert.equal(classifyResponse({ status: 403 }).class, 'AUTH');
});

test('classifyResponse: other 4xx statuses are NON_RETRYABLE', () => {
  for (const status of [400, 404, 405, 409, 422]) {
    assert.equal(classifyResponse({ status }).class, 'NON_RETRYABLE', `status ${status}`);
  }
});

test('classifyResponse: no HTTP status at all (network error before send) is RETRYABLE', () => {
  const result = classifyResponse({ error: new Error('ECONNRESET') });
  assert.equal(result.class, 'RETRYABLE');
});

test('classifyResponse: timedOutAfterSend always wins and is UNKNOWN, regardless of status', () => {
  assert.equal(classifyResponse({ timedOutAfterSend: true }).class, 'UNKNOWN');
  assert.equal(classifyResponse({ timedOutAfterSend: true, status: 200 }).class, 'UNKNOWN');
  assert.equal(classifyResponse({ timedOutAfterSend: true, status: 500 }).class, 'UNKNOWN');
});

test('classifyResponse: unexpected/unrecognised status codes are conservatively UNKNOWN', () => {
  assert.equal(classifyResponse({ status: 100 }).class, 'UNKNOWN');
  assert.equal(classifyResponse({ status: 599 }).class, 'UNKNOWN');
  assert.equal(classifyResponse({ status: 999 }).class, 'UNKNOWN');
});

test('parseRetryAfterMs: parses seconds into milliseconds', () => {
  assert.equal(parseRetryAfterMs('0'), 0);
  assert.equal(parseRetryAfterMs('1'), 1000);
  assert.equal(parseRetryAfterMs(2), 2000);
  assert.equal(parseRetryAfterMs('2.5'), 2500);
});

test('parseRetryAfterMs: absent/invalid values parse to null', () => {
  assert.equal(parseRetryAfterMs(undefined), null);
  assert.equal(parseRetryAfterMs(null), null);
  assert.equal(parseRetryAfterMs(''), null);
  assert.equal(parseRetryAfterMs('abc'), null);
  assert.equal(parseRetryAfterMs('-5'), null);
});
