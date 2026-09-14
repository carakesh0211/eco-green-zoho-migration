// Behavioural parity (and documented divergence) tests for the Catalyst Data Store
// adapter, against the Catalyst-shaped fake. Mirrors test/store.test.js's expectations
// where the Catalyst adapter promises the same behaviour, and asserts the DIFFERENT,
// documented behaviour where CONTRACTS.md §S explicitly allows it (insertMany is NOT
// atomic, transaction() is best-effort, claim()/releaseClaim() are NOT atomic).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  openStore,
  UniqueViolationError,
  ColumnNotAllowedError,
  TableNotAllowedError,
  AppendOnlyViolationError,
  RawSqlNotReadOnlyError,
  ZcqlChunkMismatchError,
  ZCQL_MAX_SELECT_COLUMNS,
} from '../src/adapters/store/catalyst.js';
import { createCatalystFake } from '../src/adapters/store/catalyst_fake.js';
import { coerceScalar, normaliseRow } from '../src/adapters/store/catalyst_types.js';
import { createAudit } from '../src/core/audit.js';
import { nowIso } from '../src/core/ids.js';

function openFakeStore() {
  const fake = createCatalystFake();
  return openStore({ app: fake.app });
}

function runRow(id, overrides = {}) {
  const now = nowIso();
  return {
    id,
    branch_code: 'PILOT01',
    query_id: 'EG_ACCT_VOUCHERS',
    query_version: 'v3',
    from_date: '2026-04-01',
    to_date: '2026-05-31',
    manifest_json: '{}',
    manifest_sha256: `sha-${id}`,
    status: 'RECEIVED',
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function sourceFileRow(overrides = {}) {
  const now = nowIso();
  return {
    run_id: 'run-A',
    file_name: 'transactions.csv',
    file_role: 'TRANSACTIONS',
    sha256: `filesha-${Math.random().toString(36).slice(2)}`,
    size_bytes: 128,
    encoding: 'utf-8',
    delimiter: ',',
    status: 'RECEIVED',
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function voucherRow(overrides = {}) {
  const now = nowIso();
  return {
    source_system: 'ECO_GREEN',
    source_query_id: 'EG_ACCT_VOUCHERS',
    source_query_version: 'v3',
    extraction_run_id: 'run-A',
    source_file_id: 1,
    source_file_hash: 'a'.repeat(64),
    source_table_or_entity: 'vouchers',
    source_record_id: 'V-1',
    branch_code: 'PILOT01',
    financial_year: '2026-27',
    period: '2026-04',
    transaction_date: '2026-04-05',
    source_transaction_type: 'PAYMENT',
    source_transaction_hash: `voucherhash-${Math.random().toString(36).slice(2)}`,
    debit_total: '100.00',
    credit_total: '100.00',
    line_count: 2,
    is_balanced: 1,
    disposition: 'PENDING',
    migration_status: 'NOT_QUEUED',
    attempt_count: 0,
    reconciliation_status: 'NOT_RECONCILED',
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

// vouchers has 43 declared columns (schema.catalyst.js) -> 44 with ROWID, past the live
// ZCQL_MAX_SELECT_COLUMNS (30) cap that triggers catalyst.js's column-chunking path.
// Populates every column (not just the mandatory ones) so a chunked find() round-trip
// can be asserted complete, not just non-empty.
function fullVoucherRow(overrides = {}) {
  const now = nowIso();
  return {
    source_system: 'ECO_GREEN',
    source_query_id: 'EG_ACCT_VOUCHERS',
    source_query_version: 'v3',
    extraction_run_id: 'run-A',
    source_file_id: 1,
    source_file_hash: 'a'.repeat(64),
    source_table_or_entity: 'vouchers',
    source_record_id: 'V-1',
    source_document_no: 'DOC-1',
    branch_code: 'PILOT01',
    zoho_location_id: 'LOC-1',
    financial_year: '2026-27',
    period: '2026-04',
    transaction_date: '2026-04-05',
    source_transaction_type: 'PAYMENT',
    source_transaction_hash: `voucherhash-${Math.random().toString(36).slice(2)}`,
    debit_total: '100.00',
    credit_total: '100.00',
    line_count: 2,
    payment_method: 'CASH',
    tax_bucket: 'GST18',
    party_code: 'P-1',
    is_balanced: 1,
    disposition: 'PENDING',
    disposition_rule_version: 'v1',
    disposition_reason: 'reason text',
    disposition_evidence_json: '{}',
    disposition_by: 'user:tester',
    disposition_at: now,
    mapping_version: 'map_v1',
    transformation_version: 'tx_v1',
    target_module: 'EXPENSE',
    target_payload_hash: 'b'.repeat(64),
    migration_batch_id: 'batch-1',
    approval_id: 'appr-1',
    zoho_record_id: 'zoho-1',
    migration_status: 'NOT_QUEUED',
    attempt_count: 0,
    last_error_code: null,
    last_error_message: null,
    reconciliation_status: 'NOT_RECONCILED',
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

test('catalyst store: insert/get/find/count basic CRUD on an id-keyed table (extraction_runs)', async () => {
  const store = await openFakeStore();
  const inserted = await store.insert('extraction_runs', runRow('run-1'));
  assert.equal(inserted.id, 'run-1');
  assert.equal(inserted.branch_code, 'PILOT01');

  const fetched = await store.get('extraction_runs', 'run-1');
  assert.equal(fetched.id, 'run-1');
  assert.equal(fetched.status, 'RECEIVED');

  const found = await store.findOne('extraction_runs', { status: 'RECEIVED' });
  assert.equal(found.id, 'run-1');

  const all = await store.find('extraction_runs', { status: 'RECEIVED' });
  assert.equal(all.length, 1);

  assert.equal(await store.count('extraction_runs', { status: 'RECEIVED' }), 1);

  assert.equal(await store.get('extraction_runs', 'NOPE'), null);
  await store.close();
});

test('catalyst store: insert/get on a ROWID-keyed table (source_files) normalises id to a string', async () => {
  const store = await openFakeStore();
  const inserted = await store.insert('source_files', sourceFileRow());
  assert.equal(typeof inserted.id, 'string');
  assert.ok(/^\d+$/.test(inserted.id), 'ROWID-derived id should be a numeric string');

  const fetched = await store.get('source_files', inserted.id);
  assert.equal(fetched.id, inserted.id);
  assert.equal(fetched.file_name, 'transactions.csv');
  await store.close();
});

test('catalyst store: find supports IS NULL matching and orderBy/limit', async () => {
  const store = await openFakeStore();
  await store.insert('source_files', sourceFileRow({ file_name: 'a.csv', declared_row_count: null }));
  await store.insert('source_files', sourceFileRow({ file_name: 'b.csv', declared_row_count: 5 }));
  await store.insert('source_files', sourceFileRow({ file_name: 'c.csv', declared_row_count: null }));

  const nulls = await store.find('source_files', { declared_row_count: null }, { orderBy: 'file_name' });
  assert.deepEqual(nulls.map((r) => r.file_name), ['a.csv', 'c.csv']);

  const limited = await store.find('source_files', {}, { orderBy: 'file_name DESC', limit: 1 });
  assert.equal(limited.length, 1);
  assert.equal(limited[0].file_name, 'c.csv');
  await store.close();
});

test('catalyst store: unique violation on manifest_sha256 maps to UniqueViolationError', async () => {
  const store = await openFakeStore();
  await store.insert('extraction_runs', runRow('run-A'));
  const dup = runRow('run-B', { manifest_sha256: 'sha-run-A' });
  await assert.rejects(
    () => store.insert('extraction_runs', dup),
    (err) => {
      assert.ok(err instanceof UniqueViolationError);
      assert.equal(err.code, 'UNIQUE_VIOLATION');
      assert.equal(err.table, 'extraction_runs');
      assert.equal(err.constraint, 'manifest_sha256');
      return true;
    }
  );
  await store.close();
});

test('catalyst store: insertMany is NOT atomic — rows before the failure persist (documented divergence from sqlite)', async () => {
  const store = await openFakeStore();
  await store.insert('extraction_runs', runRow('existing'));
  const batch = [runRow('new-1'), runRow('new-2'), runRow('new-3', { manifest_sha256: 'sha-existing' })];

  await assert.rejects(
    () => store.insertMany('extraction_runs', batch),
    (err) => {
      assert.ok(err instanceof UniqueViolationError);
      assert.equal(err.insertedCount, 2, 'the two good rows before the bad one should have been counted');
      return true;
    }
  );

  // NOT atomic: unlike sqlite.js, the rows inserted before the failure are NOT rolled back.
  assert.ok(await store.get('extraction_runs', 'new-1'), 'new-1 must persist (no rollback on this adapter)');
  assert.ok(await store.get('extraction_runs', 'new-2'), 'new-2 must persist (no rollback on this adapter)');
  assert.equal(await store.get('extraction_runs', 'new-3'), null);
  await store.close();
});

test('catalyst store: insertMany succeeds when all rows are valid', async () => {
  const store = await openFakeStore();
  const inserted = await store.insertMany('extraction_runs', [runRow('m1'), runRow('m2')]);
  assert.equal(inserted.length, 2);
  assert.equal(await store.count('extraction_runs', {}), 2);
  await store.close();
});

test('catalyst store: pagination past the 300-row ZCQL cap via find()', async () => {
  const store = await openFakeStore();
  const total = 305;
  for (let i = 0; i < total; i++) {
    await store.insert('source_files', sourceFileRow({ run_id: 'run-page', file_name: `f${i}.csv`, sha256: `sha-page-${i}` }));
  }
  const all = await store.find('source_files', { run_id: 'run-page' });
  assert.equal(all.length, total, 'find() with no limit must page past the 300-row ZCQL cap');

  const capped = await store.find('source_files', { run_id: 'run-page' }, { limit: 10 });
  assert.equal(capped.length, 10, 'a smaller explicit limit must not trigger extra pagination');

  assert.equal(await store.count('source_files', { run_id: 'run-page' }), total);
  await store.close();
});

test('catalyst store: raw() rejects non-SELECT SQL and allows SELECT (ZCQL passthrough)', async () => {
  const store = await openFakeStore();
  await store.insert('extraction_runs', runRow('raw-1'));

  const rows = await store.raw('SELECT * FROM extraction_runs WHERE branch_code = ?', ['PILOT01']);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'raw-1');

  await assert.rejects(() => store.raw("UPDATE extraction_runs SET status = 'X'"), RawSqlNotReadOnlyError);
  await assert.rejects(() => store.raw('DELETE FROM extraction_runs'), RawSqlNotReadOnlyError);
  await assert.rejects(() => store.raw("SELECT * FROM extraction_runs; DROP TABLE extraction_runs"), RawSqlNotReadOnlyError);
  await store.close();
});

test('catalyst store: table/column whitelist rejects unknown identifiers', async () => {
  const store = await openFakeStore();
  await assert.rejects(() => store.find('not_a_real_table', {}), TableNotAllowedError);
  await assert.rejects(() => store.find('extraction_runs', { not_a_real_column: 1 }), ColumnNotAllowedError);
  await assert.rejects(() => store.insert('extraction_runs', { ...runRow('bad'), not_a_real_column: 1 }), ColumnNotAllowedError);
  await store.close();
});

test('catalyst store: transaction() is best-effort, NOT atomic — a thrown error does not roll back earlier writes', async () => {
  const store = await openFakeStore();
  await assert.rejects(
    store.transaction(async (s) => {
      await s.insert('extraction_runs', runRow('txn-1'));
      throw new Error('boom');
    }),
    /boom/
  );
  // Documented divergence from sqlite.js: no rollback is possible on this adapter.
  assert.ok(await store.get('extraction_runs', 'txn-1'), 'transaction() has no rollback on the Catalyst adapter');
  await store.close();
});

test('catalyst store: claim() is flagged BEST_EFFORT and behaves correctly single-worker (race, and expired-claim reclaim)', async () => {
  const store = await openFakeStore();
  assert.equal(store.claimSemantics, 'BEST_EFFORT');

  await store.insert('extraction_runs', runRow('claim-1'));

  const first = await store.claim('extraction_runs', 'claim-1', { workerId: 'w1', expectedStatus: 'RECEIVED', newStatus: 'CLAIMED', ttlMs: 600000 });
  assert.ok(first);
  assert.equal(first.status, 'CLAIMED');
  assert.equal(first.claimed_by, 'w1');

  const second = await store.claim('extraction_runs', 'claim-1', { workerId: 'w2', expectedStatus: 'RECEIVED', newStatus: 'CLAIMED', ttlMs: 600000 });
  assert.equal(second, null, 'second claim must lose: status is no longer RECEIVED');

  await store.update('extraction_runs', 'claim-1', { claim_expires_at: '2000-01-01T00:00:00.000Z' });
  const reclaimed = await store.claim('extraction_runs', 'claim-1', { workerId: 'w3', expectedStatus: 'CLAIMED', newStatus: 'CLAIMED', ttlMs: 600000 });
  assert.ok(reclaimed, 'expired claim must be reclaimable');
  assert.equal(reclaimed.claimed_by, 'w3');
  await store.close();
});

test('catalyst store: releaseClaim clears claim fields and sets new status', async () => {
  const store = await openFakeStore();
  await store.insert('extraction_runs', runRow('claim-2'));
  await store.claim('extraction_runs', 'claim-2', { workerId: 'w1', expectedStatus: 'RECEIVED', newStatus: 'CLAIMED', ttlMs: 60000 });
  const released = await store.releaseClaim('extraction_runs', 'claim-2', { workerId: 'w1', newStatus: 'ARCHIVED' });
  assert.equal(released.status, 'ARCHIVED');
  assert.equal(released.claimed_by, null);
  assert.equal(released.claim_expires_at, null);
  await store.close();
});

test('catalyst store: audit_events is append-only — update() and claim() throw APPEND_ONLY', async () => {
  const store = await openFakeStore();
  const audit = createAudit(store);
  const emitted = await audit.emit({
    actor: 'user:tester',
    action: 'RUN.CREATE',
    entityType: 'extraction_runs',
    entityId: 'run-1',
    correlationId: 'corr-1',
  });
  assert.ok(emitted.id);

  const readBack = await store.find('audit_events', { correlation_id: 'corr-1' });
  assert.equal(readBack.length, 1);
  assert.equal(readBack[0].action, 'RUN.CREATE');

  await assert.rejects(
    () => store.update('audit_events', emitted.id, { reason: 'tampered' }),
    (err) => {
      assert.ok(err instanceof AppendOnlyViolationError);
      assert.equal(err.code, 'APPEND_ONLY');
      return true;
    }
  );
  await assert.rejects(
    () => store.claim('audit_events', emitted.id, { workerId: 'w1', expectedStatus: 'X', newStatus: 'Y', ttlMs: 1000 }),
    { code: 'APPEND_ONLY' }
  );
  await store.close();
});

test('catalyst store: update() works on a normal (non-append-only) table', async () => {
  const store = await openFakeStore();
  const inserted = await store.insert('vouchers', voucherRow());
  const updated = await store.update('vouchers', inserted.id, { disposition: 'MIGRATE' });
  assert.equal(updated.disposition, 'MIGRATE');
  assert.equal(await store.update('vouchers', 'nonexistent-rowid', { disposition: 'MIGRATE' }), null);
  await store.close();
});

test('catalyst store: branches is keyed on branch_code (not id/ROWID) — get/update/find all resolve by it', async () => {
  const store = await openFakeStore();
  const now = nowIso();
  const inserted = await store.insert('branches', {
    branch_code: 'PILOT01', branch_name: 'Pilot branch PILOT01', zoho_location_id: null,
    status: 'ACTIVE', created_at: now, updated_at: now,
  });
  assert.equal(inserted.branch_code, 'PILOT01');
  assert.equal(inserted.id, undefined, 'branches must not carry a synthetic id field (sqlite has none either)');

  const fetched = await store.get('branches', 'PILOT01');
  assert.equal(fetched.branch_code, 'PILOT01');
  assert.equal(fetched.branch_name, 'Pilot branch PILOT01');

  const updated = await store.update('branches', 'PILOT01', { zoho_location_id: 'LOC-PILOT01', updated_at: nowIso() });
  assert.equal(updated.zoho_location_id, 'LOC-PILOT01');

  const found = await store.findOne('branches', { branch_code: 'PILOT01' });
  assert.equal(found.zoho_location_id, 'LOC-PILOT01');

  assert.equal(await store.get('branches', 'NOPE'), null);
  await store.close();
});

test('catalyst store: the 11 added tables (cutover_matrix, mapping_rules, migration_batches, approvals, queue_items, api_attempts, books_snapshots, ...) support insert/get/update via the generic ROWID/id key styles', async () => {
  const store = await openFakeStore();
  const now = nowIso();

  const batch = await store.insert('migration_batches', {
    id: 'batch-1', branch_code: 'PILOT01', period: '2026-04', run_id: 'run-A', scope_hash: 'x'.repeat(64),
    mapping_version: 'map_v1', transformation_version: 'tx_v1', cutover_rule_version: 'cut_v1',
    voucher_count: 1, debit_total: '100.00', credit_total: '100.00', totals_json: '{}', status: 'DRAFT',
    approval_id: null, created_by: 'operator.local', created_at: now, updated_at: now,
  });
  assert.equal(batch.id, 'batch-1');
  const fetchedBatch = await store.get('migration_batches', 'batch-1');
  assert.equal(fetchedBatch.status, 'DRAFT');
  const updatedBatch = await store.update('migration_batches', 'batch-1', { status: 'APPROVED', updated_at: nowIso() });
  assert.equal(updatedBatch.status, 'APPROVED');

  const queueItem = await store.insert('queue_items', {
    batch_id: 'batch-1', voucher_id: 1, idempotency_key: 'y'.repeat(64), status: 'QUEUED',
    claimed_by: null, claimed_at: null, claim_expires_at: null, run_after: null, attempts: 0,
    last_error_code: null, created_at: now, updated_at: now,
  });
  assert.ok(/^\d+$/.test(queueItem.id));
  const claimed = await store.claim('queue_items', queueItem.id, { workerId: 'w1', expectedStatus: 'QUEUED', newStatus: 'CLAIMED', ttlMs: 60000 });
  assert.equal(claimed.status, 'CLAIMED');

  await store.insert('books_snapshots', {
    branch_code: 'PILOT01', zoho_location_id: 'LOC-PILOT01', organization_id: 'mock_org', kind: 'BASELINE',
    batch_id: 'batch-1', driver: 'mock', taken_at: now, balances_json: '[]', records_json: null,
    snapshot_hash: 'z'.repeat(64), created_at: now,
  });
  assert.equal(await store.count('books_snapshots', { batch_id: 'batch-1' }), 1);
  await store.close();
});

test('catalyst_fake: checkVarcharLength rejects an oversized varchar value at insert time', async () => {
  const store = await openFakeStore();
  await assert.rejects(
    () => store.insert('extraction_runs', runRow('toolong', { query_id: 'x'.repeat(200) })), // query_id max_length is 128
    (err) => {
      assert.match(err.message, /too long/i);
      return true;
    }
  );
  await store.close();
});

test('catalyst_fake: assertWithinLimits() passes on clean data (the same enforcement checkVarcharLength/checkTextLength apply at insert time, re-verified independently over the whole store)', async () => {
  const fake = createCatalystFake();
  const store = await openStore({ app: fake.app });
  await store.insert('extraction_runs', runRow('within-limits'));
  await store.insert('exceptions', {
    category: 'SCHEMA_FAILURE', severity: 'P1', branch_code: 'PILOT01', period: '2026-04', run_id: 'within-limits',
    file_id: null, voucher_id: null, batch_id: null, financial_impact: '0.00', owner: null, status: 'OPEN',
    root_cause: null, disposition: null, evidence_json: null, message: 'x'.repeat(9999), // text column, under the 10000 cap
    dedupe_key: 'dk-1', created_at: nowIso(), updated_at: nowIso(),
  });
  assert.equal(fake.assertWithinLimits(), true);
  await store.close();
});

test('catalyst store: pagination past the 300-row ZCQL cap on audit_events specifically (the table the pipeline appends to heavily)', async () => {
  const store = await openFakeStore();
  const audit = createAudit(store);
  const total = 320;
  for (let i = 0; i < total; i++) {
    await audit.emit({ actor: 'tester', action: 'TEST.EVENT', entityType: 'x', entityId: String(i), correlationId: 'corr-page' });
  }
  const all = await store.find('audit_events', { correlation_id: 'corr-page' });
  assert.equal(all.length, total, 'find(audit_events) with no limit must page past the 300-row ZCQL cap');
  assert.equal(await store.count('audit_events', { correlation_id: 'corr-page' }), total);
  await store.close();
});

test('catalyst_fake: executeZCQLQuery rejects a SELECT naming more than 30 columns (models the live ZCQL cap)', async () => {
  const fake = createCatalystFake();
  assert.equal(ZCQL_MAX_SELECT_COLUMNS, 30);
  await assert.rejects(
    () => fake.app.zcql().executeZCQLQuery('SELECT * FROM vouchers'), // 43 columns + ROWID = 44
    (err) => {
      assert.equal(err.code, 'INVALID_QUERY');
      assert.equal(err.message, 'More than 30 select columns are not allowed');
      return true;
    }
  );
  // A query at/under the cap must still work (sanity: the guard isn't over-firing).
  const ok = await fake.app.zcql().executeZCQLQuery('SELECT branch_code, status FROM branches');
  assert.deepEqual(ok, []);
});

test('catalyst store: find(vouchers) chunks the 44-column SELECT (43 + ROWID) past the 30-column ZCQL cap and returns COMPLETE rows', async () => {
  const store = await openFakeStore();
  const row = fullVoucherRow();
  const inserted = await store.insert('vouchers', row);

  const found = await store.find('vouchers', { source_record_id: 'V-1' });
  assert.equal(found.length, 1);
  for (const [k, v] of Object.entries(row)) {
    assert.equal(String(found[0][k]), String(v), `column '${k}' did not round-trip through the chunked SELECT`);
  }
  assert.equal(found[0].id, inserted.id);
  assert.ok(store.stats().chunkedQueries > 0, 'expected the 44-column vouchers SELECT to trigger column chunking');

  // get()-by-id path for a ROWID-keyed table must still use getRow() (no ZCQL cap at
  // all, so no chunking is even possible there) — verify it also returns every column.
  const before = store.stats().chunkedQueries;
  const gotten = await store.get('vouchers', inserted.id);
  for (const [k, v] of Object.entries(row)) {
    assert.equal(String(gotten[k]), String(v), `get(): column '${k}' missing/wrong`);
  }
  assert.equal(store.stats().chunkedQueries, before, 'get() by ROWID must not go through ZCQL chunking at all');
  await store.close();
});

test('catalyst store: column-chunking composes with 300-row ZCQL pagination (500 rows x 44 columns, all complete)', { timeout: 60_000 }, async () => {
  const store = await openFakeStore();
  const total = 500;
  for (let i = 0; i < total; i++) {
    await store.insert(
      'vouchers',
      fullVoucherRow({ source_record_id: `V-${i}`, source_transaction_hash: `hash-compose-${i}` })
    );
  }

  const all = await store.find('vouchers', {});
  assert.equal(all.length, total, 'find() must page past 300 rows AND chunk past 30 columns, together');
  for (const r of all) {
    assert.equal(r.source_system, 'ECO_GREEN');
    assert.equal(r.disposition_reason, 'reason text');
    assert.equal(r.target_payload_hash, 'b'.repeat(64));
    assert.ok(r.id);
  }
  assert.equal(new Set(all.map((r) => r.id)).size, total, 'every row must be distinct (no duplicate/merged ROWIDs)');
  assert.equal(await store.count('vouchers', {}), total);
  assert.ok(store.stats().chunkedQueries >= 4, 'expect >=2 chunks per page across >=2 pages (300 + 200 rows)');
  await store.close();
});

test('catalyst store: a chunk returning a divergent ROWID set throws ZCQL_CHUNK_MISMATCH rather than merging a corrupt row', async () => {
  const fake = createCatalystFake();
  const store = await openStore({ app: fake.app });
  await store.insert('vouchers', fullVoucherRow());
  await store.insert('vouchers', fullVoucherRow({ source_record_id: 'V-2', source_transaction_hash: 'hash-2' }));

  let selectCallsForVouchers = 0;
  fake.__setSelectInterceptor((ctx, rows) => {
    if (ctx.tableName !== 'vouchers') return null;
    selectCallsForVouchers += 1;
    // Simulate a row disappearing between chunk 1 and chunk 2 of the SAME logical page
    // (e.g. a concurrent delete against the live Data Store) so the two chunk queries
    // disagree on which ROWIDs they returned.
    if (selectCallsForVouchers === 2) return rows.slice(0, rows.length - 1);
    return null;
  });

  await assert.rejects(
    () => store.find('vouchers', {}),
    (err) => {
      assert.ok(err instanceof ZcqlChunkMismatchError);
      assert.equal(err.code, 'ZCQL_CHUNK_MISMATCH');
      assert.equal(err.table, 'vouchers');
      return true;
    }
  );
  await store.close();
});

test('catalyst_types: coerceScalar/normaliseRow apply the documented type coercion', () => {
  assert.equal(coerceScalar('int', '7'), 7);
  assert.equal(coerceScalar('int', 7), 7);
  assert.equal(coerceScalar('bigint', 12345), '12345');
  assert.equal(coerceScalar('bigint', '12345'), '12345');
  assert.equal(coerceScalar('varchar', 'x'), 'x');
  assert.equal(coerceScalar('int', null), null);

  const raw = { source_file_id: 42, line_count: '3', branch_code: 'PILOT01', ROWID: 4200000000000001 };
  const row = normaliseRow('vouchers', raw);
  assert.equal(row.id, '4200000000000001');
  assert.equal(row.source_file_id, '42'); // bigint -> string
  assert.equal(row.line_count, 3); // int -> number
  assert.equal(row.branch_code, 'PILOT01');
});
