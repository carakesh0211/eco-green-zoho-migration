// Eco Green raw-extract normaliser (src/sources/ecogreen/normalise.js, scripts/normalise-ecogreen.js).
// Every value below is synthetic: branch PILOT01, parties V9000x / H9000x, accounts CASH / BANK01 / EXP01.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  normaliseEcoGreen, parseSourceDate, cleanCode, NormaliseError,
  EXCLUSION_REASONS, TB_INPUT_COLUMNS, DEFAULT_SIMPLE_TABLES,
} from '../src/sources/ecogreen/normalise.js';
import { assertSafeOutput, runNormalise } from '../scripts/normalise-ecogreen.js';
import { parseCsv } from '../src/core/csv.js';
import { parseMoney, formatMoney, sum } from '../src/core/money.js';
import { sha256Bytes, sha256Text } from '../src/core/hash.js';
import { validateManifest, validateHeader, TRANSACTIONS_COLUMNS, TRIAL_BALANCE_COLUMNS } from '../src/core/manifest.js';
import { openStore } from '../src/adapters/store/memory.js';
import { createAudit } from '../src/core/audit.js';
import { ingestRun } from '../src/core/ingest.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------- fixtures

const PROFILE = {
  profile_version: 'v1',
  branch_code: 'PILOT01',
  from_date: '2026-04-01',
  to_date: '2026-05-31',
  extracted_at: '2026-06-01T00:00:00+05:30',
  in_scope_prefixes: { J: 'JOURNAL', P: 'PAYMENT', R: 'RECEIPT', X: 'CONTRA', E: 'SETTLEMENT' },
  excluded_prefixes: ['A'],
  hold_prefixes: ['JT'],
  cash_accounts: ['CASH'],
  party_controls: [
    { control: 'CTRL-AP', name: 'AP control', party_type: 'VENDOR', party_prefixes: ['V'], tb_groups: ['Supplier Balance'] },
    { control: 'CTRL-AR', name: 'AR control', party_type: 'CUSTOMER', party_prefixes: ['H'], tb_groups: ['Customer Balance', 'Branch Balance'] },
  ],
};

