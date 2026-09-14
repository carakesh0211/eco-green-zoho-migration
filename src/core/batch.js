// Batch creation + approval (CONTRACTS.md §B). Segregation of duties + immutable
// approval scope: an approval is only valid for the exact voucher/payload set it was
// computed over; any change (new/removed vouchers, a re-transformed payload) is
// detected by recomputing scope_hash and refusing rather than silently re-approving.
import { scopeHash } from './hash.js';
import { parseMoney, formatMoney, add, ZERO } from './money.js';
import { newId, nowIso } from './ids.js';
import { assertTransition, BATCH_TRANSITIONS, BATCH_STATES } from './states.js';

export class BatchNotFoundError extends Error {
  constructor(batchId) {
    super(`migration_batch not found: ${batchId}`);
    this.code = 'BATCH_NOT_FOUND';
    this.batchId = batchId;
  }
}

export class RoleForbiddenError extends Error {
  constructor(role) {
    super(`Role '${role}' is not permitted to approve a batch (requires approver|admin)`);
    this.code = 'FORBIDDEN_ROLE';
    this.role = role;
  }
}

export class SegregationOfDutiesError extends Error {
  constructor(approver) {
    super(`Approver '${approver}' cannot approve a batch they created (segregation of duties)`);
    this.code = 'SOD_VIOLATION';
    this.approver = approver;
  }
}

export class ScopeChangedError extends Error {
  constructor(batchId) {
    super(`Batch ${batchId} scope changed since creation/approval; refusing`);
    this.code = 'SCOPE_CHANGED';
    this.batchId = batchId;
  }
}

function sodEnforced() {
  return process.env.SOD_ENFORCED !== 'false';
}

function isPassLike(status) {
  return status === 'PASS' || status === 'PASS_WITH_APPROVED_EXCEPTIONS';
}

async function latestReconRun(store, runId, layer) {
  const runs = await store.find('recon_runs', { run_id: runId, layer });
  if (runs.length === 0) return null;
  return runs.reduce((latest, r) => (!latest || r.created_at > latest.created_at ? r : latest), null);
}

/** Deterministically re-derive the batch's voucher scope from durable state (never
 * from a separate join table) so approveBatch/enqueueBatch can prove nothing moved
 * underneath the approval since createBatch computed it. */
async function computeScope(store, { runId, branchCode, period, batchId = null }) {
  // A voucher belongs to at most one live batch. When computing a NEW batch (batchId
  // null) only unstamped vouchers are in scope; when re-computing an existing batch's
  // scope (approve/invalidate) its own stamped vouchers are included. This is what
  // makes a rerun unable to re-batch already-migrated vouchers (Codex P2 follow-up).
  const vouchers = (await store.find('vouchers', { extraction_run_id: runId, disposition: 'MIGRATE' }))
    .filter((v) => v.branch_code === branchCode && v.period === period && v.target_payload_hash)
    .filter((v) => v.migration_batch_id == null || v.migration_batch_id === batchId);

  const mappingVersions = new Set();
  const transformationVersions = new Set();
  const cutoverRuleVersions = new Set();
  let debitTotal = ZERO;
  let creditTotal = ZERO;
  const byModule = {};

  for (const v of vouchers) {
    if (v.mapping_version) mappingVersions.add(v.mapping_version);
    if (v.transformation_version) transformationVersions.add(v.transformation_version);
    if (v.disposition_rule_version) cutoverRuleVersions.add(v.disposition_rule_version);
    debitTotal = add(debitTotal, parseMoney(v.debit_total));
    creditTotal = add(creditTotal, parseMoney(v.credit_total));
    const mod = v.target_module ?? 'UNKNOWN';
    if (!byModule[mod]) byModule[mod] = { count: 0, debit: ZERO, credit: ZERO };
    byModule[mod].count += 1;
    byModule[mod].debit = add(byModule[mod].debit, parseMoney(v.debit_total));
    byModule[mod].credit = add(byModule[mod].credit, parseMoney(v.credit_total));
  }

  const mappingVersion = [...mappingVersions].sort().at(-1) ?? null;
  const transformationVersion = [...transformationVersions].sort().at(-1) ?? null;
  const cutoverRuleVersion = [...cutoverRuleVersions].sort().at(-1) ?? null;

  const identities = vouchers.map((v) => ({ id: v.source_transaction_hash, payload_hash: v.target_payload_hash }));
  const hash = scopeHash({
    identities,
    mapping_version: mappingVersion,
    transformation_version: transformationVersion,
    cutover_rule_version: cutoverRuleVersion,
  });

  const byModuleFormatted = {};
  for (const [mod, g] of Object.entries(byModule)) {
    byModuleFormatted[mod] = { count: g.count, debit: formatMoney(g.debit), credit: formatMoney(g.credit) };
  }

  return {
    vouchers, mappingVersion, transformationVersion, cutoverRuleVersion, hash,
    voucherCount: vouchers.length, debitTotal: formatMoney(debitTotal), creditTotal: formatMoney(creditTotal),
    byModule: byModuleFormatted,
  };
}

