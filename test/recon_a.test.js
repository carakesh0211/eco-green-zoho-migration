import test from 'node:test';
import assert from 'node:assert/strict';
import { compareLayerA } from '../src/core/recon_a.js';

function findControl(result, key) {
  const c = result.controls.find((x) => x.control_key === key);
  assert.ok(c, `expected a control named ${key}`);
  return c;
}

test('exact PASS case: everything ties out', () => {
  const manifest = {
    files: [
      { file_role: 'TRANSACTIONS', file_name: 'transactions.csv', row_count: 2, debit_total: '150.00', credit_total: '150.00' },
      { file_role: 'TRIAL_BALANCE', file_name: 'trial_balance.csv', row_count: 1, debit_total: '150.00', credit_total: '150.00' },
    ],
  };
  const files = [
    { file_role: 'TRANSACTIONS', file_name: 'transactions.csv', row_count: 2, debit_total: '150.00', credit_total: '150.00' },
    { file_role: 'TRIAL_BALANCE', file_name: 'trial_balance.csv', row_count: 1, debit_total: '150.00', credit_total: '150.00' },
  ];
  const summaries = [
    { ledger_code: 'L1', voucher_type: '*', debit: '150.00', credit: '150.00', txn_count: 2, line_count: 2, voucher_ids: ['V-1', 'V-2'] },
  ];
  const tbLines = [
    { ledger_code: 'L1', opening_debit: '0.00', opening_credit: '0.00', period_debit: '150.00', period_credit: '150.00', closing_debit: '150.00', closing_credit: '150.00', txn_count: 2 },
  ];

  const result = compareLayerA({ manifest, files, summaries, tbLines });
  assert.equal(result.status, 'PASS');
  assert.ok(result.controls.length > 0);
  for (const c of result.controls) assert.equal(c.status, 'MATCH', `${c.control_key} unexpectedly not MATCH`);
});

test('single-ledger diff reports the correct signed difference and voucher-id drilldown', () => {
  const manifest = { files: [] };
  const summariesOver = [
    { ledger_code: 'L1', voucher_type: '*', debit: '120.00', credit: '0.00', txn_count: 1, line_count: 1, voucher_ids: ['V-9'] },
  ];
  const tbLines = [
    { ledger_code: 'L1', opening_debit: '0.00', opening_credit: '0.00', period_debit: '100.00', period_credit: '0.00', closing_debit: '100.00', closing_credit: '0.00', txn_count: 1 },
  ];

  const over = compareLayerA({ manifest, files: [], summaries: summariesOver, tbLines });
  const overCtrl = findControl(over, 'ledger:L1:period_debit');
  assert.equal(overCtrl.status, 'DIFF');
  assert.equal(overCtrl.expected, '100.00');
  assert.equal(overCtrl.actual, '120.00');
  assert.equal(overCtrl.difference, '20.00');
  assert.deepEqual(overCtrl.detail.voucher_ids, ['V-9']);
  assert.equal(over.status, 'FAIL');

  const summariesUnder = [
    { ledger_code: 'L1', voucher_type: '*', debit: '80.00', credit: '0.00', txn_count: 1, line_count: 1, voucher_ids: ['V-9'] },
  ];
  const under = compareLayerA({ manifest, files: [], summaries: summariesUnder, tbLines });
  const underCtrl = findControl(under, 'ledger:L1:period_debit');
  assert.equal(underCtrl.status, 'DIFF');
  assert.equal(underCtrl.difference, '-20.00');
});

test('ledger missing in TB and ledger missing in CSV are both reported', () => {
  const manifest = { files: [] };
  const summaries = [
    { ledger_code: 'ONLY_IN_CSV', voucher_type: '*', debit: '10.00', credit: '0.00', txn_count: 1, line_count: 1, voucher_ids: ['V-5'] },
  ];
  const tbLines = [
    { ledger_code: 'ONLY_IN_TB', opening_debit: '0.00', opening_credit: '0.00', period_debit: '20.00', period_credit: '0.00', closing_debit: '20.00', closing_credit: '0.00', txn_count: 1 },
  ];

  const result = compareLayerA({ manifest, files: [], summaries, tbLines });

  const missingInTb = findControl(result, 'ledger:ONLY_IN_CSV:missing_in_tb');
  assert.equal(missingInTb.status, 'MISSING_EXPECTED');
  assert.deepEqual(missingInTb.detail.voucher_ids, ['V-5']);

  const missingInCsv = findControl(result, 'ledger:ONLY_IN_TB:missing_in_csv');
  assert.equal(missingInCsv.status, 'MISSING_ACTUAL');

  assert.equal(result.status, 'FAIL');
});

