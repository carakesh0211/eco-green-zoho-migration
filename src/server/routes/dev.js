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
import { assertTransition, RUN_TRANSITIONS } from '../../core/states.js';
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

  try {
    const { spEvidence } = await stage('CONFIG_SEEDED', () => seedDemoConfig(operatorCtx, { client }));

    const runs = await inbox.listRuns();
    let anyNewWork = false;

    for (const run of runs) {
      const ingestResult = await stage('INGEST', () =>
        ingestRun(operatorCtx, { inbox, archive, inboxRef: run.inboxRef, workerId: DEMO_OPERATOR })
      );
      if (ingestResult.outcome === 'DUPLICATE_MANIFEST' || ingestResult.outcome === 'CLAIM_LOST') continue;
      anyNewWork = true;
      if (ingestResult.outcome !== 'STAGED') continue; // e.g. VALIDATION_FAILED fixtures: leave the exception trail, no further stages

      let runRow = await store.get('extraction_runs', ingestResult.runId);
      await summariseRun(operatorCtx, { runId: runRow.id });
      let recon = await stage('LAYER_A', () => reconcileLayerA(operatorCtx, { runId: runRow.id }));

      if (!isPassLike(recon.status)) {
        await stage('APPROVE_KNOWN_DIFFS', async () => {
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
          if (open.length && runRow.status === 'SOURCE_RECON_FAILED') {
            assertTransition(RUN_TRANSITIONS, 'run', runRow.status, 'SUMMARISED');
            await store.update('extraction_runs', runRow.id, { status: 'SUMMARISED', updated_at: nowIso() });
            recon = await reconcileLayerA(operatorCtx, { runId: runRow.id });
          }
        });
      }

      if (!isPassLike(recon.status)) continue; // cannot proceed automatically past a real Layer A FAIL

      await stage('CLASSIFY_TRANSFORM', async () => {
        await classifyRun(operatorCtx, { runId: runRow.id, spEvidence, ruleVersion: 'cut_v1' });
        await transformRun(operatorCtx, { runId: runRow.id });
      });

      const layerB = await stage('LAYER_B', () => reconcileLayerB(operatorCtx, { runId: runRow.id }));
      if (!isPassLike(layerB.status)) continue;

      const vouchers = await store.find('vouchers', { extraction_run_id: runRow.id });
      const periods = [...new Set(vouchers.filter((v) => v.disposition === 'MIGRATE' && v.target_payload_hash).map((v) => v.period))].sort();

      await stage('BATCHES', async () => {
        for (const period of periods) {
          const batch = await createBatch(operatorCtx, { runId: runRow.id, branchCode: run.branchCode, period, createdBy: DEMO_OPERATOR });
          if (batch.status !== 'READY_FOR_APPROVAL') continue;
          await approveBatch(approverCtx, {
            batchId: batch.id,
            approver: DEMO_APPROVER,
            approverRole: 'approver',
            reason: `${DEMO_TAG} synthetic demo batch approval (pilot dashboard seed)`,
          });
          await enqueueBatch(operatorCtx, { batchId: batch.id });
          await takeSnapshot(operatorCtx, { client, branchCode: run.branchCode, kind: 'BASELINE', batchId: batch.id });
          await runQueueSlice(operatorCtx, { client, batchId: batch.id, workerId: DEMO_OPERATOR, maxItems: 500, timeBudgetMs: 60_000 });
          await resolveUnknownOutcomes(operatorCtx, { client, batchId: batch.id });
          await takeSnapshot(operatorCtx, { client, branchCode: run.branchCode, kind: 'POST_RUN', batchId: batch.id });
          await reconcileLayerC(operatorCtx, { client, batchId: batch.id });
          await balanceBridge(operatorCtx, { batchId: batch.id });
        }
      });
    }

    const summary = await buildDevSummary(store, { branchCode: 'PILOT01' });
    const counts = {
      runs: summary.runs.length,
      posted: summary.queueCounts.POSTED ?? 0,
      exceptions: Object.values(summary.exceptionsByCategory).reduce((a, b) => a + b, 0),
    };
    const outcome = anyNewWork ? 'SEEDED' : 'ALREADY_SEEDED';
    progress.outcome = outcome;
    progress.counts = counts;
    progress.finishedAt = nowIso();
    await stage(outcome === 'SEEDED' ? 'DONE' : 'ALREADY_SEEDED', () => {});
    return { outcome, counts };
  } catch (err) {
    progress.outcome = 'FAILED';
    progress.error = String(err?.message ?? err);
    progress.finishedAt = nowIso();
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
      const progress = { jobId, stage: 'QUEUED', startedAt: null, finishedAt: null, outcome: null, error: null, counts: null };
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
