// Read-only console/agent routes. See CONTRACTS.md §H (read list) and §G (bot reuses
// these unchanged — same auth, role, and branch-scoping machinery).
import express from 'express';

function wrap(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

/** Post-fetch branch filter for list endpoints that were not given an explicit ?branch=. */
function filterByBranch(rows, user, branchField = 'branch_code') {
  const branches = user?.branches ?? [];
  if (branches.includes('*')) return rows;
  const allowed = new Set(branches);
  return rows.filter((r) => allowed.has(r[branchField]));
}

export function createReadRouter({ store, deps = {}, auth }) {
  const router = express.Router();

  router.get(
    '/runs',
    auth.authenticate(),
    wrap(async (req, res) => {
      const { branch } = req.query;
      if (branch && !auth.branchAllowed(req.user, branch)) {
        return auth.deny(req, res, { status: 403, error: 'FORBIDDEN', reason: `BRANCH_SCOPE:${branch}` });
      }
      const where = branch ? { branch_code: branch } : {};
      const rows = await store.find('extraction_runs', where, { orderBy: 'created_at DESC' });
      res.json({ runs: filterByBranch(rows, req.user) });
    })
  );

  router.get(
    '/runs/:id',
    auth.authenticate(),
    wrap(async (req, res) => {
      const run = await store.get('extraction_runs', req.params.id);
      if (!run) return res.status(404).json({ error: 'NOT_FOUND' });
      if (!auth.branchAllowed(req.user, run.branch_code)) {
        return auth.deny(req, res, { status: 403, error: 'FORBIDDEN', reason: `BRANCH_SCOPE:${run.branch_code}` });
      }
      const files = await store.find('source_files', { run_id: run.id });
      const vouchers = await store.find('vouchers', { extraction_run_id: run.id });
      const voucherCounts = {};
      for (const v of vouchers) voucherCounts[v.disposition] = (voucherCounts[v.disposition] ?? 0) + 1;
      res.json({ run, files, voucher_counts: voucherCounts, voucher_total: vouchers.length });
    })
  );

  router.get(
    '/runs/:id/summary',
    auth.authenticate(),
    wrap(async (req, res) => {
      const run = await store.get('extraction_runs', req.params.id);
      if (!run) return res.status(404).json({ error: 'NOT_FOUND' });
      if (!auth.branchAllowed(req.user, run.branch_code)) {
        return auth.deny(req, res, { status: 403, error: 'FORBIDDEN', reason: `BRANCH_SCOPE:${run.branch_code}` });
      }
      const summaries = await store.find('summaries', { run_id: run.id });
      res.json({ run_id: run.id, summaries });
    })
  );

  // Layer A results were only reachable by knowing the recon-run id, which nothing
  // surfaced — the dashboard's Layer A card was unusable on a fresh page load. This
  // mirrors /runs/:id/bridge for layer 'A'.
  router.get(
    '/runs/:id/recon-a',
    auth.authenticate(),
    wrap(async (req, res) => {
      const run = await store.get('extraction_runs', req.params.id);
      if (!run) return res.status(404).json({ error: 'NOT_FOUND' });
      if (!auth.branchAllowed(req.user, run.branch_code)) {
        return auth.deny(req, res, { status: 403, error: 'FORBIDDEN', reason: `BRANCH_SCOPE:${run.branch_code}` });
      }
      const layerA = await store.find('recon_runs', { run_id: run.id, layer: 'A' }, { orderBy: 'created_at DESC' });
      const latest = layerA[0] ?? null;
      const results = latest ? await store.find('recon_results', { recon_run_id: latest.id }) : [];
      res.json({ recon_run: latest, results });
    })
  );

  router.get(
    '/runs/:id/bridge',
    auth.authenticate(),
    wrap(async (req, res) => {
      const run = await store.get('extraction_runs', req.params.id);
      if (!run) return res.status(404).json({ error: 'NOT_FOUND' });
      if (!auth.branchAllowed(req.user, run.branch_code)) {
        return auth.deny(req, res, { status: 403, error: 'FORBIDDEN', reason: `BRANCH_SCOPE:${run.branch_code}` });
      }
      const layerB = await store.find('recon_runs', { run_id: run.id, layer: 'B' }, { orderBy: 'created_at DESC' });
      const latest = layerB[0] ?? null;
      const results = latest ? await store.find('recon_results', { recon_run_id: latest.id }) : [];
      res.json({ recon_run: latest, results });
    })
  );

  router.get(
    '/recon/:reconRunId',
    auth.authenticate(),
    wrap(async (req, res) => {
      const reconRun = await store.get('recon_runs', req.params.reconRunId);
      if (!reconRun) return res.status(404).json({ error: 'NOT_FOUND' });
      if (!auth.branchAllowed(req.user, reconRun.branch_code)) {
        return auth.deny(req, res, { status: 403, error: 'FORBIDDEN', reason: `BRANCH_SCOPE:${reconRun.branch_code}` });
      }
      const results = await store.find('recon_results', { recon_run_id: reconRun.id });
      res.json({ recon_run: reconRun, results });
    })
  );

  router.get(
    '/vouchers',
    auth.authenticate(),
    wrap(async (req, res) => {
      const { run, disposition, status, branch } = req.query;
      if (branch && !auth.branchAllowed(req.user, branch)) {
        return auth.deny(req, res, { status: 403, error: 'FORBIDDEN', reason: `BRANCH_SCOPE:${branch}` });
      }
      const where = {};
      if (run) where.extraction_run_id = run;
      if (disposition) where.disposition = disposition;
      if (status) where.migration_status = status;
      if (branch) where.branch_code = branch;
      const rows = await store.find('vouchers', where, { orderBy: 'id' });
      res.json({ vouchers: filterByBranch(rows, req.user) });
    })
  );

  router.get(
    '/vouchers/:id',
    auth.authenticate(),
    wrap(async (req, res) => {
      const voucher = await store.get('vouchers', Number(req.params.id));
      if (!voucher) return res.status(404).json({ error: 'NOT_FOUND' });
      if (!auth.branchAllowed(req.user, voucher.branch_code)) {
        return auth.deny(req, res, { status: 403, error: 'FORBIDDEN', reason: `BRANCH_SCOPE:${voucher.branch_code}` });
      }
      const lines = await store.find('source_txn_lines', {
        run_id: voucher.extraction_run_id,
        voucher_id: voucher.source_record_id,
      });
      const overlap = await store.find('overlap_candidates', { voucher_id: voucher.id });
      const previewRows = await store.find('preview_payloads', { voucher_id: voucher.id });
      const preview_payloads = previewRows.map((p) => {
        let payload = null;
        try {
          payload = JSON.parse(p.payload_json);
        } catch {
          payload = null;
        }
        return { ...p, payload_json: payload };
      });
      const queueItems = await store.find('queue_items', { voucher_id: voucher.id });
      const attempts = [];
      for (const qi of queueItems) {
        attempts.push(...(await store.find('api_attempts', { queue_item_id: qi.id })));
      }
      const auditEvents = await store.find('audit_events', { entity_type: 'vouchers', entity_id: String(voucher.id) });
      res.json({
        voucher,
        lines,
        overlap_candidates: overlap,
        preview_payloads,
        queue_items: queueItems,
        api_attempts: attempts,
        audit_events: auditEvents,
      });
    })
  );

  router.get(
    '/exceptions',
    auth.authenticate(),
    wrap(async (req, res) => {
      const { branch, status, category } = req.query;
      if (branch && !auth.branchAllowed(req.user, branch)) {
        return auth.deny(req, res, { status: 403, error: 'FORBIDDEN', reason: `BRANCH_SCOPE:${branch}` });
      }
      const where = {};
      if (branch) where.branch_code = branch;
      if (status) where.status = status;
      if (category) where.category = category;
      const rows = await store.find('exceptions', where, { orderBy: 'created_at DESC' });
      res.json({ exceptions: filterByBranch(rows, req.user) });
    })
  );

  router.get(
    '/cutover',
    auth.authenticate(),
    wrap(async (req, res) => {
      const { branch } = req.query;
      if (branch && !auth.branchAllowed(req.user, branch)) {
        return auth.deny(req, res, { status: 403, error: 'FORBIDDEN', reason: `BRANCH_SCOPE:${branch}` });
      }
      const where = branch ? { branch_code: branch } : {};
      const rows = await store.find('cutover_matrix', where);
      res.json({ cutover: filterByBranch(rows, req.user) });
    })
  );

  router.get(
    '/batches',
    auth.authenticate(),
    wrap(async (req, res) => {
      const { branch } = req.query;
      if (branch && !auth.branchAllowed(req.user, branch)) {
        return auth.deny(req, res, { status: 403, error: 'FORBIDDEN', reason: `BRANCH_SCOPE:${branch}` });
      }
      const where = branch ? { branch_code: branch } : {};
      const rows = await store.find('migration_batches', where, { orderBy: 'created_at DESC' });
      res.json({ batches: filterByBranch(rows, req.user) });
    })
  );

  router.get(
    '/batches/:id',
    auth.authenticate(),
    wrap(async (req, res) => {
      const batch = await store.get('migration_batches', req.params.id);
      if (!batch) return res.status(404).json({ error: 'NOT_FOUND' });
      if (!auth.branchAllowed(req.user, batch.branch_code)) {
        return auth.deny(req, res, { status: 403, error: 'FORBIDDEN', reason: `BRANCH_SCOPE:${batch.branch_code}` });
      }
      const queueItems = await store.find('queue_items', { batch_id: batch.id });
      const queueCounts = {};
      for (const qi of queueItems) queueCounts[qi.status] = (queueCounts[qi.status] ?? 0) + 1;
      const attempts = [];
      for (const qi of queueItems) attempts.push(...(await store.find('api_attempts', { queue_item_id: qi.id })));
      const layerC = await store.find('recon_runs', { batch_id: batch.id, layer: 'C' }, { orderBy: 'created_at DESC' });
      const balanceBridge = await store.find(
        'recon_runs',
        { batch_id: batch.id, layer: 'BALANCE_BRIDGE' },
        { orderBy: 'created_at DESC' }
      );
      res.json({
        batch,
        queue_counts: queueCounts,
        queue_total: queueItems.length,
        attempts,
        latest_layer_c: layerC[0] ?? null,
        latest_balance_bridge: balanceBridge[0] ?? null,
      });
    })
  );

  router.get(
    '/audit',
    auth.authenticate(),
    auth.requireRole('admin', 'operator'),
    wrap(async (req, res) => {
      const { entity, id } = req.query;
      const where = {};
      if (entity) where.entity_type = entity;
      if (id) where.entity_id = String(id);
      const rows = await store.find('audit_events', where, { orderBy: 'created_at DESC', limit: 500 });
      const scoped = rows.filter((r) => !r.branch_code || auth.branchAllowed(req.user, r.branch_code));
      res.json({ audit_events: scoped });
    })
  );

  router.get(
    '/worker/health',
    auth.authenticate(),
    wrap(async (req, res) => {
      if (deps.worker && typeof deps.worker.health === 'function') {
        const health = await deps.worker.health();
        return res.json(health);
      }
      res.json({ ok: false, note: 'worker module not available in this build (src/worker/index.js not present)' });
    })
  );

  return router;
}