test('txn_count mismatch between summary and trial balance', () => {
  const manifest = { files: [] };
  const summaries = [
    { ledger_code: 'L1', voucher_type: '*', debit: '100.00', credit: '100.00', txn_count: 2, line_count: 2, voucher_ids: ['V-1', 'V-2'] },
  ];
  const tbLines = [
    { ledger_code: 'L1', opening_debit: '0.00', opening_credit: '0.00', period_debit: '100.00', period_credit: '100.00', closing_debit: '100.00', closing_credit: '100.00', txn_count: 3 },
  ];
  const result = compareLayerA({ manifest, files: [], summaries, tbLines });
  const ctrl = findControl(result, 'ledger:L1:txn_count');
  assert.equal(ctrl.status, 'DIFF');
  assert.equal(ctrl.expected, '3');
  assert.equal(ctrl.actual, '2');
  assert.equal(ctrl.difference, '-1');
  assert.equal(result.status, 'FAIL');
});

test('manifest file total mismatch (declared vs actual)', () => {
  const manifest = {
    files: [{ file_role: 'TRANSACTIONS', file_name: 'transactions.csv', row_count: 10, debit_total: '500.00', credit_total: '500.00' }],
  };
  const files = [
    { file_role: 'TRANSACTIONS', file_name: 'transactions.csv', row_count: 10, debit_total: '450.00', credit_total: '500.00' },
  ];
  const result = compareLayerA({ manifest, files, summaries: [], tbLines: [] });
  const ctrl = findControl(result, 'file:TRANSACTIONS:debit_total');
  assert.equal(ctrl.status, 'DIFF');
  assert.equal(ctrl.expected, '500.00');
  assert.equal(ctrl.actual, '450.00');
  assert.equal(ctrl.difference, '-50.00');
  assert.equal(result.status, 'FAIL');
});

test('manifest file entirely missing from actual files reports MISSING_ACTUAL', () => {
  const manifest = {
    files: [{ file_role: 'TRIAL_BALANCE', file_name: 'trial_balance.csv', row_count: 5, debit_total: '10.00', credit_total: '10.00' }],
  };
  const result = compareLayerA({ manifest, files: [], summaries: [], tbLines: [] });
  const ctrl = findControl(result, 'file:TRIAL_BALANCE:row_count');
  assert.equal(ctrl.status, 'MISSING_ACTUAL');
  assert.equal(result.status, 'FAIL');
});

test('trial balance internal identity failure (opening + period - closing != 0)', () => {
  const manifest = { files: [] };
  const summaries = [
    { ledger_code: 'L1', voucher_type: '*', debit: '50.00', credit: '0.00', txn_count: 1, line_count: 1, voucher_ids: ['V-1'] },
  ];
  const tbLines = [
    // opening 100 + period 50 = 150, but closing is declared as 200 -> identity breaks by -50.00
    { ledger_code: 'L1', opening_debit: '100.00', opening_credit: '0.00', period_debit: '50.00', period_credit: '0.00', closing_debit: '200.00', closing_credit: '0.00', txn_count: 1 },
  ];
  const result = compareLayerA({ manifest, files: [], summaries, tbLines });
  const ctrl = findControl(result, 'ledger:L1:balance_identity');
  assert.equal(ctrl.status, 'DIFF');
  assert.equal(ctrl.expected, '200.00');
  assert.equal(ctrl.actual, '150.00');
  assert.equal(ctrl.difference, '-50.00');
  assert.equal(result.status, 'FAIL');

  // the period_debit control itself should still MATCH (summary agrees with tb.period_debit)
  const periodCtrl = findControl(result, 'ledger:L1:period_debit');
  assert.equal(periodCtrl.status, 'MATCH');
});

