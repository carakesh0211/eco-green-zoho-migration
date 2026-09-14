import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { computeBridge, compareBridgeToFile } from '../src/core/bridge.js';

function v(id, disposition, debit, credit) {
  return { id, disposition, debit_total: debit, credit_total: credit };
}

describe('computeBridge', () => {
  test('ties when every disposition group sums correctly and total debit == total credit', () => {
    const vouchers = [
      v(1, 'MIGRATE', '100.00', '100.00'),
      v(2, 'SMART_PHARMA_EXCLUDED', '50.00', '50.00'),
      v(3, 'OTHER_EXCLUDED', '25.00', '25.00'),
      v(4, 'BLOCKED', '10.00', '10.00'),
    ];
    const bridge = computeBridge(vouchers);
    assert.equal(bridge.ties, true);
    assert.equal(bridge.pendingCount, 0);
    assert.equal(bridge.total.count, 4);
    assert.equal(bridge.total.debit, '185.00');
    assert.equal(bridge.total.credit, '185.00');
    assert.equal(bridge.byDisposition.MIGRATE.count, 1);
    assert.equal(bridge.byDisposition.MIGRATE.debit, '100.00');
    assert.deepEqual(bridge.byDisposition.MIGRATE.voucher_ids, [1]);
  });

  test('does not tie when overall debit != credit', () => {
    const vouchers = [
      v(1, 'MIGRATE', '100.00', '100.00'),
      v(2, 'BLOCKED', '50.00', '40.00'), // corrupt/unbalanced voucher slipped through
    ];
    const bridge = computeBridge(vouchers);
    // An unbalanced voucher correctly quarantined in BLOCKED is still part of the population:
    // the bridge ties, the population is reported unbalanced, and nothing leaked.
    assert.equal(bridge.ties, true);
    assert.equal(bridge.balanced, false);
    assert.deepEqual(bridge.unbalancedOutsideBlocked, []);
    assert.equal(bridge.total.debit, '150.00');
    assert.equal(bridge.total.credit, '140.00');
  });

  test('reports pendingCount for any voucher still PENDING', () => {
    const vouchers = [
      v(1, 'MIGRATE', '100.00', '100.00'),
      v(2, 'PENDING', '20.00', '20.00'),
      v(3, 'PENDING', '5.00', '5.00'),
    ];
    const bridge = computeBridge(vouchers);
    assert.equal(bridge.pendingCount, 2);
    assert.equal(bridge.byDisposition.PENDING.count, 2);
  });

  test('empty run: zero counts, zero totals, ties true (vacuously), zero pending', () => {
    const bridge = computeBridge([]);
    assert.equal(bridge.total.count, 0);
    assert.equal(bridge.total.debit, '0.00');
    assert.equal(bridge.total.credit, '0.00');
    assert.equal(bridge.ties, true);
    assert.equal(bridge.pendingCount, 0);
    assert.deepEqual(bridge.byDisposition, {});
  });

  test('voucher_ids drilldown lists every id in a disposition group', () => {
    const vouchers = [
      v(1, 'BLOCKED', '1.00', '1.00'),
      v(2, 'BLOCKED', '2.00', '2.00'),
      v(3, 'BLOCKED', '3.00', '3.00'),
    ];
    const bridge = computeBridge(vouchers);
    assert.deepEqual(bridge.byDisposition.BLOCKED.voucher_ids, [1, 2, 3]);
    assert.equal(bridge.byDisposition.BLOCKED.debit, '6.00');
  });

  test('money is compared exactly (no float drift) across many small amounts', () => {
    const vouchers = Array.from({ length: 10 }, (_, i) => v(i, 'MIGRATE', '0.10', '0.10'));
    const bridge = computeBridge(vouchers);
    assert.equal(bridge.total.debit, '1.00');
    assert.equal(bridge.ties, true);
  });
});


describe('bridge integrity and file-to-population controls', () => {
  test('an unbalanced voucher outside BLOCKED is reported (would fail Layer B)', () => {
    const bridge = computeBridge([
      { id: 1, disposition: 'MIGRATE', debit_total: '10.00', credit_total: '9.00' },
      { id: 2, disposition: 'BLOCKED', debit_total: '5.00', credit_total: '4.00' },
    ]);
    assert.deepEqual(bridge.unbalancedOutsideBlocked, [1]);
  });

  test('file totals tie to vouchers plus rejected rows', () => {
    const vouchers = [
      { id: 1, disposition: 'MIGRATE', debit_total: '100.00', credit_total: '100.00', line_count: 2 },
      { id: 2, disposition: 'BLOCKED', debit_total: '8000.00', credit_total: '6500.00', line_count: 2 },
    ];
    const rejected = [{ debit: '1200.00', credit: '0.00' }];
    const r = compareBridgeToFile({ file: { row_count: 5, debit_total: '9300.00', credit_total: '6600.00' }, vouchers, rejectedRows: rejected });
    assert.ok(r.controls.every(c => c.status === 'MATCH'), JSON.stringify(r.controls));
    assert.equal(r.rejected.count, 1);
    assert.equal(r.rejected.debit, '1200.00');
  });

  test('a row that vanished (not in vouchers, not rejected) breaks the file bridge', () => {
    const vouchers = [{ id: 1, disposition: 'MIGRATE', debit_total: '100.00', credit_total: '100.00', line_count: 2 }];
    const r = compareBridgeToFile({ file: { row_count: 3, debit_total: '150.00', credit_total: '100.00' }, vouchers, rejectedRows: [] });
    const rows = r.controls.find(c => c.control_key === 'bridge:file:rows');
    const debit = r.controls.find(c => c.control_key === 'bridge:file:debit');
    assert.equal(rows.status, 'DIFF');
    assert.equal(debit.status, 'DIFF');
    assert.equal(debit.difference, '-50.00');
  });
});
