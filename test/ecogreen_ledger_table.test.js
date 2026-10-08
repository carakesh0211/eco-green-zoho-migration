// Eco Green "ledger table" normaliser (src/sources/ecogreen/ledger_table.js).
// Every value below is synthetic: branch PILOT01, parties V9000x / H9000x, accounts
// CASH / BANK01 / EXP01 / SALES / CAP, controls "Sundry Creditors - Goods" etc.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { normaliseLedgerTable, LEDGER_COLUMNS, TB_COLUMNS, EXCLUSION_REASONS } from '../src/sources/ecogreen/ledger_table.js';
import { NormaliseError } from '../src/sources/ecogreen/normalise.js';
import { runNormalise } from '../scripts/normalise-ecogreen.js';
import { runLayerAStage } from '../scripts/lib/pipeline-stages.js';
import { parseCsv } from '../src/core/csv.js';
import { parseMoney, formatMoney, sum } from '../src/core/money.js';
import { sha256Bytes, sha256Text } from '../src/core/hash.js';
import { validateManifest, TRANSACTIONS_COLUMNS, TRIAL_BALANCE_COLUMNS } from '../src/core/manifest.js';
import { openStore } from '../src/adapters/store/memory.js';
import { createAudit } from '../src/core/audit.js';
import { ingestRun } from '../src/core/ingest.js';
import { buildXlsx, zip } from './helpers/xlsx_builder.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------- fixtures

const PROFILE = {
  format: 'ledger-table',
  profile_version: 'v1',
  branch_code: 'PILOT01',
  from_date: '2026-04-01',
  to_date: '2026-07-05',
  extracted_at: '2026-07-06T00:00:00+05:30',
  ledger_file: 'ledger.csv',
  closing_tb_file: 'closing_tb.csv',
  opening_tb_file: 'opening_tb.csv',
  pushed_by_value: 'ZOHO',
  prefix_types: { J: 'JOURNAL', P: 'PAYMENT', R: 'RECEIPT', F: 'CONTRA' },
  control_aliases: {},
};

const EXAMPLE = JSON.parse(readFileSync(path.join(ROOT, 'config', 'source-profiles', 'ecogreen-ledger-table.example.json'), 'utf8'));

const ZOHO = 'ZOHO';
const SMART = 'Smartpharma';
const AP = 'Sundry Creditors - Goods';
const AR = 'Sundry Debtors - Credit';

