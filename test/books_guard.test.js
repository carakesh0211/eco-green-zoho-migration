import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isPostingEnabled,
  assertPostingAllowed,
  assertOrgAllowed,
  loadBooksConfig,
  PostingDisabledError,
} from '../src/books/guard.js';

function validConfig(overrides = {}) {
  return {
    driver: 'live',
    postingEnabled: true,
    postingAuthorizationRef: 'change-ref-2026-09-14',
    orgAllowlist: ['org_pilot_01'],
    organizationId: 'org_pilot_01',
    ...overrides,
  };
}

test('isPostingEnabled: true only when every condition holds', () => {
  assert.equal(isPostingEnabled(validConfig()), true);
});

test('isPostingEnabled: false when config is missing/undefined', () => {
  assert.equal(isPostingEnabled(undefined), false);
  assert.equal(isPostingEnabled(null), false);
});

test('isPostingEnabled: driver mock never enables live posting, even with everything else valid', () => {
  const cfg = validConfig({ driver: 'mock' });
  assert.equal(isPostingEnabled(cfg), false);
  assert.throws(() => assertPostingAllowed(cfg), /driver is not "live"/);
});

test('isPostingEnabled: postingEnabled must be strictly boolean true, not the string "true"', () => {
  assert.equal(isPostingEnabled(validConfig({ postingEnabled: 'true' })), false);
});

test('isPostingEnabled: string "True"/"1" style values never enable posting', () => {
  // Only the literal boolean `true` may pass; every stringly-typed/truthy-but-not-true variant must fail.
  for (const v of ['True', 'TRUE', '1', 'yes', 1]) {
    assert.equal(isPostingEnabled(validConfig({ postingEnabled: v })), false, `postingEnabled=${JSON.stringify(v)} must not enable`);
  }
});

test('isPostingEnabled: false when postingEnabled is false', () => {
  const cfg = validConfig({ postingEnabled: false });
  assert.equal(isPostingEnabled(cfg), false);
  assert.throws(() => assertPostingAllowed(cfg), (e) => e instanceof PostingDisabledError && /POSTING_ENABLED/.test(e.reason));
});

test('isPostingEnabled: false when postingAuthorizationRef is empty or missing', () => {
  assert.equal(isPostingEnabled(validConfig({ postingAuthorizationRef: '' })), false);
  assert.equal(isPostingEnabled(validConfig({ postingAuthorizationRef: '   ' })), false);
  assert.equal(isPostingEnabled(validConfig({ postingAuthorizationRef: undefined })), false);
  assert.throws(
    () => assertPostingAllowed(validConfig({ postingAuthorizationRef: '' })),
    (e) => e instanceof PostingDisabledError && /postingAuthorizationRef/.test(e.reason),
  );
});

test('isPostingEnabled: empty allowlist blocks posting even with everything else valid', () => {
  const cfg = validConfig({ orgAllowlist: [] });
  assert.equal(isPostingEnabled(cfg), false);
  assert.throws(() => assertPostingAllowed(cfg), (e) => e instanceof PostingDisabledError && /orgAllowlist is empty/.test(e.reason));
});

test('isPostingEnabled: missing/non-array allowlist blocks posting', () => {
  assert.equal(isPostingEnabled(validConfig({ orgAllowlist: undefined })), false);
  assert.equal(isPostingEnabled(validConfig({ orgAllowlist: 'org_pilot_01' })), false);
});

test('isPostingEnabled: organizationId not in allowlist blocks posting', () => {
  const cfg = validConfig({ organizationId: 'org_other' });
  assert.equal(isPostingEnabled(cfg), false);
  assert.throws(
    () => assertPostingAllowed(cfg),
    (e) => e instanceof PostingDisabledError && /org_other/.test(e.reason) && /not in orgAllowlist/.test(e.reason),
  );
});

test('isPostingEnabled: missing organizationId blocks posting', () => {
  assert.equal(isPostingEnabled(validConfig({ organizationId: undefined })), false);
  assert.equal(isPostingEnabled(validConfig({ organizationId: '' })), false);
});

test('assertPostingAllowed: does not throw for a fully valid config', () => {
  assert.doesNotThrow(() => assertPostingAllowed(validConfig()));
});

test('assertPostingAllowed: error carries code POSTING_DISABLED', () => {
  try {
    assertPostingAllowed(validConfig({ driver: 'mock' }));
    assert.fail('expected throw');
  } catch (e) {
    assert.equal(e.code, 'POSTING_DISABLED');
  }
});

test('assertOrgAllowed: live driver + allowlisted org does not throw', () => {
  assert.doesNotThrow(() => assertOrgAllowed(validConfig()));
});

test('assertOrgAllowed: live driver + non-allowlisted org throws (blocks even reads)', () => {
  assert.throws(() => assertOrgAllowed(validConfig({ organizationId: 'org_wrong' })), PostingDisabledError);
});

test('assertOrgAllowed: live driver + empty allowlist throws', () => {
  assert.throws(() => assertOrgAllowed(validConfig({ orgAllowlist: [] })), PostingDisabledError);
});

test('assertOrgAllowed: mock driver is never restricted, regardless of allowlist', () => {
  assert.doesNotThrow(() => assertOrgAllowed({ driver: 'mock', organizationId: 'anything', orgAllowlist: [] }));
  assert.doesNotThrow(() => assertOrgAllowed(undefined));
});

test('loadBooksConfig: POSTING_ENABLED parses strictly from the string "true" only', () => {
  assert.equal(loadBooksConfig({ POSTING_ENABLED: 'true' }).postingEnabled, true);
  for (const v of ['True', 'TRUE', '1', 'yes', 'false', '', undefined]) {
    assert.equal(loadBooksConfig({ POSTING_ENABLED: v }).postingEnabled, false, `POSTING_ENABLED=${JSON.stringify(v)}`);
  }
});

test('loadBooksConfig: parses and trims the comma-separated org allowlist', () => {
  const cfg = loadBooksConfig({ BOOKS_ORG_ALLOWLIST: ' org1, org2 ,org3,' });
  assert.deepEqual(cfg.orgAllowlist, ['org1', 'org2', 'org3']);
});

test('loadBooksConfig: empty/undefined allowlist parses to []', () => {
  assert.deepEqual(loadBooksConfig({}).orgAllowlist, []);
  assert.deepEqual(loadBooksConfig({ BOOKS_ORG_ALLOWLIST: '' }).orgAllowlist, []);
});

test('loadBooksConfig: defaults driver to mock and posting to disabled when env is empty', () => {
  const cfg = loadBooksConfig({});
  assert.equal(cfg.driver, 'mock');
  assert.equal(cfg.postingEnabled, false);
  assert.equal(cfg.postingAuthorizationRef, '');
  assert.equal(isPostingEnabled(cfg), false);
});

test('loadBooksConfig: numeric env vars fall back to sane defaults when unset/invalid', () => {
  const cfg = loadBooksConfig({ BOOKS_RATE_LIMIT_PER_MINUTE: 'not-a-number' });
  assert.equal(cfg.rateLimitPerMinute, 100);
  assert.equal(cfg.maxConcurrency, 2);
  assert.equal(cfg.requestTimeoutMs, 30000);
  assert.equal(cfg.maxAttempts, 5);
});
