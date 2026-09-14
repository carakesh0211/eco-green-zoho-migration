// Exception ledger: raise/resolve with dedupe + reopen semantics. See CONTRACTS.md §X.
//
// `ctx` = { store, audit, correlationId, actor, actorRole, now? } per the CONTRACTS.md
// convention. Every call (raise or resolve) emits exactly one audit event.
import { nowIso } from './ids.js';

export const CATEGORIES = [
  'SCHEMA_FAILURE',
  'MISSING_KEY',
  'ORPHAN_RELATIONSHIP',
  'DUPLICATE_SOURCE',
  'DUPLICATE_FILE',
  'UNMAPPED_ENTITY',
  'UNMAPPED_MODULE',
  'AMBIGUOUS_MAPPING',
  'UNBALANCED_VOUCHER',
  'INVALID_TARGET_TYPE',
  'SMART_PHARMA_OVERLAP',
  'CUTOVER_RULE_MISSING',
  'LATE_OR_BACK_POSTED',
  'API_VALIDATION_ERROR',
  'AUTHENTICATION_ERROR',
  'RATE_LIMIT',
  'TRANSIENT_FAILURE',
  'UNKNOWN_API_OUTCOME',
  'TARGET_MISMATCH',
  'RECONCILIATION_DIFFERENCE',
  'POSTING_DISABLED',
];

const APPROVER_ROLES = new Set(['approver', 'admin']);
const REOPENABLE_STATUSES = new Set(['RESOLVED', 'APPROVED_EXCEPTION', 'REJECTED']);
const TOUCHABLE_STATUSES = new Set(['OPEN', 'ASSIGNED']);
const RESOLVE_STATUSES = new Set(['RESOLVED', 'APPROVED_EXCEPTION', 'REJECTED']);

export class InvalidCategoryError extends Error {
  constructor(category) {
    super(`Unknown exception category: ${category}`);
    this.code = 'INVALID_CATEGORY';
    this.category = category;
  }
}

export class InvalidResolveStatusError extends Error {
  constructor(status) {
    super(`Invalid resolve() status: ${status}`);
    this.code = 'INVALID_RESOLVE_STATUS';
    this.status = status;
  }
}

export class ExceptionNotFoundError extends Error {
  constructor(id) {
    super(`Exception not found: ${id}`);
    this.code = 'EXCEPTION_NOT_FOUND';
    this.id = id;
  }
}

export class RoleForbiddenError extends Error {
  constructor(role) {
    super(`Role '${role}' is not permitted to approve an exception (requires approver|admin)`);
    this.code = 'FORBIDDEN_ROLE';
    this.role = role;
  }
}

function nowFn(ctx) {
  return ctx.now ? ctx.now() : nowIso();
}

