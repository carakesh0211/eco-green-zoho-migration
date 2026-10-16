// Transaction plan: ledger table V2 -> our postings, and how each receipt / payment is applied
// (Eco Green settlement first, then oldest opening item, rest unapplied). Synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ledgerDate, accountKey, readLedgerRows, groupVouchers, classifyVoucher, pairSettlement, refKey,
  readSupplierAllocations, readCustomerSettlements, buildTxnPlan, planReport, INTER_BRANCH, coaCrosswalk,
} from '../src/txn/plan.js';

const HDR = ['c_br_code', 'c_year', 'c_prefix', 'n_tran_no', 'c_act_code', 'd_date', 'n_amount', 'c_opp_act_code', 'c_ref_br_code', 'n_pk', 'c_name', 'n_type', 'c_grp_no', 'c_remarks', 'cust_pay_ref_no', 'supp_pay_ref_no', 'To be pushed by '];
const row = (prefix, no, code, date, amount, name, type, owner = 'ZOHO', remarks = null) => [0, 26, prefix, no, code, date, amount, '', 460, 1, name, type, 1, remarks, null, null, owner];
const lines = (rows) => readLedgerRows([HDR, ...rows]);
const P = (rupees) => BigInt(Math.round(rupees * 100));

test('ledgerDate: text dd/mm/yy, and Excel date cells swapped back (or kept with asis)', () => {
  assert.equal(ledgerDate('29/05/26'), '2026-05-29');
  assert.equal(ledgerDate({ date: '2026-03-06' }), '2026-06-03');
  assert.equal(ledgerDate({ date: '2026-03-06' }, { excelDates: 'asis' }), '2026-03-06');
  assert.equal(ledgerDate('garbage'), null);
});

test('accountKey: "#NAME?" keyed by ledger name, code 0 / type 3 is inter-branch', () => {
  assert.equal(accountKey('#NAME?', 'Central GST Receivable', 0), 'NAME:CENTRAL GST RECEIVABLE');
  assert.equal(accountKey(0, 'FRANKROSS ADMIN', 3), INTER_BRANCH);
  assert.equal(accountKey('UR_REC', 'x', 0), 'UR_REC');
});

test('extract variations: text-marker codes, zero-padded codes, padded headers and blank rows read the same', () => {
  const hdr = HDR.map((h) => (h === 'n_amount' ? ' n_amount ' : h.trim()));
  const ls = readLedgerRows([hdr,
    row('J', 1, "'000939", '01/05/26', 100, 'HDFC BANK', 1),
    row('J', 1, "'V01833", '01/05/26', -100, 'VENDOR', 5),
    [null, null, null, null, null, null, 0, null, null, null, null, null, null, null, null, null, null],
  ]);
  assert.deepEqual(ls.map((l) => [l.account, l.code, l.party]), [['939', '000939', null], ['V01833', 'V01833', 'vendor']]);
  assert.equal(accountKey('939', 'x', 1), accountKey('000939', 'x', 1));
});

test('coaCrosswalk: Eco Green codes tagged on Zoho accounts; a code on two accounts is ambiguous', () => {
  const csv = 'Account Name,Account Code,Account Type,Account Status,Currency,Parent Account,CF.Eco Green Account Code\n'
    + 'Hdfc Bank,AL0060,Bank,Active,INR,,939\n'
    + 'Central GST Receivable,AL0213,Other Current Liability,Active,INR,,\'-CGSTR\n'
    + 'Postage & Courier,IE179,Expense,Active,INR,,"COURIE\nCOURIER"\n'
    + 'Old,IE999,Expense,Inactive,INR,,IE021\n'
    + 'A,IE001,Expense,Active,INR,,DUP\nB,IE002,Expense,Active,INR,,DUP\n';
  const { map, ambiguous } = coaCrosswalk(csv);
  assert.deepEqual(Object.fromEntries(map), { 939: 'AL0060', '-CGSTR': 'AL0213', COURIE: 'IE179', COURIER: 'IE179' });
  assert.deepEqual(ambiguous, [['DUP', ['IE001', 'IE002']]]);
});