const cell = (v) => (/[",\n\r]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));

/** Raw table text from a header, per-row defaults and row overrides. */
function table(header, defaults, rows) {
  const lines = [header.join(',')];
  for (const r of rows) {
    const o = { ...defaults, ...r };
    lines.push(header.map((h) => cell(o[h] ?? '')).join(','));
  }
  return `${lines.join('\n')}\n`;
}

const JV_HEAD = ['c_br_code', 'c_year', 'c_prefix', 'n_srno', 'n_seq', 'c_act_code', 'n_credit', 'n_debit', 'd_date', 'c_ref_br_code', 'n_cancel_flag', 'c_remark'];
const JV_DEF = { c_br_code: 'PILOT01', c_year: '26', c_prefix: 'J', n_srno: '1', n_seq: '1', c_act_code: 'EXP01', n_credit: '0.00', n_debit: '0.00', d_date: '05/04/26', c_ref_br_code: 'PILOT01', n_cancel_flag: '0', c_remark: '' };
const jv = (rows) => table(JV_HEAD, JV_DEF, rows);

const SP_HEAD = ['c_br_code', 'c_year', 'c_prefix', 'n_srno', 'c_ref_br_code', 'c_inv_year', 'c_inv_prefix', 'n_inv_no', 'n_amount', 'd_date', 'c_supp_code', 'n_cancel_flag', 'c_opp_act_code', 'c_chq_no'];
const SP_DEF = { c_br_code: 'PILOT01', c_year: '26', c_prefix: 'P', n_srno: '5', c_ref_br_code: 'PILOT01', c_inv_year: '26', c_inv_prefix: 'PI', n_inv_no: '101', n_amount: '0.00', d_date: '10/04/26', c_supp_code: 'V90001', n_cancel_flag: '0', c_opp_act_code: 'BANK01', c_chq_no: '' };
const sp = (rows) => table(SP_HEAD, SP_DEF, rows);

const SET_HEAD = ['c_br_code', 'c_year', 'c_prefix', 'n_srno', 'c_ref_br_code', 'c_inv_year', 'c_inv_prefix', 'n_inv_no', 'n_amount', 'd_date', 'c_cust_code', 'n_cancel_flag'];
const SET_DEF = { c_br_code: 'PILOT01', c_year: '26', c_prefix: 'E', n_srno: '1', c_ref_br_code: 'PILOT01', c_inv_year: '26', c_inv_prefix: 'SI', n_inv_no: '201', n_amount: '0.00', d_date: '12/04/26', c_cust_code: 'H90001', n_cancel_flag: '0' };
const st = (rows) => table(SET_HEAD, SET_DEF, rows);

const SIMPLE_BASE = ['c_br_code', 'c_year', 'c_prefix', 'n_srno', 'd_date', 'c_remark', 'c_chq_no'];
const SIMPLE_DEF = { c_br_code: 'PILOT01', c_year: '26', c_prefix: 'P', n_srno: '7', d_date: '15/04/26', c_remark: '', c_chq_no: '' };
const simple = (cols, rows) => table([...SIMPLE_BASE, ...cols], SIMPLE_DEF, rows);
const PAYMENT_COLS = ['c_act_code', 'c_credit_act_code', 'n_total', 'n_cgst_amt', 'n_sgst_amt'];
const RECEIPT_COLS = ['c_debit_act_code', 'c_act_code', 'n_total'];
const OPP_COLS = ['c_act_code', 'c_opp_act_code', 'n_total'];

const TB_DEF = { name: '', top: 'Asset', group: 'Misc', opdr: '0.00', opcr: '0.00', trdr: '0.00', trcr: '0.00', cldr: '0.00', clcr: '0.00' };
const tbTable = (rows) => table(TB_INPUT_COLUMNS, TB_DEF, rows);

/** Standard small trial balance: plain ledgers plus two control groups. */
function standardTb() {
  return tbTable([
    { code: 'CASH', name: 'Cash in Hand', group: 'Cash' },
    { code: 'BANK01', name: 'Bank Account One', group: 'Bank' },
    { code: 'EXP01', name: 'TB Expense Name', top: 'Expense', group: 'Expense' },
    { code: 'SUPCTL', name: 'Supplier Control Raw', top: 'Liability', group: 'Supplier Balance', opcr: '100.00', clcr: '100.00' },
    { code: 'CUSTCTL', name: 'Customer Control Raw', group: 'Customer Balance', opdr: '50.00', cldr: '50.00' },
  ]);
}

/** A complete synthetic branch extract touching every table the normaliser reads. */
function fullRawSet() {
  return {
    'jv_det.csv': jv([
      { n_srno: '1', n_seq: '1', c_act_code: 'EXP01', n_debit: '100.00', d_date: '05/04/26' },
      { n_srno: '1', n_seq: '2', c_act_code: 'BANK01', n_credit: '100.00', d_date: '05/04/26' },
      { n_srno: '2', n_seq: '1', c_act_code: 'V90001', n_debit: '40.00', d_date: '20/05/26' },
      { n_srno: '2', n_seq: '2', c_act_code: 'H90001', n_credit: '40.00', d_date: '20/05/26' },
    ]),
    'supp_pay_det.csv': sp([
      { n_srno: '5', n_inv_no: '101', n_amount: '500.00', c_supp_code: 'V90001', c_opp_act_code: 'BANK01', c_chq_no: '000123' },
      { n_srno: '5', n_inv_no: '102', n_amount: '300.00', c_supp_code: 'V90002', c_opp_act_code: 'CASH' },
    ]),
    'payment.csv': simple(PAYMENT_COLS, [{ n_srno: '7', c_act_code: 'EXP01', c_credit_act_code: 'CASH', n_total: '250.00' }]),
    'receipt.csv': simple(RECEIPT_COLS, [{ c_prefix: 'R', n_srno: '8', c_debit_act_code: 'BANK01', c_act_code: 'H90001', n_total: '75.00' }]),
    'cash_depo.csv': simple(OPP_COLS, [{ c_prefix: 'X', n_srno: '9', c_act_code: 'BANK01', c_opp_act_code: 'CASH', n_total: '60.00' }]),
    'cash_with.csv': simple(OPP_COLS, []),
    'set_det.csv': st([{ n_srno: '1', n_amount: '75.00' }]),
    'jv_act.csv': 'c_code,c_name\nEXP01,Synthetic Expense\n',
    'tb.csv': standardTb(),
  };
}

const run = (files, profile = PROFILE, now) => normaliseEcoGreen({ files, profile, now });

function rowsOf(text) {
  const { header, rows } = parseCsv(text);
  return rows.map((cells) => Object.fromEntries(header.map((h, i) => [h, cells[i]])));
}
const linesOf = (res, voucherId) => rowsOf(res.transactionsCsv).filter((r) => r.voucher_id === voucherId);
const shape = (rows) => rows.map((r) => [r.ledger_code, r.party_code, r.debit, r.credit]);
const bridgeOf = (res, tableName) => res.report.bridge.find((b) => b.table === tableName);
const excl = (res, tableName, prefix, reason) => res.report.exclusions.find((e) => e.table === tableName && e.prefix === prefix && e.reason === reason);

// ---------------------------------------------------------------- helpers: parse / clean

test('parseSourceDate: dd/mm/yy (with optional time) to ISO, everything else null', () => {
  assert.equal(parseSourceDate('05/04/26'), '2026-04-05');
  assert.equal(parseSourceDate(' 31/12/26 '), '2026-12-31');
  assert.equal(parseSourceDate('05/04/26 10:30:00'), '2026-04-05');
  assert.equal(parseSourceDate('29/02/28'), '2028-02-29');
  assert.equal(parseSourceDate('29/02/26'), null);
  assert.equal(parseSourceDate('31/02/26'), null);
  assert.equal(parseSourceDate('05/04/2026'), null, 'four-digit years are not the source format');
  assert.equal(parseSourceDate('2026-04-05'), null);
  assert.equal(parseSourceDate('5/4/26'), null);
  assert.equal(parseSourceDate(''), null);
  assert.equal(parseSourceDate(undefined), null);
  assert.equal(parseSourceDate(null), null);
});

test('cleanCode: trims and strips one leading apostrophe', () => {
  assert.equal(cleanCode("'V90001"), 'V90001');
  assert.equal(cleanCode("  'EXP01 "), 'EXP01');
  assert.equal(cleanCode('CASH'), 'CASH');
  assert.equal(cleanCode(undefined), '');
  assert.equal(cleanCode(null), '');
});

test('exports: exclusion reasons and column constants have the documented shape', () => {
  assert.equal(EXCLUSION_REASONS.length, 10);
  assert.ok(Object.isFrozen(EXCLUSION_REASONS));
  assert.deepEqual(TB_INPUT_COLUMNS, ['code', 'name', 'top', 'group', 'opdr', 'opcr', 'trdr', 'trcr', 'cldr', 'clcr']);
  assert.deepEqual(DEFAULT_SIMPLE_TABLES.map((t) => t.file), ['payment.csv', 'receipt.csv', 'cash_depo.csv', 'cash_with.csv', 'bank_to_bank.csv', 'b2b.csv']);
  assert.equal(new NormaliseError('X', 'm').code, 'X');
});

// ---------------------------------------------------------------- exclusions and the bridge

test('exclusions: every reason is exercised, counted once per row, and the bridge ties for every table', () => {
  const files = {
    'tb.csv': standardTb(),
    'jv_det.csv': jv([
      { n_srno: '1', n_seq: '1', c_act_code: 'EXP01', n_debit: '10.00' },
      { n_srno: '1', n_seq: '2', c_act_code: 'BANK01', n_credit: '10.00' },
      { n_srno: '11', c_ref_br_code: 'OTHER01', n_debit: '11.00' },
      { n_srno: '12', n_seq: '1', n_cancel_flag: '1', n_debit: '12.00' },
      { n_srno: '12', n_seq: '2', n_cancel_flag: '1', n_credit: '12.00' },
      { n_srno: '13', c_prefix: 'A', n_debit: '13.00' },
      { n_srno: '14', c_prefix: 'JT', n_debit: '14.00' },
      { n_srno: '15', c_prefix: 'ZZ', n_debit: '15.00' },
      { n_srno: '16', d_date: '31/02/26', n_debit: '16.00' },
      { n_srno: '17', d_date: '31/03/26', n_debit: '17.00' },
      { n_srno: '18', d_date: '01/06/26', n_debit: '18.00' },
      { n_srno: '19', n_debit: '0.00', n_credit: '0.00' },
      { n_srno: '20', c_prefix: 'E', n_debit: '20.00' }, // SETTLEMENT prefix in jv_det: currently counted as UNKNOWN_PREFIX
    ]),
    'payment.csv': simple(PAYMENT_COLS, [
      { n_srno: '30', c_act_code: 'EXP01', c_credit_act_code: 'BANK01', n_total: '30.00', n_cgst_amt: '0.00' },
      { n_srno: '31', c_act_code: 'EXP01', c_credit_act_code: 'BANK01', n_total: '31.00', n_cgst_amt: '2.79', n_sgst_amt: '2.79' },
    ]),
  };
  const res = run(files);

  assert.deepEqual(new Set(res.report.exclusions.map((e) => e.reason)), new Set(EXCLUSION_REASONS), 'all ten reasons appear');
  assert.deepEqual(excl(res, 'jv_det.csv', 'J', 'OTHER_BRANCH'), { table: 'jv_det.csv', prefix: 'J', reason: 'OTHER_BRANCH', rows: 1, documents: 1, amount: '11.00' });
  assert.deepEqual(excl(res, 'jv_det.csv', 'J', 'CANCELLED'), { table: 'jv_det.csv', prefix: 'J', reason: 'CANCELLED', rows: 2, documents: 1, amount: '24.00' });
  assert.equal(excl(res, 'jv_det.csv', 'A', 'EXCLUDED_INVENTORY').rows, 1);
  assert.equal(excl(res, 'jv_det.csv', 'JT', 'ON_HOLD').rows, 1);
  assert.equal(excl(res, 'jv_det.csv', 'ZZ', 'UNKNOWN_PREFIX').amount, '15.00');
  assert.equal(excl(res, 'jv_det.csv', 'J', 'BAD_DATE').amount, '16.00');
  assert.equal(excl(res, 'jv_det.csv', 'J', 'BEFORE_WINDOW').amount, '17.00');
  assert.equal(excl(res, 'jv_det.csv', 'J', 'AFTER_WINDOW').amount, '18.00');
  assert.equal(excl(res, 'jv_det.csv', 'J', 'ZERO_AMOUNT').rows, 1);
  assert.equal(excl(res, 'payment.csv', 'P', 'UNSUPPORTED_GST_SPLIT').amount, '31.00');

  // known quirk, left as is: a prefix mapped to SETTLEMENT inside jv_det is reported as UNKNOWN_PREFIX
  assert.equal(excl(res, 'jv_det.csv', 'E', 'UNKNOWN_PREFIX').rows, 1);

  // only the two clean documents were emitted
  assert.deepEqual([...new Set(rowsOf(res.transactionsCsv).map((r) => r.voucher_id))].sort(), ['PILOT01/26/J/1', 'PILOT01/26/P/30']);

  for (const b of res.report.bridge) assert.equal(b.ties, true, `${b.table} ties`);
  assert.deepEqual(bridgeOf(res, 'jv_det.csv'), { table: 'jv_det.csv', source_rows: 13, emitted_rows: 2, excluded_rows: 11, ties: true });
  assert.deepEqual(bridgeOf(res, 'payment.csv'), { table: 'payment.csv', source_rows: 2, emitted_rows: 1, excluded_rows: 1, ties: true });
});

test('exclusions: supplier-payment and settlement tables also bridge (other branch, cancelled, zero amount)', () => {
  const res = run({
    'tb.csv': standardTb(),
    'supp_pay_det.csv': sp([
      { n_srno: '5', n_inv_no: '101', n_amount: '500.00' },
      { n_srno: '6', n_inv_no: '102', n_amount: '0.00' },
      { n_srno: '7', n_inv_no: '103', n_amount: '70.00', n_cancel_flag: '1' },
      { n_srno: '8', n_inv_no: '104', n_amount: '80.00', c_ref_br_code: 'OTHER01' },
    ]),
    'set_det.csv': st([
      { n_srno: '1', n_amount: '75.00' },
      { n_srno: '2', n_amount: '20.00', c_ref_br_code: 'OTHER01' },
      { n_srno: '3', n_amount: '30.00', c_prefix: 'ZZ' },
      { n_srno: '4', n_amount: '40.00', d_date: '01/06/26' },
    ]),
  });
  assert.equal(excl(res, 'supp_pay_det.csv', 'P', 'ZERO_AMOUNT').rows, 1);
  assert.equal(excl(res, 'supp_pay_det.csv', 'P', 'CANCELLED').amount, '70.00');
  assert.equal(excl(res, 'supp_pay_det.csv', 'P', 'OTHER_BRANCH').amount, '80.00');
  assert.equal(excl(res, 'set_det.csv', 'E', 'OTHER_BRANCH').rows, 1);
  assert.equal(excl(res, 'set_det.csv', 'ZZ', 'UNKNOWN_PREFIX').rows, 1);
  assert.equal(excl(res, 'set_det.csv', 'E', 'AFTER_WINDOW').rows, 1);
  assert.deepEqual(bridgeOf(res, 'supp_pay_det.csv'), { table: 'supp_pay_det.csv', source_rows: 4, emitted_rows: 1, excluded_rows: 3, ties: true });
  assert.deepEqual(bridgeOf(res, 'set_det.csv'), { table: 'set_det.csv', source_rows: 4, emitted_rows: 1, excluded_rows: 3, ties: true });
  for (const b of res.report.bridge) assert.equal(b.ties, true);
});

test('window: from_date and to_date are both inclusive', () => {
  const res = run({
    'tb.csv': standardTb(),
    'jv_det.csv': jv([
      { n_srno: '1', n_seq: '1', c_act_code: 'EXP01', n_debit: '1.00', d_date: '01/04/26' },
      { n_srno: '1', n_seq: '2', c_act_code: 'BANK01', n_credit: '1.00', d_date: '01/04/26' },
      { n_srno: '2', n_seq: '1', c_act_code: 'EXP01', n_debit: '2.00', d_date: '31/05/26' },
      { n_srno: '2', n_seq: '2', c_act_code: 'BANK01', n_credit: '2.00', d_date: '31/05/26' },
      { n_srno: '3', n_seq: '1', c_act_code: 'EXP01', n_debit: '3.00', d_date: '31/03/26' },
      { n_srno: '3', n_seq: '2', c_act_code: 'BANK01', n_credit: '3.00', d_date: '31/03/26' },
      { n_srno: '4', n_seq: '1', c_act_code: 'EXP01', n_debit: '4.00', d_date: '01/06/26' },
      { n_srno: '4', n_seq: '2', c_act_code: 'BANK01', n_credit: '4.00', d_date: '01/06/26' },
    ]),
  });
  const tx = rowsOf(res.transactionsCsv);
  assert.deepEqual([...new Set(tx.map((r) => r.voucher_date))], ['2026-04-01', '2026-05-31']);
  assert.equal(tx.length, 4);
  assert.equal(excl(res, 'jv_det.csv', 'J', 'BEFORE_WINDOW').rows, 2);
  assert.equal(excl(res, 'jv_det.csv', 'J', 'AFTER_WINDOW').rows, 2);
  assert.equal(bridgeOf(res, 'jv_det.csv').ties, true);
});

// ---------------------------------------------------------------- journals

test('journals: party codes roll to controls, control-group TB codes roll up, unknown ledger is reported, names resolve', () => {
  const res = run({
    'tb.csv': standardTb(),
    'jv_act.csv': table(['c_code', 'c_name'], {}, [
      { c_code: "'V90001", c_name: 'Synthetic Vendor One' },
      { c_code: 'EXP01', c_name: 'Synthetic Expense Account' },
      { c_code: 'H90001', c_name: 'Synthetic Customer One' },
    ]),
    // written out of n_seq order on purpose
    'jv_det.csv': jv([
      { n_srno: '2', n_seq: '3', c_act_code: 'H90001', n_credit: '60.00', d_date: '06/04/26' },
      { n_srno: '2', n_seq: '1', c_act_code: 'V90001', n_debit: '100.00', d_date: '06/04/26' },
      { n_srno: '2', n_seq: '5', c_act_code: 'ZZLEDGER', n_credit: '20.00', d_date: '06/04/26' },
      { n_srno: '2', n_seq: '2', c_act_code: "'EXP01", n_debit: '20.00', d_date: '06/04/26', c_remark: 'Synthetic note' },
      { n_srno: '2', n_seq: '4', c_act_code: 'SUPCTL', n_credit: '40.00', d_date: '06/04/26' },
    ]),
  });
  const lines = linesOf(res, 'PILOT01/26/J/2');
  assert.deepEqual(lines.map((l) => l.line_no), ['1', '2', '3', '4', '5']);
  assert.deepEqual(shape(lines), [
    ['CTRL-AP', 'V90001', '100.00', '0.00'],
    ['EXP01', '', '20.00', '0.00'],
    ['CTRL-AR', 'H90001', '0.00', '60.00'],
    ['CTRL-AP', '', '0.00', '40.00'], // TB code in a control group rolls to the control, no party
    ['ZZLEDGER', '', '0.00', '20.00'],
  ]);
  assert.equal(lines[0].ledger_name, 'AP control');
  assert.equal(lines[0].party_name, 'Synthetic Vendor One', 'leading apostrophe stripped from jv_act code too');
  assert.equal(lines[1].ledger_name, 'Synthetic Expense Account', 'jv_act name wins over the TB name');
  assert.equal(lines[1].narration, 'Synthetic note');
  assert.equal(lines[2].ledger_name, 'AR control');
  assert.equal(lines[2].party_name, 'Synthetic Customer One');
  assert.equal(lines[4].ledger_name, '');
  for (const l of lines) {
    assert.equal(l.voucher_type, 'JOURNAL');
    assert.equal(l.voucher_no, l.voucher_id);
    assert.equal(l.branch_code, 'PILOT01');
  }
  assert.deepEqual(res.report.unknown_ledgers, [{ ledger_code: 'ZZLEDGER', lines: 1 }]);
  assert.deepEqual(res.report.unbalanced_vouchers, []);
});

test('journals: TB name is the fallback ledger name when no jv_act.csv is supplied', () => {
  const res = run({
    'tb.csv': standardTb(),
    'jv_det.csv': jv([
      { n_srno: '1', n_seq: '1', c_act_code: 'EXP01', n_debit: '5.00' },
      { n_srno: '1', n_seq: '2', c_act_code: 'CASH', n_credit: '5.00' },
    ]),
  });
  assert.deepEqual(linesOf(res, 'PILOT01/26/J/1').map((l) => l.ledger_name), ['TB Expense Name', 'Cash in Hand']);
});

test('journals: a negative amount flips side, both sides on one row are netted, exactly one side is non-zero', () => {
  const res = run({
    'tb.csv': standardTb(),
    'jv_det.csv': jv([
      { n_srno: '3', n_seq: '1', c_act_code: 'BANK01', n_debit: '-50.00', d_date: '07/04/26' },
      { n_srno: '3', n_seq: '2', c_act_code: 'EXP01', n_debit: '100.00', n_credit: '30.00', d_date: '07/04/26' },
      { n_srno: '3', n_seq: '3', c_act_code: 'CASH', n_credit: '20.00', d_date: '07/04/26' },
    ]),
  });
  const lines = linesOf(res, 'PILOT01/26/J/3');
  assert.deepEqual(shape(lines), [
    ['BANK01', '', '0.00', '50.00'],
    ['EXP01', '', '70.00', '0.00'],
    ['CASH', '', '0.00', '20.00'],
  ]);
  for (const l of lines) assert.equal((parseMoney(l.debit) !== 0n) !== (parseMoney(l.credit) !== 0n), true);
  assert.deepEqual(res.report.unbalanced_vouchers, []);
});

test('journals: an unbalanced source voucher is still emitted and surfaced in the report', () => {
  const res = run({
    'tb.csv': standardTb(),
    'jv_det.csv': jv([
      { n_srno: '4', n_seq: '1', c_act_code: 'EXP01', n_debit: '100.00' },
      { n_srno: '4', n_seq: '2', c_act_code: 'BANK01', n_credit: '90.00' },
    ]),
  });
  assert.equal(linesOf(res, 'PILOT01/26/J/4').length, 2);
  assert.deepEqual(res.report.unbalanced_vouchers, [{ voucher_id: 'PILOT01/26/J/4', debit: '100.00', credit: '90.00' }]);
});

test('journals: a party code that is itself a TB ledger is not rolled up by pattern', () => {
  // V90009 matches the vendor pattern but is a real TB ledger in a non-control group.
  const tb = tbTable([{ code: 'V90009', name: 'Plain Ledger', group: 'Misc' }, { code: 'BANK01', name: 'Bank', group: 'Bank' }]);
  const res = run({
    'tb.csv': tb,
    'jv_det.csv': jv([
      { n_srno: '1', n_seq: '1', c_act_code: 'V90009', n_debit: '8.00' },
      { n_srno: '1', n_seq: '2', c_act_code: 'BANK01', n_credit: '8.00' },
    ]),
  });
  assert.deepEqual(shape(linesOf(res, 'PILOT01/26/J/1')), [['V90009', '', '8.00', '0.00'], ['BANK01', '', '0.00', '8.00']]);
  assert.deepEqual(res.report.unknown_ledgers, []);
});

// ---------------------------------------------------------------- supplier payments

test('supplier payments: party lines per invoice row, one credit line per opposite account with the net amount', () => {
  const res = run({
    'tb.csv': standardTb(),
    'supp_pay_det.csv': sp([
      { n_srno: '5', n_inv_no: '101', n_amount: '1000.00', c_supp_code: 'V90001', c_opp_act_code: 'BANK01', c_chq_no: '000123' },
      { n_srno: '5', n_inv_no: '102', n_amount: '500.00', c_supp_code: 'V90001', c_opp_act_code: 'BANK01', c_chq_no: '000123' },
      { n_srno: '5', n_inv_no: '103', n_amount: '-200.00', c_supp_code: 'V90002', c_opp_act_code: 'BANK01', c_chq_no: '000123' },
      { n_srno: '5', n_inv_no: '104', n_amount: '300.00', c_supp_code: 'V90002', c_opp_act_code: 'CASH' },
      // net-zero against one account: party lines only, no credit line
      { n_srno: '6', n_inv_no: '201', n_amount: '100.00', c_supp_code: 'V90001', c_opp_act_code: 'BANK01' },
      { n_srno: '6', n_inv_no: '202', n_amount: '-100.00', c_supp_code: 'V90001', c_opp_act_code: 'BANK01' },
    ]),
  });
  const v5 = linesOf(res, 'PILOT01/26/P/5');
  assert.deepEqual(shape(v5), [
    ['CTRL-AP', 'V90001', '1000.00', '0.00'],
    ['CTRL-AP', 'V90001', '500.00', '0.00'],
    ['CTRL-AP', 'V90002', '0.00', '200.00'], // negative row flips to a credit
    ['CTRL-AP', 'V90002', '300.00', '0.00'],
    ['BANK01', '', '0.00', '1300.00'], // 1000 + 500 - 200 net
    ['CASH', '', '0.00', '300.00'],
  ]);
  assert.deepEqual(v5.map((l) => l.reference_no), ['PILOT01/26/PI/101', 'PILOT01/26/PI/102', 'PILOT01/26/PI/103', 'PILOT01/26/PI/104', '000123', '']);
  assert.deepEqual(v5.map((l) => l.payment_method), ['BANK', 'BANK', 'BANK', 'CASH', 'BANK', 'CASH']);
  assert.equal(v5[0].narration, 'Supplier payment against PILOT01/26/PI/101');
  for (const l of v5) assert.equal(l.voucher_type, 'PAYMENT');
  assert.equal(sum(v5.map((l) => parseMoney(l.debit))), sum(v5.map((l) => parseMoney(l.credit))), 'voucher balances');

  const v6 = linesOf(res, 'PILOT01/26/P/6');
  assert.deepEqual(shape(v6), [['CTRL-AP', 'V90001', '100.00', '0.00'], ['CTRL-AP', 'V90001', '0.00', '100.00']]);

  assert.deepEqual(res.report.unbalanced_vouchers, []);
  assert.deepEqual(bridgeOf(res, 'supp_pay_det.csv'), { table: 'supp_pay_det.csv', source_rows: 6, emitted_rows: 6, excluded_rows: 0, ties: true });

  const alloc = rowsOf(res.allocationsCsv);
  assert.equal(alloc.length, 6);
  assert.deepEqual(alloc[0], {
    voucher_id: 'PILOT01/26/P/5', voucher_date: '2026-04-10', source_table: 'supp_pay_det',
    party_code: 'V90001', party_type: 'VENDOR', invoice_ref: 'PILOT01/26/PI/101', amount: '1000.00',
  });
  assert.equal(alloc[2].amount, '-200.00');
  assert.equal(alloc[2].party_code, 'V90002');
  assert.equal(res.report.output.allocations, 6);
});

test('supplier payments: payment_method comes from profile.cash_accounts and defaults to BANK', () => {
  const files = {
    'tb.csv': standardTb(),
    'supp_pay_det.csv': sp([{ n_srno: '5', n_amount: '10.00', c_opp_act_code: 'PETTY1' }]),
  };
  const cash = run(files, { ...PROFILE, cash_accounts: ['PETTY1'] });
  assert.deepEqual(linesOf(cash, 'PILOT01/26/P/5').map((l) => l.payment_method), ['CASH', 'CASH']);
  const bank = run(files, { ...PROFILE, cash_accounts: [] });
  assert.deepEqual(linesOf(bank, 'PILOT01/26/P/5').map((l) => l.payment_method), ['BANK', 'BANK']);
});

// ---------------------------------------------------------------- simple one-row documents

test('simple tables: a header-only file means no documents, not an error', () => {
  const res = run({
    'tb.csv': standardTb(),
    'cash_depo.csv': simple(OPP_COLS, []),
    'b2b.csv': 'c_br_code\n', // not even the columns: still fine when there are no rows
  });
  assert.equal(rowsOf(res.transactionsCsv).length, 0);
  assert.deepEqual(bridgeOf(res, 'cash_depo.csv'), { table: 'cash_depo.csv', source_rows: 0, emitted_rows: 0, excluded_rows: 0, ties: true });
  assert.deepEqual(bridgeOf(res, 'b2b.csv'), { table: 'b2b.csv', source_rows: 0, emitted_rows: 0, excluded_rows: 0, ties: true });
  assert.equal(res.manifest.files[0].row_count, 0);
  assert.equal(res.manifest.files[0].debit_total, '0.00');
});

test('simple tables: a data row becomes a balanced two-line voucher in the default direction', () => {
  const res = run({
    'tb.csv': standardTb(),
    'payment.csv': simple(PAYMENT_COLS, [{ n_srno: '7', c_act_code: 'EXP01', c_credit_act_code: 'BANK01', n_total: '250.00', c_chq_no: 'CHQ001', c_remark: 'Synthetic payment' }]),
    'receipt.csv': simple(RECEIPT_COLS, [{ c_prefix: 'R', n_srno: '8', c_debit_act_code: 'CASH', c_act_code: 'H90001', n_total: '75.00' }]),
    'cash_depo.csv': simple(OPP_COLS, [{ c_prefix: 'X', n_srno: '9', c_act_code: 'BANK01', c_opp_act_code: 'CASH', n_total: '60.00' }]),
  });
  const pay = linesOf(res, 'PILOT01/26/P/7');
  assert.deepEqual(shape(pay), [['EXP01', '', '250.00', '0.00'], ['BANK01', '', '0.00', '250.00']]);
  assert.deepEqual(pay.map((l) => l.payment_method), ['BANK', 'BANK']);
  assert.deepEqual(pay.map((l) => l.reference_no), ['CHQ001', 'CHQ001']);
  assert.equal(pay[0].narration, 'Synthetic payment');
  assert.equal(pay[0].voucher_type, 'PAYMENT');

  const rec = linesOf(res, 'PILOT01/26/R/8');
  assert.deepEqual(shape(rec), [['CASH', '', '75.00', '0.00'], ['CTRL-AR', 'H90001', '0.00', '75.00']]);
  assert.deepEqual(rec.map((l) => l.payment_method), ['CASH', 'CASH'], 'receipt method follows the debit (money-in) account');
  assert.equal(rec[0].voucher_type, 'RECEIPT');

  const contra = linesOf(res, 'PILOT01/26/X/9');
  assert.deepEqual(shape(contra), [['BANK01', '', '60.00', '0.00'], ['CASH', '', '0.00', '60.00']]);
  assert.deepEqual(contra.map((l) => l.payment_method), ['', ''], 'contra carries no payment method');
  assert.equal(contra[0].voucher_type, 'CONTRA');

  assert.deepEqual(res.report.unbalanced_vouchers, []);
  for (const b of res.report.bridge) assert.equal(b.ties, true);
});

test('simple tables: profile.simple_tables overrides direction; a negative amount flips it again', () => {
  const profile = {
    ...PROFILE,
    simple_tables: [{ file: 'cash_depo.csv', debit_col: 'c_opp_act_code', credit_col: 'c_act_code', amount_col: 'n_total' }],
  };
  const files = {
    'tb.csv': standardTb(),
    'cash_depo.csv': simple(OPP_COLS, [
      { c_prefix: 'X', n_srno: '9', c_act_code: 'BANK01', c_opp_act_code: 'CASH', n_total: '60.00' },
      { c_prefix: 'X', n_srno: '10', c_act_code: 'BANK01', c_opp_act_code: 'CASH', n_total: '-5.00' },
    ]),
    // not listed in the override, so it is not read at all
    'payment.csv': simple(PAYMENT_COLS, [{ n_srno: '7', c_act_code: 'EXP01', c_credit_act_code: 'BANK01', n_total: '250.00' }]),
  };
  const res = run(files, profile);
  assert.deepEqual(shape(linesOf(res, 'PILOT01/26/X/9')), [['CASH', '', '60.00', '0.00'], ['BANK01', '', '0.00', '60.00']]);
  assert.deepEqual(shape(linesOf(res, 'PILOT01/26/X/10')), [['BANK01', '', '5.00', '0.00'], ['CASH', '', '0.00', '5.00']]);
  assert.equal(bridgeOf(res, 'payment.csv'), undefined);
});

test('simple tables: payment rows carrying GST amounts are held back, zero GST columns are fine', () => {
  const res = run({
    'tb.csv': standardTb(),
    'payment.csv': simple(PAYMENT_COLS, [
      { n_srno: '7', c_act_code: 'EXP01', c_credit_act_code: 'BANK01', n_total: '100.00', n_cgst_amt: '', n_sgst_amt: '0.00' },
      { n_srno: '8', c_act_code: 'EXP01', c_credit_act_code: 'BANK01', n_total: '118.00', n_sgst_amt: '9.00' },
      { n_srno: '9', c_act_code: 'EXP01', c_credit_act_code: 'BANK01', n_total: '0.00' },
    ]),
  });
  assert.equal(linesOf(res, 'PILOT01/26/P/7').length, 2);
  assert.equal(linesOf(res, 'PILOT01/26/P/8').length, 0);
  assert.equal(excl(res, 'payment.csv', 'P', 'UNSUPPORTED_GST_SPLIT').rows, 1);
  assert.equal(excl(res, 'payment.csv', 'P', 'ZERO_AMOUNT').rows, 1);
  assert.equal(bridgeOf(res, 'payment.csv').ties, true);
});

test('simple tables: a missing required column with data rows throws HEADER_MISMATCH', () => {
  const noOpp = table(['c_br_code', 'c_year', 'c_prefix', 'n_srno', 'd_date', 'c_act_code', 'n_total'], SIMPLE_DEF, [{ c_prefix: 'X', n_srno: '9', c_act_code: 'BANK01', n_total: '60.00' }]);
  assert.throws(
    () => run({ 'tb.csv': standardTb(), 'cash_with.csv': noOpp }),
    (e) => e instanceof NormaliseError && e.code === 'HEADER_MISMATCH' && /cash_with\.csv/.test(e.message) && /c_opp_act_code/.test(e.message),
  );
  // the same file with no data rows is just "no documents"
  const headerOnly = 'c_br_code,c_year,c_prefix,n_srno,d_date,c_act_code,n_total\n';
  assert.doesNotThrow(() => run({ 'tb.csv': standardTb(), 'cash_with.csv': headerOnly }));
});

test('required columns: jv_det, supp_pay_det and set_det reject a header that lacks one, even with no rows', () => {
  for (const [name, text, col] of [
    ['jv_det.csv', 'c_br_code,c_year,c_prefix,n_srno,c_act_code,n_credit,d_date,c_ref_br_code,n_cancel_flag\n', 'n_debit'],
    ['supp_pay_det.csv', 'c_br_code,c_year,c_prefix,n_srno\n', 'c_supp_code'],
    ['set_det.csv', 'c_br_code,c_year,c_prefix,n_srno\n', 'c_cust_code'],
  ]) {
    assert.throws(
      () => run({ 'tb.csv': standardTb(), [name]: text }),
      (e) => e.code === 'HEADER_MISMATCH' && e.message.includes(name) && e.message.includes(col),
      name,
    );
  }
});

test('money: an amount that is not a 2dp number throws MONEY_PARSE naming the document', () => {
  assert.throws(
    () => run({ 'tb.csv': standardTb(), 'jv_det.csv': jv([{ n_srno: '1', c_act_code: 'EXP01', n_debit: 'twelve' }]) }),
    (e) => e.code === 'MONEY_PARSE' && /PILOT01\/26\/J\/1/.test(e.message),
  );
  assert.throws(
    () => run({ 'tb.csv': standardTb(), 'supp_pay_det.csv': sp([{ n_amount: '1.234' }]) }),
    (e) => e.code === 'MONEY_PARSE',
  );
});

// ---------------------------------------------------------------- settlements

test('settlements: set_det produces allocation evidence only, never ledger lines', () => {
  const res = run({
    'tb.csv': standardTb(),
    'set_det.csv': st([
      { n_srno: '1', n_inv_no: '201', n_amount: '75.00', c_cust_code: "'H90001" },
      { n_srno: '1', n_inv_no: '202', n_amount: '25.00', c_cust_code: 'H90002' },
    ]),
  });
  assert.equal(rowsOf(res.transactionsCsv).length, 0);
  assert.equal(res.report.output.vouchers, 0);
  const alloc = rowsOf(res.allocationsCsv);
  assert.deepEqual(alloc, [
    { voucher_id: 'PILOT01/26/E/1', voucher_date: '2026-04-12', source_table: 'set_det', party_code: 'H90001', party_type: 'CUSTOMER', invoice_ref: 'PILOT01/26/SI/201', amount: '75.00' },
    { voucher_id: 'PILOT01/26/E/1', voucher_date: '2026-04-12', source_table: 'set_det', party_code: 'H90002', party_type: 'CUSTOMER', invoice_ref: 'PILOT01/26/SI/202', amount: '25.00' },
  ]);
  assert.deepEqual(bridgeOf(res, 'set_det.csv'), { table: 'set_det.csv', source_rows: 2, emitted_rows: 2, excluded_rows: 0, ties: true });
});

// ---------------------------------------------------------------- trial balance

test('trial balance: control groups collapse to one row, duplicate codes merge, txn_count counts distinct vouchers', () => {
  const tb = tbTable([
    { code: 'CASH', name: 'Cash in Hand', group: 'Cash', opdr: '100.00', trdr: '50.00', trcr: '20.00', cldr: '130.00' },
    { code: 'BANK01', name: 'Bank Account One', group: 'Bank', opdr: '1000.00', trdr: '10.00', cldr: '1010.00' },
    { code: 'BANK01', name: 'Bank Account One (dup)', group: 'Bank', opdr: '25.00', trcr: '5.00', cldr: '20.00' },
    { code: 'EXP01', name: 'Expense One', top: 'Expense', group: 'Expense', trdr: '200.00', cldr: '200.00' },
    { code: 'SUP1', name: 'Supplier One', top: 'Liability', group: 'Supplier Balance', opcr: '300.00', trdr: '40.00', trcr: '10.00', clcr: '270.00' },
    { code: 'SUP2', name: 'Supplier Two', top: 'Liability', group: 'Supplier Balance', opcr: '100.00', clcr: '100.00' },
    { code: 'CUST1', name: 'Customer One', group: 'Customer Balance', opdr: '50.00', cldr: '50.00' },
    { code: 'BRN1', name: 'Branch One', group: 'Branch Balance', opdr: '5.00', trdr: '1.00', cldr: '6.00' },
  ]);
  const res = run({
    'tb.csv': tb,
    'jv_det.csv': jv([
      { n_srno: '1', n_seq: '1', c_act_code: 'EXP01', n_debit: '100.00' },
      { n_srno: '1', n_seq: '2', c_act_code: 'BANK01', n_credit: '100.00' },
      { n_srno: '2', n_seq: '1', c_act_code: 'EXP01', n_debit: '50.00' },
      { n_srno: '2', n_seq: '2', c_act_code: 'BANK01', n_credit: '50.00' },
      // two lines of the same voucher on EXP01 count once; both CTRL-AP lines (party + group code) count once
      { n_srno: '3', n_seq: '1', c_act_code: 'EXP01', n_debit: '30.00' },
      { n_srno: '3', n_seq: '2', c_act_code: 'EXP01', n_debit: '20.00' },
      { n_srno: '3', n_seq: '3', c_act_code: 'BANK01', n_credit: '50.00' },
      { n_srno: '4', n_seq: '1', c_act_code: 'V90001', n_debit: '10.00' },
      { n_srno: '4', n_seq: '2', c_act_code: 'SUP1', n_credit: '10.00' },
    ]),
  });
  const tbOut = Object.fromEntries(rowsOf(res.trialBalanceCsv).map((r) => [r.ledger_code, r]));
  assert.deepEqual(Object.keys(tbOut), ['CASH', 'BANK01', 'EXP01', 'CTRL-AP', 'CTRL-AR'], 'one row per ledger, first-seen order, no SUP*/CUST*/BRN* rows');

  assert.deepEqual(tbOut['CTRL-AP'], {
    branch_code: 'PILOT01', ledger_code: 'CTRL-AP', ledger_name: 'AP control',
    opening_debit: '0.00', opening_credit: '400.00', period_debit: '40.00', period_credit: '10.00',
    closing_debit: '0.00', closing_credit: '370.00', txn_count: '1',
  });
  assert.deepEqual(tbOut['CTRL-AR'], {
    branch_code: 'PILOT01', ledger_code: 'CTRL-AR', ledger_name: 'AR control',
    opening_debit: '55.00', opening_credit: '0.00', period_debit: '1.00', period_credit: '0.00',
    closing_debit: '56.00', closing_credit: '0.00', txn_count: '0',
  });
  assert.deepEqual(tbOut.BANK01, {
    branch_code: 'PILOT01', ledger_code: 'BANK01', ledger_name: 'Bank Account One',
    opening_debit: '1025.00', opening_credit: '0.00', period_debit: '10.00', period_credit: '5.00',
    closing_debit: '1030.00', closing_credit: '0.00', txn_count: '3',
  });
  assert.equal(tbOut.EXP01.txn_count, '3');
  assert.equal(tbOut.CASH.txn_count, '0');
  assert.equal(res.report.output.trial_balance_ledgers, 5);
});

test('trial balance: a missing tb file is MISSING_FILE, a bad amount is MONEY_PARSE, a bad header is HEADER_MISMATCH', () => {
  assert.throws(() => run({ 'jv_det.csv': jv([]) }), (e) => e instanceof NormaliseError && e.code === 'MISSING_FILE' && /tb\.csv/.test(e.message));
  assert.throws(
    () => run({ 'tb.csv': tbTable([{ code: 'CASH', name: 'Cash', opdr: 'abc' }]) }),
    (e) => e.code === 'MONEY_PARSE' && /CASH/.test(e.message) && /opdr/.test(e.message),
  );
  assert.throws(
    () => run({ 'tb.csv': 'code,name,top,group\nCASH,Cash,Asset,Cash\n' }),
    (e) => e.code === 'HEADER_MISMATCH' && /opdr/.test(e.message),
  );
});

test('trial balance: profile.tb_file selects a different file name', () => {
  const res = run({ 'trial.csv': standardTb() }, { ...PROFILE, tb_file: 'trial.csv' });
  assert.equal(res.report.output.trial_balance_ledgers, 5, 'three plain ledgers plus the two control rows');
  assert.throws(() => run({ 'tb.csv': standardTb() }, { ...PROFILE, tb_file: 'trial.csv' }), (e) => e.code === 'MISSING_FILE' && /trial\.csv/.test(e.message));
});

// ---------------------------------------------------------------- input encodings

test('input: Buffers, UTF-8 BOM and an unsupported encoding', () => {
  const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(standardTb(), 'utf8')]);
  const res = run({ 'tb.csv': bom });
  assert.equal(res.report.output.trial_balance_ledgers, 5);
  assert.throws(() => run({ 'tb.csv': Buffer.from([0xff, 0x41, 0x42, 0x0a]) }), (e) => e.code === 'UNKNOWN_ENCODING');
});

