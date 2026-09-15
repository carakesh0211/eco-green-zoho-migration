import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/adapters/store/memory.js';
import { nowIso } from '../src/core/ids.js';
import { computeBranchSummary, refreshBranchSummary, BranchNotFoundError } from '../src/core/branch_summary.js';

const NOW = '2026-09-15T00:00:00.000Z';

async function makeBranch(store, code = 'PILOT01') {
  const now = nowIso();
  return store.insert('branches', {
    branch_code: code,
    branch_name: `Pilot ${code}`,
    zoho_location_id: 'LOC-1',
    status: 'ACTIVE',
    created_at: now,
    updated_at: now,
  });
}

test('computeBranchSummary throws BranchNotFoundError for an unknown branch', async () => {
  const store = await openStore();
  await assert.rejects(() => computeBranchSummary(store, 'NOPE', { now: NOW }), BranchNotFoundError);
  await store.close();
});

test('computeBranchSummary: NOT_STARTED for a branch with no activity at all', async () => {
  const store = await openStore();
  await makeBranch(store);
  const row = await computeBranchSummary(store, 'PILOT01', { now: NOW });

  assert.equal(row.branch_code, 'PILOT01');
  assert.equal(row.branch_name, 'Pilot PILOT01');
  assert.equal(row.zoho_location_id, 'LOC-1');
  assert.equal(row.receipt_status, 'NOT_RECEIVED');
  assert.equal(row.layer_a_status, 'NOT_RUN');
  assert.equal(row.layer_c_status, 'NOT_RUN');
  assert.equal(row.balance_bridge_status, 'NOT_RUN');
  assert.equal(row.mapping_status, 'NOT_STARTED');
  assert.equal(row.overlap_status, 'NOT_ASSESSED');
  assert.equal(row.batch_approval_status, 'NONE');
  assert.equal(row.total_count, 0);
  assert.equal(row.migrated_count, 0);
  assert.equal(row.migration_progress_pct, 0);
  assert.equal(row.open_exception_count, 0);
  assert.equal(row.open_exception_impact, '0.00');
  assert.equal(row.readiness_status, 'NOT_STARTED');
  assert.equal(row.is_synthetic, 0);
  assert.equal(row.summary_version, 1);
  await store.close();
});

test('computeBranchSummary: receipt_status VALIDATION_FAILED from the latest run, PARTIAL when no ARCHIVED file', async () => {
  const store = await openStore();
  await makeBranch(store);
  const now = nowIso();

  await store.insert('extraction_runs', {
    id: 'run-old', branch_code: 'PILOT01', query_id: 'Q', query_version: 'v1',
    from_date: '2026-04-01', to_date: '2026-04-30', manifest_json: '{}', manifest_sha256: 'sha-old',
    status: 'STAGED', created_at: '2026-04-01T00:00:00.000Z', updated_at: now,
  });
  await store.insert('source_files', {
    run_id: 'run-old', file_name: 'f.csv', file_role: 'TRANSACTIONS', sha256: 'sha-f1',
    size_bytes: 1, encoding: 'utf-8', delimiter: ',', status: 'VALIDATED', created_at: now, updated_at: now,
  });

  let row = await computeBranchSummary(store, 'PILOT01', { now: NOW });
  assert.equal(row.receipt_status, 'PARTIAL', 'run exists but no ARCHIVED file');
  assert.equal(row.readiness_status, 'IN_PROGRESS');

  await store.insert('extraction_runs', {
    id: 'run-new', branch_code: 'PILOT01', query_id: 'Q', query_version: 'v1',
    from_date: '2026-05-01', to_date: '2026-05-31', manifest_json: '{}', manifest_sha256: 'sha-new',
    status: 'VALIDATION_FAILED', created_at: '2026-05-01T00:00:00.000Z', updated_at: now,
  });
  row = await computeBranchSummary(store, 'PILOT01', { now: NOW });
  assert.equal(row.receipt_status, 'VALIDATION_FAILED', 'the NEWEST run is VALIDATION_FAILED');
  await store.close();
});

