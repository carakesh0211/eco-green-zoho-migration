#!/usr/bin/env node
// scripts/build-mapping.js — propose a Zoho Books mapping (MODULE_ROUTE, LEDGER_ACCOUNT, PARTY
// rules) for a normalised run, from Books reference data exported outside the app
// (docs/ECOGREEN_SOURCE.md §Building the Books mapping).
//
//   node scripts/build-mapping.js --run <normalised-run-folder> --books-ref <folder with accounts.json + contacts.json>
//        --org <books org id> --out <folder> [--mapping-version map_test_v1] [--effective-from 2026-04-01]
//        [--threshold 0.8] [--decided-on 2026-10-08]
//
// Writes <out>/{mapping-rules.json, review-accounts.csv, review-contacts.csv, mapping-report.json}.
// The rules are DRAFT suggestions for POST /api/mappings; nothing is approved here. The review
// sheets carry real ledger, party and Books names: inside this repository the output may only go
// under the gitignored var/ directory.
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCsv } from '../src/core/csv.js';
import { isIsoDate } from '../src/core/ids.js';
import {
  proposeAccountMappings, proposeContactMappings, buildRuleRows, reviewCsv,
} from '../src/core/mapping_proposals.js';
import { assertSafeOutput } from './normalise-ecogreen.js';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    args[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  return args;
}

async function readText(file, what) {
  try { return await readFile(file, 'utf8'); } catch (e) {
    throw Object.assign(new Error(`${what} not found or unreadable: ${path.basename(file)}`), { code: 'MISSING_FILE', cause: e });
  }
}

async function readJsonArray(file, what) {
  const data = JSON.parse(await readText(file, what));
  if (!Array.isArray(data)) throw Object.assign(new Error(`${what} must be a JSON array`), { code: 'BAD_INPUT' });
  return data;
}

async function readTable(file, what, required) {
  const { header, rows } = parseCsv(await readText(file, what));
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));
  const missing = required.filter((c) => !(c in idx));
  if (missing.length) throw Object.assign(new Error(`${what} is missing columns: ${missing.join(', ')}`), { code: 'BAD_INPUT' });
  return rows.map((r) => Object.fromEntries(Object.entries(idx).map(([h, i]) => [h, r[i]])));
}

const countBy = (rows) => rows.reduce((acc, r) => { acc[r.status] = (acc[r.status] ?? 0) + 1; return acc; }, {});

/** Distinct ledgers (that appear in transactions) and parties of a normalised run. */
export function collectRunEntities(transactions, trialBalance) {
  const tbNames = new Map();
  for (const t of trialBalance) {
    const code = (t.ledger_code ?? '').trim();
    if (code && !tbNames.has(code) && (t.ledger_name ?? '').trim()) tbNames.set(code, t.ledger_name.trim());
  }
  const ledgers = new Map();
  const parties = new Map();
  const voucherTypes = new Set();
  for (const t of transactions) {
    const code = (t.ledger_code ?? '').trim();
    if (code) {
      const l = ledgers.get(code) ?? { ledger_code: code, ledger_name: tbNames.get(code) ?? '', usage_count: 0 };
      if (!l.ledger_name && (t.ledger_name ?? '').trim()) l.ledger_name = t.ledger_name.trim();
      l.usage_count += 1;
      ledgers.set(code, l);
    }
    const pc = (t.party_code ?? '').trim();
    if (pc) {
      const p = parties.get(pc) ?? { party_code: pc, party_name: '', usage_count: 0, ledger_codes: new Set() };
      if (!p.party_name && (t.party_name ?? '').trim()) p.party_name = t.party_name.trim();
      p.usage_count += 1;
      if (code) p.ledger_codes.add(code);
      parties.set(pc, p);
    }
    const vt = (t.voucher_type ?? '').trim();
    if (vt) voucherTypes.add(vt);
  }
  const byUsage = (a, b) => (b.usage_count - a.usage_count) || (a.ledger_code ?? a.party_code).localeCompare(b.ledger_code ?? b.party_code);
  return {
    ledgers: [...ledgers.values()].sort(byUsage),
    parties: [...parties.values()].map((p) => ({ ...p, ledger_codes: [...p.ledger_codes].sort() })).sort(byUsage),
    voucherTypes: [...voucherTypes].sort(),
    trialBalanceOnlyLedgers: [...tbNames.keys()].filter((c) => !ledgers.has(c)).length,
  };
}

