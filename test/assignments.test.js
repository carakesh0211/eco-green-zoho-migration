// Unit tests for src/core/assignments.js: branch-period assignment lifecycle, SoD,
// optimistic locking, and the ON_HOLD/resume history trick (no `previous_status`
// column exists — schema.sql is frozen — so resuming reads the row's own audit trail).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/adapters/store/memory.js';
import { createAudit } from '../src/core/audit.js';
import {
  createAssignment, reassign, setStatus, listAssignments, workload, history,
  ValidationError, UserNotFoundError, SegregationOfDutiesError, AssignmentNotFoundError, VersionConflictError,
} from '../src/core/assignments.js';
import { IllegalTransitionError } from '../src/core/states.js';

const DIRECTORY = [
  { id: 'op-alice', role: 'operator', branches: ['PILOT01'] },
  { id: 'op-carol', role: 'operator', branches: ['PILOT01'] },
  { id: 'ap-bob', role: 'approver', branches: ['PILOT01'] },
  { id: 'ap-dora', role: 'approver', branches: ['PILOT01'] },
  { id: 'view-eve', role: 'viewer', branches: ['PILOT01'] },
  { id: 'op-other-branch', role: 'operator', branches: ['PILOT02'] },
  { id: 'admin-zed', role: 'admin', branches: ['*'] },
];

async function resolveUser(id) {
  return DIRECTORY.find((u) => u.id === id) ?? null;
}

async function makeCtx(overrides = {}) {
  const store = await openStore();
  const audit = createAudit(store);
  const ctx = { store, audit, correlationId: 'corr-assign', actor: 'admin-zed', actorRole: 'admin', resolveUser, ...overrides };
  return { store, audit, ctx };
}

test('createAssignment: happy path — status ASSIGNED, version 1, uk composed correctly', async () => {
  const { store, ctx } = await makeCtx();
  try {
    const row = await createAssignment(ctx, {
      branchCode: 'PILOT01', period: '2026-04', assignedOperator: 'op-alice', assignedApprover: 'ap-bob', assignedBy: 'admin-zed',
    });
    assert.equal(row.status, 'ASSIGNED');
    assert.equal(row.version, 1);
    assert.equal(row.priority_level, 'NORMAL');
    assert.equal(row.uk, 'PILOT01|2026-04|*');

    const events = await store.find('audit_events', { entity_type: 'branch_period_assignment', entity_id: String(row.id) });
    assert.equal(events.length, 1);
    assert.equal(events[0].action, 'ASSIGNMENT.CREATE');
  } finally {
    await store.close();
  }
});

test('createAssignment: rejects a malformed period', async () => {
  const { store, ctx } = await makeCtx();
  try {
    await assert.rejects(
      () => createAssignment(ctx, { branchCode: 'PILOT01', period: '2026/04', assignedOperator: 'op-alice', assignedApprover: 'ap-bob' }),
      ValidationError
    );
  } finally {
    await store.close();
  }
});

test('createAssignment: rejects an unknown priority', async () => {
  const { store, ctx } = await makeCtx();
  try {
    await assert.rejects(
      () => createAssignment(ctx, { branchCode: 'PILOT01', period: '2026-04', assignedOperator: 'op-alice', assignedApprover: 'ap-bob', priority: 'SUPER_URGENT' }),
      ValidationError
    );
  } finally {
    await store.close();
  }
});

test('createAssignment: unknown user -> USER_NOT_FOUND', async () => {
  const { store, ctx } = await makeCtx();
  try {
    await assert.rejects(
      () => createAssignment(ctx, { branchCode: 'PILOT01', period: '2026-04', assignedOperator: 'ghost', assignedApprover: 'ap-bob' }),
      UserNotFoundError
    );
  } finally {
    await store.close();
  }
});

test('createAssignment: wrong role for the slot -> VALIDATION', async () => {
  const { store, ctx } = await makeCtx();
  try {
    await assert.rejects(
      () => createAssignment(ctx, { branchCode: 'PILOT01', period: '2026-04', assignedOperator: 'view-eve', assignedApprover: 'ap-bob' }),
      ValidationError
    );
  } finally {
    await store.close();
  }
});

test('createAssignment: operator scoped to a different branch -> VALIDATION', async () => {
  const { store, ctx } = await makeCtx();
  try {
    await assert.rejects(
      () => createAssignment(ctx, { branchCode: 'PILOT01', period: '2026-04', assignedOperator: 'op-other-branch', assignedApprover: 'ap-bob' }),
      ValidationError
    );
  } finally {
    await store.close();
  }
});

