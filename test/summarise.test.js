import test from 'node:test';
import assert from 'node:assert/strict';
import { summariseLines } from '../src/core/summarise.js';

function line(overrides = {}) {
  return {
    ledger_code: 'LEDG-1001',
    voucher_type: 'PURCHASE',
    voucher_id: 'V-1',
    debit: '0.00',
    credit: '0.00',
    ...overrides,
  };
}

test('summarises a single line into a per-type row and a * rollup', () => {
  const rows = summariseLines([line({ debit: '100.00', credit: '0.00' })]);
  assert.equal(rows.length, 2);
  const [typeRow, starRow] = rows;
  assert.deepEqual(typeRow, {
    ledger_code: 'LEDG-1001', voucher_type: 'PURCHASE', debit: '100.00', credit: '0.00', txn_count: 1, line_count: 1,
  });
  assert.deepEqual(starRow, {
    ledger_code: 'LEDG-1001', voucher_type: '*', debit: '100.00', credit: '0.00', txn_count: 1, line_count: 1,
  });
});

test('groups by (ledger_code, voucher_type) and rolls up per ledger', () => {
  const rows = summariseLines([
    line({ ledger_code: 'L1', voucher_type: 'PURCHASE', voucher_id: 'V-1', debit: '10.00' }),
    line({ ledger_code: 'L1', voucher_type: 'PURCHASE', voucher_id: 'V-2', debit: '5.00' }),
    line({ ledger_code: 'L1', voucher_type: 'PAYMENT', voucher_id: 'V-3', credit: '3.00' }),
    line({ ledger_code: 'L2', voucher_type: 'PURCHASE', voucher_id: 'V-4', debit: '7.00' }),
  ]);

  const byKey = Object.fromEntries(rows.map((r) => [`${r.ledger_code}:${r.voucher_type}`, r]));

  assert.deepEqual(byKey['L1:PURCHASE'], {
    ledger_code: 'L1', voucher_type: 'PURCHASE', debit: '15.00', credit: '0.00', txn_count: 2, line_count: 2,
  });
  assert.deepEqual(byKey['L1:PAYMENT'], {
    ledger_code: 'L1', voucher_type: 'PAYMENT', debit: '0.00', credit: '3.00', txn_count: 1, line_count: 1,
  });
  assert.deepEqual(byKey['L1:*'], {
    ledger_code: 'L1', voucher_type: '*', debit: '15.00', credit: '3.00', txn_count: 3, line_count: 3,
  });
  assert.deepEqual(byKey['L2:*'], {
    ledger_code: 'L2', voucher_type: '*', debit: '7.00', credit: '0.00', txn_count: 1, line_count: 1,
  });
});

test('txn_count counts distinct voucher_id, not line count', () => {
  const rows = summariseLines([
    line({ ledger_code: 'L1', voucher_type: 'JOURNAL', voucher_id: 'V-1', debit: '1.00' }),
    line({ ledger_code: 'L1', voucher_type: 'JOURNAL', voucher_id: 'V-1', credit: '1.00' }),
    line({ ledger_code: 'L1', voucher_type: 'JOURNAL', voucher_id: 'V-1', debit: '2.00' }),
  ]);
  const star = rows.find((r) => r.voucher_type === '*');
  assert.equal(star.txn_count, 1);
  assert.equal(star.line_count, 3);
});

test('money arithmetic is exact for values that break floating point (0.10 + 0.20)', () => {
  const rows = summariseLines([
    line({ ledger_code: 'L1', voucher_type: 'JOURNAL', voucher_id: 'V-1', debit: '0.10' }),
    line({ ledger_code: 'L1', voucher_type: 'JOURNAL', voucher_id: 'V-2', debit: '0.20' }),
  ]);
  const typeRow = rows.find((r) => r.voucher_type === 'JOURNAL');
  assert.equal(typeRow.debit, '0.30');
  assert.notEqual(0.1 + 0.2, 0.3); // sanity: float arithmetic would NOT produce an exact "0.30"
});

test('accumulates many small amounts exactly (no drift)', () => {
  const lines = [];
  for (let i = 0; i < 25; i += 1) {
    lines.push(line({ ledger_code: 'L1', voucher_type: 'JOURNAL', voucher_id: `V-${i}`, debit: '0.01' }));
  }
  const star = summariseLines(lines).find((r) => r.voucher_type === '*');
  assert.equal(star.debit, '0.25');
});

test('sort order is deterministic: ledger_code asc, then voucher_type asc with * last', () => {
  const rows = summariseLines([
    line({ ledger_code: 'B', voucher_type: 'PAYMENT', voucher_id: 'V-1' }),
    line({ ledger_code: 'A', voucher_type: 'RECEIPT', voucher_id: 'V-2' }),
    line({ ledger_code: 'A', voucher_type: 'PURCHASE', voucher_id: 'V-3' }),
    line({ ledger_code: 'B', voucher_type: 'JOURNAL', voucher_id: 'V-4' }),
  ]);
  const seq = rows.map((r) => `${r.ledger_code}:${r.voucher_type}`);
  assert.deepEqual(seq, [
    'A:PURCHASE', 'A:RECEIPT', 'A:*',
    'B:JOURNAL', 'B:PAYMENT', 'B:*',
  ]);
});

test('sort order is stable across input order permutations', () => {
  const a = [
    line({ ledger_code: 'L1', voucher_type: 'PURCHASE', voucher_id: 'V-1' }),
    line({ ledger_code: 'L1', voucher_type: 'PAYMENT', voucher_id: 'V-2' }),
  ];
  const b = [a[1], a[0]];
  const seqA = summariseLines(a).map((r) => `${r.ledger_code}:${r.voucher_type}`);
  const seqB = summariseLines(b).map((r) => `${r.ledger_code}:${r.voucher_type}`);
  assert.deepEqual(seqA, seqB);
});

test('returns an empty array for no lines', () => {
  assert.deepEqual(summariseLines([]), []);
});

test('handles negative (credit-heavy) balances without sign errors', () => {
  const rows = summariseLines([
    line({ ledger_code: 'L1', voucher_type: 'CREDIT_NOTE', voucher_id: 'V-1', credit: '50.00' }),
  ]);
  const typeRow = rows.find((r) => r.voucher_type === 'CREDIT_NOTE');
  assert.equal(typeRow.debit, '0.00');
  assert.equal(typeRow.credit, '50.00');
});
