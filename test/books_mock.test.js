import test from 'node:test';
import assert from 'node:assert/strict';
import { createMockClient } from '../src/books/mock.js';
import { PostingDisabledError } from '../src/books/guard.js';

test('create(): returns {id, module, custom_fields} and stores the record with created_at', async () => {
  const client = createMockClient();
  const result = await client.create('bill', {
    location_id: 'loc_head_office',
    date: '2026-05-01',
    line_items: [{ account_id: 'acct_ap', debit: '0.00', credit: '100.00' }],
    custom_fields: { cf_migration_source_hash: 'hash-abc' },
  });

  assert.equal(result.module, 'bill');
  assert.match(result.id, /^mock_bill_\d+$/);
  assert.deepEqual(result.custom_fields, { cf_migration_source_hash: 'hash-abc' });

  const stored = client._records().find((r) => r.id === result.id);
  assert.ok(stored, 'record must be stored');
  assert.ok(typeof stored.created_at === 'string' && stored.created_at.length > 0);
});

test('create(): ids are unique and increment per call', async () => {
  const client = createMockClient();
  const a = await client.create('expense', { line_items: [] });
  const b = await client.create('expense', { line_items: [] });
  assert.notEqual(a.id, b.id);
});

test('create(): honours the write guard — mockWritesEnabled defaults to true', async () => {
  const client = createMockClient(); // no config at all
  await assert.doesNotReject(client.create('bill', { line_items: [] }));
});

test('create(): honours the write guard — mockWritesEnabled explicitly false blocks writes', async () => {
  const client = createMockClient({ mockWritesEnabled: false });
  await assert.rejects(client.create('bill', { line_items: [] }), (e) => {
    assert.ok(e instanceof PostingDisabledError);
    assert.equal(e.code, 'POSTING_DISABLED');
    return true;
  });
  assert.deepEqual(client._records(), [], 'nothing should be stored when the guard blocks the write');
});

test('failNext: status fault injection classifies through classify.js (429 -> RATE_LIMIT)', async () => {
  const client = createMockClient();
  client.failNext({ status: 429, retryAfterHeader: '3' });
  await assert.rejects(client.create('bill', { line_items: [] }), (e) => {
    assert.equal(e.classification.class, 'RATE_LIMIT');
    assert.equal(e.classification.retry_after_ms, 3000);
    return true;
  });
  // the following call is unaffected
  const ok = await client.create('bill', { line_items: [] });
  assert.ok(ok.id);
});

test('failNext: status fault injection (500 -> RETRYABLE, 401 -> AUTH, 422 -> NON_RETRYABLE)', async () => {
  const client = createMockClient();
  client.failNext({ status: 500 });
  await assert.rejects(client.create('bill', {}), (e) => e.classification.class === 'RETRYABLE');

  client.failNext({ status: 401 });
  await assert.rejects(client.create('bill', {}), (e) => e.classification.class === 'AUTH');

  client.failNext({ status: 422 });
  await assert.rejects(client.create('bill', {}), (e) => e.classification.class === 'NON_RETRYABLE');
});

test('failNext: timeoutAfterSend fault injection yields UNKNOWN, never SUCCESS/other', async () => {
  const client = createMockClient();
  client.failNext({ timeoutAfterSend: true });
  await assert.rejects(client.create('bill', {}), (e) => e.classification.class === 'UNKNOWN');
});

test('failNext: times>1 applies the fault to multiple consecutive calls, then clears', async () => {
  const client = createMockClient();
  client.failNext({ status: 500, times: 2 });
  await assert.rejects(client.create('bill', {}));
  await assert.rejects(client.create('bill', {}));
  const ok = await client.create('bill', {});
  assert.ok(ok.id);
});

