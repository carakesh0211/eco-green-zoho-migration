// Reusable pipeline stage functions, extracted from scripts/run-pipeline.js so the same
// orchestration logic can be driven from more than one place: the CLI script (which
// prints a human report from the returned structured results) and, per the Catalyst
// dashboard pipeline goal, a deployed seed/run endpoint that wants the structured
// results directly (see catalyst-functions skill) rather than parsed console text.
//
// Every function here takes `(ctx, deps)` where `ctx = { store, audit, correlationId,
// actor, actorRole }` (the CONTRACTS.md convention used throughout src/core/*) and
// returns a plain, JSON-serialisable result object — no console output. Callers decide
// how (or whether) to present the result.
import { ingestRun } from '../../src/core/ingest.js';
import { summariseRun } from '../../src/core/summarise.js';
import { reconcileLayerA } from '../../src/core/recon_a.js';
import { classifyRun } from '../../src/core/overlap.js';
import { transformRun } from '../../src/core/transform.js';
import { computeBridge, reconcileLayerB } from '../../src/core/bridge.js';
import { resolve as resolveException } from '../../src/core/exceptions.js';
import { createBatch, approveBatch, enqueueBatch } from '../../src/core/batch.js';
import { runQueueSlice, resolveUnknownOutcomes } from '../../src/worker/executor.js';
import { reconcileLayerC } from '../../src/core/recon_c.js';
import { takeSnapshot, balanceBridge } from '../../src/core/balance_bridge.js';
import { assertTransition, RUN_TRANSITIONS } from '../../src/core/states.js';
import { nowIso } from '../../src/core/ids.js';

export function isPassLike(status) {
  return status === 'PASS' || status === 'PASS_WITH_APPROVED_EXCEPTIONS';
}

/**
 * Ingest one inbox run. Mirrors what scripts/run-pipeline.js did inline: the manifest is
 * read directly (not only through ingestRun) so a runId is available for the caller's
 * follow-up store lookups even on outcomes where ingestRun itself doesn't return one
 * (DUPLICATE_MANIFEST, CLAIM_LOST, an early VALIDATION_FAILED). Always resolves `run`
 * (the extraction_runs row, or null) and `files` (source_files rows, [] when none) when
 * a runId could be determined, regardless of outcome — harmless no-op queries when
 * there's nothing to find yet.
 *
 * -> { outcome, runId, run, files, errors?, counts? } (outcome/errors/counts per
 *    src/core/ingest.js#ingestRun's documented return shapes).
 */
export async function runIngestStage(ctx, { inbox, archive, inboxRef, workerId }) {
  const { store } = ctx;

  let manifestRunId = null;
  try {
    const manifestBuf = await inbox.readFile(inboxRef, 'manifest.json');
    const manifest = JSON.parse(manifestBuf.toString('utf8'));
    manifestRunId = manifest?.extraction_run_id ?? null;
  } catch {
    // Unreadable/invalid JSON: ingestRun below will surface and report this itself.
  }

  const ingestResult = await ingestRun(ctx, { inbox, archive, inboxRef, workerId });
  const runId = ingestResult.runId ?? manifestRunId;

  let run = null;
  let files = [];
  if (runId) {
    run = await store.get('extraction_runs', runId);
    files = await store.find('source_files', { run_id: runId });
  }

  return { ...ingestResult, runId, run, files };
}

/**
 * Runs Layer A when the run just reached STAGED (summarise + reconcileLayerA); otherwise
 * looks up the most recent existing Layer A recon_runs row for the run (an incremental
 * rerun over already-summarised state). Always resolves the recon_results controls for
 * whichever recon run was found/created.
 *
 * -> { reconAStatus, reconARunId, controls, failing, run } (run = the possibly-updated
 *    extraction_runs row).
 */
