#!/usr/bin/env node
// Closing reconciliation for a branch (see src/txn/recon.js).
//
//   node scripts/txn-recon.js fetch --out var/recon/460 --to 2026-07-05 --location <location id>
//       read only: saves the Books trial balance, customer balances and vendor balances
//   node scripts/txn-recon.js report --out var/recon/460 --to 2026-07-05 --closing-tb <Closing_tb.xlsx> \
//       --ledger <Ledger V2.xlsx> --opening var/opening/460 --txn var/txn/460 [--control-map map.json] [--posted ours|all]
//       [--controls <contacts editpage json>]   (default: controls.json saved by fetch)
//       [--account-map <accounts-all.csv>]      (with --posted all: every ledger, Smart Pharma's too)
//       [--gl-parties H30066,H58907]            (as in the plan: party codes kept as GL ledgers)
//       [--strict-controls]                     (each receivable / payable account must tie on its own:
//                                                production, where contacts carry their group's account)
//       writes recon.md, integrity.csv, tb.csv, parties.csv to --out (no Books calls)
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { readXlsx } from '../src/sources/ecogreen/xlsx.js';
import { parseCsv } from '../src/core/csv.js';
import { formatMoney } from '../src/core/money.js';
import { booksClient, liveConfig, progress } from '../src/books/rest.js';
import { readLedgerRows } from '../src/txn/plan.js';
import {
  readClosingTb, ecoIntegrity, expectedBooks, readBooksTb, compareTb, compareParties, reconReport, controlAccountIds,
} from '../src/txn/recon.js';

