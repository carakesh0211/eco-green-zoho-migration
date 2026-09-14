// Proves the full dashboard pipeline (ingest -> summarise -> Layer A -> approve known
// diffs -> re-run A -> classify -> transform -> Layer B -> batches -> approve -> enqueue
// -> mock queue -> Layer C -> balance bridge) runs end-to-end on the Catalyst Data Store
// adapter, driven entirely through scripts/lib/pipeline-stages.js (the same functions
// scripts/run-pipeline.js and, per the dashboard pipeline goal, a deployed seed endpoint
// use) against `catalyst_fake` rather than sqlite. Mirrors test/pipeline_e2e.test.js's
// assertions exactly, since the business outcome must not depend on which store adapter
// runs underneath it.
//
// Everything here runs in a single Node process against ONE persistent catalyst_fake
// store instance (an in-memory fake cannot be shared across spawned child processes the
// way test/pipeline_e2e.test.js's sqlite file is), calling the stage functions directly
// instead of spawning the CLI script.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { openStoreForPipeline } from '../scripts/run-pipeline.js';
import { seedFixtures } from '../scripts/seed-fixtures.js';
import {
  isPassLike,
  runIngestStage,
  runLayerAStage,
  approveKnownDiffsStage,
  runClassifyTransformBridgeStage,
  runMockBooksStage,
} from '../scripts/lib/pipeline-stages.js';
import { openInbox } from '../src/adapters/inbox/index.js';
import { openArchive } from '../src/adapters/archive/index.js';
import { createAudit } from '../src/core/audit.js';
import { newCorrelationId } from '../src/core/ids.js';
import { createBooksClient } from '../src/books/index.js';

const TEXT_ASSERT_CAP = 8000; // documented headroom under Catalyst's 10,000-char text cap

async function buildEnv() {
  const tmpRoot = mkdtempSync(path.join(tmpdir(), 'pipeline-catalyst-fake-'));
  const inboxRoot = path.join(tmpRoot, 'inbox');
  const archiveRoot = path.join(tmpRoot, 'archive');

  const store = await openStoreForPipeline({ adapter: 'catalyst-fake' });
  const audit = createAudit(store);
  const ctx = { store, audit, correlationId: newCorrelationId(), actor: 'run-pipeline', actorRole: 'operator' };

  const inbox = await openInbox({ adapter: 'local', root: inboxRoot });
  const archive = await openArchive({ adapter: 'local', root: archiveRoot });
  const client = createBooksClient({ driver: 'mock', config: { mockWritesEnabled: true, organizationId: 'mock_org' } });

  const seeded = await seedFixtures(ctx, { inboxRoot, client });

  return { tmpRoot, store, ctx, inbox, archive, client, seeded };
}

function countByCategory(rows, key) {
  const out = {};
  for (const r of rows) out[r[key]] = (out[r[key]] ?? 0) + 1;
  return out;
}

