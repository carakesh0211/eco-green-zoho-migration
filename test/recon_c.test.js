import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/adapters/store/memory.js';
import { createAudit } from '../src/core/audit.js';
import { createBooksClient } from '../src/books/index.js';
import { reconcileLayerC } from '../src/core/recon_c.js';

async function makeCtx() {
  const store = await openStore();
  const audit = createAudit(store);
  return { store, audit, ctx: { store, audit, correlationId: 'corr-reconc', actor: 'tester', actorRole: 'operator' } };
}

async function seedScope(store, { runId, batchId, period = '2026-04' }) {
  const now = new Date().toISOString();
  await store.insert('extraction_runs', {
    id: runId, branch_code: 'PILOT01', query_id: 'Q1', query_version: 'v1',
    from_date: '2026-04-01', to_date: '2026-04-30', manifest_json: '{}', manifest_sha256: `msha-${runId}`,
    inbox_ref: null, archive_uri: null, status: 'STAGED', claimed_by: null, claimed_at: null, claim_expires_at: null,
    error_code: null, error_message: null, created_at: now, updated_at: now,
  });
  await store.insert('migration_batches', {
    id: batchId, branch_code: 'PILOT01', period, run_id: runId, scope_hash: 'scope-1',
    mapping_version: 'map_v1', transformation_version: 'tx_v1', cutover_rule_version: 'cut_v1',
    voucher_count: 0, debit_total: '0.00', credit_total: '0.00', totals_json: '{}',
    status: 'QUEUED', approval_id: null, created_by: 'alice', created_at: now, updated_at: now,
  });
  const file = await store.insert('source_files', {
    run_id: runId, file_name: 'transactions.csv', file_role: 'TRANSACTIONS', sha256: `fsha-${runId}`,
    size_bytes: 10, encoding: 'utf-8', delimiter: ',', declared_row_count: 1, actual_row_count: 1,
    declared_debit_total: '0.00', declared_credit_total: '0.00', actual_debit_total: '0.00', actual_credit_total: '0.00',
    archive_uri: null, status: 'ARCHIVED', validation_json: '[]', created_at: now, updated_at: now,
  });
  return { file };
}

async function seedQueueItem(store, { runId, fileId, batchId, voucherId, hash, module = 'bill' }) {
  const now = new Date().toISOString();
  const voucher = await store.insert('vouchers', {
    source_query_id: 'Q1', source_query_version: 'v1', extraction_run_id: runId, source_file_id: fileId,
    source_file_hash: 'fsha', source_record_id: voucherId, branch_code: 'PILOT01',
    zoho_location_id: 'LOC-PILOT01', financial_year: '2026-27', period: '2026-04', transaction_date: '2026-04-10',
    source_transaction_type: 'PURCHASE', source_transaction_hash: hash, debit_total: '100.00', credit_total: '100.00',
    line_count: 2, is_balanced: 1, disposition: 'MIGRATE', target_module: module, migration_batch_id: batchId,
    created_at: now, updated_at: now,
  });
  const item = await store.insert('queue_items', {
    batch_id: batchId, voucher_id: voucher.id, idempotency_key: hash, status: 'POSTED',
    claimed_by: null, claimed_at: null, claim_expires_at: null, run_after: null, attempts: 1,
    last_error_code: null, created_at: now, updated_at: now,
  });
  return { voucher, item };
}

