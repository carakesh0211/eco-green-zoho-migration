import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/adapters/store/memory.js';
import { openStore as openDispatchStore } from '../src/adapters/store/index.js';
import { UniqueViolationError, RawSqlNotReadOnlyError, TableNotAllowedError, ColumnNotAllowedError } from '../src/adapters/store/sqlite.js';
import { nowIso } from '../src/core/ids.js';

function branchRow(code = 'PILOT01') {
  const now = nowIso();
  return { branch_code: code, branch_name: 'Pilot Branch', status: 'ACTIVE', created_at: now, updated_at: now };
}

function runRow(id) {
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
  };
}

test('store: insert/get/find/update/count basic CRUD', async () => {
  const store = await openStore();
  try {
    const inserted = await store.insert('branches', branchRow());
    assert.equal(inserted.branch_code, 'PILOT01');
    assert.equal(inserted.branch_name, 'Pilot Branch');

    const fetched = await store.get('branches', 'PILOT01');
    assert.equal(fetched.branch_code, 'PILOT01');

    const found = await store.findOne('branches', { status: 'ACTIVE' });
    assert.equal(found.branch_code, 'PILOT01');

    const all = await store.find('branches', { status: 'ACTIVE' });
    assert.equal(all.length, 1);

    const count = await store.count('branches', { status: 'ACTIVE' });
    assert.equal(count, 1);

    const updated = await store.update('branches', 'PILOT01', { status: 'SUSPENDED' });
    assert.equal(updated.status, 'SUSPENDED');

    const missing = await store.get('branches', 'NOPE');
    assert.equal(missing, null);
  } finally {
    await store.close();
  }
});

test('store: find supports IS NULL matching and orderBy/limit', async () => {
  const store = await openStore();
  try {
    await store.insert('branches', { ...branchRow('B1'), zoho_location_id: null });
    await store.insert('branches', { ...branchRow('B2'), zoho_location_id: 'LOC-2' });
    await store.insert('branches', { ...branchRow('B3'), zoho_location_id: null });

    const nulls = await store.find('branches', { zoho_location_id: null }, { orderBy: 'branch_code' });
    assert.deepEqual(nulls.map((r) => r.branch_code), ['B1', 'B3']);

    const limited = await store.find('branches', {}, { orderBy: 'branch_code DESC', limit: 1 });
    assert.equal(limited.length, 1);
    assert.equal(limited[0].branch_code, 'B3');
  } finally {
    await store.close();
  }
});

test('store: unique violation on manifest_sha256 has code/table/constraint', async () => {
  const store = await openStore();
  try {
    await store.insert('extraction_runs', runRow('run-A'));
    const dup = { ...runRow('run-B'), manifest_sha256: 'sha-run-A' };
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
  } finally {
    await store.close();
  }
});

test('store: insertMany is atomic — one bad row rolls back all', async () => {
  const store = await openStore();
  try {
    await store.insert('extraction_runs', runRow('existing'));
    const batch = [runRow('new-1'), runRow('new-2'), { ...runRow('new-3'), manifest_sha256: 'sha-existing' }];

    await assert.rejects(() => store.insertMany('extraction_runs', batch), UniqueViolationError);

    const count = await store.count('extraction_runs', {});
    assert.equal(count, 1, 'only the pre-existing row should remain; the batch must fully roll back');
    assert.equal(await store.get('extraction_runs', 'new-1'), null);
    assert.equal(await store.get('extraction_runs', 'new-2'), null);
  } finally {
    await store.close();
  }
});

test('store: insertMany succeeds atomically when all rows are valid', async () => {
  const store = await openStore();
  try {
    const inserted = await store.insertMany('extraction_runs', [runRow('m1'), runRow('m2')]);
    assert.equal(inserted.length, 2);
    assert.equal(await store.count('extraction_runs', {}), 2);
  } finally {
    await store.close();
  }
});

