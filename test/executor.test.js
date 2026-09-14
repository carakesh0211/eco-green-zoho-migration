import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/adapters/store/memory.js';
import { createAudit } from '../src/core/audit.js';
import { createBooksClient } from '../src/books/index.js';
import { runQueueSlice, resolveUnknownOutcomes } from '../src/worker/executor.js';

async function makeCtx() {
  const store = await openStore();
  const audit = createAudit(store);
  return { store, audit, ctx: { store, audit, correlationId: 'corr-exec', actor: 'worker-test', actorRole: 'operator' } };
}

function mockClient(overrides = {}) {
  return createBooksClient({ driver: 'mock', config: { mockWritesEnabled: true, maxAttempts: 3, ...overrides } });
}

/** Wraps a client so create() calls are counted, for concurrency assertions. */
function countingClient(client) {
  let calls = 0;
  return {
    client: { ...client, create: async (...args) => { calls += 1; return client.create(...args); } },
    get calls() { return calls; },
  };
}

async function seedRun(store, runId) {
  const now = new Date().toISOString();
  const existing = await store.get('extraction_runs', runId);
  if (existing) return existing;
  return store.insert('extraction_runs', {
    id: runId, branch_code: 'PILOT01', query_id: 'Q1', query_version: 'v1',
    from_date: '2026-04-01', to_date: '2026-04-30', manifest_json: '{}', manifest_sha256: `msha-${runId}`,
    inbox_ref: null, archive_uri: null, status: 'STAGED', claimed_by: null, claimed_at: null, claim_expires_at: null,
    error_code: null, error_message: null, created_at: now, updated_at: now,
  });
}

async function seedReadyQueueItem(store, { runId, voucherId, batchId, module = 'bill' }) {
  const now = new Date().toISOString();
  const file = await store.insert('source_files', {
    run_id: runId, file_name: 'transactions.csv', file_role: 'TRANSACTIONS', sha256: `fsha-${runId}-${voucherId}`,
    size_bytes: 10, encoding: 'utf-8', delimiter: ',', declared_row_count: 1, actual_row_count: 1,
    declared_debit_total: '0.00', declared_credit_total: '0.00', actual_debit_total: '0.00', actual_credit_total: '0.00',
    archive_uri: null, status: 'ARCHIVED', validation_json: '[]', created_at: now, updated_at: now,
  });
  const voucher = await store.insert('vouchers', {
    source_query_id: 'Q1', source_query_version: 'v1', extraction_run_id: runId, source_file_id: file.id,
    source_file_hash: 'fsha', source_record_id: voucherId, branch_code: 'PILOT01',
    zoho_location_id: 'LOC-PILOT01', financial_year: '2026-27', period: '2026-04', transaction_date: '2026-04-10',
    source_transaction_type: 'PURCHASE', source_transaction_hash: `hash-${voucherId}`,
    debit_total: '100.00', credit_total: '100.00', line_count: 2, is_balanced: 1, disposition: 'MIGRATE',
    disposition_rule_version: 'cut_v1', mapping_version: 'map_v1', transformation_version: 'tx_v1',
    target_module: module, target_payload_hash: `payload-${voucherId}`, migration_batch_id: batchId,
    created_at: now, updated_at: now,
  });
  const payload = { vendor: 'ZB-CONTACT-001', date: '2026-04-10', line_items: [{ account: 'ZB-ACC-1004', amount: '100.00' }], location_id: 'LOC-PILOT01', custom_fields: { cf_migration_source_hash: `hash-${voucherId}` } };
  await store.insert('preview_payloads', {
    voucher_id: voucher.id, target_module: module, payload_json: JSON.stringify(payload),
    payload_hash: `payload-${voucherId}`, human_summary: `${module} test`, mapping_version: 'map_v1',
    transformation_version: 'tx_v1', warnings_json: '[]', uk: `${voucher.id}|tx_v1|map_v1`, created_at: now,
  });
  const item = await store.insert('queue_items', {
    batch_id: batchId, voucher_id: voucher.id, idempotency_key: `hash-${voucherId}`, status: 'QUEUED',
    claimed_by: null, claimed_at: null, claim_expires_at: null, run_after: null, attempts: 0,
    last_error_code: null, created_at: now, updated_at: now,
  });
  return { voucher, item, file };
}

async function seedBatch(store, { batchId, runId, status = 'QUEUED' }) {
  const now = new Date().toISOString();
  await seedRun(store, runId);
  return store.insert('migration_batches', {
    id: batchId, branch_code: 'PILOT01', period: '2026-04', run_id: runId, scope_hash: 'scope-1',
    mapping_version: 'map_v1', transformation_version: 'tx_v1', cutover_rule_version: 'cut_v1',
    voucher_count: 1, debit_total: '100.00', credit_total: '100.00', totals_json: '{}',
    status, approval_id: null, created_by: 'alice', created_at: now, updated_at: now,
  });
}