test('reconcileLayerC: classifies present/missing/duplicate items and flags an unexpected Books record', async () => {
  const { store, ctx } = await makeCtx();
  try {
    await seedScope(store, { runId: 'RUN-1', batchId: 'BATCH-1' });
    const fileRow = (await store.find('source_files', { run_id: 'RUN-1' }))[0];

    const present = await seedQueueItem(store, { runId: 'RUN-1', fileId: fileRow.id, batchId: 'BATCH-1', voucherId: 'V-MATCH', hash: 'hash-match' });
    const missing = await seedQueueItem(store, { runId: 'RUN-1', fileId: fileRow.id, batchId: 'BATCH-1', voucherId: 'V-MISSING', hash: 'hash-missing' });
    const duplicated = await seedQueueItem(store, { runId: 'RUN-1', fileId: fileRow.id, batchId: 'BATCH-1', voucherId: 'V-DUP', hash: 'hash-dup' });

    const client = createBooksClient({ driver: 'mock', config: {} });
    client.seedRecords([
      { module: 'bill', date: '2026-04-05', custom_fields: { cf_migration_source_hash: 'hash-match' } },
      { module: 'bill', date: '2026-04-06', custom_fields: { cf_migration_source_hash: 'hash-dup' } },
      { module: 'bill', date: '2026-04-07', custom_fields: { cf_migration_source_hash: 'hash-dup' } },
      { module: 'bill', date: '2026-04-08', custom_fields: { cf_migration_source_hash: 'hash-not-ours' } },
    ]);

    const result = await reconcileLayerC(ctx, { client, batchId: 'BATCH-1' });
    assert.equal(result.status, 'FAIL');

    const results = await store.find('recon_results', { recon_run_id: result.reconRunId });
    const byKey = Object.fromEntries(results.map((r) => [r.control_key, r]));

    assert.equal(byKey[`c:item:${present.item.id}`].status, 'MATCH');
    assert.equal(byKey[`c:item:${missing.item.id}`].status, 'MISSING_ACTUAL');
    assert.equal(byKey[`c:item:${duplicated.item.id}`].status, 'DUPLICATE');
    assert.equal(byKey['c:bill:unexpected'].status, 'UNEXPECTED');
    assert.equal(byKey['c:bill:unexpected'].actual, '1');

    const exceptions = await store.find('exceptions', { category: 'TARGET_MISMATCH', batch_id: 'BATCH-1' });
    // one each for missing, duplicate, and unexpected
    assert.equal(exceptions.length, 3);
  } finally {
    await store.close();
  }
});

test('reconcileLayerC: PASS when every item matches exactly once and nothing is unexpected', async () => {
  const { store, ctx } = await makeCtx();
  try {
    await seedScope(store, { runId: 'RUN-2', batchId: 'BATCH-2' });
    const fileRow = (await store.find('source_files', { run_id: 'RUN-2' }))[0];
    const item = await seedQueueItem(store, { runId: 'RUN-2', fileId: fileRow.id, batchId: 'BATCH-2', voucherId: 'V-1', hash: 'hash-ok' });

    const client = createBooksClient({ driver: 'mock', config: {} });
    client.seedRecords([{ module: 'bill', date: '2026-04-05', custom_fields: { cf_migration_source_hash: 'hash-ok' } }]);

    const result = await reconcileLayerC(ctx, { client, batchId: 'BATCH-2' });
    assert.equal(result.status, 'PASS');
    const results = await store.find('recon_results', { recon_run_id: result.reconRunId });
    for (const r of results) assert.notEqual(r.status, 'DIFF');
    void item;
  } finally {
    await store.close();
  }
});

test('reconcileLayerC: zero queue items over a NON-EMPTY approved batch is a FAIL, not a vacuous PASS (Codex P2)', async () => {
  const { store, ctx } = await makeCtx();
  try {
    await seedScope(store, { runId: 'RUN-Z', batchId: 'BATCH-Z' });
    // Approved population of 3 vouchers, but nothing was ever enqueued/exercised.
    await store.update('migration_batches', 'BATCH-Z', { voucher_count: 3 });
    const client = createBooksClient({ driver: 'mock', config: {} });
    const result = await reconcileLayerC(ctx, { client, batchId: 'BATCH-Z' });
    assert.equal(result.status, 'FAIL');
    assert.equal(result.itemCount, 0);
    const ctrl = (await store.find('recon_results', { recon_run_id: result.reconRunId })).find((r) => r.control_key === 'c:population:exercised');
    assert.ok(ctrl, 'c:population:exercised control must be recorded');
    assert.equal(ctrl.status, 'MISSING_ACTUAL');
    assert.equal(ctrl.expected, '3');
    assert.equal(ctrl.actual, '0');
  } finally { await store.close(); }
});

test('reconcileLayerC: zero items over a genuinely EMPTY batch is acceptable', async () => {
  const { store, ctx } = await makeCtx();
  try {
    await seedScope(store, { runId: 'RUN-E', batchId: 'BATCH-E' }); // voucher_count 0
    const client = createBooksClient({ driver: 'mock', config: {} });
    const result = await reconcileLayerC(ctx, { client, batchId: 'BATCH-E' });
    assert.equal(result.status, 'PASS');
    const ctrl = (await store.find('recon_results', { recon_run_id: result.reconRunId })).find((r) => r.control_key === 'c:population:exercised');
    assert.equal(ctrl.status, 'MATCH');
  } finally { await store.close(); }
});
