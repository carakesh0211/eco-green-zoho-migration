import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/adapters/store/memory.js';
import { createAudit } from '../src/core/audit.js';
import { createBooksClient } from '../src/books/index.js';
import { computeBalanceBridge, takeSnapshot, balanceBridge } from '../src/core/balance_bridge.js';
import { uk } from '../src/core/ids.js';

async function makeCtx() {
  const store = await openStore();
  const audit = createAudit(store);
  return { store, audit, ctx: { store, audit, correlationId: 'corr-bb', actor: 'tester', actorRole: 'operator' } };
}

/** Deterministic, strictly-increasing ISO clock so BASELINE/POST_RUN snapshots taken in
 * quick succession within a test never collide/tie on `taken_at`. */
function makeClock(startIso = '2026-04-01T00:00:00.000Z') {
  let t = Date.parse(startIso);
  return () => new Date((t += 1000)).toISOString();
}

describe('computeBalanceBridge (pure)', () => {
  test('ties: baseline + migration + sp == post_run for every account', () => {
    const result = computeBalanceBridge({
      baseline: { 'ACC-1': '100.00', 'ACC-2': '0.00' },
      migration: { 'ACC-1': '50.00', 'ACC-2': '20.00' },
      sp: { 'ACC-2': '5.00' },
      postRun: { 'ACC-1': '150.00', 'ACC-2': '25.00' },
    });
    assert.equal(result.status, 'PASS');
    for (const a of result.accounts) {
      assert.equal(a.status, 'MATCH');
      assert.equal(a.unexplained, '0.00');
    }
  });

  test('an unauthorised manual movement is reported unexplained and fails the control', () => {
    const result = computeBalanceBridge({
      baseline: { 'ACC-1': '100.00' },
      migration: { 'ACC-1': '50.00' },
      sp: {},
      // Someone moved an extra 30.00 through ACC-1 that migration/sp does not account for.
      postRun: { 'ACC-1': '180.00' },
    });
    assert.equal(result.status, 'FAIL');
    const acc1 = result.accounts.find((a) => a.account_id === 'ACC-1');
    assert.equal(acc1.status, 'FAIL');
    assert.equal(acc1.unexplained, '30.00');
    assert.equal(acc1.manual, '0.00');
  });

  test('a pre-authorised manual movement explains the residual and the control passes', () => {
    const result = computeBalanceBridge({
      baseline: { 'ACC-1': '100.00' },
      migration: { 'ACC-1': '50.00' },
      sp: {},
      postRun: { 'ACC-1': '180.00' },
      authorizedManual: { 'ACC-1': '30.00' },
    });
    assert.equal(result.status, 'PASS');
    const acc1 = result.accounts.find((a) => a.account_id === 'ACC-1');
    assert.equal(acc1.manual, '30.00');
    assert.equal(acc1.unexplained, '0.00');
  });

  test('a negative unexplained residual (balance went down unexpectedly) also fails', () => {
    const result = computeBalanceBridge({
      baseline: { 'ACC-1': '100.00' },
      migration: { 'ACC-1': '0.00' },
      postRun: { 'ACC-1': '70.00' },
    });
    assert.equal(result.status, 'FAIL');
    const acc1 = result.accounts.find((a) => a.account_id === 'ACC-1');
    assert.equal(acc1.unexplained, '-30.00');
  });

  test('manualObserved is informational only: it is reported but does not by itself explain the residual', () => {
    const result = computeBalanceBridge({
      baseline: { 'ACC-1': '100.00' },
      migration: { 'ACC-1': '0.00' },
      postRun: { 'ACC-1': '130.00' },
      manualObserved: { 'ACC-1': '30.00' },
    });
    assert.equal(result.status, 'FAIL');
    const acc1 = result.accounts.find((a) => a.account_id === 'ACC-1');
    assert.equal(acc1.manual_observed, '30.00');
    assert.equal(acc1.manual, '0.00');
    assert.equal(acc1.unexplained, '30.00');
  });
});

