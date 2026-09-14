// Development-only synthetic seed + dashboard summary routes (task note, CONTRACTS.md §H
// style: authenticate -> role -> branch scope -> do the write -> audit). Never reachable
// outside a Development environment with DEV_SEED_ENABLED=true; NEVER in Production.
//
// The seed job replays the same stage sequence as scripts/run-pipeline.js's
// `--approve-known-diffs --through-mock-books` flow (ingest -> Layer A -> approve known
// synthetic diffs -> classify -> transform -> Layer B -> batch -> approve -> enqueue ->
// drain queue -> Layer C -> balance bridge), but against the bundled read-only fixtures
// inbox and the app's own current store/archive, and detached from the HTTP request: the
// route replies 202 immediately (AppSail's 30s request timeout would otherwise cut the
// job off mid-way), and the job keeps running in the background inside the SAME
// AsyncLocalStorage context (same Catalyst app) the request captured, via
// `runtime.runWithApp()`.
import express from 'express';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { newId, newCorrelationId, nowIso } from '../../core/ids.js';
import { ingestRun } from '../../core/ingest.js';
import { summariseRun } from '../../core/summarise.js';
import { reconcileLayerA } from '../../core/recon_a.js';
import { classifyRun } from '../../core/overlap.js';
import { transformRun } from '../../core/transform.js';
import { reconcileLayerB, computeBridge } from '../../core/bridge.js';
import { resolve as resolveException } from '../../core/exceptions.js';
import { createBatch, approveBatch, enqueueBatch } from '../../core/batch.js';
import { runQueueSlice, resolveUnknownOutcomes } from '../../worker/executor.js';
import { reconcileLayerC } from '../../core/recon_c.js';
import { takeSnapshot, balanceBridge } from '../../core/balance_bridge.js';
import { assertTransition, RUN_TRANSITIONS, RUN_STATES } from '../../core/states.js';
import { loadCutoverMatrix } from '../../core/cutover.js';
import { loadMappingRules } from '../../core/mapping.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');
const DEFAULT_CONFIG_ROOT = path.join(PROJECT_ROOT, 'config');

export const DEMO_TAG = '[SYNTHETIC DEMO]';
export const DEMO_OPERATOR = 'demo:synthetic-seed';
export const DEMO_APPROVER = 'demo:finance-lead-synthetic';