const csvField = (v) => { const s = String(v ?? ''); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const csvLine = (cells) => cells.map(csvField).join(',');

// ---- the ledger table

const LEDGER_HEAD = ['c_br_code', 'c_year', 'c_prefix', 'd_date', 'n_tran_no', 'c_act_code', 'act_name', 'n_amount', 'Debit', 'Credit', 'c_opp_act_code', 'n_flag', 'c_ref_br_code', 'n_pk', 'opp_act_name', 'Status', 'To be pushed by '];
let pk = 0;
/** One ledger line. amt > 0 is a debit, amt < 0 a credit (shown as a negative in the Credit column, as the source does). */
function ln({ p = 'J', no, date = '05/04/26', code, name = '', amt, opp = '', oppName = '', status = '', by = ZOHO, br = 'PILOT01', year = '26', debit, credit }) {
  const dr = debit ?? (amt > 0 ? amt : 0);
  const cr = credit ?? (amt < 0 ? amt : 0);
  pk += 1;
  return {
    c_br_code: br, c_year: year, c_prefix: p, d_date: date, n_tran_no: no, c_act_code: code, act_name: name,
    n_amount: (amt ?? 0).toFixed(2), Debit: dr.toFixed(2), Credit: cr.toFixed(2), c_opp_act_code: opp, n_flag: '0',
    c_ref_br_code: 'PILOT01', n_pk: String(pk), opp_act_name: oppName, Status: status, 'To be pushed by ': by,
  };
}
const ledgerCsv = (rows, head = LEDGER_HEAD) => `${[csvLine(head), ...rows.map((r) => csvLine(head.map((h) => r[h] ?? '')))].join('\n')}\n`;

/**
 * Base population: four documents pushed by us, two by Smartpharma, one footer row.
 *   J/1 expense paid from bank, P/5 payment to vendor V90001, R/8 receipt from customer H90001
 *   (its two lines carry different c_br_code: 'PILOT01' and '0'), F/3 bank deposit from cash.
 */
function baseRows() {
  pk = 0; // n_pk restarts so repeated calls produce identical bytes
  return [
    ln({ p: 'J', no: '1', date: '05/04/26', code: 'EXP01', name: 'Office Expenses', amt: 300, opp: 'BANK01', oppName: 'Bank Account' }),
    ln({ p: 'J', no: '1', date: '05/04/26', code: 'BANK01', name: 'Bank Account', amt: -300, opp: 'EXP01', oppName: 'Office Expenses' }),
    ln({ p: 'P', no: '5', date: '10/04/26', code: 'V90001', name: 'Vendor One', amt: 500, opp: 'BANK01', oppName: 'Bank Account', status: AP }),
    ln({ p: 'P', no: '5', date: '10/04/26', code: 'BANK01', name: 'Bank Account', amt: -500, opp: 'V90001', oppName: 'Vendor One' }),
    ln({ p: 'R', no: '8', date: '15/04/26', code: 'CASH', name: 'Cash in Hand', amt: 700, opp: 'H90001', oppName: 'Customer One', br: 'PILOT01' }),
    ln({ p: 'R', no: '8', date: '15/04/26', code: 'H90001', name: 'Customer One', amt: -700, opp: 'CASH', oppName: 'Cash in Hand', status: AR, br: '0' }),
    ln({ p: 'F', no: '3', date: '12/04/26', code: 'BANK01', name: 'Bank Account', amt: 100, opp: 'CASH', oppName: 'Cash in Hand' }),
    ln({ p: 'F', no: '3', date: '12/04/26', code: 'CASH', name: 'Cash in Hand', amt: -100, opp: 'BANK01', oppName: 'Bank Account' }),
    ln({ p: 'S', no: '50', date: '20/04/26', code: 'SALES', name: 'Sales Account', amt: -1000, opp: 'H90001', oppName: 'Customer One', by: SMART }),
    ln({ p: 'S', no: '50', date: '20/04/26', code: 'H90001', name: 'Customer One', amt: 1000, opp: 'SALES', oppName: 'Sales Account', status: AR, by: SMART }),
    ln({ p: 'S', no: '51', date: '22/04/26', code: 'EXP01', name: 'Office Expenses', amt: 400, opp: 'V90001', oppName: 'Vendor One', by: SMART }),
    ln({ p: 'S', no: '51', date: '22/04/26', code: 'V90001', name: 'Vendor One', amt: -400, opp: 'EXP01', oppName: 'Office Expenses', status: AP, by: SMART }),
    // footer / grand-total row: no prefix, no transaction number
    ln({ p: '', no: '', date: '', code: '', amt: 0, debit: 3000, credit: -3000, by: '' }),
  ];
}

// ---- trial balance reports (title rows, header row, group rows without an Act Code)

const TB_HEAD = ['Act Code', 'Description', 'Op.Debit', 'Op.Credit', 'Tran. Debit', 'Tran. Credit', 'Cl.Debit', 'Cl.Credit', 'Sub Total', 'Total'];
const m2 = (n) => Number(n).toFixed(2);
/** account: [code, name, [opDr, opCr], [trDr, trCr], [clDr, clCr]] */
const ACCOUNTS = [
  ['BANK01', 'Bank Account', [5000, 0], [100, 800], [4300, 0]],
  ['CASH', 'Cash in Hand', [1000, 0], [700, 100], [1600, 0]],
  ['CUSCTL', AR, [3000, 0], [1000, 700], [3300, 0]],
  ['CAP', 'Capital Account', [0, 7000], [0, 0], [0, 7000]],
  ['SUPCTL', AP, [0, 2000], [500, 400], [0, 1900]],
  ['EXP01', 'Office Expenses', [0, 0], [700, 0], [700, 0]],
  ['SALES', 'Sales Account', [0, 0], [0, 1000], [0, 1000]],
];
const tbWidth = TB_HEAD.length;
const pad = (cells) => [...cells, ...Array.from({ length: tbWidth - cells.length }, () => '')];
/** the report as rows of cells: 3 title rows, header, group rows carrying subtotals, accounts, a grand-total row */
function tbCells(accounts, { titles = true } = {}) {
  const out = [];
  if (titles) {
    out.push(pad(['Eco Green Pilot Pharmacy']), pad(['Trial Balance 01/04/2026 to 05/07/2026']), pad([]));
  }
  out.push(TB_HEAD);
  out.push(pad(['', 'Assets', '99999.00', '0.00', '0.00', '0.00', '99999.00', '0.00', '99999.00', '99999.00']));
  accounts.forEach((a, i) => {
    if (i === 3) out.push(pad(['', 'Liabilities and Income', '11111.00', '0.00', '0.00', '0.00', '11111.00', '0.00', '', '']));
    const [code, name, op, tr, cl] = a;
    out.push([code, name, m2(op[0]), m2(op[1]), m2(tr[0]), m2(tr[1]), m2(cl[0]), m2(cl[1]), m2(cl[0] - cl[1]), m2(cl[0] - cl[1])]);
  });
  out.push(pad(['', 'Grand Total', '55555.00', '55555.00', '1.00', '1.00', '55555.00', '55555.00', '', '']));
  return out;
}
const tbCsv = (accounts = ACCOUNTS, opts) => `${tbCells(accounts, opts).map(csvLine).join('\n')}\n`;
/** prior-year (31 March) closing report: Cl equals the closing report's opening */
const openingAccounts = (accounts = ACCOUNTS) => accounts.map(([c, n, op]) => [c, n, op, [0, 0], op]);

function baseFiles(overrides = {}) {
  return { 'ledger.csv': ledgerCsv(baseRows()), 'closing_tb.csv': tbCsv(), 'opening_tb.csv': tbCsv(openingAccounts()), ...overrides };
}
const NOW = () => '2026-07-06T00:00:00Z';
const run = (files = baseFiles(), profile = PROFILE) => normaliseLedgerTable({ files, profile, now: NOW });

function rowsOf(text) {
  const { header, rows } = parseCsv(text);
  return rows.map((cells) => Object.fromEntries(header.map((h, i) => [h, cells[i]])));
}
const byLedger = (text) => Object.fromEntries(rowsOf(text).map((r) => [r.ledger_code, r]));
const excl = (res, prefix, reason) => res.report.exclusions.find((e) => e.prefix === prefix && e.reason === reason);

// ---------------------------------------------------------------- the clean population

test('base population: our four documents are emitted, ordered by date then id, balanced, credits from the negative column', () => {
  const res = run();
  const tx = rowsOf(res.transactionsCsv);
  assert.deepEqual(Object.keys(tx[0]), TRANSACTIONS_COLUMNS);
  const ids = [...new Set(tx.map((r) => r.voucher_id))];
  assert.deepEqual(ids, ['26/J/1', '26/P/5', '26/F/3', '26/R/8']);
  assert.equal(res.report.output.vouchers, 4);
  assert.equal(res.report.output.lines, 8);
  assert.equal(res.report.output.debit_total, '1600.00');
  assert.equal(res.report.output.credit_total, '1600.00');
  assert.deepEqual(res.report.unbalanced_vouchers, []);

  const j = tx.filter((r) => r.voucher_id === '26/J/1');
  assert.deepEqual(j.map((r) => [r.line_no, r.ledger_code, r.debit, r.credit, r.voucher_type, r.voucher_date]), [
    ['1', 'EXP01', '300.00', '0.00', 'JOURNAL', '2026-04-05'],
    ['2', 'BANK01', '0.00', '300.00', 'JOURNAL', '2026-04-05'],
  ]);
  assert.deepEqual(res.report.output.by_type, {
    JOURNAL: { vouchers: 1, lines: 2, debit_total: '300.00' },
    PAYMENT: { vouchers: 1, lines: 2, debit_total: '500.00' },
    CONTRA: { vouchers: 1, lines: 2, debit_total: '100.00' },
    RECEIPT: { vouchers: 1, lines: 2, debit_total: '700.00' },
  });
  for (const id of ids) {
    const lines = tx.filter((r) => r.voucher_id === id);
    assert.deepEqual(lines.map((r) => Number(r.line_no)), lines.map((_, i) => i + 1), 'line numbers restart at 1');
    assert.equal(lines.every((r) => r.voucher_no === id), true);
  }
});

test('document key is year/prefix/tran_no: lines with c_br_code PILOT01 and 0 join into one voucher', () => {
  const res = run();
  const r8 = rowsOf(res.transactionsCsv).filter((r) => r.voucher_id === '26/R/8');
  assert.equal(r8.length, 2);
  assert.deepEqual(r8.map((r) => r.ledger_code), ['CASH', 'CUSCTL']);

  // the same prefix/number in another year is a different document
  const rows = [
    ln({ p: 'J', no: '1', year: '26', code: 'EXP01', amt: 10 }), ln({ p: 'J', no: '1', year: '26', code: 'BANK01', amt: -10 }),
    ln({ p: 'J', no: '1', year: '27', date: '06/04/26', code: 'EXP01', amt: 20 }), ln({ p: 'J', no: '1', year: '27', date: '06/04/26', code: 'BANK01', amt: -20 }),
  ];
  const two = run(baseFiles({ 'ledger.csv': ledgerCsv(rows) }));
  assert.deepEqual([...new Set(rowsOf(two.transactionsCsv).map((r) => r.voucher_id))], ['26/J/1', '27/J/1']);
});

test('party lines: a party code absent from the TB posts to the control ledger whose Description matches Status; the party is kept', () => {
  const res = run();
  const tx = rowsOf(res.transactionsCsv);
  const pay = tx.filter((r) => r.voucher_id === '26/P/5');
  assert.deepEqual(pay.map((r) => [r.ledger_code, r.ledger_name, r.party_code, r.party_name, r.debit, r.credit]), [
    ['SUPCTL', AP, 'V90001', 'Vendor One', '500.00', '0.00'],
    ['BANK01', 'Bank Account', '', '', '0.00', '500.00'],
  ]);
  const rec = tx.filter((r) => r.voucher_id === '26/R/8');
  assert.deepEqual(rec.map((r) => [r.ledger_code, r.party_code, r.party_name]), [['CASH', '', ''], ['CUSCTL', 'H90001', 'Customer One']]);
  assert.equal(pay[0].narration, 'vs BANK01 Bank Account');
  assert.equal(rec[0].narration, 'vs H90001 Customer One');
  assert.deepEqual(res.report.unknown_controls, []);
  // the party-less contract columns stay empty
  assert.equal(tx.every((r) => r.payment_method === '' && r.tax_bucket === '' && r.reference_no === ''), true);
});

test('Status is matched to the TB Description ignoring case and punctuation; control_aliases resolves a name the TB does not carry', () => {
  const extra = [
    ln({ p: 'J', no: '20', date: '18/04/26', code: 'V90002', name: 'Vendor Two', amt: 10, status: 'SUNDRY  creditors goods.' }),
    ln({ p: 'J', no: '20', date: '18/04/26', code: 'V90003', name: 'Vendor Three', amt: 20, status: 'Trade Payables' }),
    ln({ p: 'J', no: '20', date: '18/04/26', code: 'V90004', name: 'Vendor Four', amt: 30, status: 'Mystery Control' }),
    ln({ p: 'J', no: '20', date: '18/04/26', code: 'EXP01', name: 'Office Expenses', amt: -60 }),
  ];
  const files = baseFiles({ 'ledger.csv': ledgerCsv([...baseRows(), ...extra]) });

  const plain = run(files);
  const lines = rowsOf(plain.transactionsCsv).filter((r) => r.voucher_id === '26/J/20');
  assert.deepEqual(lines.map((r) => [r.ledger_code, r.party_code]), [['SUPCTL', 'V90002'], ['V90003', ''], ['V90004', ''], ['EXP01', '']]);
  assert.deepEqual(plain.report.unknown_controls, [
    { code: 'V90003', status: 'Trade Payables', lines: 1 },
    { code: 'V90004', status: 'Mystery Control', lines: 1 },
  ]);
  // an unmapped line keeps its raw code and the source name, and shows up as a TB component outside the trial balance
  assert.equal(lines[2].ledger_name, 'Vendor Four');
  const comp = byLedger(plain.componentsCsv);
  assert.equal(comp.V90004.in_trial_balance, 'NO');
  assert.equal(comp.V90004.movement_ours, '30.00');
  assert.equal(plain.report.trial_balance_ties.all, false);
  assert.ok(plain.report.trial_balance_ties.failing.some((f) => f.ledger_code === 'V90004' && f.in_trial_balance === 'NO'));
  assert.equal(byLedger(plain.trialBalanceCsv).V90004, undefined, 'not a trial-balance ledger');

  const aliased = run(files, { ...PROFILE, control_aliases: { 'trade payables': 'SUPCTL' } });
  const al = rowsOf(aliased.transactionsCsv).filter((r) => r.voucher_id === '26/J/20');
  assert.deepEqual(al.map((r) => [r.ledger_code, r.party_code, r.party_name]), [['SUPCTL', 'V90002', 'Vendor Two'], ['SUPCTL', 'V90003', 'Vendor Three'], ['V90004', '', ''], ['EXP01', '', '']]);
  assert.deepEqual(aliased.report.unknown_controls, [{ code: 'V90004', status: 'Mystery Control', lines: 1 }]);
  assert.equal(byLedger(aliased.componentsCsv).SUPCTL.movement_ours, '530.00', '500 + 10 + 20');
  assert.equal(byLedger(plain.componentsCsv).SUPCTL.movement_ours, '510.00');
});

test('a party code that IS a ledger in the TB stays a plain ledger (Status is not consulted)', () => {
  const accounts = [...ACCOUNTS, ['V90001', 'Vendor One as a ledger', [0, 0], [0, 0], [0, 0]]];
  const res = run(baseFiles({ 'closing_tb.csv': tbCsv(accounts) }));
  const pay = rowsOf(res.transactionsCsv).filter((r) => r.voucher_id === '26/P/5');
  assert.deepEqual(pay.map((r) => [r.ledger_code, r.party_code]), [['V90001', ''], ['BANK01', '']]);
});

// ---------------------------------------------------------------- who pushes

test('only rows whose "To be pushed by" equals pushed_by_value are emitted (case and spacing ignored); the rest are counted as PUSHED_BY_OTHER', () => {
  const rows = baseRows();
  rows[0]['To be pushed by '] = ' zoho ';
  rows[1]['To be pushed by '] = 'Zoho';
  rows[2]['To be pushed by '] = 'Z O H O';
  const res = run(baseFiles({ 'ledger.csv': ledgerCsv(rows) }));
  assert.equal(res.report.output.vouchers, 4, 'spelling variants of ZOHO are all ours');
  assert.equal(res.transactionsCsv, run().transactionsCsv);
  assert.deepEqual(Object.keys(res.report.pushers).sort(), ['Smartpharma', 'Z O H O', 'ZOHO', 'Zoho', 'zoho'].sort());

  const base = run();
  assert.deepEqual(excl(base, 'S', 'PUSHED_BY_OTHER'), { prefix: 'S', reason: 'PUSHED_BY_OTHER', rows: 4, documents: 2, amount: '2800.00' });
  assert.equal(base.report.pushers.Smartpharma.rows, 4);
  assert.equal(base.report.pushers.Smartpharma.documents, 2);
  assert.deepEqual(base.report.pushers.Smartpharma.prefixes, ['S']);
  assert.equal(base.report.pushers.Smartpharma.gross_amount, '2800.00');
  assert.deepEqual(base.report.pushers.ZOHO.prefixes, ['F', 'J', 'P', 'R']);
  assert.equal(base.report.pushers.ZOHO.gross_amount, '3200.00');
});

test('pushed_by_value is configurable (case, spaces and punctuation ignored) and defaults to ZOHO', () => {
  const profile = { ...PROFILE, pushed_by_value: 'smart-pharma', prefix_types: { ...PROFILE.prefix_types, S: 'JOURNAL' } };
  const res = run(baseFiles(), profile);
  assert.deepEqual([...new Set(rowsOf(res.transactionsCsv).map((r) => r.voucher_id))], ['26/S/50', '26/S/51']);
  assert.equal(excl(res, 'J', 'PUSHED_BY_OTHER').rows, 2);
  // the other pusher is now ZOHO: its movement is added to the opening
  const comp = byLedger(res.componentsCsv);
  assert.equal(comp.BANK01.movement_other_pusher, '-700.00');
  assert.equal(comp.BANK01.movement_ours, '0.00');
  assert.equal(comp.EXP01.movement_ours, '400.00');
  assert.equal(res.report.trial_balance_ties.all, true);

  const { pushed_by_value: _drop, ...noPusher } = PROFILE;
  assert.equal(run(baseFiles(), noPusher).transactionsCsv, run().transactionsCsv);
});

// ---------------------------------------------------------------- exclusions and the bridge

function dirtyRows() {
  pk = 0;
  return [
    // PUSHED_BY_UNKNOWN: blank pusher
    ln({ p: 'J', no: '90', code: 'EXP01', amt: 10, by: '' }), ln({ p: 'J', no: '90', code: 'BANK01', amt: -10, by: '' }),
    // UNKNOWN_PREFIX
    ln({ p: 'Z', no: '70', date: '06/04/26', code: 'EXP01', amt: 20 }), ln({ p: 'Z', no: '70', date: '06/04/26', code: 'BANK01', amt: -20 }),
    // BAD_DATE
    ln({ p: 'J', no: '91', date: 'garbage', code: 'EXP01', amt: 30 }), ln({ p: 'J', no: '91', date: 'garbage', code: 'BANK01', amt: -30 }),
    // OUT_OF_WINDOW: a day after to_date, a day before from_date
    ln({ p: 'J', no: '92', date: '06/07/26', code: 'EXP01', amt: 40 }), ln({ p: 'J', no: '92', date: '06/07/26', code: 'BANK01', amt: -40 }),
    ln({ p: 'J', no: '93', date: '31/03/26', code: 'EXP01', amt: 5 }), ln({ p: 'J', no: '93', date: '31/03/26', code: 'BANK01', amt: -5 }),
    // ZERO_AMOUNT: a nil line, and a line whose debit and credit cancel
    ln({ p: 'J', no: '94', code: 'EXP01', amt: 0 }), ln({ p: 'J', no: '94', code: 'BANK01', debit: 100, credit: -100 }),
    // FOOTER rows: prefix without a number, number without a prefix, a totals row
    ln({ p: 'J', no: '', code: '', amt: 0, debit: 500, credit: 0 }),
    ln({ p: '', no: '12', code: '', amt: 0, debit: 7, credit: 0 }),
    ln({ p: '', no: '', date: '', code: '', amt: 0, debit: 600, credit: -600, by: '' }),
    // window boundaries are inclusive
    ln({ p: 'J', no: '95', date: '01/04/26', code: 'EXP01', amt: 1 }), ln({ p: 'J', no: '95', date: '01/04/26', code: 'BANK01', amt: -1 }),
    ln({ p: 'J', no: '96', date: '05/07/26', code: 'EXP01', amt: 2 }), ln({ p: 'J', no: '96', date: '05/07/26', code: 'BANK01', amt: -2 }),
    // one document whose lines carry different dates: the earliest is used
    ln({ p: 'J', no: '97', date: '10/04/26', code: 'EXP01', amt: 3 }), ln({ p: 'J', no: '97', date: '08/04/26', code: 'BANK01', amt: -3 }),
    // a document split between pushers: only our half is emitted and the voucher is reported unbalanced
    ln({ p: 'J', no: '98', code: 'EXP01', amt: 50 }), ln({ p: 'J', no: '98', code: 'BANK01', amt: -50, by: SMART }),
  ];
}

test('every excluded row is counted under one reason, with documents and gross amount; the bridge ties', () => {
  const res = run(baseFiles({ 'ledger.csv': ledgerCsv(dirtyRows()) }));
  const r = res.report;
  assert.deepEqual(excl(res, 'J', 'PUSHED_BY_UNKNOWN'), { prefix: 'J', reason: 'PUSHED_BY_UNKNOWN', rows: 2, documents: 1, amount: '20.00' });
  assert.deepEqual(excl(res, 'Z', 'UNKNOWN_PREFIX'), { prefix: 'Z', reason: 'UNKNOWN_PREFIX', rows: 2, documents: 1, amount: '40.00' });
  assert.deepEqual(excl(res, 'J', 'BAD_DATE'), { prefix: 'J', reason: 'BAD_DATE', rows: 2, documents: 1, amount: '60.00' });
  assert.deepEqual(excl(res, 'J', 'OUT_OF_WINDOW'), { prefix: 'J', reason: 'OUT_OF_WINDOW', rows: 4, documents: 2, amount: '90.00' });
  assert.deepEqual(excl(res, 'J', 'ZERO_AMOUNT'), { prefix: 'J', reason: 'ZERO_AMOUNT', rows: 2, documents: 1, amount: '0.00' });
  assert.deepEqual(excl(res, 'J', 'PUSHED_BY_OTHER'), { prefix: 'J', reason: 'PUSHED_BY_OTHER', rows: 1, documents: 1, amount: '50.00' });
  assert.deepEqual(excl(res, 'J', 'FOOTER'), { prefix: 'J', reason: 'FOOTER', rows: 1, documents: 1, amount: '500.00' });
  assert.deepEqual(excl(res, '(none)', 'FOOTER'), { prefix: '(none)', reason: 'FOOTER', rows: 2, documents: 2, amount: '7.00' });
  assert.equal(r.exclusions.every((e) => EXCLUSION_REASONS.includes(e.reason)), true);

  assert.equal(r.bridge.source_rows, dirtyRows().length);
  assert.equal(r.bridge.emitted_rows, 7);
  assert.equal(r.bridge.excluded_rows, r.exclusions.reduce((n, e) => n + e.rows, 0));
  assert.equal(r.bridge.source_rows, r.bridge.emitted_rows + r.bridge.excluded_rows);
  assert.equal(r.bridge.ties, true);
  assert.equal(r.bridge.table, 'ledger.csv');

  const tx = rowsOf(res.transactionsCsv);
  assert.deepEqual([...new Set(tx.map((x) => x.voucher_id))], ['26/J/95', '26/J/98', '26/J/97', '26/J/96']);
  assert.equal(tx.find((x) => x.voucher_id === '26/J/97').voucher_date, '2026-04-08', 'earliest line date wins');
  assert.equal(tx.find((x) => x.voucher_id === '26/J/95').voucher_date, '2026-04-01');
  assert.equal(tx.find((x) => x.voucher_id === '26/J/96').voucher_date, '2026-07-05');
  assert.deepEqual(r.unbalanced_vouchers, [{ voucher_id: '26/J/98', debit: '50.00', credit: '0.00' }]);
  assert.equal(r.pushers['(blank)'].rows, 2, 'the totals row is a footer, so only the two blank-pusher document rows count');
});

test('exclusion reasons are the documented set', () => {
  assert.deepEqual([...EXCLUSION_REASONS].sort(), ['BAD_DATE', 'FOOTER', 'OUT_OF_WINDOW', 'PUSHED_BY_OTHER', 'PUSHED_BY_UNKNOWN', 'UNKNOWN_PREFIX', 'ZERO_AMOUNT']);
  assert.throws(() => EXCLUSION_REASONS.push('X'), TypeError, 'frozen');
});

// ---------------------------------------------------------------- date damage and repair

/** a ledger as spreadsheet rows: header + one row per ledger line; d_date is a string (text) or { date } (date-typed) */
function xlsxLedger(lines) {
  const rows = [LEDGER_HEAD.map((h) => h)];
  for (const l of lines) {
    rows.push(LEDGER_HEAD.map((h) => {
      if (h === 'c_year') return 26;
      if (h === 'n_tran_no') return Number(l.no);
      if (h === 'Debit') return l.amt > 0 ? l.amt : 0;
      if (h === 'Credit') return l.amt < 0 ? l.amt : 0;
      if (h === 'n_amount') return l.amt;
      if (h === 'd_date') return l.date;
      if (h === 'c_prefix') return l.p;
      if (h === 'c_act_code') return l.code;
      if (h === 'To be pushed by ') return l.by ?? ZOHO;
      if (h === 'Status') return l.status ?? '';
      return '';
    }));
  }
  return buildXlsx([{ name: 'Ledger', rows }]);
}
const xp = (p, no, date, code, amt, extra = {}) => ({ p, no, date, code, amt, ...extra });
const xpair = (p, no, date, a, b, amt, extra = {}) => [xp(p, no, date, a, amt, extra), xp(p, no, date, b, -amt, extra)];

test('date repair: date-typed cells outside the window that fall inside once day and month are swapped are all swapped', () => {
  // Excel read 09/04/26 as September 4 and 12/05/26 as December 5; 20/04/26 could not be read as a date and stayed text
  const lines = [
    ...xpair('J', 1, { date: '2026-09-04' }, 'EXP01', 'BANK01', 300),
    ...xpair('P', 5, { date: '2026-12-05' }, 'EXP01', 'BANK01', 500),
    ...xpair('R', 8, '20/04/26', 'CASH', 'BANK01', 700),
    ...xpair('S', 50, { date: '2026-11-04' }, 'SALES', 'CASH', 90, { by: SMART }),
  ];
  const res = run(baseFiles({ 'ledger.csv': xlsxLedger(lines) }), { ...PROFILE, ledger_file: 'ledger.csv' });
  assert.deepEqual(res.report.date_repair, { date_typed_cells: 6, text_cells: 2, swapped_day_month: true, out_of_window_as_is: 6, out_of_window_swapped: 0 });
  const tx = rowsOf(res.transactionsCsv);
  const dateOf = (id) => [...new Set(tx.filter((r) => r.voucher_id === id).map((r) => r.voucher_date))];
  assert.deepEqual(dateOf('26/J/1'), ['2026-04-09']);
  assert.deepEqual(dateOf('26/P/5'), ['2026-05-12']);
  assert.deepEqual(dateOf('26/R/8'), ['2026-04-20'], 'text dates are parsed as dd/mm/yy and never swapped');
  assert.deepEqual([...new Set(tx.map((r) => r.voucher_id))], ['26/J/1', '26/R/8', '26/P/5'], 'ordered by the repaired dates');
  assert.equal(res.report.bridge.ties, true);
  assert.equal(excl(res, 'J', 'OUT_OF_WINDOW'), undefined);
});

test('date repair: when date-typed cells already fall in the window nothing is swapped, even if the swapped reading is also in the window', () => {
  // 2026-05-06 and 2026-06-05 are both in the window under either reading
  const lines = [
    ...xpair('J', 1, { date: '2026-05-06' }, 'EXP01', 'BANK01', 300),
    ...xpair('P', 5, { date: '2026-06-05' }, 'EXP01', 'BANK01', 500),
    ...xpair('R', 8, '20/04/26', 'CASH', 'BANK01', 700),
  ];
  const res = run(baseFiles({ 'ledger.csv': xlsxLedger(lines) }));
  assert.deepEqual(res.report.date_repair, { date_typed_cells: 4, text_cells: 2, swapped_day_month: false, out_of_window_as_is: 0, out_of_window_swapped: 0 });
  const tx = rowsOf(res.transactionsCsv);
  assert.equal(tx.find((r) => r.voucher_id === '26/J/1').voucher_date, '2026-05-06');
  assert.equal(tx.find((r) => r.voucher_id === '26/P/5').voucher_date, '2026-06-05');
});

test('date repair: not applied when the swapped reading would leave any date-typed cell outside the window (or invalid)', () => {
  // 2026-09-04 would be fixed by a swap, but 2026-05-13 would become the impossible 2026-13-05
  const lines = [
    ...xpair('J', 1, { date: '2026-09-04' }, 'EXP01', 'BANK01', 300),
    ...xpair('P', 5, { date: '2026-05-13' }, 'EXP01', 'BANK01', 500),
  ];
  const res = run(baseFiles({ 'ledger.csv': xlsxLedger(lines) }));
  assert.equal(res.report.date_repair.swapped_day_month, false);
  assert.equal(res.report.date_repair.out_of_window_as_is, 2);
  assert.equal(res.report.date_repair.out_of_window_swapped, 2);
  assert.deepEqual(excl(res, 'J', 'OUT_OF_WINDOW'), { prefix: 'J', reason: 'OUT_OF_WINDOW', rows: 2, documents: 1, amount: '600.00' });
  assert.deepEqual([...new Set(rowsOf(res.transactionsCsv).map((r) => `${r.voucher_id}@${r.voucher_date}`))], ['26/P/5@2026-05-13']);

  // a second guard: the swapped reading of one cell lands outside the window (2026-06-10 -> 2026-10-06)
  const res2 = run(baseFiles({ 'ledger.csv': xlsxLedger([...xpair('J', 1, { date: '2026-09-04' }, 'EXP01', 'BANK01', 300), ...xpair('P', 5, { date: '2026-06-10' }, 'EXP01', 'BANK01', 500)]) }));
  assert.equal(res2.report.date_repair.swapped_day_month, false);
});

test('date repair: text-only dates are never touched, and text dates outside the window are simply OUT_OF_WINDOW', () => {
  const lines = [...xpair('J', 1, '09/09/26', 'EXP01', 'BANK01', 300), ...xpair('P', 5, '10/04/26', 'EXP01', 'BANK01', 500)];
  const res = run(baseFiles({ 'ledger.csv': xlsxLedger(lines) }));
  assert.deepEqual(res.report.date_repair, { date_typed_cells: 0, text_cells: 4, swapped_day_month: false, out_of_window_as_is: 0, out_of_window_swapped: 0 });
  assert.equal(excl(res, 'J', 'OUT_OF_WINDOW').rows, 2);
  assert.equal(res.report.output.vouchers, 1);
});

// ---------------------------------------------------------------- spreadsheet inputs

function sheetRowsFromCsvText(text, numeric) {
  const { header, rows } = parseCsv(text);
  return [header, ...rows].map((cells, ri) => cells.map((c, ci) => {
    if (c === '') return null;
    if (ri > 0 && numeric.includes(header[ci])) return Number(c.replace(/,/g, ''));
    return c;
  }));
}

test('the same population read from .xlsx files (shared strings, numbers, single-quoted XML, deflate) gives identical output to the CSV delivery', () => {
  const csv = run();
  const ledgerRows = sheetRowsFromCsvText(ledgerCsv(baseRows()), ['c_year', 'n_tran_no', 'n_amount', 'Debit', 'Credit']);
  const tbNumeric = ['Op.Debit', 'Op.Credit', 'Tran. Debit', 'Tran. Credit', 'Cl.Debit', 'Cl.Credit', 'Sub Total', 'Total'];
  const tbSheet = (accounts) => {
    // title rows have fewer cells in a real workbook; the reader pads them
    const rows = tbCells(accounts).map((cells, i) => (i < 3 ? [cells[0] || null] : cells));
    const header = TB_HEAD;
    return rows.map((cells, ri) => cells.map((c, ci) => {
      if (c === '' || c === null) return null;
      if (ri > 3 && tbNumeric.includes(header[ci])) return Number(c);
      return c;
    }));
  };
  const files = {
    'ledger.xlsx': buildXlsx([{ name: 'Ledger', rows: ledgerRows }, { name: 'Ignored', rows: [['x']] }], { quote: "'" }),
    'closing_tb.xlsx': buildXlsx([{ name: 'TB', rows: tbSheet(ACCOUNTS) }], { deflate: true }),
    'opening_tb.xlsx': buildXlsx([{ name: 'TB', rows: tbSheet(openingAccounts()) }]),
  };
  const profile = { ...PROFILE, ledger_file: 'ledger.xlsx', closing_tb_file: 'closing_tb.xlsx', opening_tb_file: 'opening_tb.xlsx' };
  const res = run(files, profile);
  assert.equal(res.transactionsCsv, csv.transactionsCsv);
  assert.equal(res.trialBalanceCsv, csv.trialBalanceCsv);
  assert.equal(res.componentsCsv, csv.componentsCsv);
  assert.equal(res.report.trial_balance_ties.all, true);
  assert.deepEqual(res.report.opening_differences, []);
  assert.equal(res.report.bridge.table, 'ledger.xlsx');
  assert.deepEqual(res.report.date_repair, { date_typed_cells: 0, text_cells: 13, swapped_day_month: false, out_of_window_as_is: 0, out_of_window_swapped: 0 });
});

test('mixed delivery: an .xlsx ledger with CSV trial balances works, and inputs are recognised by content, not file name', () => {
  const lines = [...xpair('J', 1, '05/04/26', 'EXP01', 'BANK01', 300)];
  const res = run({ ...baseFiles(), 'ledger.csv': xlsxLedger(lines) });
  assert.equal(res.report.output.vouchers, 1);
});

test('the shipped example profile is valid and normalises a sample delivery (CSV bytes under the .xlsx names it expects)', () => {
  assert.equal(EXAMPLE.format, 'ledger-table');
  assert.equal(EXAMPLE.branch_code, 'PILOT01');
  const named = { 'ledger.xlsx': baseFiles()['ledger.csv'], 'closing_tb.xlsx': baseFiles()['closing_tb.csv'], 'opening_tb.xlsx': baseFiles()['opening_tb.csv'] };
  const res = run(named, EXAMPLE);
  assert.equal(validateManifest(res.manifest).ok, true);
  assert.equal(res.report.output.vouchers, 4);
  assert.equal(res.report.trial_balance_ties.all, true);
  assert.equal(res.report.bridge.ties, true);
});

// ---------------------------------------------------------------- trial balance

test('trial balance: contract opening = Eco Green opening + the other pusher\'s movement; period is the GROSS of our lines; closing is Eco Green\'s', () => {
  const res = run();
  assert.deepEqual(Object.keys(rowsOf(res.trialBalanceCsv)[0]), TRIAL_BALANCE_COLUMNS);
  const tb = byLedger(res.trialBalanceCsv);
  const row = (c) => [tb[c].opening_debit, tb[c].opening_credit, tb[c].period_debit, tb[c].period_credit, tb[c].closing_debit, tb[c].closing_credit, tb[c].txn_count];
  assert.deepEqual(Object.keys(tb), ['BANK01', 'CAP', 'CASH', 'CUSCTL', 'EXP01', 'SALES', 'SUPCTL']);
  assert.deepEqual(row('BANK01'), ['5000.00', '0.00', '100.00', '800.00', '4300.00', '0.00', '3']);
  assert.deepEqual(row('CASH'), ['1000.00', '0.00', '700.00', '100.00', '1600.00', '0.00', '2']);
  // customer control: opening 3000 + Smartpharma's 1000 debit; our 700 credit is the period
  assert.deepEqual(row('CUSCTL'), ['4000.00', '0.00', '0.00', '700.00', '3300.00', '0.00', '1']);
  // supplier control: opening 2000 credit + Smartpharma's 400 credit = 2400; our 500 debit
  assert.deepEqual(row('SUPCTL'), ['0.00', '2400.00', '500.00', '0.00', '0.00', '1900.00', '1']);
  assert.deepEqual(row('EXP01'), ['400.00', '0.00', '300.00', '0.00', '700.00', '0.00', '1']);
  assert.deepEqual(row('SALES'), ['0.00', '1000.00', '0.00', '0.00', '0.00', '1000.00', '0']);
  assert.deepEqual(row('CAP'), ['0.00', '7000.00', '0.00', '0.00', '0.00', '7000.00', '0']);
  // opening + period debit - period credit = closing on every ledger (what Layer A relies on)
  for (const r of Object.values(tb)) {
    const open = parseMoney(r.opening_debit) - parseMoney(r.opening_credit);
    const close = parseMoney(r.closing_debit) - parseMoney(r.closing_credit);
    assert.equal(open + parseMoney(r.period_debit) - parseMoney(r.period_credit), close, r.ledger_code);
  }
  assert.equal(tb.BANK01.ledger_name, 'Bank Account');
  assert.equal(tb.BANK01.branch_code, 'PILOT01');
  // group-heading rows and the grand-total row are not ledgers
  assert.equal(Object.keys(tb).some((c) => /assets|total|liabilities/i.test(c) || /assets|total/i.test(tb[c].ledger_name)), false);
});

test('trial_balance_components.csv: the three-way proof per ledger, signed (debit positive), with ties', () => {
  const res = run();
  assert.deepEqual(Object.keys(rowsOf(res.componentsCsv)[0]), ['ledger_code', 'ledger_name', 'opening', 'movement_other_pusher', 'movement_ours', 'closing', 'closing_report_movement', 'difference', 'in_trial_balance', 'ties']);
  const c = byLedger(res.componentsCsv);
  const v = (code) => { const r = c[code]; return [r.opening, r.movement_other_pusher, r.movement_ours, r.closing, r.closing_report_movement, r.difference, r.in_trial_balance, r.ties]; };
  assert.deepEqual(v('BANK01'), ['5000.00', '0.00', '-700.00', '4300.00', '-700.00', '0.00', 'YES', 'YES']);
  assert.deepEqual(v('CASH'), ['1000.00', '0.00', '600.00', '1600.00', '600.00', '0.00', 'YES', 'YES']);
  assert.deepEqual(v('CUSCTL'), ['3000.00', '1000.00', '-700.00', '3300.00', '300.00', '0.00', 'YES', 'YES']);
  assert.deepEqual(v('SUPCTL'), ['-2000.00', '-400.00', '500.00', '-1900.00', '100.00', '0.00', 'YES', 'YES']);
  assert.deepEqual(v('EXP01'), ['0.00', '400.00', '300.00', '700.00', '700.00', '0.00', 'YES', 'YES']);
  assert.deepEqual(v('SALES'), ['0.00', '-1000.00', '0.00', '-1000.00', '-1000.00', '0.00', 'YES', 'YES']);
  assert.deepEqual(v('CAP'), ['-7000.00', '0.00', '0.00', '-7000.00', '0.00', '0.00', 'YES', 'YES']);
  assert.equal(c.SUPCTL.ledger_name, AP);
  assert.deepEqual(res.report.trial_balance_ties, { all: true, ledgers: 7, failing: [] });
  // the closing column total of the components is a balanced trial balance
  assert.equal(sum(Object.values(c).map((r) => parseMoney(r.closing))), 0n);
});

test('an inconsistent trial balance makes trial_balance_ties.all false and lists the ledger', () => {
  const skewed = ACCOUNTS.map((a) => (a[0] === 'BANK01' ? ['BANK01', a[1], a[2], a[3], [4400, 0]] : a));
  const res = run(baseFiles({ 'closing_tb.csv': tbCsv(skewed) }));
  assert.equal(res.report.trial_balance_ties.all, false);
  assert.deepEqual(res.report.trial_balance_ties.failing, [{ ledger_code: 'BANK01', ledger_name: 'Bank Account', difference: '-100.00', in_trial_balance: 'YES' }]);
  const c = byLedger(res.componentsCsv);
  assert.equal(c.BANK01.ties, 'NO');
  assert.equal(c.BANK01.difference, '-100.00', 'opening + movement - closing');
  assert.equal(c.CASH.ties, 'YES');
  // the contract rows still carry the Eco Green closing, so Layer A will flag it
  assert.equal(byLedger(res.trialBalanceCsv).BANK01.closing_debit, '4400.00');
});

test('a ledger whose report movement disagrees with the table fails the tie even when opening + movement = closing', () => {
  // closing report says CASH moved +650 (debit 650) although the table's rows net +600; closing kept consistent with the table
  const skewed = ACCOUNTS.map((a) => (a[0] === 'CASH' ? ['CASH', a[1], a[2], [650, 0], a[4]] : a));
  const res = run(baseFiles({ 'closing_tb.csv': tbCsv(skewed) }));
  const c = byLedger(res.componentsCsv);
  assert.equal(c.CASH.difference, '0.00');
  assert.equal(c.CASH.closing_report_movement, '650.00');
  assert.equal(c.CASH.ties, 'NO');
  assert.equal(res.report.trial_balance_ties.all, false);
});

test('opening_differences lists codes where the 31 March closing differs from the 1 April opening, and is empty without an opening file', () => {
  const prior = openingAccounts().map((a) => (a[0] === 'EXP01' ? ['EXP01', a[1], a[2], [0, 0], [250, 0]] : a));
  prior.push(['OLD01', 'Retired Ledger', [0, 0], [0, 0], [40, 0]]);
  const res = run(baseFiles({ 'opening_tb.csv': tbCsv(prior) }));
  const diffs = [...res.report.opening_differences].sort((a, b) => (a.ledger_code < b.ledger_code ? -1 : 1));
  assert.deepEqual(diffs, [
    { ledger_code: 'EXP01', ledger_name: 'Office Expenses', closing_31_march: '250.00', opening_1_april: '0.00' },
    { ledger_code: 'OLD01', ledger_name: 'Retired Ledger', closing_31_march: '40.00', opening_1_april: '0.00' },
  ]);

  const { 'opening_tb.csv': _omit, ...noOpening } = baseFiles();
  assert.deepEqual(run(noOpening).report.opening_differences, []);
  assert.deepEqual(run().report.opening_differences, []);
});

test('duplicate Act Code rows in the trial balance are merged (summed) per code', () => {
  const split = [];
  for (const a of ACCOUNTS) {
    if (a[0] !== 'CASH') { split.push(a); continue; }
    split.push(['CASH', 'Cash in Hand', [600, 0], [700, 0], [1300, 0]]);
    split.push(['CASH', 'Cash in Hand', [400, 0], [0, 100], [300, 0]]);
  }
  const res = run(baseFiles({ 'closing_tb.csv': tbCsv(split) }));
  assert.equal(res.trialBalanceCsv, run().trialBalanceCsv);
  assert.equal(res.componentsCsv, run().componentsCsv);
  assert.equal(res.report.trial_balance_ties.all, true);
  assert.equal(rowsOf(res.trialBalanceCsv).filter((r) => r.ledger_code === 'CASH').length, 1);
});

test('a trial balance without title rows, and amounts with thousands separators, parse the same', () => {
  const noTitles = run(baseFiles({ 'closing_tb.csv': tbCsv(ACCOUNTS, { titles: false }) }));
  assert.equal(noTitles.trialBalanceCsv, run().trialBalanceCsv);
  const text = tbCsv().replace('0.00,7000.00,0.00,0.00,0.00,7000.00', '0.00,"7,000.00",0.00,0.00,0.00,"7,000.00"');
  assert.notEqual(text, tbCsv());
  assert.equal(run(baseFiles({ 'closing_tb.csv': text })).trialBalanceCsv, run().trialBalanceCsv);
});

// ---------------------------------------------------------------- manifest and determinism

test('manifest: validates, and file hashes, row counts and totals match the emitted CSVs', () => {
  const res = run();
  const m = res.manifest;
  assert.equal(validateManifest(m).ok, true, JSON.stringify(validateManifest(m).errors));
  assert.equal(m.source_system, 'ECO_GREEN');
  assert.equal(m.branch_code, 'PILOT01');
  assert.equal(m.from_date, '2026-04-01');
  assert.equal(m.to_date, '2026-07-05');
  assert.equal(m.currency, 'INR');
  assert.equal(m.extracted_at, PROFILE.extracted_at);
  assert.equal(m.query_version, 'v1');
  const [tx, tb] = m.files;
  assert.equal(tx.file_role, 'TRANSACTIONS');
  assert.equal(tb.file_role, 'TRIAL_BALANCE');
  assert.equal(tx.sha256, sha256Text(res.transactionsCsv));
  assert.equal(tb.sha256, sha256Text(res.trialBalanceCsv));
  const txRows = rowsOf(res.transactionsCsv);
  const tbRows = rowsOf(res.trialBalanceCsv);
  assert.equal(tx.row_count, txRows.length);
  assert.equal(tb.row_count, tbRows.length);
  assert.equal(tx.debit_total, formatMoney(sum(txRows.map((r) => parseMoney(r.debit)))));
  assert.equal(tx.credit_total, formatMoney(sum(txRows.map((r) => parseMoney(r.credit)))));
  assert.equal(tb.debit_total, formatMoney(sum(tbRows.map((r) => parseMoney(r.closing_debit)))));
  assert.equal(tb.credit_total, formatMoney(sum(tbRows.map((r) => parseMoney(r.closing_credit)))));
  assert.equal(tb.debit_total, '9900.00');
  assert.equal(tb.credit_total, '9900.00');
  assert.equal(sha256Bytes(Buffer.from(res.transactionsCsv)), tx.sha256);
});

test('run id and manifest are deterministic; the id changes with any input byte or the profile; extraction_run_id and extracted_at can be set', () => {
  const a = run(); const b = run();
  assert.equal(JSON.stringify(a.manifest), JSON.stringify(b.manifest));
  assert.match(a.manifest.extraction_run_id, /^PILOT01-2026-04-01-2026-07-05-ledger-[0-9a-f]{8}$/);
  assert.match(a.manifest.sql_hash, /^sha256:[0-9a-f]{64}$/);

  const reordered = { 'opening_tb.csv': baseFiles()['opening_tb.csv'], 'closing_tb.csv': baseFiles()['closing_tb.csv'], 'ledger.csv': baseFiles()['ledger.csv'] };
  assert.equal(run(reordered).manifest.extraction_run_id, a.manifest.extraction_run_id, 'file order does not matter');
  const asBuffers = Object.fromEntries(Object.entries(baseFiles()).map(([k, v]) => [k, Buffer.from(v)]));
  assert.equal(run(asBuffers).manifest.extraction_run_id, a.manifest.extraction_run_id, 'text and Buffer inputs hash the same');

  const changed = run(baseFiles({ 'ledger.csv': baseFiles()['ledger.csv'].replace('Vendor One', 'Vendor Uno') }));
  assert.notEqual(changed.manifest.extraction_run_id, a.manifest.extraction_run_id);
  assert.notEqual(run(baseFiles(), { ...PROFILE, profile_version: 'v2' }).manifest.extraction_run_id, a.manifest.extraction_run_id);
  assert.equal(run(baseFiles(), { ...PROFILE, extraction_run_id: 'RUN-FIXED-1' }).manifest.extraction_run_id, 'RUN-FIXED-1');

  const { extracted_at: _drop, ...noStamp } = PROFILE;
  assert.equal(run(baseFiles(), noStamp).manifest.extracted_at, '2026-07-06T00:00:00Z', 'now() supplies extracted_at');
  const wall = normaliseLedgerTable({ files: baseFiles(), profile: noStamp });
  assert.match(wall.manifest.extracted_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(a.manifest.query_name, /ledger table/i);
});

// ---------------------------------------------------------------- errors

test('INVALID_PROFILE: every missing or bad field is reported together', () => {
  const files = baseFiles();
  for (const bad of [undefined, null, {}]) {
    assert.throws(() => normaliseLedgerTable({ files, profile: bad }), (e) => e instanceof NormaliseError && e.code === 'INVALID_PROFILE'
      && ['branch_code', 'from_date', 'to_date', 'prefix_types'].every((f) => e.message.includes(`${f} is required`)));
  }
  const bad = (patch, re) => assert.throws(() => run(files, { ...PROFILE, ...patch }), (e) => e.code === 'INVALID_PROFILE' && re.test(e.message), JSON.stringify(patch));
  bad({ branch_code: '' }, /branch_code is required/);
  bad({ from_date: '01/04/2026' }, /from_date must be YYYY-MM-DD/);
  bad({ to_date: '2026-02-30' }, /to_date must be YYYY-MM-DD/);
  bad({ from_date: '2026-08-01' }, /from_date is after to_date/);
  bad({ prefix_types: { ...PROFILE.prefix_types, Q: 'SETTLEMENT' } }, /prefix_types\.Q: unknown voucher type SETTLEMENT/);
  const { prefix_types: _p, ...noPrefixes } = PROFILE;
  assert.throws(() => run(files, noPrefixes), (e) => e.code === 'INVALID_PROFILE' && /prefix_types is required/.test(e.message) && !/branch_code is required/.test(e.message));
});

test('MISSING_FILE: the ledger table and the closing trial balance are required; the opening trial balance is optional', () => {
  const { 'ledger.csv': _l, ...noLedger } = baseFiles();
  assert.throws(() => run(noLedger), (e) => e.code === 'MISSING_FILE' && /ledger\.csv \(ledger table\) is required/.test(e.message));
  const { 'closing_tb.csv': _c, ...noClosing } = baseFiles();
  assert.throws(() => run(noClosing), (e) => e.code === 'MISSING_FILE' && /closing_tb\.csv \(trial balance\) is required/.test(e.message));
  const { 'opening_tb.csv': _o, ...noOpening } = baseFiles();
  assert.doesNotThrow(() => run(noOpening));
  assert.throws(() => run({}), (e) => e.code === 'MISSING_FILE');
  // default file names apply when the profile does not name them
  const { ledger_file: _a, closing_tb_file: _b, opening_tb_file: _d, ...noNames } = PROFILE;
  const res = run({ 'ledger.xlsx': baseFiles()['ledger.csv'], 'closing_tb.xlsx': baseFiles()['closing_tb.csv'] }, noNames);
  assert.equal(res.report.output.vouchers, 4);
  assert.deepEqual(res.report.opening_differences, []);
});

test('HEADER_MISMATCH: missing ledger or trial-balance columns, or no header row at all', () => {
  const files = baseFiles();
  const noPush = LEDGER_HEAD.filter((h) => h !== 'To be pushed by ');
  assert.throws(() => run({ ...files, 'ledger.csv': ledgerCsv(baseRows(), noPush) }), (e) => e.code === 'HEADER_MISMATCH' && /ledger\.csv: missing column\(s\) To be pushed by/.test(e.message));
  assert.throws(() => run({ ...files, 'ledger.csv': ledgerCsv(baseRows(), LEDGER_HEAD.filter((h) => h !== 'Status' && h !== 'Credit')) }), (e) => e.code === 'HEADER_MISMATCH' && /Credit, Status/.test(e.message));
  assert.throws(() => run({ ...files, 'ledger.csv': 'a,b,c\n1,2,3\n' }), (e) => e.code === 'HEADER_MISMATCH' && /header row not found/.test(e.message));
  assert.throws(() => run({ ...files, 'closing_tb.csv': 'Act Code,Description\nX,Y\n' }), (e) => e.code === 'HEADER_MISMATCH' && /closing_tb\.csv: header row not found/.test(e.message));
  const noOp = tbCsv().replace('Op.Debit', 'Opening Dr');
  assert.throws(() => run({ ...files, 'closing_tb.csv': noOp }), (e) => e.code === 'HEADER_MISMATCH' && /missing column\(s\) Op\.Debit/.test(e.message));
  assert.throws(() => run({ ...files, 'opening_tb.csv': 'Act Code,Description\nX,Y\n' }), (e) => e.code === 'HEADER_MISMATCH' && /opening_tb\.csv/.test(e.message));
  // the header may have stray spaces ("To be pushed by " as delivered)
  assert.ok(LEDGER_COLUMNS.includes('To be pushed by'));
  assert.deepEqual(TB_COLUMNS.slice(0, 2), ['Act Code', 'Description']);
});

test('MONEY_PARSE: a non-amount or sub-paisa value stops the run, naming the file, column and document', () => {
  const rows = baseRows();
  rows[0].Debit = 'abc';
  assert.throws(() => run(baseFiles({ 'ledger.csv': ledgerCsv(rows) })), (e) => e instanceof NormaliseError && e.code === 'MONEY_PARSE' && /ledger\.csv 26\/J\/1: Debit="abc" is not an amount/.test(e.message));
  const rows2 = baseRows();
  rows2[1].Credit = '-12.345';
  assert.throws(() => run(baseFiles({ 'ledger.csv': ledgerCsv(rows2) })), (e) => e.code === 'MONEY_PARSE' && /Credit="-12\.345"/.test(e.message));
  const tb = tbCsv().replace('4300.00', '43x0.00');
  assert.throws(() => run(baseFiles({ 'closing_tb.csv': tb })), (e) => e.code === 'MONEY_PARSE' && /closing_tb\.csv BANK01: Cl\.Debit/.test(e.message));
  // blank amounts are zero
  const blank = baseRows(); blank[12].Debit = ''; blank[12].Credit = '';
  assert.doesNotThrow(() => run(baseFiles({ 'ledger.csv': ledgerCsv(blank) })));
});

test('XLSX_PARSE and UNKNOWN_ENCODING: unreadable inputs are reported as NormaliseErrors naming the file', () => {
  const brokenXlsx = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('this is not really a workbook')]);
  assert.throws(() => run(baseFiles({ 'ledger.csv': brokenXlsx })), (e) => e instanceof NormaliseError && e.code === 'XLSX_PARSE' && /^ledger\.csv: /.test(e.message));
  const noWorkbook = zip([{ name: 'readme.txt', data: 'hello' }]);
  assert.throws(() => run(baseFiles({ 'closing_tb.csv': noWorkbook })), (e) => e.code === 'XLSX_PARSE' && /closing_tb\.csv: xl\/workbook\.xml missing/.test(e.message));
  assert.throws(() => run(baseFiles({ 'ledger.csv': Buffer.from([0xc3, 0x28, 0x2c, 0x41]) })), (e) => e.code === 'UNKNOWN_ENCODING' && /ledger\.csv/.test(e.message));
});

