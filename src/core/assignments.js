// Team management: branch-period-transaction_class assignments. See
// IMPLEMENTATION_PLAN.md and schema.sql's `branch_period_assignments` table comment.
//
// `uk` = branch_code|period|transaction_class (src/core/ids.js#uk). SoD (segregation of
// duties): assigned_operator !== assigned_approver is enforced on both create and
// reassign; READY_FOR_APPROVAL -> APPROVED can never be performed by the assigned
// operator. Optimistic locking via `version`: every write requires the caller's
// `expectedVersion` to match the current row, else VERSION_CONFLICT.
//
// `ctx` follows the CONTRACTS.md convention: { store, audit, correlationId, actor,
// actorRole, now?, deps?, resolveUser }. `resolveUser(id)` is injected by the caller
// (routes/admin.js) so this module works identically whether a principal comes from
// the static config or the `app_users` directory table — it must return a normalised
// { id, role, branches, principal_type } or null.
import { nowIso, uk } from './ids.js';
import { assertTransition, IllegalTransitionError } from './states.js';

export const PRIORITIES = Object.freeze(['LOW', 'NORMAL', 'HIGH', 'URGENT']);

export const ASSIGNMENT_STATES = Object.freeze({
  UNASSIGNED: 'UNASSIGNED',
  ASSIGNED: 'ASSIGNED',
  IN_PROGRESS: 'IN_PROGRESS',
  READY_FOR_APPROVAL: 'READY_FOR_APPROVAL',
  APPROVED: 'APPROVED',
  ON_HOLD: 'ON_HOLD',
  DONE: 'DONE',
});

// ON_HOLD's outgoing edge is intentionally empty here: resuming from ON_HOLD is only
// ever allowed back to the exact state it was paused from, which is not a static edge
// (it depends on history) — see resumeTargetFromHistory() below, which setStatus()
// consults instead of this table whenever the current status is ON_HOLD.
export const ASSIGNMENT_TRANSITIONS = Object.freeze({
  UNASSIGNED: ['ASSIGNED', 'ON_HOLD'],
  ASSIGNED: ['IN_PROGRESS', 'ON_HOLD'],
  IN_PROGRESS: ['READY_FOR_APPROVAL', 'ON_HOLD'],
  READY_FOR_APPROVAL: ['APPROVED', 'ON_HOLD'],
  APPROVED: ['DONE', 'ON_HOLD'],
  ON_HOLD: [],
  DONE: [],
});

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const TERMINAL_STATES = new Set(['DONE']);

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.code = 'VALIDATION';
  }
}

export class UserNotFoundError extends Error {
  constructor(userId) {
    super(`User not found or not active: ${JSON.stringify(userId)}`);
    this.code = 'USER_NOT_FOUND';
    this.userId = userId;
  }
}

export class SegregationOfDutiesError extends Error {
  constructor(userId) {
    super(`'${userId}' cannot be both the assigned operator and the assigned approver (segregation of duties)`);
    this.code = 'SOD_VIOLATION';
    this.userId = userId;
  }
}

export class AssignmentNotFoundError extends Error {
  constructor(id) {
    super(`branch_period_assignment not found: ${id}`);
    this.code = 'ASSIGNMENT_NOT_FOUND';
    this.id = id;
  }
}

export class VersionConflictError extends Error {
  constructor(currentVersion) {
    super(`version conflict: current version is ${currentVersion}`);
    this.code = 'VERSION_CONFLICT';
    this.currentVersion = currentVersion;
  }
}

function nowFn(ctx) {
  return ctx.now ? ctx.now() : nowIso();
}

/** After every write, give a concurrently-developed branch-summary refresher a chance
 *  to run. Purely optional: absent in every test/ctx that doesn't wire it up. */
async function maybeRefreshBranchSummary(ctx, branchCode) {
  const fn = ctx.deps?.branchSummary?.refreshBranchSummary;
  if (typeof fn === 'function') {
    await fn(ctx, { branchCode });
  }
}

/** Resolve `userId` via ctx.resolveUser(), and verify it holds one of `allowedRoles`
 *  and is scoped ('*' or the exact branch) to `branchCode`. Throws USER_NOT_FOUND or
 *  VALIDATION; returns the resolved user on success. */
async function validateUserForRole(ctx, userId, allowedRoles, branchCode) {
  if (!userId) throw new ValidationError(`a user id is required (expected one of ${allowedRoles.join('|')})`);
  if (typeof ctx.resolveUser !== 'function') {
    throw new TypeError('ctx.resolveUser(id) is required by src/core/assignments.js');
  }
  const user = await ctx.resolveUser(userId);
  if (!user) throw new UserNotFoundError(userId);
  if (!allowedRoles.includes(user.role)) {
    throw new ValidationError(`user '${userId}' has role '${user.role}', expected one of ${allowedRoles.join('|')}`);
  }
  const branches = user.branches ?? [];
  if (!branches.includes('*') && !branches.includes(branchCode)) {
    throw new ValidationError(`user '${userId}' is not scoped to branch '${branchCode}'`);
  }
  return user;
}