test('createAssignment: same person as operator and approver -> SOD_VIOLATION', async () => {
  const { store, ctx } = await makeCtx();
  try {
    await assert.rejects(
      () => createAssignment(ctx, { branchCode: 'PILOT01', period: '2026-04', assignedOperator: 'admin-zed', assignedApprover: 'admin-zed' }),
      SegregationOfDutiesError
    );
  } finally {
    await store.close();
  }
});

test('createAssignment: duplicate (branch, period, class) -> UNIQUE_VIOLATION passes through', async () => {
  const { store, ctx } = await makeCtx();
  try {
    await createAssignment(ctx, { branchCode: 'PILOT01', period: '2026-04', assignedOperator: 'op-alice', assignedApprover: 'ap-bob' });
    await assert.rejects(
      () => createAssignment(ctx, { branchCode: 'PILOT01', period: '2026-04', assignedOperator: 'op-carol', assignedApprover: 'ap-dora' }),
      (err) => { assert.equal(err.code, 'UNIQUE_VIOLATION'); return true; }
    );
  } finally {
    await store.close();
  }
});

test('reassign: requires a non-empty reason', async () => {
  const { store, ctx } = await makeCtx();
  try {
    const row = await createAssignment(ctx, { branchCode: 'PILOT01', period: '2026-04', assignedOperator: 'op-alice', assignedApprover: 'ap-bob' });
    await assert.rejects(
      () => reassign(ctx, { id: row.id, assignedOperator: 'op-carol', reason: '  ', expectedVersion: row.version }),
      ValidationError
    );
  } finally {
    await store.close();
  }
});

test('reassign: version conflict reports the current version', async () => {
  const { store, ctx } = await makeCtx();
  try {
    const row = await createAssignment(ctx, { branchCode: 'PILOT01', period: '2026-04', assignedOperator: 'op-alice', assignedApprover: 'ap-bob' });
    await assert.rejects(
      () => reassign(ctx, { id: row.id, assignedOperator: 'op-carol', reason: 'handoff', expectedVersion: row.version + 1 }),
      (err) => { assert.equal(err.code, 'VERSION_CONFLICT'); assert.equal(err.currentVersion, row.version); return true; }
    );
  } finally {
    await store.close();
  }
});

test('reassign: SoD is re-checked on the RESULTING pair, and success updates version + reason', async () => {
  const { store, ctx } = await makeCtx();
  try {
    const row = await createAssignment(ctx, { branchCode: 'PILOT01', period: '2026-04', assignedOperator: 'op-alice', assignedApprover: 'ap-bob' });
    // Admin qualifies for both slots' role check, so it's the only way to construct a
    // same-person collision that gets past the per-slot role check and reaches the
    // resulting-pair SoD check. Put admin-zed on the approver slot first...
    const withAdminApprover = await reassign(ctx, { id: row.id, assignedApprover: 'admin-zed', reason: 'temp cover', expectedVersion: row.version });
    // ...then changing only the OPERATOR into a collision with that unchanged approver
    // must still be refused (proves SoD is re-checked on the resulting pair, not just
    // the field being changed).
    await assert.rejects(
      () => reassign(ctx, { id: row.id, assignedOperator: 'admin-zed', reason: 'oops', expectedVersion: withAdminApprover.version }),
      SegregationOfDutiesError
    );

    const updated = await reassign(ctx, { id: row.id, assignedOperator: 'op-carol', assignedApprover: 'ap-bob', reason: 'alice is on leave', expectedVersion: withAdminApprover.version });
    assert.equal(updated.assigned_operator, 'op-carol');
    assert.equal(updated.assigned_approver, 'ap-bob');
    assert.equal(updated.reassignment_reason, 'alice is on leave');
    assert.equal(updated.version, withAdminApprover.version + 1);

    const events = await store.find('audit_events', { entity_type: 'branch_period_assignment', entity_id: String(row.id), action: 'ASSIGNMENT.REASSIGN' });
    assert.equal(events.length, 2, 'the earlier successful reassign (to admin-zed) also audits');
  } finally {
    await store.close();
  }
});

test('reassign: missing row -> AssignmentNotFoundError', async () => {
  const { store, ctx } = await makeCtx();
  try {
    await assert.rejects(() => reassign(ctx, { id: 999999, assignedOperator: 'op-carol', reason: 'x', expectedVersion: 1 }), AssignmentNotFoundError);
  } finally {
    await store.close();
  }
});

