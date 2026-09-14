#!/usr/bin/env node
// scripts/run-pipeline.js --branch PILOT01 --run run-001 --dry-run (CONTRACTS.md §P).
//
// Runs the pipeline against one seeded inbox run end-to-end with the MOCK Books driver
// and prints a compact human report. `--dry-run` is the only supported mode; even
// without the flag this script never touches a live driver (see src/books/guard.js —
// posting stays impossible unless POSTING_ENABLED, an authorization ref, and an
// allow-listed live organisation ALL line up, none of which this script sets).
//
// Documented resolution of a real state-machine constraint: DATA_CONTRACT.md's fixture
// is deliberately unbalanced so Layer A must FAIL, but src/core/states.js#RUN_TRANSITIONS
// forbids SOURCE_RECON_FAILED -> CLASSIFIED. This script does not bypass that guard
// ("never weaken a guard"), so when Layer A does not PASS, classification/transform are
// reported as SKIPPED rather than silently forced through — the Layer A failure report
// itself is the point of the fixture (DATA_CONTRACT.md §8: "proving the control catches
// them"), so exit code stays 0 for an expected FAIL, non-zero only for a crash.
import { openStore } from '../src/adapters/store/index.js';
import { openInbox } from '../src/adapters/inbox/index.js';
import { openArchive } from '../src/adapters/archive/index.js';
import { createAudit } from '../src/core/audit.js';
import { newCorrelationId } from '../src/core/ids.js';
import { createBooksClient } from '../src/books/index.js';
import { rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { seedFixtures } from './seed-fixtures.js';
import {
  isPassLike,
  runIngestStage,
  runLayerAStage,
  approveKnownDiffsStage,
  runClassifyTransformBridgeStage,
  runMockBooksStage,
} from './lib/pipeline-stages.js';

/**
 * Injectable store opener (CONTRACTS.md §S adapter dispatch, extended here only to add
 * a `catalyst-fake` option): defaults to sqlite exactly as before (`STORE_ADAPTER` env
 * var otherwise unset/'sqlite' behaves identically to the previous inline
 * `openStore({ adapter: 'sqlite', path: sqlitePath })` call). Set `STORE_ADAPTER=
 * catalyst-fake` (or pass `{ adapter: 'catalyst-fake' }`) to run this same pipeline
 * in-process against the offline Catalyst-shaped fake instead — exactly what
 * test/pipeline_catalyst_fake.test.js and (per the dashboard pipeline goal) a deployed
 * seed endpoint do by calling the stage functions above directly rather than spawning
 * this CLI script. The returned store carries a non-enumerable `catalystFake` property
 * in that mode so a caller can call `store.catalystFake.assertWithinLimits()`.
 */
export async function openStoreForPipeline({ sqlitePath, adapter } = {}) {
  const chosen = adapter ?? process.env.STORE_ADAPTER ?? 'sqlite';
  if (chosen === 'catalyst-fake') {
    const { createCatalystFake } = await import('../src/adapters/store/catalyst_fake.js');
    const { openStore: openCatalystStore } = await import('../src/adapters/store/catalyst.js');
    const fake = createCatalystFake();
    const store = await openCatalystStore({ app: fake.app });
    Object.defineProperty(store, 'catalystFake', { value: fake, enumerable: false });
    return store;
  }
  return openStore({ adapter: 'sqlite', path: sqlitePath });
}

function parseArgs(argv) {
  const args = { dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--branch') args.branch = argv[++i];
    else if (a === '--run') args.run = argv[++i];
    else if (a === '--dry-run') args.dryRun = true;
    // Finance-style approval of the KNOWN synthetic defects (see fixtures EXPECTED.md):
    // marks each open RECONCILIATION_DIFFERENCE as APPROVED_EXCEPTION under an approver
    // identity and re-runs Layer A. The state guard is respected, not bypassed.
    else if (a === '--approve-known-diffs') args.approveKnownDiffs = true;
    // Drive approved batches through the MOCK Books client only (never live) to
    // demonstrate queue, Layer C and the balance bridge end-to-end.
    else if (a === '--through-mock-books') args.throughMockBooks = true;
    // Isolated-state VERIFICATION mode: wipes the local sqlite DB, inbox and archive
    // (only when they live under ./var) so the run is a clean end-to-end proof, not a
    // rerun over existing state. Without it, a rerun is idempotent and reports so.
    else if (a === '--fresh') args.fresh = true;
  }
  return args;
}

function line(...parts) {
  // eslint-disable-next-line no-console
  console.log(parts.join(''));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.branch || !args.run) {
    line('Usage: node scripts/run-pipeline.js --branch <code> --run <id> [--dry-run] [--fresh] [--approve-known-diffs] [--through-mock-books]');
    process.exitCode = 1;
    return;
  }

  const sqlitePath = process.env.SQLITE_PATH ?? './var/migration.db';
  const inboxRoot = process.env.INBOX_LOCAL_PATH ?? './var/inbox';
  const archiveRoot = process.env.ARCHIVE_LOCAL_PATH ?? './var/archive';
  if (args.fresh) {
    const varRoot = path.resolve('./var');
    for (const p of [sqlitePath, `${sqlitePath}-wal`, `${sqlitePath}-shm`, inboxRoot, archiveRoot]) {
      const abs = path.resolve(p);
      if (!abs.startsWith(varRoot + path.sep) && abs !== varRoot) {
        line(`--fresh refuses to delete ${abs}: only paths under ./var are wiped. Set SQLITE_PATH/INBOX_LOCAL_PATH/ARCHIVE_LOCAL_PATH under ./var or omit --fresh.`);
        process.exitCode = 2;
        return;
      }
      if (existsSync(abs)) rmSync(abs, { recursive: true, force: true });
    }
    line('MODE: FRESH ISOLATED VERIFICATION (local state under ./var wiped before run)');
  } else {
    line('MODE: INCREMENTAL (existing local state reused; a rerun over the same manifest is an idempotency check, NOT end-to-end evidence)');
  }
  const store = await openStoreForPipeline({ sqlitePath });
  const audit = createAudit(store);
  const workerId = 'run-pipeline';
  const ctx = { store, audit, correlationId: newCorrelationId(), actor: workerId, actorRole: 'operator' };

  try {
    const inbox = await openInbox({});
    const archive = await openArchive({});
    const client = createBooksClient({ driver: 'mock', config: { mockWritesEnabled: true, organizationId: 'mock_org' } });

    const seeded = await seedFixtures(ctx, { client });

    const inboxRef = `${args.branch}/${args.run}`;

    line(`=== run-pipeline: ${inboxRef} (${args.dryRun ? 'dry-run' : 'dry-run (implied)'}) ===`);
    line(`Seeded ${seeded.copiedRuns.length} inbox run(s), ${seeded.cutoverRows.length} cutover rows, ${seeded.mappingRows.length} mapping rules, ${seeded.spEvidence.length} SP evidence rows.`);
    line('');

    const ingest = await runIngestStage(ctx, { inbox, archive, inboxRef, workerId });
    const runId = ingest.runId;
    line(`Ingest outcome: ${ingest.outcome}`);
    if (ingest.outcome === 'DUPLICATE_MANIFEST') {
      line('IDEMPOTENT RERUN: this manifest was already registered; no new work was created. This output is NOT end-to-end verification evidence (use --fresh for that).');
    }
    if (ingest.outcome === 'CLAIM_LOST') {
      line('Another process currently holds the claim on this run — nothing more to report.');
      line('');
      line('POSTING: DISABLED (mock driver, dry-run)');
      return;
    }

    line('Files:');
    for (const f of ingest.files) {
      line(`  ${f.file_name.padEnd(20)} [${f.file_role.padEnd(13)}] status=${f.status.padEnd(17)} rows=${f.actual_row_count ?? '-'} debit=${f.actual_debit_total ?? '-'} credit=${f.actual_credit_total ?? '-'}`);
    }
    line('');

    let run = ingest.run;
    if (!run) {
      line(`No extraction_runs row for ${runId} (manifest/validation failed before a row could be created).`);
      if (ingest.errors) for (const e of ingest.errors) line(`  - [${e.code}] ${e.path ?? ''} ${e.message ?? ''}`);
      line('');
      line('POSTING: DISABLED (mock driver, dry-run)');
      return;
    }

    line(`Run status: ${run.status}`);
    line('');

    let layerA = await runLayerAStage(ctx, { runId, run });
    run = layerA.run;
    let reconAStatus = layerA.reconAStatus;
    let reconARunId = layerA.reconARunId;

    if (reconARunId) {
      line(`Layer A: ${reconAStatus} (${layerA.controls.length} controls, ${layerA.failing.length} failing)`);
      for (const f of layerA.failing) {
        line(`  ${f.status.padEnd(16)} ${f.control_key.padEnd(32)} expected=${f.expected} actual=${f.actual} diff=${f.difference}`);
      }
    } else {
      line('Layer A: not run (ingest did not reach STAGED)');
    }
    line('');

    if (!isPassLike(reconAStatus) && reconARunId && args.approveKnownDiffs) {
      const approved = await approveKnownDiffsStage(ctx, { runId, reconAStatus, reconARunId });
      reconAStatus = approved.reconAStatus;
      reconARunId = approved.reconARunId;
      run = approved.run;
      line(`Layer A (re-run after approving ${approved.approvedCount} known differences as finance.lead): ${reconAStatus}`);
      line('');
    }

    const ctb = await runClassifyTransformBridgeStage(ctx, { runId, reconAStatus, spEvidence: seeded.spEvidence, ruleVersion: 'cut_v1' });
    if (!ctb.skipped) {
      line('Classification/Transform: complete');
      line(`Layer B (CSV -> approved population bridge): ${ctb.layerB.status}`);
    } else {
      line('Classification/Transform: SKIPPED (Layer A did not PASS — see states.js RUN_TRANSITIONS; the guard is intentional and not bypassed here)');
    }
    line('');

    const vouchers = ctb.vouchers;
    const dispositionCounts = ctb.dispositionCounts;
    line('Disposition bridge:');
    line(`  ${'disposition'.padEnd(24)}${'count'.padEnd(8)}${'debit'.padEnd(14)}credit`);
    for (const [d, g] of Object.entries(dispositionCounts.byDisposition)) {
      line(`  ${d.padEnd(24)}${String(g.count).padEnd(8)}${g.debit.padEnd(14)}${g.credit}`);
    }
    line(`  ${'TOTAL'.padEnd(24)}${String(dispositionCounts.total.count).padEnd(8)}${dispositionCounts.total.debit.padEnd(14)}${dispositionCounts.total.credit}`);
    line('');

    const moduleEntries = Object.entries(ctb.previewByModule);
    line(moduleEntries.length ? 'Preview payloads by module:' : 'Preview payloads by module: (none)');
    for (const [module, count] of moduleEntries) line(`  ${module.padEnd(20)}${count}`);
    line('');

    const layerB = ctb.layerB;
    let mb = null;
    if (args.throughMockBooks) {
      mb = await runMockBooksStage(ctx, { client, branchCode: args.branch, runId, layerB, vouchers });
      if (mb.ran) {
        line('Mock Books delivery (driver=mock; live posting is structurally disabled):');
        for (const entry of mb.batches) {
          const { batch, period } = entry;
          line(`  batch ${batch.id} period=${period} status=${batch.status} vouchers=${batch.voucher_count} debit=${batch.debit_total} credit=${batch.credit_total}`);
          if (batch.status !== 'READY_FOR_APPROVAL') continue;
          line(`    approved by finance.lead (SoD: creator operator.local), enqueued=${entry.enqueued}, processed=${entry.slice.processed}, posted=${entry.slice.posted}, unknown-resolved=${entry.unknownResolved}`);
          line(`    queue: ${Object.entries(entry.byStatus).map(([k, v]) => `${k}=${v}`).join(' ')}`);
          line(`    Layer C (approved population vs migration-tagged mock records): ${entry.layerC.status} (${entry.layerC.itemCount} items)`);
          line(`    Balance bridge: ${entry.bridge.status}`);
        }
        line('');
      }

      // Verification verdict (Codex P2): a --through-mock-books run over a non-empty
      // approved population must have actually exercised items; zero items is not proof.
      if (mb.verificationStatus === 'FAILED') {
        line('VERIFICATION: FAILED');
        for (const f of mb.verificationFailures) line(`  - ${f}`);
        process.exitCode = 3;
      } else if (mb.verificationStatus === 'PASSED') {
        line(`VERIFICATION: PASSED — ${mb.postedTotal}/${mb.approvedPopulation} approved vouchers posted to the mock driver and reconciled (Layer C + balance bridge)`);
      } else {
        line('VERIFICATION: NOT APPLICABLE — approved migration population is empty');
      }
      line('');
    }

    const exceptions = await store.find('exceptions', { run_id: runId });
    const byCategory = {};
    for (const e of exceptions) byCategory[e.category] = (byCategory[e.category] ?? 0) + 1;
    const categoryEntries = Object.entries(byCategory);
    line(categoryEntries.length ? 'Exceptions by category:' : 'Exceptions by category: (none)');
    for (const [cat, count] of categoryEntries) line(`  ${cat.padEnd(28)}${count}`);
    line('');

    line('POSTING: DISABLED (mock driver, dry-run)');
  } finally {
    await store.close();
  }
}

// Guarded so `openStoreForPipeline` (and the stage functions it composes with) can be
// imported by test/pipeline_catalyst_fake.test.js — or a future deployed seed endpoint —
// without main() firing on import (it used to run unconditionally; nothing previously
// imported this file, so this is a no-op for the CLI path: `node scripts/run-pipeline.js`
// is still the main module and still runs exactly as before).
function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('run-pipeline crashed:', err);
    process.exitCode = 1;
  });
}
