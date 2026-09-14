// Branch/transaction-class cutover matrix (CONTRACTS.md §K, PROJECT_CONTEXT "Branch cutover matrix").
//
// Date alone never decides eligibility. Smart Pharma has already posted some
// populations to the live Zoho Books org; the eligibility + overlap gate exists
// specifically to prevent duplicating them. See overlap.js for the overlap gate
// that runs after a voucher is found IN_WINDOW here.

import { uk } from './ids.js';

/**
 * Upsert cutover_matrix rows by their composite uk (branch|class|payment_method|rule_version).
 * Rows default to DRAFT unless the caller explicitly sets approval_status: 'APPROVED'.
 * Only APPROVED rows are ever considered by resolveCutover.
 */
export async function loadCutoverMatrix(ctx, rows) {
  const { store } = ctx;
  const now = ctx.now ? ctx.now() : new Date().toISOString();
  const out = [];
  for (const row of rows) {
    const rowUk = uk(row.branch_code, row.transaction_class ?? '*', row.payment_method ?? '*', row.cutover_rule_version);
    const existing = await store.findOne('cutover_matrix', { uk: rowUk });
    const patch = {
      branch_code: row.branch_code,
      zoho_location_id: row.zoho_location_id ?? null,
      migration_from_date: row.migration_from_date,
      live_system_start_date: row.live_system_start_date ?? null,
      historical_migration_end_date: row.historical_migration_end_date ?? null,
      transaction_class: row.transaction_class ?? '*',
      payment_method: row.payment_method ?? '*',
      smart_pharma_coverage_status: row.smart_pharma_coverage_status ?? 'UNKNOWN',
      cutover_rule_version: row.cutover_rule_version,
      approval_status: row.approval_status === 'APPROVED' ? 'APPROVED' : (row.approval_status ?? 'DRAFT'),
      approved_by: row.approved_by ?? null,
      approved_at: row.approved_at ?? null,
      evidence_ref: row.evidence_ref ?? null,
      uk: rowUk,
      updated_at: now,
    };
    if (existing) {
      out.push(await store.update('cutover_matrix', existing.id, patch));
    } else {
      out.push(await store.insert('cutover_matrix', { ...patch, created_at: now }));
    }
  }
  return out;
}

/**
 * Pick the single most specific APPROVED cutover row for a voucher's
 * (branch, voucher_type, payment_method). DRAFT and REVOKED rows are ignored.
 * Resolution order: (class, payment_method) > (class, '*') > ('*', '*').
 * Returns null when no APPROVED row applies.
 */
export function resolveCutover(matrixRows, { branchCode, voucherType, paymentMethod }) {
  const approved = (matrixRows ?? []).filter(
    r => r.approval_status === 'APPROVED' && r.branch_code === branchCode,
  );
  const exact = approved.find(r => r.transaction_class === voucherType && r.payment_method === paymentMethod);
  if (exact) return exact;
  const classWildcardPayment = approved.find(r => r.transaction_class === voucherType && r.payment_method === '*');
  if (classWildcardPayment) return classWildcardPayment;
  const fullyWild = approved.find(r => r.transaction_class === '*' && r.payment_method === '*');
  if (fullyWild) return fullyWild;
  return null;
}

const ELIGIBILITY_REASONS = Object.freeze({
  RULE_MISSING: 'RULE_MISSING',
  LIVE_START_UNVERIFIED: 'LIVE_START_UNVERIFIED',
  BEFORE_MIGRATION_FROM: 'BEFORE_MIGRATION_FROM',
  AFTER_CUTOVER: 'AFTER_CUTOVER',
  LATE_OR_BACK_POSTED: 'LATE_OR_BACK_POSTED',
  IN_WINDOW: 'IN_WINDOW',
});
export { ELIGIBILITY_REASONS };

function datePart(v) {
  if (v === null || v === undefined) return null;
  const s = String(v);
  return s.length >= 10 ? s.slice(0, 10) : s;
}

/**
 * Evaluate whether a voucher falls inside the approved migration window for its
 * resolved cutover rule. ISO string comparison only — never Date arithmetic on money
 * or on the window itself (lexicographic comparison of YYYY-MM-DD is exact).
 *
 * Priority (first match wins):
 *   RULE_MISSING -> LIVE_START_UNVERIFIED -> BEFORE_MIGRATION_FROM -> AFTER_CUTOVER
 *   -> LATE_OR_BACK_POSTED -> IN_WINDOW
 *
 * Boundary rules: transaction_date == live_system_start_date -> AFTER_CUTOVER;
 * transaction_date == historical_migration_end_date -> IN_WINDOW.
 */
export function evaluateEligibility(rule, voucher) {
  if (!rule) {
    return { eligible: false, reason: ELIGIBILITY_REASONS.RULE_MISSING };
  }
  const liveStart = rule.live_system_start_date;
  const coverage = rule.smart_pharma_coverage_status;
  if (liveStart === null || liveStart === undefined || liveStart === '' || coverage === 'UNKNOWN' || coverage === null || coverage === undefined) {
    return { eligible: false, reason: ELIGIBILITY_REASONS.LIVE_START_UNVERIFIED };
  }

  const txnDate = voucher.transaction_date;
  const migrationFrom = rule.migration_from_date;
  if (migrationFrom && txnDate < migrationFrom) {
    return { eligible: false, reason: ELIGIBILITY_REASONS.BEFORE_MIGRATION_FROM };
  }

  const historicalEnd = rule.historical_migration_end_date;
  const afterLiveStart = txnDate >= liveStart;
  const afterHistoricalEnd = historicalEnd ? txnDate > historicalEnd : false;
  if (afterLiveStart || afterHistoricalEnd) {
    return { eligible: false, reason: ELIGIBILITY_REASONS.AFTER_CUTOVER };
  }

  const modifiedDate = datePart(voucher.source_modified_at ?? voucher.modified_at);
  if (modifiedDate && modifiedDate >= liveStart) {
    return { eligible: false, reason: ELIGIBILITY_REASONS.LATE_OR_BACK_POSTED };
  }

  return { eligible: true, reason: ELIGIBILITY_REASONS.IN_WINDOW };
}