test('classifyVoucher: receipt (pass-through control nets out), payment, bill, journal', () => {
  const v = groupVouchers(lines([
    row('J', 1, 'H1', '01/05/26', -100, 'UPI TERMINAL', 4),
    row('J', 1, 'IE611', '01/05/26', 1, 'CHARGES', 6),
    row('J', 1, 0, '01/05/26', 99, 'HO', 3),
    row('J', 1, 'H2', '01/05/26', -99, 'PHONEPE CONTROL', 4),
    row('J', 1, 'H2', '01/05/26', 99, 'PHONEPE CONTROL', 4),
    row('Q', 2, 'CASH', '02/05/26', -50, 'CASH', 1),
    row('Q', 2, 'V1', '02/05/26', 50, 'VENDOR', 5),
    row('J', 3, 'V2', '03/05/26', -500, 'LANDLORD', 5),
    row('J', 3, 'IE135', '03/05/26', 500, 'RENT', 6),
    row('F', 4, 'CASH', '04/05/26', -10, 'CASH', 1),
    row('F', 4, 903, '04/05/26', 10, 'BANK', 1),
  ]));
  const r = classifyVoucher(v.get('26/J/1'));
  assert.equal(r.kind, 'receipt');
  assert.equal(r.amount, P(100));
  assert.equal(r.party.code, 'H1');
  assert.equal(r.direct, false);
  assert.deepEqual(r.offset.map((o) => [o.account, o.contact, o.amount]), [['IE611', undefined, P(1)], [INTER_BRANCH, '000', P(99)]]);
  assert.equal(v.get('26/J/1').passThrough, 2);
  const q = classifyVoucher(v.get('26/Q/2'));
  assert.deepEqual([q.kind, q.amount, q.direct], ['payment', P(50), true]);
  assert.equal(classifyVoucher(v.get('26/J/3')).kind, 'bill');
  assert.equal(classifyVoucher(v.get('26/F/4')).kind, 'journal');
});

test('pairSettlement: debits and credits matched in file order, splitting amounts', () => {
  const pairs = pairSettlement([{ doc: 'A', amount: P(30) }, { doc: 'B', amount: P(70) }], [{ doc: 'R1', amount: -P(50) }, { doc: 'R2', amount: -P(50) }]);
  assert.deepEqual(pairs.map((p) => [p.debit, p.credit, p.amount]), [['A', 'R1', P(30)], ['B', 'R1', P(20)], ['B', 'R2', P(50)]]);
});

test('refKey: opening references to year/prefix/number', () => {
  assert.equal(refKey('25/T 5960'), '25/T/5960');
  assert.equal(refKey('25/K/1700'), '25/K/1700');
  assert.equal(refKey('OPENING BALANCE'), null);
});

test('settlement CSV readers: supplier pairs and customer E groups (cancelled rows dropped)', () => {
  const sup = readSupplierAllocations([
    'c_br_code,c_year,c_prefix,n_srno,c_inv_year,c_inv_prefix,c_inv_no,n_total,d_date,c_code,d_chq_dt,c_chq_no,c_ref_br_code,account_name',
    '000,26,Q,7,25,K,29,-873.00,06/04/26,CASH,,,460,CASH-IN-HAND',
    '000,26,Q,7,25,K,29,873.00,06/04/26,V1,,,460,VENDOR',
  ].join('\n'));
  assert.deepEqual(sup.map((s) => [s.payment, s.party, s.doc, s.amount, s.date]), [['26/Q/7', 'CASH', '25/K/29', -P(873), '2026-04-06'], ['26/Q/7', 'V1', '25/K/29', P(873), '2026-04-06']]);
  const cust = readCustomerSettlements([
    'c_br_code,c_year,c_prefix,n_srno,c_ref_br_code,c_inv_year,c_inv_prefix,n_inv_no,n_amount,d_date,c_cust_code,n_cancel_flag',
    '000,26,E,1,460,26,S,10,100.00,25/05/26,H1,0',
    '000,26,E,1,460,26,J,11,-100.00,25/05/26,H1,0',
    '000,26,E,2,460,26,S,12,5.00,25/05/26,H1,1',
  ].join('\n'));
  assert.deepEqual(cust.map((c) => [c.group, c.doc, c.amount]), [['1', '26/S/10', P(100)], ['1', '26/J/11', -P(100)]]);
});

