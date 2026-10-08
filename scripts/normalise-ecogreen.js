#!/usr/bin/env node
// scripts/normalise-ecogreen.js — turn a raw Eco Green branch extract folder into a
// contract-v1 run folder the ingest pipeline can pick up (docs/ECOGREEN_SOURCE.md).
//
//   node scripts/normalise-ecogreen.js --in <raw-folder> --profile <profile.json> --out <inbox-root>
//
// Writes <inbox-root>/<branch>/<run-id>/{manifest.json, transactions.csv, trial_balance.csv,
// allocations.csv, normalisation_report.json}. Real extracts are client financial data:
// inside this repository the output may only go under the gitignored var/ directory.
import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normaliseEcoGreen } from '../src/sources/ecogreen/normalise.js';
import { normaliseLedgerTable } from '../src/sources/ecogreen/ledger_table.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    args[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  return args;
}

/** Output inside the repo is allowed only under var/ (gitignored). */
export function assertSafeOutput(outDir, projectRoot = PROJECT_ROOT) {
  const rel = path.relative(projectRoot, path.resolve(outDir));
  const inside = rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  if ((inside || rel === '') && rel.split(path.sep)[0] !== 'var') {
    throw new Error(`refusing to write normalised extracts to ${outDir}: inside the repository only var/ is allowed`);
  }
}

export async function runNormalise({ inDir, profilePath, outRoot, now }) {
  assertSafeOutput(outRoot);
  const profile = JSON.parse(await readFile(profilePath, 'utf8'));
  const files = {};
  for (const entry of await readdir(inDir, { withFileTypes: true })) {
    if (entry.isFile() && /\.(csv|xlsx)$/i.test(entry.name)) files[entry.name] = await readFile(path.join(inDir, entry.name));
  }
  // profile.format selects the delivery format: 'raw-tables' (default) or 'ledger-table'
  const result = profile.format === 'ledger-table'
    ? normaliseLedgerTable({ files, profile, now })
    : normaliseEcoGreen({ files, profile, now });
  const runDir = path.join(outRoot, result.manifest.branch_code, result.manifest.extraction_run_id);
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(runDir, 'transactions.csv'), result.transactionsCsv);
  await writeFile(path.join(runDir, 'trial_balance.csv'), result.trialBalanceCsv);
  if (result.allocationsCsv) await writeFile(path.join(runDir, 'allocations.csv'), result.allocationsCsv);
  if (result.componentsCsv) await writeFile(path.join(runDir, 'trial_balance_components.csv'), result.componentsCsv);
  await writeFile(path.join(runDir, 'normalisation_report.json'), JSON.stringify(result.report, null, 2) + '\n');
  // manifest last: the inbox treats a folder as complete only once manifest.json exists
  await writeFile(path.join(runDir, 'manifest.json'), JSON.stringify(result.manifest, null, 2) + '\n');
  return { runDir, report: result.report };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.in || !args.profile || !args.out) {
    console.error('usage: normalise-ecogreen.js --in <raw-folder> --profile <profile.json> --out <inbox-root>');
    process.exit(2);
  }
  try {
    const { runDir, report } = await runNormalise({ inDir: args.in, profilePath: args.profile, outRoot: args.out });
    console.log(`run folder: ${runDir}`);
    console.log(JSON.stringify({
      output: report.output, bridge: report.bridge, exclusions: report.exclusions,
      unbalanced_vouchers: report.unbalanced_vouchers.length,
      unknown_ledgers: report.unknown_ledgers?.length, unknown_controls: report.unknown_controls?.length,
      trial_balance_ties: report.trial_balance_ties && { all: report.trial_balance_ties.all, failing: report.trial_balance_ties.failing.length },
      date_repair: report.date_repair, pushers: report.pushers,
    }, null, 2));
  } catch (e) {
    console.error(`${e.code ?? 'ERROR'}: ${e.message}`);
    process.exit(1);
  }
}