test('takeSnapshot + balanceBridge: end-to-end wiring with the mock client ties out with no movement', async () => {
  const { store, ctx } = await makeCtx();
  try {
    const now = new Date().toISOString();
    await store.insert('branches', {
      branch_code: 'PILOT01', branch_name: 'Pilot', zoho_location_id: 'loc_head_office',
      status: 'ACTIVE', created_at: now, updated_at: now,
    });
    await store.insert('extraction_runs', {
      id: 'RUN-BB-1', branch_code: 'PILOT01', query_id: 'Q1', query_version: 'v1',
      from_date: '2026-04-01', to_date: '2026-04-30', manifest_json: '{}', manifest_sha256: 'msha-bb-1',
      inbox_ref: null, archive_uri: null, status: 'STAGED', claimed_by: null, claimed_at: null, claim_expires_at: null,
      error_code: null, error_message: null, created_at: now, updated_at: now,
    });
    await store.insert('migration_batches', {
      id: 'BATCH-BB-1', branch_code: 'PILOT01', period: '2026-04', run_id: 'RUN-BB-1', scope_hash: 'scope-1',
      mapping_version: 'map_v1', transformation_version: 'tx_v1', cutover_rule_version: 'cut_v1',
      voucher_count: 0, debit_total: '0.00', credit_total: '0.00', totals_json: '{}',
      status: 'MIGRATED', approval_id: null, created_by: 'alice', created_at: now, updated_at: now,
    });

    const client = createBooksClient({ driver: 'mock', config: {} });

    await takeSnapshot(ctx, { client, branchCode: 'PILOT01', kind: 'BASELINE', batchId: 'BATCH-BB-1' });
    // Nothing was posted between baseline and post_run in this smoke test.
    await takeSnapshot(ctx, { client, branchCode: 'PILOT01', kind: 'POST_RUN', batchId: 'BATCH-BB-1' });

    const result = await balanceBridge(ctx, { batchId: 'BATCH-BB-1' });
    assert.equal(result.status, 'PASS');

    const reconRun = await store.get('recon_runs', result.reconRunId);
    assert.equal(reconRun.layer, 'BALANCE_BRIDGE');
    assert.equal(reconRun.status, 'PASS');
  } finally {
    await store.close();
  }
});