/** collects MIGRATE vouchers with payloads for run+period; scope_hash pins the exact
 * set; DRAFT -> READY_FOR_APPROVAL only when the run's latest Layer A AND Layer B recon
 * runs both PASS (or PASS_WITH_APPROVED_EXCEPTIONS); otherwise stays DRAFT with the
 * reason recorded in totals_json so an operator can see why. */
export async function createBatch(ctx, { runId, branchCode, period, createdBy }) {
  const { store, audit, correlationId } = ctx;
  const now = ctx.now ? ctx.now() : nowIso();

  const scope = await computeScope(store, { runId, branchCode, period });

  // Idempotency: one live batch per (run, branch, period, scope). A rerun returns the
  // existing batch instead of minting a second approval scope over the same vouchers.
  const liveBatches = (await store.find('migration_batches', { run_id: runId, branch_code: branchCode, period }))
    .filter((b) => b.status !== BATCH_STATES.REJECTED && b.status !== BATCH_STATES.APPROVAL_INVALIDATED)
    .sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
  const sameScope = liveBatches.find((b) => b.scope_hash === scope.hash);
  const nothingLeftToBatch = scope.voucherCount === 0 && liveBatches.length > 0;

  const reconA = await latestReconRun(store, runId, 'A');
  const reconB = await latestReconRun(store, runId, 'B');
  let reason = null;
  if (!reconA) reason = 'NO_LAYER_A_RECON_RUN';
  else if (!isPassLike(reconA.status)) reason = `LAYER_A_STATUS_${reconA.status}`;
  else if (!reconB) reason = 'NO_LAYER_B_RECON_RUN';
  else if (!isPassLike(reconB.status)) reason = `LAYER_B_STATUS_${reconB.status}`;

  const eligible = reason === null && scope.voucherCount > 0;

  if (sameScope && sameScope.status === BATCH_STATES.DRAFT) {
    // Same scope, still a DRAFT: re-evaluate in place (the recon status may have changed
    // since the draft was minted) instead of creating a second batch row.
    const patch = { totals_json: JSON.stringify({ byModule: scope.byModule, reason: reason ?? undefined }), updated_at: now };
    if (eligible) {
      assertTransition(BATCH_TRANSITIONS, 'batch', BATCH_STATES.DRAFT, BATCH_STATES.READY_FOR_APPROVAL);
      patch.status = BATCH_STATES.READY_FOR_APPROVAL;
    }
    const updated = await store.update('migration_batches', sameScope.id, patch);
    await audit.emit({
      actor: createdBy, action: 'BATCH.CREATE_IDEMPOTENT', entityType: 'migration_batches', entityId: updated.id,
      before: { status: sameScope.status }, after: { status: updated.status, reason: reason ?? 'DRAFT_REEVALUATED' },
      correlationId, branchCode, period, batchId: updated.id,
    });
    return updated;
  }
  if (sameScope || nothingLeftToBatch) {
    const existing = sameScope ?? liveBatches[liveBatches.length - 1];
    await audit.emit({
      actor: createdBy, action: 'BATCH.CREATE_IDEMPOTENT', entityType: 'migration_batches', entityId: existing.id,
      after: { status: existing.status, reason: sameScope ? 'SAME_SCOPE_EXISTS' : 'NO_UNBATCHED_VOUCHERS' },
      correlationId, branchCode, period, batchId: existing.id,
    });
    return existing;
  }

  const batchId = newId('batch');
  const batch = await store.insert('migration_batches', {
    id: batchId,
    branch_code: branchCode,
    period,
    run_id: runId,
    scope_hash: scope.hash,
    mapping_version: scope.mappingVersion ?? '',
    transformation_version: scope.transformationVersion ?? '',
    cutover_rule_version: scope.cutoverRuleVersion ?? '',
    voucher_count: scope.voucherCount,
    debit_total: scope.debitTotal,
    credit_total: scope.creditTotal,
    totals_json: JSON.stringify({ byModule: scope.byModule, reason: reason ?? undefined }),
    status: BATCH_STATES.DRAFT,
    approval_id: null,
    created_by: createdBy,
    created_at: now,
    updated_at: now,
  });

  let finalBatch = batch;
  if (eligible) {
    assertTransition(BATCH_TRANSITIONS, 'batch', BATCH_STATES.DRAFT, BATCH_STATES.READY_FOR_APPROVAL);
    finalBatch = await store.update('migration_batches', batchId, { status: BATCH_STATES.READY_FOR_APPROVAL, updated_at: now });
  }

  await audit.emit({
    actor: createdBy,
    action: 'BATCH.CREATE',
    entityType: 'migration_batches',
    entityId: batchId,
    after: { status: finalBatch.status, voucherCount: scope.voucherCount, reason },
    reason: eligible ? null : reason,
    correlationId,
    branchCode,
    period,
    batchId,
  });

  return finalBatch;
}