test('setStatus: full happy-path lifecycle, each transition driven by the right actor', async () => {
  const { store, ctx } = await makeCtx();
  try {
    const row = await createAssignment(ctx, { branchCode: 'PILOT01', period: '2026-04', assignedOperator: 'op-alice', assignedApprover: 'ap-bob' });

    const s1 = await setStatus({ ...ctx, actorRole: 'operator' }, { id: row.id, status: 'IN_PROGRESS', expectedVersion: row.version, actor: 'op-alice' });
    assert.equal(s1.status, 'IN_PROGRESS');
    assert.equal(s1.version, row.version + 1);

    const s2 = await setStatus({ ...ctx, actorRole: 'operator' }, { id: row.id, status: 'READY_FOR_APPROVAL', expectedVersion: s1.version, actor: 'op-alice' });
    assert.equal(s2.status, 'READY_FOR_APPROVAL');

    // The assigned operator may never self-approve — SoD.
    await assert.rejects(
      () => setStatus({ ...ctx, actorRole: 'operator' }, { id: row.id, status: 'APPROVED', expectedVersion: s2.version, actor: 'op-alice' }),
      SegregationOfDutiesError
    );
    // A DIFFERENT approver (not assigned to this row) is refused too, but as VALIDATION not SoD.
    await assert.rejects(
      () => setStatus({ ...ctx, actorRole: 'approver' }, { id: row.id, status: 'APPROVED', expectedVersion: s2.version, actor: 'ap-dora' }),
      ValidationError
    );

    const s3 = await setStatus({ ...ctx, actorRole: 'approver' }, { id: row.id, status: 'APPROVED', expectedVersion: s2.version, actor: 'ap-bob' });
    assert.equal(s3.status, 'APPROVED');

    const s4 = await setStatus({ ...ctx, actorRole: 'admin' }, { id: row.id, status: 'DONE', expectedVersion: s3.version, actor: 'admin-zed' });
    assert.equal(s4.status, 'DONE');
  } finally {
    await store.close();
  }
});

test('setStatus: illegal jump is refused (states.js IllegalTransitionError)', async () => {
  const { store, ctx } = await makeCtx();
  try {
    const row = await createAssignment(ctx, { branchCode: 'PILOT01', period: '2026-04', assignedOperator: 'op-alice', assignedApprover: 'ap-bob' });
    await assert.rejects(
      () => setStatus({ ...ctx, actorRole: 'operator' }, { id: row.id, status: 'APPROVED', expectedVersion: row.version, actor: 'op-alice' }),
      IllegalTransitionError
    );
  } finally {
    await store.close();
  }
});

test('setStatus: operators may only move their own assignments', async () => {
  const { store, ctx } = await makeCtx();
  try {
    const row = await createAssignment(ctx, { branchCode: 'PILOT01', period: '2026-04', assignedOperator: 'op-alice', assignedApprover: 'ap-bob' });
    await assert.rejects(
      () => setStatus({ ...ctx, actorRole: 'operator' }, { id: row.id, status: 'IN_PROGRESS', expectedVersion: row.version, actor: 'op-carol' }),
      ValidationError
    );
  } finally {
    await store.close();
  }
});

test('setStatus: version conflict', async () => {
  const { store, ctx } = await makeCtx();
  try {
    const row = await createAssignment(ctx, { branchCode: 'PILOT01', period: '2026-04', assignedOperator: 'op-alice', assignedApprover: 'ap-bob' });
    await assert.rejects(
      () => setStatus({ ...ctx, actorRole: 'operator' }, { id: row.id, status: 'IN_PROGRESS', expectedVersion: row.version + 1, actor: 'op-alice' }),
      VersionConflictError
    );
  } finally {
    await store.close();
  }
});

test('setStatus: ON_HOLD resumes only to the exact state it was paused from (read from audit history, no previous_status column)', async () => {
  const { store, ctx } = await makeCtx();
  try {
    const row = await createAssignment(ctx, { branchCode: 'PILOT01', period: '2026-04', assignedOperator: 'op-alice', assignedApprover: 'ap-bob' });
    const inProgress = await setStatus({ ...ctx, actorRole: 'operator' }, { id: row.id, status: 'IN_PROGRESS', expectedVersion: row.version, actor: 'op-alice' });

    const held = await setStatus({ ...ctx, actorRole: 'operator' }, { id: row.id, status: 'ON_HOLD', expectedVersion: inProgress.version, actor: 'op-alice' });
    assert.equal(held.status, 'ON_HOLD');

    // Resuming to anything other than IN_PROGRESS (the state it was held from) is illegal.
    await assert.rejects(
      () => setStatus({ ...ctx, actorRole: 'operator' }, { id: row.id, status: 'READY_FOR_APPROVAL', expectedVersion: held.version, actor: 'op-alice' }),
      IllegalTransitionError
    );

    const resumed = await setStatus({ ...ctx, actorRole: 'operator' }, { id: row.id, status: 'IN_PROGRESS', expectedVersion: held.version, actor: 'op-alice' });
    assert.equal(resumed.status, 'IN_PROGRESS');
  } finally {
    await store.close();
  }
});