test('computeBranchSummary: receipt_status RECEIVED once the latest run has an ARCHIVED file', async () => {
  const store = await openStore();
  await makeBranch(store);
  const now = nowIso();
  await store.insert('extraction_runs', {
    id: 'run-1', branch_code: 'PILOT01', query_id: 'Q', query_version: 'v1',
    from_date: '2026-04-01', to_date: '2026-04-30', manifest_json: '{}', manifest_sha256: 'sha-1',
    status: 'STAGED', created_at: now, updated_at: now,
  });
  await store.insert('source_files', {
    run_id: 'run-1', file_name: 'f.csv', file_role: 'TRANSACTIONS', sha256: 'sha-f1',
    size_bytes: 1, encoding: 'utf-8', delimiter: ',', status: 'ARCHIVED', created_at: now, updated_at: now,
  });
  const row = await computeBranchSummary(store, 'PILOT01', { now: NOW });
  assert.equal(row.receipt_status, 'RECEIVED');
  await store.close();
});

test('computeBranchSummary: cutover_matrix live/migration dates, preferring the "*" transaction_class row', async () => {
  const store = await openStore();
  await makeBranch(store);
  const now = nowIso();
  await store.insert('cutover_matrix', {
    branch_code: 'PILOT01', zoho_location_id: 'LOC-1', migration_from_date: '2026-04-01',
    live_system_start_date: null, historical_migration_end_date: null,
    transaction_class: 'PAYMENT', payment_method: '*', smart_pharma_coverage_status: 'UNKNOWN',
    cutover_rule_version: 'cut_v1', approval_status: 'DRAFT', uk: 'PILOT01|PAYMENT|*|cut_v1',
    created_at: now, updated_at: now,
  });
  await store.insert('cutover_matrix', {
    branch_code: 'PILOT01', zoho_location_id: 'LOC-1', migration_from_date: '2026-04-01',
    live_system_start_date: '2026-08-01', historical_migration_end_date: '2026-07-31',
    transaction_class: '*', payment_method: '*', smart_pharma_coverage_status: 'COVERED',
    cutover_rule_version: 'cut_v1', approval_status: 'APPROVED', uk: 'PILOT01|*|*|cut_v1',
    created_at: now, updated_at: now,
  });
  const row = await computeBranchSummary(store, 'PILOT01', { now: NOW });
  assert.equal(row.live_start_date, '2026-08-01');
  assert.equal(row.migration_from_date, '2026-04-01');
  assert.equal(row.migration_to_date, '2026-07-31');
  await store.close();
});

test('computeBranchSummary: mapping_status is global (not branch-scoped) — DRAFT until every rule is APPROVED', async () => {
  const store = await openStore();
  await makeBranch(store);
  await makeBranch(store, 'PILOT02');
  const now = nowIso();
  await store.insert('mapping_rules', {
    rule_type: 'MODULE_ROUTE', source_key: 'PAYMENT', target_value: 'vendor_payment',
    mapping_version: 'map_v1', effective_from: '2026-04-01', status: 'DRAFT',
    uk: 'MODULE_ROUTE|PAYMENT|map_v1', created_at: now, updated_at: now,
  });
  let row1 = await computeBranchSummary(store, 'PILOT01', { now: NOW });
  let row2 = await computeBranchSummary(store, 'PILOT02', { now: NOW });
  assert.equal(row1.mapping_status, 'DRAFT');
  assert.equal(row2.mapping_status, 'DRAFT', 'same global mapping_status for every branch');

  await store.insert('mapping_rules', {
    rule_type: 'LEDGER_ACCOUNT', source_key: 'L100', target_value: 'acct-1',
    mapping_version: 'map_v1', effective_from: '2026-04-01', status: 'APPROVED',
    uk: 'LEDGER_ACCOUNT|L100|map_v1', created_at: now, updated_at: now,
  });
  row1 = await computeBranchSummary(store, 'PILOT01', { now: NOW });
  assert.equal(row1.mapping_status, 'DRAFT', 'still DRAFT: not every non-retired rule is approved');
  await store.close();
});

test('computeBranchSummary: exceptions open count/impact excludes RESOLVED/CLOSED, readiness BLOCKED on open P0/P1', async () => {
  const store = await openStore();
  await makeBranch(store);
  const now = nowIso();
  await store.insert('exceptions', {
    category: 'RECONCILIATION_DIFFERENCE', severity: 'P1', branch_code: 'PILOT01',
    financial_impact: '-150.00', status: 'OPEN', message: 'diff', dedupe_key: 'exc-1',
    created_at: now, updated_at: now,
  });
  await store.insert('exceptions', {
    category: 'RECONCILIATION_DIFFERENCE', severity: 'P3', branch_code: 'PILOT01',
    financial_impact: '10.00', status: 'RESOLVED', message: 'fixed', dedupe_key: 'exc-2',
    created_at: now, updated_at: now,
  });
  const row = await computeBranchSummary(store, 'PILOT01', { now: NOW });
  assert.equal(row.open_exception_count, 1, 'RESOLVED exception excluded');
  assert.equal(row.open_exception_impact, '150.00', 'absolute value of the negative impact');
  assert.equal(row.readiness_status, 'BLOCKED', 'open P1 exception blocks readiness');
  await store.close();
});

