// Data validation: src/core/validation.js and src/server/routes/validation.js.
// All names, codes and amounts are synthetic.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openStore } from '../src/adapters/store/memory.js';
import { openArchive } from '../src/adapters/archive/local.js';
import { createAudit } from '../src/core/audit.js';
import { createApp } from '../src/server/app.js';
import { runValidation, reportCsv, normCode, ValidationError } from '../src/core/validation.js';
import { parseCsv } from '../src/core/csv.js';
import { buildXlsx } from './helpers/xlsx_builder.js';

const buf = (s) => Buffer.from(s, 'utf8');
const file = (name, content) => ({ name, bytes: Buffer.isBuffer(content) ? content : buf(content) });
const TB_HEAD = ['Act Code', 'Description', 'Op.Debit', 'Op.Credit', 'Tran. Debit', 'Tran. Credit', 'Cl.Debit', 'Cl.Credit'];

// Eco Green style: a 31 March TB (opening file), the period TB (closing file) and the ledger.
// BANK 000939 opens 1000 Dr; SALES closes the year (500 Cr at 31 March, 0 at 1 April);
// PARTY H001 posts through the Sundry Debtors control ledger named in Status.
function ecoGreenFiles() {
  const opening = buildXlsx([{ name: 'TB', rows: [
    ['Opening trial balance as at 31-03-2026'],
    TB_HEAD,
    ['000939', 'Hdfc Bank', 0, 0, 0, 0, 1000, 0],
    ['DEBT', 'Sundry Debtors', 0, 0, 0, 0, 200, 0],
    ['SAL', 'Sales Account', 0, 0, 0, 0, 0, -500],
    ['RES', 'Reserve & Surplus', 0, 0, 0, 0, 0, -700],
    [null, 'Grand Total', 0, 0, 0, 0, 1200, -1200],
  ] }]);
  const closing = buildXlsx([{ name: 'TB', rows: [
    TB_HEAD,
    ['000939', 'Hdfc Bank', 1000, 0, 300, -100, 1200, 0],
    ['DEBT', 'Sundry Debtors', 200, 0, 0, -300, 0, -100],
    ['SAL', 'Sales Account', 0, 0, 100, 0, 100, 0],
    ['RES', 'Reserve & Surplus', 0, -1200, 0, 0, 0, -1200],
    [null, 'Grand Total', 1200, -1200, 400, -400, 1300, -1300],
  ] }]);
  const ledger = [
    'c_br_code,c_year,c_prefix,d_date,n_tran_no,c_act_code,act_name,Debit,Credit,Status,To be pushed by',
    "461,26,211,01/04/2026,1,'000939,HDFC BANK,300.00,0.00,,ZOHO",
    '461,26,211,01/04/2026,1,H001,ACME STORES,0.00,-300.00,Sundry Debtors,ZOHO',
    '461,26,Q,02/04/2026,2,SAL,SALES ACCOUNT,100.00,0.00,,Smartpharma',
    "461,26,Q,02/04/2026,2,'000939,HDFC BANK,0.00,-100.00,,Smartpharma",
    ',,,,,,,400.00,-400.00,,',
  ].join('\n');
  return { opening: file('opening_tb.xlsx', opening), closing: file('closing_tb.xlsx', closing), ledger: file('ledger.csv', ledger) };
}