export async function runLayerAStage(ctx, { runId, run }) {
  const { store } = ctx;
  let reconAStatus = null;
  let reconARunId = null;
  let updatedRun = run;

  if (run.status === 'STAGED') {
    await summariseRun(ctx, { runId });
    const reconOutcome = await reconcileLayerA(ctx, { runId });
    reconAStatus = reconOutcome.status;
    reconARunId = reconOutcome.reconRunId;
    updatedRun = await store.get('extraction_runs', runId);
  } else {
    const existing = await store.find('recon_runs', { run_id: runId, layer: 'A' });
    const latest = existing.length ? existing[existing.length - 1] : null;
    reconAStatus = latest?.status ?? null;
    reconARunId = latest?.id ?? null;
  }

  let controls = [];
  let failing = [];
  if (reconARunId) {
    controls = await store.find('recon_results', { recon_run_id: reconARunId });
    failing = controls.filter((r) => r.status !== 'MATCH');
  }

  return { reconAStatus, reconARunId, controls, failing, run: updatedRun };
}

/**
 * Approves every OPEN/ASSIGNED RECONCILIATION_DIFFERENCE exception for the run as
 * `approverActor` and re-runs Layer A. A no-op (returns `applied: false`) when Layer A
 * already passed or there is no Layer A recon run to approve exceptions against — the
 * caller (CLI flag / operator action) still decides WHETHER to call this at all; this
 * only encodes the business precondition for it doing anything.
 *
 * -> { applied, approvedCount, reconAStatus, reconARunId, run }.
 */
export async function approveKnownDiffsStage(ctx, { runId, reconAStatus, reconARunId, approverActor = 'finance.lead' }) {
  const { store } = ctx;
  if (isPassLike(reconAStatus) || !reconARunId) {
    return { applied: false, approvedCount: 0, reconAStatus, reconARunId, run: await store.get('extraction_runs', runId) };
  }

  const approverCtx = { ...ctx, actor: approverActor, actorRole: 'approver' };
  const open = (await store.find('exceptions', { run_id: runId, category: 'RECONCILIATION_DIFFERENCE' }))
    .filter((e) => e.status === 'OPEN' || e.status === 'ASSIGNED');
  for (const e of open) {
    await resolveException(approverCtx, {
      id: e.id,
      status: 'APPROVED_EXCEPTION',
      actor: approverActor,
      rootCause: 'Known synthetic defect documented in fixtures EXPECTED.md',
      disposition: 'Approved as a pilot demonstration exception; would require finance sign-off on real data',
    });
  }

  let run = await store.get('extraction_runs', runId);
  assertTransition(RUN_TRANSITIONS, 'run', run.status, 'SUMMARISED');
  await store.update('extraction_runs', runId, { status: 'SUMMARISED', updated_at: nowIso() });
  const rerun = await reconcileLayerA(ctx, { runId });
  run = await store.get('extraction_runs', runId);

  return { applied: true, approvedCount: open.length, reconAStatus: rerun.status, reconARunId: rerun.reconRunId, run };
}

/**
 * Classify + transform + Layer B, gated on Layer A having passed (`reconAStatus`); when
 * it hasn't, classification/transform are SKIPPED (never bypassing the states.js
 * RUN_TRANSITIONS guard). The disposition bridge and preview-payload-by-module tallies
 * are always computed from current voucher state, whether or not this run's classify/
 * transform actually executed (an incremental rerun over already-classified vouchers
 * still wants an accurate bridge).
 *
 * -> { skipped, layerB, vouchers, dispositionCounts, previewByModule }.
 */
export async function runClassifyTransformBridgeStage(ctx, { runId, reconAStatus, spEvidence = [], ruleVersion = 'cut_v1' }) {
  const { store } = ctx;
  const skipped = !isPassLike(reconAStatus);
  let layerB = null;

  if (!skipped) {
    await classifyRun(ctx, { runId, spEvidence, ruleVersion });
    await transformRun(ctx, { runId });
    layerB = await reconcileLayerB(ctx, { runId });
  }

  const vouchers = await store.find('vouchers', { extraction_run_id: runId });
  const dispositionCounts = computeBridge(vouchers);

  const previewRows = await store.find('preview_payloads', {});
  const previewByModule = {};
  for (const p of previewRows) {
    const voucher = await store.get('vouchers', p.voucher_id);
    if (voucher?.extraction_run_id !== runId) continue;
    previewByModule[p.target_module] = (previewByModule[p.target_module] ?? 0) + 1;
  }

  return { skipped, layerB, vouchers, dispositionCounts, previewByModule };
}

