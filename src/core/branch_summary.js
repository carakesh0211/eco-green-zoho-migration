// Branch Control Dashboard: derive one denormalised `branch_summaries` row from the
// transactional tables. See CONTRACTS.md §S for the store contract and
// src/adapters/store/schema.sql (bottom, "increment 2") for the exact 27 columns.
//
// Pure and deterministic: computeBranchSummary() only ever READS from the store and
// derives its output from `now` + whatever rows already exist — calling it twice
// against the same data returns the same object (module-version fields aside).
// refreshBranchSummary() is the only function in this file that writes.
//
// Column derivations that were NOT spelled out unambiguously in the task note (see
// the doc comments inline below for the reasoning):
//   - live_start_date       <- cutover_matrix.live_system_start_date (the task note's
//                              "live start" column; there is no column literally named
//                              live_start_date on cutover_matrix).
//   - migration_to_date     <- cutover_matrix.historical_migration_end_date (the task
//                              note calls this "migration_to_date"; the actual schema
//                              column is historical_migration_end_date).
//   - mapping_status        mapping_rules carries NO branch_code column (it is global
//                              reference config - ledger/party/payment-mode/tax
//                              mappings), so mapping_status is the SAME value for every
//                              branch: derived from the full mapping_rules table,
//                              ignoring RETIRED rows.
//   - zoho_location_name    <- books_locations row matched by branch_code (the only
//                              table that carries a human-readable location name).
//   - migrated_count        vouchers has no migration_status literal 'MIGRATED' (the
//                              BATCH_STATES machine does, but not QUEUE/voucher
//                              migration_status); 'POSTED' is the only success terminal
//                              for a voucher row, so migrated_count counts POSTED.
//   - layer_a/c/balance_bridge status  PASS_WITH_APPROVED_EXCEPTIONS collapses to PASS
//                              (matches the isPassLike() convention already used in
//                              src/server/routes/dev.js and src/core/bridge.js).
//   - batch_approval_status  any migration_batches status past APPROVED (QUEUED,
//                              MIGRATING, PAUSED, PARTIALLY_MIGRATED, MIGRATED,
//                              POST_RECONCILIATION, RECONCILIATION_FAILED, SIGNED_OFF)
//                              maps to APPROVED (approval already happened and was
//                              never revoked); APPROVAL_INVALIDATED maps to REJECTED
//                              (approval no longer holds; needs re-approval).
import { nowIso } from './ids.js';
import { parseMoney, formatMoney, abs as moneyAbs, sum as moneySum } from './money.js';

export class BranchNotFoundError extends Error {
  constructor(branchCode) {
    super(`Branch not found: ${branchCode}`);
    this.code = 'BRANCH_NOT_FOUND';
    this.branchCode = branchCode;
  }
}

const OPEN_EXCEPTION_CLOSED_STATUSES = new Set(['RESOLVED', 'CLOSED']);
const P0_P1 = new Set(['P0', 'P1']);

function latestByCreatedAt(rows) {
  return rows.reduce((best, r) => (!best || r.created_at > best.created_at ? r : best), null);
}

/** PASS_WITH_APPROVED_EXCEPTIONS is treated as PASS everywhere else in this codebase
 * (src/server/routes/dev.js#isPassLike, src/core/bridge.js) — branch_summaries only
 * models NOT_RUN | PASS | FAIL, so the same collapse applies here. */
function mapReconStatus(row) {
  if (!row) return 'NOT_RUN';
  if (row.status === 'PASS' || row.status === 'PASS_WITH_APPROVED_EXCEPTIONS') return 'PASS';
  if (row.status === 'FAIL') return 'FAIL';
  return 'NOT_RUN';
}

function mapMappingStatus(rows) {
  const active = rows.filter((r) => r.status !== 'RETIRED');
  if (active.length === 0) return 'NOT_STARTED';
  return active.every((r) => r.status === 'APPROVED') ? 'APPROVED' : 'DRAFT';
}

function mapOverlapStatus(classifications) {
  if (classifications.length === 0) return 'NOT_ASSESSED';
  const found = classifications.some((c) => c === 'SMART_PHARMA_ALREADY_POSTED' || c === 'PARTIAL_OR_AMBIGUOUS_OVERLAP');
  return found ? 'OVERLAP_FOUND' : 'CLEAR';
}

/** Maps a migration_batches.status value onto the 5-state dashboard bucket. `null`
 * (no batch exists yet for this branch) maps to NONE. */
