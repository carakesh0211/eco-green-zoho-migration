// Linked-voucher check (src/core/voucher_links.js). Synthetic vouchers only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkVoucherLinks } from '../src/core/voucher_links.js';

const NAMES = { PV1: 'PETTY CASH VENDOR', HO1: 'HEAD OFFICE', VEN1: 'Vendor One', CUS1: 'Card Terminal' };
const line = (voucher_no, voucher_date, ledger_code, debit, credit, party_code = '') => ({ voucher_no, voucher_id: voucher_no, voucher_type: 'JOURNAL', voucher_date, ledger_code, party_code, party_name: NAMES[party_code] ?? '', debit, credit });

const GOOD = [
  // UR_PAY: vendor payment, then clearing to bank
  line('26/Q/101', '2026-04-10', 'CRED2', '500.00', '0.00', 'VEN1'),
  line('26/Q/101', '2026-04-10', 'UR_PAY', '0.00', '500.00'),
  line('26/Q/-101', '2026-04-12', 'UR_PAY', '500.00', '0.00'),
  line('26/Q/-101', '2026-04-12', 'BANK1', '0.00', '500.00'),
  // UR_REC: card receipt with charges, then transfer to bank
  line('26/R/201', '2026-04-01', 'CREDIT', '2.00', '0.00'),
  line('26/R/201', '2026-04-01', 'DEBT1', '0.00', '102.00', 'CUS1'),
  line('26/R/201', '2026-04-01', 'UR_REC', '100.00', '0.00'),
  line('26/R/-201', '2026-04-01', 'BANK2', '100.00', '0.00'),
  line('26/R/-201', '2026-04-01', 'UR_REC', '0.00', '100.00'),
  // Petty cash: expense journal, then Head Office reimbursement
  line('26/J/301', '2026-05-02', 'IB1', '0.00', '700.00', 'HO1'),
  line('26/J/301', '2026-05-02', 'EXP1', '450.00', '0.00'),
  line('26/J/301', '2026-05-02', 'EXP2', '250.00', '0.00'),
  line('26/J/301', '2026-05-02', 'CRED1', '0.00', '700.00', 'PV1'),
  line('26/J/301', '2026-05-02', 'CRED1', '700.00', '0.00', 'PV1'),
  line('26/J/302', '2026-05-20', 'IB1', '700.00', '0.00', 'HO1'),
  line('26/J/302', '2026-05-20', 'CASH', '0.00', '700.00'),
  line('26/J/302', '2026-05-20', 'CRED1', '700.00', '0.00', 'PV1'),
  line('26/J/302', '2026-05-20', 'CRED1', '0.00', '700.00', 'PV1'),
];

test('pairs: negative-numbered clearing vouchers link to their payment/receipt; petty cash expense once', () => {
  const r = checkVoucherLinks(GOOD);
  assert.deepEqual(r.summary, { ok: true, problems: 0, ur_pay_pairs: 1, ur_rec_pairs: 1, petty_pairs: 1 });
  assert.equal(r.controls.UR_PAY.open_balance, '0.00');
  assert.deepEqual(r.controls.UR_REC.pairList[0].clearing_ledgers, ['BANK2']);
  assert.equal(r.petty.pairs[0].reimbursement, '26/J/302');
  assert.equal(r.petty.pairs[0].expense_booked, '700.00');
});

test('problems: missing partner, uncleared payment, amount mismatch, unreimbursed expense, expense in reimbursement', () => {
  const lines = [
    line('26/Q/-900', '2026-04-12', 'UR_PAY', '100.00', '0.00'), line('26/Q/-900', '2026-04-12', 'BANK1', '0.00', '100.00'),
    line('26/Q/901', '2026-04-12', 'CRED2', '50.00', '0.00', 'VEN1'), line('26/Q/901', '2026-04-12', 'UR_PAY', '0.00', '50.00'),
    line('26/211/5', '2026-04-01', 'UR_REC', '10.00', '0.00'), line('26/211/5', '2026-04-01', 'DEBT1', '0.00', '10.00', 'CUS1'),
    line('26/211/-5', '2026-04-02', 'UR_REC', '0.00', '9.00'), line('26/211/-5', '2026-04-02', 'BANK2', '9.00', '0.00'),
    line('26/J/1', '2026-05-02', 'EXP1', '80.00', '0.00'), line('26/J/1', '2026-05-02', 'CRED1', '0.00', '80.00', 'PV1'), line('26/J/1', '2026-05-02', 'CRED1', '80.00', '0.00', 'PV1'), line('26/J/1', '2026-05-02', 'IB1', '0.00', '80.00', 'HO1'),
  ];
  const r = checkVoucherLinks(lines);
  const issues = [...r.controls.UR_PAY.problems, ...r.controls.UR_REC.problems, ...r.petty.problems].map((p) => `${p.voucher}:${p.issue}`).sort();
  assert.deepEqual(issues, ['26/211/-5:AMOUNT_MISMATCH', '26/J/1:NOT_REIMBURSED', '26/Q/-900:NO_PARTNER', '26/Q/901:NOT_CLEARED']);
  assert.equal(r.summary.ok, false);
  assert.equal(r.controls.UR_REC.open_balance, '1.00');
});
