// Mutating console/agent routes. See CONTRACTS.md §H (mutating list), §X (exceptions),
// §K/§T (cutover/mapping approve semantics live in states/exceptions; upsert delegates
// to the concurrently-developed core modules injected via `deps`).
//
// Every route here: authenticates, assigns/echoes X-Correlation-Id, applies the §G bot
// action ceiling (botGate), then the route's role requirement, then does the write and
// audits ALLOWED (either directly, or by delegating to a core module that already
// audits per its own CONTRACTS.md entry — never both, to avoid double audit rows).
import express from 'express';
import { assertTransition, BATCH_TRANSITIONS, QUEUE_TRANSITIONS } from '../../core/states.js';
import { nowIso, uk, isIsoDate } from '../../core/ids.js';
import { refreshBranchSummary } from '../../core/branch_summary.js';
import * as exceptionsModule from '../../core/exceptions.js';
import { isBotUser, botMayPerform } from './agent.js';

const MAPPING_RULE_TYPES = ['MODULE_ROUTE', 'LEDGER_ACCOUNT', 'PARTY', 'PAYMENT_MODE', 'TAX'];
const MAPPING_UPSERT_MAX_ROWS = 5000;

function nonEmpty(v) {
  return v !== null && v !== undefined && String(v).trim() !== '';
}

/** -> message naming the first invalid row index, or null when every row is valid. */
function validateMappingRows(rows) {
  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i];
    if (!r || typeof r !== 'object' || Array.isArray(r)) return `row ${i}: must be an object`;
    if (!MAPPING_RULE_TYPES.includes(r.rule_type)) {
      return `row ${i}: rule_type must be one of ${MAPPING_RULE_TYPES.join(', ')}`;
    }
    for (const f of ['source_key', 'target_value', 'mapping_version']) {
      if (!nonEmpty(r[f])) return `row ${i}: ${f} is required`;
    }
    if (!isIsoDate(r.effective_from)) return `row ${i}: effective_from must be a valid YYYY-MM-DD date`;
  }
  return null;
}

