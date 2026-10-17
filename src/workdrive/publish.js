// Put the WorkDrive branches on the console's Branch Control Dashboard: every branch folder gets a
// `branches` row and a `branch_summaries` row. A branch the console has no import runs for (the
// WorkDrive route) shows the WorkDrive picture: files received, the Eco Green TB check, our
// voucher count and readiness. Branches with import runs keep the summary derived from those.
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
    await refreshBranchSummary(store, code, { now });
    const runs = await store.find('extraction_runs', { branch_code: code });
    if (!runs.length) await store.update('branch_summaries', code, { ...summaryFields(row), last_activity_at: now, updated_at: now });
  }
  log(`dashboard: ${tracker.length} branches (${added} new)`);
}
