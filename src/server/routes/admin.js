// Team management: user directory + branch-period assignments. See CONTRACTS.md §H
// style (authenticate -> role -> branch scope -> write -> audit) and the task note
// for this workstream (RULES/DELIVERABLES). Human-only surface: every route requires
// auth.requireHuman() — a bot/agent token gets 403 regardless of its provisioned role,
// matching the §G ceiling (this surface isn't in the bot allowlist at all).
import express from 'express';
import { randomBytes } from 'node:crypto';
import { nowIso } from '../../core/ids.js';
import { normalizeUsers, hashToken } from '../auth.js';
import {
  createAssignment,
  reassign,
  setStatus,
  listAssignments,
  workload as computeWorkload,
  history as assignmentHistory,
} from '../../core/assignments.js';

const USER_STATUSES = new Set(['INVITED', 'ACTIVE', 'INACTIVE']);

// Maps a thrown domain error's `.code` to an HTTP status. The central handler in
// app.js only knows a handful of codes (ILLEGAL_TRANSITION, UNIQUE_VIOLATION, ...);
// this router owns the rest so it also works standalone (a bare express() + this
// router + a tiny error handler, per the task's test-harness note) without app.js.
const ERROR_STATUS = {
  SOD_VIOLATION: 409,
  VERSION_CONFLICT: 409,
  VALIDATION: 400,
  USER_NOT_FOUND: 404,
  ILLEGAL_TRANSITION: 409,
  ASSIGNMENT_NOT_FOUND: 404,
  UNIQUE_VIOLATION: 409,
  CONFIG_USER_READONLY: 409,
};

function domainError(code, message) {
  return Object.assign(new Error(message), { code });
}

function wrap(fn) {
  return async (req, res, next) => {
    try {
      await fn(req, res, next);
    } catch (err) {
      const status = ERROR_STATUS[err?.code];
      if (status) {
        const body = { error: err.code, message: err.message };
        if (err.code === 'VERSION_CONFLICT' && err.currentVersion !== undefined) body.currentVersion = err.currentVersion;
        return res.status(status).json(body);
      }
      next(err);
    }
  };
}