describe('runValidation: Eco Green reports', () => {
  test('closing-TB opening columns: every account reconciles; party lines go to their control ledger', () => {
    const f = ecoGreenFiles();
    const r = runValidation({ closing: f.closing, ledger: f.ledger }, {});
    assert.equal(r.opening_basis, 'closing_tb_opening_columns', 'no Opening TB file -> Closing TB opening columns');
    assert.equal(r.summary.accounts, 4);
    assert.equal(r.summary.equation_holds, true, JSON.stringify(r.accounts.filter((a) => a.status !== 'RECONCILED')));
    const debt = r.accounts.find((a) => a.code === 'DEBT');
    assert.equal(debt.credit, '300.00');
    assert.equal(debt.party_lines, 1);
    assert.equal(r.lines[debt.key][0].party, 'H001 ACME STORES');
    const bank = r.accounts.find((a) => a.code === '000939');
    assert.deepEqual([bank.opening, bank.debit, bank.credit, bank.calculated_closing, bank.closing_tb], ['1000.00', '300.00', '100.00', '1200.00', '1200.00']);
    assert.equal(r.lines[bank.key].length, 2, 'apostrophe codes match the TB code');
    assert.equal(r.lines[bank.key][1].voucher, '26/Q/2');
    assert.equal(r.summary.file_checks.find((c) => c.check === 'Every voucher balances').ok, true);
  });

  test('Opening TB file (31 March): year-end close shows as differences, explained by OPENING_MISMATCH', () => {
    const f = ecoGreenFiles();
    const r = runValidation(f, {});
    assert.equal(r.opening_basis, 'closing_columns');
    const sal = r.accounts.find((a) => a.code === 'SAL');
    assert.equal(sal.status, 'DIFFERENCE_FOUND');
    assert.equal(sal.difference, '-500.00');
    assert.ok(sal.flags.includes('OPENING_MISMATCH'));
    assert.equal(r.accounts.find((a) => a.code === 'RES').difference, '500.00');
    assert.equal(r.summary.differences, 2);
    assert.equal(r.summary.total_difference, '1000.00');
    assert.ok(r.exceptions.inconsistencies.some((i) => i.type === 'OPENING_MISMATCH' && i.account_code === 'SAL'));
    // the same files with the Closing TB opening reconcile
    assert.equal(runValidation(f, { openingBasis: 'closing_tb_opening' }).summary.equation_holds, true);
  });
});

// The same branch with a sectioned 31 March TB: ASSETS / LIABILITIES are balance sheet,
// INCOME / EXPENDITURE are P&L. At 1 April Eco Green zeroes P&L, opens Opening Stock at last
// year's closing stock (250) and moves the year's result (profit 750) to Reserve & Surplus.
function sectionedFiles({ reserveName = 'Reserve & Surplus' } = {}) {
  const opening = buildXlsx([{ name: 'TB', rows: [
    ['Trial Balance For the Period Between : 31 Mar, 2026 and 31 Mar, 2026'],
    [...TB_HEAD, 'Sub Total', 'Total'],
    [null, 'ASSETS', null, null, null, null, null, null, null, 1200],
    [null, '  CURRENT ASSETS', null, null, null, null, null, null, 1200, null],
    ['000939', '    Hdfc Bank', 0, 0, 0, 0, 1000, 0],
    ['DEBT', '    Sundry Debtors', 0, 0, 0, 0, 200, 0],
    [null, 'LIABILITIES', null, null, null, null, null, null, null, -700],
    ['RES', `    ${reserveName}`, 0, 0, 0, 0, 0, -700],
    [null, 'INCOME', null, null, null, null, null, null, null, -800],
    ['SAL', '    Sales Account', 0, 0, 0, 0, 0, -800],
    [null, 'EXPENDITURE', null, null, null, null, null, null, null, 300],
    ['OPSTK', '    Opening Stock', 0, 0, 0, 0, 300, 0],
    [null, 'Grand Total', 0, 0, 0, 0, 1500, -1500],
  ] }]);
  const closing = buildXlsx([{ name: 'TB', rows: [
    TB_HEAD,
    ['000939', 'Hdfc Bank', 1000, 0, 300, -100, 1200, 0],
    ['DEBT', 'Sundry Debtors', 200, 0, 0, -300, 0, -100],
    ['RES', reserveName, 0, -1450, 0, 0, 0, -1450],
    ['SAL', 'Sales Account', 0, 0, 100, 0, 100, 0],
    ['OPSTK', 'Opening Stock', 250, 0, 0, 0, 250, 0],
  ] }]);
  return { ...ecoGreenFiles(), opening: file('opening_tb.xlsx', opening), closing: file('closing_tb.xlsx', closing) };
}