function wrap(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

export function createMutateRouter({ store, audit, deps = {}, auth }) {
  const router = express.Router();

  function botGate(actionName) {
    return async (req, res, next) => {
      if (isBotUser(req.user) && !botMayPerform(actionName)) {
        return auth.deny(req, res, {
          status: 403,
          error: 'FORBIDDEN',
          reason: `BOT_CEILING:${actionName}`,
          message: `Bot/agent tokens may not perform '${actionName}'`,
        });
      }
      next();
    };
  }

  function ctxFor(req) {
    return { store, audit, correlationId: req.correlationId, actor: req.user.id, actorRole: req.user.role };
  }

  function notImplemented(res, moduleName) {
    return res.status(501).json({
      error: 'NOT_IMPLEMENTED',
      message: `${moduleName} module is not available in this build (written by a concurrent workstream; see CONTRACTS.md).`,
    });
  }

  // ---- rerun Layer A reconciliation ----
  router.post(
    '/runs/:id/rerun-recon',
    auth.authenticate(),
    auth.requireCorrelationId(),
    botGate('rerun_recon'),
    auth.requireRole('operator', 'admin'),
    wrap(async (req, res) => {
      const run = await store.get('extraction_runs', req.params.id);
      if (!run) return res.status(404).json({ error: 'NOT_FOUND' });
      if (!auth.branchAllowed(req.user, run.branch_code)) {
        return auth.deny(req, res, { status: 403, error: 'FORBIDDEN', reason: `BRANCH_SCOPE:${run.branch_code}` });
      }
      if (!deps.recon_a) return notImplemented(res, 'recon_a');
      const result = await deps.recon_a.reconcileLayerA(ctxFor(req), {
        runId: run.id,
        tolerance: req.body?.tolerance ?? '0.00',
      });
      res.json(result);
    })
  );

  // ---- re-run the transform for a run (e.g. after mapping rules were approved) ----
  router.post(
    '/runs/:id/retransform',
    auth.authenticate(),
    auth.requireCorrelationId(),
    botGate('retransform'),
    auth.requireRole('operator', 'admin'),
    wrap(async (req, res) => {
      const run = await store.get('extraction_runs', req.params.id);
      if (!run) return res.status(404).json({ error: 'NOT_FOUND' });
      if (!auth.branchAllowed(req.user, run.branch_code)) {
        return auth.deny(req, res, { status: 403, error: 'FORBIDDEN', reason: `BRANCH_SCOPE:${run.branch_code}` });
      }
      if (!deps.transform) return notImplemented(res, 'transform');
      let result;
      try {
        result = await deps.transform.retransformRun(ctxFor(req), { runId: run.id });
      } catch (err) {
        if (err?.code === 'NOT_FOUND') return res.status(404).json({ error: err.code, message: err.message });
        if (err?.code === 'INVALID_RUN_STATE' || err?.code === 'BATCH_IN_PROGRESS') {
          return res.status(409).json({ error: err.code, message: err.message });
        }
        throw err;
      }
      try {
        await refreshBranchSummary(store, run.branch_code);
      } catch {
        // best effort: the summary is a derived view and can be refreshed later
      }
      res.json(result);
    })
  );

  // ---- cutover matrix upsert (DRAFT) ----
  router.post(
    '/cutover',
    auth.authenticate(),
    auth.requireCorrelationId(),
    botGate('cutover_upsert'),
    auth.requireRole('admin'),
    wrap(async (req, res) => {
      const rows = Array.isArray(req.body) ? req.body : req.body?.rows;
      if (!Array.isArray(rows) || rows.length === 0) {
        return res.status(400).json({ error: 'BAD_REQUEST', message: 'Body must be an array of rows or { rows: [...] }' });
      }
      for (const r of rows) {
        if (!auth.branchAllowed(req.user, r.branch_code)) {
          return auth.deny(req, res, { status: 403, error: 'FORBIDDEN', reason: `BRANCH_SCOPE:${r.branch_code}` });
        }
      }
      if (!deps.cutover) return notImplemented(res, 'cutover');
      const result = await deps.cutover.loadCutoverMatrix({ store }, rows);
      await audit.emit({
        actor: req.user.id,
        actorRole: req.user.role,
        action: 'CUTOVER.UPSERT',
        entityType: 'cutover_matrix',
        entityId: null,
        before: null,
        after: { count: result.length, branches: [...new Set(rows.map((r) => r.branch_code))] },
        reason: req.body?.reason ?? null,
        correlationId: req.correlationId,
        branchCode: rows.length === 1 ? rows[0].branch_code : null,
      });
      res.json({ cutover: result });
    })
  );

  // ---- cutover matrix approve ----
  router.post(
    '/cutover/:id/approve',
    auth.authenticate(),
    auth.requireCorrelationId(),
    botGate('cutover_approve'),
    auth.requireRole('approver', 'admin'),
    wrap(async (req, res) => {
      const row = await store.get('cutover_matrix', Number(req.params.id));
      if (!row) return res.status(404).json({ error: 'NOT_FOUND' });
      if (!auth.branchAllowed(req.user, row.branch_code)) {
        return auth.deny(req, res, { status: 403, error: 'FORBIDDEN', reason: `BRANCH_SCOPE:${row.branch_code}` });
      }
      const now = nowIso();
      const updated = await store.update('cutover_matrix', row.id, {
        approval_status: 'APPROVED',
        approved_by: req.user.id,
        approved_at: now,
        updated_at: now,
      });
      await audit.emit({
        actor: req.user.id,
        actorRole: req.user.role,
        action: 'CUTOVER.APPROVE',
        entityType: 'cutover_matrix',
        entityId: row.id,
        before: row,
        after: updated,
        reason: req.body?.reason ?? null,
        correlationId: req.correlationId,
        branchCode: row.branch_code,
      });
      res.json(updated);
    })
  );

  // ---- mapping rules upsert (always DRAFT; approval is a separate step) ----
  router.post(
    '/mappings',
    auth.authenticate(),
    auth.requireCorrelationId(),
    botGate('mappings_upsert'),
    auth.requireRole('operator', 'admin'),
    wrap(async (req, res) => {
      const rows = Array.isArray(req.body) ? req.body : req.body?.rows;
      if (!Array.isArray(rows) || rows.length === 0) {
        return res.status(400).json({ error: 'BAD_REQUEST', message: 'Body must be an array of rows or { rows: [...] }' });
      }
      if (rows.length > MAPPING_UPSERT_MAX_ROWS) {
        return res.status(413).json({
          error: 'PAYLOAD_TOO_LARGE',
          message: `At most ${MAPPING_UPSERT_MAX_ROWS} mapping rows per request (got ${rows.length})`,
        });
      }
      const invalid = validateMappingRows(rows);
      if (invalid) return res.status(400).json({ error: 'BAD_REQUEST', message: invalid });
      if (!deps.mapping) return notImplemented(res, 'mapping');

      // Force DRAFT regardless of caller/role; skip rows that would change nothing for an
      // already-APPROVED rule (same uk, same target_value) so a re-upload never demotes it.
      const toLoad = [];
      let unchanged = 0;
      for (const r of rows) {
        const existing = await store.findOne('mapping_rules', { uk: uk(r.rule_type, r.source_key, r.mapping_version) });
        if (existing && existing.status === 'APPROVED' && String(existing.target_value) === String(r.target_value)) {
          unchanged += 1;
          continue;
        }
        toLoad.push({ ...r, status: 'DRAFT', approved_by: null, approved_at: null });
      }
      const result = toLoad.length ? await deps.mapping.loadMappingRules({ store }, toLoad) : [];
      await audit.emit({
        actor: req.user.id,
        actorRole: req.user.role,
        action: 'MAPPING.UPSERT',
        entityType: 'mapping_rules',
        entityId: null,
        before: null,
        after: { count: result.length, upserted: result.length, unchanged },
        reason: req.body?.reason ?? null,
        correlationId: req.correlationId,
      });
      res.json({ mappings: result, upserted: result.length, unchanged });
    })
  );

  // ---- mapping rules bulk approve (by ids or by filter; DRAFT rows only) ----
  router.post(
    '/mappings/approve',
    auth.authenticate(),
    auth.requireCorrelationId(),
    botGate('mappings_approve'),
    auth.requireRole('approver', 'admin'),
    wrap(async (req, res) => {
      const { ids, filter } = req.body ?? {};
      const hasIds = ids !== undefined && ids !== null;
      const hasFilter = filter !== undefined && filter !== null;
      if (hasIds === hasFilter) {
        return res.status(400).json({ error: 'BAD_REQUEST', message: 'Provide exactly one of ids or filter' });
      }
      let candidates = [];
      if (hasIds) {
        if (!Array.isArray(ids) || ids.length === 0 || !ids.every((i) => Number.isInteger(i))) {
          return res.status(400).json({ error: 'BAD_REQUEST', message: 'ids must be a non-empty array of integers' });
        }
        const seen = new Set();
        for (const id of ids) {
          if (seen.has(id)) continue;
          seen.add(id);
          const row = await store.get('mapping_rules', id);
          if (row && row.status === 'DRAFT') candidates.push(row);
        }
      } else {
        if (typeof filter !== 'object' || Array.isArray(filter)) {
          return res.status(400).json({ error: 'BAD_REQUEST', message: 'filter must be an object' });
        }
        const where = { status: 'DRAFT' };
        for (const k of ['rule_type', 'mapping_version', 'source_key']) {
          if (filter[k] !== undefined && filter[k] !== null && filter[k] !== '') where[k] = filter[k];
        }
        candidates = await store.find('mapping_rules', where);
      }
      const now = nowIso();
      const approvedIds = [];
      for (const row of candidates) {
        await store.update('mapping_rules', row.id, {
          status: 'APPROVED',
          approved_by: req.user.id,
          approved_at: now,
          updated_at: now,
        });
        approvedIds.push(row.id);
      }
      await audit.emit({
        actor: req.user.id,
        actorRole: req.user.role,
        action: 'MAPPING.APPROVE_BULK',
        entityType: 'mapping_rules',
        entityId: null,
        before: null,
        after: { count: approvedIds.length, ids: approvedIds },
        reason: req.body?.reason ?? null,
        correlationId: req.correlationId,
      });
      res.json({ approved: approvedIds.length, ids: approvedIds });
    })
  );

  // ---- mapping rule retire (DRAFT | APPROVED -> RETIRED) ----
  router.post(
    '/mappings/:id/retire',
    auth.authenticate(),
    auth.requireCorrelationId(),
    botGate('mappings_retire'),
    auth.requireRole('approver', 'admin'),
    wrap(async (req, res) => {
      const row = await store.get('mapping_rules', Number(req.params.id));
      if (!row) return res.status(404).json({ error: 'NOT_FOUND' });
      if (row.status === 'RETIRED') {
        return res.status(409).json({ error: 'ALREADY_RETIRED', message: 'Mapping rule is already RETIRED' });
      }
      const updated = await store.update('mapping_rules', row.id, { status: 'RETIRED', updated_at: nowIso() });
      await audit.emit({
        actor: req.user.id,
        actorRole: req.user.role,
        action: 'MAPPING.RETIRE',
        entityType: 'mapping_rules',
        entityId: row.id,
        before: row,
        after: updated,
        reason: req.body?.reason ?? null,
        correlationId: req.correlationId,
      });
      res.json(updated);
    })
  );

  // ---- mapping rule approve ----
  router.post(
    '/mappings/:id/approve',
    auth.authenticate(),
    auth.requireCorrelationId(),
    botGate('mappings_approve'),
    auth.requireRole('approver', 'admin'),
    wrap(async (req, res) => {
      const row = await store.get('mapping_rules', Number(req.params.id));
      if (!row) return res.status(404).json({ error: 'NOT_FOUND' });
      const now = nowIso();
      const updated = await store.update('mapping_rules', row.id, {
        status: 'APPROVED',
        approved_by: req.user.id,
        approved_at: now,
        updated_at: now,
      });
      await audit.emit({
        actor: req.user.id,
        actorRole: req.user.role,
        action: 'MAPPING.APPROVE',
        entityType: 'mapping_rules',
        entityId: row.id,
        before: row,
        after: updated,
        reason: req.body?.reason ?? null,
        correlationId: req.correlationId,
      });
      res.json(updated);
    })
  );

  // ---- batch create / approve / enqueue (require the concurrently-built batch.js) ----
  router.post(
    '/batches',
    auth.authenticate(),
    auth.requireCorrelationId(),
    botGate('create_batch'),
    auth.requireRole('operator', 'admin'),
    wrap(async (req, res) => {
      if (!auth.branchAllowed(req.user, req.body?.branchCode)) {
        return auth.deny(req, res, { status: 403, error: 'FORBIDDEN', reason: `BRANCH_SCOPE:${req.body?.branchCode}` });
      }
      if (!deps.batch) return notImplemented(res, 'batch');
      const result = await deps.batch.createBatch(ctxFor(req), {
        runId: req.body.runId,
        branchCode: req.body.branchCode,
        period: req.body.period,
        createdBy: req.user.id,
      });
      res.status(201).json(result);
    })
  );

  router.post(
    '/batches/:id/approve',
    auth.authenticate(),
    auth.requireCorrelationId(),
    botGate('approve_batch'),
    auth.requireRole('approver', 'admin'),
    wrap(async (req, res) => {
      const batch = await store.get('migration_batches', req.params.id);
      if (!batch) return res.status(404).json({ error: 'NOT_FOUND' });
      if (!auth.branchAllowed(req.user, batch.branch_code)) {
        return auth.deny(req, res, { status: 403, error: 'FORBIDDEN', reason: `BRANCH_SCOPE:${batch.branch_code}` });
      }
      if (!deps.batch) return notImplemented(res, 'batch');
      const result = await deps.batch.approveBatch(ctxFor(req), {
        batchId: batch.id,
        approver: req.user.id,
        approverRole: req.user.role,
        reason: req.body?.reason,
      });
      res.json(result);
    })
  );

  router.post(
    '/batches/:id/enqueue',
    auth.authenticate(),
    auth.requireCorrelationId(),
    botGate('enqueue_batch'),
    auth.requireRole('operator', 'admin'),
    wrap(async (req, res) => {
      const batch = await store.get('migration_batches', req.params.id);
      if (!batch) return res.status(404).json({ error: 'NOT_FOUND' });
      if (!auth.branchAllowed(req.user, batch.branch_code)) {
        return auth.deny(req, res, { status: 403, error: 'FORBIDDEN', reason: `BRANCH_SCOPE:${batch.branch_code}` });
      }
      if (!deps.batch) return notImplemented(res, 'batch');
      const result = await deps.batch.enqueueBatch(ctxFor(req), { batchId: batch.id });
      res.json(result);
    })
  );

  // ---- pause / resume (bot-allowed) ----
  router.post(
    '/batches/:id/pause',
    auth.authenticate(),
    auth.requireCorrelationId(),
    botGate('pause_batch'),
    auth.requireRole('operator', 'admin'),
    wrap(async (req, res) => {
      const batch = await store.get('migration_batches', req.params.id);
      if (!batch) return res.status(404).json({ error: 'NOT_FOUND' });
      if (!auth.branchAllowed(req.user, batch.branch_code)) {
        return auth.deny(req, res, { status: 403, error: 'FORBIDDEN', reason: `BRANCH_SCOPE:${batch.branch_code}` });
      }
      assertTransition(BATCH_TRANSITIONS, 'batch', batch.status, 'PAUSED');
      const updated = await store.update('migration_batches', batch.id, { status: 'PAUSED', updated_at: nowIso() });
      await audit.emit({
        actor: req.user.id,
        actorRole: req.user.role,
        action: 'BATCH.PAUSE',
        entityType: 'migration_batches',
        entityId: batch.id,
        before: batch,
        after: updated,
        reason: req.body?.reason ?? null,
        correlationId: req.correlationId,
        branchCode: batch.branch_code,
        batchId: batch.id,
      });
      res.json(updated);
    })
  );

  router.post(
    '/batches/:id/resume',
    auth.authenticate(),
    auth.requireCorrelationId(),
    botGate('resume_batch'),
    auth.requireRole('operator', 'admin'),
    wrap(async (req, res) => {
      const batch = await store.get('migration_batches', req.params.id);
      if (!batch) return res.status(404).json({ error: 'NOT_FOUND' });
      if (!auth.branchAllowed(req.user, batch.branch_code)) {
        return auth.deny(req, res, { status: 403, error: 'FORBIDDEN', reason: `BRANCH_SCOPE:${batch.branch_code}` });
      }
      assertTransition(BATCH_TRANSITIONS, 'batch', batch.status, 'QUEUED');
      const updated = await store.update('migration_batches', batch.id, { status: 'QUEUED', updated_at: nowIso() });
      await audit.emit({
        actor: req.user.id,
        actorRole: req.user.role,
        action: 'BATCH.RESUME',
        entityType: 'migration_batches',
        entityId: batch.id,
        before: batch,
        after: updated,
        reason: req.body?.reason ?? null,
        correlationId: req.correlationId,
        branchCode: batch.branch_code,
        batchId: batch.id,
      });
      res.json(updated);
    })
  );

  // ---- queue item retry (bot-allowed; eligible-only, never UNKNOWN_OUTCOME) ----
  router.post(
    '/queue/:id/retry',
    auth.authenticate(),
    auth.requireCorrelationId(),
    botGate('retry_queue_item'),
    auth.requireRole('operator', 'admin'),
    wrap(async (req, res) => {
      const item = await store.get('queue_items', Number(req.params.id));
      if (!item) return res.status(404).json({ error: 'NOT_FOUND' });
      const batch = item.batch_id ? await store.get('migration_batches', item.batch_id) : null;
      if (batch && !auth.branchAllowed(req.user, batch.branch_code)) {
        return auth.deny(req, res, { status: 403, error: 'FORBIDDEN', reason: `BRANCH_SCOPE:${batch.branch_code}` });
      }

      if (item.status === 'UNKNOWN_OUTCOME') {
        return res.status(409).json({
          error: 'UNKNOWN_OUTCOME_NOT_RETRYABLE',
          message:
            'UNKNOWN_OUTCOME items are never retried directly. Run resolveUnknownOutcomes (deterministic target lookup) instead.',
        });
      }
      if (!['FAILED_RETRYABLE', 'DEAD_LETTER'].includes(item.status)) {
        return res.status(409).json({ error: 'ILLEGAL_TRANSITION', message: `queue item status '${item.status}' is not retryable` });
      }
      if (item.status === 'DEAD_LETTER') {
        if (!req.body?.reason) {
          return res.status(400).json({ error: 'MISSING_REASON', message: 'A reason is required to retry a DEAD_LETTER item.' });
        }
        if (!['operator', 'admin'].includes(req.user.role)) {
          return res.status(403).json({ error: 'FORBIDDEN', message: 'DEAD_LETTER retry requires operator or admin role.' });
        }
      }
      assertTransition(QUEUE_TRANSITIONS, 'queue_item', item.status, 'QUEUED');
      const updated = await store.update('queue_items', item.id, { status: 'QUEUED', run_after: null, updated_at: nowIso() });
      await audit.emit({
        actor: req.user.id,
        actorRole: req.user.role,
        action: 'QUEUE.RETRY',
        entityType: 'queue_items',
        entityId: item.id,
        before: item,
        after: updated,
        reason: req.body?.reason ?? null,
        correlationId: req.correlationId,
        branchCode: batch?.branch_code ?? null,
        batchId: item.batch_id,
      });
      res.json(updated);
    })
  );

  // ---- exception resolve (operator/approver per §X) ----
  router.post(
    '/exceptions/:id/resolve',
    auth.authenticate(),
    auth.requireCorrelationId(),
    botGate('resolve_exception'),
    auth.requireRole('operator', 'approver', 'admin'),
    wrap(async (req, res) => {
      const exc = await store.get('exceptions', Number(req.params.id));
      if (!exc) return res.status(404).json({ error: 'NOT_FOUND' });
      if (!auth.branchAllowed(req.user, exc.branch_code)) {
        return auth.deny(req, res, { status: 403, error: 'FORBIDDEN', reason: `BRANCH_SCOPE:${exc.branch_code}` });
      }
      try {
        const updated = await exceptionsModule.resolve(ctxFor(req), {
          id: exc.id,
          status: req.body?.status,
          rootCause: req.body?.rootCause,
          disposition: req.body?.disposition,
          actor: req.user.id,
        });
        res.json(updated);
      } catch (err) {
        if (err.code === 'FORBIDDEN_ROLE') return res.status(403).json({ error: err.code, message: err.message });
        if (err.code === 'INVALID_RESOLVE_STATUS') return res.status(400).json({ error: err.code, message: err.message });
        if (err.code === 'EXCEPTION_NOT_FOUND') return res.status(404).json({ error: err.code, message: err.message });
        throw err;
      }
    })
  );

  // ---- exception assign (bot-allowed) ----
  router.post(
    '/exceptions/:id/assign',
    auth.authenticate(),
    auth.requireCorrelationId(),
    botGate('assign_exception'),
    auth.requireRole('operator', 'approver', 'admin'),
    wrap(async (req, res) => {
      const exc = await store.get('exceptions', Number(req.params.id));
      if (!exc) return res.status(404).json({ error: 'NOT_FOUND' });
      if (!auth.branchAllowed(req.user, exc.branch_code)) {
        return auth.deny(req, res, { status: 403, error: 'FORBIDDEN', reason: `BRANCH_SCOPE:${exc.branch_code}` });
      }
      const patch = { owner: req.body?.owner ?? req.user.id, updated_at: nowIso() };
      if (exc.status === 'OPEN') patch.status = 'ASSIGNED';
      const updated = await store.update('exceptions', exc.id, patch);
      await audit.emit({
        actor: req.user.id,
        actorRole: req.user.role,
        action: 'EXCEPTION.ASSIGN',
        entityType: 'exceptions',
        entityId: exc.id,
        before: exc,
        after: updated,
        reason: req.body?.reason ?? null,
        correlationId: req.correlationId,
        branchCode: exc.branch_code,
        batchId: exc.batch_id,
      });
      res.json(updated);
    })
  );

  // ---- read-only Books snapshot ----
  router.post(
    '/snapshots',
    auth.authenticate(),
    auth.requireCorrelationId(),
    botGate('snapshots'),
    auth.requireRole('operator', 'admin'),
    wrap(async (req, res) => {
      if (!auth.branchAllowed(req.user, req.body?.branchCode)) {
        return auth.deny(req, res, { status: 403, error: 'FORBIDDEN', reason: `BRANCH_SCOPE:${req.body?.branchCode}` });
      }
      if (!deps.recon_c || !deps.books) return notImplemented(res, 'recon_c/books');
      const result = await deps.recon_c.takeSnapshot(ctxFor(req), {
        client: deps.books,
        branchCode: req.body.branchCode,
        kind: req.body.kind ?? 'BASELINE',
        batchId: req.body.batchId ?? null,
      });
      res.status(201).json(result);
    })
  );

  return router;
}
