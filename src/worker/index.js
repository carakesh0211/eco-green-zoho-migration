// Worker loop (CONTRACTS.md §W). `runOnce(ctx, deps)` walks every complete inbox run
// and every QUEUED/MIGRATING/PARTIALLY_MIGRATED batch through as much of the pipeline
// as its durable status allows, tolerant of any single stage failing (logged, then it
// moves on to the next run/batch rather than aborting the whole pass). `main()` polls
// forever. Idempotent by construction: every step is gated on the row's own durable
// status, so re-running (after a crash, or on the next poll tick) never repeats work
// that already advanced the status past that gate.
import { ingestRun } from '../core/ingest.js';
import { summariseRun } from '../core/summarise.js';
import { reconcileLayerA } from '../core/recon_a.js';
import { classifyRun } from '../core/overlap.js';
import { transformRun } from '../core/transform.js';
import { reconcileLayerB } from '../core/bridge.js';
import { runQueueSlice, resolveUnknownOutcomes } from './executor.js';
import { nowIso, newCorrelationId } from '../core/ids.js';
import { log } from '../core/log.js';

const ACTIVE_BATCH_STATUSES = ['QUEUED', 'MIGRATING', 'PARTIALLY_MIGRATED'];

let snapshot = { workerId: null, lastRunAt: null, lastOutcome: null, counts: {} };

