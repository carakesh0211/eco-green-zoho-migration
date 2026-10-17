#!/usr/bin/env node
// Plan a branch's transaction push for the migration window (nothing talks to Zoho):
//
//   node scripts/txn-plan.js --branch 460 --ledger <Ledger_..._V2.xlsx> --opening var/opening/460/plan.json \
//     --supplier <supplier_payment_details_act.csv> --customer <invoice_receipt_det_act_460.csv> \
//     --from 2026-04-01 --to 2026-07-05 --out var/txn/460 [--account-map accounts.csv] [--excel-dates asis]
//     [--coa <Books chart of accounts export with the "Eco Green Account Code" field>]
//                                    (maps every tagged ledger; --account-map rows override it)
//     [--closing-tb <Closing_tb_report.xlsx>]   (checks the ledger against Eco Green's own TB movement: integrity.csv)
//     [--gl-parties H30066,H58907]   (party codes kept as GL ledgers in Books: their lines post to the
//                                     account map's code, and their opening is on that ledger)
//
// Writes to --out: plan.json, report.md, applications.csv, exceptions.csv and accounts.csv
// (every ledger our postings touch; fill zoho_code and pass it back as --account-map) and
// accounts-all.csv (every ledger in the file, Smart Pharma's too — the reconciliation's map once
// both sides are in Books).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { readXlsx } from '../src/sources/ecogreen/xlsx.js';
import { parseCsv } from '../src/core/csv.js';
import { formatMoney } from '../src/core/money.js';
import {
  readLedgerRows, readSupplierAllocations, coaCrosswalk, readCustomerSettlements, buildTxnPlan, planReport,
} from '../src/txn/plan.js';
import { readClosingTb, ecoIntegrity } from '../src/txn/recon.js';

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error(`unexpected argument ${a}`);
    const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
    opts[a.slice(2)] = v;
  }
  return opts;
}
const need = (o, k) => {
  if (!o[k]) throw new Error(`--${k} is required`);
  return o[k];
};
const csvCell = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const toCsv = (header, rows) => [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\n') + '\n';
const toJson = (v) => JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? formatMoney(x) : x instanceof Set ? [...x] : x), 2);