// ---------------------------------------------------------------- manifest and determinism

test('manifest: validates against the contract and the declared sha256, counts and totals match the emitted CSV text', () => {
  const res = run(fullRawSet());
  const checked = validateManifest(res.manifest);
  assert.equal(checked.ok, true, JSON.stringify(checked.errors));
  assert.equal(res.manifest.source_system, 'ECO_GREEN');
  assert.equal(res.manifest.branch_code, 'PILOT01');
  assert.equal(res.manifest.currency, 'INR');

  const [txMeta, tbMeta] = res.manifest.files;
  assert.equal(txMeta.file_role, 'TRANSACTIONS');
  assert.equal(tbMeta.file_role, 'TRIAL_BALANCE');

  const tx = rowsOf(res.transactionsCsv);
  assert.equal(validateHeader(parseCsv(res.transactionsCsv).header, TRANSACTIONS_COLUMNS).ok, true);
  assert.equal(txMeta.sha256, sha256Text(res.transactionsCsv));
  assert.equal(txMeta.sha256, sha256Bytes(Buffer.from(res.transactionsCsv, 'utf8')));
  assert.equal(txMeta.row_count, tx.length);
  assert.equal(txMeta.debit_total, formatMoney(sum(tx.map((r) => parseMoney(r.debit)))));
  assert.equal(txMeta.credit_total, formatMoney(sum(tx.map((r) => parseMoney(r.credit)))));
  assert.equal(txMeta.debit_total, txMeta.credit_total, 'the sample extract balances overall');
  assert.equal(txMeta.encoding, 'utf-8');
  assert.equal(txMeta.delimiter, ',');

  const tb = rowsOf(res.trialBalanceCsv);
  assert.equal(validateHeader(parseCsv(res.trialBalanceCsv).header, TRIAL_BALANCE_COLUMNS).ok, true);
  assert.equal(tbMeta.sha256, sha256Text(res.trialBalanceCsv));
  assert.equal(tbMeta.row_count, tb.length);
  assert.equal(tbMeta.debit_total, formatMoney(sum(tb.map((r) => parseMoney(r.closing_debit)))), 'TB totals are the sums of closing_debit / closing_credit');
  assert.equal(tbMeta.credit_total, formatMoney(sum(tb.map((r) => parseMoney(r.closing_credit)))));
  assert.notEqual(tbMeta.debit_total, '0.00');

  assert.equal(res.report.output.lines, tx.length);
  assert.equal(res.report.output.debit_total, txMeta.debit_total);
});