test('executor: success path writes an api_attempts row and posts the voucher/queue_item', async () => {
  const { store, ctx } = await makeCtx();
  try {
    await seedBatch(store, { batchId: 'BATCH-1', runId: 'RUN-1' });
    const { voucher, item } = await seedReadyQueueItem(store, { runId: 'RUN-1', voucherId: 'V-1', batchId: 'BATCH-1' });
    const client = mockClient();

    const result = await runQueueSlice(ctx, { client, batchId: 'BATCH-1', workerId: 'w1', maxItems: 10, timeBudgetMs: 5000 });
    assert.equal(result.processed, 1);
    assert.equal(result.posted, 1);
    assert.equal(result.batch.status, 'MIGRATED');

    const queueRow = await store.get('queue_items', item.id);
    assert.equal(queueRow.status, 'POSTED');
    assert.equal(queueRow.claimed_by, null);

    const voucherRow = await store.get('vouchers', voucher.id);
    assert.equal(voucherRow.migration_status, 'POSTED');
    assert.ok(voucherRow.zoho_record_id);

    const attempts = await store.find('api_attempts', { queue_item_id: item.id });
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].response_class, 'SUCCESS');
    assert.equal(attempts[0].zoho_record_id, voucherRow.zoho_record_id);
    assert.equal(attempts[0].request_hash, `payload-V-1`);
  } finally {
    await store.close();
  }
});

test('executor: a 429 classifies FAILED_RETRYABLE with run_after set in the future', async () => {
  const { store, ctx } = await makeCtx();
  try {
    await seedBatch(store, { batchId: 'BATCH-2', runId: 'RUN-2' });
    const { item } = await seedReadyQueueItem(store, { runId: 'RUN-2', voucherId: 'V-1', batchId: 'BATCH-2' });
    const client = mockClient();
    client.failNext({ status: 429, retryAfterHeader: '1' });

    const before = Date.now();
    const result = await runQueueSlice(ctx, { client, batchId: 'BATCH-2', workerId: 'w1' });
    assert.equal(result.processed, 1);
    assert.equal(result.posted, 0);

    const queueRow = await store.get('queue_items', item.id);
    assert.equal(queueRow.status, 'FAILED_RETRYABLE');
    assert.equal(queueRow.attempts, 1);
    assert.ok(queueRow.run_after);
    assert.ok(Date.parse(queueRow.run_after) > before);
  } finally {
    await store.close();
  }
});

test('executor: timeoutAfterSend yields UNKNOWN_OUTCOME, never auto-retried by a second slice', async () => {
  const { store, ctx } = await makeCtx();
  try {
    await seedBatch(store, { batchId: 'BATCH-3', runId: 'RUN-3' });
    const { item } = await seedReadyQueueItem(store, { runId: 'RUN-3', voucherId: 'V-1', batchId: 'BATCH-3' });
    const client = mockClient();
    client.failNext({ timeoutAfterSend: true });

    const first = await runQueueSlice(ctx, { client, batchId: 'BATCH-3', workerId: 'w1' });
    assert.equal(first.processed, 1);

    const afterFirst = await store.get('queue_items', item.id);
    assert.equal(afterFirst.status, 'UNKNOWN_OUTCOME');

    const wrapped = countingClient(client);
    const second = await runQueueSlice(ctx, { client: wrapped.client, batchId: 'BATCH-3', workerId: 'w1' });
    assert.equal(second.processed, 0, 'an UNKNOWN_OUTCOME item must never be picked up by runQueueSlice again');
    assert.equal(wrapped.calls, 0);

    const stillUnknown = await store.get('queue_items', item.id);
    assert.equal(stillUnknown.status, 'UNKNOWN_OUTCOME');
  } finally {
    await store.close();
  }
});

