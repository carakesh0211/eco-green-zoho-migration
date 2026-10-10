// Re-transform as a detached job.
//
// Re-applying the mapping to a real branch run (hundreds of vouchers, each updated, its
// exceptions resolved and its payload rebuilt against the Catalyst Data Store) takes
// minutes, far past AppSail's 30 s request cap — the same reason run import is a job
// (src/server/routes/import_runs.js). A request only checks the preconditions, starts the
// job and returns 202 + jobId; the console polls GET /api/runs/retransform-jobs/:jobId.
//
// Jobs live in memory on the instance that started them (like import jobs). At most one
// job per run is active: starting another while one is QUEUED/RUNNING returns that job.
import { newId, nowIso } from '../core/ids.js';
import { refreshBranchSummary } from '../core/branch_summary.js';

const ACTIVE = new Set(['QUEUED', 'RUNNING']);
const KEEP_FINISHED = 200;

export function createRetransformJobs({ store, transform, runtime } = {}) {
  const jobs = new Map();
  const activeByRun = new Map();

  function prune() {
    if (jobs.size <= KEEP_FINISHED) return;
    for (const [id, job] of jobs) {
      if (jobs.size <= KEEP_FINISHED) break;
      if (!ACTIVE.has(job.stage)) jobs.delete(id);
    }
  }

  /**
   * Start (or join) the re-transform of one run. `ctx` is the request context the job runs
   * under (actor, correlation id, audit); `trigger` records why it started.
   * Resolves to the job row once it is registered — not when it finishes.
   */
  async function start(ctx, { runId, branchCode, trigger = 'manual' }) {
    const activeId = activeByRun.get(runId);
    if (activeId && jobs.has(activeId) && ACTIVE.has(jobs.get(activeId).stage)) {
      return { job: jobs.get(activeId), joined: true };
    }
    const job = {
      jobId: newId('retransform'), runId, branchCode, trigger, stage: 'QUEUED',
      requestedBy: ctx.actor ?? null, queuedAt: nowIso(), startedAt: null, finishedAt: null,
      result: null, error: null,
    };
    jobs.set(job.jobId, job);
    activeByRun.set(runId, job.jobId);
    prune();

    const capturedApp = runtime ? await runtime.currentApp().catch(() => null) : null;
    const run = async () => {
      job.stage = 'RUNNING';
      job.startedAt = nowIso();
      try {
        job.result = await transform.retransformRun(ctx, { runId });
        job.stage = 'DONE';
      } catch (err) {
        job.stage = 'FAILED';
        job.error = { code: err?.code ?? 'ERROR', message: String(err?.message ?? err) };
      } finally {
        job.finishedAt = nowIso();
        if (activeByRun.get(runId) === job.jobId) activeByRun.delete(runId);
        try {
          if (branchCode) await refreshBranchSummary(store, branchCode);
        } catch {
          // best effort: the summary is a derived view and can be refreshed later
        }
      }
    };
    const kick = () => { run().catch(() => {}); };
    // Detach from the request: the caller has already been answered with 202.
    setImmediate(() => {
      if (runtime && capturedApp) runtime.runWithApp(capturedApp, kick); else kick();
    });
    return { job, joined: false };
  }

  /** Run `fn` after the current request has been answered, in the same Catalyst app
   * context. Resolves (never rejects) when `fn` settles; the last one is kept for tests. */
  let lastDetached = Promise.resolve();
  async function detach(fn) {
    const capturedApp = runtime ? await runtime.currentApp().catch(() => null) : null;
    lastDetached = new Promise((resolve) => {
      setImmediate(() => {
        const go = () => Promise.resolve().then(fn).catch(() => {}).then(resolve);
        if (runtime && capturedApp) runtime.runWithApp(capturedApp, go); else go();
      });
    });
    return lastDetached;
  }

  return {
    start,
    detach,
    settled: () => lastDetached,
    get: (jobId) => jobs.get(String(jobId)) ?? null,
    /** The newest job (active or finished) for a run, or null. */
    latestForRun(runId) {
      let latest = null;
      for (const job of jobs.values()) {
        if (job.runId === runId && (!latest || job.queuedAt >= latest.queuedAt)) latest = job;
      }
      return latest;
    },
  };
}