test('manifest: deterministic run id derived from inputs and profile, explicit id wins, extracted_at honours profile then now()', () => {
  const files = fullRawSet();
  const noId = { ...PROFILE };
  const a = run(files, noId);
  assert.match(a.manifest.extraction_run_id, /^PILOT01-2026-04-01-2026-05-31-raw-[0-9a-f]{8}$/);
  assert.equal(run(files, noId).manifest.extraction_run_id, a.manifest.extraction_run_id, 'same inputs, same id');

  const reordered = Object.fromEntries(Object.keys(files).reverse().map((k) => [k, files[k]]));
  assert.equal(run(reordered, noId).manifest.extraction_run_id, a.manifest.extraction_run_id, 'file key order does not matter');

  const changed = { ...files, 'jv_det.csv': files['jv_det.csv'].replace('100.00', '101.00') };
  assert.notEqual(run(changed, noId).manifest.extraction_run_id, a.manifest.extraction_run_id, 'a changed input changes the id');
  assert.notEqual(run(files, { ...noId, to_date: '2026-06-30' }).manifest.extraction_run_id, a.manifest.extraction_run_id, 'a changed profile changes the id');
  assert.match(a.manifest.sql_hash, /^sha256:[0-9a-f]{64}$/);

  assert.equal(run(files, { ...noId, extraction_run_id: 'RUN-FIXED-1' }).manifest.extraction_run_id, 'RUN-FIXED-1');

  assert.equal(a.manifest.extracted_at, '2026-06-01T00:00:00+05:30');
  const noStamp = { ...PROFILE };
  delete noStamp.extracted_at;
  assert.equal(run(files, noStamp, () => '2026-07-01T00:00:00+05:30').manifest.extracted_at, '2026-07-01T00:00:00+05:30');
  assert.equal(run(files, PROFILE, () => 'ignored').manifest.extracted_at, '2026-06-01T00:00:00+05:30');
});