describe('balanceBridge (mock world, end-to-end): provable PASS/FAIL', () => {
  /** Seeds an extraction_run + source_file + migration_batch scope, mirroring
   * test/recon_c.test.js's helpers. */
  async function seedScope(store, { runId, batchId, period = '2026-04' }, now) {
    await store.insert('extraction_runs', {
      id: runId, branch_code: 'PILOT01', query_id: 'Q1', query_version: 'v1',
      from_date: '2026-04-01', to_date: '2026-04-30', manifest_json: '{}', manifest_sha256: `msha-${runId}`,
      inbox_ref: null, archive_uri: null, status: 'STAGED', claimed_by: null, claimed_at: null, claim_expires_at: null,
      error_code: null, error_message: null, created_at: now, updated_at: now,
    });
    await store.insert('migration_batches', {
      id: batchId, branch_code: 'PILOT01', period, run_id: runId, scope_hash: `scope-${batchId}`,
      mapping_version: 'map_v1', transformation_version: 'tx_v1', cutover_rule_version: 'cut_v1',
      voucher_count: 0, debit_total: '0.00', credit_total: '0.00', totals_json: '{}',
      status: 'MIGRATED', approval_id: null, created_by: 'alice', created_at: now, updated_at: now,
    });
    const file = await store.insert('source_files', {
      run_id: runId, file_name: 'transactions.csv', file_role: 'TRANSACTIONS', sha256: `fsha-${runId}`,
      size_bytes: 10, encoding: 'utf-8', delimiter: ',', declared_row_count: 1, actual_row_count: 1,
      declared_debit_total: '0.00', declared_credit_total: '0.00', actual_debit_total: '0.00', actual_credit_total: '0.00',
      archive_uri: null, status: 'ARCHIVED', validation_json: '[]', created_at: now, updated_at: now,
    });
    return { file };
  }

  /** Seeds one voucher + its preview_payloads row (keyed exactly as
   * src/core/transform.js#transformRun writes it: voucher_id|transformation_version|
   * mapping_version) + a POSTED queue_item — the shape balanceBridge's
   * migrationMovementByAccount() looks up. */
  async function seedPostedVoucher(store, { runId, fileId, batchId, voucherId, hash, module, payload }, now) {
    const voucher = await store.insert('vouchers', {
      source_query_id: 'Q1', source_query_version: 'v1', extraction_run_id: runId, source_file_id: fileId,
      source_file_hash: `fsha-${runId}`, source_record_id: voucherId, branch_code: 'PILOT01',
      zoho_location_id: 'loc_head_office', financial_year: '2026-27', period: '2026-04', transaction_date: '2026-04-10',
      source_transaction_type: module === 'bill' ? 'PURCHASE' : 'JOURNAL', source_transaction_hash: hash,
      debit_total: '100.00', credit_total: '100.00', line_count: 1, is_balanced: 1, disposition: 'MIGRATE',
      target_module: module, target_payload_hash: `hash-${voucherId}`, mapping_version: 'map_v1', transformation_version: 'tx_v1',
      migration_batch_id: batchId, created_at: now, updated_at: now,
    });
    await store.insert('preview_payloads', {
      voucher_id: voucher.id, target_module: module, payload_json: JSON.stringify(payload), payload_hash: `hash-${voucherId}`,
      human_summary: `${module} ${voucherId}`, mapping_version: 'map_v1', transformation_version: 'tx_v1', warnings_json: '[]',
      uk: uk(voucher.id, 'tx_v1', 'map_v1'), created_at: now,
    });
    await store.insert('queue_items', {
      batch_id: batchId, voucher_id: voucher.id, idempotency_key: hash, status: 'POSTED',
      claimed_by: null, claimed_at: null, claim_expires_at: null, run_after: null, attempts: 1,
      last_error_code: null, created_at: now, updated_at: now,
    });
    return voucher;
  }

  test('PASS when nothing unexplained happened: two vouchers posted through the mock, migration fully explains the movement', async () => {
    const { store, ctx: baseCtx } = await makeCtx();
    const clock = makeClock();
    const ctx = { ...baseCtx, now: clock };
    try {
      const now = clock();
      await store.insert('branches', { branch_code: 'PILOT01', branch_name: 'Pilot', zoho_location_id: 'loc_head_office', status: 'ACTIVE', created_at: now, updated_at: now });
      const { file } = await seedScope(store, { runId: 'RUN-BB-2', batchId: 'BATCH-BB-2' }, now);

      const billPayload = { vendor: 'ZB-CONTACT-001', date: '2026-04-10', line_items: [{ account: 'ZB-ACC-1004', amount: '100.00' }], location_id: 'loc_head_office', reference_number: 'V-1', custom_fields: { cf_migration_source_hash: 'hash-v1' } };
      const journalPayload = { date: '2026-04-11', line_items: [{ account: 'ZB-ACC-1001', debit: '40.00' }, { account: 'ZB-ACC-1003', credit: '40.00' }], location_id: 'loc_head_office', reference_number: 'V-2', custom_fields: { cf_migration_source_hash: 'hash-v2' } };
      await seedPostedVoucher(store, { runId: 'RUN-BB-2', fileId: file.id, batchId: 'BATCH-BB-2', voucherId: 'V-1', hash: 'hash-v1', module: 'bill', payload: billPayload }, now);
      await seedPostedVoucher(store, { runId: 'RUN-BB-2', fileId: file.id, batchId: 'BATCH-BB-2', voucherId: 'V-2', hash: 'hash-v2', module: 'journal', payload: journalPayload }, now);

      const client = createBooksClient({ driver: 'mock', config: {} });
      await takeSnapshot(ctx, { client, branchCode: 'PILOT01', kind: 'BASELINE', batchId: 'BATCH-BB-2' });
      await client.create('bill', billPayload, { idempotencyKey: 'hash-v1' });
      await client.create('journal', journalPayload, { idempotencyKey: 'hash-v2' });
      await takeSnapshot(ctx, { client, branchCode: 'PILOT01', kind: 'POST_RUN', batchId: 'BATCH-BB-2' });

      const result = await balanceBridge(ctx, { batchId: 'BATCH-BB-2', client });
      assert.equal(result.status, 'PASS');
      const acc1004 = result.accounts.find((a) => a.account_id === 'ZB-ACC-1004');
      assert.equal(acc1004.migration, '100.00');
      assert.equal(acc1004.unexplained, '0.00');
      const acc1001 = result.accounts.find((a) => a.account_id === 'ZB-ACC-1001');
      assert.equal(acc1001.migration, '40.00');

      // No account should carry a migration_tag_consistency DIFF — our own postings were
      // just re-derived and re-summed from the same records.
      const results = await store.find('recon_results', { recon_run_id: result.reconRunId });
      const crossChecks = results.filter((r) => r.control_key.startsWith('bb:migration_tag_consistency:'));
      assert.ok(crossChecks.length > 0);
      for (const c of crossChecks) assert.equal(c.status, 'MATCH');
    } finally {
      await store.close();
    }
  });

  test('FAIL on an unauthorised manual movement, then PASS once it is authorised', async () => {
    const { store, ctx: baseCtx } = await makeCtx();
    const clock = makeClock('2026-04-02T00:00:00.000Z');
    const ctx = { ...baseCtx, now: clock };
    try {
      const now = clock();
      await store.insert('branches', { branch_code: 'PILOT01', branch_name: 'Pilot', zoho_location_id: 'loc_head_office', status: 'ACTIVE', created_at: now, updated_at: now });
      const { file } = await seedScope(store, { runId: 'RUN-BB-3', batchId: 'BATCH-BB-3' }, now);

      const billPayload = { vendor: 'ZB-CONTACT-002', date: '2026-04-10', line_items: [{ account: 'ZB-ACC-1004', amount: '100.00' }], location_id: 'loc_head_office', reference_number: 'V-3', custom_fields: { cf_migration_source_hash: 'hash-v3' } };
      await seedPostedVoucher(store, { runId: 'RUN-BB-3', fileId: file.id, batchId: 'BATCH-BB-3', voucherId: 'V-3', hash: 'hash-v3', module: 'bill', payload: billPayload }, now);

      const client = createBooksClient({ driver: 'mock', config: {} });
      await takeSnapshot(ctx, { client, branchCode: 'PILOT01', kind: 'BASELINE', batchId: 'BATCH-BB-3' });
      await client.create('bill', billPayload, { idempotencyKey: 'hash-v3' });
      // A manual, untagged GL entry lands in Books in the same window — nobody told the
      // bridge about it, so it must be reported unexplained.
      client.seedRecords([{
        module: 'bill', date: '2026-04-12',
        effects: [{ account_id: 'ZB-ACC-1004', debit: '30.00', credit: '0.00' }, { account_id: 'ZB-ACC-1001', debit: '0.00', credit: '30.00' }],
      }]);
      await takeSnapshot(ctx, { client, branchCode: 'PILOT01', kind: 'POST_RUN', batchId: 'BATCH-BB-3' });

      const failed = await balanceBridge(ctx, { batchId: 'BATCH-BB-3', client });
      assert.equal(failed.status, 'FAIL');
      const acc1004Fail = failed.accounts.find((a) => a.account_id === 'ZB-ACC-1004');
      assert.equal(acc1004Fail.status, 'FAIL');
      assert.equal(acc1004Fail.unexplained, '30.00');
      assert.equal(acc1004Fail.manual_observed, '30.00');
      assert.equal(acc1004Fail.manual, '0.00');

      const exceptions = await store.find('exceptions', { category: 'TARGET_MISMATCH', batch_id: 'BATCH-BB-3' });
      assert.ok(exceptions.some((e) => e.dedupe_key === 'bb:BATCH-BB-3:ZB-ACC-1004'));

      // The same underlying snapshots, now with the movement pre-authorised -> PASS.
      const passed = await balanceBridge(ctx, {
        batchId: 'BATCH-BB-3', client,
        authorizedManual: { 'ZB-ACC-1004': '30.00', 'ZB-ACC-1001': '-30.00' },
      });
      assert.equal(passed.status, 'PASS');
      const acc1004Pass = passed.accounts.find((a) => a.account_id === 'ZB-ACC-1004');
      assert.equal(acc1004Pass.manual, '30.00');
      assert.equal(acc1004Pass.unexplained, '0.00');
    } finally {
      await store.close();
    }
  });

  test('PASS with a Smart-Pharma-tagged posting automatically explained as sp movement (no authorizedManual needed)', async () => {
    const { store, ctx: baseCtx } = await makeCtx();
    const clock = makeClock('2026-04-03T00:00:00.000Z');
    const ctx = { ...baseCtx, now: clock };
    try {
      const now = clock();
      await store.insert('branches', { branch_code: 'PILOT01', branch_name: 'Pilot', zoho_location_id: 'loc_head_office', status: 'ACTIVE', created_at: now, updated_at: now });
      const { file } = await seedScope(store, { runId: 'RUN-BB-4', batchId: 'BATCH-BB-4' }, now);

      const billPayload = { vendor: 'ZB-CONTACT-003', date: '2026-04-10', line_items: [{ account: 'ZB-ACC-1004', amount: '50.00' }], location_id: 'loc_head_office', reference_number: 'V-4', custom_fields: { cf_migration_source_hash: 'hash-v4' } };
      await seedPostedVoucher(store, { runId: 'RUN-BB-4', fileId: file.id, batchId: 'BATCH-BB-4', voucherId: 'V-4', hash: 'hash-v4', module: 'bill', payload: billPayload }, now);

      const client = createBooksClient({ driver: 'mock', config: {} });
      await takeSnapshot(ctx, { client, branchCode: 'PILOT01', kind: 'BASELINE', batchId: 'BATCH-BB-4' });
      await client.create('bill', billPayload, { idempotencyKey: 'hash-v4' });
      client.seedRecords([{
        module: 'bill', date: '2026-04-13', sp_batch_ref: 'SP-BATCH-77',
        effects: [{ account_id: 'ZB-ACC-1009', debit: '20.00', credit: '0.00' }, { account_id: 'ZB-ACC-1001', debit: '0.00', credit: '20.00' }],
      }]);
      await takeSnapshot(ctx, { client, branchCode: 'PILOT01', kind: 'POST_RUN', batchId: 'BATCH-BB-4' });

      const result = await balanceBridge(ctx, { batchId: 'BATCH-BB-4', client });
      assert.equal(result.status, 'PASS');
      const acc1009 = result.accounts.find((a) => a.account_id === 'ZB-ACC-1009');
      assert.equal(acc1009.sp, '20.00');
      assert.equal(acc1009.unexplained, '0.00');
    } finally {
      await store.close();
    }
  });
});
