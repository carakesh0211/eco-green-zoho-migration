// Put the WorkDrive branches on the console's Branch Control Dashboard: every branch folder gets a
// `branches` row and a `branch_summaries` row showing the WorkDrive picture (files received, the
// Eco Green TB check, our voucher count, readiness) — also for branches with earlier pilot import
// runs, whose run-derived counts are stale once the branch comes through WorkDrive.
import { refreshBranchSummary } from '../core/branch_summary.js';
import { nowIso } from '../core/ids.js';
import { REQUIRED } from './sync.js';

const READINESS = {
  READY: 'READY', 'OPENING FILE RECEIVED': 'IN_PROGRESS', 'WAITING FOR OPENING': 'IN_PROGRESS',
  FIX: 'BLOCKED', 'PLAN ERROR': 'BLOCKED', 'WAITING FOR FILES': 'NOT_STARTED', EXCLUDED: 'NOT_STARTED',
};

/** Dashboard fields for one tracker row (src/workdrive/sync.js#trackerRow). */
export function summaryFields(row) {
  const missing = new Set(String(row.missing_files || '').split(';').map((s) => s.trim()).filter(Boolean));
  const got = REQUIRED.filter((k) => !missing.has(k)).length;
  if (row.status === 'EXCLUDED') return { receipt_status: 'NOT_RECEIVED', layer_a_status: 'NOT_RUN', total_count: 0, readiness_status: 'NOT_STARTED' };
  const planned = row.our_vouchers !== '' && row.our_vouchers !== undefined && row.our_vouchers !== null;
  return {
    receipt_status: got === REQUIRED.length ? 'RECEIVED' : got ? 'PARTIAL' : 'NOT_RECEIVED',
    layer_a_status: !planned ? 'NOT_RUN' : /closing TB/i.test(row.problems ?? '') ? 'FAIL' : 'PASS',
    total_count: planned ? Number(row.our_vouchers) || 0 : 0,
    readiness_status: READINESS[row.status] ?? 'IN_PROGRESS',
  };
}

const regionName = (region) => {
  const top = String(region || '').split('/')[0];
  return top ? top.charAt(0).toUpperCase() + top.slice(1) : '';
};

export async function publishToDashboard(store, tracker, { now = nowIso(), log = () => {} } = {}) {
  let added = 0;
  for (const row of tracker) {
    const code = String(row.branch);
    if (!(await store.findOne('branches', { branch_code: code }))) {
      await store.insert('branches', { branch_code: code, branch_name: `${regionName(row.region)} ${code}`.trim(), status: 'ACTIVE', created_at: now, updated_at: now });
      added += 1;
    }
    // the WorkDrive picture wins: earlier pilot imports (e.g. 460) would otherwise show stale counts
    await refreshBranchSummary(store, code, { now });
    await store.update('branch_summaries', code, { ...summaryFields(row), last_activity_at: now, updated_at: now });
  }
  log(`dashboard: ${tracker.length} branches (${added} new)`);
}
