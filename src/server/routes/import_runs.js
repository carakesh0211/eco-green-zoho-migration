// Run import (docs/ECOGREEN_SOURCE.md §Importing a normalised run).
//
//   POST /api/import/runs        operator | admin, IMPORT_ENABLED=true, branch in scope
//   GET  /api/import/runs/:jobId same roles; progress of a job started by this instance
//
// The body carries ONE contract-v1 run already produced by scripts/normalise-ecogreen.js
// (manifest.json + transactions.csv + trial_balance.csv, base64) plus the branch row and
// an optional cutover rule. The files are archived by the configured archive adapter
// (Stratus in the deployment) and ingested through the same ingestRun() the inbox path
// uses, then Layer A, classification/transform and the branch summary run — exactly the
// stage sequence of scripts/run-pipeline.js. Ingest of a real branch takes minutes against
// the Catalyst Data Store, far past AppSail's request cap, so the work runs as a detached
// job (same pattern as POST /api/dev/seed) and the response is 202 + jobId.
//
// Nothing here posts to Zoho Books: the job stops after transform/Layer B, where every
// voucher waits for mapping and approval like any other run.
import express from 'express';
import { gunzipSync } from 'node:zlib';
import { newId, nowIso } from '../../core/ids.js';
import { validateManifest } from '../../core/manifest.js';
import { loadCutoverMatrix } from '../../core/cutover.js';
import { refreshBranchSummary } from '../../core/branch_summary.js';
import { runIngestStage, runLayerAStage, runClassifyTransformBridgeStage } from '../../../scripts/lib/pipeline-stages.js';

const MAX_TOTAL_BYTES = 10 * 1024 * 1024;
const REQUIRED_FILES = ['manifest.json', 'transactions.csv', 'trial_balance.csv'];
const BRANCH_CODE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;

function wrap(fn) {
  return async (req, res, next) => {
    try { await fn(req, res, next); } catch (err) { next(err); }
  };
}

/** Decode the request's base64 files into Buffers. -> { files, totalBytes } or { error } */
export function decodeFiles(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { error: 'files must be an object of file_name -> base64' };
  const files = {};
  let totalBytes = 0;
  for (const [name, b64] of Object.entries(input)) {
    if (!/^[A-Za-z0-9_.-]{1,80}$/.test(name) || name.includes('..')) return { error: `invalid file name: ${name}` };
    if (typeof b64 !== 'string') return { error: `${name}: content must be a base64 string` };
    let buf = Buffer.from(b64, 'base64');
    if (buf.length === 0) return { error: `${name}: empty` };
    // gzip is accepted transparently (magic 1f 8b): a browser-side uploader can send a
    // whole branch run in a few tens of kilobytes. Decoded size still counts against the cap.
    if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
      try { buf = gunzipSync(buf, { maxOutputLength: MAX_TOTAL_BYTES }); } catch { return { error: `${name}: gzip content could not be decoded` }; }
    }
    totalBytes += buf.length;
    if (totalBytes > MAX_TOTAL_BYTES) return { error: `files exceed ${MAX_TOTAL_BYTES} bytes in total` };
    files[name] = buf;
  }
  for (const r of REQUIRED_FILES) if (!files[r]) return { error: `${r} is required` };
  return { files, totalBytes };
}

/** In-memory inbox over the posted files; the only method ingestRun() needs. */
function memoryInbox(files) {
  return {
    async readFile(_inboxRef, fileName) {
      const buf = files[fileName];
      if (!buf) throw new Error(`file not found: ${fileName}`);
      return buf;
    },
  };
}