function mapBatchApprovalStatus(status) {
  if (!status) return 'NONE';
  if (status === 'DRAFT') return 'DRAFT';
  if (status === 'READY_FOR_APPROVAL') return 'READY_FOR_APPROVAL';
  if (status === 'REJECTED' || status === 'APPROVAL_INVALIDATED') return 'REJECTED';
  return 'APPROVED'; // APPROVED, QUEUED, MIGRATING, PAUSED, PARTIALLY_MIGRATED, MIGRATED, POST_RECONCILIATION, RECONCILIATION_FAILED, SIGNED_OFF
}

function mapReceiptStatus(latestRun, filesOfLatestRun) {
  if (!latestRun) return 'NOT_RECEIVED';
  if (latestRun.status === 'VALIDATION_FAILED') return 'VALIDATION_FAILED';
  const anyArchived = filesOfLatestRun.some((f) => f.status === 'ARCHIVED');
  return anyArchived ? 'RECEIVED' : 'PARTIAL';
}

/**
 * computeBranchSummary(store, branchCode, { now }) -> full branch_summaries row (27
 * columns, plain object; caller decides whether/how to persist it). Throws
 * BranchNotFoundError if `branches` has no row for branchCode.
 */
/** Most recent '*'-class assignment for the branch (drives assigned_operator/approver). */
async function latestWholeBranchAssignment(store, branchCode) {
  const rows = await store.find('branch_period_assignments', { branch_code: branchCode, transaction_class: '*' }, { orderBy: 'period DESC' });
  return rows[0] ?? null;
}