/**
 * Drives the approved (MIGRATE + payload) population of `vouchers` through
 * createBatch -> approveBatch -> enqueueBatch -> BASELINE snapshot -> runQueueSlice ->
 * resolveUnknownOutcomes -> POST_RUN snapshot -> Layer C -> balance bridge, one batch per
 * distinct period. Only actually runs batches when `layerB` passed — callers should only
 * invoke this stage at all when they intend mock-Books delivery (it has real side
 * effects: batches, queue items, mock postings), mirroring scripts/run-pipeline.js's
 * `--through-mock-books` flag gate.
 *
 * `approvedPopulation`/`verificationFailures`/`verificationStatus` are always computed
 * (even when `ran` is false) so a caller can still report a correct verdict — e.g.
 * Layer B failed but the approved population is non-empty is itself a failure to report,
 * not silence.
 *
 * -> { ran, batches: [{ period, batch, enqueued?, slice?, unknownResolved?, byStatus?,
 *      layerC?, bridge? }], exercised, postedTotal, approvedPopulation,
 *      verificationFailures, verificationStatus: 'PASSED'|'FAILED'|'NOT_APPLICABLE' }.
 */
export async function runMockBooksStage(ctx, {
  client, branchCode, runId, layerB, vouchers,
  workerId = 'run-pipeline', operatorActor = 'operator.local', approverActor = 'finance.lead',
}) {
  const { store } = ctx;
  const approvedPopulation = vouchers.filter((v) => v.disposition === 'MIGRATE' && v.target_payload_hash).length;
  const result = {
    ran: false, batches: [], exercised: 0, postedTotal: 0,
    approvedPopulation, verificationFailures: [], verificationStatus: null,
  };

  if (layerB && isPassLike(layerB.status)) {
    result.ran = true;
    const operatorCtx = { ...ctx, actor: operatorActor, actorRole: 'operator' };
    const approverCtx = { ...ctx, actor: approverActor, actorRole: 'approver' };
    const periods = [...new Set(
      vouchers.filter((v) => v.disposition === 'MIGRATE' && v.target_payload_hash).map((v) => v.period)
    )].sort();

    for (const period of periods) {
      const batch = await createBatch(operatorCtx, { runId, branchCode, period, createdBy: operatorActor });
      const entry = { period, batch };
      if (batch.status !== 'READY_FOR_APPROVAL') {
        result.batches.push(entry);
        continue;
      }

      await approveBatch(approverCtx, {
        batchId: batch.id, approver: approverActor, approverRole: 'approver',
        reason: 'pilot dry-run against mock Books',
      });
      const enq = await enqueueBatch(operatorCtx, { batchId: batch.id });
      await takeSnapshot(operatorCtx, { client, branchCode, kind: 'BASELINE', batchId: batch.id });
      const slice = await runQueueSlice(operatorCtx, { client, batchId: batch.id, workerId, maxItems: 500, timeBudgetMs: 60_000 });
      const unk = await resolveUnknownOutcomes(operatorCtx, { client, batchId: batch.id });
      await takeSnapshot(operatorCtx, { client, branchCode, kind: 'POST_RUN', batchId: batch.id });
      const layerC = await reconcileLayerC(operatorCtx, { client, batchId: batch.id });
      const bridge = await balanceBridge(operatorCtx, { batchId: batch.id });
      const items = await store.find('queue_items', { batch_id: batch.id });
      const byStatus = {};
      for (const it of items) byStatus[it.status] = (byStatus[it.status] ?? 0) + 1;

      Object.assign(entry, { enqueued: enq.enqueued, slice, unknownResolved: unk.resolvedPosted, byStatus, layerC, bridge });
      result.batches.push(entry);

      result.exercised += slice.processed;
      result.postedTotal += slice.posted;
      if (layerC.status !== 'PASS' || bridge.status !== 'PASS') {
        result.verificationFailures.push(`batch ${batch.id}: layerC=${layerC.status} bridge=${bridge.status}`);
      }
    }
  }

  if (approvedPopulation > 0 && result.exercised === 0) {
    result.verificationFailures.push(
      `approved population ${approvedPopulation} but 0 queue items were exercised (state already migrated or nothing enqueued)`
    );
  }
  result.verificationStatus = result.verificationFailures.length
    ? 'FAILED'
    : approvedPopulation > 0 ? 'PASSED' : 'NOT_APPLICABLE';

  return result;
}