async function upsertBranch(store, { branch_code, branch_name, zoho_location_id }) {
  const now = nowIso();
  const existing = await store.findOne('branches', { branch_code });
  if (existing) {
    const patch = {};
    if (branch_name && branch_name !== existing.branch_name) patch.branch_name = branch_name;
    if (zoho_location_id && zoho_location_id !== existing.zoho_location_id) patch.zoho_location_id = zoho_location_id;
    if (Object.keys(patch).length === 0) return existing;
    return store.update('branches', branch_code, { ...patch, updated_at: now });
  }
  return store.insert('branches', {
    branch_code,
    branch_name: branch_name || `Branch ${branch_code}`,
    zoho_location_id: zoho_location_id || `LOC-${branch_code}-UNMAPPED`,
    status: 'ACTIVE',
    created_at: now,
    updated_at: now,
  });
}

export async function runImportJob({ store, audit, correlationId, actor, actorRole }, { archive, files, manifest, branch, cutover, progress, spEvidence = [] }) {
  const ctx = { store, audit, correlationId, actor, actorRole };
  const stage = async (name, fn) => {
    progress.stage = name;
    try {
      return await fn();
    } catch (err) {
      progress.failedStage = name;
      progress.error = String(err?.message ?? err).slice(0, 500);
      throw err;
    }
  };
  progress.startedAt = nowIso();
  try {
    await stage('BRANCH', () => upsertBranch(store, branch));
    if (cutover) await stage('CUTOVER', () => loadCutoverMatrix(ctx, [cutover]));
    const ingest = await stage('INGEST', () =>
      runIngestStage(ctx, { inbox: memoryInbox(files), archive, inboxRef: `${branch.branch_code}/${manifest.extraction_run_id}`, workerId: actor }));
    progress.ingest = { outcome: ingest.outcome, runId: ingest.runId, counts: ingest.counts ?? null, errors: ingest.errors ?? null };
    if (ingest.outcome !== 'STAGED' || !ingest.run) {
      progress.outcome = ingest.outcome === 'DUPLICATE_MANIFEST' ? 'DUPLICATE' : 'INGEST_FAILED';
    } else {
      const layerA = await stage('LAYER_A', () => runLayerAStage(ctx, { runId: ingest.runId, run: ingest.run }));
      progress.layerA = { status: layerA.reconAStatus, controls: layerA.controls.length, failing: layerA.failing.length };
      const ctb = await stage('CLASSIFY_TRANSFORM', () =>
        runClassifyTransformBridgeStage(ctx, { runId: ingest.runId, reconAStatus: layerA.reconAStatus, spEvidence, ruleVersion: cutover?.cutover_rule_version ?? 'cut_v1' }));
      progress.classification = ctb.skipped
        ? { skipped: true }
        : { skipped: false, layerB: ctb.layerB?.status ?? null, dispositions: Object.fromEntries(Object.entries(ctb.dispositionCounts?.byDisposition ?? {}).map(([k, v]) => [k, v.count])) };
      progress.outcome = 'IMPORTED';
    }
    await stage('SUMMARY', () => refreshBranchSummary(store, branch.branch_code));
  } catch {
    progress.outcome = progress.outcome ?? 'FAILED';
  } finally {
    progress.finishedAt = nowIso();
    progress.stage = 'DONE';
    try {
      await audit.emit({
        actor, actorRole, action: 'IMPORT.RUN', entityType: 'extraction_runs', entityId: manifest.extraction_run_id,
        after: { outcome: progress.outcome, failedStage: progress.failedStage, error: progress.error, ingest: progress.ingest, layerA: progress.layerA ?? null },
        correlationId, branchCode: branch.branch_code,
      });
    } catch { /* best effort */ }
  }
  return progress;
}

/**
 * createImportRouter({ store, audit, auth, deps: { archive }, environment, importEnabled, runtime })
 */