test('searchByMigrationTag: finds records by module + cf_migration_source_hash', async () => {
  const client = createMockClient();
  await client.create('bill', { line_items: [], custom_fields: { cf_migration_source_hash: 'hash-1' } });
  await client.create('bill', { line_items: [], custom_fields: { cf_migration_source_hash: 'hash-2' } });
  await client.create('expense', { line_items: [], custom_fields: { cf_migration_source_hash: 'hash-1' } });

  const found = await client.searchByMigrationTag({ module: 'bill', sourceHash: 'hash-1' });
  assert.equal(found.length, 1);
  assert.equal(found[0].custom_fields.cf_migration_source_hash, 'hash-1');

  const notFound = await client.searchByMigrationTag({ module: 'bill', sourceHash: 'does-not-exist' });
  assert.equal(notFound.length, 0);
});

test('seedRecords + listRecordsInWindow: classifies migration/SP/manual records by tag', async () => {
  const client = createMockClient();
  client.seedRecords([
    { module: 'bill', date: '2026-05-01', custom_fields: { cf_migration_source_hash: 'h1' } }, // migration
    { module: 'bill', date: '2026-05-02', sp_batch_ref: 'SP-BATCH-01' }, // smart pharma
    { module: 'bill', date: '2026-05-03' }, // manual/untagged
    { module: 'bill', date: '2026-06-15' }, // out of window
  ]);

  const window = await client.listRecordsInWindow({ module: 'bill', fromDate: '2026-05-01', toDate: '2026-05-31' });
  assert.equal(window.length, 3);
  const byCreator = Object.fromEntries(window.map((r) => [r.tags.created_by, r]));
  assert.ok(byCreator.migration);
  assert.equal(byCreator.migration.tags.migration_source_hash, 'h1');
  assert.equal(byCreator.migration.tags.manual, false);
  assert.ok(byCreator.smart_pharma);
  assert.equal(byCreator.smart_pharma.tags.sp_batch_ref, 'SP-BATCH-01');
  assert.equal(byCreator.smart_pharma.tags.manual, false);
  assert.ok(byCreator.manual);
  assert.equal(byCreator.manual.tags.migration_source_hash, null);
  assert.equal(byCreator.manual.tags.sp_batch_ref, null);
  assert.equal(byCreator.manual.tags.manual, true);
});

test('listRecordsInWindow: returns each record\'s effects alongside its tags', async () => {
  const client = createMockClient();
  client.seedRecords([
    {
      module: 'journal',
      date: '2026-05-01',
      sp_batch_ref: 'SP-BATCH-01',
      effects: [{ account_id: 'acct_cash', debit: '10.00', credit: '0.00' }, { account_id: 'acct_sales', debit: '0.00', credit: '10.00' }],
    },
    { module: 'journal', date: '2026-05-02' }, // manual, no effects -> contributes nothing
  ]);

  const window = await client.listRecordsInWindow({ module: 'journal', fromDate: '2026-05-01', toDate: '2026-05-31' });
  assert.equal(window.length, 2);
  const spRecord = window.find((r) => r.tags.sp_batch_ref === 'SP-BATCH-01');
  assert.deepEqual(spRecord.effects, [
    { account_id: 'acct_cash', debit: '10.00', credit: '0.00' },
    { account_id: 'acct_sales', debit: '0.00', credit: '10.00' },
  ]);
  const manualRecord = window.find((r) => r.tags.manual === true);
  assert.deepEqual(manualRecord.effects, []);
});

test('listRecordsInWindow: filters by location and module', async () => {
  const client = createMockClient();
  client.seedRecords([
    { module: 'bill', location_id: 'loc_a', date: '2026-05-01' },
    { module: 'bill', location_id: 'loc_b', date: '2026-05-01' },
    { module: 'expense', location_id: 'loc_a', date: '2026-05-01' },
  ]);
  const rows = await client.listRecordsInWindow({ module: 'bill', locationId: 'loc_a', fromDate: '2026-01-01', toDate: '2026-12-31' });
  assert.equal(rows.length, 1);
});

