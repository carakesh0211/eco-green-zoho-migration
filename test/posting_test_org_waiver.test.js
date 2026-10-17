// Option A — test-organisation posting waiver (owner decision 13-10-2026): live posting on a
// BEST_EFFORT-claim store only for a single allow-listed TEST organisation with a singleton
// worker, plus a duplicate lookup in Books before every live send.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/adapters/store/memory.js';
import { createAudit } from '../src/core/audit.js';
import { assertPostingAllowed, postingBlockedReasons, bestEffortWaived } from '../src/books/guard.js';
import { runQueueSlice, recordIdOf } from '../src/worker/executor.js';

const TEST_ORG = '60000000001';
const OTHER_ORG = '60000000002';

const bestEffortStore = { claimSemantics: 'BEST_EFFORT' };

function liveConfig(overrides = {}) {
  return {
    driver: 'live',
    postingEnabled: true,
    postingAuthorizationRef: 'OWNER-13-10-2026',
    organizationId: TEST_ORG,
    orgAllowlist: [TEST_ORG],
    bestEffortPostingTestOrg: TEST_ORG,
    maxAttempts: 3,
    ...overrides,
  };
}

// ---- 1. Guard -------------------------------------------------------------------------

test('guard: BEST_EFFORT store is refused when the waiver org is unset', () => {
  assert.throws(
    () => assertPostingAllowed(liveConfig({ bestEffortPostingTestOrg: '' }), { store: bestEffortStore, workerMode: 'singleton' }),
    (err) => err.code === 'POSTING_DISABLED' && /BEST_EFFORT_CLAIMS/.test(err.message)
  );
});

test('guard: BEST_EFFORT store is refused when the waiver org differs from organizationId', () => {
  assert.throws(
    () => assertPostingAllowed(liveConfig({ bestEffortPostingTestOrg: OTHER_ORG }), { store: bestEffortStore, workerMode: 'singleton' }),
    /BEST_EFFORT_CLAIMS/
  );
});

test('guard: BEST_EFFORT store is refused when the allowlist has a second organisation', () => {
  assert.throws(
    () => assertPostingAllowed(liveConfig({ orgAllowlist: [TEST_ORG, OTHER_ORG] }), { store: bestEffortStore, workerMode: 'singleton' }),
    /BEST_EFFORT_CLAIMS/
  );
});

test('guard: BEST_EFFORT store is refused unless workerMode is singleton', () => {
  for (const workerMode of [undefined, 'disabled', 'multi', 'Singleton']) {
    assert.throws(
      () => assertPostingAllowed(liveConfig(), { store: bestEffortStore, workerMode }),
      /BEST_EFFORT_CLAIMS/,
      `workerMode=${workerMode}`
    );
  }
});

test('guard: BEST_EFFORT store passes only when every waiver condition holds; the refusal names them', () => {
  assert.doesNotThrow(() => assertPostingAllowed(liveConfig(), { store: bestEffortStore, workerMode: 'singleton' }));
  assert.equal(bestEffortWaived(liveConfig(), { workerMode: 'singleton' }), true);
  assert.throws(
    () => assertPostingAllowed(liveConfig({ bestEffortPostingTestOrg: '' }), { store: bestEffortStore, workerMode: 'singleton' }),
    (err) => /BEST_EFFORT_POSTING_TEST_ORG/.test(err.message) && /WORKER_MODE=singleton/.test(err.message) && /test organisation/.test(err.message)
  );
});

test('guard: the waiver never relaxes the other posting conditions', () => {
  const opts = { store: bestEffortStore, workerMode: 'singleton' };
  assert.throws(() => assertPostingAllowed(liveConfig({ driver: 'mock' }), opts), /driver is not "live"/);
  assert.throws(() => assertPostingAllowed(liveConfig({ postingEnabled: false }), opts), /POSTING_ENABLED/);
  assert.throws(() => assertPostingAllowed(liveConfig({ postingAuthorizationRef: '' }), opts), /postingAuthorizationRef/);
});

// ---- 2. postingBlockedReasons -----------------------------------------------------------