test('computeBranchSummary: readiness READY requires layer A PASS + mapping APPROVED + overlap CLEAR + batch APPROVED', async () => {
  const store = await openStore();
  await makeBranch(store);
  const now = nowIso();

  await store.insert('extraction_runs', {
    id: 'run-r', branch_code: 'PILOT01', query_id: 'Q', query_version: 'v1',
    from_date: '2026-04-01', to_date: '2026-04-30', manifest_json: '{}', manifest_sha256: 'sha-r',
    status: 'CLASSIFIED', created_at: now, updated_at: now,
  });
  await store.insert('recon_runs', {
    id: 'reconA-1', run_id: 'run-r', batch_id: null, layer: 'A', branch_code: 'PILOT01',
    tolerance: '0.00', status: 'PASS', summary_json: '{}', inputs_version: 'v1', created_by: 'tester', created_at: now,
  });
  await store.insert('mapping_rules', {
    rule_type: 'MODULE_ROUTE', source_key: 'PAYMENT', target_value: 'vendor_payment',
    mapping_version: 'map_v1', effective_from: '2026-04-01', status: 'APPROVED',
    uk: 'MODULE_ROUTE|PAYMENT|map_v1', created_at: now, updated_at: now,
  });
  const file = await store.insert('source_files', {
    run_id: 'run-r', file_name: 'f.csv', file_role: 'TRANSACTIONS', sha256: 'sha-r1',
    size_bytes: 1, encoding: 'utf-8', delimiter: ',', status: 'ARCHIVED', created_at: now, updated_at: now,
  });
  const voucher = await store.insert('vouchers', {
    source_query_id: 'Q', source_query_version: 'v1', extraction_run_id: 'run-r', source_file_id: file.id,
    source_file_hash: 'h', source_record_id: 'V-1', branch_code: 'PILOT01', financial_year: '2026-27',
    period: '2026-04', transaction_date: '2026-04-05', source_transaction_type: 'PAYMENT',
    source_transaction_hash: 'txh-1', debit_total: '10.00', credit_total: '10.00', line_count: 2,
    is_balanced: 1, disposition: 'MIGRATE', migration_status: 'NOT_QUEUED', created_at: now, updated_at: now,
  });
  await store.insert('overlap_candidates', {
    voucher_id: voucher.id, population_key: 'k', classification: 'MIGRATE', match_strength: 'NONE',
    evidence_json: '{}', rule_version: 'cut_v1', uk: `${voucher.id}|cut_v1`, created_at: now,
  });
  await store.insert('migration_batches', {
    id: 'batch-1', branch_code: 'PILOT01', period: '2026-04', run_id: 'run-r', scope_hash: 'h',
    mapping_version: 'map_v1', transformation_version: 'tx_v1', cutover_rule_version: 'cut_v1',
    voucher_count: 1, debit_total: '10.00', credit_total: '10.00', totals_json: '{}',
    status: 'APPROVED', created_by: 'tester', created_at: now, updated_at: now,
  });

  const row = await computeBranchSummary(store, 'PILOT01', { now: NOW });
  assert.equal(row.layer_a_status, 'PASS');
  assert.equal(row.mapping_status, 'APPROVED');
  assert.equal(row.overlap_status, 'CLEAR');
  assert.equal(row.batch_approval_status, 'APPROVED');
  assert.equal(row.total_count, 1);
  assert.equal(row.migrated_count, 0);
  assert.equal(row.readiness_status, 'READY');
  await store.close();
});

