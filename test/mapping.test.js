import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRule, AmbiguousMappingError } from '../src/core/mapping.js';

function ledgerRule(overrides = {}) {
  return {
    rule_type: 'LEDGER_ACCOUNT', source_key: 'LEDG-1001', target_value: 'ACC-1',
    mapping_version: 'map_v1', effective_from: '2026-01-01', effective_to: null, status: 'APPROVED',
    ...overrides,
  };
}

describe('resolveRule', () => {
  test('returns the single APPROVED rule whose window contains onDate (open-ended effective_to)', () => {
    const rules = [ledgerRule()];
    const r = resolveRule(rules, 'LEDGER_ACCOUNT', 'LEDG-1001', '2026-05-01');
    assert.equal(r.target_value, 'ACC-1');
  });

  test('returns null when no rule matches the ruleType/sourceKey', () => {
    const rules = [ledgerRule()];
    assert.equal(resolveRule(rules, 'LEDGER_ACCOUNT', 'LEDG-9999', '2026-05-01'), null);
  });

  test('returns null when onDate is before effective_from', () => {
    const rules = [ledgerRule({ effective_from: '2026-06-01' })];
    assert.equal(resolveRule(rules, 'LEDGER_ACCOUNT', 'LEDG-1001', '2026-05-01'), null);
  });

  test('returns null when onDate is after effective_to', () => {
    const rules = [ledgerRule({ effective_to: '2026-04-30' })];
    assert.equal(resolveRule(rules, 'LEDGER_ACCOUNT', 'LEDG-1001', '2026-05-01'), null);
  });

  test('window is inclusive on both ends', () => {
    const rules = [ledgerRule({ effective_from: '2026-04-01', effective_to: '2026-04-30' })];
    assert.ok(resolveRule(rules, 'LEDGER_ACCOUNT', 'LEDG-1001', '2026-04-01'));
    assert.ok(resolveRule(rules, 'LEDGER_ACCOUNT', 'LEDG-1001', '2026-04-30'));
    assert.equal(resolveRule(rules, 'LEDGER_ACCOUNT', 'LEDG-1001', '2026-05-01'), null);
  });

  test('ignores DRAFT/RETIRED rules', () => {
    const rules = [ledgerRule({ status: 'DRAFT' }), ledgerRule({ status: 'RETIRED', mapping_version: 'map_v2' })];
    assert.equal(resolveRule(rules, 'LEDGER_ACCOUNT', 'LEDG-1001', '2026-05-01'), null);
  });

  test('throws AmbiguousMappingError when two APPROVED rules apply on the same date', () => {
    const rules = [
      ledgerRule({ mapping_version: 'map_v1', target_value: 'ACC-1' }),
      ledgerRule({ mapping_version: 'map_v2', target_value: 'ACC-2' }),
    ];
    assert.throws(
      () => resolveRule(rules, 'LEDGER_ACCOUNT', 'LEDG-1001', '2026-05-01'),
      (err) => err instanceof AmbiguousMappingError && err.code === 'AMBIGUOUS_MAPPING',
    );
  });

  test('non-overlapping successive versions are not ambiguous', () => {
    const rules = [
      ledgerRule({ mapping_version: 'map_v1', effective_from: '2026-01-01', effective_to: '2026-03-31', target_value: 'ACC-OLD' }),
      ledgerRule({ mapping_version: 'map_v2', effective_from: '2026-04-01', effective_to: null, target_value: 'ACC-NEW' }),
    ];
    assert.equal(resolveRule(rules, 'LEDGER_ACCOUNT', 'LEDG-1001', '2026-02-01').target_value, 'ACC-OLD');
    assert.equal(resolveRule(rules, 'LEDGER_ACCOUNT', 'LEDG-1001', '2026-04-01').target_value, 'ACC-NEW');
  });

  test('accepts a full ISO datetime for onDate (date-part only)', () => {
    const rules = [ledgerRule({ effective_from: '2026-04-01', effective_to: '2026-04-30' })];
    assert.ok(resolveRule(rules, 'LEDGER_ACCOUNT', 'LEDG-1001', '2026-04-15T10:30:00Z'));
  });

  test('different rule_type/source_key combinations do not collide', () => {
    const rules = [
      ledgerRule({ rule_type: 'PARTY', source_key: 'V-PARTY-007', target_value: 'CONTACT-1' }),
      ledgerRule({ rule_type: 'LEDGER_ACCOUNT', source_key: 'V-PARTY-007', target_value: 'ACC-X' }),
    ];
    assert.equal(resolveRule(rules, 'PARTY', 'V-PARTY-007', '2026-05-01').target_value, 'CONTACT-1');
    assert.equal(resolveRule(rules, 'LEDGER_ACCOUNT', 'V-PARTY-007', '2026-05-01').target_value, 'ACC-X');
  });
});