/** Find the state a row was in immediately before it was last moved to ON_HOLD, by
 *  reading its own audit trail (there is no `previous_status` column — the schema is
 *  frozen — so history is the only durable record of it). Returns null if the row's
 *  audit trail doesn't (yet) contain an ON_HOLD transition. */
async function resumeTargetFromHistory(store, id) {
  const events = await store.find(
    'audit_events',
    { entity_type: 'branch_period_assignment', entity_id: String(id), action: 'ASSIGNMENT.STATUS' },
    { orderBy: 'created_at DESC' }
  );
  for (const e of events) {
    let after = null;
    let before = null;
    try {
      after = e.after_json ? JSON.parse(e.after_json) : null;
      before = e.before_json ? JSON.parse(e.before_json) : null;
    } catch {
      continue;
    }
    if (after?.status === 'ON_HOLD') {
      return before?.status ?? null;
    }
  }
  return null;
}

/** Who may drive `toStatus`, given the row's assigned operator/approver. Throws
 *  SOD_VIOLATION for the one case the spec calls out explicitly (the assigned operator
 *  trying to self-approve), VALIDATION for every other unauthorised attempt. Admins can
 *  always act; a bot never reaches this module at all (routes/admin.js requires human). */
function authorizeTransition({ actorRole, actingUser, row, toStatus }) {
  if (actorRole === 'admin') return;

  if (toStatus === 'APPROVED') {
    if (actingUser === row.assigned_operator) throw new SegregationOfDutiesError(actingUser);
    if (actorRole === 'approver' && actingUser === row.assigned_approver) return;
    throw new ValidationError('Only the assigned approver or an admin may approve this assignment');
  }

  if (actorRole === 'operator') {
    if (actingUser !== row.assigned_operator) {
      throw new ValidationError('Operators may only move their own assignments');
    }
    return;
  }
  if (actorRole === 'approver') {
    if (actingUser !== row.assigned_approver) {
      throw new ValidationError('Approvers may only move their own assignments');
    }
    return;
  }
  throw new ValidationError(`Role '${actorRole}' may not change an assignment's status`);
}

/** Validates period/priority/user-directory/SoD, then inserts the row (status
 *  ASSIGNED, version 1). A duplicate (branch_code, period, transaction_class) is a
 *  UNIQUE_VIOLATION from the store — deliberately not caught here, so it passes
 *  through to the caller (routes/admin.js maps it to 409). */
export async function createAssignment(
  ctx,
  {
    branchCode,
    period,
    transactionClass = '*',
    assignedOperator,
    assignedApprover,
    priority = 'NORMAL',
    dueAt = null,
    assignedBy,
  }
) {
  const { store, audit, correlationId } = ctx;
  const now = nowFn(ctx);

  if (!branchCode) throw new ValidationError('branchCode is required');
  if (!PERIOD_RE.test(String(period))) throw new ValidationError(`period must be YYYY-MM, got ${JSON.stringify(period)}`);
  if (!PRIORITIES.includes(priority)) throw new ValidationError(`priority must be one of ${PRIORITIES.join('|')}, got ${JSON.stringify(priority)}`);

  await validateUserForRole(ctx, assignedOperator, ['operator', 'admin'], branchCode);
  await validateUserForRole(ctx, assignedApprover, ['approver', 'admin'], branchCode);

  if (assignedOperator === assignedApprover) {
    throw new SegregationOfDutiesError(assignedOperator);
  }

  const row = await store.insert('branch_period_assignments', {
    branch_code: branchCode,
    period,
    transaction_class: transactionClass,
    assigned_operator: assignedOperator,
    assigned_approver: assignedApprover,
    status: ASSIGNMENT_STATES.ASSIGNED,
    priority_level: priority,
    assigned_at: now,
    due_at: dueAt ?? null,
    version: 1,
    assigned_by: assignedBy ?? ctx.actor ?? null,
    reassignment_reason: null,
    uk: uk(branchCode, period, transactionClass),
    created_at: now,
    updated_at: now,
  });

  await audit.emit({
    actor: assignedBy ?? ctx.actor,
    actorRole: ctx.actorRole,
    action: 'ASSIGNMENT.CREATE',
    entityType: 'branch_period_assignment',
    entityId: row.id,
    before: null,
    after: row,
    correlationId,
    branchCode,
    period,
  });

  await maybeRefreshBranchSummary(ctx, branchCode);
  return row;
}

/** Change the assigned operator and/or approver. `reason` is mandatory (non-empty).
 *  Optimistic lock via expectedVersion. SoD is re-checked on the RESULTING pair, not
 *  just the changed field, so reassigning only the operator into a collision with an
 *  unchanged approver is still refused. */
