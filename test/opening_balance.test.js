// Branch opening balances (src/opening/plan.js, src/opening/books_docs.js). The workbook is
// built in-test (test/helpers/xlsx_builder.js); every value is synthetic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildXlsx } from './helpers/xlsx_builder.js';
import { buildOpeningPlan, summarisePlan, OpeningPlanError } from '../src/opening/plan.js';
import {
  openingBalanceBody, documentBody, sameDocument, postingQueue, pickAccount, assertTestOrgPosting, OpeningPostError, OPENING_TEST_ORG,
} from '../src/opening/books_docs.js';
import { assertPostingAllowed } from '../src/books/guard.js';

const D = (date) => ({ date });
const LOC = '900000000000000001';

function workbook({ goodsStated = 400 } = {}) {
  return buildXlsx([
    { name: 'TB - 999', rows: [
      ['Act Code', 'Name', 'Cl.Debit', 'Cl.Credit', 'New Code_Zoho'],
      [null, 'ASSETS'],
      ['002001', 'Sundry Debtors-corporate', 1500, 0, 'FRP0013G'],
      ['002022', 'Sundry Debtors-collection Account', 300, 0, 'FRP0020G'],
      ['002000', 'Sundry Debtors', 0, 200, 'FRP0026G'],
      ['300001', 'Cash In Hand', 1000, 0, 'AL0077 cash'],
      [null, 'LIABILITIES'],
      ['001001', 'Sundry Creditors-goods', 0, 400, 'FRP0040G'],
      ['004007', 'Advance Against Expense-others', 100, 0, 'FRP0030G'],
      ['008000', 'Reserve & Surplus', 0, 2000, 'AL0108'],
      [null, 'INCOME'],
      ['900001', 'Sales', 0, 500],
      [null, 'EXPENDITURE'],
      ['900002', 'Purchases', 200, 0],
    ] },
    { name: 'CUSTOMER TRACES-999 (A)', rows: [
      ['Customer Name', null, 'Type', 'Number', 'Date', 'Due', 'Amount'],
      ['Cust : H1 - ONGC', null, null, null, null, null, 1500],
      ['ONGC', null, 'JVT', 'J1', D('2025-11-01'), D('2025-12-01'), 1600],
      ['ONGC', null, 'CRNT', 'C1', D('2025-11-05'), null, -100],
      ['[ AL0232 ] CARD SALES', null, null, null, null, null, 300],
      ['CARD', null, 'SALE', 'S1', D('2026-03-30'), null, 300],
    ] },
    { name: 'CUSTOMER BALANCE-999', rows: [
      ['Act Code', 'Name', null, null, null, null, 'Debit', 'Credit'],
      ['H1', 'ONGC', null, null, null, null, 1500, 0],
      ['H2', 'HDFC CARD', null, null, null, null, 300, 0],
    ] },
    { name: 'BRANCH BALANCE-999 (002000)', rows: [
      ['Act Code', 'Name', null, null, null, null, 'Debit', 'Credit'],
      ['011', 'Branch A', null, null, null, null, 0, 200],
      ['092', 'Branch Nil', null, null, null, null, 0, 0],
    ] },
    { name: 'SUPP TRACES WORKING FILE - 999', rows: [
      ['SUNDRY CREDITORS-GOODS', null, null, null, null, null, 'GROUP TOTAL', null, goodsStated, 'Cr'],
      ['Supplier Name', 'Code'],
      ['Vendor V', 'SU1', '25', 'PB', '7', D('2026-02-01'), D('2026-03-01'), 400, 400, 'INV-7', D('2026-01-30')],
      ['ADVANCE AGAINST EXPENSE-OTHERS', null, null, null, null, null, 'GROUP TOTAL', null, -100, 'Dr'],
      ['Vendor W', 'SU2', '25', 'PY', '8', D('2026-03-10'), D('2026-03-10'), 100, -100, null, null],
    ] },
  ]);
}

const plan999 = (o = {}) => buildOpeningPlan(workbook(o), { branch: '999', asOf: '2026-03-31', closingStock: 10000n, locationId: LOC });

