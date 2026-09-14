// Behavioural parity (and documented divergence) tests for the Catalyst Data Store
// adapter, against the Catalyst-shaped fake. Mirrors test/store.test.js's expectations
// where the Catalyst adapter promises the same behaviour, and asserts the DIFFERENT,
// documented behaviour where CONTRACTS.md §S explicitly allows it (insertMany is NOT
// atomic, transaction() is best-effort, claim()/releaseClaim() are NOT atomic).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore, UniqueViolationError, ColumnNotAllowedError, TableNotAllowedError, AppendOnlyViolationError, RawSqlNotReadOnlyError } from '../src/adapters/store/catalyst.js';
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
