#!/usr/bin/env node
// Prepare every branch whose extract is in var/raw<branch>/txn and summarise what is ready
// (nothing talks to Zoho):
//
//   node scripts/branch-ready.js [--branches 460,461] [--coa var/books-ref/coa.csv]
//     [--account-map var/txn/accounts_master.csv] [--gl-parties H30066,H58907]
//     [--from 2026-04-01] [--to 2026-07-05]
//
// Per branch the extract folder holds (names as delivered; matched loosely):
//   ledger_v2.xlsx                      the ledger table V2 (required)
//   supplier_payment_details_act.csv    supplier allocations
//   invoice_receipt_det_act_<br>.csv    customer settlements
//   closing_tb_*.xlsx                   Eco Green closing TB (integrity check)
// and var/opening/<br>/plan.json once the opening is prepared. Each branch is planned into
// var/txn/<br> (scripts/txn-plan.js); var/txn/readiness.md and readiness.csv summarise them all.
import { readdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error(`unexpected argument ${a}`);
    opts[a.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
  }
  return opts;
}
const csvCell = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const toCsv = (header, rows) => [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\n') + '\n';
const pick = (dir, re) => readdirSync(dir).filter((f) => re.test(f)).sort().map((f) => join(dir, f))[0] ?? null;
const sum = (xs) => xs.reduce((t, x) => t + Number(x || 0), 0);
const rs = (n) => n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function branchesFound(root) {
  return readdirSync(root).map((d) => /^raw(\d+)$/.exec(d)?.[1]).filter((b) => b && existsSync(join(root, `raw${b}`, 'txn')));
}

function prepare(b, o) {
  const dir = join('var', `raw${b}`, 'txn');
  const files = {
    ledger: pick(dir, /^ledger.*\.xlsx$/i),
    supplier: pick(dir, /^supplier_payment.*\.csv$/i),
    customer: pick(dir, /^invoice_receipt.*\.csv$/i),
    closingTb: pick(dir, /^closing_tb.*\.xlsx$/i) ?? (existsSync(join('var', `raw${b}`, 'run-in')) ? pick(join('var', `raw${b}`, 'run-in'), /^closing_tb.*\.xlsx$/i) : null),
    opening: existsSync(join('var', 'opening', b, 'plan.json')) ? join('var', 'opening', b, 'plan.json') : null,
  };
  const row = { branch: b, files, missing: Object.entries(files).filter(([, v]) => !v).map(([k]) => k) };
  if (!files.ledger) return { ...row, status: 'NO LEDGER' };
  const args = ['scripts/txn-plan.js', '--branch', b, '--ledger', files.ledger, '--from', o.from, '--to', o.to, '--out', join('var', 'txn', b)];
  for (const [flag, v] of [['supplier', files.supplier], ['customer', files.customer], ['closing-tb', files.closingTb], ['opening', files.opening],
    ['coa', o.coa], ['account-map', o['account-map']], ['gl-parties', o['gl-parties']]]) if (v) args.push(`--${flag}`, v);
  const run = spawnSync(process.execPath, args, { encoding: 'utf8' });
  if (![0, 2].includes(run.status)) return { ...row, status: 'PLAN ERROR', error: (run.stderr || run.stdout).trim().split('\n').pop() };
  const plan = JSON.parse(readFileSync(join('var', 'txn', b, 'plan.json'), 'utf8'));
  const kinds = {};
  for (const p of plan.postings) kinds[p.kind] = (kinds[p.kind] ?? 0) + 1;
  const waiting = plan.exceptions.filter((e) => /not in Books/.test(e.type));
  const failed = plan.checks.filter((c) => !c.ok);
  return {
    ...row, kinds, checks: plan.checks, failed,
    status: failed.length ? 'FIX' : files.opening ? 'READY' : 'WAITING FOR OPENING',
    totals: plan.totals, waiting: waiting.length, waitingAmount: sum(waiting.map((e) => e.amount)),
    smartPharma: plan.totals?.smartPharmaVouchers,
  };
}

function main() {
  const o = { from: '2026-04-01', to: '2026-07-05', 'gl-parties': 'H30066,H58907', ...parseArgs(process.argv.slice(2)) };
  if (!o.coa && existsSync('var/books-ref/coa.csv')) o.coa = 'var/books-ref/coa.csv';
  if (!o['account-map'] && existsSync('var/txn/accounts_master.csv')) o['account-map'] = 'var/txn/accounts_master.csv';
  const branches = o.branches ? o.branches.split(',').map((x) => x.trim()) : branchesFound('var');
  const rows = branches.map((b) => {
    process.stderr.write(`branch ${b}…\n`);
    return prepare(b, o);
  });
  const L = [`# Branch readiness (${new Date().toISOString().slice(0, 10)})`, '',
    `Window ${o.from} to ${o.to}. Chart of accounts: ${o.coa ?? 'none'}. Account map: ${o['account-map'] ?? 'none'}. GL parties: ${o['gl-parties'] || 'none'}.`, '',
    '| Branch | Status | Our vouchers | Receipts + payments | Applied exactly | Waiting for opening / Smart Pharma | Missing files |',
    '|---|---|---|---|---|---|---|'];
  for (const r of rows) {
    const ours = r.kinds ? Object.entries(r.kinds).map(([k, n]) => `${n} ${k}`).join(', ') : '';
    L.push(`| ${r.branch} | ${r.status} | ${ours} | ${r.totals ? rs(Number(r.totals.paymentsAmount ?? 0)) : ''} | ${r.totals ? rs(Number(r.totals.exact ?? 0)) : ''} | ${r.waiting ?? ''}${r.waiting ? ` (${rs(r.waitingAmount)})` : ''} | ${r.missing.join(', ')} |`);
  }
  L.push('');
  for (const r of rows.filter((x) => x.failed?.length || x.error)) {
    L.push(`## ${r.branch}: to fix`, '');
    if (r.error) L.push(`- ${r.error}`);
    for (const c of r.failed ?? []) L.push(`- ${c.name}: ${c.detail}`);
    L.push('');
  }
  writeFileSync(join('var', 'txn', 'readiness.md'), L.join('\n'));
  writeFileSync(join('var', 'txn', 'readiness.csv'), toCsv(
    ['branch', 'status', 'journals', 'receipts', 'payments', 'bills', 'failed_checks', 'waiting_documents', 'waiting_amount', 'missing_files'],
    rows.map((r) => [r.branch, r.status, r.kinds?.journal ?? 0, r.kinds?.receipt ?? 0, r.kinds?.payment ?? 0, r.kinds?.bill ?? 0,
      (r.failed ?? []).map((c) => c.name).join('; ') || r.error || '', r.waiting ?? '', r.waitingAmount ? r.waitingAmount.toFixed(2) : '', r.missing.join('; ')]),
  ));
  process.stdout.write(L.join('\n'));
  if (rows.some((r) => ['FIX', 'PLAN ERROR', 'NO LEDGER'].includes(r.status))) process.exitCode = 2;
}

main();