test('pipeline on catalyst_fake: full stage sequence produces the same outcomes as the sqlite e2e (STAGED, 7 known diffs, 31/3/4/2, 2 batches, 31 posted, Layer C/bridge PASS x2); rerun is idempotent (DUPLICATE_MANIFEST)', { timeout: 120_000 }, async () => {
  const env = await buildEnv();
  const { store, ctx, inbox, archive, client, seeded } = env;
  const branchCode = 'PILOT01';
  const inboxRef = `${branchCode}/run-001`;

  try {
    // ---- ingest ----
    const ingest = await runIngestStage(ctx, { inbox, archive, inboxRef, workerId: 'run-pipeline' });
    assert.equal(ingest.outcome, 'STAGED');
    const runId = ingest.runId;
    assert.ok(runId);
    assert.equal(ingest.run.status, 'STAGED');

    // ---- Layer A: expect exactly 7 failing controls (fixtures EXPECTED.md) ----
    const layerA = await runLayerAStage(ctx, { runId, run: ingest.run });
    assert.equal(layerA.reconAStatus, 'FAIL');
    assert.equal(layerA.failing.length, 7);
    assert.ok(layerA.controls.length > layerA.failing.length);

    // ---- approve the 7 known synthetic differences as finance.lead, re-run Layer A ----
    const approved = await approveKnownDiffsStage(ctx, { runId, reconAStatus: layerA.reconAStatus, reconARunId: layerA.reconARunId });
    assert.equal(approved.applied, true);
    assert.equal(approved.approvedCount, 7);
    assert.equal(approved.reconAStatus, 'PASS_WITH_APPROVED_EXCEPTIONS');
    assert.ok(isPassLike(approved.reconAStatus));

    // ---- classify -> transform -> Layer B ----
    const ctb = await runClassifyTransformBridgeStage(ctx, {
      runId, reconAStatus: approved.reconAStatus, spEvidence: seeded.spEvidence, ruleVersion: 'cut_v1',
    });
    assert.equal(ctb.skipped, false);
    assert.equal(ctb.layerB.status, 'PASS');
    assert.equal(ctb.dispositionCounts.total.count, 40);

    const dispositionByCount = Object.fromEntries(
      Object.entries(ctb.dispositionCounts.byDisposition).map(([k, v]) => [k, v.count])
    );
    assert.deepEqual(dispositionByCount, {
      MIGRATE: 31,
      SMART_PHARMA_EXCLUDED: 3,
      BLOCKED: 4,
      OTHER_EXCLUDED: 2,
    });

    // ---- batches -> approve -> enqueue -> mock queue -> Layer C -> balance bridge ----
    const mb = await runMockBooksStage(ctx, { client, branchCode, runId, layerB: ctb.layerB, vouchers: ctb.vouchers });
    assert.equal(mb.ran, true);
    assert.equal(mb.batches.length, 2, 'one batch per period (2026-04, 2026-05)');
    assert.equal(mb.approvedPopulation, 31);
    assert.equal(mb.postedTotal, 31);
    assert.equal(mb.exercised, 31);
    assert.equal(mb.verificationFailures.length, 0);
    assert.equal(mb.verificationStatus, 'PASSED');
    for (const entry of mb.batches) {
      assert.equal(entry.batch.status, 'READY_FOR_APPROVAL');
      assert.equal(entry.layerC.status, 'PASS');
      assert.equal(entry.bridge.status, 'PASS');
    }
    const totalVouchersAcrossBatches = mb.batches.reduce((n, e) => n + e.batch.voucher_count, 0);
    assert.equal(totalVouchersAcrossBatches, 31);

    // ---- store-level cross-checks (independent of the stage functions' own tallies) ----
    assert.equal(await store.count('vouchers', { extraction_run_id: runId }), 40);
    assert.equal(await store.count('queue_items', {}), 31);
    assert.equal(await store.count('queue_items', { status: 'POSTED' }), 31);
    assert.equal(await store.count('api_attempts', {}), 31, 'exactly one API attempt per posted voucher');
    assert.equal(await store.count('migration_batches', {}), 2);
    const postedVouchers = (await store.find('vouchers', { extraction_run_id: runId })).filter((v) => v.zoho_record_id);
    assert.equal(postedVouchers.length, 31);
    assert.equal(new Set(postedVouchers.map((v) => v.zoho_record_id)).size, 31, 'every posted voucher has a distinct target id');

    // ---- pre-deploy proof: every stored row is within the live Data Store's declared
    //      column limits (varchar max_length / text cap), and the specific fields the
    //      task calls out stay well under the 10,000-char text cap with headroom. ----
    assert.equal(store.catalystFake.assertWithinLimits(), true);

    // ---- pre-deploy proof: `vouchers` has 43 columns (44 with ROWID), past the live
    //      30-selected-column ZCQL cap (docs/CATALYST_REFERENCES.md, 2026-09-15) — every
    //      find('vouchers', ...) call above (the pipeline reads vouchers heavily) had to
    //      go through catalyst.js's column-chunking path. Asserting the counter is >0
    //      here proves that path is actually exercised by this end-to-end run, not
    //      silently bypassed (e.g. by a stray `columns` override or a test double). ----
    assert.ok(
      store.stats().chunkedQueries > 0,
      'expected at least one column-chunked ZCQL query — the vouchers table has 43 columns, past the 30-column cap'
    );

    const previewRows = await store.find('preview_payloads', {});
    assert.equal(previewRows.length, 31);
    for (const p of previewRows) {
      assert.ok(p.payload_json.length < TEXT_ASSERT_CAP, `preview_payloads.payload_json too long: ${p.payload_json.length}`);
    }

    const snapshotRows = await store.find('books_snapshots', {});
    assert.equal(snapshotRows.length, 4, '2 batches x (BASELINE + POST_RUN)');
    for (const s of snapshotRows) {
      assert.ok(s.balances_json.length < TEXT_ASSERT_CAP, `books_snapshots.balances_json too long: ${s.balances_json.length}`);
      // Documented fallback (schema.catalyst.js's `books_snapshots` comment): if a real
      // snapshot ever exceeded the cap, the recommended fix is to store a truncated
      // marker (`{"_truncated":true}`) rather than fail the insert — not implemented in
      // src/core/balance_bridge.js and not expected to trigger against these small
      // synthetic fixtures (asserted above).
      if (s.records_json) assert.ok(s.records_json.length < TEXT_ASSERT_CAP);
    }

    const exceptionRows = await store.find('exceptions', { run_id: runId });
    const exceptionsByCategory = countByCategory(exceptionRows, 'category');
    assert.ok(exceptionsByCategory.RECONCILIATION_DIFFERENCE >= 7);

    // ---- rerun over the same manifest: DUPLICATE_MANIFEST, no duplicate work ----
    const before = {
      vouchers: await store.count('vouchers', {}),
      queue: await store.count('queue_items', {}),
      posted: await store.count('queue_items', { status: 'POSTED' }),
      attempts: await store.count('api_attempts', {}),
      batches: await store.count('migration_batches', {}),
    };

    const ingest2 = await runIngestStage(ctx, { inbox, archive, inboxRef, workerId: 'run-pipeline' });
    assert.equal(ingest2.outcome, 'DUPLICATE_MANIFEST');
    assert.equal(ingest2.runId, runId);

    const layerA2 = await runLayerAStage(ctx, { runId, run: ingest2.run });
    assert.equal(layerA2.reconAStatus, 'PASS_WITH_APPROVED_EXCEPTIONS', 'incremental rerun reuses the already-approved Layer A recon run, not a fresh one');

    const after = {
      vouchers: await store.count('vouchers', {}),
      queue: await store.count('queue_items', {}),
      posted: await store.count('queue_items', { status: 'POSTED' }),
      attempts: await store.count('api_attempts', {}),
      batches: await store.count('migration_batches', {}),
    };
    assert.deepEqual(after, before, 'rerun must not create vouchers, queue items, attempts or batches');
  } finally {
    await store.close();
    rmSync(env.tmpRoot, { recursive: true, force: true });
  }
});