test('CSV input: a UTF-8 BOM is tolerated; a ragged row is rejected as CSV_PARSE', () => {
  const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(baseFiles()['ledger.csv'])]);
  assert.equal(run(baseFiles({ 'ledger.csv': bom })).transactionsCsv, run().transactionsCsv);
  const ragged = `${baseFiles()['closing_tb.csv']}extra,row\n`;
  assert.throws(() => run(baseFiles({ 'closing_tb.csv': ragged })), (e) => e.code === 'CSV_PARSE');
});

// ---------------------------------------------------------------- through the pipeline

function makeInbox(filesByRef) {
  return {
    async readFile(inboxRef, fileName) {
      const buf = filesByRef[inboxRef]?.[fileName];
      if (!buf) throw new Error(`no such file: ${inboxRef}/${fileName}`);
      return buf;
    },
    async markPicked() {},
    async listRuns() { return []; },
  };
}
function makeArchive() {
  const bytesByUri = new Map();
  return {
    async put({ runId, branchCode, fileName, bytes, sha256 }) {
      const uri = `local://${branchCode}/${runId}/${sha256 ?? sha256Bytes(bytes)}/${fileName}`;
      bytesByUri.set(uri, bytes);
      return uri;
    },
    async exists(uri) { return bytesByUri.has(uri); },
    async get(uri) { return bytesByUri.get(uri); },
  };
}