test('postingBlockedReasons: BEST_EFFORT_CLAIMS is omitted only under the full waiver', () => {
  const full = { store: bestEffortStore, workerMode: 'singleton' };
  assert.deepEqual(postingBlockedReasons(liveConfig(), full), []);
  assert.ok(postingBlockedReasons(liveConfig({ bestEffortPostingTestOrg: '' }), full).includes('BEST_EFFORT_CLAIMS'));
  assert.ok(postingBlockedReasons(liveConfig({ bestEffortPostingTestOrg: OTHER_ORG }), full).includes('BEST_EFFORT_CLAIMS'));
  assert.ok(postingBlockedReasons(liveConfig({ orgAllowlist: [TEST_ORG, OTHER_ORG] }), full).includes('BEST_EFFORT_CLAIMS'));
  assert.ok(postingBlockedReasons(liveConfig(), { store: bestEffortStore, workerMode: 'disabled' }).includes('BEST_EFFORT_CLAIMS'));
  assert.ok(postingBlockedReasons(liveConfig(), { store: bestEffortStore }).includes('BEST_EFFORT_CLAIMS'));
});

// ---- 3/4. Executor -----------------------------------------------------------------------

/** The memory store, but reporting the Catalyst adapter's non-atomic claim semantics. */
function asBestEffort(store) {
  return new Proxy(store, {
    get(target, key) {
      if (key === 'claimSemantics') return 'BEST_EFFORT';
      const v = target[key];
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

async function makeCtx({ workerMode } = {}) {
  const base = await openStore();
  const store = asBestEffort(base);
  const audit = createAudit(store);
  return { base, store, ctx: { store, audit, correlationId: 'corr-waiver', actor: 'worker-test', actorRole: 'operator', workerMode } };
}

async function seed(store, { batchId = 'BATCH-W', voucherId = 'V-1', referenceNumber = 'PUR/461/0001' } = {}) {
  const now = new Date().toISOString();
  const runId = `RUN-${batchId}`;
  await store.insert('extraction_runs', {
    id: runId, branch_code: 'PILOT01', query_id: 'Q1', query_version: 'v1',
    from_date: '2026-04-01', to_date: '2026-04-30', manifest_json: '{}', manifest_sha256: `msha-${runId}`,
    inbox_ref: null, archive_uri: null, status: 'STAGED', claimed_by: null, claimed_at: null, claim_expires_at: null,
    error_code: null, error_message: null, created_at: now, updated_at: now,
  });
  await store.insert('migration_batches', {
    id: batchId, branch_code: 'PILOT01', period: '2026-04', run_id: runId, scope_hash: 'scope-1',
    mapping_version: 'map_v1', transformation_version: 'tx_v1', cutover_rule_version: 'cut_v1',
    voucher_count: 1, debit_total: '100.00', credit_total: '100.00', totals_json: '{}',
    status: 'QUEUED', approval_id: null, created_by: 'alice', created_at: now, updated_at: now,
  });
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
    target_module: 'bill', target_payload_hash: `payload-${voucherId}`, migration_batch_id: batchId,
    created_at: now, updated_at: now,
  });
  const payload = {
    vendor: 'ZB-CONTACT-001', date: '2026-04-10', reference_number: referenceNumber,
    line_items: [{ account: 'ZB-ACC-1004', amount: '100.00' }], location_id: 'LOC-PILOT01',
    custom_fields: { cf_migration_source_hash: `hash-${voucherId}` },
  };
  await store.insert('preview_payloads', {
    voucher_id: voucher.id, target_module: 'bill', payload_json: JSON.stringify(payload),
    payload_hash: `payload-${voucherId}`, human_summary: 'bill test', mapping_version: 'map_v1',
    transformation_version: 'tx_v1', warnings_json: '[]', uk: `${voucher.id}|tx_v1|map_v1`, created_at: now,
  });
  const item = await store.insert('queue_items', {
    batch_id: batchId, voucher_id: voucher.id, idempotency_key: `hash-${voucherId}`, status: 'QUEUED',
    claimed_by: null, claimed_at: null, claim_expires_at: null, run_after: null, attempts: 0,
    last_error_code: null, created_at: now, updated_at: now,
  });
  return { batchId, voucher, item, referenceNumber };
}

/** Fake live client: counts create() calls; `lookup` decides what searchByMigrationTag returns. */
function fakeLiveClient({ config = liveConfig(), lookup = async () => [], created = { id: 'ZB-NEW-1' } } = {}) {
  const calls = { create: 0, search: 0 };
  return {
    calls,
    client: {
      driver: 'live',
      config,
      async searchByMigrationTag(args) {
        calls.search += 1;
        return lookup(args);
      },
      async create() {
        calls.create += 1;
        return created;
      },
    },
  };
}

test('executor: live client on a BEST_EFFORT store without the waiver never calls create()', async () => {
  const { base, store, ctx } = await makeCtx({ workerMode: 'singleton' });
  try {
    const { batchId } = await seed(store);
    const { client, calls } = fakeLiveClient({ config: liveConfig({ bestEffortPostingTestOrg: '' }) });
    await assert.rejects(
      () => runQueueSlice(ctx, { client, batchId, workerId: 'w1' }),
      (err) => err.code === 'POSTING_DISABLED' && /BEST_EFFORT_CLAIMS/.test(err.message)
    );
    assert.equal(calls.create, 0);
  } finally {
    await base.close();
  }
});

test('executor (waiver): empty pre-send lookup -> create() once, item POSTED', async () => {
  const { base, store, ctx } = await makeCtx({ workerMode: 'singleton' });
  try {
    const { batchId, item, voucher } = await seed(store);
    const { client, calls } = fakeLiveClient({ lookup: async () => [] });
    const result = await runQueueSlice(ctx, { client, batchId, workerId: 'w1' });
    assert.equal(calls.search, 1);
    assert.equal(calls.create, 1);
    assert.equal(result.posted, 1);
    assert.equal((await store.get('queue_items', item.id)).status, 'POSTED');
    assert.equal((await store.get('vouchers', voucher.id)).zoho_record_id, 'ZB-NEW-1');
  } finally {
    await base.close();
  }
});

test('executor (waiver): one record already tagged with our hash -> no create(), item POSTED with that id', async () => {
  const { base, store, ctx } = await makeCtx({ workerMode: 'singleton' });
  try {
    const { batchId, item, voucher } = await seed(store);
    const { client, calls } = fakeLiveClient({
      lookup: async ({ sourceHash }) => [
        { id: 'ZB-EXISTING-7', reference_number: 'PUR/461/0001', custom_fields: [{ api_name: 'cf_migration_source_hash', value: sourceHash }] },
      ],
    });
    const result = await runQueueSlice(ctx, { client, batchId, workerId: 'w1' });
    assert.equal(calls.create, 0);
    assert.equal(result.posted, 1);
    assert.equal((await store.get('queue_items', item.id)).status, 'POSTED');
    assert.equal((await store.get('vouchers', voucher.id)).zoho_record_id, 'ZB-EXISTING-7');
    const events = await store.find('audit_events', {});
    const posted = events.filter((e) => JSON.stringify(e).includes('QUEUE.POSTED'));
    assert.equal(posted.length, 1);
    assert.match(JSON.stringify(posted[0]), /ALREADY_IN_BOOKS/);
  } finally {
    await base.close();
  }
});

test('executor (waiver): untagged record with the same reference number -> no create(), FAILED_FINAL + P1', async () => {
  const { base, store, ctx } = await makeCtx({ workerMode: 'singleton' });
  try {
    const { batchId, item, voucher, referenceNumber } = await seed(store);
    const { client, calls } = fakeLiveClient({
      lookup: async () => [{ id: 'ZB-MANUAL-3', reference_number: referenceNumber, custom_fields: [] }],
    });
    const result = await runQueueSlice(ctx, { client, batchId, workerId: 'w1' });
    assert.equal(calls.create, 0);
    assert.equal(result.posted, 0);
    const row = await store.get('queue_items', item.id);
    assert.equal(row.status, 'FAILED_FINAL');
    assert.equal(row.last_error_code, 'ALREADY_IN_BOOKS_AMBIGUOUS');
    assert.equal((await store.get('vouchers', voucher.id)).migration_status, 'FAILED');
    const exceptions = await store.find('exceptions', { category: 'API_VALIDATION_ERROR' });
    assert.equal(exceptions.length, 1);
    assert.equal(exceptions[0].severity, 'P1');
  } finally {
    await base.close();
  }
});

test('executor (waiver): more than one record tagged with our hash -> no create(), FAILED_FINAL', async () => {
  const { base, store, ctx } = await makeCtx({ workerMode: 'singleton' });
  try {
    const { batchId, item } = await seed(store);
    const { client, calls } = fakeLiveClient({
      lookup: async ({ sourceHash }) => [
        { id: 'ZB-A', cf_migration_source_hash: sourceHash },
        { id: 'ZB-B', custom_field_hash: { cf_migration_source_hash: sourceHash } },
      ],
    });
    await runQueueSlice(ctx, { client, batchId, workerId: 'w1' });
    assert.equal(calls.create, 0);
    assert.equal((await store.get('queue_items', item.id)).status, 'FAILED_FINAL');
  } finally {
    await base.close();
  }
});

test('executor (waiver): pre-send lookup throws -> no create(), item FAILED_RETRYABLE', async () => {
  const { base, store, ctx } = await makeCtx({ workerMode: 'singleton' });
  try {
    const { batchId, item } = await seed(store);
    const { client, calls } = fakeLiveClient({ lookup: async () => { throw new Error('Books search timed out'); } });
    const result = await runQueueSlice(ctx, { client, batchId, workerId: 'w1' });
    assert.equal(calls.create, 0);
    assert.equal(result.posted, 0);
    const row = await store.get('queue_items', item.id);
    assert.equal(row.status, 'FAILED_RETRYABLE');
    assert.equal(row.last_error_code, 'PRESEND_LOOKUP_FAILED');
  } finally {
    await base.close();
  }
});

// ---- 5. Books record ids and the early posting check --------------------------------------

test('recordIdOf: reads the id from Books create responses, list rows and the mock shape', () => {
  assert.equal(recordIdOf({ code: 0, message: 'The journal entry has been created.', journal: { journal_id: '4222956000000999001' } }), '4222956000000999001');
  assert.equal(recordIdOf({ code: 0, bill: { bill_id: 'B-1' } }), 'B-1');
  assert.equal(recordIdOf({ code: 0, vendorpayment: { payment_id: 'P-1' } }), 'P-1');
  assert.equal(recordIdOf({ journal_id: 'J-2', reference_number: '26/J/1' }), 'J-2');
  assert.equal(recordIdOf({ id: 'ZB-NEW-1' }), 'ZB-NEW-1');
  assert.equal(recordIdOf({ code: 0, message: 'ok' }), null);
  assert.equal(recordIdOf(null), null);
});

test('executor (waiver): a real Books create response stores the journal id on the voucher', async () => {
  const { base, store, ctx } = await makeCtx({ workerMode: 'singleton' });
  try {
    const { batchId, voucher } = await seed(store);
    const { client } = fakeLiveClient({ created: { code: 0, message: 'The journal entry has been created.', journal: { journal_id: '4222956000000999001' } } });
    await runQueueSlice(ctx, { client, batchId, workerId: 'w1' });
    assert.equal((await store.get('vouchers', voucher.id)).zoho_record_id, '4222956000000999001');
    const [attempt] = await store.find('api_attempts', {});
    assert.equal(attempt.zoho_record_id, '4222956000000999001');
  } finally {
    await base.close();
  }
});

test('executor (waiver): a list row carrying only journal_id is recorded when already in Books', async () => {
  const { base, store, ctx } = await makeCtx({ workerMode: 'singleton' });
  try {
    const { batchId, voucher } = await seed(store);
    const { client, calls } = fakeLiveClient({
      lookup: async ({ sourceHash }) => [{ journal_id: '4222956000000999002', cf_migration_source_hash: sourceHash }],
    });
    await runQueueSlice(ctx, { client, batchId, workerId: 'w1' });
    assert.equal(calls.create, 0);
    assert.equal((await store.get('vouchers', voucher.id)).zoho_record_id, '4222956000000999002');
  } finally {
    await base.close();
  }
});

test('executor: a refused post puts the item back in the queue and leaves the voucher untouched', async () => {
  const { base, store, ctx } = await makeCtx({ workerMode: 'singleton' });
  try {
    const { batchId, item, voucher } = await seed(store);
    const { client, calls } = fakeLiveClient({ config: liveConfig({ bestEffortPostingTestOrg: '' }) });
    await assert.rejects(() => runQueueSlice(ctx, { client, batchId, workerId: 'w1' }), /BEST_EFFORT_CLAIMS/);
    assert.equal(calls.create, 0);
    assert.equal(calls.search, 0);
    assert.equal((await store.get('queue_items', item.id)).status, 'QUEUED');
    assert.notEqual((await store.get('vouchers', voucher.id)).migration_status, 'IN_FLIGHT');
    assert.equal((await store.find('api_attempts', {})).length, 0);
  } finally {
    await base.close();
  }
});