function parseEvidence(json) {
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/** Merge new evidence into existing evidence without discarding history. */
function mergeEvidence(existing, incoming) {
  if (incoming === undefined) return existing ?? null;
  if (existing === null || existing === undefined) return incoming;
  if (Array.isArray(existing) && Array.isArray(incoming)) return [...existing, ...incoming];
  if (
    typeof existing === 'object' &&
    typeof incoming === 'object' &&
    !Array.isArray(existing) &&
    !Array.isArray(incoming)
  ) {
    return { ...existing, ...incoming };
  }
  return incoming;
}

/**
 * raise(ctx, { category, severity, message, dedupeKey, branchCode, period, runId,
 *              fileId, voucherId, batchId, financialImpact = '0.00', evidence })
 * Upserts on dedupe_key:
 *   - no existing row -> insert OPEN.
 *   - existing OPEN/ASSIGNED -> touch updated_at + merge evidence, no duplicate row.
 *   - existing RESOLVED/APPROVED_EXCEPTION/REJECTED -> re-open to OPEN with an audit
 *     event noting the reopen.
 * Every call emits exactly one audit event.
 */
export async function raise(
  ctx,
  {
    category,
    severity,
    message,
    dedupeKey,
    branchCode = null,
    period = null,
    runId = null,
    fileId = null,
    voucherId = null,
    batchId = null,
    financialImpact = '0.00',
    evidence = null,
  }
) {
  const { store, audit, correlationId, actor, actorRole } = ctx;
  if (!CATEGORIES.includes(category)) throw new InvalidCategoryError(category);
  if (!dedupeKey) throw new TypeError('exceptions.raise() requires a dedupeKey');

  const now = nowFn(ctx);
  const existing = await store.findOne('exceptions', { dedupe_key: dedupeKey });

  if (!existing) {
    const row = await store.insert('exceptions', {
      category,
      severity,
      branch_code: branchCode,
      period,
      run_id: runId,
      file_id: fileId,
      voucher_id: voucherId,
      batch_id: batchId,
      financial_impact: financialImpact,
      owner: null,
      status: 'OPEN',
      root_cause: null,
      disposition: null,
      evidence_json: evidence === null ? null : JSON.stringify(evidence),
      message,
      dedupe_key: dedupeKey,
      created_at: now,
      updated_at: now,
    });
    await audit.emit({
      actor,
      actorRole,
      action: 'EXCEPTION.RAISED',
      entityType: 'exceptions',
      entityId: row.id,
      before: null,
      after: row,
      reason: message,
      correlationId,
      branchCode,
      period,
      batchId,
    });
    return row;
  }

  if (TOUCHABLE_STATUSES.has(existing.status)) {
    const merged = mergeEvidence(parseEvidence(existing.evidence_json), evidence);
    const updated = await store.update('exceptions', existing.id, {
      evidence_json: merged === null ? null : JSON.stringify(merged),
      updated_at: now,
    });
    await audit.emit({
      actor,
      actorRole,
      action: 'EXCEPTION.TOUCHED',
      entityType: 'exceptions',
      entityId: existing.id,
      before: existing,
      after: updated,
      reason: 'Duplicate raise() on an open exception: evidence merged, no new row',
      correlationId,
      branchCode: existing.branch_code,
      period: existing.period,
      batchId: existing.batch_id,
    });
    return updated;
  }

  if (REOPENABLE_STATUSES.has(existing.status)) {
    const merged = mergeEvidence(parseEvidence(existing.evidence_json), evidence);
    const updated = await store.update('exceptions', existing.id, {
      status: 'OPEN',
      evidence_json: merged === null ? null : JSON.stringify(merged),
      updated_at: now,
    });
    await audit.emit({
      actor,
      actorRole,
      action: 'EXCEPTION.REOPENED',
      entityType: 'exceptions',
      entityId: existing.id,
      before: existing,
      after: updated,
      reason: `Reopened from ${existing.status}: condition recurred`,
      correlationId,
      branchCode: existing.branch_code,
      period: existing.period,
      batchId: existing.batch_id,
    });
    return updated;
  }

  // Unreachable given the schema's status enum, but fail closed rather than silently
  // dropping the raise.
  throw new Error(`Unhandled exception status during raise(): ${existing.status}`);
}

/**
 * resolve(ctx, { id, status, rootCause, disposition, actor })
 * status ∈ 'RESOLVED' | 'APPROVED_EXCEPTION' | 'REJECTED'. APPROVED_EXCEPTION requires
 * ctx.actorRole ∈ {approver, admin}. Never deletes; history preserved via audit.
 */
export async function resolve(ctx, { id, status, rootCause = null, disposition = null, actor }) {
  const { store, audit, correlationId, actorRole } = ctx;
  if (!RESOLVE_STATUSES.has(status)) throw new InvalidResolveStatusError(status);

  const existing = await store.get('exceptions', id);
  if (!existing) throw new ExceptionNotFoundError(id);

  if (status === 'APPROVED_EXCEPTION' && !APPROVER_ROLES.has(actorRole)) {
    throw new RoleForbiddenError(actorRole);
  }

  const now = nowFn(ctx);
  const resolvedActor = actor ?? ctx.actor;
  const updated = await store.update('exceptions', id, {
    status,
    root_cause: rootCause ?? existing.root_cause,
    disposition: disposition ?? existing.disposition,
    owner: resolvedActor ?? existing.owner,
    updated_at: now,
  });

  await audit.emit({
    actor: resolvedActor,
    actorRole,
    action: 'EXCEPTION.RESOLVED',
    entityType: 'exceptions',
    entityId: id,
    before: existing,
    after: updated,
    reason: rootCause,
    correlationId,
    branchCode: existing.branch_code,
    period: existing.period,
    batchId: existing.batch_id,
  });

  return updated;
}
