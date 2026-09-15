// Pure query/paging/CSV helpers over an array of `branch_summaries` rows (see
// src/adapters/store/schema.sql, "increment 2"). No store access here — the HTTP layer
// (src/server/routes/branches.js) is responsible for fetching rows and applying branch
// scope BEFORE calling applyBranchQuery, so `counts`/`total` here always reflect
// exactly what the caller is entitled to see.
import { parseMoney } from './money.js';

/** The 27 branch_summaries columns, in schema.sql order — the fixed CSV column order
 * and the sort whitelist. */
export const BRANCH_SUMMARY_COLUMNS = Object.freeze([
  'branch_code',
  'branch_name',
  'zoho_location_id',
  'zoho_location_name',
  'assigned_operator',
  'assigned_approver',
  'live_start_date',
  'migration_from_date',
  'migration_to_date',
  'receipt_status',
  'layer_a_status',
  'mapping_status',
  'overlap_status',
  'open_exception_count',
  'open_exception_impact',
  'batch_approval_status',
  'migrated_count',
  'total_count',
  'migration_progress_pct',
  'layer_c_status',
  'balance_bridge_status',
  'last_activity_at',
  'readiness_status',
  'is_synthetic',
  'summary_version',
  'created_at',
  'updated_at',
]);

/** query param name -> branch_summaries column name, for the equality filters.
 * Exported so the route layer can push these exact same filters down into
 * `store.find('branch_summaries', where)` before re-applying filterAndSortBranches/
 * applyBranchQuery for search/date-range/sort/paging (equality filters applied twice
 * is a harmless no-op — store.find only supports equality). */
export const EQUALITY_FILTER_MAP = Object.freeze({
  readiness: 'readiness_status',
  receipt: 'receipt_status',
  layerA: 'layer_a_status',
  mapping: 'mapping_status',
  overlap: 'overlap_status',
  approval: 'batch_approval_status',
  layerC: 'layer_c_status',
  bridge: 'balance_bridge_status',
  operator: 'assigned_operator',
  approver: 'assigned_approver',
});

const NUMERIC_COLUMNS = new Set(['open_exception_count', 'migrated_count', 'total_count', 'migration_progress_pct', 'summary_version', 'is_synthetic']);
const MONEY_COLUMNS = new Set(['open_exception_impact']);

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

function toPositiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && Number.isInteger(n) ? n : fallback;
}

function compareValues(a, b, column) {
  if (NUMERIC_COLUMNS.has(column)) {
    return (Number(a) || 0) - (Number(b) || 0);
  }
  if (MONEY_COLUMNS.has(column)) {
    const pa = parseMoney(a ?? '0.00');
    const pb = parseMoney(b ?? '0.00');
    return pa < pb ? -1 : pa > pb ? 1 : 0;
  }
  const aNil = a === null || a === undefined || a === '';
  const bNil = b === null || b === undefined || b === '';
  if (aNil && bNil) return 0;
  if (aNil) return 1; // nulls/blank sort last regardless of direction
  if (bNil) return -1;
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * filterAndSortBranches(rows, query) -> { sorted, counts } — every applyBranchQuery
 * knob EXCEPT pagination. Exported so CSV export (which must return every matching
 * row, not just one page) can reuse the exact same filter/search/sort semantics as
 * the paginated JSON list without going through the 200-row pageSize cap.
 */
export function filterAndSortBranches(rows, query = {}) {
  let filtered = rows;

  const search = String(query.search ?? '').trim().toLowerCase();
  if (search) {
    filtered = filtered.filter((r) =>
      [r.branch_code, r.branch_name, r.zoho_location_name].some(
        (v) => typeof v === 'string' && v.toLowerCase().includes(search)
      )
    );
  }

  for (const [param, column] of Object.entries(EQUALITY_FILTER_MAP)) {
    const value = query[param];
    if (value !== undefined && value !== null && value !== '') {
      filtered = filtered.filter((r) => r[column] === value);
    }
  }

  if (query.liveFrom) filtered = filtered.filter((r) => r.live_start_date && r.live_start_date >= query.liveFrom);
  if (query.liveTo) filtered = filtered.filter((r) => r.live_start_date && r.live_start_date <= query.liveTo);
  if (query.activityFrom) filtered = filtered.filter((r) => r.last_activity_at && r.last_activity_at >= query.activityFrom);
  if (query.activityTo) filtered = filtered.filter((r) => r.last_activity_at && r.last_activity_at <= query.activityTo);

  // migrationMonth=YYYY-MM: keep rows whose [migration_from_date, migration_to_date]
  // window includes ANY day of that month. A null migration_to_date is open-ended (never
  // excludes on the "to" side); a null/missing migration_from_date has no defined window
  // at all, so it never matches. YYYY-MM-DD strings compare correctly lexicographically.
  if (query.migrationMonth) {
    const range = monthRange(query.migrationMonth);
    if (range) {
      const [monthFirst, monthLast] = range;
      filtered = filtered.filter((r) => {
        if (!r.migration_from_date) return false;
        if (r.migration_from_date > monthLast) return false;
        if (r.migration_to_date && r.migration_to_date < monthFirst) return false;
        return true;
      });
    }
  }

  // liveMonth=YYYY-MM: live_start_date falls within that calendar month.
  if (query.liveMonth) {
    const range = monthRange(query.liveMonth);
    if (range) {
      filtered = filtered.filter((r) => typeof r.live_start_date === 'string' && r.live_start_date.slice(0, 7) === query.liveMonth);
    }
  }

  // openExceptions=any|none|min:<n> over open_exception_count.
  if (query.openExceptions) {
    const spec = String(query.openExceptions);
    if (spec === 'any') {
      filtered = filtered.filter((r) => (Number(r.open_exception_count) || 0) > 0);
    } else if (spec === 'none') {
      filtered = filtered.filter((r) => (Number(r.open_exception_count) || 0) === 0);
    } else {
      const m = /^min:(\d+)$/.exec(spec);
      if (m) {
        const threshold = Number(m[1]);
        filtered = filtered.filter((r) => (Number(r.open_exception_count) || 0) >= threshold);
      }
    }
  }

  // impactMin=<decimal>: open_exception_impact >= value, compared numerically (paise).
  if (query.impactMin !== undefined && query.impactMin !== null && query.impactMin !== '') {
    let threshold = null;
    try {
      threshold = parseMoney(query.impactMin);
    } catch {
      threshold = null; // unparsable threshold -> filter is a no-op rather than a 500
    }
    if (threshold !== null) {
      filtered = filtered.filter((r) => parseMoney(r.open_exception_impact ?? '0.00') >= threshold);
    }
  }

  // counts.* are over the FILTERED set, before pagination.
  const byReadiness = {};
  const byOperator = {};
  const byApprover = {};
  for (const r of filtered) {
    byReadiness[r.readiness_status] = (byReadiness[r.readiness_status] ?? 0) + 1;
    if (r.assigned_operator) byOperator[r.assigned_operator] = (byOperator[r.assigned_operator] ?? 0) + 1;
    if (r.assigned_approver) byApprover[r.assigned_approver] = (byApprover[r.assigned_approver] ?? 0) + 1;
  }

  const sortCol = BRANCH_SUMMARY_COLUMNS.includes(query.sort) ? query.sort : 'branch_code';
  const dir = String(query.dir ?? '').toLowerCase() === 'desc' ? -1 : 1;
  const sorted = [...filtered].sort((a, b) => {
    const primary = compareValues(a[sortCol], b[sortCol], sortCol) * dir;
    if (primary !== 0) return primary;
    // Deterministic tiebreak, independent of `dir`: equal sort keys always resolve to a
    // total order on branch_code ascending, so paging never drops/duplicates a row and
    // repeated requests for the same page always return the same rows in the same order.
    if (a.branch_code < b.branch_code) return -1;
    if (a.branch_code > b.branch_code) return 1;
    return 0;
  });

  return { sorted, counts: { byReadiness, byOperator, byApprover } };
}

/** 'YYYY-MM' -> ['YYYY-MM-01', 'YYYY-MM-<lastDay>'], or null if malformed. */
function monthRange(monthStr) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(monthStr ?? ''));
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return [`${m[1]}-${m[2]}-01`, `${m[1]}-${m[2]}-${String(lastDay).padStart(2, '0')}`];
}