/** role must be approver|admin; approver !== created_by unless SOD_ENFORCED==='false';
 * recomputes scope_hash and refuses (SCOPE_CHANGED) if the underlying voucher/payload
 * set moved since createBatch; stamps vouchers.approval_id/migration_batch_id. */
export async function approveBatch(ctx, { batchId, approver, approverRole, reason }) {
  const { store, audit, correlationId } = ctx;
  const now = ctx.now ? ctx.now() : nowIso();

  const batch = await store.get('migration_batches', batchId);
  if (!batch) throw new BatchNotFoundError(batchId);

  if (approverRole !== 'approver' && approverRole !== 'admin') {
    throw new RoleForbiddenError(approverRole);
  }
  if (sodEnforced() && approver === batch.created_by) {
    throw new SegregationOfDutiesError(approver);
  }

  const scope = await computeScope(store, { runId: batch.run_id, branchCode: batch.branch_code, period: batch.period, batchId: batch.id });
  if (scope.hash !== batch.scope_hash) {
    await audit.emit({
      actor: approver, actorRole: approverRole, action: 'BATCH.APPROVE_REFUSED_SCOPE_CHANGED',
      entityType: 'migration_batches', entityId: batchId,
      before: { scope_hash: batch.scope_hash }, after: { scope_hash: scope.hash },
      reason: 'scope_hash mismatch', authorizationDecision: 'DENIED',
      correlationId, branchCode: batch.branch_code, period: batch.period, batchId,
    });
    throw new ScopeChangedError(batchId);
  }

  assertTransition(BATCH_TRANSITIONS, 'batch', batch.status, BATCH_STATES.APPROVED);

  const approvalId = newId('appr');
  await store.insert('approvals', {
    id: approvalId,
    batch_id: batchId,
    scope_hash: batch.scope_hash,
    decision: 'APPROVED',
    approver,
    approver_role: approverRole,
    reason: reason ?? null,
    invalidated_at: null,
    invalidation_reason: null,
    created_at: now,
  });

  const updated = await store.update('migration_batches', batchId, {
    status: BATCH_STATES.APPROVED, approval_id: approvalId, updated_at: now,
  });

  for (const v of scope.vouchers) {
    await store.update('vouchers', v.id, { approval_id: approvalId, migration_batch_id: batchId, updated_at: now });
  }

  await audit.emit({
    actor: approver, actorRole: approverRole, action: 'BATCH.APPROVE',
    entityType: 'migration_batches', entityId: batchId,
    before: { status: batch.status }, after: { status: updated.status, approvalId },
    reason, correlationId, branchCode: batch.branch_code, period: batch.period, batchId,
  });

  return updated;
}

/** Recompute scope_hash; if it differs from the batch's stored value, invalidate the
 * standing approval (never silently re-approve) and clear the stamped voucher links. */