async function ingestResult(res) {
  const inboxRef = `PILOT01/${res.manifest.extraction_run_id}`;
  const inbox = makeInbox({
    [inboxRef]: {
      'manifest.json': Buffer.from(JSON.stringify(res.manifest)),
      'transactions.csv': Buffer.from(res.transactionsCsv, 'utf8'),
      'trial_balance.csv': Buffer.from(res.trialBalanceCsv, 'utf8'),
    },
  });
  const store = await openStore();
  const audit = createAudit(store);
  const ctx = { store, audit, correlationId: 'corr-eco-ledger', actor: 'tester', actorRole: 'operator' };
  const result = await ingestRun(ctx, { inbox, archive: makeArchive(), inboxRef, workerId: 'worker-1' });
  return { store, ctx, result, runId: res.manifest.extraction_run_id };
}

test('end to end: ingestRun accepts the ledger-table output, stages every voucher, and Layer A passes on the consistent set', async () => {
  const res = run();
  const { store, ctx, result, runId } = await ingestResult(res);
  try {
    assert.equal(result.outcome, 'STAGED', JSON.stringify(result.errors ?? result));
    assert.equal(result.counts.txnRowsLoaded, 8);
    assert.equal(result.counts.txnRowsSkipped, 0);
    assert.equal(result.counts.vouchersBuilt, 4);
    assert.equal(result.counts.vouchersBlocked, 0);
    const vouchers = await store.find('vouchers', { extraction_run_id: runId });
    assert.equal(vouchers.length, 4);
    for (const v of vouchers) assert.equal(v.is_balanced, 1);

    const run1 = await store.get('extraction_runs', runId);
    assert.equal(run1.status, 'STAGED');
    const layerA = await runLayerAStage(ctx, { runId, run: run1 });
    assert.equal(layerA.reconAStatus, 'PASS', JSON.stringify(layerA.failing));
    assert.deepEqual(layerA.failing, []);
    assert.ok(layerA.controls.length > 0);
  } finally {
    await store.close();
  }
});