test('computeBranchSummary: readiness MIGRATED at 100% progress + layer C PASS', async () => {
  const store = await openStore();
  await makeBranch(store);
  const now = nowIso();
  const run = await store.insert('extraction_runs', {
    id: 'run-x', branch_code: 'PILOT01', query_id: 'Q', query_version: 'v1',
    from_date: '2026-04-01', to_date: '2026-04-30', manifest_json: '{}', manifest_sha256: 'sha-x',
    status: 'READY_FOR_APPROVAL', created_at: now, updated_at: now,
  });
  const file = await store.insert('source_files', {
    run_id: run.id, file_name: 'f.csv', file_role: 'TRANSACTIONS', sha256: 'sha-x1',
    size_bytes: 1, encoding: 'utf-8', delimiter: ',', status: 'ARCHIVED', created_at: now, updated_at: now,
  });
  const voucher = await store.insert('vouchers', {
    source_query_id: 'Q', source_query_version: 'v1', extraction_run_id: run.id, source_file_id: file.id,
    source_file_hash: 'h', source_record_id: 'V-1', branch_code: 'PILOT01', financial_year: '2026-27',
    period: '2026-04', transaction_date: '2026-04-05', source_transaction_type: 'PAYMENT',
    source_transaction_hash: 'txh-mig', debit_total: '10.00', credit_total: '10.00', line_count: 2,
    is_balanced: 1, disposition: 'MIGRATE', migration_status: 'POSTED', created_at: now, updated_at: now,
  });
  assert.ok(voucher.id);
  await store.insert('recon_runs', {
    id: 'reconC-1', run_id: null, batch_id: 'batch-1', layer: 'C', branch_code: 'PILOT01',
    tolerance: '0.00', status: 'PASS', summary_json: '{}', inputs_version: 'v1', created_by: 'tester', created_at: now,
  });
  const row = await computeBranchSummary(store, 'PILOT01', { now: NOW });
  assert.equal(row.total_count, 1);
  assert.equal(row.migrated_count, 1);
  assert.equal(row.migration_progress_pct, 100);
  assert.equal(row.layer_c_status, 'PASS');
  assert.equal(row.readiness_status, 'MIGRATED');
  await store.close();
});

test('computeBranchSummary: assigned_operator/approver come from the "*" transaction_class row for the most recent period', async () => {
  const store = await openStore();
  await makeBranch(store);
  const now = nowIso();
  await store.insert('branch_period_assignments', {
    branch_code: 'PILOT01', period: '2026-04', transaction_class: '*', assigned_operator: 'op-april',
    assigned_approver: 'appr-april', status: 'ASSIGNED', uk: 'PILOT01|2026-04|*', created_at: now, updated_at: now,
  });
  await store.insert('branch_period_assignments', {
    branch_code: 'PILOT01', period: '2026-05', transaction_class: '*', assigned_operator: 'op-may',
    assigned_approver: 'appr-may', status: 'ASSIGNED', uk: 'PILOT01|2026-05|*', created_at: now, updated_at: now,
  });
  await store.insert('branch_period_assignments', {
    branch_code: 'PILOT01', period: '2026-06', transaction_class: 'PAYMENT', assigned_operator: 'op-narrow',
    assigned_approver: 'appr-narrow', status: 'ASSIGNED', uk: 'PILOT01|2026-06|PAYMENT', created_at: now, updated_at: now,
  });
  const row = await computeBranchSummary(store, 'PILOT01', { now: NOW });
  assert.equal(row.assigned_operator, 'op-may', 'most recent "*" period, ignoring the narrower class row');
  assert.equal(row.assigned_approver, 'appr-may');
  await store.close();
});

test('computeBranchSummary: zoho_location_name from books_locations by branch_code', async () => {
  const store = await openStore();
  await makeBranch(store);
  const now = nowIso();
  await store.insert('books_locations', {
    location_id: 'LOC-1', location_name: 'Pilot Warehouse', status: 'ACTIVE', branch_code: 'PILOT01',
    synced_at: now, created_at: now, updated_at: now,
  });
  const row = await computeBranchSummary(store, 'PILOT01', { now: NOW });
  assert.equal(row.zoho_location_name, 'Pilot Warehouse');
  await store.close();
});

test('refreshBranchSummary: inserts at version 1, then bumps summary_version on every subsequent call', async () => {
  const store = await openStore();
  await makeBranch(store);

  const inserted = await refreshBranchSummary(store, 'PILOT01', { now: NOW });
  assert.equal(inserted.summary_version, 1);
  assert.equal(inserted.created_at, NOW);

  const updated = await refreshBranchSummary(store, 'PILOT01', { now: '2026-09-16T00:00:00.000Z' });
  assert.equal(updated.summary_version, 2);
  assert.equal(updated.created_at, NOW, 'created_at is preserved across refreshes');
  assert.equal(updated.updated_at, '2026-09-16T00:00:00.000Z');

  const stored = await store.get('branch_summaries', 'PILOT01');
  assert.equal(stored.summary_version, 2);
  await store.close();
});