function readAccountMap(path) {
  const { header, rows } = parseCsv(readFileSync(path, 'utf8'));
  const h = header.map((x) => x.trim().toLowerCase());
  const a = h.indexOf('account');
  const z = h.indexOf('zoho_code');
  if (a < 0 || z < 0) throw new Error(`${path}: needs "account" and "zoho_code" columns`);
  return new Map(rows.filter((r) => r[z]?.trim()).map((r) => [r[a].trim(), r[z].trim()]));
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  const out = need(o, 'out');
  const wb = readXlsx(readFileSync(need(o, 'ledger')));
  const glParties = new Set((o['gl-parties'] ?? '').split(',').map((x) => x.trim()).filter(Boolean));
  const lines = readLedgerRows(wb.sheets[0].rows, { excelDates: o['excel-dates'] ?? 'swapped', glParties });
  // their opening balance is on the GL ledger, not an open item of a customer / vendor
  const isGl = (d) => glParties.has(d.partyCode);
  const openingDocs = (o.opening ? JSON.parse(readFileSync(o.opening, 'utf8')).documents : []).filter((d) => !isGl(d));
  const supplierAlloc = o.supplier ? readSupplierAllocations(readFileSync(o.supplier, 'utf8')) : [];
  const customerSettle = o.customer ? readCustomerSettlements(readFileSync(o.customer, 'utf8')) : [];
  const coa = o.coa ? coaCrosswalk(readFileSync(o.coa, 'utf8')) : null;
  const explicit = o['account-map'] ? readAccountMap(o['account-map']) : new Map();
  const accountMap = coa || o['account-map'] ? new Map([...(coa?.map ?? []), ...explicit]) : null;
  const sourceOf = (a) => (explicit.has(a) ? 'account-map' : coa?.map.has(a) ? 'chart of accounts' : '');

  const plan = buildTxnPlan({
    branch: need(o, 'branch'), lines, supplierAlloc, customerSettle, openingDocs, from: need(o, 'from'), to: need(o, 'to'), accountMap,
  });

  mkdirSync(out, { recursive: true });
  if (o['closing-tb']) {
    // the extract is complete when every TB code's movement equals the ledger's lines (Smart Pharma's too)
    const integrity = ecoIntegrity(lines, readClosingTb(readXlsx(readFileSync(o['closing-tb'])).sheets[0].rows));
    const off = integrity.filter((r) => !r.ok);
    plan.checks.push({
      name: 'ledger ties to the Eco Green closing TB movement', ok: !off.length,
      detail: off.length ? `${off.length} of ${integrity.length} TB codes differ (integrity.csv): ${off.slice(0, 5).map((r) => `${r.code} ${formatMoney(r.diff)}`).join('; ')}` : `${integrity.length} TB codes`,
    });
    writeFileSync(join(out, 'integrity.csv'), toCsv(['tb_code', 'account', 'tb_movement', 'ledger', 'difference', 'ok'], integrity.map((r) => [r.code, r.name, formatMoney(r.tb), formatMoney(r.ledger), formatMoney(r.diff), r.ok])));
  }
  writeFileSync(join(out, 'plan.json'), toJson(plan));
  writeFileSync(join(out, 'report.md'), planReport(plan));
  writeFileSync(join(out, 'applications.csv'), toCsv(
    ['voucher', 'kind', 'date', 'party', 'doc', 'doc_source', 'amount', 'method', 'eco_green_ref'],
    plan.postings.flatMap((p) => (p.applications ?? []).map((a) => [p.key, p.kind, p.date, a.party, a.doc, a.source, formatMoney(a.amount), a.method, a.ref ?? ''])),
  ));
  writeFileSync(join(out, 'exceptions.csv'), toCsv(
    ['type', 'ref', 'doc', 'party', 'amount'],
    [
      ...plan.exceptions.map((e) => [e.type, e.ref, e.doc ?? '', e.party ?? '', e.amount ?? '']),
      ...plan.postings.filter((p) => p.unapplied > 0n).map((p) => [`${p.kind} left unapplied`, p.key, '', p.party.code, formatMoney(p.unapplied)]),
    ],
  ));
  writeFileSync(join(out, 'accounts.csv'), toCsv(
    ['account', 'eco_code', 'name', 'lines', 'zoho_code', 'source'],
    plan.accounts.map((a) => [a.account, a.code, a.name, a.lines, accountMap?.get(a.account) ?? '', sourceOf(a.account)]),
  ));
  const all = new Map();
  for (const l of lines.filter((x) => !x.party)) {
    const a = all.get(l.account) ?? { account: l.account, code: l.code, name: l.name, ours: 0, smartPharma: 0 };
    if (l.owner === 'ZOHO') a.ours += 1; else a.smartPharma += 1;
    all.set(l.account, a);
  }
  writeFileSync(join(out, 'accounts-all.csv'), toCsv(
    ['account', 'eco_code', 'name', 'lines_ours', 'lines_smart_pharma', 'zoho_code'],
    [...all.values()].sort((a, b) => a.account.localeCompare(b.account)).map((a) => [a.account, a.code, a.name, a.ours, a.smartPharma, accountMap?.get(a.account) ?? '']),
  ));
  process.stdout.write(planReport(plan));
  if (coa?.ambiguous.length) process.stdout.write(`\nEco Green codes tagged on more than one Zoho account (decide in --account-map): ${coa.ambiguous.map(([e, z]) => `${e} -> ${z.join('/')}`).join('; ')}\n`);
  if (plan.checks.some((c) => !c.ok)) process.exitCode = 2;
}

main();