test('plan: documents per module, every control tied, GL + documents balance', () => {
  const p = plan999();
  assert.deepEqual(summarisePlan(p), {
    'customer:invoice': { count: 2, amount: '1900.00' },
    'customer:credit_note': { count: 2, amount: '300.00' },
    'vendor:bill': { count: 1, amount: '400.00' },
    'vendor:vendor_advance': { count: 1, amount: '100.00' },
  });
  assert.ok(p.checks.every((c) => c.ok), JSON.stringify(p.checks.filter((c) => !c.ok)));
  // Reserve takes the year's profit (300) less closing stock (100) carried as an asset.
  assert.deepEqual(p.gl.map((g) => [g.zohoCode, g.net]), [['AL0077', 100000n], ['AL0108', -240000n], ['AL0052', 10000n]]);
  const card = p.documents.find((d) => d.sourceRef === 'S1');
  assert.equal(card.partyCode, 'H2');
  assert.equal(card.controlCode, '002022');
  const ib = p.documents.find((d) => d.partyCode === '011');
  assert.deepEqual([ib.kind, ib.number, ib.amount], ['credit_note', '999/IB/011', 20000n]);
  assert.equal(p.documents.some((d) => d.partyCode === '092'), false);
  const bill = p.documents.find((d) => d.kind === 'bill');
  assert.deepEqual([bill.number, bill.vendorInvoiceNo, bill.date], ['999/25/PB/7', 'INV-7', '2026-01-30']);
});

test('plan: a supplier group total read from the file keeps its sign (Dr groups are negative)', () => {
  const p = plan999();
  const adv = p.checks.find((c) => c.check.includes('ADVANCE AGAINST EXPENSE'));
  assert.deepEqual([adv.expected, adv.actual, adv.ok], ['-100.00', '-100.00', true]);
  const bad = plan999({ goodsStated: 399 }).checks.find((c) => c.check.includes('SUNDRY CREDITORS-GOODS'));
  assert.equal(bad.ok, false);
});

test('plan: refuses a missing opening date', () => {
  assert.throws(() => buildOpeningPlan(workbook(), { branch: '999', asOf: '31/03/2026' }), OpeningPlanError);
});

const RES = {
  docDate: 'original', offsetAccountId: 'ACC-OBA', itemId: 'ITEM-OB', taxExemptionId: null,
  accounts: { AL0077: { account_id: 'A77', currency_id: 'INR-1' }, AL0108: { account_id: 'A108', currency_id: 'INR-1' }, AL0052: { account_id: 'A52', currency_id: 'INR-1' } },
  contacts: { 'customer:H1': 'C1', 'customer:H2': 'C2', 'customer:011': 'C11', 'vendor:SU1': 'V1', 'vendor:SU2': 'V2' },
};

test('Opening Balances body: one line per GL code, Dr/Cr by sign, at the branch location', () => {
  const body = openingBalanceBody(plan999(), RES);
  assert.equal(body.date, '2026-03-31');
  assert.equal(body.location_id, LOC);
  assert.deepEqual(body.accounts, [
    { account_id: 'A77', currency_id: 'INR-1', debit_or_credit: 'debit', exchange_rate: 1, amount: 1000 },
    { account_id: 'A108', currency_id: 'INR-1', debit_or_credit: 'credit', exchange_rate: 1, amount: 2400 },
    { account_id: 'A52', currency_id: 'INR-1', debit_or_credit: 'debit', exchange_rate: 1, amount: 100 },
  ]);
  assert.throws(() => openingBalanceBody(plan999(), { ...RES, accounts: {} }), OpeningPostError);
  // An account resolved without its currency is refused here, not by Books (code 22006).
  assert.throws(() => openingBalanceBody(plan999(), { ...RES, accounts: { ...RES.accounts, AL0077: { account_id: 'A77' } } }), /no currency/);
});

