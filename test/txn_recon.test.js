// Closing reconciliation: Eco Green TB vs ledger, Books TB vs opening + posted lines, parties.
// Synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readLedgerRows } from '../src/txn/plan.js';
import {
  readClosingTb, ecoIntegrity, expectedBooks, readBooksTb, compareTb, compareParties, reconReport, tbCodeOf,
} from '../src/txn/recon.js';

const HDR = ['c_br_code', 'c_year', 'c_prefix', 'n_tran_no', 'c_act_code', 'd_date', 'n_amount', 'c_opp_act_code', 'c_ref_br_code', 'n_pk', 'c_name', 'n_type', 'c_grp_no', 'c_remarks', 'cust_pay_ref_no', 'supp_pay_ref_no', 'To be pushed by '];
const row = (prefix, no, code, amount, name, type, grp, owner = 'ZOHO') => [0, 26, prefix, no, code, '01/05/26', amount, '', 460, 1, name, type, grp, null, null, null, owner];
const P = (r) => BigInt(Math.round(r * 100));

const lines = readLedgerRows([HDR,
  row(211, 1, 'H1', -100, 'HDFC TERMINAL', 4, 1002002022),
  row(211, 1, 903, 100, 'INDUSIND', 1, 1002003003),
  row('J', 2, '#NAME?', 18, 'CENTRAL GST RECEIVABLE', 0, 2005003000),
  row('J', 2, 'V1', -18, 'LANDLORD', 5, 2005001008),
  row('S', 3, 'H1', 50, 'HDFC TERMINAL', 4, 1002002022, 'Smartpharma'),
  row('S', 3, 'SALES', -50, 'SALES', 6, 3001001000, 'Smartpharma'),
]);

const TB_ROWS = [
  ['Trial Balance'],
  ['Act Code', 'Description', 'Op.Debit', 'Op.Credit', 'Tran. Debit', 'Tran. Credit', 'Cl.Debit', 'Cl.Credit'],
  [null, 'ASSETS'],
  ['000903', 'Indusind Bank', 0, 0, 100, 0, 100, null],
  ['002022', 'Sundry Debtors-collection', 10, 0, 50, 100, null, 40],
  ['-CGSTR', 'Central Gst Receivable', 0, 0, 18, 0, 18, null],
  ['001008', 'Sundry Creditors-rent', 0, 0, 0, 18, null, 18],
  ['SALES', 'Sales', 0, 0, 0, 50, null, 50],
];

test('readClosingTb / tbCodeOf: parties roll up to their group, numeric codes padded, #NAME? by name', () => {
  const tb = readClosingTb(TB_ROWS);
  assert.equal(tb.get('002022').tran, P(-50));
  const byName = new Map([['CENTRALGSTRECEIVABLE', '-CGSTR']]);
  assert.equal(tbCodeOf(lines[0], byName), '002022');
  assert.equal(tbCodeOf(lines[1], byName), '000903');
  assert.equal(tbCodeOf(lines[2], byName), '-CGSTR');
});

test('ecoIntegrity: every TB code ties to the ledger; a missing line shows as a difference', () => {
  const tb = readClosingTb(TB_ROWS);
  assert.ok(ecoIntegrity(lines, tb).every((r) => r.ok));
  const short = ecoIntegrity(lines.slice(0, 4), tb).filter((r) => !r.ok).map((r) => [r.code, r.diff]);
  assert.deepEqual(short, [['002022', P(-50)], ['SALES', P(50)]]);
});

const opening = {
  gl: [{ zohoCode: 'AL0054', net: String(P(10)) }, { zohoCode: 'RES', net: String(P(-10)) }],
  documents: [{ side: 'customer', partyCode: 'H1', partyName: 'HDFC TERMINAL', controlCode: '002022', controlZoho: 'FRP0020G', net: String(P(10)) }],
};
const accountMap = { 903: 'AL0054', 'NAME:CENTRAL GST RECEIVABLE': 'AL0213' };
const groupZoho = new Map([['002022', 'FRP0020G'], ['001008', 'FRP0044G']]);