test('getTrialBalance: sums debit/credit with exact BigInt-paise money, no float drift', async () => {
  const client = createMockClient();
  // Values chosen so naive float addition (0.1 + 0.2 style) would drift.
  client.seedRecords([
    {
      module: 'journal',
      date: '2026-05-01',
      effects: [
        { account_id: 'acct_cash', debit: '0.10', credit: '0.00' },
        { account_id: 'acct_cash', debit: '0.20', credit: '0.00' },
        { account_id: 'acct_sales', debit: '0.00', credit: '100.01' },
        { account_id: 'acct_sales', debit: '0.00', credit: '0.02' },
      ],
    },
  ]);

  const tb = await client.getTrialBalance({ fromDate: '2026-01-01', toDate: '2026-12-31' });
  const byAccount = Object.fromEntries(tb.map((r) => [r.account_id, r]));

  assert.equal(byAccount.acct_cash.debit, '0.30');
  assert.equal(byAccount.acct_cash.credit, '0.00');
  assert.equal(byAccount.acct_cash.balance, '0.30');
  assert.equal(byAccount.acct_sales.credit, '100.03');
  assert.equal(byAccount.acct_sales.debit, '0.00');
  assert.equal(byAccount.acct_sales.balance, '-100.03');
  for (const row of tb) {
    assert.equal(typeof row.debit, 'string');
    assert.match(row.debit, /^\d+\.\d{2}$/);
    assert.match(row.credit, /^\d+\.\d{2}$/);
    assert.match(row.balance, /^-?\d+\.\d{2}$/);
  }
});

test('getTrialBalance: respects date range and location filters', async () => {
  const client = createMockClient();
  client.seedRecords([
    { module: 'journal', date: '2026-04-01', location_id: 'loc_head_office', effects: [{ account_id: 'acct_cash', debit: '10.00', credit: '0.00' }] },
    { module: 'journal', date: '2026-07-01', location_id: 'loc_head_office', effects: [{ account_id: 'acct_cash', debit: '99.00', credit: '0.00' }] },
  ]);
  const tb = await client.getTrialBalance({ locationId: 'loc_head_office', fromDate: '2026-04-01', toDate: '2026-06-30' });
  const cash = tb.find((r) => r.account_id === 'acct_cash');
  assert.equal(cash.debit, '10.00');
});

test('getTrialBalance: a seeded record with no effects contributes nothing', async () => {
  const client = createMockClient();
  client.seedRecords([{ module: 'bill', date: '2026-05-01', sp_batch_ref: 'SP-1' }]); // no `effects`
  const tb = await client.getTrialBalance({ fromDate: '2026-01-01', toDate: '2026-12-31' });
  assert.deepEqual(tb, []);
});

test('getTrialBalance: aggregates create()-posted records (real double-entry effects) alongside seeded ones', async () => {
  const client = createMockClient();
  await client.create('bill', {
    date: '2026-05-10',
    vendor: 'ZB-CONTACT-001',
    line_items: [{ account: 'ZB-ACC-1004', amount: '80.00' }],
  });
  client.seedRecords([
    { module: 'journal', date: '2026-05-11', sp_batch_ref: 'SP-1', effects: [{ account_id: 'ZB-ACC-1004', debit: '0.00', credit: '20.00' }, { account_id: 'ZB-ACC-1001', debit: '20.00', credit: '0.00' }] },
  ]);

  const tb = await client.getTrialBalance({ fromDate: '2026-01-01', toDate: '2026-12-31' });
  const byAccount = Object.fromEntries(tb.map((r) => [r.account_id, r]));
  // ZB-ACC-1004 debited 80.00 by the bill, credited 20.00 by the seeded journal -> net 60.00 debit.
  assert.equal(byAccount['ZB-ACC-1004'].debit, '80.00');
  assert.equal(byAccount['ZB-ACC-1004'].credit, '20.00');
  assert.equal(byAccount['ZB-ACC-1004'].balance, '60.00');
  assert.equal(byAccount['CONTACT:ZB-CONTACT-001'].credit, '80.00');
  assert.equal(byAccount['ZB-ACC-1001'].debit, '20.00');
});

test('getOrganization / getLocations: return the in-memory mock org shape', async () => {
  const client = createMockClient({ organizationId: 'org_mock_1' });
  const org = await client.getOrganization();
  assert.equal(org.organization_id, 'org_mock_1');
  const locations = await client.getLocations();
  assert.ok(Array.isArray(locations) && locations.length >= 1);
});