test('store: claim race — first wins, second loses; expired claim is reclaimable', async () => {
  const store = await openStore();
  try {
    await store.insert('extraction_runs', runRow('claim-1'));

    const first = await store.claim('extraction_runs', 'claim-1', {
      workerId: 'w1',
      expectedStatus: 'RECEIVED',
      newStatus: 'CLAIMED',
      ttlMs: 10 * 60 * 1000,
    });
    assert.ok(first, 'first claim should win');
    assert.equal(first.status, 'CLAIMED');
    assert.equal(first.claimed_by, 'w1');

    const second = await store.claim('extraction_runs', 'claim-1', {
      workerId: 'w2',
      expectedStatus: 'RECEIVED',
      newStatus: 'CLAIMED',
      ttlMs: 10 * 60 * 1000,
    });
    assert.equal(second, null, 'second claim must lose because status is no longer RECEIVED');

    // Simulate an expired claim by rewriting claim_expires_at into the past, then
    // re-attempt with expectedStatus matching the CURRENT (claimed) status — a
    // worker recovering an expired claim re-claims from the same status, not RECEIVED.
    await store.update('extraction_runs', 'claim-1', { claim_expires_at: '2000-01-01T00:00:00.000Z' });
    const reclaimed = await store.claim('extraction_runs', 'claim-1', {
      workerId: 'w3',
      expectedStatus: 'CLAIMED',
      newStatus: 'CLAIMED',
      ttlMs: 10 * 60 * 1000,
    });
    assert.ok(reclaimed, 'expired claim must be reclaimable');
    assert.equal(reclaimed.claimed_by, 'w3');
  } finally {
    await store.close();
  }
});

test('store: releaseClaim clears claim fields and sets new status', async () => {
  const store = await openStore();
  try {
    await store.insert('extraction_runs', runRow('claim-2'));
    await store.claim('extraction_runs', 'claim-2', { workerId: 'w1', expectedStatus: 'RECEIVED', newStatus: 'CLAIMED', ttlMs: 60000 });
    const released = await store.releaseClaim('extraction_runs', 'claim-2', { workerId: 'w1', newStatus: 'ARCHIVED' });
    assert.equal(released.status, 'ARCHIVED');
    assert.equal(released.claimed_by, null);
    assert.equal(released.claim_expires_at, null);
  } finally {
    await store.close();
  }
});

test('store: raw() rejects non-SELECT SQL and allows SELECT', async () => {
  const store = await openStore();
  try {
    await store.insert('branches', branchRow());

    const rows = await store.raw('SELECT * FROM branches WHERE branch_code = ?', ['PILOT01']);
    assert.equal(rows.length, 1);

    await assert.rejects(() => store.raw("UPDATE branches SET status = 'X'"), RawSqlNotReadOnlyError);
    await assert.rejects(() => store.raw('DELETE FROM branches'), RawSqlNotReadOnlyError);
    await assert.rejects(() => store.raw('DROP TABLE branches'), RawSqlNotReadOnlyError);
    await assert.rejects(() => store.raw("SELECT * FROM branches; DROP TABLE branches"), RawSqlNotReadOnlyError);
  } finally {
    await store.close();
  }
});

test('store: table/column whitelist rejects unknown identifiers', async () => {
  const store = await openStore();
  try {
    await assert.rejects(() => store.find('not_a_real_table', {}), TableNotAllowedError);
    await assert.rejects(() => store.find('branches', { not_a_real_column: 1 }), ColumnNotAllowedError);
    await assert.rejects(() => store.insert('branches', { not_a_real_column: 1 }), ColumnNotAllowedError);
  } finally {
    await store.close();
  }
});

test('store: transaction() rolls back on error and commits on success', async () => {
  const store = await openStore();
  try {
    await assert.rejects(
      store.transaction(async (s) => {
        await s.insert('branches', branchRow('TXN1'));
        throw new Error('boom');
      }),
      /boom/
    );
    assert.equal(await store.get('branches', 'TXN1'), null);

    const result = await store.transaction(async (s) => {
      await s.insert('branches', branchRow('TXN2'));
      return 'ok';
    });
    assert.equal(result, 'ok');
    assert.ok(await store.get('branches', 'TXN2'));
  } finally {
    await store.close();
  }
});

test('store/index: dispatches to memory adapter, rejects unknown adapters, catalyst stub is NOT_IMPLEMENTED', async () => {
  const store = await openDispatchStore({ adapter: 'memory' });
  try {
    await store.insert('branches', branchRow('DISP1'));
    assert.ok(await store.get('branches', 'DISP1'));
  } finally {
    await store.close();
  }

  await assert.rejects(() => openDispatchStore({ adapter: 'nope' }), { code: 'UNKNOWN_ADAPTER' });
  await assert.rejects(() => openDispatchStore({ adapter: 'catalyst' }), { code: 'NOT_IMPLEMENTED' });
});