/** Current worker health, for GET /api/worker/health and scripts/run-pipeline.js. */
export function health() {
  return { ...snapshot, counts: { ...snapshot.counts } };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Runs every pipeline stage the run's current status permits, in one pass, stopping
 * (but not throwing) on the first stage that cannot proceed automatically (Layer A
 * FAIL needs an approved exception or a fix; anything else is a hard stop for now). */
async function processRun(ctx, deps, runId) {
  for (;;) {
    const run = await ctx.store.get('extraction_runs', runId);
    if (!run) return;

    if (run.status === 'STAGED') {
      await summariseRun(ctx, { runId, summaryVersion: deps.summaryVersion ?? 'sum_v1' });
      continue;
    }
    if (run.status === 'SUMMARISED') {
      const recon = await reconcileLayerA(ctx, { runId, tolerance: deps.tolerance ?? '0.00' });
      if (recon.status === 'FAIL') return; // needs an approved exception or a data fix
      continue;
    }
    if (run.status === 'SOURCE_RECONCILED') {
      await classifyRun(ctx, { runId, spEvidence: deps.spEvidence ?? [], ruleVersion: deps.cutoverRuleVersion ?? 'cut_v1' });
      continue;
    }
    if (run.status === 'CLASSIFIED') {
      await transformRun(ctx, { runId, transformationVersion: deps.transformationVersion ?? 'tx_v1' });
      continue;
    }
    if (run.status === 'TRANSFORMED') {
      // reconcileLayerB does not move the run's own status (see bridge.js), so guard
      // on "has Layer B ever run for this run" instead of the run status, or every
      // poll tick would insert a fresh recon_runs row forever.
      const existingB = await ctx.store.findOne('recon_runs', { run_id: runId, layer: 'B' });
      if (!existingB) await reconcileLayerB(ctx, { runId });
      return;
    }
    return; // RECEIVED/CLAIMED/VALIDATION_FAILED/SOURCE_RECON_FAILED/EXCEPTION: nothing automatic to do
  }
}

/** A crashed worker can leave an extraction_run stuck at CLAIMED past its
 * claim_expires_at. ingest.js's own insert-then-claim design cannot safely resume a
 * partially-ingested run in place (re-running ingestRun would collide on the
 * manifest's primary key/sha256), so this only restores visibility (RECEIVED, audited)
 * for operator attention rather than silently re-driving the pipeline — correctness
 * over automation for a financial migration. */
async function reclaimExpiredRunClaims(ctx, workerId) {
  const { store } = ctx;
  const stuck = await store.find('extraction_runs', { status: 'CLAIMED' });
  const now = nowIso();
  let reclaimed = 0;
  for (const run of stuck) {
    if (!run.claim_expires_at || run.claim_expires_at >= now) continue;
    const released = await store.releaseClaim('extraction_runs', run.id, {
      workerId: run.claimed_by, newStatus: 'RECEIVED',
    });
    if (released) {
      reclaimed += 1;
      await ctx.audit.emit({
        actor: workerId, action: 'WORKER.RECLAIM_EXPIRED_RUN_CLAIM', entityType: 'extraction_runs', entityId: run.id,
        before: { status: 'CLAIMED' }, after: { status: 'RECEIVED' }, correlationId: ctx.correlationId, branchCode: run.branch_code,
      });
    }
  }
  return reclaimed;
}

/** One full pass: ingest every complete inbox run, drive each run's pipeline as far
 * as it can go, drain active batches' queue slices, and resolve UNKNOWN_OUTCOME items.
 * Never throws — every stage is wrapped so one bad run/batch cannot stop the pass. */
export async function runOnce(ctx, deps) {
  const { inbox, archive, client, workerId } = deps;
  const counts = {
    inboxRunsSeen: 0, ingested: 0, ingestErrors: 0,
    runsProcessed: 0, runErrors: 0,
    batchesDrained: 0, batchErrors: 0,
    reclaimedRunClaims: 0,
  };

  try {
    counts.reclaimedRunClaims = await reclaimExpiredRunClaims(ctx, workerId);
  } catch (err) {
    log('error', 'worker.reclaimExpiredRunClaims failed', { error: err.message });
  }

  let inboxRuns = [];
  try {
    inboxRuns = await inbox.listRuns();
  } catch (err) {
    log('error', 'worker.inbox.listRuns failed', { error: err.message });
  }
  counts.inboxRunsSeen = inboxRuns.length;

  for (const run of inboxRuns) {
    try {
      const result = await ingestRun(ctx, { inbox, archive, inboxRef: run.inboxRef, workerId });
      if (result.outcome !== 'CLAIM_LOST') {
        // Safe to hide from future listRuns() calls: DUPLICATE_MANIFEST/STAGED/
        // VALIDATION_FAILED/EXCEPTION are all terminal for this inbox folder.
        // CLAIM_LOST means another worker is actively handling it right now — leave
        // it visible so its own claim-expiry reclaim can find it if that worker dies.
        try { await inbox.markPicked(run.inboxRef, { workerId }); } catch { /* best-effort */ }
      }
      if (result.outcome === 'STAGED') counts.ingested += 1;
    } catch (err) {
      counts.ingestErrors += 1;
      log('error', 'worker.ingestRun failed', { inboxRef: run.inboxRef, error: err.message });
    }
  }

  const allRuns = await ctx.store.find('extraction_runs', {});
  for (const run of allRuns) {
    try {
      await processRun(ctx, deps, run.id);
      counts.runsProcessed += 1;
    } catch (err) {
      counts.runErrors += 1;
      log('error', 'worker.processRun failed', { runId: run.id, error: err.message });
    }
  }

  if (client) {
    for (const status of ACTIVE_BATCH_STATUSES) {
      const batches = await ctx.store.find('migration_batches', { status });
      for (const batch of batches) {
        try {
          await runQueueSlice(ctx, {
            client, batchId: batch.id, workerId,
            maxItems: deps.maxItemsPerBatch ?? 50, timeBudgetMs: deps.timeBudgetMsPerBatch ?? 30_000,
          });
          await resolveUnknownOutcomes(ctx, { client, batchId: batch.id });
          counts.batchesDrained += 1;
        } catch (err) {
          counts.batchErrors += 1;
          log('error', 'worker.runQueueSlice/resolveUnknownOutcomes failed', { batchId: batch.id, error: err.message });
        }
      }
    }
  }

  snapshot = {
    workerId,
    lastRunAt: nowIso(),
    lastOutcome: (counts.ingestErrors || counts.runErrors || counts.batchErrors) ? 'PARTIAL' : 'OK',
    counts,
  };
  return snapshot;
}

/** DEFAULT_LEASE_MS: best-effort mutual exclusion window (CONTRACTS.md task note). Kept
 * as a plain function (not a module-level constant) so tests that flip
 * WORKER_LEASE_MS between calls are never seeing a value captured at import time. */
function leaseMs() {
  return Number(process.env.WORKER_LEASE_MS) || 600_000;
}

/**
 * Scans recent WORKER.START audit events for a lease still held by a DIFFERENT worker id
 * (a WORKER.START within `leaseMs()` with no later WORKER.STOP from that same actor).
 * Documented as BEST-EFFORT mutual exclusion (CONTRACTS.md §W task note): this is an
 * audit-trail heuristic, not a distributed lock — it protects against the common case
 * (a second `npm run worker` started by mistake against the same Catalyst store) but
 * cannot prevent a determined concurrent start the way store.claim() prevents a queue
 * item from being processed twice.
 */
export async function findConflictingSingletonLease(store, { workerId, now = Date.now() } = {}) {
  const starts = await store.find('audit_events', { action: 'WORKER.START' }, { orderBy: 'created_at DESC', limit: 50 });
  const lease = leaseMs();
  for (const startEvent of starts) {
    if (startEvent.actor === workerId) continue;
    const startedAtMs = Date.parse(startEvent.created_at);
    if (Number.isNaN(startedAtMs) || now - startedAtMs >= lease) continue; // lease expired
    const stops = await store.find('audit_events', { action: 'WORKER.STOP', actor: startEvent.actor }, { orderBy: 'created_at DESC', limit: 10 });
    const stoppedAfterStart = stops.some((stopEvent) => {
      const stoppedAtMs = Date.parse(stopEvent.created_at);
      return !Number.isNaN(stoppedAtMs) && stoppedAtMs >= startedAtMs;
    });
    if (!stoppedAfterStart) {
      return { workerId: startEvent.actor, startedAt: startEvent.created_at };
    }
  }
  return null;
}

export class WorkerStartupRefusedError extends Error {
  constructor(reason, details = {}) {
    super(reason);
    this.code = 'WORKER_STARTUP_REFUSED';
    Object.assign(this, details);
  }
}

/**
 * Runs the fail-closed startup checks and, if they pass, acquires the singleton lease by
 * writing the WORKER.START audit event. Throws WorkerStartupRefusedError (never touches
 * `process` itself) so tests can call it directly against a fake store instead of running
 * the whole `main()` poll loop.
 *   - A Catalyst-backed store (`claimSemantics === 'BEST_EFFORT'`) refuses to start at all
 *     unless `workerMode === 'singleton'` (CONTRACTS.md task note: claim()/releaseClaim()
 *     are non-atomic there, so more than one worker instance risks double-claiming the
 *     same queue item).
 *   - In singleton mode, also refuses if another worker id's WORKER.START is still within
 *     its lease window with no matching WORKER.STOP (best-effort mutual exclusion; see
 *     findConflictingSingletonLease's header for what this can and cannot guarantee).
 */
export async function assertWorkerCanStart({ store, audit, workerId, workerMode }) {
  const isCatalystStore = store.claimSemantics === 'BEST_EFFORT';
  if (isCatalystStore && workerMode !== 'singleton') {
    throw new WorkerStartupRefusedError(
      'WORKER_MODE must be "singleton" to run the worker loop against a best-effort-claim (Catalyst) store',
      { workerMode }
    );
  }

  if (workerMode === 'singleton') {
    const conflict = await findConflictingSingletonLease(store, { workerId });
    if (conflict) {
      throw new WorkerStartupRefusedError(
        'another WORKER.START is within its lease window with no matching WORKER.STOP (best-effort mutual exclusion)',
        { conflict }
      );
    }
    await audit.emit({
      actor: workerId,
      action: 'WORKER.START',
      entityType: 'worker',
      entityId: workerId,
      reason: `singleton lease acquired (WORKER_LEASE_MS=${leaseMs()}, best-effort mutual exclusion)`,
      correlationId: newCorrelationId(),
    });
  }

  return { ok: true };
}

export async function main() {
  const workerId = process.env.WORKER_ID ?? 'worker-local-1';
  const pollIntervalMs = Number(process.env.WORKER_POLL_INTERVAL_MS) || 5000;
  // Deployed config defaults to 'disabled': this MVP's dashboard does not run the worker
  // loop at all (the Development seed endpoint drives the pipeline stages in-process
  // instead) — see .env.example and src/server/routes/dev.js.
  const workerMode = process.env.WORKER_MODE ?? 'disabled';

  const { openStore } = await import('../adapters/store/index.js');
  const { openInbox } = await import('../adapters/inbox/index.js');
  const { openArchive } = await import('../adapters/archive/index.js');
  const { createAudit } = await import('../core/audit.js');
  const { createBooksClient, loadBooksConfig } = await import('../books/index.js');

  const store = await openStore({});
  const audit = createAudit(store);

  try {
    await assertWorkerCanStart({ store, audit, workerId, workerMode });
  } catch (err) {
    if (err instanceof WorkerStartupRefusedError) {
      log('error', 'worker.refused_to_start', { reason: err.message, ...err });
      process.exitCode = 2;
      await store.close();
      return;
    }
    throw err;
  }

  if (workerMode === 'singleton') {
    const emitStop = () => {
      audit
        .emit({ actor: workerId, action: 'WORKER.STOP', entityType: 'worker', entityId: workerId, reason: 'graceful shutdown', correlationId: newCorrelationId() })
        .catch((err) => log('error', 'worker.stop_audit_failed', { error: err.message }));
    };
    process.once('SIGTERM', emitStop);
    process.once('SIGINT', emitStop);
  }

  const inbox = await openInbox({});
  const archive = await openArchive({});
  const booksConfig = loadBooksConfig();
  const client = createBooksClient({ driver: booksConfig.driver, config: booksConfig, store, audit });

  log('info', 'worker.main starting', { workerId, pollIntervalMs, workerMode, driver: booksConfig.driver });

  for (;;) {
    const ctx = { store, audit, correlationId: newCorrelationId(), actor: workerId, actorRole: 'operator' };
    try {
      const result = await runOnce(ctx, { inbox, archive, client, workerId });
      log('info', 'worker.runOnce complete', { workerId, outcome: result.lastOutcome, counts: result.counts });
    } catch (err) {
      log('error', 'worker.runOnce crashed (continuing)', { workerId, error: err.message });
    }
    await sleep(pollIntervalMs);
  }
}

const isMainModule = (() => {
  try {
    return import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('worker/index.js') || process.argv[1]?.endsWith('worker\\index.js');
  } catch {
    return false;
  }
})();

if (isMainModule) {
  main();
}