test('expectedBooks + compareTb: opening + our lines per Zoho code; Books differences flagged', () => {
  const ours = lines.filter((l) => l.owner === 'ZOHO');
  const { exp, unmapped } = expectedBooks({ opening, lines: ours, accountMap, groupZoho });
  assert.equal(unmapped.size, 0);
  assert.deepEqual(Object.fromEntries([...exp].map(([k, v]) => [k, v])), { AL0054: P(110), RES: P(-10), FRP0020G: P(-90), AL0213: P(18), FRP0044G: P(-18) });
  const tbJson = {
    trialbalance: [{
      name: 'Total', account_transactions: [
        { name: 'Assets', account_transactions: [
          { account_id: '1', account_code: 'AL0054', name: 'Indusind', net_debit_total: 110, net_credit_total: '' },
          { account_id: '2', account_code: 'FRP0020G', name: 'SD collection', net_debit_total: '', net_credit_total: 90 },
          { account_id: '3', account_code: 'AL0213', name: 'CGST receivable', net_debit_total: 18, net_credit_total: '' },
        ] },
        { name: 'Liabilities', account_transactions: [
          { account_id: '4', account_code: 'FRP0040G', name: 'SC goods', net_debit_total: '', net_credit_total: 18 },
          { account_id: '5', account_code: 'RES', name: 'Reserves', net_debit_total: '', net_credit_total: 10 },
        ] },
      ],
    }],
  };
  const rows = compareTb(exp, readBooksTb(tbJson));
  assert.deepEqual(rows.filter((r) => !r.ok).map((r) => [r.code, r.diff]).sort(), [['FRP0040G', P(-18)], ['FRP0044G', P(18)]]);
  assert.equal(rows.filter((r) => r.ok).length, 4);
});

test('compareParties: Books net vs opening + posted; Eco Green closing and Smart Pharma part alongside', () => {
  const { rows, extra } = compareParties({
    opening, posted: lines.filter((l) => l.owner === 'ZOHO'), all: lines,
    contacts: { 'customer:H1': 'C1', 'vendor:V1': 'V-1' },
    customers: [{ customer_id: 'C1', customer_name: 'HDFC TERMINAL', bcy_balance: -90, invoice_balance: 10, available_credits: 100 }, { customer_id: 'C9', customer_name: 'Stray', bcy_balance: 5 }],
    vendors: [{ vendor_id: 'V-1', vendor_name: 'LANDLORD', bcy_balance: 18, bill_balance: 18, excess_payment: 0 }],
  });
  const h1 = rows.find((r) => r.code === 'H1');
  assert.deepEqual([h1.expected, h1.books, h1.ok, h1.ecoClosing, h1.smartPharma], [P(-90), P(-90), true, P(-40), P(50)]);
  assert.equal(rows.find((r) => r.code === 'V1').ok, true);
  assert.deepEqual(extra.map((e) => e.name), ['Stray']);
  const md = reconReport({ branch: '999', asOf: '2026-07-05', integrity: [], tb: [], unmapped: new Map(), parties: { rows, extra } });
  assert.match(md, /2\/2 parties tie/);
  assert.match(md, /Smart Pharma's documents for 1 parties/);
});

test('compareTb with controls: split across receivable / payable accounts is listed, the group total must tie', () => {
  const exp = new Map([['FRP0013G', P(100)], ['AL0054', P(-100)]]);
  const books = new Map([['name:Accounts Receivable', { name: 'Accounts Receivable', net: P(100) }], ['AL0054', { name: 'Bank', net: P(-100) }]]);
  const rows = compareTb(exp, books, new Set(['FRP0013G']));
  assert.ok(rows.every((r) => r.ok));
  assert.deepEqual([rows.controlGroup.expected, rows.controlGroup.books, rows.controlGroup.ok], [P(100), P(100), true]);
  const off = compareTb(exp, new Map([['name:Accounts Receivable', { net: P(90) }], ['AL0054', { net: P(-100) }]]), new Set(['FRP0013G']));
  assert.equal(off.controlGroup.ok, false);
  assert.match(reconReport({ branch: '9', asOf: 'x', integrity: [], tb: off, unmapped: new Map(), parties: { rows: [], extra: [] } }), /does not tie/);
});

test('compareParties: HO / inter-branch lines belong to contact 000', () => {
  const ho = readLedgerRows([HDR, row('J', 9, 0, 75, 'FRANKROSS ADMIN', 3, 1002002000), row('J', 9, 903, -75, 'INDUSIND', 1, 1002003003)]);
  const { rows } = compareParties({
    opening: { documents: [] }, posted: ho, all: ho, contacts: { 'customer:000': 'HO' },
    customers: [{ customer_id: 'HO', customer_name: 'Frankross Admin', bcy_balance: 75 }], vendors: [],
  });
  assert.deepEqual(rows.map((r) => [r.side, r.code, r.expected, r.ok]), [['customer', '000', P(75), true]]);
});