function wrap(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function isPassLike(status) {
  return status === 'PASS' || status === 'PASS_WITH_APPROVED_EXCEPTIONS';
}

// ---------------------------------------------------------------- resumable seeding
//
// THE INCIDENT this section fixes: a synthetic seed run against the live Catalyst Data
// Store completed CONFIG_SEEDED -> INGEST -> SUMMARISE -> LAYER_A -> APPROVE_KNOWN_DIFFS
// and then died mid CLASSIFY_TRANSFORM on a platform error. Re-running the seed hit
// `ingestRun`'s DUPLICATE_MANIFEST outcome (the extraction_runs row already exists) and
// the OLD code treated any DUPLICATE_MANIFEST as "nothing to do here", reporting
// outcome: 'ALREADY_SEEDED' — which was actively wrong: the demo data was incomplete.
// The fix: on DUPLICATE_MANIFEST, resolve the EXISTING run row instead of skipping it,
// and drive it forward from wherever it actually stopped (`stagesOwedFor`), deciding
// SEEDED/RESUMED/ALREADY_SEEDED from the verified END STATE (`assessRunCompleteness`),
// never from the ingest outcome alone.

export const SEED_STAGE = Object.freeze({
  SUMMARISE: 'SUMMARISE',
  LAYER_A: 'LAYER_A',
  APPROVE_KNOWN_DIFFS: 'APPROVE_KNOWN_DIFFS',
  CLASSIFY: 'CLASSIFY',
  TRANSFORM: 'TRANSFORM',
  LAYER_B: 'LAYER_B',
  BATCHES: 'BATCHES',
});

/**
 * Pure. Given a run's CURRENT `extraction_runs.status`, returns the ordered list of
 * SEED_STAGE names still owed to it, per the RUN_TRANSITIONS table in
 * src/core/states.js — the sole authority on which jumps are legal; this function
 * never invents a path RUN_TRANSITIONS doesn't already allow, so driving these stages
 * in order can never hand `assertTransition` an illegal from/to pair:
 *
 *   STAGED               -[SUMMARISE]-> SUMMARISED -[LAYER_A]-> SOURCE_RECONCILED | SOURCE_RECON_FAILED
 *   SUMMARISED           -[LAYER_A]-> SOURCE_RECONCILED | SOURCE_RECON_FAILED
 *   SOURCE_RECON_FAILED  -[APPROVE_KNOWN_DIFFS: -> SUMMARISED, re-run LAYER_A]-> SOURCE_RECONCILED
 *   SOURCE_RECONCILED    -[CLASSIFY]-> CLASSIFIED
 *   CLASSIFIED           -[TRANSFORM]-> TRANSFORMED
 *   TRANSFORMED/READY_FOR_APPROVAL -> LAYER_B (bridge.js never moves run state) -> BATCHES
 *
 * RECEIVED/CLAIMED/ARCHIVED are transient states only ever persisted mid-`ingestRun()`
 * (a crash inside ingest itself, before it reaches STAGED/VALIDATION_FAILED/EXCEPTION) —
 * how much of that step actually committed is unknowable from here, so — like
 * VALIDATION_FAILED and EXCEPTION, which are the demo's own intentional failure trail —
 * they are deliberately never auto-resumed: `[]` in every case.
 */
export function stagesOwedFor(status) {
  switch (status) {
    case RUN_STATES.STAGED:
      return [
        SEED_STAGE.SUMMARISE, SEED_STAGE.LAYER_A, SEED_STAGE.APPROVE_KNOWN_DIFFS,
        SEED_STAGE.CLASSIFY, SEED_STAGE.TRANSFORM, SEED_STAGE.LAYER_B, SEED_STAGE.BATCHES,
      ];
    case RUN_STATES.SUMMARISED:
      return [
        SEED_STAGE.LAYER_A, SEED_STAGE.APPROVE_KNOWN_DIFFS,
        SEED_STAGE.CLASSIFY, SEED_STAGE.TRANSFORM, SEED_STAGE.LAYER_B, SEED_STAGE.BATCHES,
      ];
    case RUN_STATES.SOURCE_RECON_FAILED:
      return [SEED_STAGE.APPROVE_KNOWN_DIFFS, SEED_STAGE.CLASSIFY, SEED_STAGE.TRANSFORM, SEED_STAGE.LAYER_B, SEED_STAGE.BATCHES];
    case RUN_STATES.SOURCE_RECONCILED:
      return [SEED_STAGE.CLASSIFY, SEED_STAGE.TRANSFORM, SEED_STAGE.LAYER_B, SEED_STAGE.BATCHES];
    case RUN_STATES.CLASSIFIED:
      return [SEED_STAGE.TRANSFORM, SEED_STAGE.LAYER_B, SEED_STAGE.BATCHES];
    case RUN_STATES.TRANSFORMED:
    case RUN_STATES.READY_FOR_APPROVAL:
      return [SEED_STAGE.LAYER_B, SEED_STAGE.BATCHES];
    case RUN_STATES.RECEIVED:
    case RUN_STATES.CLAIMED:
    case RUN_STATES.ARCHIVED:
    case RUN_STATES.VALIDATION_FAILED:
    case RUN_STATES.EXCEPTION:
    default:
      return [];
  }
}

const TERMINAL_QUEUE_STATUSES = new Set(['POSTED', 'FAILED_FINAL', 'DEAD_LETTER']); // see QUEUE_TRANSITIONS in states.js

/**
 * Verifies the END STATE of one run's migration — never the ingest/outcome flags that
 * caused the real incident (DUPLICATE_MANIFEST -> assumed 'ALREADY_SEEDED'). A run is
 * "complete" when:
 *   1. every voucher of the run has a non-PENDING disposition, AND
 *   2. at least one migration_batches row exists for the run, AND
 *   3. every queue_items row for those batches sits in a terminal status.
 * A run intentionally left at VALIDATION_FAILED or EXCEPTION (the demo's failure trail
 * — see stagesOwedFor) is reported complete on its own terms: nothing further will, or
 * should, ever happen to it, so it is not "missing" a batch it was never meant to get.
 * Exported standalone so both runSeedJob and tests can ask "did this actually finish?"
 * without re-deriving the rule.
 */
export async function assessRunCompleteness(store, runId) {
  const run = await store.get('extraction_runs', runId);
  if (!run) return { complete: false, reasons: ['RUN_NOT_FOUND'] };

  if (run.status === RUN_STATES.VALIDATION_FAILED || run.status === RUN_STATES.EXCEPTION) {
    return {
      complete: true,
      reasons: [`status ${run.status} is a terminal, intentionally-never-auto-resumed state (see stagesOwedFor)`],
    };
  }

  const reasons = [];
  const vouchers = await store.find('vouchers', { extraction_run_id: runId });
  const pending = vouchers.filter((v) => (v.disposition ?? 'PENDING') === 'PENDING');
  reasons.push(
    pending.length === 0
      ? `all ${vouchers.length} voucher(s) have a non-PENDING disposition`
      : `${pending.length} of ${vouchers.length} voucher(s) still PENDING disposition`
  );

  const batches = await store.find('migration_batches', { run_id: runId });
  reasons.push(batches.length > 0 ? `${batches.length} migration batch(es) exist for this run` : 'no migration batch exists for this run yet');

  let nonTerminal = 0;
  let queueItemCount = 0;
  for (const b of batches) {
    const items = await store.find('queue_items', { batch_id: b.id });
    queueItemCount += items.length;
    nonTerminal += items.filter((i) => !TERMINAL_QUEUE_STATUSES.has(i.status)).length;
  }
  if (batches.length > 0) {
    reasons.push(
      nonTerminal === 0
        ? `all ${queueItemCount} queue item(s) across this run's batches are terminal`
        : `${nonTerminal} of ${queueItemCount} queue item(s) are not yet terminal`
    );
  }

  const complete = pending.length === 0 && batches.length > 0 && nonTerminal === 0;
  return { complete, reasons };
}

/** DUPLICATE_MANIFEST means `ingestRun()` returned no runId (src/core/ingest.js step 1:
 * `return { outcome: 'DUPLICATE_MANIFEST' }`). Prefer a runId ingestRun DID return, in
 * case that ever changes upstream; otherwise resolve the existing row's id the only
 * other way available — read the SAME manifest.json ingestRun() itself just read and
 * use its `extraction_run_id` (manifest.js's own primary key for the row). */
async function resolveDuplicateRunId(inbox, run, ingestResult) {
  if (ingestResult && ingestResult.runId) return ingestResult.runId;
  try {
    const manifestBytes = await inbox.readFile(run.inboxRef, 'manifest.json');
    const manifest = JSON.parse(manifestBytes.toString('utf8'));
    return manifest?.extraction_run_id ?? null;
  } catch {
    return null;
  }
}

/**
 * Advances one run through whatever SEED_STAGE entries it still owes, re-reading
 * `runRow.status` after every write instead of assuming — a freshly-STAGED run and a
 * resumed SOURCE_RECONCILED run both fall through these exact same branches. Mirrors
 * the single-pass pipeline scripts/lib/pipeline-stages.js uses for the CLI, adapted to
 * be safely callable against whatever state a prior invocation left behind.
 * -> { runRow, stagesRun } — stagesRun lists (in order) the SEED_STAGE names this call
 * actually executed for this run.
 */
async function driveRunForward({ operatorCtx, approverCtx, store, client, spEvidence, runRow, stage }) {
  const stagesRun = [];

  if (runRow.status === RUN_STATES.STAGED) {
    await stage(SEED_STAGE.SUMMARISE, () => summariseRun(operatorCtx, { runId: runRow.id }));
    stagesRun.push(SEED_STAGE.SUMMARISE);
    runRow = await store.get('extraction_runs', runRow.id);
  }

  let recon = null;
  if (runRow.status === RUN_STATES.SUMMARISED) {
    recon = await stage(SEED_STAGE.LAYER_A, () => reconcileLayerA(operatorCtx, { runId: runRow.id }));
    stagesRun.push(SEED_STAGE.LAYER_A);
    runRow = await store.get('extraction_runs', runRow.id);
  }

  if (runRow.status === RUN_STATES.SOURCE_RECON_FAILED) {
    await stage(SEED_STAGE.APPROVE_KNOWN_DIFFS, async () => {
      const open = (await store.find('exceptions', { run_id: runRow.id, category: 'RECONCILIATION_DIFFERENCE' })).filter(
        (e) => e.status === 'OPEN' || e.status === 'ASSIGNED'
      );
      for (const e of open) {
        await resolveException(approverCtx, {
          id: e.id,
          status: 'APPROVED_EXCEPTION',
          actor: DEMO_APPROVER,
          rootCause: `${DEMO_TAG} known synthetic defect documented in fixtures EXPECTED.md`,
          // exceptions.disposition is a short varchar(32) code on the Catalyst schema
          // (catalyst/iac/schema.catalyst.js) — the longer explanation lives in
          // rootCause (an unbounded text column) instead.
          disposition: `${DEMO_TAG} approved`,
        });
      }
      runRow = await store.get('extraction_runs', runRow.id);
      if (open.length && runRow.status === RUN_STATES.SOURCE_RECON_FAILED) {
        assertTransition(RUN_TRANSITIONS, 'run', runRow.status, RUN_STATES.SUMMARISED);
        await store.update('extraction_runs', runRow.id, { status: RUN_STATES.SUMMARISED, updated_at: nowIso() });
        recon = await reconcileLayerA(operatorCtx, { runId: runRow.id });
      }
    });
    stagesRun.push(SEED_STAGE.APPROVE_KNOWN_DIFFS);
    runRow = await store.get('extraction_runs', runRow.id);
  }

  if (recon && !isPassLike(recon.status)) {
    return { runRow, stagesRun }; // cannot proceed automatically past a real Layer A FAIL
  }

  if (runRow.status === RUN_STATES.SOURCE_RECONCILED) {
    await stage(SEED_STAGE.CLASSIFY, () => classifyRun(operatorCtx, { runId: runRow.id, spEvidence, ruleVersion: 'cut_v1' }));
    stagesRun.push(SEED_STAGE.CLASSIFY);
    runRow = await store.get('extraction_runs', runRow.id);
  }

  if (runRow.status === RUN_STATES.CLASSIFIED) {
    await stage(SEED_STAGE.TRANSFORM, () => transformRun(operatorCtx, { runId: runRow.id }));
    stagesRun.push(SEED_STAGE.TRANSFORM);
    runRow = await store.get('extraction_runs', runRow.id);
  }

  let layerB = null;
  if (runRow.status === RUN_STATES.TRANSFORMED || runRow.status === RUN_STATES.READY_FOR_APPROVAL) {
    layerB = await stage(SEED_STAGE.LAYER_B, () => reconcileLayerB(operatorCtx, { runId: runRow.id }));
    stagesRun.push(SEED_STAGE.LAYER_B);
  }

  if (!layerB || !isPassLike(layerB.status)) {
    return { runRow, stagesRun };
  }

  const vouchers = await store.find('vouchers', { extraction_run_id: runRow.id });
  const periods = [...new Set(vouchers.filter((v) => v.disposition === 'MIGRATE' && v.target_payload_hash).map((v) => v.period))].sort();

  await stage(SEED_STAGE.BATCHES, async () => {
    for (const period of periods) {
      const batch = await createBatch(operatorCtx, { runId: runRow.id, branchCode: runRow.branch_code, period, createdBy: DEMO_OPERATOR });
      if (batch.status !== 'READY_FOR_APPROVAL') continue;
      await approveBatch(approverCtx, {
        batchId: batch.id,
        approver: DEMO_APPROVER,
        approverRole: 'approver',
        reason: `${DEMO_TAG} synthetic demo batch approval (pilot dashboard seed)`,
      });
      await enqueueBatch(operatorCtx, { batchId: batch.id });
      await takeSnapshot(operatorCtx, { client, branchCode: runRow.branch_code, kind: 'BASELINE', batchId: batch.id });
      await runQueueSlice(operatorCtx, { client, batchId: batch.id, workerId: DEMO_OPERATOR, maxItems: 500, timeBudgetMs: 60_000 });
      await resolveUnknownOutcomes(operatorCtx, { client, batchId: batch.id });
      await takeSnapshot(operatorCtx, { client, branchCode: runRow.branch_code, kind: 'POST_RUN', batchId: batch.id });
      await reconcileLayerC(operatorCtx, { client, batchId: batch.id });
      await balanceBridge(operatorCtx, { batchId: batch.id });
    }
  });
  stagesRun.push(SEED_STAGE.BATCHES);

  return { runRow, stagesRun };
}

async function readJsonArrayIfExists(p) {
  try {
    const parsed = JSON.parse(await readFile(p, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** config/mapping-rules.json's column is `approval_status`; mapping.js#loadMappingRules
 * reads `row.status` (same mismatch documented in scripts/seed-fixtures.js). */
function normalizeMappingRow(row) {
  const { approval_status, ...rest } = row;
  return { ...rest, status: approval_status ?? row.status };
}

/** Loads cutover/mapping/Smart-Pharma-evidence config into the store and mock client —
 * everything scripts/seed-fixtures.js#seedFixtures does EXCEPT copying fixture files onto
 * local disk (AppSail's working directory is write-restricted; the bundled inbox adapter
 * reads fixtures/synthetic/* directly instead — see src/adapters/inbox/bundled.js). */
export async function seedDemoConfig(ctx, { client, configRoot = DEFAULT_CONFIG_ROOT } = {}) {
  const { store } = ctx;
  const now = nowIso();
  const branchCode = 'PILOT01';

  const existingBranch = await store.findOne('branches', { branch_code: branchCode });
  if (!existingBranch) {
    await store.insert('branches', {
      branch_code: branchCode,
      branch_name: `Pilot branch ${branchCode}`,
      zoho_location_id: 'LOC-PILOT01',
      status: 'ACTIVE',
      created_at: now,
      updated_at: now,
    });
  }

  const cutoverRaw = await readJsonArrayIfExists(path.join(configRoot, 'cutover-matrix.json'));
  const mappingRaw = await readJsonArrayIfExists(path.join(configRoot, 'mapping-rules.json'));
  const spEvidence = await readJsonArrayIfExists(path.join(configRoot, 'smart-pharma-evidence.json'));

  if (cutoverRaw.length) await loadCutoverMatrix(ctx, cutoverRaw);
  if (mappingRaw.length) await loadMappingRules(ctx, mappingRaw.map(normalizeMappingRow));
  if (client && typeof client.seedRecords === 'function' && spEvidence.length) {
    client.seedRecords(
      spEvidence.map((row) => ({
        id: row.books_record_id ?? undefined,
        module: row.books_module,
        date: row.business_date,
        sp_batch_ref: row.sp_batch_ref,
        custom_fields: {},
      }))
    );
  }

  return { spEvidence };
}

/** Aggregate figures for the dashboard Overview section / GET /api/dev/summary. Kept as a
 * standalone export so the seed job can reuse it to report idempotent, always-current
 * counts (a rerun that does no new work reports the SAME counts as before, rather than a
 * zeroed-out delta). */
export async function buildDevSummary(store, { branchCode } = {}) {
  const runsWhere = branchCode ? { branch_code: branchCode } : {};
  const runs = await store.find('extraction_runs', runsWhere, { orderBy: 'created_at DESC', limit: 25 });

  const vouchers = [];
  for (const run of runs) {
    vouchers.push(...(await store.find('vouchers', { extraction_run_id: run.id })));
  }
  const dispositionBridge = computeBridge(vouchers);

  const layerStatus = { A: null, B: null, C: null, BALANCE_BRIDGE: null };
  for (const layer of Object.keys(layerStatus)) {
    const rows = await store.find('recon_runs', { layer });
    const scoped = branchCode ? rows.filter((r) => r.branch_code === branchCode || runs.some((run) => run.id === r.run_id)) : rows;
    const latest = scoped.reduce((best, r) => (!best || r.created_at > best.created_at ? r : best), null);
    layerStatus[layer] = latest?.status ?? null;
  }

  const batchesWhere = branchCode ? { branch_code: branchCode } : {};
  const batches = await store.find('migration_batches', batchesWhere, { orderBy: 'created_at DESC', limit: 25 });
  const batchesByStatus = {};
  for (const b of batches) batchesByStatus[b.status] = (batchesByStatus[b.status] ?? 0) + 1;

  const queueCounts = {};
  for (const b of batches) {
    const items = await store.find('queue_items', { batch_id: b.id });
    for (const item of items) queueCounts[item.status] = (queueCounts[item.status] ?? 0) + 1;
  }

  const exceptionsWhere = branchCode ? { branch_code: branchCode } : {};
  const exceptions = await store.find('exceptions', exceptionsWhere);
  const exceptionsByCategory = {};
  for (const e of exceptions) exceptionsByCategory[e.category] = (exceptionsByCategory[e.category] ?? 0) + 1;

  return {
    runs: runs.map((r) => ({ id: r.id, branchCode: r.branch_code, status: r.status })),
    dispositionBridge,
    layerStatus,
    batches: { total: batches.length, byStatus: batchesByStatus },
    queueCounts,
    exceptionsByCategory,
    posting: { enabled: false, note: 'Production posting can never be enabled from this console (CONTRACTS.md §H).' },
  };
}

/**
 * runSeedJob(ctx, deps) — exported standalone so tests can run it inline (no HTTP, no
 * background detachment) against a fake/mock store+client.
 *   ctx: { store, audit, correlationId }
 *   deps: { inbox, archive, client, jobId, progress } — `progress` is a plain mutable
 *     object the caller owns (see createDevRouter's in-memory job registry below); this
 *     function only ever assigns fields onto it, never replaces it, so a status poll
 *     reading the same object mid-job sees live updates.
 */
export async function runSeedJob(ctx, deps) {
  const { store, audit, correlationId = newCorrelationId() } = ctx;
  const { inbox, archive, client, jobId, progress = {} } = deps;

  const operatorCtx = { store, audit, correlationId, actor: DEMO_OPERATOR, actorRole: 'operator' };
  const approverCtx = { store, audit, correlationId, actor: DEMO_APPROVER, actorRole: 'approver' };

  async function stage(name, fn) {
    progress.stage = name;
    try {
      await audit.emit({
        actor: DEMO_OPERATOR,
        actorRole: 'operator',
        action: `DEV.SEED.${name}`,
        entityType: 'dev_seed_job',
        entityId: jobId,
        reason: `${DEMO_TAG} stage ${name}`,
        correlationId,
      });
    } catch {
      // Progress audit is best-effort; never let it abort the seed job itself.
    }
    return fn();
  }

  progress.jobId = jobId;
  progress.startedAt = progress.startedAt ?? nowIso();
  progress.outcome = null;
  progress.error = null;
  progress.failedStage = null;
  progress.completeness = null;
  progress.stagesRun = [];

  try {
    const { spEvidence } = await stage('CONFIG_SEEDED', () => seedDemoConfig(operatorCtx, { client }));

    const runs = await inbox.listRuns();
    let anyIngested = false;
    let anyStagesRun = false;
    const completenessReports = [];

    for (const run of runs) {
      const ingestResult = await stage('INGEST', () =>
        ingestRun(operatorCtx, { inbox, archive, inboxRef: run.inboxRef, workerId: DEMO_OPERATOR })
      );
      if (ingestResult.outcome === 'CLAIM_LOST') continue; // another worker holds the claim; try again next invocation

      const isDuplicate = ingestResult.outcome === 'DUPLICATE_MANIFEST';
      let runId;
      if (isDuplicate) {
        // THE INCIDENT: this used to `continue` here unconditionally, which is exactly
        // what made a rerun over a mid-pipeline-crashed run report ALREADY_SEEDED.
        // Resolve the EXISTING row instead of skipping it.
        runId = await resolveDuplicateRunId(inbox, run, ingestResult);
      } else {
        anyIngested = true; // genuinely new ingest work this invocation (STAGED, or a fresh VALIDATION_FAILED/EXCEPTION fixture)
        runId = ingestResult.runId;
      }
      if (!runId) continue; // DUPLICATE_MANIFEST but the existing row couldn't be resolved: skip, as before

      const runRow = await store.get('extraction_runs', runId);
      if (!runRow) continue;

      const owed = stagesOwedFor(runRow.status);
      if (owed.length === 0) {
        // VALIDATION_FAILED/EXCEPTION (the demo's intentional failure trail) or a run
        // stuck mid-ingestRun(): never auto-resumed — see stagesOwedFor's doc comment.
        completenessReports.push({ runId, ...(await assessRunCompleteness(store, runId)) });
        continue;
      }

      const preCompleteness = await assessRunCompleteness(store, runId);
      if (preCompleteness.complete) {
        // Verified against the END STATE, not the ingest outcome: this run already has
        // every voucher dispositioned, at least one batch, and every queue item
        // terminal. Re-running LAYER_B/BATCHES against it would be pure churn.
        completenessReports.push({ runId, ...preCompleteness });
        continue;
      }

      const { runRow: advancedRun, stagesRun: ranHere } = await driveRunForward({
        operatorCtx, approverCtx, store, client, spEvidence, runRow, stage,
      });
      if (ranHere.length > 0) {
        anyStagesRun = true;
        progress.stagesRun.push(...ranHere);
      }
      completenessReports.push({ runId, ...(await assessRunCompleteness(store, advancedRun.id)) });
    }

    const summary = await buildDevSummary(store, { branchCode: 'PILOT01' });
    const counts = {
      runs: summary.runs.length,
      posted: summary.queueCounts.POSTED ?? 0,
      exceptions: Object.values(summary.exceptionsByCategory).reduce((a, b) => a + b, 0),
    };

    const overallComplete = completenessReports.length > 0 && completenessReports.every((r) => r.complete);
    const completenessReasons = completenessReports.flatMap((r) => r.reasons.map((reason) => `${r.runId}: ${reason}`));
    progress.completeness = { complete: overallComplete, reasons: completenessReasons };

    // Outcome is decided from what THIS invocation actually did (anyIngested/
    // anyStagesRun), with ALREADY_SEEDED additionally requiring the verified end state
    // to be complete — never inferred from the ingest outcome alone (that inference is
    // the bug this whole module exists to fix).
    let outcome;
    if (anyIngested) outcome = 'SEEDED';
    else if (anyStagesRun) outcome = 'RESUMED';
    else outcome = overallComplete ? 'ALREADY_SEEDED' : 'RESUMED';

    progress.outcome = outcome;
    progress.counts = counts;
    progress.finishedAt = nowIso();
    await stage(outcome === 'SEEDED' ? 'DONE' : outcome, () => {});
    return { outcome, counts };
  } catch (err) {
    progress.outcome = 'FAILED';
    progress.error = String(err?.message ?? err);
    progress.failedStage = progress.stage;
    progress.finishedAt = nowIso();
    // Populate counts with whatever was established before the failure (best-effort —
    // a platform error that killed the job might also make this query fail; that's fine,
    // `counts` just stays whatever it was, never a false-empty null that hides real work).
    try {
      const summary = await buildDevSummary(store, { branchCode: 'PILOT01' });
      progress.counts = {
        runs: summary.runs.length,
        posted: summary.queueCounts.POSTED ?? 0,
        exceptions: Object.values(summary.exceptionsByCategory).reduce((a, b) => a + b, 0),
      };
    } catch {
      /* best-effort */
    }
    try {
      await audit.emit({
        actor: DEMO_OPERATOR,
        actorRole: 'operator',
        action: 'DEV.SEED.FAILED',
        entityType: 'dev_seed_job',
        entityId: jobId,
        reason: `${DEMO_TAG} seed job failed: ${progress.error}`,
        correlationId,
      });
    } catch {
      /* best-effort */
    }
    throw err;
  }
}

/**
 * createDevRouter({ store, audit, auth, deps, environment, devSeedEnabled, runtime })
 *   deps: { inbox, archive, client } — the app's OWN bundled inbox / current archive
 *     adapter / mock Books client, injected so tests can supply fakes.
 *   runtime: optional { currentApp, runWithApp } (src/server/catalyst_runtime.js) — when
 *     given, the seed job is detached via runtime.runWithApp() so it keeps resolving the
 *     SAME per-request Catalyst app after the response is sent; when omitted (sqlite/local
 *     deployments) the job is simply detached with no ALS re-entry needed.
 */
export function createDevRouter({ store, audit, auth, deps = {}, environment, devSeedEnabled, runtime }) {
  const router = express.Router();
  const jobs = new Map(); // jobId -> progress object
  let latestJobId = null;

  function seedIsAllowed() {
    return environment === 'Development' && devSeedEnabled === true;
  }

  router.post(
    '/dev/seed',
    auth.authenticate(),
    auth.requireCorrelationId(),
    auth.requireRole('admin'),
    wrap(async (req, res) => {
      if (environment === 'Production' || !seedIsAllowed()) {
        return auth.deny(req, res, {
          status: 403,
          error: 'DEV_SEED_DISABLED',
          reason: `DEV_SEED_DISABLED:environment=${environment}`,
          message: 'The synthetic seed endpoint is only available in a Development environment with DEV_SEED_ENABLED=true.',
        });
      }

      // Coalesce concurrent POSTs into the one currently-running job rather than kicking
      // off a second overlapping pass over the same fixtures.
      if (latestJobId) {
        const existing = jobs.get(latestJobId);
        if (existing && existing.outcome === null) {
          return res.status(202).json({ jobId: latestJobId });
        }
      }

      const jobId = newId('devseed');
      const progress = {
        jobId, stage: 'QUEUED', startedAt: null, finishedAt: null, outcome: null, error: null,
        failedStage: null, counts: null, completeness: null, stagesRun: [],
      };
      jobs.set(jobId, progress);
      latestJobId = jobId;

      const correlationId = req.correlationId;
      const capturedApp = runtime ? await runtime.currentApp().catch(() => null) : null;

      res.status(202).json({ jobId });

      const runJob = () => runSeedJob({ store, audit, correlationId }, { ...deps, jobId, progress }).catch(() => {
        // Failure is already recorded on `progress` inside runSeedJob(); nothing further
        // to do here (there is no HTTP response left to send).
      });

      if (runtime && capturedApp) {
        runtime.runWithApp(capturedApp, runJob);
      } else {
        runJob();
      }
    })
  );

  router.get(
    '/dev/seed/status',
    auth.authenticate(),
    auth.requireRole('admin'),
    wrap(async (req, res) => {
      const jobId = req.query.jobId || latestJobId;
      if (!jobId || !jobs.has(jobId)) {
        return res.status(404).json({ error: 'NOT_FOUND', message: 'No seed job with that id (or no seed job has run yet).' });
      }
      res.json(jobs.get(jobId));
    })
  );

  router.get(
    '/dev/summary',
    auth.authenticate(),
    wrap(async (req, res) => {
      const branch = req.query.branch || (req.user.branches?.includes('*') ? undefined : req.user.branches?.[0]);
      if (branch && !auth.branchAllowed(req.user, branch)) {
        return auth.deny(req, res, { status: 403, error: 'FORBIDDEN', reason: `BRANCH_SCOPE:${branch}` });
      }
      const summary = await buildDevSummary(store, { branchCode: branch });
      res.json(summary);
    })
  );

  return router;
}