test('tolerance boundary: a difference exactly at tolerance passes, one cent more fails', () => {
  const manifest = { files: [] };
  const tbLines = [
    { ledger_code: 'L1', opening_debit: '0.00', opening_credit: '0.00', period_debit: '100.00', period_credit: '0.00', closing_debit: '100.00', closing_credit: '0.00', txn_count: 1 },
  ];

  const atBoundary = compareLayerA({
    manifest,
    files: [],
    summaries: [{ ledger_code: 'L1', voucher_type: '*', debit: '100.05', credit: '0.00', txn_count: 1, line_count: 1 }],
    tbLines,
    tolerance: '0.05',
  });
  assert.equal(findControl(atBoundary, 'ledger:L1:period_debit').status, 'MATCH');

  const overBoundary = compareLayerA({
    manifest,
    files: [],
    summaries: [{ ledger_code: 'L1', voucher_type: '*', debit: '100.06', credit: '0.00', txn_count: 1, line_count: 1 }],
    tbLines,
    tolerance: '0.05',
  });
  assert.equal(findControl(overBoundary, 'ledger:L1:period_debit').status, 'DIFF');
});

test('tb:total_debit_equals_credit control sums closing balances across all ledgers', () => {
  const manifest = { files: [] };
  const tbLines = [
    { ledger_code: 'L1', opening_debit: '0.00', opening_credit: '0.00', period_debit: '100.00', period_credit: '0.00', closing_debit: '100.00', closing_credit: '0.00', txn_count: 1 },
    { ledger_code: 'L2', opening_debit: '0.00', opening_credit: '0.00', period_debit: '0.00', period_credit: '100.00', closing_debit: '0.00', closing_credit: '100.00', txn_count: 1 },
  ];
  const summaries = [
    { ledger_code: 'L1', voucher_type: '*', debit: '100.00', credit: '0.00', txn_count: 1, line_count: 1 },
    { ledger_code: 'L2', voucher_type: '*', debit: '0.00', credit: '100.00', txn_count: 1, line_count: 1 },
  ];
  const result = compareLayerA({ manifest, files: [], summaries, tbLines });
  const ctrl = findControl(result, 'tb:total_debit_equals_credit');
  assert.equal(ctrl.status, 'MATCH');
  assert.equal(result.status, 'PASS');
});

test('non-* summary rows (per voucher_type) are ignored for ledger-level TB controls', () => {
  const manifest = { files: [] };
  const summaries = [
    { ledger_code: 'L1', voucher_type: 'PURCHASE', debit: '999.00', credit: '0.00', txn_count: 5, line_count: 5 },
    { ledger_code: 'L1', voucher_type: '*', debit: '100.00', credit: '0.00', txn_count: 1, line_count: 1, voucher_ids: ['V-1'] },
  ];
  const tbLines = [
    { ledger_code: 'L1', opening_debit: '0.00', opening_credit: '0.00', period_debit: '100.00', period_credit: '0.00', closing_debit: '100.00', closing_credit: '0.00', txn_count: 1 },
  ];
  const result = compareLayerA({ manifest, files: [], summaries, tbLines });
  assert.equal(findControl(result, 'ledger:L1:period_debit').status, 'MATCH');
  assert.equal(findControl(result, 'ledger:L1:txn_count').status, 'MATCH');
  // (tb:total_debit_equals_credit legitimately fails here since this single-sided
  // fixture has no offsetting ledger — irrelevant to what this test checks.)
});

test('opening-balance-only ledger (no period movement, txn_count 0) is NOT reported missing in CSV', () => {
  const manifest = { files: [] };
  const tbLines = [
    { ledger_code: 'CAPITAL', opening_debit: '0.00', opening_credit: '5000.00', period_debit: '0.00', period_credit: '0.00', closing_debit: '0.00', closing_credit: '5000.00', txn_count: 0 },
    { ledger_code: 'ACTIVE_BUT_ABSENT', opening_debit: '0.00', opening_credit: '0.00', period_debit: '20.00', period_credit: '0.00', closing_debit: '20.00', closing_credit: '0.00', txn_count: 1 },
  ];
  const result = compareLayerA({ manifest, files: [], summaries: [], tbLines });
  assert.equal(result.controls.find((x) => x.control_key === 'ledger:CAPITAL:missing_in_csv'), undefined);
  assert.equal(findControl(result, 'ledger:CAPITAL:period_debit').status, 'MATCH');
  assert.equal(findControl(result, 'ledger:CAPITAL:txn_count').status, 'MATCH');
  assert.equal(findControl(result, 'ledger:CAPITAL:balance_identity').status, 'MATCH');
  assert.equal(findControl(result, 'ledger:ACTIVE_BUT_ABSENT:missing_in_csv').status, 'MISSING_ACTUAL');
});