function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const opts = {};
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    if (!a.startsWith('--')) throw new Error(`unexpected argument ${a}`);
    opts[a.slice(2)] = rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[++i] : 'true';
  }
  return { cmd, opts };
}
const need = (o, k) => {
  if (!o[k]) throw new Error(`--${k} is required`);
  return o[k];
};
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const csvCell = (v) => {
  const s = v === null || v === undefined ? '' : typeof v === 'bigint' ? formatMoney(v) : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const toCsv = (header, rows) => [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\n') + '\n';

async function cmdFetch(o) {
  const out = need(o, 'out');
  mkdirSync(out, { recursive: true });
  const books = booksClient(liveConfig());
  const q = { to_date: need(o, 'to'), location_id: need(o, 'location') };
  writeFileSync(join(out, 'tb.json'), JSON.stringify(await books.call('GET', '/reports/trialbalance', { query: q }), null, 2));
  // every receivable / payable account (the contact form lists them all)
  writeFileSync(join(out, 'controls.json'), JSON.stringify(await books.call('GET', '/contacts/editpage', { query: { contact_type: 'customer' } }), null, 2));
  for (const [file, path, key] of [['customers.json', '/reports/customerbalances', 'customerbalances'], ['vendors.json', '/reports/vendorbalances', 'vendorbalances']]) {
    const all = [];
    for (let page = 1; ; page += 1) {
      const j = await books.call('GET', path, { query: { ...q, page, per_page: 200 } });
      all.push(...(j[key] ?? []));
      if (!j.page_context?.has_more_page) break;
    }
    writeFileSync(join(out, file), JSON.stringify({ [key]: all }, null, 2));
  }
  progress(`saved tb.json, customers.json, vendors.json to ${out} (${books.usage.calls} Books calls, all GET)`);
  return 0;
}

function readAccountMap(path) {
  const { header, rows } = parseCsv(readFileSync(path, 'utf8'));
  const h = header.map((x) => x.trim().toLowerCase());
  return Object.fromEntries(rows.filter((r) => r[h.indexOf('zoho_code')]?.trim()).map((r) => [r[h.indexOf('account')].trim(), r[h.indexOf('zoho_code')].trim()]));
}

function cmdReport(o) {
  const out = need(o, 'out');
  const txn = need(o, 'txn');
  const openingDir = need(o, 'opening');
  const opening = readJson(join(openingDir, 'plan.json'));
  const glParties = new Set((o['gl-parties'] ?? '').split(',').map((x) => x.trim()).filter(Boolean));
  const lines = readLedgerRows(readXlsx(readFileSync(need(o, 'ledger'))).sheets[0].rows, { glParties });
  const tb = readClosingTb(readXlsx(readFileSync(need(o, 'closing-tb'))).sheets[0].rows);
  const accountMap = readAccountMap(o['account-map'] ?? join(txn, 'accounts_zoho.csv'));
  const groupZoho = new Map(opening.documents.map((d) => [d.controlCode, d.controlZoho]));
  for (const [g, z] of Object.entries(o['control-map'] ? readJson(o['control-map']) : {})) groupZoho.set(g, z);
  const contacts = {
    ...(existsSync(join(openingDir, 'resolution.json')) ? readJson(join(openingDir, 'resolution.json')).contacts : {}),
    ...readJson(join(txn, 'resolution.json')).contacts,
  };
  const posted = (o.posted ?? 'ours') === 'all' ? lines : lines.filter((l) => l.owner === 'ZOHO');

  const integrity = ecoIntegrity(lines, tb);
  const { exp, unmapped } = expectedBooks({ opening, lines: posted, accountMap, groupZoho, glParties });
  const controlsFile = o.controls ?? join(out, 'controls.json');
  if (!existsSync(controlsFile)) throw new Error(`${controlsFile} not found: rerun fetch, or pass --controls <contacts editpage json>`);
  const tbRows = compareTb(exp, readBooksTb(readJson(join(out, 'tb.json'))), new Set(groupZoho.values()), controlAccountIds(readJson(controlsFile)), { strict: o['strict-controls'] === 'true' });
  const parties = compareParties({
    opening: { ...opening, documents: opening.documents.filter((d) => !glParties.has(d.partyCode)) }, posted, all: lines, contacts,
    customers: readJson(join(out, 'customers.json')).customerbalances, vendors: readJson(join(out, 'vendors.json')).vendorbalances,
  });

  writeFileSync(join(out, 'integrity.csv'), toCsv(['tb_code', 'account', 'tb_movement', 'ledger', 'difference', 'ok'], integrity.map((r) => [r.code, r.name, r.tb, r.ledger, r.diff, r.ok])));
  writeFileSync(join(out, 'tb.csv'), toCsv(['zoho_code', 'account', 'expected', 'books', 'difference', 'control_account', 'ok'], tbRows.map((r) => [r.code, r.name, r.expected, r.books, r.diff, r.control, r.ok])));
  writeFileSync(join(out, 'parties.csv'), toCsv(
    ['side', 'code', 'party', 'expected', 'books', 'difference', 'ok', 'books_open_documents', 'books_unused_credits', 'eco_green_closing', 'smart_pharma_part'],
    parties.rows.map((r) => [r.side, r.code, r.name, r.expected, r.books, r.diff, r.ok, r.open, r.credits, r.ecoClosing, r.smartPharma]),
  ));
  const md = reconReport({ branch: opening.branch ?? '', asOf: need(o, 'to'), integrity, tb: tbRows, unmapped, parties });
  writeFileSync(join(out, 'recon.md'), md);
  console.log(md);
  return [integrity, tbRows, parties.rows].some((rows) => rows.some((r) => !r.ok)) || !tbRows.controlGroup.ok ? 2 : 0;
}

const { cmd, opts } = parseArgs(process.argv.slice(2));
const run = { fetch: cmdFetch, report: cmdReport }[cmd];
if (!run) {
  console.error('usage: txn-recon.js fetch|report [options] (see the header of this file)');
  process.exit(64);
}
Promise.resolve()
  .then(() => run(opts))
  .then((code) => process.exit(code ?? 0))
  .catch((err) => {
    console.error(`${cmd}: ${err.message}`);
    process.exit(1);
  });