function scenario() {
  const ledger = lines([
    // Smart Pharma B2C invoices on the card-terminal control customer
    row('S', 10, 'H1', '10/04/26', 60, 'HDFC TERMINAL', 4, 'Smartpharma'),
    row('S', 10, 'SALES', '10/04/26', -60, 'SALES', 6, 'Smartpharma'),
    row('S', 11, 'H1', '11/04/26', 40, 'HDFC TERMINAL', 4, 'Smartpharma'),
    row('S', 11, 'SALES', '11/04/26', -40, 'SALES', 6, 'Smartpharma'),
    // our receipt 211/5: 120 from H1 to the clearing account (100 settled by E/1, rest falls through)
    row(211, 5, 'H1', '12/04/26', -120, 'HDFC TERMINAL', 4),
    row(211, 5, 'UR_REC', '12/04/26', 120, 'CHQ RECD NOT RECONCILED', 0),
    // our receipt J/6 from ONGC: knocks off pre-opening invoices (-> opening balance item)
    row('J', 6, 'H9', '15/04/26', -300, 'ONGC', 4),
    row('J', 6, 0, '15/04/26', 300, 'HO', 3),
    // our vendor payment Q/7: bill 25/K/29 (90) less debit note 25/I/3 (20) = 70
    row('Q', 7, 'CASH', '16/04/26', -70, 'CASH', 1),
    row('Q', 7, 'V1', '16/04/26', 70, 'VENDOR', 5),
  ]);
  const openingDocs = [
    { kind: 'invoice', side: 'customer', partyCode: 'H1', date: '2026-03-01', amount: String(P(15)), sourceRef: '25/S 900' },
    { kind: 'invoice', side: 'customer', partyCode: 'H9', date: '2025-08-28', amount: String(P(50)), sourceRef: '25/T 5960' },
    { kind: 'invoice', side: 'customer', partyCode: 'H9', date: '2026-03-31', amount: String(P(300)), sourceRef: 'OPENING BALANCE-\r\n460H9' },
    { kind: 'bill', side: 'vendor', partyCode: 'V1', date: '2026-02-01', amount: String(P(90)), sourceRef: '25/K/29' },
    { kind: 'vendor_credit', side: 'vendor', partyCode: 'V1', date: '2026-02-02', amount: String(P(20)), sourceRef: '25/I/3' },
  ];
  const customerSettle = [
    { group: '1', party: 'H1', doc: '26/S/10', amount: P(60), date: '2026-04-20' },
    { group: '1', party: 'H1', doc: '26/S/11', amount: P(40), date: '2026-04-20' },
    { group: '1', party: 'H1', doc: '26/211/5', amount: -P(100), date: '2026-04-20' },
    { group: '2', party: 'H9', doc: '23/T/1', amount: P(250), date: '2026-06-30' },
    { group: '2', party: 'H9', doc: '24/T/2', amount: P(80), date: '2026-06-30' },
    { group: '2', party: 'H9', doc: '24/J/77', amount: -P(30), date: '2026-06-30' }, // old credit, not in Books
    { group: '2', party: 'H9', doc: '26/J/6', amount: -P(300), date: '2026-06-30' },
    { group: '3', party: 'H1', doc: '26/S/11', amount: P(40), date: '2026-08-01' }, // after cut-off
  ];
  const supplierAlloc = [
    { payment: '26/Q/7', party: 'CASH', doc: '25/K/29', amount: -P(90), date: '2026-04-16' },
    { payment: '26/Q/7', party: 'V1', doc: '25/K/29', amount: P(90), date: '2026-04-16' },
    { payment: '26/Q/7', party: 'V1', doc: '25/I/3', amount: -P(20), date: '2026-04-16' },
    { payment: '26/Q/7', party: 'V1', doc: '25/K/404', amount: P(5), date: '2026-04-16' }, // not in Books
  ];
  return { ledger, openingDocs, customerSettle, supplierAlloc };
}

