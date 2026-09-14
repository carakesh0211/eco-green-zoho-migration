import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolveCutover, evaluateEligibility, ELIGIBILITY_REASONS } from '../src/core/cutover.js';

function rule(overrides = {}) {
  return {
    branch_code: 'PILOT01',
    transaction_class: '*',
    payment_method: '*',
    migration_from_date: '2026-04-01',
    live_system_start_date: '2026-06-01',
    historical_migration_end_date: '2026-05-31',
    smart_pharma_coverage_status: 'NOT_COVERED',
    approval_status: 'APPROVED',
    cutover_rule_version: 'cut_v1',
    ...overrides,
  };
}

function voucher(overrides = {}) {
  return { transaction_date: '2026-04-15', source_modified_at: null, ...overrides };
}

describe('resolveCutover specificity', () => {
  test('picks (class, payment_method) over (class, *) and (*, *)', () => {
    const rows = [
      rule({ transaction_class: '*', payment_method: '*', cutover_rule_version: 'r1' }),
      rule({ transaction_class: 'SALES_B2C', payment_method: '*', cutover_rule_version: 'r2' }),
      rule({ transaction_class: 'SALES_B2C', payment_method: 'CASH', cutover_rule_version: 'r3' }),
    ];
    const picked = resolveCutover(rows, { branchCode: 'PILOT01', voucherType: 'SALES_B2C', paymentMethod: 'CASH' });
    assert.equal(picked.cutover_rule_version, 'r3');
  });

  test('falls back to (class, *) when no exact payment_method row', () => {
    const rows = [
      rule({ transaction_class: '*', payment_method: '*', cutover_rule_version: 'r1' }),
      rule({ transaction_class: 'SALES_B2C', payment_method: '*', cutover_rule_version: 'r2' }),
    ];
    const picked = resolveCutover(rows, { branchCode: 'PILOT01', voucherType: 'SALES_B2C', paymentMethod: 'UPI' });
    assert.equal(picked.cutover_rule_version, 'r2');
  });

  test('falls back to (*, *) when no class-specific row', () => {
    const rows = [rule({ transaction_class: '*', payment_method: '*', cutover_rule_version: 'r1' })];
    const picked = resolveCutover(rows, { branchCode: 'PILOT01', voucherType: 'PURCHASE', paymentMethod: 'BANK' });
    assert.equal(picked.cutover_rule_version, 'r1');
  });

  test('returns null when nothing applies', () => {
    const rows = [rule({ branch_code: 'OTHER', cutover_rule_version: 'r1' })];
    assert.equal(resolveCutover(rows, { branchCode: 'PILOT01', voucherType: 'PURCHASE', paymentMethod: 'BANK' }), null);
  });

  test('DRAFT rows are ignored even if more specific', () => {
    const rows = [
      rule({ transaction_class: '*', payment_method: '*', cutover_rule_version: 'r1', approval_status: 'APPROVED' }),
      rule({ transaction_class: 'SALES_B2C', payment_method: 'CASH', cutover_rule_version: 'r2', approval_status: 'DRAFT' }),
    ];
    const picked = resolveCutover(rows, { branchCode: 'PILOT01', voucherType: 'SALES_B2C', paymentMethod: 'CASH' });
    assert.equal(picked.cutover_rule_version, 'r1');
  });

  test('REVOKED rows are ignored', () => {
    const rows = [
      rule({ transaction_class: 'SALES_B2C', payment_method: 'CASH', cutover_rule_version: 'r2', approval_status: 'REVOKED' }),
    ];
    assert.equal(resolveCutover(rows, { branchCode: 'PILOT01', voucherType: 'SALES_B2C', paymentMethod: 'CASH' }), null);
  });
});