export async function invalidateApprovalIfChanged(ctx, { batchId, reason }) {
  const { store, audit, correlationId } = ctx;
  const now = ctx.now ? ctx.now() : nowIso();

  const batch = await store.get('migration_batches', batchId);
  if (!batch) throw new BatchNotFoundError(batchId);

  const scope = await computeScope(store, { runId: batch.run_id, branchCode: batch.branch_code, period: batch.period, batchId: batch.id });
  if (scope.hash === batch.scope_hash) {
    return { changed: false, batch };
  }

  if (!BATCH_TRANSITIONS[batch.status]?.includes(BATCH_STATES.APPROVAL_INVALIDATED)) {
    // Nothing to invalidate from this state (e.g. still DRAFT/READY_FOR_APPROVAL: no
    // standing approval exists yet) — surface the drift without forcing a transition.
    return { changed: true, invalidated: false, batch };
  }

  assertTransition(BATCH_TRANSITIONS, 'batch', batch.status, BATCH_STATES.APPROVAL_INVALIDATED);

  if (batch.approval_id) {
    const approval = await store.get('approvals', batch.approval_id);
    if (approval && !approval.invalidated_at) {
      await store.update('approvals', batch.approval_id, { invalidated_at: now, invalidation_reason: reason ?? 'SCOPE_CHANGED' });
    }
  }

  const updated = await store.update('migration_batches', batchId, {
    status: BATCH_STATES.APPROVAL_INVALIDATED, approval_id: null, updated_at: now,
  });

  const affected = await store.find('vouchers', { migration_batch_id: batchId, approval_id: batch.approval_id });
  for (const v of affected) {
    await store.update('vouchers', v.id, { approval_id: null, updated_at: now });
  }

  await audit.emit({
    actor: ctx.actor ?? 'worker', action: 'BATCH.APPROVAL_INVALIDATED',
    entityType: 'migration_batches', entityId: batchId,
    before: { status: batch.status, scope_hash: batch.scope_hash }, after: { status: updated.status, scope_hash: scope.hash },
    reason: reason ?? 'SCOPE_CHANGED', correlationId, branchCode: batch.branch_code, period: batch.period, batchId,
  });

  return { changed: true, invalidated: true, batch: updated };
}

/** APPROVED only; inserts queue_items (idempotency_key = source_transaction_hash);
 * a UNIQUE_VIOLATION on that key means the item is already queued (from a prior
 * partial/interrupted enqueue, or another batch) — skip it rather than failing the
 * whole batch, so a retry after a crash is safe. */
export async function enqueueBatch(ctx, { batchId }) {
  const { store, audit, correlationId } = ctx;
  const now = ctx.now ? ctx.now() : nowIso();

  const batch = await store.get('migration_batches', batchId);
  if (!batch) throw new BatchNotFoundError(batchId);

  assertTransition(BATCH_TRANSITIONS, 'batch', batch.status, BATCH_STATES.QUEUED);

  const scope = await computeScope(store, { runId: batch.run_id, branchCode: batch.branch_code, period: batch.period, batchId: batch.id });

  let enqueued = 0;
  let skippedExisting = 0;
  for (const v of scope.vouchers) {
    try {
      await store.insert('queue_items', {
        batch_id: batchId,
        voucher_id: v.id,
        idempotency_key: v.source_transaction_hash,
        status: 'QUEUED',
        claimed_by: null,
        claimed_at: null,
        claim_expires_at: null,
        run_after: null,
        attempts: 0,
        last_error_code: null,
        created_at: now,
        updated_at: now,
      });
      enqueued += 1;
    } catch (e) {
      if (e && e.code === 'UNIQUE_VIOLATION') {
        skippedExisting += 1;
      } else {
        throw e;
      }
    }
  }

  const updated = await store.update('migration_batches', batchId, { status: BATCH_STATES.QUEUED, updated_at: now });

  await audit.emit({
    actor: ctx.actor ?? 'worker', action: 'BATCH.ENQUEUE',
    entityType: 'migration_batches', entityId: batchId,
    before: { status: batch.status }, after: { status: updated.status, enqueued, skippedExisting },
    correlationId, branchCode: batch.branch_code, period: batch.period, batchId,
  });

  return { batch: updated, enqueued, skippedExisting };
}