test('buildTxnPlan: exact settlement, opening balance item, oldest-first, unapplied, debit notes', () => {
  const s = scenario();
  const plan = buildTxnPlan({ branch: '999', lines: s.ledger, openingDocs: s.openingDocs, customerSettle: s.customerSettle, supplierAlloc: s.supplierAlloc, from: '2026-04-01', to: '2026-07-05' });
  assert.ok(plan.checks.every((c) => c.ok), JSON.stringify(plan.checks));
  assert.equal(plan.postings.length, 3, 'only our vouchers');
  const by = Object.fromEntries(plan.postings.map((p) => [p.key, p]));

  const r = by['26/211/5'];
  assert.equal(r.kind, 'receipt');
  assert.deepEqual(r.applications.map((a) => [a.doc, a.amount, a.method]), [['26/S/10', P(60), 'exact'], ['26/S/11', P(40), 'exact'], ['25/S/900', P(15), 'fifo']]);
  assert.equal(r.unapplied, P(5));

  const o = by['26/J/6'];
  assert.deepEqual(o.applications.map((a) => [a.doc, a.amount, a.method]), [['OPENING/H9', P(300), 'exact']]);
  assert.equal(o.unapplied, 0n, 'the opening list invoice 25/T/5960 stays open');

  const q = by['26/Q/7'];
  assert.deepEqual(q.applications.map((a) => [a.doc, a.amount, a.method]), [['25/K/29', P(70), 'exact']]);
  assert.deepEqual(plan.creditApplications.map((c) => [c.credit, c.doc, c.amount]), [['25/I/3', '25/K/29', P(20)]]);
  assert.deepEqual(plan.exceptions.map((e) => [e.ref, e.doc]), [['26/Q/7', '25/K/404']]);
  assert.ok(plan.warnings.some((w) => /1 customer settlements dated after/.test(w)));
  assert.ok(plan.warnings.some((w) => /2 settlement rows against documents older than the opening list/.test(w)));
  assert.match(planReport(plan), /Applied exactly/);
});

test('buildTxnPlan: dates outside the window, unbalanced vouchers and unmapped ledgers fail checks', () => {
  const plan = buildTxnPlan({
    branch: '999',
    lines: lines([row('J', 1, 'A', '01/08/26', 10, 'A', 0), row('J', 1, 'B', '01/08/26', -9, 'B', 0)]),
    from: '2026-04-01', to: '2026-07-05', accountMap: new Map([['A', 'Z1']]),
  });
  const failed = plan.checks.filter((c) => !c.ok).map((c) => c.name);
  assert.deepEqual(failed, ['dates inside the window', 'every voucher balances', 'every ledger mapped to a Zoho account']);
});

test('glParties: a party code kept as a GL ledger posts as a ledger (receipt becomes a journal)', () => {
  const ls = readLedgerRows([HDR, row(211, 1, 'H1', '01/05/26', -100, 'HDFC TERMINAL', 4), row(211, 1, 'UR_REC', '01/05/26', 100, 'CHQ', 0)], { glParties: new Set(['H1']) });
  assert.deepEqual([ls[0].party, ls[0].account, ls[0].glParty], [null, 'H1', true]);
  assert.equal(classifyVoucher(groupVouchers(ls).get('26/211/1')).kind, 'journal');
});