test('resolveUnknownOutcomes: found by tag -> POSTED; proven absent -> back to QUEUED', async () => {
  const { store, ctx } = await makeCtx();
  try {
    await seedBatch(store, { batchId: 'BATCH-4', runId: 'RUN-4' });
    const found = await seedReadyQueueItem(store, { runId: 'RUN-4', voucherId: 'V-FOUND', batchId: 'BATCH-4' });
    const absent = await seedReadyQueueItem(store, { runId: 'RUN-4', voucherId: 'V-ABSENT', batchId: 'BATCH-4' });
    const client = mockClient();

    // Move both straight to UNKNOWN_OUTCOME as if a prior slice hit a timeout for each.
    await store.update('queue_items', found.item.id, { status: 'UNKNOWN_OUTCOME' });
    await store.update('queue_items', absent.item.id, { status: 'UNKNOWN_OUTCOME' });

    // Seed the mock's own record store so searchByMigrationTag finds V-FOUND's tag.
    client.seedRecords([{ module: 'bill', date: '2026-04-10', custom_fields: { cf_migration_source_hash: 'hash-V-FOUND' } }]);

    const result = await resolveUnknownOutcomes(ctx, { client, batchId: 'BATCH-4' });
    assert.equal(result.resolvedPosted, 1);
    assert.equal(result.resolvedRequeued, 1);

    const foundRow = await store.get('queue_items', found.item.id);
    assert.equal(foundRow.status, 'POSTED');
    const foundVoucher = await store.get('vouchers', found.voucher.id);
    assert.ok(foundVoucher.zoho_record_id);

    const absentRow = await store.get('queue_items', absent.item.id);
    assert.equal(absentRow.status, 'QUEUED');
  } finally {
    await store.close();
  }
});

test('executor: AUTH classification pauses the batch and raises AUTHENTICATION_ERROR', async () => {
  const { store, ctx } = await makeCtx();
  try {
    await seedBatch(store, { batchId: 'BATCH-5', runId: 'RUN-5' });
    const { item } = await seedReadyQueueItem(store, { runId: 'RUN-5', voucherId: 'V-1', batchId: 'BATCH-5' });
    const client = mockClient();
    client.failNext({ status: 401 });

    const result = await runQueueSlice(ctx, { client, batchId: 'BATCH-5', workerId: 'w1' });
    assert.equal(result.circuitBroken, true);
    assert.equal(result.batch.status, 'PAUSED');

    const queueRow = await store.get('queue_items', item.id);
    assert.equal(queueRow.status, 'QUEUED', 'the item itself goes back to QUEUED, untouched');

    const exceptions = await store.find('exceptions', { category: 'AUTHENTICATION_ERROR' });
    assert.equal(exceptions.length, 1);
  } finally {
    await store.close();
  }
});

test('executor: two workers racing the same item -> exactly one client.create() call, exactly one POSTED', async () => {
  const { store, ctx } = await makeCtx();
  try {
    await seedBatch(store, { batchId: 'BATCH-6', runId: 'RUN-6' });
    const { item } = await seedReadyQueueItem(store, { runId: 'RUN-6', voucherId: 'V-1', batchId: 'BATCH-6' });
    const baseClient = mockClient();
    const wrapped = countingClient(baseClient);

    const ctxA = { ...ctx };
    const ctxB = { ...ctx };
    const [a, b] = await Promise.all([
      runQueueSlice(ctxA, { client: wrapped.client, batchId: 'BATCH-6', workerId: 'worker-A' }),
      runQueueSlice(ctxB, { client: wrapped.client, batchId: 'BATCH-6', workerId: 'worker-B' }),
    ]);

    assert.equal(wrapped.calls, 1, 'client.create() must be called exactly once across both workers');
    const totalProcessed = a.processed + b.processed;
    assert.equal(totalProcessed, 1);

    const queueRow = await store.get('queue_items', item.id);
    assert.equal(queueRow.status, 'POSTED');
    const attempts = await store.find('api_attempts', { queue_item_id: item.id });
    assert.equal(attempts.length, 1);
  } finally {
    await store.close();
  }
});

test('executor: restart mid-slice (expired claim) makes an item reclaimable, still only one POSTED', async () => {
  const { store, ctx } = await makeCtx();
  try {
    await seedBatch(store, { batchId: 'BATCH-7', runId: 'RUN-7' });
    const { item } = await seedReadyQueueItem(store, { runId: 'RUN-7', voucherId: 'V-1', batchId: 'BATCH-7' });

    // Simulate a worker that claimed the item then crashed before finishing: status
    // CLAIMED, but claim_expires_at is already in the past.
    const past = new Date(Date.now() - 60_000).toISOString();
    await store.update('queue_items', item.id, { status: 'CLAIMED', claimed_by: 'dead-worker', claimed_at: past, claim_expires_at: past });

    const client = mockClient();
    const wrapped = countingClient(client);
    const result = await runQueueSlice(ctx, { client: wrapped.client, batchId: 'BATCH-7', workerId: 'worker-fresh' });

    assert.equal(result.processed, 1);
    assert.equal(result.posted, 1);
    assert.equal(wrapped.calls, 1);

    const queueRow = await store.get('queue_items', item.id);
    assert.equal(queueRow.status, 'POSTED');
    const attempts = await store.find('api_attempts', { queue_item_id: item.id });
    assert.equal(attempts.length, 1);
  } finally {
    await store.close();
  }
});