function safeParseBranches(json) {
  try {
    const parsed = JSON.parse(json ?? '[]');
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

/** Post-fetch branch filter for list endpoints, matching routes/read.js's helper. */
function filterByBranch(rows, user, branchField = 'branch_code') {
  const branches = user?.branches ?? [];
  if (branches.includes('*')) return rows;
  const allowed = new Set(branches);
  return rows.filter((r) => allowed.has(r[branchField]));
}

function stripToken(row) {
  if (!row) return row;
  // eslint-disable-next-line no-unused-vars
  const { token_sha256, ...rest } = row;
  return rest;
}

export function createAdminRouter({ store, audit, auth, users = [], deps = {} }) {
  const router = express.Router();

  /** Read-only view of a config-file user, safe to hand back over the API. */
  function configUserView(u) {
    return { id: u.id, role: u.role, principal_type: u.principal_type, branches: u.branches, source: 'config' };
  }

  function isConfigUser(id) {
    return users.some((u) => u.id === id);
  }

  async function loadDirectory() {
    const rows = await store.find('app_users', {});
    const directoryUsers = rows.map((r) => ({
      id: r.id,
      email: r.email,
      display_name: r.display_name,
      role: r.role,
      principal_type: r.principal_type,
      status: r.status,
      branches: safeParseBranches(r.branches_json),
      created_by: r.created_by,
      created_at: r.created_at,
      updated_at: r.updated_at,
      version: r.version,
      last_login_at: r.last_login_at,
      source: 'directory',
    }));
    return [...users.map(configUserView), ...directoryUsers];
  }

  /** ctx.resolveUser(id): config users first, then ACTIVE app_users rows. Works
   *  identically for src/core/assignments.js regardless of which directory a
   *  principal lives in. */
  async function resolveUser(id) {
    const cfg = users.find((u) => u.id === id);
    if (cfg) return { id: cfg.id, role: cfg.role, principal_type: cfg.principal_type, branches: cfg.branches };
    const row = await store.findOne('app_users', { id, status: 'ACTIVE' });
    if (!row) return null;
    return { id: row.id, role: row.role, principal_type: row.principal_type, branches: safeParseBranches(row.branches_json) };
  }

  function ctxFor(req) {
    return {
      store,
      audit,
      correlationId: req.correlationId,
      actor: req.user.id,
      actorRole: req.user.role,
      resolveUser,
      deps,
    };
  }

  // ---------------------------------------------------------------- user directory

  router.get(
    '/admin/users',
    auth.authenticate(),
    auth.requireHuman(),
    auth.requireRole('admin'),
    wrap(async (req, res) => {
      res.json({ users: await loadDirectory() });
    })
  );

  router.post(
    '/admin/users',
    auth.authenticate(),
    auth.requireHuman(),
    auth.requireCorrelationId(),
    auth.requireRole('admin'),
    wrap(async (req, res) => {
      const body = req.body ?? {};
      const id = body.id ? String(body.id) : `usr_${randomBytes(6).toString('hex')}`;
      const principalType = body.principal_type ?? 'human';
      const branches = Array.isArray(body.branches) ? body.branches.map(String) : [];

      let normalized;
      try {
        // Reuse the exact same role/principal_type validation the config file gets at
        // startup (bots capped at operator, etc.) — token_sha256 here is a throwaway
        // placeholder only so normalizeUsers' shape check passes; it is never stored.
        [normalized] = normalizeUsers([{ id, role: body.role, principal_type: principalType, branches, token_sha256: 'x'.repeat(64) }]);
      } catch (err) {
        throw domainError('VALIDATION', err.message);
      }

      const now = nowIso();
      const isBot = normalized.principal_type === 'bot';
      let token = null;
      let tokenSha256 = null;
      if (isBot) {
        token = randomBytes(32).toString('hex');
        tokenSha256 = hashToken(token);
      }

      const row = await store.insert('app_users', {
        id: normalized.id,
        email: body.email ?? null,
        display_name: body.display_name ?? null,
        role: normalized.role,
        principal_type: normalized.principal_type,
        status: isBot ? 'ACTIVE' : 'INVITED',
        branches_json: JSON.stringify(normalized.branches),
        token_sha256: tokenSha256,
        created_by: req.user.id,
        created_at: now,
        updated_at: now,
        version: 1,
        last_login_at: null,
      });

      auth.invalidateUserCache();
      await audit.emit({
        actor: req.user.id,
        actorRole: req.user.role,
        action: 'USER.CREATE',
        entityType: 'app_users',
        entityId: row.id,
        before: null,
        after: row, // audit.emit()'s redact() strips token_sha256 (key matches /token/i)
        correlationId: req.correlationId,
      });

      const response = { user: stripToken(row) };
      if (token) {
        response.token = token;
        response.tokenRevealedOnce = true;
        response.note = 'This token is shown once and is never retrievable again. Store it now.';
      }
      res.status(201).json(response);
    })
  );

  router.patch(
    '/admin/users/:id',
    auth.authenticate(),
    auth.requireHuman(),
    auth.requireCorrelationId(),
    auth.requireRole('admin'),
    wrap(async (req, res) => {
      const id = req.params.id;
      if (isConfigUser(id)) {
        throw domainError('CONFIG_USER_READONLY', `User '${id}' is defined in config and cannot be edited via the API`);
      }
      const row = await store.get('app_users', id);
      if (!row) throw domainError('USER_NOT_FOUND', `User not found: ${id}`);

      const body = req.body ?? {};
      if (body.version === undefined || Number(body.version) !== row.version) {
        const err = domainError('VERSION_CONFLICT', 'version mismatch');
        err.currentVersion = row.version;
        throw err;
      }

      const patch = { version: row.version + 1, updated_at: nowIso() };

      if (body.role !== undefined || body.branches !== undefined) {
        const candidateRole = body.role !== undefined ? body.role : row.role;
        const candidateBranches = body.branches !== undefined
          ? (Array.isArray(body.branches) ? body.branches.map(String) : [])
          : safeParseBranches(row.branches_json);
        try {
          normalizeUsers([{ id: row.id, role: candidateRole, principal_type: row.principal_type, branches: candidateBranches, token_sha256: 'x'.repeat(64) }]);
        } catch (err) {
          throw domainError('VALIDATION', err.message);
        }
        if (body.role !== undefined) patch.role = candidateRole;
        if (body.branches !== undefined) patch.branches_json = JSON.stringify(candidateBranches);
      }
      if (body.status !== undefined) {
        if (!USER_STATUSES.has(body.status)) throw domainError('VALIDATION', `status must be one of ${[...USER_STATUSES].join('|')}`);
        patch.status = body.status;
      }
      if (body.display_name !== undefined) patch.display_name = body.display_name;

      const updated = await store.update('app_users', id, patch);
      auth.invalidateUserCache();
      await audit.emit({
        actor: req.user.id,
        actorRole: req.user.role,
        action: 'USER.UPDATE',
        entityType: 'app_users',
        entityId: id,
        before: row,
        after: updated,
        correlationId: req.correlationId,
      });
      res.json({ user: stripToken(updated) });
    })
  );

  router.post(
    '/admin/users/:id/rotate-token',
    auth.authenticate(),
    auth.requireHuman(),
    auth.requireCorrelationId(),
    auth.requireRole('admin'),
    wrap(async (req, res) => {
      const id = req.params.id;
      if (isConfigUser(id)) {
        throw domainError('CONFIG_USER_READONLY', `User '${id}' is defined in config and cannot be edited via the API`);
      }
      const row = await store.get('app_users', id);
      if (!row) throw domainError('USER_NOT_FOUND', `User not found: ${id}`);
      if (row.principal_type !== 'bot') {
        throw domainError('VALIDATION', 'Only bot principals have a rotatable token');
      }

      const token = randomBytes(32).toString('hex');
      const tokenSha256 = hashToken(token);
      const updated = await store.update('app_users', id, {
        token_sha256: tokenSha256,
        version: row.version + 1,
        updated_at: nowIso(),
      });
      auth.invalidateUserCache();
      await audit.emit({
        actor: req.user.id,
        actorRole: req.user.role,
        action: 'USER.TOKEN_ROTATED',
        entityType: 'app_users',
        entityId: id,
        before: row,
        after: updated,
        correlationId: req.correlationId,
      });
      res.json({ user: stripToken(updated), token, tokenRevealedOnce: true, note: 'The previous token is now invalid.' });
    })
  );

  router.get(
    '/admin/workload',
    auth.authenticate(),
    auth.requireHuman(),
    auth.requireRole('admin', 'approver'),
    wrap(async (req, res) => {
      const directory = (await loadDirectory()).filter((u) => u.principal_type !== 'bot');
      res.json({ workload: await computeWorkload(store, directory) });
    })
  );

  // ---------------------------------------------------------------- assignments

  router.get(
    '/assignments',
    auth.authenticate(),
    auth.requireHuman(),
    wrap(async (req, res) => {
      const { branch, period, operator, approver, status } = req.query;
      if (branch && !auth.branchAllowed(req.user, branch)) {
        return auth.deny(req, res, { status: 403, error: 'FORBIDDEN', reason: `BRANCH_SCOPE:${branch}` });
      }
      const rows = await listAssignments(store, { branchCode: branch, period, operator, approver, status });
      res.json({ assignments: filterByBranch(rows, req.user) });
    })
  );

  router.post(
    '/assignments',
    auth.authenticate(),
    auth.requireHuman(),
    auth.requireCorrelationId(),
    auth.requireRole('admin'),
    wrap(async (req, res) => {
      const body = req.body ?? {};
      if (body.branchCode && !auth.branchAllowed(req.user, body.branchCode)) {
        return auth.deny(req, res, { status: 403, error: 'FORBIDDEN', reason: `BRANCH_SCOPE:${body.branchCode}` });
      }
      const row = await createAssignment(ctxFor(req), {
        branchCode: body.branchCode,
        period: body.period,
        transactionClass: body.transactionClass ?? '*',
        assignedOperator: body.assignedOperator,
        assignedApprover: body.assignedApprover,
        priority: body.priority ?? 'NORMAL',
        dueAt: body.dueAt ?? null,
        assignedBy: req.user.id,
      });
      res.status(201).json(row);
    })
  );

  router.post(
    '/assignments/:id/reassign',
    auth.authenticate(),
    auth.requireHuman(),
    auth.requireCorrelationId(),
    auth.requireRole('admin'),
    wrap(async (req, res) => {
      const id = Number(req.params.id);
      const existing = await store.get('branch_period_assignments', id);
      if (!existing) throw domainError('ASSIGNMENT_NOT_FOUND', `branch_period_assignment not found: ${id}`);
      if (!auth.branchAllowed(req.user, existing.branch_code)) {
        return auth.deny(req, res, { status: 403, error: 'FORBIDDEN', reason: `BRANCH_SCOPE:${existing.branch_code}` });
      }
      const body = req.body ?? {};
      const updated = await reassign(ctxFor(req), {
        id,
        assignedOperator: body.assignedOperator,
        assignedApprover: body.assignedApprover,
        reason: body.reason,
        expectedVersion: Number(body.expectedVersion),
      });
      res.json(updated);
    })
  );

  router.post(
    '/assignments/:id/status',
    auth.authenticate(),
    auth.requireHuman(),
    auth.requireCorrelationId(),
    auth.requireRole('operator', 'approver', 'admin'),
    wrap(async (req, res) => {
      const id = Number(req.params.id);
      const existing = await store.get('branch_period_assignments', id);
      if (!existing) throw domainError('ASSIGNMENT_NOT_FOUND', `branch_period_assignment not found: ${id}`);
      if (!auth.branchAllowed(req.user, existing.branch_code)) {
        return auth.deny(req, res, { status: 403, error: 'FORBIDDEN', reason: `BRANCH_SCOPE:${existing.branch_code}` });
      }
      const body = req.body ?? {};
      const updated = await setStatus(ctxFor(req), {
        id,
        status: body.status,
        expectedVersion: Number(body.expectedVersion),
        actor: req.user.id,
      });
      res.json(updated);
    })
  );

  router.get(
    '/assignments/:id/history',
    auth.authenticate(),
    auth.requireHuman(),
    auth.requireRole('admin', 'approver', 'viewer'),
    wrap(async (req, res) => {
      const id = Number(req.params.id);
      const existing = await store.get('branch_period_assignments', id);
      if (!existing) throw domainError('ASSIGNMENT_NOT_FOUND', `branch_period_assignment not found: ${id}`);
      if (!auth.branchAllowed(req.user, existing.branch_code)) {
        return auth.deny(req, res, { status: 403, error: 'FORBIDDEN', reason: `BRANCH_SCOPE:${existing.branch_code}` });
      }
      const events = await assignmentHistory(store, id);
      res.json({ assignment: existing, history: events });
    })
  );

  return router;
}