test('end to end: an inconsistent trial balance is caught by Layer A (the run stages, the reconciliation fails on that ledger)', async () => {
  const skewed = ACCOUNTS.map((a) => (a[0] === 'BANK01' ? ['BANK01', a[1], a[2], a[3], [4400, 0]] : a));
  const res = run(baseFiles({ 'closing_tb.csv': tbCsv(skewed) }));
  assert.equal(res.report.trial_balance_ties.all, false);
  const { store, ctx, result, runId } = await ingestResult(res);
  try {
    assert.equal(result.outcome, 'STAGED', JSON.stringify(result.errors ?? result));
    const layerA = await runLayerAStage(ctx, { runId, run: await store.get('extraction_runs', runId) });
    assert.equal(layerA.reconAStatus, 'FAIL');
    assert.ok(layerA.failing.some((c) => JSON.stringify(c).includes('BANK01')), JSON.stringify(layerA.failing.map((f) => f.control_key)));
  } finally {
    await store.close();
  }
});

// ---------------------------------------------------------------- CLI dispatch

async function withTempDirs(fn, { files = baseFiles(), profile = PROFILE } = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'eg-ledger-table-'));
  try {
    const inDir = path.join(base, 'in');
    const outRoot = path.join(base, 'out');
    await fs.mkdir(inDir);
    for (const [name, content] of Object.entries(files)) await fs.writeFile(path.join(inDir, name), content);
    await fs.writeFile(path.join(inDir, 'notes.txt'), 'ignored: not csv/xlsx');
    const profilePath = path.join(base, 'profile.json');
    await fs.writeFile(profilePath, JSON.stringify(profile));
    return await fn({ base, inDir, outRoot, profilePath });
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
}

