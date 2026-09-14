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
import { ingestRun } from '../src/core/ingest.js';
import { summariseRun } from '../src/core/summarise.js';
import { reconcileLayerA } from '../src/core/recon_a.js';
import { classifyRun } from '../src/core/overlap.js';
import { transformRun } from '../src/core/transform.js';
import { computeBridge, reconcileLayerB } from '../src/core/bridge.js';
import { resolve as resolveException } from '../src/core/exceptions.js';
import { createBatch, approveBatch, enqueueBatch } from '../src/core/batch.js';
import { runQueueSlice, resolveUnknownOutcomes } from '../src/worker/executor.js';
import { reconcileLayerC } from '../src/core/recon_c.js';
import { takeSnapshot, balanceBridge } from '../src/core/balance_bridge.js';
import { assertTransition, RUN_TRANSITIONS } from '../src/core/states.js';
import { nowIso } from '../src/core/ids.js';
import { rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { seedFixtures } from './seed-fixtures.js';

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

function isPassLike(status) {
  return status === 'PASS' || status === 'PASS_WITH_APPROVED_EXCEPTIONS';
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
  const store = await openStore({ adapter: 'sqlite', path: sqlitePath });
  const audit = createAudit(store);
  const workerId = 'run-pipeline';
  const ctx = { store, audit, correlationId: newCorrelationId(), actor: workerId, actorRole: 'operator' };

  try {
    const inbox = await openInbox({});
    const archive = await openArchive({});
    const client = createBooksClient({ driver: 'mock', config: { mockWritesEnabled: true, organizationId: 'mock_org' } });

    const seeded = await seedFixtures(ctx, { client });

    const inboxRef = `${args.branch}/${args.run}`;
    const manifestBuf = await inbox.readFile(inboxRef, 'manifest.json');
    const manifest = JSON.parse(manifestBuf.toString('utf8'));
    const runId = manifest.extraction_run_id;

    line(`=== run-pipeline: ${inboxRef} (${args.dryRun ? 'dry-run' : 'dry-run (implied)'}) ===`);
    line(`Seeded ${seeded.copiedRuns.length} inbox run(s), ${seeded.cutoverRows.length} cutover rows, ${seeded.mappingRows.length} mapping rules, ${seeded.spEvidence.length} SP evidence rows.`);
    line('');

    const ingestResult = await ingestRun(ctx, { inbox, archive, inboxRef, workerId });
    line(`Ingest outcome: ${ingestResult.outcome}`);
    if (ingestResult.outcome === 'DUPLICATE_MANIFEST') {
      line('IDEMPOTENT RERUN: this manifest was already registered; no new work was created. This output is NOT end-to-end verification evidence (use --fresh for that).');
    }
    if (ingestResult.outcome === 'CLAIM_LOST') {
      line('Another process currently holds the claim on this run — nothing more to report.');
      line('');
      line('POSTING: DISABLED (mock driver, dry-run)');
      return;
    }

    const files = await store.find('source_files', { run_id: runId });
    line('Files:');
    for (const f of files) {
      line(`  ${f.file_name.padEnd(20)} [${f.file_role.padEnd(13)}] status=${f.status.padEnd(17)} rows=${f.actual_row_count ?? '-'} debit=${f.actual_debit_total ?? '-'} credit=${f.actual_credit_total ?? '-'}`);
    }
    line('');

    let run = await store.get('extraction_runs', runId);
    if (!run) {
      line(`No extraction_runs row for ${runId} (manifest/validation failed before a row could be created).`);
      if (ingestResult.errors) for (const e of ingestResult.errors) line(`  - [${e.code}] ${e.path ?? ''} ${e.message ?? ''}`);
      line('');
      line('POSTING: DISABLED (mock driver, dry-run)');
      return;
    }

    line(`Run status: ${run.status}`);
    line('');

    let reconAStatus = null;
    let reconARunId = null;
    if (run.status === 'STAGED') {
      await summariseRun(ctx, { runId });
      const reconOutcome = await reconcileLayerA(ctx, { runId });
      reconAStatus = reconOutcome.status;
      reconARunId = reconOutcome.reconRunId;
      run = await store.get('extraction_runs', runId);
    } else {
      const existing = await store.find('recon_runs', { run_id: runId, layer: 'A' });
      const latest = existing.length ? existing[existing.length - 1] : null;
      reconAStatus = latest?.status ?? null;
      reconARunId = latest?.id ?? null;
    }

    if (reconARunId) {
      const reconResults = await store.find('recon_results', { recon_run_id: reconARunId });
      const failing = reconResults.filter((r) => r.status !== 'MATCH');
      line(`Layer A: ${reconAStatus} (${reconResults.length} controls, ${failing.length} failing)`);
      for (const f of failing) {
        line(`  ${f.status.padEnd(16)} ${f.control_key.padEnd(32)} expected=${f.expected} actual=${f.actual} diff=${f.difference}`);
      }
    } else {
      line('Layer A: not run (ingest did not reach STAGED)');
    }
    line('');

    if (!isPassLike(reconAStatus) && reconARunId && args.approveKnownDiffs) {
      const approverCtx = { ...ctx, actor: 'finance.lead', actorRole: 'approver' };
      const open = (await store.find('exceptions', { run_id: runId, category: 'RECONCILIATION_DIFFERENCE' }))
        .filter((e) => e.status === 'OPEN' || e.status === 'ASSIGNED');
      for (const e of open) {
        await resolveException(approverCtx, {
          id: e.id, status: 'APPROVED_EXCEPTION', actor: 'finance.lead',
          rootCause: 'Known synthetic defect documented in fixtures EXPECTED.md',
          disposition: 'Approved as a pilot demonstration exception; would require finance sign-off on real data',
        });
      }
      run = await store.get('extraction_runs', runId);
      assertTransition(RUN_TRANSITIONS, 'run', run.status, 'SUMMARISED');
      await store.update('extraction_runs', runId, { status: 'SUMMARISED', updated_at: nowIso() });
      const rerun = await reconcileLayerA(ctx, { runId });
      reconAStatus = rerun.status; reconARunId = rerun.reconRunId;
      run = await store.get('extraction_runs', runId);
      line(`Layer A (re-run after approving ${open.length} known differences as finance.lead): ${reconAStatus}`);
      line('');
    }

    let dispositionCounts = null;
    let previewByModule = {};
    let layerB = null;
    if (isPassLike(reconAStatus)) {
      await classifyRun(ctx, { runId, spEvidence: seeded.spEvidence, ruleVersion: 'cut_v1' });
      await transformRun(ctx, { runId });
      line('Classification/Transform: complete');
      layerB = await reconcileLayerB(ctx, { runId });
      line(`Layer B (CSV -> approved population bridge): ${layerB.status}`);
    } else {
      line('Classification/Transform: SKIPPED (Layer A did not PASS — see states.js RUN_TRANSITIONS; the guard is intentional and not bypassed here)');
    }
    line('');

    const vouchers = await store.find('vouchers', { extraction_run_id: runId });
    dispositionCounts = computeBridge(vouchers);
    line('Disposition bridge:');
    line(`  ${'disposition'.padEnd(24)}${'count'.padEnd(8)}${'debit'.padEnd(14)}credit`);
    for (const [d, g] of Object.entries(dispositionCounts.byDisposition)) {
      line(`  ${d.padEnd(24)}${String(g.count).padEnd(8)}${g.debit.padEnd(14)}${g.credit}`);
    }
    line(`  ${'TOTAL'.padEnd(24)}${String(dispositionCounts.total.count).padEnd(8)}${dispositionCounts.total.debit.padEnd(14)}${dispositionCounts.total.credit}`);
    line('');

    const previewRows = await store.find('preview_payloads', {});
    for (const p of previewRows) {
      const voucher = await store.get('vouchers', p.voucher_id);
      if (voucher?.extraction_run_id !== runId) continue;
      previewByModule[p.target_module] = (previewByModule[p.target_module] ?? 0) + 1;
    }
    const moduleEntries = Object.entries(previewByModule);
    line(moduleEntries.length ? 'Preview payloads by module:' : 'Preview payloads by module: (none)');
    for (const [module, count] of moduleEntries) line(`  ${module.padEnd(20)}${count}`);
    line('');

    let exercised = 0;
    let postedTotal = 0;
    const verificationFailures = [];
    if (args.throughMockBooks && layerB && isPassLike(layerB.status)) {
      line('Mock Books delivery (driver=mock; live posting is structurally disabled):');
      const operatorCtx = { ...ctx, actor: 'operator.local', actorRole: 'operator' };
      const approverCtx = { ...ctx, actor: 'finance.lead', actorRole: 'approver' };
      const periods = [...new Set(vouchers.filter((v) => v.disposition === 'MIGRATE' && v.target_payload_hash).map((v) => v.period))].sort();
      for (const period of periods) {
        const batch = await createBatch(operatorCtx, { runId, branchCode: args.branch, period, createdBy: 'operator.local' });
        line(`  batch ${batch.id} period=${period} status=${batch.status} vouchers=${batch.voucher_count} debit=${batch.debit_total} credit=${batch.credit_total}`);
        if (batch.status !== 'READY_FOR_APPROVAL') continue;
        await approveBatch(approverCtx, { batchId: batch.id, approver: 'finance.lead', approverRole: 'approver', reason: 'pilot dry-run against mock Books' });
        const enq = await enqueueBatch(operatorCtx, { batchId: batch.id });
        await takeSnapshot(operatorCtx, { client, branchCode: args.branch, kind: 'BASELINE', batchId: batch.id });
        const slice = await runQueueSlice(operatorCtx, { client, batchId: batch.id, workerId: 'run-pipeline', maxItems: 500, timeBudgetMs: 60_000 });
        const unk = await resolveUnknownOutcomes(operatorCtx, { client, batchId: batch.id });
        await takeSnapshot(operatorCtx, { client, branchCode: args.branch, kind: 'POST_RUN', batchId: batch.id });
        const c = await reconcileLayerC(operatorCtx, { client, batchId: batch.id });
        const bb = await balanceBridge(operatorCtx, { batchId: batch.id });
        const q = await store.find('queue_items', { batch_id: batch.id });
        const byStatus = {};
        for (const it of q) byStatus[it.status] = (byStatus[it.status] ?? 0) + 1;
        line(`    approved by finance.lead (SoD: creator operator.local), enqueued=${enq.enqueued}, processed=${slice.processed}, posted=${slice.posted}, unknown-resolved=${unk.resolvedPosted}`);
        line(`    queue: ${Object.entries(byStatus).map(([k, v]) => `${k}=${v}`).join(' ')}`);
        line(`    Layer C (approved population vs migration-tagged mock records): ${c.status} (${c.itemCount} items)`);
        line(`    Balance bridge: ${bb.status}`);
        exercised += slice.processed;
        postedTotal += slice.posted;
        if (c.status !== 'PASS' || bb.status !== 'PASS') verificationFailures.push(`batch ${batch.id}: layerC=${c.status} bridge=${bb.status}`);
      }
      line('');
    }

    // Verification verdict (Codex P2): a --through-mock-books run over a non-empty
    // approved population must have actually exercised items; zero items is not proof.
    if (args.throughMockBooks) {
      const approvedPopulation = vouchers.filter((v) => v.disposition === 'MIGRATE' && v.target_payload_hash).length;
      if (approvedPopulation > 0 && exercised === 0) {
        verificationFailures.push(`approved population ${approvedPopulation} but 0 queue items were exercised (state already migrated or nothing enqueued)`);
      }
      if (verificationFailures.length) {
        line('VERIFICATION: FAILED');
        for (const f of verificationFailures) line(`  - ${f}`);
        process.exitCode = 3;
      } else if (approvedPopulation > 0) {
        line(`VERIFICATION: PASSED — ${postedTotal}/${approvedPopulation} approved vouchers posted to the mock driver and reconciled (Layer C + balance bridge)`);
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

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('run-pipeline crashed:', err);
  process.exitCode = 1;
});