test('document bodies: each module, its own number, the offset account and the location', () => {
  const p = plan999();
  const by = (ref) => p.documents.find((d) => d.sourceRef === ref);
  const inv = documentBody(by('J1'), p, RES);
  assert.deepEqual([inv.customer_id, inv.invoice_number, inv.date, inv.due_date, inv.location_id], ['C1', '999/J1', '2025-11-01', '2025-12-01', LOC]);
  assert.deepEqual([inv.line_items[0].item_id, inv.line_items[0].rate], ['ITEM-OB', 1600]);
  const cn = documentBody(by('C1'), p, RES);
  assert.deepEqual([cn.creditnote_number, cn.line_items[0].account_id, cn.line_items[0].rate], ['999/C1', 'ACC-OBA', 100]);
  const bill = documentBody(by('25/PB/7'), p, RES);
  assert.deepEqual([bill.vendor_id, bill.bill_number, bill.reference_number, bill.line_items[0].account_id], ['V1', '999/25/PB/7', 'INV-7', 'ACC-OBA']);
  const adv = documentBody(by('25/PY/8'), p, { ...RES, advancePaidThroughId: 'BANK-1' });
  assert.deepEqual([adv.vendor_id, adv.amount, adv.reference_number, adv.paid_through_account_id], ['V2', 100, '999/25/PY/8', 'BANK-1']);
  assert.equal(documentBody(by('J1'), p, { ...RES, docDate: 'asof' }).date, '2026-03-31');
  assert.throws(() => documentBody(by('J1'), p, { ...RES, contacts: {} }), OpeningPostError);
  assert.throws(() => documentBody({ ...by('J1'), kind: 'debit_note' }, p, RES), /original Books invoice/);
});

test('idempotency match: same number and same contact only', () => {
  const p = plan999();
  const inv = p.documents.find((d) => d.sourceRef === 'J1');
  assert.equal(sameDocument(inv, { invoice_number: '999/J1', customer_id: 'C1' }, 'C1'), true);
  assert.equal(sameDocument(inv, { invoice_number: '999/J1', customer_id: 'C9' }, 'C1'), false);
  assert.equal(sameDocument(inv, { invoice_number: '999/J2', customer_id: 'C1' }, 'C1'), false);
});

test('posting queue: invoices before notes, bills before advances; smoke test takes one of each', () => {
  const p = plan999();
  assert.deepEqual(postingQueue(p).map((d) => d.kind), ['invoice', 'invoice', 'credit_note', 'credit_note', 'bill', 'vendor_advance']);
  assert.deepEqual(postingQueue(p, { perKind: 1, kinds: ['invoice', 'bill'] }).map((d) => d.kind), ['invoice', 'bill']);
});

test('post gate: shared posting guard, test organisation only, named on the command line', () => {
  const ok = {
    driver: 'live', postingEnabled: true, postingAuthorizationRef: 'REF-1',
    organizationId: OPENING_TEST_ORG, orgAllowlist: [OPENING_TEST_ORG],
  };
  assert.doesNotThrow(() => assertTestOrgPosting(ok, OPENING_TEST_ORG, assertPostingAllowed));
  assert.throws(() => assertTestOrgPosting({ ...ok, driver: 'mock' }, OPENING_TEST_ORG, assertPostingAllowed), /driver/);
  assert.throws(() => assertTestOrgPosting({ ...ok, postingEnabled: false }, OPENING_TEST_ORG, assertPostingAllowed), /POSTING_ENABLED/);
  assert.throws(() => assertTestOrgPosting({ ...ok, organizationId: '60065029674', orgAllowlist: ['60065029674'] }, '60065029674', assertPostingAllowed), /test organisation/);
  assert.throws(() => assertTestOrgPosting({ ...ok, orgAllowlist: [OPENING_TEST_ORG, '60065029674'] }, OPENING_TEST_ORG, assertPostingAllowed), /only/);
  assert.throws(() => assertTestOrgPosting(ok, undefined, assertPostingAllowed), /--confirm-org/);
});

test('account lookup: exactly one Books account per code, repeats of the same account collapse', () => {
  const a = { account_id: '1', account_code: 'AL0081', account_name: 'Tds Receivable Py' };
  assert.equal(pickAccount('AL0081', [a, { ...a }]).account.account_id, '1');
  assert.match(pickAccount('AL0081', [a, { ...a, account_id: '2' }]).problem, /2 Books accounts/);
  assert.match(pickAccount('AL0171', [a]).problem, /0 Books accounts/);
});