/**
 * computeBranchFacets(rows) -> { operators, approvers, readiness, receipt }
 * Pure aggregate over an already branch-scoped (but otherwise unfiltered) set of
 * branch_summaries rows — backs GET /api/branches/facets so the dashboard's operator/
 * approver selects can be populated with exactly the values a user is entitled to see,
 * independent of whatever other filters are currently applied to the list view.
 */
export function computeBranchFacets(rows) {
  const byReadiness = {};
  const byReceipt = {};
  const operatorCounts = {};
  const approverCounts = {};
  for (const r of rows) {
    byReadiness[r.readiness_status] = (byReadiness[r.readiness_status] ?? 0) + 1;
    byReceipt[r.receipt_status] = (byReceipt[r.receipt_status] ?? 0) + 1;
    if (r.assigned_operator) operatorCounts[r.assigned_operator] = (operatorCounts[r.assigned_operator] ?? 0) + 1;
    if (r.assigned_approver) approverCounts[r.assigned_approver] = (approverCounts[r.assigned_approver] ?? 0) + 1;
  }
  const toList = (counts) =>
    Object.entries(counts)
      .map(([id, count]) => ({ id, count }))
      .sort((a, b) => b.count - a.count || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return {
    operators: toList(operatorCounts),
    approvers: toList(approverCounts),
    readiness: byReadiness,
    receipt: byReceipt,
  };
}

/**
 * applyBranchQuery(rows, query) -> { items, total, page, pageSize, totalPages, counts }
 * Pure: does not mutate `rows`. `query` is a plain object (typically req.query — all
 * string values); every filter/sort/paging knob is documented in CONTRACTS-adjacent
 * task note and mirrored 1:1 here.
 */
export function applyBranchQuery(rows, query = {}) {
  const { sorted, counts } = filterAndSortBranches(rows, query);

  const page = Math.max(1, toPositiveInt(query.page, 1));
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, toPositiveInt(query.pageSize, DEFAULT_PAGE_SIZE)));

  const total = sorted.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const start = (page - 1) * pageSize;
  const items = sorted.slice(start, start + pageSize);

  return { items, total, page, pageSize, totalPages, counts };
}

/** RFC4180 field: quote if it contains a comma/quote/CR/LF, doubling embedded quotes. */
function csvCell(value) {
  let s = value === null || value === undefined ? '' : String(value);
  // Formula-injection guard: a leading = + - @ opens a formula in Excel/Sheets when the
  // CSV is opened as a spreadsheet; prefix with a single quote to force text.
  if (/^[=+\-@]/.test(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** toCsv(rows) -> RFC4180 text, fixed BRANCH_SUMMARY_COLUMNS column order, CRLF line
 * endings, trailing CRLF after the last row. */
export function toCsv(rows) {
  const lines = [BRANCH_SUMMARY_COLUMNS.map(csvCell).join(',')];
  for (const row of rows) {
    lines.push(BRANCH_SUMMARY_COLUMNS.map((col) => csvCell(row[col])).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}