export async function runBuildMapping({
  runDir, booksRefDir, orgId, outDir, mappingVersion = 'map_test_v1', effectiveFrom = '2026-04-01',
  threshold = 0.8, decidedOn, now = () => new Date().toISOString(),
}) {
  if (!runDir || !booksRefDir || !orgId || !outDir) throw Object.assign(new Error('runDir, booksRefDir, orgId and outDir are required'), { code: 'BAD_ARGS' });
  assertSafeOutput(outDir);
  if (!isIsoDate(effectiveFrom)) throw Object.assign(new Error('effective-from must be YYYY-MM-DD'), { code: 'BAD_ARGS' });
  const thr = Number(threshold);
  if (!Number.isFinite(thr) || thr <= 0 || thr > 1) throw Object.assign(new Error('threshold must be a number in (0, 1]'), { code: 'BAD_ARGS' });
  const generatedAt = now();
  const decided = decidedOn ?? generatedAt.slice(0, 10);
  if (!isIsoDate(decided)) throw Object.assign(new Error('decided-on must be YYYY-MM-DD'), { code: 'BAD_ARGS' });

  const transactions = await readTable(path.join(runDir, 'transactions.csv'), 'transactions.csv', ['voucher_type', 'ledger_code', 'ledger_name', 'party_code', 'party_name']);
  const trialBalance = await readTable(path.join(runDir, 'trial_balance.csv'), 'trial_balance.csv', ['ledger_code', 'ledger_name']);
  let manifest = null;
  try { manifest = JSON.parse(await readFile(path.join(runDir, 'manifest.json'), 'utf8')); } catch { /* optional */ }
  const accounts = await readJsonArray(path.join(booksRefDir, 'accounts.json'), 'accounts.json');
  const contacts = await readJsonArray(path.join(booksRefDir, 'contacts.json'), 'contacts.json');

  const entities = collectRunEntities(transactions, trialBalance);
  const accountProposals = proposeAccountMappings({ ledgers: entities.ledgers, accounts, threshold: thr });
  const contactProposals = proposeContactMappings({ parties: entities.parties, contacts, accounts, threshold: thr });
  const rules = buildRuleRows({
    accountProposals, contactProposals, voucherTypes: entities.voucherTypes,
    mappingVersion, effectiveFrom, booksOrgId: orgId, decidedOn: decided,
  });

  const rulesByType = rules.reduce((acc, r) => { acc[r.rule_type] = (acc[r.rule_type] ?? 0) + 1; return acc; }, {});
  const report = {
    run_id: manifest?.extraction_run_id ?? null,
    books_org_id: orgId,
    mapping_version: mappingVersion,
    effective_from: effectiveFrom,
    threshold: thr,
    ledgers_in_transactions: entities.ledgers.length,
    trial_balance_only_ledgers: entities.trialBalanceOnlyLedgers,
    parties: entities.parties.length,
    accounts: countBy(accountProposals),
    contacts: countBy(contactProposals),
    rules: rulesByType,
    module_routes: rules.filter((r) => r.rule_type === 'MODULE_ROUTE').map((r) => ({ voucher_type: r.source_key, target: r.target_value })),
    generated_at: generatedAt,
  };

  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, 'mapping-rules.json'), JSON.stringify(rules, null, 2) + '\n');
  await writeFile(path.join(outDir, 'review-accounts.csv'), reviewCsv(accountProposals, 'accounts'));
  await writeFile(path.join(outDir, 'review-contacts.csv'), reviewCsv(contactProposals, 'contacts'));
  await writeFile(path.join(outDir, 'mapping-report.json'), JSON.stringify(report, null, 2) + '\n');
  return { outDir, report, rules, accountProposals, contactProposals };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.run || !args['books-ref'] || !args.org || !args.out) {
    console.error('usage: build-mapping.js --run <normalised-run-folder> --books-ref <folder> --org <books org id> --out <folder> [--mapping-version map_test_v1] [--effective-from 2026-04-01] [--threshold 0.8] [--decided-on 2026-10-08]');
    process.exit(2);
  }
  try {
    const { outDir, report } = await runBuildMapping({
      runDir: args.run, booksRefDir: args['books-ref'], orgId: String(args.org), outDir: args.out,
      mappingVersion: args['mapping-version'] === undefined ? undefined : String(args['mapping-version']),
      effectiveFrom: args['effective-from'] === undefined ? undefined : String(args['effective-from']),
      threshold: args.threshold === undefined ? undefined : args.threshold,
      decidedOn: args['decided-on'] === undefined ? undefined : String(args['decided-on']),
    });
    console.log(`mapping folder: ${outDir}`);
    console.log(JSON.stringify({
      mapping_version: report.mapping_version, ledgers: report.ledgers_in_transactions,
      trial_balance_only_ledgers: report.trial_balance_only_ledgers, parties: report.parties,
      accounts: report.accounts, contacts: report.contacts, rules: report.rules,
    }, null, 2));
  } catch (e) {
    console.error(`${e.code ?? 'ERROR'}: ${e.message}`);
    process.exit(1);
  }
}