test('determinism: the same inputs give byte-identical outputs, whether given as strings or Buffers', () => {
  const files = fullRawSet();
  const a = run(files);
  const b = run(files);
  assert.equal(a.transactionsCsv, b.transactionsCsv);
  assert.equal(a.trialBalanceCsv, b.trialBalanceCsv);
  assert.equal(a.allocationsCsv, b.allocationsCsv);
  assert.equal(JSON.stringify(a.manifest), JSON.stringify(b.manifest));
  assert.equal(JSON.stringify(a.report), JSON.stringify(b.report));
  const asBuffers = Object.fromEntries(Object.entries(files).map(([k, v]) => [k, Buffer.from(v, 'utf8')]));
  const c = run(asBuffers);
  assert.equal(c.transactionsCsv, a.transactionsCsv);
  assert.equal(JSON.stringify(c.manifest), JSON.stringify(a.manifest));
});

test('output: vouchers are ordered by date then id, with line numbers restarting at 1', () => {
  const res = run(fullRawSet());
  const tx = rowsOf(res.transactionsCsv);
  const ids = [...new Set(tx.map((r) => r.voucher_id))];
  assert.deepEqual(ids, [
    'PILOT01/26/J/1', 'PILOT01/26/P/5', 'PILOT01/26/P/7', 'PILOT01/26/R/8', 'PILOT01/26/X/9', 'PILOT01/26/J/2',
  ]);
  for (const id of ids) {
    assert.deepEqual(tx.filter((r) => r.voucher_id === id).map((r) => Number(r.line_no)), tx.filter((r) => r.voucher_id === id).map((_, i) => i + 1));
  }
  assert.deepEqual(res.report.output.by_type.JOURNAL, { vouchers: 2, lines: 4, debit_total: '140.00' });
  assert.equal(res.report.output.vouchers, 6);
  assert.equal(res.report.output.lines, 14);
  assert.equal(res.report.inputs.length, Object.keys(fullRawSet()).length);
  for (const b of res.report.bridge) assert.equal(b.ties, true, b.table);
});