describe('runValidation: balance sheet items only (year-end close)', () => {
  test('default with a sectioned Opening TB: P&L opens at zero, stock carried, result to Reserve & Surplus', () => {
    const r = runValidation(sectionedFiles(), {});
    assert.equal(r.opening_basis, 'balance_sheet_only');
    assert.equal(r.summary.equation_holds, true, JSON.stringify(r.accounts.filter((a) => a.status !== 'RECONCILED')));
    const by = Object.fromEntries(r.accounts.map((a) => [a.code, a]));
    assert.equal(by.SAL.opening, '0.00', 'income does not carry forward');
    assert.equal(by.OPSTK.opening, '250.00', 'opening stock = last year closing stock from the Closing TB');
    assert.equal(by.RES.opening, '-1450.00');
    assert.equal(by['000939'].opening, '1000.00', 'balance sheet items unchanged');
    const y = r.year_end_close;
    assert.deepEqual([y.pl_accounts, y.pl_total, y.result, y.result_amount], [2, '-500.00', 'PROFIT', '750.00']);
    assert.deepEqual([y.opening_stock.before, y.opening_stock.carried], ['300.00', '250.00']);
    assert.deepEqual([y.reserve.code, y.reserve.before, y.reserve.after, y.reserve.agrees], ['RES', '-700.00', '-1450.00', true]);
    assert.ok(!r.exceptions.inconsistencies.some((i) => i.type === 'OPENING_MISMATCH' || i.type === 'TB_NOT_BALANCED'));
  });

  test('"all accounts" keeps the old behaviour: P&L balances show as differences', () => {
    const r = runValidation(sectionedFiles(), { openingBasis: 'closing_columns' });
    assert.equal(r.opening_basis, 'closing_columns');
    assert.equal(r.year_end_close, null);
    assert.equal(r.summary.equation_holds, false);
    assert.ok(r.exceptions.inconsistencies.some((i) => i.type === 'OPENING_MISMATCH' && i.account_code === 'SAL'));
  });

  test('no reserve account by name: reported, and fixed by naming the reserve account', () => {
    const f = sectionedFiles({ reserveName: 'General Fund' });
    const r = runValidation(f, {});
    assert.equal(r.year_end_close.reserve, null);
    assert.ok(r.exceptions.inconsistencies.some((i) => i.type === 'RESERVE_NOT_FOUND'));
    assert.equal(r.summary.equation_holds, false);
    const fixed = runValidation(f, { reserveCode: 'RES' });
    assert.equal(fixed.summary.equation_holds, true);
    assert.throws(() => runValidation(f, { reserveCode: 'SAL' }), (e) => e instanceof ValidationError && e.code === 'BAD_REQUEST', 'a P&L account cannot take the result');
  });

  test('an Opening TB without section headings cannot be split; auto keeps all accounts', () => {
    const f = ecoGreenFiles();
    assert.throws(() => runValidation(f, { openingBasis: 'balance_sheet_only' }), (e) => e instanceof ValidationError && e.code === 'BASIS_UNAVAILABLE');
    assert.equal(runValidation(f, {}).opening_basis, 'closing_columns');
  });
});

