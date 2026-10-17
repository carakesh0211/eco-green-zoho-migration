// WorkDrive branch inbox on the AppSail service: runs src/workdrive/job.js as a detached job
// (one at a time, like the import / re-transform jobs), on a schedule
// (WORKDRIVE_SYNC_EVERY_MIN) and on request (POST /api/workdrive/sync — the console, Hermes, or
// a Catalyst cron). Pulled files and state live in the Stratus bucket under "workdrive/" when the
// archive adapter is Stratus, else under WORKDRIVE_DATA_PATH on local disk.
import { newId, nowIso } from '../core/ids.js';
import { workdriveConfig, workdriveClient } from '../workdrive/client.js';
import { localBlobs, stratusBlobs } from '../workdrive/blobs.js';
import { runSync } from '../workdrive/job.js';

const KEEP_LOG = 200;

export function createWorkdriveService({ env = process.env, runtime = null, log = () => {}, deps = {} } = {}) {
  let config = null;
  let configError = null;
  try { config = workdriveConfig(env); } catch (err) { configError = err.message; }
  const blobs = deps.blobs ?? (env.ARCHIVE_ADAPTER === 'stratus' && runtime && env.STRATUS_BUCKET
    ? stratusBlobs({ currentApp: runtime.currentApp, bucketName: env.STRATUS_BUCKET })
    : localBlobs(env.WORKDRIVE_DATA_PATH ?? '.'));
  const wd = deps.wd ?? (config ? workdriveClient(config) : null);
  let current = null;
  let last = null;
  let timer = null;

  function start(trigger, actor = 'system') {
    if (!config && !deps.wd) return { error: 'NOT_CONFIGURED', message: configError };
    if (current) return { job: current, joined: true };
    const job = { jobId: newId('wdsync'), trigger, requestedBy: actor, stage: 'RUNNING', startedAt: nowIso(), finishedAt: null, summary: null, error: null, log: [] };
    current = job;
    const note = (m) => { job.log.push(`${nowIso().slice(11, 19)} ${m}`); if (job.log.length > KEEP_LOG) job.log.shift(); log('info', 'workdrive_sync', { jobId: job.jobId, message: m }); };
    const run = async () => {
      try {
        const s = await runSync({ wd, blobs, rootFolderId: deps.rootFolderId ?? config.rootFolderId, configFolderId: env.WORKDRIVE_CONFIG_FOLDER_ID || null, upload: env.WORKDRIVE_UPLOAD !== 'false', log: note });
        job.summary = { branches: s.branches, pulled: s.pulled, planned: s.planned, tracker: s.tracker };
        job.stage = 'DONE';
      } catch (err) {
        job.stage = 'FAILED';
        job.error = String(err?.message ?? err);
        note(`failed: ${job.error}`);
      } finally {
        job.finishedAt = nowIso();
        last = job;
        current = null;
      }
    };
    const kick = () => { run().catch(() => {}); };
    setImmediate(() => (runtime?.runWithApp && deps.capturedApp ? runtime.runWithApp(deps.capturedApp, kick) : kick()));
    job.done = new Promise((resolve) => { const t = setInterval(() => { if (job.finishedAt) { clearInterval(t); resolve(job); } }, 50); t.unref?.(); });
    return { job, joined: false };
  }

  function schedule() {
    const every = Number(env.WORKDRIVE_SYNC_EVERY_MIN ?? 0);
    if (!(every > 0) || timer || (!config && !deps.wd)) return false;
    timer = setInterval(() => start('schedule'), every * 60_000);
    timer.unref?.();
    setTimeout(() => start('startup'), 60_000).unref?.();
    return true;
  }

  async function status() {
    const tracker = last?.summary?.tracker ?? (await blobs.get('var/workdrive/tracker.csv').catch(() => null))?.toString() ?? null;
    const view = (j) => (j ? { ...j, done: undefined } : null);
    return {
      configured: Boolean(config || deps.wd), configError, scheduleEveryMin: Number(env.WORKDRIVE_SYNC_EVERY_MIN ?? 0) || null,
      storage: blobs.kind, running: view(current), last: view(last), tracker,
    };
  }

  return { start, schedule, status, stop: () => timer && clearInterval(timer) };
}