test('runNormalise: a ledger-table profile writes manifest, transactions, trial balance, components and report (no allocations.csv)', () => withTempDirs(async ({ inDir, outRoot, profilePath }) => {
  const { runDir, report } = await runNormalise({ inDir, profilePath, outRoot });
  const manifest = JSON.parse(await fs.readFile(path.join(runDir, 'manifest.json'), 'utf8'));
  assert.equal(runDir, path.join(outRoot, 'PILOT01', manifest.extraction_run_id));
  assert.deepEqual((await fs.readdir(runDir)).sort(), ['manifest.json', 'normalisation_report.json', 'transactions.csv', 'trial_balance.csv', 'trial_balance_components.csv']);
  assert.equal(validateManifest(manifest).ok, true);
  for (const f of manifest.files) {
    const bytes = await fs.readFile(path.join(runDir, f.file_name));
    assert.equal(sha256Bytes(bytes), f.sha256, f.file_name);
    assert.equal(parseCsv(bytes.toString('utf8')).rows.length, f.row_count, f.file_name);
  }
  const written = JSON.parse(await fs.readFile(path.join(runDir, 'normalisation_report.json'), 'utf8'));
  assert.deepEqual(written, JSON.parse(JSON.stringify(report)));
  assert.equal(written.output.vouchers, 4);
  assert.equal(written.trial_balance_ties.all, true);
  assert.equal(await fs.readFile(path.join(runDir, 'trial_balance_components.csv'), 'utf8'), run().componentsCsv);
  assert.equal(written.inputs.some((i) => i.startsWith('notes.txt')), false, 'only csv/xlsx files are read');
  assert.equal(manifest.extraction_run_id, run().manifest.extraction_run_id, 'same inputs give the same run id as the library call');
}));