test('an extract with only a trial balance is a valid, empty run', () => {
  const res = run({ 'tb.csv': standardTb() });
  assert.equal(validateManifest(res.manifest).ok, true);
  assert.equal(res.manifest.files[0].row_count, 0);
  assert.equal(res.manifest.files[1].row_count, 5);
  assert.deepEqual(res.report.bridge, []);
  assert.equal(res.transactionsCsv.trim().split('\n').length, 1, 'header only');
});

test('the shipped example profile is valid and normalises a sample extract', () => {
  return fs.readFile(path.join(ROOT, 'config', 'source-profiles', 'ecogreen.example.json'), 'utf8').then((text) => {
    const profile = JSON.parse(text);
    assert.equal(profile.branch_code, 'PILOT01');
    const res = run(fullRawSet(), profile);
    assert.equal(validateManifest(res.manifest).ok, true);
    assert.equal(res.report.output.vouchers, 6);
    for (const b of res.report.bridge) assert.equal(b.ties, true, b.table);
  });
});

// ---------------------------------------------------------------- profile validation

test('profile: missing fields are reported together as INVALID_PROFILE', () => {
  const files = { 'tb.csv': standardTb() };
  for (const bad of [undefined, null, {}]) {
    assert.throws(() => normaliseEcoGreen({ files, profile: bad }), (e) => e instanceof NormaliseError && e.code === 'INVALID_PROFILE'
      && ['branch_code', 'from_date', 'to_date', 'in_scope_prefixes'].every((f) => e.message.includes(`${f} is required`)));
  }
  const { branch_code: _drop, ...noBranch } = PROFILE;
  assert.throws(() => run(files, noBranch), (e) => e.code === 'INVALID_PROFILE' && /branch_code is required/.test(e.message) && !/from_date is required/.test(e.message));
});

