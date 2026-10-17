// Change the Zoho Books location of a branch before anything of it is posted.
//
// The location is copied onto every voucher at import and into every prepared payload, and
// approved batches pin the payload hashes. So a change here:
//   1. refuses while any batch of the branch is queued, migrating or later, or any voucher
//      has been sent to Books;
//   2. withdraws the approval of every APPROVED batch (what was approved has changed), sets
//      every open batch aside as REJECTED and frees its vouchers;
//   3. sets the new location on the branch, its summary row and every unposted voucher;
//   4. re-transforms each of the branch's runs, so every payload carries the new location.
// The batches are then built again (step 4 "Build batch for approval") and approved afresh by
// a second person. Nothing is approved or posted here. It touches every voucher of the branch,
// so the server runs it as a detached job (src/server/retransform_jobs.js).
import { nowIso } from './ids.js';
import { assertTransition, BATCH_TRANSITIONS, BATCH_STATES } from './states.js';
import { retransformRun } from './transform.js';

const OPEN_BATCH_STATES = new Set([
  BATCH_STATES.DRAFT, BATCH_STATES.READY_FOR_APPROVAL, BATCH_STATES.APPROVED,
  BATCH_STATES.APPROVAL_INVALIDATED, BATCH_STATES.REJECTED,
]);
const SENT_VOUCHER_STATES = new Set(['IN_FLIGHT', 'POSTED', 'UNKNOWN_OUTCOME', 'QUEUED', 'DEAD_LETTER', 'FAILED']);
const RETRANSFORMABLE_RUN_STATES = new Set(['CLASSIFIED', 'TRANSFORMED', 'READY_FOR_APPROVAL']);

function codedError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/** The preconditions, without changing anything (fast enough for the request path).
 * -> { branch, target, batches, runs, vouchersByRun } */
export async function checkLocationChange(ctx, { branchCode, locationId, reason }) {
  const { store } = ctx;
  const target = String(locationId ?? '').trim();
  if (!/^\d{6,25}$/.test(target)) throw codedError('BAD_LOCATION_ID', 'locationId must be a Zoho Books location id (digits only)');
  if (!reason || !String(reason).trim()) throw codedError('REASON_REQUIRED', 'a reason is required');

  const branch = await store.get('branches', branchCode);
  if (!branch) throw codedError('NOT_FOUND', `Branch not found: ${branchCode}`);

  const batches = await store.find('migration_batches', { branch_code: branchCode });
  const busy = batches.find((b) => !OPEN_BATCH_STATES.has(b.status));
  if (busy) throw codedError('BATCH_IN_PROGRESS', `Batch ${busy.id} (${busy.period}) is ${busy.status}; the location can only change before anything is queued or posted`);

  const runs = await store.find('extraction_runs', { branch_code: branchCode });
  const vouchersByRun = new Map();
  for (const run of runs) {
    const vouchers = await store.find('vouchers', { extraction_run_id: run.id });
    const sent = vouchers.find((v) => SENT_VOUCHER_STATES.has(v.migration_status));
    if (sent) throw codedError('VOUCHER_SENT', `Voucher ${sent.source_record_id} is ${sent.migration_status}; the location can only change before anything is sent to Books`);
    vouchersByRun.set(run.id, vouchers);
  }
  return { branch, target, batches, runs, vouchersByRun };
}

/** -> { branchCode, before, after, batchesSetAside: [{ id, period, from }], vouchersUpdated, runsRetransformed } */
export async function changeBranchLocation(ctx, { branchCode, locationId, locationName = null, reason }) {
  const { store, audit } = ctx;
  const now = ctx.now ? ctx.now() : nowIso();
  const { branch, target, batches, runs, vouchersByRun } = await checkLocationChange(ctx, { branchCode, locationId, reason });
  const before = branch.zoho_location_id ?? null;

  // 2. Withdraw approvals; set every open batch aside as REJECTED and free its vouchers.
  const batchesSetAside = [];
  for (const batch of batches) {
    if (batch.status === BATCH_STATES.REJECTED) continue;
    const from = batch.status;
    if (batch.status === BATCH_STATES.APPROVED) {
      if (batch.approval_id) {
        const approval = await store.get('approvals', batch.approval_id);
        if (approval && !approval.invalidated_at) {
          await store.update('approvals', batch.approval_id, { invalidated_at: now, invalidation_reason: 'LOCATION_CHANGED' });
        }
      }
      assertTransition(BATCH_TRANSITIONS, 'batch', BATCH_STATES.APPROVED, BATCH_STATES.APPROVAL_INVALIDATED);
      batch.status = BATCH_STATES.APPROVAL_INVALIDATED;
    }
    if (batch.status === BATCH_STATES.APPROVAL_INVALIDATED) {
      assertTransition(BATCH_TRANSITIONS, 'batch', BATCH_STATES.APPROVAL_INVALIDATED, BATCH_STATES.DRAFT);
      batch.status = BATCH_STATES.DRAFT;
    }
    assertTransition(BATCH_TRANSITIONS, 'batch', batch.status, BATCH_STATES.REJECTED);
    await store.update('migration_batches', batch.id, { status: BATCH_STATES.REJECTED, approval_id: null, updated_at: now });
    batchesSetAside.push({ id: batch.id, period: batch.period, from });
  }
  const setAsideIds = new Set(batchesSetAside.map((x) => x.id));

  // 3. New location on the branch, its summary and every unposted voucher.
  await store.update('branches', branchCode, { zoho_location_id: target, updated_at: now });
  if (await store.get('branch_summaries', branchCode)) {
    await store.update('branch_summaries', branchCode, { zoho_location_id: target, zoho_location_name: locationName });
  }
  let vouchersUpdated = 0;
  for (const vouchers of vouchersByRun.values()) {
    for (const v of vouchers) {
      const freed = setAsideIds.has(v.migration_batch_id);
      if (v.zoho_location_id === target && !freed) continue;
      await store.update('vouchers', v.id, {
        zoho_location_id: target, updated_at: now,
        ...(freed ? { migration_batch_id: null, approval_id: null } : {}),
      });
      vouchersUpdated += 1;
    }
  }

  // 4. Re-transform so every payload carries the new location.
  let runsRetransformed = 0;
  for (const run of runs) {
    if (!RETRANSFORMABLE_RUN_STATES.has(run.status)) continue;
    await retransformRun(ctx, { runId: run.id });
    runsRetransformed += 1;
  }

  await audit.emit({
    actor: ctx.actor, actorRole: ctx.actorRole, action: 'BRANCH.LOCATION_CHANGED', entityType: 'branches', entityId: branchCode,
    before: { zoho_location_id: before }, after: { zoho_location_id: target, vouchersUpdated, runsRetransformed, batchesSetAside },
    reason: String(reason).trim(), correlationId: ctx.correlationId, branchCode,
  });

  return { branchCode, before, after: target, batchesSetAside, vouchersUpdated, runsRetransformed };
}