test('runNormalise: .xlsx files on disk are read as Buffers (binary safe)', () => withTempDirs(async ({ inDir, outRoot, profilePath }) => {
  const { report } = await runNormalise({ inDir, profilePath, outRoot });
  assert.equal(report.output.vouchers, 1);
  assert.equal(report.bridge.table, 'ledger.xlsx');
}, {
  files: {
    'ledger.xlsx': xlsxLedger(xpair('J', 1, '05/04/26', 'EXP01', 'BANK01', 300)),
    'closing_tb.xlsx': buildXlsx([{ name: 'TB', rows: tbCells(ACCOUNTS).map((r, i) => (i < 3 ? [r[0] || null] : r.map((c, ci) => (c !== '' && i > 3 && ci > 1 ? Number(c) : (c === '' ? null : c))))) }]),
  },
  profile: { ...PROFILE, ledger_file: 'ledger.xlsx', closing_tb_file: 'closing_tb.xlsx', opening_tb_file: 'opening_tb.xlsx' },
}));

test('CLI: a ledger-table profile succeeds and prints the summary; a normalisation error exits 1 with its code', () => withTempDirs(async ({ inDir, outRoot, profilePath }) => {
  const script = path.join(ROOT, 'scripts', 'normalise-ecogreen.js');
  const ok = spawnSync(process.execPath, [script, '--in', inDir, '--profile', profilePath, '--out', outRoot], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /run folder: /);
  const summary = JSON.parse(ok.stdout.slice(ok.stdout.indexOf('{')));
  assert.equal(summary.output.vouchers, 4);
  assert.equal(summary.bridge.ties, true);
  assert.deepEqual(summary.trial_balance_ties, { all: true, failing: 0 });
  assert.equal(summary.date_repair.swapped_day_month, false);
  assert.equal(summary.unknown_controls, 0);
  assert.equal(summary.unbalanced_vouchers, 0);

  await fs.rm(path.join(inDir, 'closing_tb.csv'));
  const bad = spawnSync(process.execPath, [script, '--in', inDir, '--profile', profilePath, '--out', outRoot], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /^MISSING_FILE: closing_tb\.csv \(trial balance\) is required/);
}));