test('profile: bad dates, reversed window, a prefix listed twice, an unknown voucher type, a control without party_type', () => {
  const files = { 'tb.csv': standardTb() };
  const bad = (patch, re) => assert.throws(() => run(files, { ...PROFILE, ...patch }), (e) => e.code === 'INVALID_PROFILE' && re.test(e.message), JSON.stringify(patch));
  bad({ from_date: '01/04/2026' }, /from_date must be YYYY-MM-DD/);
  bad({ to_date: '2026-02-30' }, /to_date must be YYYY-MM-DD/);
  bad({ from_date: '2026-06-01', to_date: '2026-05-31' }, /from_date is after to_date/);
  bad({ excluded_prefixes: ['A', 'J'] }, /prefix J is listed as both in_scope and excluded/);
  bad({ hold_prefixes: ['JT', 'P'] }, /prefix P is listed as both in_scope and hold/);
  bad({ excluded_prefixes: ['A', 'JT'] }, /prefix JT is listed as both excluded and hold/);
  bad({ in_scope_prefixes: { ...PROFILE.in_scope_prefixes, Z: 'PURCHASE_ORDER' } }, /in_scope_prefixes\.Z: unknown voucher type PURCHASE_ORDER/);
  bad({ party_controls: [{ control: 'CTRL-AP' }] }, /party_controls entries need control and party_type/);
});