test('listAssignments filters by branch/period/operator/approver/status', async () => {
  const { store, ctx } = await makeCtx();
  try {
    await createAssignment(ctx, { branchCode: 'PILOT01', period: '2026-04', assignedOperator: 'op-alice', assignedApprover: 'ap-bob' });
    await createAssignment(ctx, { branchCode: 'PILOT01', period: '2026-05', assignedOperator: 'op-carol', assignedApprover: 'ap-dora' });

    const byPeriod = await listAssignments(store, { branchCode: 'PILOT01', period: '2026-04' });
    assert.equal(byPeriod.length, 1);
    assert.equal(byPeriod[0].assigned_operator, 'op-alice');

    const byOperator = await listAssignments(store, { operator: 'op-carol' });
    assert.equal(byOperator.length, 1);

    const byStatus = await listAssignments(store, { status: 'ASSIGNED' });
    assert.equal(byStatus.length, 2);
  } finally {
    await store.close();
  }
});

test('workload: per-user open/closed counts across operator + approver roles', async () => {
  const { store, ctx } = await makeCtx();
  try {
    const a = await createAssignment(ctx, { branchCode: 'PILOT01', period: '2026-04', assignedOperator: 'op-alice', assignedApprover: 'ap-bob' });
    await createAssignment(ctx, { branchCode: 'PILOT01', period: '2026-05', assignedOperator: 'op-alice', assignedApprover: 'ap-dora' });
    const s1 = await setStatus({ ...ctx, actorRole: 'operator' }, { id: a.id, status: 'IN_PROGRESS', expectedVersion: a.version, actor: 'op-alice' });
    const s2 = await setStatus({ ...ctx, actorRole: 'operator' }, { id: a.id, status: 'READY_FOR_APPROVAL', expectedVersion: s1.version, actor: 'op-alice' });
    await setStatus({ ...ctx, actorRole: 'approver' }, { id: a.id, status: 'APPROVED', expectedVersion: s2.version, actor: 'ap-bob' });

    const report = await workload(store, DIRECTORY);
    const alice = report.find((r) => r.id === 'op-alice');
    assert.deepEqual(alice.assignedAsOperator, { APPROVED: 1, ASSIGNED: 1 });
    assert.equal(alice.openTotal, 2);

    const bob = report.find((r) => r.id === 'ap-bob');
    assert.deepEqual(bob.assignedAsApprover, { APPROVED: 1 });
  } finally {
    await store.close();
  }
});

test('history: audit events for the assignment, newest first', async () => {
  const { store, ctx } = await makeCtx();
  try {
    const row = await createAssignment(ctx, { branchCode: 'PILOT01', period: '2026-04', assignedOperator: 'op-alice', assignedApprover: 'ap-bob' });
    await setStatus({ ...ctx, actorRole: 'operator' }, { id: row.id, status: 'IN_PROGRESS', expectedVersion: row.version, actor: 'op-alice' });

    const events = await history(store, row.id);
    assert.equal(events.length, 2);
    assert.equal(events[0].action, 'ASSIGNMENT.STATUS');
    assert.equal(events[1].action, 'ASSIGNMENT.CREATE');
  } finally {
    await store.close();
  }
});

test('createAssignment: optional branchSummary refresh hook is invoked when present, ignored when absent', async () => {
  const { store, ctx } = await makeCtx();
  try {
    let called = null;
    const ctxWithHook = { ...ctx, deps: { branchSummary: { refreshBranchSummary: async (_c, args) => { called = args; } } } };
    await createAssignment(ctxWithHook, { branchCode: 'PILOT01', period: '2026-04', assignedOperator: 'op-alice', assignedApprover: 'ap-bob' });
    assert.deepEqual(called, { branchCode: 'PILOT01' });

    // No hook -> no throw.
    await createAssignment(ctx, { branchCode: 'PILOT01', period: '2026-05', assignedOperator: 'op-alice', assignedApprover: 'ap-bob' });
  } finally {
    await store.close();
  }
});

test('createAssignment: a throwing branch-summary refresh hook never fails the committed write', async () => {
  const { store, ctx } = await makeCtx({ deps: { branchSummary: { refreshBranchSummary: async () => { throw new Error('Branch not found: EG-0002'); } } } });
  try {
    const row = await createAssignment(ctx, {
      branchCode: 'PILOT01', period: '2026-05', assignedOperator: 'op-alice', assignedApprover: 'ap-bob', assignedBy: 'admin-zed',
    });
    assert.equal(row.status, 'ASSIGNED');
    assert.equal((await store.find('branch_period_assignments', { branch_code: 'PILOT01', period: '2026-05' })).length, 1);
  } finally {
    await store.close();
  }
});