describe('runValidation: plain exports, exceptions and mappings', () => {
  const opening = 'Account Name,Debit,Credit\nCash,1000,\nCapital,,1000\nOld Ledger,50,\nSuspense,,50\n';
  const closing = 'Account Name,Balance\nCash,900\nCapital,-1000\nRent Expense,100\nSuspence A/c,0\nOld Ledger,50\nSuspense,-50\n';
  const ledger = 'Date,Voucher No,Account Name,Debit,Credit,Narration\n2026-04-02,J1,Rent,100,,April rent\n2026-04-02,J1,Cash,,100,April rent\n';

  test('names only: matched by name; unmapped and missing accounts are listed with suggestions', () => {
    const r = runValidation({ opening: file('o.csv', opening), closing: file('c.csv', closing), ledger: file('l.csv', ledger) });
    const byName = Object.fromEntries(r.accounts.map((a) => [a.name, a]));
    assert.equal(byName.Cash.status, 'RECONCILED');
    assert.equal(byName['Rent Expense'].status, 'DIFFERENCE_FOUND', 'ledger says "Rent", the TB "Rent Expense"');
    assert.ok(byName.Rent.flags.includes('UNMAPPED'));
    assert.ok(byName.Rent.flags.includes('MISSING_OPENING') && byName.Rent.flags.includes('MISSING_CLOSING'));
    assert.equal(byName.Rent.source_role, 'ledger');
    assert.equal(byName.Rent.suggestions[0].name, 'Rent Expense');
    assert.ok(r.exceptions.not_in_ledger.includes(byName['Old Ledger'].key));
    assert.equal(byName['Old Ledger'].movement_expected, false);
    assert.ok(byName['Suspence A/c'].flags.includes('MISSING_OPENING'));
    assert.equal(r.summary.counts.unbalanced_vouchers, 0);
  });

  test('a confirmed mapping links the files and the account reconciles', () => {
    const files = { opening: file('o.csv', opening), closing: file('c.csv', closing), ledger: file('l.csv', ledger) };
    const first = runValidation(files);
    const rent = first.accounts.find((a) => a.name === 'Rent');
    const target = first.accounts.find((a) => a.name === 'Rent Expense');
    const r = runValidation(files, { mappings: [{ role: 'ledger', from_key: rent.source_key, to_key: target.key }] });
    const acc = r.accounts.find((a) => a.name === 'Rent Expense');
    assert.equal(acc.status, 'RECONCILED');
    assert.equal(acc.debit, '100.00');
    assert.ok(!r.accounts.some((a) => a.name === 'Rent'));
    assert.equal(r.lines[acc.key][0].narration, 'April rent');
  });

  test('duplicates, inconsistencies, leading zeros and tolerance', () => {
    const tb = 'Account Code,Account Name,Debit,Credit\n0101,Cash,100,\n101,Cash in hand,,\nTDS1,Tds Payable,,40\nTDS2,Tds Payable,,10\nX1,Both,5,5\n';
    const close = 'Account Code,Account Name,Debit,Credit\n101,Cash,150.40,\nTDS1,Tds Payable,,40\nTDS2,Tds Payable,,10\nX1,Both,,\n';
    const led = 'Voucher No,Account Code,Account Name,Debit,Credit\nV1,0101,Cash,50,\nV1,TDS1,Tds Payable,,40\n';
    const r = runValidation({ opening: file('o.csv', tb), closing: file('c.csv', close), ledger: file('l.csv', led) }, { tolerance: '1.00' });
    const cash = r.accounts.find((a) => a.code === '101');
    assert.equal(cash.calculated_closing, '150.00');
    assert.equal(cash.difference, '-0.40');
    assert.equal(cash.status, 'RECONCILED', 'within the 1.00 tolerance');
    const reasons = r.exceptions.duplicates.map((d) => d.reason);
    assert.ok(reasons.includes('One code with different names'), JSON.stringify(r.exceptions.duplicates));
    assert.ok(reasons.includes('One name under different codes'));
    const types = r.exceptions.inconsistencies.map((i) => i.type);
    assert.ok(types.includes('BOTH_SIDES'));
    assert.ok(types.includes('TB_NOT_BALANCED'));
    assert.ok(types.includes('LEDGER_NOT_BALANCED'));
    assert.ok(types.includes('VOUCHER_NOT_BALANCED'));
    assert.equal(normCode("'000939"), '939');
    assert.equal(normCode('-CGSTR'), '-CGSTR');
  });

  test('reportCsv: the report columns, totals and exception views', () => {
    const r = runValidation({ opening: file('o.csv', opening), closing: file('c.csv', closing), ledger: file('l.csv', ledger) });
    const all = parseCsv(reportCsv(r, 'all').slice(1));
    assert.deepEqual(all.header.slice(0, 10), ['Account Code', 'Account Name', 'Opening Balance', 'Total Debit', 'Total Credit', 'Net Transaction', 'Calculated Closing Balance', 'Closing TB Balance', 'Difference', 'Reconciliation Status']);
    assert.equal(all.rows.at(-1)[0], 'TOTAL');
    assert.equal(parseCsv(reportCsv(r, 'differences').slice(1)).rows.length, r.summary.differences);
    assert.match(reportCsv(r, 'inconsistencies'), /^﻿Type,File,Row/);
    assert.match(reportCsv(r, 'duplicates'), /^﻿File,Account code/);
  });

  test('unreadable files are a ValidationError naming the file', () => {
    assert.throws(() => runValidation({ closing: file('c.csv', 'foo,bar\n1,2\n'), ledger: file('l.csv', ledger) }), (e) => e instanceof ValidationError && /c\.csv/.test(e.message));
    assert.throws(() => runValidation({ ledger: file('l.csv', ledger) }), /Closing TB file is required/);
    assert.throws(() => runValidation({ closing: file('c.csv', closing), ledger: file('l.csv', 'Account Name,Debit,Credit\nCash,abc,\n') }), /is not an amount/);
  });
});