test('profile: an in-scope SETTLEMENT type is valid, and unconfigured optional lists default to empty', () => {
  const minimal = { branch_code: 'PILOT01', from_date: '2026-04-01', to_date: '2026-04-30', in_scope_prefixes: { J: 'JOURNAL', E: 'SETTLEMENT' } };
  const res = run({ 'tb.csv': standardTb(), 'jv_det.csv': jv([{ n_srno: '1', c_act_code: 'EXP01', n_debit: '1.00' }, { n_srno: '1', n_seq: '2', c_act_code: 'BANK01', n_credit: '1.00' }]) }, minimal, () => '2026-05-01T00:00:00Z');
  assert.equal(validateManifest(res.manifest).ok, true);
  // no party_controls: V/H codes stay as their own ledgers, SUPCTL stays a plain ledger
  assert.equal(res.report.output.trial_balance_ledgers, 5);
});

// ---------------------------------------------------------------- end to end through ingest

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

test('end to end: normaliser output is accepted by ingestRun and stages every voucher', async () => {
  const res = run(fullRawSet());
  const inboxRef = `PILOT01/${res.manifest.extraction_run_id}`;
  const inbox = makeInbox({
    [inboxRef]: {
      'manifest.json': Buffer.from(JSON.stringify(res.manifest)),
      'transactions.csv': Buffer.from(res.transactionsCsv, 'utf8'),
      'trial_balance.csv': Buffer.from(res.trialBalanceCsv, 'utf8'),
    },
  });
  const store = await openStore();
  try {
    const audit = createAudit(store);
    const ctx = { store, audit, correlationId: 'corr-eco-norm', actor: 'tester', actorRole: 'operator' };
    const result = await ingestRun(ctx, { inbox, archive: makeArchive(), inboxRef, workerId: 'worker-1' });
    assert.equal(result.outcome, 'STAGED', JSON.stringify(result.errors ?? result));
    assert.equal(result.counts.txnRowsLoaded, res.report.output.lines);
    assert.equal(result.counts.txnRowsSkipped, 0);
    assert.equal(result.counts.vouchersBuilt, res.report.output.vouchers);
    assert.equal(result.counts.vouchersBuilt, 6);
    assert.equal(result.counts.vouchersBlocked, 0);

    const run1 = await store.get('extraction_runs', res.manifest.extraction_run_id);
    assert.equal(run1.status, 'STAGED');
    const vouchers = await store.find('vouchers', { extraction_run_id: res.manifest.extraction_run_id });
    assert.equal(vouchers.length, 6);
    for (const v of vouchers) assert.equal(v.is_balanced, 1);
  } finally {
    await store.close();
  }
});

// ---------------------------------------------------------------- CLI: assertSafeOutput / runNormalise

test('assertSafeOutput: inside the repository only var/ is allowed', () => {
  for (const bad of [ROOT, path.join(ROOT, 'inbox'), path.join(ROOT, 'config'), path.join(ROOT, 'variant'), path.join(ROOT, 'var', '..', 'src'), path.join(ROOT, 'src', 'var')]) {
    assert.throws(() => assertSafeOutput(bad, ROOT), /refusing to write normalised extracts/, bad);
  }
  for (const ok of [path.join(ROOT, 'var'), path.join(ROOT, 'var', 'x'), path.join(ROOT, 'var', 'inbox', 'PILOT01'), os.tmpdir(), path.join(os.tmpdir(), 'eg-norm-x'), `${ROOT}-sibling`]) {
    assert.doesNotThrow(() => assertSafeOutput(ok, ROOT), ok);
  }
});

test('assertSafeOutput: honours an explicit project root, and the default root is this repository', () => {
  const fakeRoot = path.join(os.tmpdir(), 'eg-fake-root');
  assert.throws(() => assertSafeOutput(path.join(fakeRoot, 'out'), fakeRoot), /only var\//);
  assert.doesNotThrow(() => assertSafeOutput(path.join(fakeRoot, 'var', 'out'), fakeRoot));
  assert.throws(() => assertSafeOutput(path.join(ROOT, 'out')), /only var\//);
  assert.doesNotThrow(() => assertSafeOutput(path.join(ROOT, 'var', 'out')));
});

async function withTempDirs(fn) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'eg-normalise-'));
  try {
    const inDir = path.join(base, 'in');
    const outRoot = path.join(base, 'out');
    await fs.mkdir(inDir);
    const files = fullRawSet();
    for (const [name, text] of Object.entries(files)) await fs.writeFile(path.join(inDir, name), text);
    await fs.writeFile(path.join(inDir, 'notes.txt'), 'not a csv, ignored');
    const profilePath = path.join(base, 'profile.json');
    await fs.writeFile(profilePath, JSON.stringify(PROFILE));
    return await fn({ base, inDir, outRoot, profilePath });
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
}

test('runNormalise: writes the five files under <out>/<branch>/<run-id>, consistent with the manifest', () => withTempDirs(async ({ inDir, outRoot, profilePath }) => {
  const { runDir, report } = await runNormalise({ inDir, profilePath, outRoot });
  const manifest = JSON.parse(await fs.readFile(path.join(runDir, 'manifest.json'), 'utf8'));
  assert.equal(runDir, path.join(outRoot, 'PILOT01', manifest.extraction_run_id));
  assert.deepEqual((await fs.readdir(runDir)).sort(), ['allocations.csv', 'manifest.json', 'normalisation_report.json', 'transactions.csv', 'trial_balance.csv']);
  assert.equal(validateManifest(manifest).ok, true);

  for (const f of manifest.files) {
    const bytes = await fs.readFile(path.join(runDir, f.file_name));
    assert.equal(sha256Bytes(bytes), f.sha256, f.file_name);
    assert.equal(parseCsv(bytes.toString('utf8')).rows.length, f.row_count, f.file_name);
  }
  const written = JSON.parse(await fs.readFile(path.join(runDir, 'normalisation_report.json'), 'utf8'));
  assert.deepEqual(written, JSON.parse(JSON.stringify(report)));
  assert.equal(written.output.vouchers, 6);
  assert.equal(rowsOf(await fs.readFile(path.join(runDir, 'allocations.csv'), 'utf8')).length, 3);
  assert.equal(report.inputs.some((i) => i.startsWith('notes.txt')), false, 'non-csv files are not read');
}));

test('runNormalise: refuses to write inside the repository outside var/, before reading anything', async () => {
  await assert.rejects(
    runNormalise({ inDir: path.join(os.tmpdir(), 'does-not-exist'), profilePath: path.join(os.tmpdir(), 'nope.json'), outRoot: path.join(ROOT, 'inbox-test-do-not-create') }),
    /refusing to write normalised extracts/,
  );
});

test('CLI: usage error exits 2; a normalisation error exits 1 with its code; success prints the run folder', () => withTempDirs(async ({ base, inDir, outRoot, profilePath }) => {
  const script = path.join(ROOT, 'scripts', 'normalise-ecogreen.js');
  const usage = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.equal(usage.status, 2);
  assert.match(usage.stderr, /usage: normalise-ecogreen\.js/);

  await fs.rm(path.join(inDir, 'tb.csv'));
  const failed = spawnSync(process.execPath, [script, '--in', inDir, '--profile', profilePath, '--out', outRoot], { encoding: 'utf8' });
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /^MISSING_FILE:/);

  await fs.writeFile(path.join(inDir, 'tb.csv'), standardTb());
  const ok = spawnSync(process.execPath, [script, '--in', inDir, '--profile', profilePath, '--out', outRoot], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /run folder: /);
  assert.ok(ok.stdout.includes(path.join(base, 'out', 'PILOT01')));
  const summary = JSON.parse(ok.stdout.slice(ok.stdout.indexOf('{')));
  assert.equal(summary.unbalanced_vouchers, 0);
  assert.equal(summary.output.vouchers, 6);

  const unsafe = spawnSync(process.execPath, [script, '--in', inDir, '--profile', profilePath, '--out', path.join(ROOT, 'inbox-test-do-not-create')], { encoding: 'utf8' });
  assert.equal(unsafe.status, 1);
  assert.match(unsafe.stderr, /refusing to write normalised extracts/);
}));