export async function reassign(ctx, { id, assignedOperator, assignedApprover, reason, expectedVersion }) {
  const { store, audit, correlationId } = ctx;
  const now = nowFn(ctx);

  if (!reason || !String(reason).trim()) throw new ValidationError('reason is required for reassignment');

  const row = await store.get('branch_period_assignments', id);
  if (!row) throw new AssignmentNotFoundError(id);
  if (row.version !== expectedVersion) throw new VersionConflictError(row.version);

  const nextOperator = assignedOperator !== undefined ? assignedOperator : row.assigned_operator;
  const nextApprover = assignedApprover !== undefined ? assignedApprover : row.assigned_approver;

  if (assignedOperator !== undefined) {
    await validateUserForRole(ctx, assignedOperator, ['operator', 'admin'], row.branch_code);
  }
  if (assignedApprover !== undefined) {
    await validateUserForRole(ctx, assignedApprover, ['approver', 'admin'], row.branch_code);
  }
  if (nextOperator === nextApprover) {
    throw new SegregationOfDutiesError(nextOperator);
  }

  const updated = await store.update('branch_period_assignments', id, {
    assigned_operator: nextOperator,
    assigned_approver: nextApprover,
    reassignment_reason: reason,
    version: row.version + 1,
    updated_at: now,
  });

  await audit.emit({
    actor: ctx.actor,
    actorRole: ctx.actorRole,
    action: 'ASSIGNMENT.REASSIGN',
    entityType: 'branch_period_assignment',
    entityId: id,
    before: row,
    after: updated,
    reason,
    correlationId,
    branchCode: row.branch_code,
    period: row.period,
  });

  await maybeRefreshBranchSummary(ctx, row.branch_code);
  return updated;
}

/** Move an assignment through its lifecycle. See ASSIGNMENT_TRANSITIONS for the base
 *  graph; ON_HOLD's exit is resolved dynamically from the row's own audit history
 *  (resumeTargetFromHistory). Optimistic lock via expectedVersion. `actor` is the
 *  acting human's id (defaults to ctx.actor); the role used for authorization is
 *  ctx.actorRole, per the CONTRACTS.md ctx convention. */
export async function setStatus(ctx, { id, status, expectedVersion, actor }) {
  const { store, audit, correlationId, actorRole } = ctx;
  const now = nowFn(ctx);
  const actingUser = actor ?? ctx.actor;

  const row = await store.get('branch_period_assignments', id);
  if (!row) throw new AssignmentNotFoundError(id);
  if (row.version !== expectedVersion) throw new VersionConflictError(row.version);

  if (row.status === ASSIGNMENT_STATES.ON_HOLD) {
    const resumeTarget = await resumeTargetFromHistory(store, id);
    if (!resumeTarget || status !== resumeTarget) {
      throw new IllegalTransitionError('branch_period_assignment', row.status, status);
    }
  } else {
    assertTransition(ASSIGNMENT_TRANSITIONS, 'branch_period_assignment', row.status, status);
  }

  authorizeTransition({ actorRole, actingUser, row, toStatus: status });

  const updated = await store.update('branch_period_assignments', id, {
    status,
    version: row.version + 1,
    updated_at: now,
  });

  await audit.emit({
    actor: actingUser,
    actorRole,
    action: 'ASSIGNMENT.STATUS',
    entityType: 'branch_period_assignment',
    entityId: id,
    before: row,
    after: updated,
    correlationId,
    branchCode: row.branch_code,
    period: row.period,
  });

  await maybeRefreshBranchSummary(ctx, row.branch_code);
  return updated;
}

export async function listAssignments(store, { branchCode, period, operator, approver, status } = {}) {
  const where = {};
  if (branchCode) where.branch_code = branchCode;
  if (period) where.period = period;
  if (operator) where.assigned_operator = operator;
  if (approver) where.assigned_approver = approver;
  if (status) where.status = status;
  return store.find('branch_period_assignments', where, { orderBy: 'created_at DESC' });
}

/** Per-user open/closed workload snapshot. `users` is any list of normalised
 *  principals ({ id, role, ... }) — typically the merged directory from
 *  routes/admin.js so both config and app_users principals are covered. */
export async function workload(store, users = []) {
  const all = await store.find('branch_period_assignments', {});
  const byStatus = (rows) =>
    rows.reduce((acc, r) => {
      acc[r.status] = (acc[r.status] ?? 0) + 1;
      return acc;
    }, {});

  return users.map((u) => {
    const asOperator = all.filter((a) => a.assigned_operator === u.id);
    const asApprover = all.filter((a) => a.assigned_approver === u.id);
    const openIds = new Set(
      [...asOperator, ...asApprover].filter((r) => !TERMINAL_STATES.has(r.status)).map((r) => r.id)
    );
    return {
      id: u.id,
      role: u.role,
      assignedAsOperator: byStatus(asOperator),
      assignedAsApprover: byStatus(asApprover),
      openTotal: openIds.size,
    };
  });
}

export async function history(store, id) {
  return store.find(
    'audit_events',
    { entity_type: 'branch_period_assignment', entity_id: String(id) },
    { orderBy: 'created_at DESC' }
  );
}