export function createImportRouter({ store, audit, auth, deps = {}, environment, importEnabled = false, runtime }) {
  const router = express.Router();
  const jobs = new Map();

  router.post(
    '/import/runs',
    auth.authenticate(),
    auth.requireCorrelationId(),
    auth.requireRole('operator', 'admin'),
    wrap(async (req, res) => {
      if (!importEnabled || environment === 'Production') {
        return auth.deny(req, res, { status: 403, error: 'IMPORT_DISABLED', reason: `IMPORT_DISABLED:environment=${environment}`, message: 'Run import is not enabled in this environment (IMPORT_ENABLED).' });
      }
      if (!deps.archive) return res.status(501).json({ error: 'NOT_IMPLEMENTED', message: 'no archive adapter configured' });
      const body = req.body ?? {};
      const branch = body.branch ?? {};
      const branchCode = String(branch.branch_code ?? '');
      if (!BRANCH_CODE_RE.test(branchCode)) return res.status(400).json({ error: 'BAD_REQUEST', message: 'branch.branch_code is required' });
      if (!auth.branchAllowed(req.user, branchCode)) {
        return auth.deny(req, res, { status: 403, error: 'FORBIDDEN', reason: `BRANCH_SCOPE:${branchCode}` });
      }
      const decoded = decodeFiles(body.files);
      if (decoded.error) return res.status(400).json({ error: 'BAD_REQUEST', message: decoded.error });
      let manifestObj;
      try { manifestObj = JSON.parse(decoded.files['manifest.json'].toString('utf8')); } catch { return res.status(400).json({ error: 'BAD_REQUEST', message: 'manifest.json is not valid JSON' }); }
      const validated = validateManifest(manifestObj);
      if (!validated.ok) return res.status(400).json({ error: 'INVALID_MANIFEST', errors: validated.errors });
      if (validated.manifest.branch_code !== branchCode) {
        return res.status(400).json({ error: 'BAD_REQUEST', message: `manifest branch_code ${validated.manifest.branch_code} != ${branchCode}` });
      }
      for (const f of validated.manifest.files) {
        if (!decoded.files[f.file_name]) return res.status(400).json({ error: 'BAD_REQUEST', message: `manifest lists ${f.file_name} but it was not sent` });
      }
      let cutover = null;
      if (body.cutover && typeof body.cutover === 'object') {
        cutover = { ...body.cutover, branch_code: branchCode };
        if (cutover.approval_status === 'APPROVED' && req.user.role !== 'admin') {
          return auth.deny(req, res, { status: 403, error: 'FORBIDDEN', reason: 'CUTOVER_APPROVAL_REQUIRES_ADMIN', message: 'Only an admin may import an APPROVED cutover rule; send it as DRAFT.' });
        }
      }

      const jobId = newId('import');
      const progress = {
        jobId, branchCode, runId: validated.manifest.extraction_run_id, stage: 'QUEUED', startedAt: null, finishedAt: null,
        outcome: null, error: null, failedStage: null, ingest: null, layerA: null, classification: null,
        requestedBy: req.user.id, bytes: decoded.totalBytes,
      };
      jobs.set(jobId, progress);
      const capturedApp = runtime ? await runtime.currentApp().catch(() => null) : null;
      res.status(202).json({ jobId, runId: progress.runId, branchCode });

      const runJob = () => runImportJob(
        { store, audit, correlationId: req.correlationId, actor: req.user.id, actorRole: req.user.role },
        { archive: deps.archive, files: decoded.files, manifest: validated.manifest, branch: { branch_code: branchCode, branch_name: branch.branch_name, zoho_location_id: branch.zoho_location_id }, cutover, progress, spEvidence: deps.spEvidence ?? [] },
      ).catch(() => {});
      if (runtime && capturedApp) runtime.runWithApp(capturedApp, runJob); else runJob();
    })
  );

  router.get(
    '/import/runs/:jobId',
    auth.authenticate(),
    auth.requireRole('operator', 'admin', 'approver', 'viewer'),
    wrap(async (req, res) => {
      const job = jobs.get(String(req.params.jobId));
      if (!job) return res.status(404).json({ error: 'NOT_FOUND', message: 'unknown import job (jobs are kept in memory by the instance that started them)' });
      if (!auth.branchAllowed(req.user, job.branchCode)) {
        return auth.deny(req, res, { status: 403, error: 'FORBIDDEN', reason: `BRANCH_SCOPE:${job.branchCode}` });
      }
      res.json(job);
    })
  );

  return router;
}
