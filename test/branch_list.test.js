import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyBranchQuery, filterAndSortBranches, toCsv, BRANCH_SUMMARY_COLUMNS, computeBranchFacets } from '../src/core/branch_list.js';

function row(overrides = {}) {
  return {
    branch_code: 'PILOT01',
    branch_name: 'Pilot One',
    zoho_location_id: 'LOC-1',
    zoho_location_name: 'Loc One',
    assigned_operator: null,
    assigned_approver: null,
    live_start_date: '2026-06-01',
    migration_from_date: '2026-04-01',
    migration_to_date: '2026-05-31',
    receipt_status: 'RECEIVED',
    layer_a_status: 'PASS',
    mapping_status: 'APPROVED',
    overlap_status: 'CLEAR',
    open_exception_count: 0,
    open_exception_impact: '0.00',
    batch_approval_status: 'APPROVED',
    migrated_count: 0,
    total_count: 10,
    migration_progress_pct: 0,
    layer_c_status: 'NOT_RUN',
    balance_bridge_status: 'NOT_RUN',
    last_activity_at: '2026-09-01T00:00:00.000Z',
    readiness_status: 'READY',
    is_synthetic: 0,
    summary_version: 1,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function sampleRows() {
  return [
    row({ branch_code: 'EG-0003', branch_name: 'Eco Green Branch 0003', readiness_status: 'NOT_STARTED', open_exception_count: 0, total_count: 0, last_activity_at: null }),
    row({ branch_code: 'PILOT01', branch_name: 'Pilot One', readiness_status: 'READY', open_exception_count: 2, open_exception_impact: '150.75', total_count: 40, last_activity_at: '2026-09-10T00:00:00.000Z' }),
    row({ branch_code: 'EG-0002', branch_name: 'Eco Green Branch 0002', readiness_status: 'BLOCKED', open_exception_count: 5, open_exception_impact: '9999.99', total_count: 20, last_activity_at: '2026-09-05T00:00:00.000Z' }),
    row({ branch_code: 'PILOT02', branch_name: 'Special Warehouse', zoho_location_name: 'Warehouse Zone', readiness_status: 'MIGRATED', open_exception_count: 0, total_count: 100, migrated_count: 100, migration_progress_pct: 100, last_activity_at: '2026-09-12T00:00:00.000Z' }),
  ];
}

test('applyBranchQuery: default sort is branch_code ascending, default page size 50', () => {
  const result = applyBranchQuery(sampleRows(), {});
  assert.deepEqual(result.items.map((r) => r.branch_code), ['EG-0002', 'EG-0003', 'PILOT01', 'PILOT02']);
  assert.equal(result.page, 1);
  assert.equal(result.pageSize, 50);
  assert.equal(result.total, 4);
  assert.equal(result.totalPages, 1);
});

test('applyBranchQuery: search matches branch_code, branch_name, zoho_location_name case-insensitively', () => {
  const rows = sampleRows();
  assert.deepEqual(applyBranchQuery(rows, { search: 'warehouse' }).items.map((r) => r.branch_code), ['PILOT02']);
  assert.deepEqual(applyBranchQuery(rows, { search: 'eco green' }).items.map((r) => r.branch_code), ['EG-0002', 'EG-0003']);
  assert.deepEqual(applyBranchQuery(rows, { search: 'pilot01' }).items.map((r) => r.branch_code), ['PILOT01']);
  assert.equal(applyBranchQuery(rows, { search: 'nope-nothing-matches' }).total, 0);
});

test('applyBranchQuery: equality filters (readiness, receipt, layerA, mapping, overlap, approval, layerC, bridge, operator, approver)', () => {
  const rows = [
    row({ branch_code: 'A', readiness_status: 'READY', assigned_operator: 'op-1', assigned_approver: 'ap-1' }),
    row({ branch_code: 'B', readiness_status: 'BLOCKED', assigned_operator: 'op-2', assigned_approver: 'ap-2' }),
  ];
  assert.deepEqual(applyBranchQuery(rows, { readiness: 'BLOCKED' }).items.map((r) => r.branch_code), ['B']);
  assert.deepEqual(applyBranchQuery(rows, { operator: 'op-1' }).items.map((r) => r.branch_code), ['A']);
  assert.deepEqual(applyBranchQuery(rows, { approver: 'ap-2' }).items.map((r) => r.branch_code), ['B']);
  assert.equal(applyBranchQuery(rows, { readiness: 'READY', operator: 'op-2' }).total, 0, 'filters combine with AND');
});

test('applyBranchQuery: liveFrom/liveTo and activityFrom/activityTo date ranges', () => {
  const rows = sampleRows();
  const live = applyBranchQuery(rows, { liveFrom: '2026-06-01', liveTo: '2026-06-01' });
  assert.equal(live.total, 4, 'every sample row shares the same live_start_date');

  const activity = applyBranchQuery(rows, { activityFrom: '2026-09-06', activityTo: '2026-09-11' });
  assert.deepEqual(activity.items.map((r) => r.branch_code), ['PILOT01']);

  const noActivity = applyBranchQuery(rows, { activityFrom: '2026-01-01' });
  assert.ok(!noActivity.items.some((r) => r.branch_code === 'EG-0003'), 'null last_activity_at never matches a range filter');
});

test('applyBranchQuery: sorts numeric columns numerically, not lexicographically', () => {
  const rows = [
    row({ branch_code: 'A', total_count: 9 }),
    row({ branch_code: 'B', total_count: 10 }),
    row({ branch_code: 'C', total_count: 2 }),
  ];
  const asc = applyBranchQuery(rows, { sort: 'total_count', dir: 'asc' });
  assert.deepEqual(asc.items.map((r) => r.total_count), [2, 9, 10]);
  const desc = applyBranchQuery(rows, { sort: 'total_count', dir: 'desc' });
  assert.deepEqual(desc.items.map((r) => r.total_count), [10, 9, 2]);
});

test('applyBranchQuery: sorts money-string columns numerically', () => {
  const rows = [
    row({ branch_code: 'A', open_exception_impact: '150.75' }),
    row({ branch_code: 'B', open_exception_impact: '9999.99' }),
    row({ branch_code: 'C', open_exception_impact: '20.00' }),
  ];
  const sorted = applyBranchQuery(rows, { sort: 'open_exception_impact', dir: 'asc' });
  assert.deepEqual(sorted.items.map((r) => r.branch_code), ['C', 'A', 'B']);
});

test('applyBranchQuery: an unknown/unwhitelisted sort column falls back to branch_code asc', () => {
  const rows = sampleRows();
  const result = applyBranchQuery(rows, { sort: 'DROP TABLE branch_summaries;--' });
  assert.deepEqual(result.items.map((r) => r.branch_code), ['EG-0002', 'EG-0003', 'PILOT01', 'PILOT02']);
});

test('applyBranchQuery: pagination boundaries — page 1..N, out-of-range page is empty but reports correct totals', () => {
  const rows = Array.from({ length: 5 }, (_, i) => row({ branch_code: `EG-000${i}` }));
  const page1 = applyBranchQuery(rows, { pageSize: 2, page: 1 });
  assert.equal(page1.items.length, 2);
  assert.equal(page1.totalPages, 3);
  const page3 = applyBranchQuery(rows, { pageSize: 2, page: 3 });
  assert.equal(page3.items.length, 1, 'last partial page');
  const page4 = applyBranchQuery(rows, { pageSize: 2, page: 4 });
  assert.equal(page4.items.length, 0);
  assert.equal(page4.total, 5);
  assert.equal(page4.totalPages, 3);
});

test('applyBranchQuery: pageSize is clamped to [1, 200] and page to >= 1', () => {
  const rows = sampleRows();
  assert.equal(applyBranchQuery(rows, { pageSize: 0 }).pageSize, 1);
  assert.equal(applyBranchQuery(rows, { pageSize: 999 }).pageSize, 200);
  assert.equal(applyBranchQuery(rows, { page: -5 }).page, 1);
  assert.equal(applyBranchQuery(rows, { page: 'nonsense' }).page, 1);
});

test('applyBranchQuery: never returns more than pageSize rows', () => {
  const rows = Array.from({ length: 250 }, (_, i) => row({ branch_code: `EG-${String(i).padStart(4, '0')}` }));
  const result = applyBranchQuery(rows, { pageSize: 200, page: 1 });
  assert.ok(result.items.length <= 200);
  assert.equal(result.items.length, 200);
  assert.equal(result.total, 250);
});

test('applyBranchQuery: counts.byReadiness reflects the FILTERED set, before pagination', () => {
  const rows = sampleRows(); // NOT_STARTED, READY, BLOCKED, MIGRATED
  const all = applyBranchQuery(rows, { pageSize: 1 });
  assert.deepEqual(all.counts.byReadiness, { NOT_STARTED: 1, READY: 1, BLOCKED: 1, MIGRATED: 1 });

  const filtered = applyBranchQuery(rows, { search: 'eco green' });
  assert.deepEqual(filtered.counts.byReadiness, { NOT_STARTED: 1, BLOCKED: 1 });
});

test('filterAndSortBranches: applies filters/sort without any pagination cap', () => {
  const rows = Array.from({ length: 250 }, (_, i) => row({ branch_code: `EG-${String(i).padStart(4, '0')}` }));
  const { sorted } = filterAndSortBranches(rows, {});
  assert.equal(sorted.length, 250, 'no 200-row cap outside applyBranchQuery pagination');
});

test('toCsv: fixed column order matching BRANCH_SUMMARY_COLUMNS, RFC4180 quoting', () => {
  const csv = toCsv([row({ branch_name: 'Name, with comma' })]);
  const lines = csv.split('\r\n').filter(Boolean);
  assert.equal(lines[0], BRANCH_SUMMARY_COLUMNS.join(','));
  assert.ok(lines[1].includes('"Name, with comma"'));
  assert.ok(csv.endsWith('\r\n'), 'trailing CRLF after the last row');
});

test('toCsv: doubles embedded quotes and preserves embedded newlines inside quotes', () => {
  const csv = toCsv([row({ branch_name: 'Say "hi"\nnext line' })]);
  assert.ok(csv.includes('"Say ""hi""\nnext line"'));
});

test('toCsv: formula-injection guard prefixes leading =, +, -, @ with a single quote', () => {
  const csv = toCsv([
    row({ branch_code: 'A1', branch_name: '=1+1' }),
    row({ branch_code: 'A2', branch_name: '+SUM(A1:A2)' }),
    row({ branch_code: 'A3', branch_name: '-2' }),
    row({ branch_code: 'A4', branch_name: '@cmd' }),
    row({ branch_code: 'A5', branch_name: 'normal text' }),
  ]);
  const lines = csv.split('\r\n').filter(Boolean).slice(1);
  assert.ok(lines[0].includes(",'=1+1,") || lines[0].includes(",'=1+1"));
  assert.ok(lines[1].includes("'+SUM(A1:A2)"));
  assert.ok(lines[2].includes("'-2"));
  assert.ok(lines[3].includes("'@cmd"));
  assert.ok(!lines[4].includes("'normal text") && lines[4].includes('normal text'));
});

// ---------------------------------------------------------------- migrationMonth / liveMonth

test('applyBranchQuery: migrationMonth keeps rows whose window includes any day of that month; null to_date is open-ended', () => {
  const rows = [
    row({ branch_code: 'A', migration_from_date: '2026-04-01', migration_to_date: '2026-05-31' }), // fully before June
    row({ branch_code: 'B', migration_from_date: '2026-05-15', migration_to_date: '2026-06-10' }), // straddles into June
    row({ branch_code: 'C', migration_from_date: '2026-06-01', migration_to_date: null }), // open-ended, starts in June
    row({ branch_code: 'D', migration_from_date: '2026-07-01', migration_to_date: '2026-08-01' }), // fully after June
    row({ branch_code: 'E', migration_from_date: null, migration_to_date: null }), // no window at all
  ];
  const result = applyBranchQuery(rows, { migrationMonth: '2026-06' });
  assert.deepEqual(result.items.map((r) => r.branch_code), ['B', 'C']);
});

test('applyBranchQuery: migrationMonth with a malformed value is a no-op rather than an error', () => {
  const rows = [row({ branch_code: 'A' }), row({ branch_code: 'B' })];
  const result = applyBranchQuery(rows, { migrationMonth: 'not-a-month' });
  assert.equal(result.total, 2);
});

test('applyBranchQuery: liveMonth matches the calendar month of live_start_date', () => {
  const rows = [
    row({ branch_code: 'A', live_start_date: '2026-06-01' }),
    row({ branch_code: 'B', live_start_date: '2026-06-30' }),
    row({ branch_code: 'C', live_start_date: '2026-07-01' }),
    row({ branch_code: 'D', live_start_date: null }),
  ];
  const result = applyBranchQuery(rows, { liveMonth: '2026-06' });
  assert.deepEqual(result.items.map((r) => r.branch_code), ['A', 'B']);
});

// ---------------------------------------------------------------- openExceptions / impactMin

test('applyBranchQuery: openExceptions=any|none|min:<n>', () => {
  const rows = [
    row({ branch_code: 'A', open_exception_count: 0 }),
    row({ branch_code: 'B', open_exception_count: 1 }),
    row({ branch_code: 'C', open_exception_count: 5 }),
    row({ branch_code: 'D', open_exception_count: 10 }),
  ];
  assert.deepEqual(applyBranchQuery(rows, { openExceptions: 'any' }).items.map((r) => r.branch_code), ['B', 'C', 'D']);
  assert.deepEqual(applyBranchQuery(rows, { openExceptions: 'none' }).items.map((r) => r.branch_code), ['A']);
  assert.deepEqual(applyBranchQuery(rows, { openExceptions: 'min:5' }).items.map((r) => r.branch_code), ['C', 'D']);
  assert.deepEqual(applyBranchQuery(rows, { openExceptions: 'min:11' }).items.map((r) => r.branch_code), []);
});

test('applyBranchQuery: impactMin compares open_exception_impact numerically', () => {
  const rows = [
    row({ branch_code: 'A', open_exception_impact: '4.99' }),
    row({ branch_code: 'B', open_exception_impact: '5.00' }),
    row({ branch_code: 'C', open_exception_impact: '100.00' }),
  ];
  assert.deepEqual(applyBranchQuery(rows, { impactMin: '5' }).items.map((r) => r.branch_code), ['B', 'C']);
  assert.deepEqual(applyBranchQuery(rows, { impactMin: '5.00' }).items.map((r) => r.branch_code), ['B', 'C']);
  assert.deepEqual(applyBranchQuery(rows, { impactMin: '100.01' }).items.map((r) => r.branch_code), []);
});

test('applyBranchQuery: impactMin with an unparsable threshold is a no-op rather than an error', () => {
  const rows = [row({ branch_code: 'A' }), row({ branch_code: 'B' })];
  const result = applyBranchQuery(rows, { impactMin: 'garbage' });
  assert.equal(result.total, 2);
});

// ---------------------------------------------------------------- workload counts

test('applyBranchQuery: counts.byOperator/byApprover reflect the FILTERED set, skipping unassigned rows', () => {
  const rows = [
    row({ branch_code: 'A', assigned_operator: 'op-1', assigned_approver: 'ap-1' }),
    row({ branch_code: 'B', assigned_operator: 'op-1', assigned_approver: 'ap-2' }),
    row({ branch_code: 'C', assigned_operator: 'op-2', assigned_approver: null }),
    row({ branch_code: 'D', assigned_operator: null, assigned_approver: null }),
  ];
  const result = applyBranchQuery(rows, {});
  assert.deepEqual(result.counts.byOperator, { 'op-1': 2, 'op-2': 1 });
  assert.deepEqual(result.counts.byApprover, { 'ap-1': 1, 'ap-2': 1 });

  const filtered = applyBranchQuery(rows, { operator: 'op-1' });
  assert.deepEqual(filtered.counts.byOperator, { 'op-1': 2 });
});

// ---------------------------------------------------------------- computeBranchFacets

test('computeBranchFacets: aggregates operators/approvers/readiness/receipt over the given rows', () => {
  const rows = [
    row({ branch_code: 'A', assigned_operator: 'op-1', assigned_approver: 'ap-1', readiness_status: 'READY', receipt_status: 'RECEIVED' }),
    row({ branch_code: 'B', assigned_operator: 'op-1', assigned_approver: 'ap-2', readiness_status: 'BLOCKED', receipt_status: 'NOT_RECEIVED' }),
    row({ branch_code: 'C', assigned_operator: 'op-2', assigned_approver: null, readiness_status: 'READY', receipt_status: 'RECEIVED' }),
  ];
  const facets = computeBranchFacets(rows);
  assert.deepEqual(facets.operators, [{ id: 'op-1', count: 2 }, { id: 'op-2', count: 1 }]);
  assert.deepEqual(facets.approvers, [{ id: 'ap-1', count: 1 }, { id: 'ap-2', count: 1 }]);
  assert.deepEqual(facets.readiness, { READY: 2, BLOCKED: 1 });
  assert.deepEqual(facets.receipt, { RECEIVED: 2, NOT_RECEIVED: 1 });
});

// ---------------------------------------------------------------- stability / total order

test('applyBranchQuery: 351-row fixture with heavily duplicated sort keys — pages never overlap and exactly cover the input set', () => {
  const READINESS = ['NOT_STARTED', 'IN_PROGRESS', 'BLOCKED', 'READY', 'MIGRATED'];
  const rows = Array.from({ length: 351 }, (_, i) =>
    row({
      branch_code: `EG-${String(i).padStart(4, '0')}`,
      readiness_status: READINESS[i % READINESS.length], // heavy duplication of the sort key
    })
  );

  const pageSize = 50;
  const totalPages = Math.ceil(351 / pageSize);
  const seen = new Set();
  let allItemsInOrder = [];
  for (let page = 1; page <= totalPages; page += 1) {
    const result = applyBranchQuery(rows, { sort: 'readiness_status', dir: 'asc', page, pageSize });
    for (const item of result.items) {
      assert.ok(!seen.has(item.branch_code), `branch_code ${item.branch_code} appeared on more than one page`);
      seen.add(item.branch_code);
    }
    allItemsInOrder = allItemsInOrder.concat(result.items);
  }

  assert.equal(seen.size, 351, 'every branch_code appears exactly once across all pages');
  assert.deepEqual([...seen].sort(), rows.map((r) => r.branch_code).sort(), 'pages cover exactly the input set, no more and no less');

  // Total order: within each readiness_status run, branch_code is strictly ascending
  // (the deterministic tiebreak), and the readiness_status groups themselves are in
  // ascending lexical order (since 'asc' was requested and readiness_status is a plain
  // string column).
  for (let i = 1; i < allItemsInOrder.length; i += 1) {
    const prev = allItemsInOrder[i - 1];
    const cur = allItemsInOrder[i];
    if (prev.readiness_status === cur.readiness_status) {
      assert.ok(prev.branch_code < cur.branch_code, 'equal sort keys must be tiebroken by branch_code ascending');
    } else {
      assert.ok(prev.readiness_status < cur.readiness_status, 'readiness_status groups must be in ascending order');
    }
  }

  // Fetching the same page twice is byte-for-byte identical (determinism, not just "no overlap").
  const again = applyBranchQuery(rows, { sort: 'readiness_status', dir: 'asc', page: 2, pageSize });
  const first = applyBranchQuery(rows, { sort: 'readiness_status', dir: 'asc', page: 2, pageSize });
  assert.deepEqual(again.items.map((r) => r.branch_code), first.items.map((r) => r.branch_code));
});