// ---------------------------------------------------------------- routes

const sha = (t) => createHash('sha256').update(t, 'utf8').digest('hex');
const TOKENS = { operator: 'tok-val-operator', viewer: 'tok-val-viewer', bot: 'tok-val-bot', other: 'tok-val-other' };
const USERS = [
  { id: 'u_operator', role: 'operator', branches: ['B1'], token_sha256: sha(TOKENS.operator) },
  { id: 'u_viewer', role: 'viewer', branches: ['B1'], token_sha256: sha(TOKENS.viewer) },
  { id: 'bot:hermes', role: 'operator', branches: ['B1'], token_sha256: sha(TOKENS.bot) },
  { id: 'u_other', role: 'operator', branches: ['B2'], token_sha256: sha(TOKENS.other) },
];

async function startApp() {
  const root = await mkdtemp(path.join(tmpdir(), 'validation-'));
  const store = await openStore();
  const app = createApp({ store, audit: createAudit(store), users: USERS, devDeps: { archive: await openArchive({ root }) } });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (method, p, role, body) => {
    const res = await fetch(`${base}${p}`, {
      method, headers: { Authorization: `Bearer ${TOKENS[role]}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const textBody = await res.text();
    let json = null;
    try { json = JSON.parse(textBody); } catch { /* csv */ }
    return { status: res.status, body: json, text: textBody };
  };
  return {
    store, call,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      await store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

const b64 = (b) => (Buffer.isBuffer(b) ? b : buf(b)).toString('base64');

describe('validation routes', () => {
  test('run, list, open, drill down, CSV, map and re-run', async () => {
    const t = await startApp();
    try {
      const opening = 'Account Name,Debit,Credit\nCash,1000,\nCapital,,1000\n';
      const closing = 'Account Name,Balance\nCash,900\nCapital,-1000\nRent Expense,100\n';
      const ledger = 'Voucher No,Account Name,Debit,Credit\nJ1,Rent,100,\nJ1,Cash,,100\n';
      const files = { opening: { name: 'o.csv', content: b64(opening) }, closing: { name: 'c.csv', content: b64(closing) }, ledger: { name: 'l.csv', content: b64(ledger) } };

      const run = await t.call('POST', '/branches/B1/validation/runs', 'operator', { files });
      assert.equal(run.status, 201, JSON.stringify(run.body));
      assert.equal(run.body.summary.equation_holds, false);
      assert.equal(run.body.lines, undefined, 'ledger lines are not sent with the report');
      const id = run.body.id;

      const list = await t.call('GET', '/branches/B1/validation/runs', 'viewer');
      assert.equal(list.body.runs[0].id, id);
      assert.equal(list.body.runs[0].inputs.ledger.name, 'l.csv');

      const got = await t.call('GET', `/branches/B1/validation/runs/${id}`, 'viewer');
      assert.equal(got.status, 200);
      const cash = got.body.accounts.find((a) => a.name === 'Cash');
      const lines = await t.call('GET', `/branches/B1/validation/runs/${id}/lines?account=${encodeURIComponent(cash.key)}`, 'viewer');
      assert.equal(lines.body.total_lines, 1);
      assert.equal(lines.body.lines[0].voucher, 'J1');

      const csv = await t.call('GET', `/branches/B1/validation/runs/${id}/report.csv?view=unmapped`, 'viewer');
      assert.equal(csv.status, 200);
      assert.match(csv.text, /Rent/);
      assert.equal((await t.call('GET', `/branches/B1/validation/runs/${id}/report.csv?view=bogus`, 'viewer')).status, 400);

      const rent = got.body.accounts.find((a) => a.name === 'Rent');
      const target = got.body.accounts.find((a) => a.name === 'Rent Expense');
      const saved = await t.call('POST', '/validation/mappings', 'operator', { role: rent.source_role, from_key: rent.source_key, from_name: 'Rent', to_key: target.key, to_name: 'Rent Expense' });
      assert.equal(saved.status, 200, JSON.stringify(saved.body));
      assert.equal((await t.call('GET', '/validation/mappings', 'viewer')).body.mappings.length, 1);

      const again = await t.call('POST', `/branches/B1/validation/runs/${id}/rerun`, 'operator', {});
      assert.equal(again.status, 201, JSON.stringify(again.body));
      assert.equal(again.body.summary.equation_holds, true);
      assert.equal(again.body.rerun_of, id);
      assert.equal(again.body.mappings_used, 1);

      const removed = await t.call('POST', '/validation/mappings/remove', 'operator', { role: rent.source_role, from_key: rent.source_key });
      assert.equal(removed.status, 200);
      assert.equal((await t.call('GET', '/validation/mappings', 'viewer')).body.mappings.length, 0);
      assert.equal((await t.store.find('audit_events', { action: 'VALIDATION.RUN' })).length, 2);
    } finally {
      await t.close();
    }
  });

  test('roles, bots, branch scope and bad files', async () => {
    const t = await startApp();
    try {
      const files = { closing: { name: 'c.csv', content: b64('Account Name,Balance\nCash,0\n') }, ledger: { name: 'l.csv', content: b64('Account Name,Debit,Credit\nCash,1,1\n') } };
      assert.equal((await t.call('POST', '/branches/B1/validation/runs', 'viewer', { files })).status, 403);
      assert.equal((await t.call('POST', '/branches/B1/validation/runs', 'bot', { files })).status, 403);
      assert.equal((await t.call('POST', '/branches/B1/validation/runs', 'other', { files })).status, 403);
      assert.equal((await t.call('GET', '/branches/B1/validation/runs', 'other')).status, 403);
      assert.equal((await t.call('POST', '/validation/mappings', 'viewer', { role: 'ledger', from_key: 'N:a', to_key: 'N:b' })).status, 403);
      assert.equal((await t.call('POST', '/validation/mappings', 'operator', { role: 'nope', from_key: 'N:a', to_key: 'N:b' })).status, 400);
      const bad = await t.call('POST', '/branches/B1/validation/runs', 'operator', { files: { ...files, closing: { name: 'c.csv', content: b64('x,y\n1,2\n') } } });
      assert.equal(bad.status, 400);
      assert.equal(bad.body.error, 'HEADER_NOT_FOUND');
      const missing = await t.call('POST', '/branches/B1/validation/runs', 'operator', { files: { ledger: files.ledger } });
      assert.equal(missing.status, 400);
      assert.equal((await t.call('GET', '/branches/B1/validation/runs/val-nope', 'viewer')).status, 404);
      const ok = await t.call('POST', '/branches/B1/validation/runs', 'operator', { files });
      assert.equal(ok.status, 201, JSON.stringify(ok.body));
      assert.equal((await t.call('GET', `/branches/B2/validation/runs/${ok.body.id}`, 'other')).status, 404, 'a run is only found under its own branch');
    } finally {
      await t.close();
    }
  });
});