export async function computeBranchSummary(store, branchCode, { now = nowIso() } = {}) {
  const branch = await store.findOne('branches', { branch_code: branchCode });
  if (!branch) throw new BranchNotFoundError(branchCode);

  const [
    cutoverRows,
    runs,
    recon_A,
    recon_C,
    recon_BB,
    mappingRows,
    vouchers,
    exceptions,
    batches,
    assignments,
    auditEvents,
    location,
  ] = await Promise.all([
    store.find('cutover_matrix', { branch_code: branchCode }),
    store.find('extraction_runs', { branch_code: branchCode }, { orderBy: 'created_at DESC' }),
    store.find('recon_runs', { branch_code: branchCode, layer: 'A' }, { orderBy: 'created_at DESC' }),
    store.find('recon_runs', { branch_code: branchCode, layer: 'C' }, { orderBy: 'created_at DESC' }),
    store.find('recon_runs', { branch_code: branchCode, layer: 'BALANCE_BRIDGE' }, { orderBy: 'created_at DESC' }),
    store.find('mapping_rules', {}),
    store.find('vouchers', { branch_code: branchCode }),
    store.find('exceptions', { branch_code: branchCode }),
    store.find('migration_batches', { branch_code: branchCode }, { orderBy: 'created_at DESC' }),
    store.find('branch_period_assignments', { branch_code: branchCode, transaction_class: '*' }, { orderBy: 'period DESC' }),
    store.find('audit_events', { branch_code: branchCode }, { orderBy: 'created_at DESC', limit: 1 }),
    store.findOne('books_locations', { branch_code: branchCode }),
  ]);

  // ---- cutover (prefer the all-classes '*' row; else the most recently created row) ----
  const cutover = cutoverRows.find((r) => r.transaction_class === '*') ?? latestByCreatedAt(cutoverRows);

  // ---- receipt status ----
  const latestRun = runs[0] ?? null;
  const filesOfLatestRun = latestRun ? await store.find('source_files', { run_id: latestRun.id }) : [];
  const receipt_status = mapReceiptStatus(latestRun, filesOfLatestRun);

  // ---- Layer A / C / balance bridge ----
  const layer_a_status = mapReconStatus(recon_A[0] ?? null);
  const layer_c_status = mapReconStatus(recon_C[0] ?? null);
  const balance_bridge_status = mapReconStatus(recon_BB[0] ?? null);

  // ---- mapping (global, not branch-scoped; see file header) ----
  const mapping_status = mapMappingStatus(mappingRows);

  // ---- overlap (per-voucher overlap_candidates, joined by voucher id) ----
  const overlapClassifications = [];
  for (const v of vouchers) {
    const candidates = await store.find('overlap_candidates', { voucher_id: v.id });
    for (const c of candidates) overlapClassifications.push(c.classification);
  }
  const overlap_status = mapOverlapStatus(overlapClassifications);

  // ---- exceptions (open = not RESOLVED/CLOSED) ----
  const openExceptions = exceptions.filter((e) => !OPEN_EXCEPTION_CLOSED_STATUSES.has(e.status));
  const open_exception_count = openExceptions.length;
  const open_exception_impact = formatMoney(moneySum(openExceptions.map((e) => moneyAbs(parseMoney(e.financial_impact)))));
  const hasBlockingException = openExceptions.some((e) => P0_P1.has(e.severity));

  // ---- batch approval ----
  const latestBatch = batches[0] ?? null;
  const batch_approval_status = mapBatchApprovalStatus(latestBatch?.status ?? null);

  // ---- vouchers / migration progress ----
  const migrateVouchers = vouchers.filter((v) => v.disposition === 'MIGRATE');
  const total_count = migrateVouchers.length;
  const migrated_count = migrateVouchers.filter((v) => v.migration_status === 'POSTED').length;
  const migration_progress_pct = total_count > 0 ? Math.round((migrated_count / total_count) * 100) : 0;

  // ---- assignment (most recent period, '*' transaction class) ----
  const assignment = assignments[0] ?? null;

  // ---- readiness ----
  let readiness_status;
  if (migration_progress_pct === 100 && layer_c_status === 'PASS') {
    readiness_status = 'MIGRATED';
  } else if (hasBlockingException || layer_a_status === 'FAIL') {
    readiness_status = 'BLOCKED';
  } else if (
    layer_a_status === 'PASS' &&
    mapping_status === 'APPROVED' &&
    overlap_status === 'CLEAR' &&
    batch_approval_status === 'APPROVED'
  ) {
    readiness_status = 'READY';
  } else if (runs.length > 0) {
    readiness_status = 'IN_PROGRESS';
  } else {
    readiness_status = 'NOT_STARTED';
  }

  return {
    branch_code: branchCode,
    branch_name: branch.branch_name,
    zoho_location_id: branch.zoho_location_id ?? null,
    zoho_location_name: location?.location_name ?? null,
    assigned_operator: assignment?.assigned_operator ?? null,
    assigned_approver: assignment?.assigned_approver ?? null,
    live_start_date: cutover?.live_system_start_date ?? null,
    migration_from_date: cutover?.migration_from_date ?? null,
    migration_to_date: cutover?.historical_migration_end_date ?? null,
    receipt_status,
    layer_a_status,
    mapping_status,
    overlap_status,
    open_exception_count,
    open_exception_impact,
    batch_approval_status,
    migrated_count,
    total_count,
    migration_progress_pct,
    layer_c_status,
    balance_bridge_status,
    last_activity_at: auditEvents[0]?.created_at ?? null,
    readiness_status,
    is_synthetic: 0,
    summary_version: 1,
    created_at: now,
    updated_at: now,
  };
}

/**
 * refreshBranchSummary(store, branchCode, { now }) -> upserts branch_summaries,
 * bumping summary_version on every update (starts at 1 on first insert).
 */
export async function refreshBranchSummary(store, branchCode, { now = nowIso() } = {}) {
  const existing = await store.get('branch_summaries', branchCode);
  let computed;
  try {
    computed = await computeBranchSummary(store, branchCode, { now });
  } catch (err) {
    // A summary-only branch (the synthetic EG-* rows have no `branches` row) keeps its
    // seeded statuses; only the assignment-derived columns are re-derived. Anything
    // else (unknown branch, store failure) still propagates.
    if (!(err instanceof BranchNotFoundError) || !existing) throw err;
    const assignment = await latestWholeBranchAssignment(store, branchCode);
    return store.update('branch_summaries', branchCode, {
      assigned_operator: assignment?.assigned_operator ?? existing.assigned_operator ?? null,
      assigned_approver: assignment?.assigned_approver ?? existing.assigned_approver ?? null,
      last_activity_at: assignment ? now : existing.last_activity_at,
      summary_version: existing.summary_version + 1,
      updated_at: now,
    });
  }
  if (!existing) {
    return store.insert('branch_summaries', { ...computed, summary_version: 1, created_at: now, updated_at: now });
  }
  const patch = { ...computed, summary_version: existing.summary_version + 1, created_at: existing.created_at, updated_at: now };
  delete patch.branch_code;
  return store.update('branch_summaries', branchCode, patch);
}