describe('evaluateEligibility reasons', () => {
  test('RULE_MISSING when no rule at all', () => {
    const r = evaluateEligibility(null, voucher());
    assert.deepEqual(r, { eligible: false, reason: ELIGIBILITY_REASONS.RULE_MISSING });
  });

  test('LIVE_START_UNVERIFIED when live_system_start_date is null', () => {
    const r = evaluateEligibility(rule({ live_system_start_date: null, smart_pharma_coverage_status: 'NOT_COVERED' }), voucher());
    assert.equal(r.reason, ELIGIBILITY_REASONS.LIVE_START_UNVERIFIED);
    assert.equal(r.eligible, false);
  });

  test('LIVE_START_UNVERIFIED when live_system_start_date is empty string', () => {
    const r = evaluateEligibility(rule({ live_system_start_date: '' }), voucher());
    assert.equal(r.reason, ELIGIBILITY_REASONS.LIVE_START_UNVERIFIED);
  });

  test('LIVE_START_UNVERIFIED when coverage is UNKNOWN, even with a live_system_start_date', () => {
    const r = evaluateEligibility(rule({ smart_pharma_coverage_status: 'UNKNOWN' }), voucher());
    assert.equal(r.reason, ELIGIBILITY_REASONS.LIVE_START_UNVERIFIED);
  });

  test('BEFORE_MIGRATION_FROM when transaction_date precedes migration_from_date', () => {
    const r = evaluateEligibility(rule(), voucher({ transaction_date: '2026-03-31' }));
    assert.equal(r.reason, ELIGIBILITY_REASONS.BEFORE_MIGRATION_FROM);
    assert.equal(r.eligible, false);
  });

  test('AFTER_CUTOVER when transaction_date is on/after live_system_start_date', () => {
    const r = evaluateEligibility(rule(), voucher({ transaction_date: '2026-06-15' }));
    assert.equal(r.reason, ELIGIBILITY_REASONS.AFTER_CUTOVER);
  });

  test('boundary: transaction_date == live_system_start_date -> AFTER_CUTOVER', () => {
    const r = evaluateEligibility(rule(), voucher({ transaction_date: '2026-06-01' }));
    assert.equal(r.reason, ELIGIBILITY_REASONS.AFTER_CUTOVER);
  });

  test('boundary: transaction_date == historical_migration_end_date -> IN_WINDOW', () => {
    const r = evaluateEligibility(rule(), voucher({ transaction_date: '2026-05-31' }));
    assert.equal(r.reason, ELIGIBILITY_REASONS.IN_WINDOW);
    assert.equal(r.eligible, true);
  });

  test('AFTER_CUTOVER when transaction_date exceeds historical_migration_end_date even if before live_system_start_date', () => {
    const r = evaluateEligibility(
      rule({ live_system_start_date: '2026-07-01', historical_migration_end_date: '2026-05-31' }),
      voucher({ transaction_date: '2026-06-10' }),
    );
    assert.equal(r.reason, ELIGIBILITY_REASONS.AFTER_CUTOVER);
  });

  test('LATE_OR_BACK_POSTED when source_modified_at date >= live_system_start_date, even though transaction_date is in window', () => {
    const r = evaluateEligibility(rule(), voucher({ transaction_date: '2026-04-15', source_modified_at: '2026-06-01T10:00:00Z' }));
    assert.equal(r.reason, ELIGIBILITY_REASONS.LATE_OR_BACK_POSTED);
    assert.equal(r.eligible, false);
  });

  test('not LATE_OR_BACK_POSTED when source_modified_at is before live_system_start_date', () => {
    const r = evaluateEligibility(rule(), voucher({ transaction_date: '2026-04-15', source_modified_at: '2026-04-16T10:00:00Z' }));
    assert.equal(r.reason, ELIGIBILITY_REASONS.IN_WINDOW);
  });

  test('IN_WINDOW for a plain mid-window voucher with no modification', () => {
    const r = evaluateEligibility(rule(), voucher({ transaction_date: '2026-05-01' }));
    assert.deepEqual(r, { eligible: true, reason: ELIGIBILITY_REASONS.IN_WINDOW });
  });

  test('priority: RULE_MISSING wins over everything else', () => {
    const r = evaluateEligibility(null, voucher({ transaction_date: '1999-01-01' }));
    assert.equal(r.reason, ELIGIBILITY_REASONS.RULE_MISSING);
  });

  test('priority: LIVE_START_UNVERIFIED wins over BEFORE_MIGRATION_FROM', () => {
    const r = evaluateEligibility(rule({ live_system_start_date: null }), voucher({ transaction_date: '2020-01-01' }));
    assert.equal(r.reason, ELIGIBILITY_REASONS.LIVE_START_UNVERIFIED);
  });

  test('priority: AFTER_CUTOVER wins over LATE_OR_BACK_POSTED evaluation (not reached)', () => {
    const r = evaluateEligibility(rule(), voucher({ transaction_date: '2026-06-02', source_modified_at: '2026-04-01' }));
    assert.equal(r.reason, ELIGIBILITY_REASONS.AFTER_CUTOVER);
  });
});
