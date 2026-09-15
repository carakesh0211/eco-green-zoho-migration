// Branch Control Dashboard read/refresh routes. See CONTRACTS.md §H (route style: wrap,
// filterByBranch), src/core/branch_summary.js (row derivation), src/core/branch_list.js
// (query/paging/CSV). Mounted by the app owner as
// `app.use('/api', createBranchesRouter({ store, audit, auth }))` — this file does not
// mount itself into src/server/app.js.
import express from 'express';
import { refreshBranchSummary } from '../../core/branch_summary.js';
import { applyBranchQuery, filterAndSortBranches, toCsv, EQUALITY_FILTER_MAP } from '../../core/branch_list.js';
import { nowIso } from '../../core/ids.js';
import { isBotUser, botMayPerform } from './agent.js';

function wrap(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

/** Branch-scope a list of branch_summaries rows: users whose `branches` does not
 * include '*' only ever see rows whose branch_code is in their scope. Mirrors
 * routes/read.js#filterByBranch (kept local here since that one isn't exported). */
function scopeRows(rows, user) {
  const branches = user?.branches ?? [];
  if (branches.includes('*')) return rows;
  const allowed = new Set(branches);
  return rows.filter((r) => allowed.has(r.branch_code));
}

/** Equality filters that map 1:1 onto branch_summaries columns, pushed down into
 * store.find() before the pure in-memory filter/sort/paging pass. */
function pushdownWhere(query) {
  const where = {};
  for (const [param, column] of Object.entries(EQUALITY_FILTER_MAP)) {
    const value = query?.[param];
    if (value !== undefined && value !== null && value !== '') where[column] = value;
  }
  return where;
}

function expectedBranchCount() {
  return Number(process.env.EXPECTED_BRANCH_COUNT ?? 351);
}

export function createBranchesRouter({ store, audit, auth }) {
  const router = express.Router();

  /** Same shape as routes/mutate.js#botGate, kept local: a bot may only ever reach an
   * action explicitly allowlisted in routes/agent.js#BOT_ALLOWED_ACTIONS. Refresh is
   * deliberately never added there, so this makes the refresh route humans-only
   * without needing a second, bespoke "is this a bot" branch per route. */
  function botGate(actionName) {
    return (req, res, next) => {
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

  // ---- list (any authenticated role, including bots) ----
  router.get(
    '/branches',
    auth.authenticate(),
    wrap(async (req, res) => {
      const startedAt = Date.now();
      const rows = scopeRows(await store.find('branch_summaries', pushdownWhere(req.query)), req.user);
      const { items, total, page, pageSize, totalPages, counts } = applyBranchQuery(rows, req.query);
      res.json({
        items,
        page,
        pageSize,
        total,
        totalPages,
        counts,
        expectedBranchCount: expectedBranchCount(),
        meta: { queryMs: Date.now() - startedAt },
      });
    })
  );

  // ---- CSV export (bots forbidden; must precede '/branches/:code') ----
  router.get(
    '/branches/export.csv',
    auth.authenticate(),
    wrap(async (req, res) => {
      if (isBotUser(req.user)) {
        return auth.deny(req, res, { status: 403, error: 'FORBIDDEN', reason: 'BOT_CEILING:branches_export' });
      }
      const rows = scopeRows(await store.find('branch_summaries', pushdownWhere(req.query)), req.user);
      const { sorted } = filterAndSortBranches(rows, req.query);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="branches.csv"');
      res.send(toCsv(sorted));
    })
  );

  // ---- refresh one branch (operator/admin, humans only) ----
  router.post(
    '/branches/:code/refresh',
    auth.authenticate(),
    auth.requireCorrelationId(),
    botGate('branch_summary_refresh'),
    auth.requireRole('operator', 'admin'),
    wrap(async (req, res) => {
      const code = req.params.code;
      if (!auth.branchAllowed(req.user, code)) {
        return auth.deny(req, res, { status: 403, error: 'FORBIDDEN', reason: `BRANCH_SCOPE:${code}` });
      }
      const before = await store.get('branch_summaries', code);
      let updated;
      try {
        updated = await refreshBranchSummary(store, code, { now: nowIso() });
      } catch (err) {
        if (err?.code === 'BRANCH_NOT_FOUND') return res.status(404).json({ error: err.code, message: err.message });
        throw err;
      }
      await audit.emit({
        actor: req.user.id,
        actorRole: req.user.role,
        action: 'BRANCH_SUMMARY.REFRESH',
        entityType: 'branch_summaries',
        entityId: code,
        before,
        after: updated,
        reason: req.body?.reason ?? null,
        correlationId: req.correlationId,
        branchCode: code,
      });
      res.json(updated);
    })
  );

  // ---- one branch (must follow '/branches/export.csv' so 'export.csv' never matches :code) ----
  router.get(
    '/branches/:code',
    auth.authenticate(),
    wrap(async (req, res) => {
      const row = await store.get('branch_summaries', req.params.code);
      if (!row) return res.status(404).json({ error: 'NOT_FOUND' });
      if (!auth.branchAllowed(req.user, row.branch_code)) {
        return auth.deny(req, res, { status: 403, error: 'FORBIDDEN', reason: `BRANCH_SCOPE:${row.branch_code}` });
      }
      res.json(row);
    })
  );

  return router;
}
