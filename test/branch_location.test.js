// Changing a branch's Zoho Books location before anything is posted (src/core/branch_location.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/adapters/store/memory.js';
import { createAudit } from '../src/core/audit.js';
import { transformRun } from '../src/core/transform.js';
import { createBatch, approveBatch } from '../src/core/batch.js';
import { changeBranchLocation, checkLocationChange } from '../src/core/branch_location.js';
import { nowIso } from '../src/core/ids.js';

const RUN_ID = 'run-loc1';
const OLD_LOC = '3370193000000412037';
const NEW_LOC = '4222956000000042021';

function ctxFor(store, actor = 'admin-1') {
  return { store, audit: createAudit(store), correlationId: 'corr-loc', actor, actorRole: 'admin' };
}

function rule(overrides) {
  const now = nowIso();
  const row = {
    effective_from: '2026-01-01', effective_to: null, status: 'APPROVED', mapping_version: 'map_v1',
    target_meta: null, notes: null, created_at: now, updated_at: now, ...overrides,
  };
  row.uk = `${row.rule_type}|${row.source_key}|${row.mapping_version}`;
  return row;
}

/** One branch, one transformed run with one journal voucher, an approved April batch. */
async function seedApproved() {
  const store = await openStore();
  const now = nowIso();
  await store.insert('branches', { branch_code: 'B01', branch_name: 'Branch 1', zoho_location_id: OLD_LOC, status: 'ACTIVE', created_at: now, updated_at: now });
  await store.insert('extraction_runs', {
    id: RUN_ID, branch_code: 'B01', query_id: 'Q', query_version: 'v1', from_date: '2026-04-01', to_date: '2026-04-30',
    manifest_json: '{}', manifest_sha256: 'sha-loc1', status: 'CLASSIFIED', created_at: now, updated_at: now,
  });
  const file = await store.insert('source_files', {
    run_id: RUN_ID, file_name: 'txns.csv', file_role: 'TRANSACTIONS', sha256: 'file-sha-loc1', size_bytes: 10,
    encoding: 'utf-8', delimiter: ',', status: 'VALIDATED', created_at: now, updated_at: now,
  });
  const voucher = await store.insert('vouchers', {
    source_query_id: 'Q', source_query_version: 'v1', extraction_run_id: RUN_ID, source_file_id: file.id,
    source_file_hash: 'file-sha-loc1', source_record_id: 'V-L1', source_document_no: 'JNL-L1', branch_code: 'B01',
    zoho_location_id: OLD_LOC, financial_year: '2026-27', period: '2026-04', transaction_date: '2026-04-05',
    source_transaction_type: 'JOURNAL', source_transaction_hash: 'txn-hash-l1', debit_total: '250.00',
    credit_total: '250.00', line_count: 2, is_balanced: 1, disposition: 'MIGRATE', disposition_rule_version: 'cut_v1',
    created_at: now, updated_at: now,
  });
  const mkLine = (n, over) => ({
    run_id: RUN_ID, file_id: file.id, row_number: n, branch_code: 'B01', voucher_id: 'V-L1', voucher_no: 'JNL-L1',
    voucher_type: 'JOURNAL', voucher_date: '2026-04-05', line_no: n, debit: '0.00', credit: '0.00',
    row_hash: `h${n}`, uk: `${file.id}|V-L1|${n}`, created_at: now, ...over,
  });
  await store.insert('source_txn_lines', mkLine(1, { ledger_code: 'LEDG-EXP', debit: '250.00' }));
  await store.insert('source_txn_lines', mkLine(2, { ledger_code: 'LEDG-CASH', credit: '250.00' }));
  await store.insert('mapping_rules', rule({ rule_type: 'MODULE_ROUTE', source_key: 'JOURNAL', target_value: 'journal' }));
  await store.insert('mapping_rules', rule({ rule_type: 'LEDGER_ACCOUNT', source_key: 'LEDG-EXP', target_value: 'ACC-EXP' }));
  await store.insert('mapping_rules', rule({ rule_type: 'LEDGER_ACCOUNT', source_key: 'LEDG-CASH', target_value: 'ACC-CASH' }));
  for (const layer of ['A', 'B']) {
    await store.insert('recon_runs', {
      id: `recon${layer}-${RUN_ID}`, run_id: RUN_ID, batch_id: null, layer, branch_code: 'B01',
      tolerance: '0.00', status: 'PASS', summary_json: '{}', inputs_version: 'v1', created_by: 'tester', created_at: now,
    });
  }
  await transformRun(ctxFor(store, 'worker'), { runId: RUN_ID });
  const built = await createBatch(ctxFor(store, 'alice'), { runId: RUN_ID, branchCode: 'B01', period: '2026-04', createdBy: 'alice' });
  assert.equal(built.status, 'READY_FOR_APPROVAL');
  const approved = await approveBatch(ctxFor(store, 'bob'), { batchId: built.id, approver: 'bob', approverRole: 'approver', reason: 'ok' });
  assert.equal(approved.status, 'APPROVED');
  return { store, voucher, batch: approved };
}

async function payloadOf(store, voucherId) {
  const [row] = await store.find('preview_payloads', { voucher_id: voucherId });
  return JSON.parse(row.payload_json);
}

test('location change: approval withdrawn, batch set aside, vouchers and payloads carry the new location', async () => {
  const { store, voucher, batch } = await seedApproved();
  try {
    assert.equal((await payloadOf(store, voucher.id)).location_id, OLD_LOC);
    const result = await changeBranchLocation(ctxFor(store), { branchCode: 'B01', locationId: NEW_LOC, locationName: 'Branch 461', reason: 'Test org location' });

    assert.equal(result.before, OLD_LOC);
    assert.equal(result.after, NEW_LOC);
    assert.deepEqual(result.batchesSetAside.map((b) => [b.id, b.from]), [[batch.id, 'APPROVED']]);

    const b = await store.get('migration_batches', batch.id);
    assert.equal(b.status, 'REJECTED');
    assert.equal(b.approval_id, null);
    const approval = await store.get('approvals', batch.approval_id);
    assert.ok(approval.invalidated_at);
    assert.equal(approval.invalidation_reason, 'LOCATION_CHANGED');

    const v = await store.get('vouchers', voucher.id);
    assert.equal(v.zoho_location_id, NEW_LOC);
    assert.equal(v.migration_batch_id, null);
    assert.equal(v.approval_id, null);
    assert.equal(v.disposition, 'MIGRATE');
    assert.equal((await payloadOf(store, voucher.id)).location_id, NEW_LOC);
    assert.equal((await store.get('branches', 'B01')).zoho_location_id, NEW_LOC);

    const [event] = await store.find('audit_events', { action: 'BRANCH.LOCATION_CHANGED' });
    assert.ok(event);
  } finally {
    await store.close();
  }
});

test('location change: the batch is built again over the re-prepared vouchers and needs a fresh approval', async () => {
  const { store, batch } = await seedApproved();
  try {
    await changeBranchLocation(ctxFor(store), { branchCode: 'B01', locationId: NEW_LOC, reason: 'Test org location' });
    const rebuilt = await createBatch(ctxFor(store, 'alice'), { runId: RUN_ID, branchCode: 'B01', period: '2026-04', createdBy: 'alice' });
    assert.notEqual(rebuilt.id, batch.id);
    assert.equal(rebuilt.status, 'READY_FOR_APPROVAL');
    assert.equal(rebuilt.voucher_count, 1);
    assert.notEqual(rebuilt.scope_hash, batch.scope_hash);
  } finally {
    await store.close();
  }
});

test('location change is refused once a batch is queued or a voucher was sent', async () => {
  const { store, voucher, batch } = await seedApproved();
  try {
    await store.update('migration_batches', batch.id, { status: 'QUEUED' });
    await assert.rejects(
      () => changeBranchLocation(ctxFor(store), { branchCode: 'B01', locationId: NEW_LOC, reason: 'r' }),
      (err) => err.code === 'BATCH_IN_PROGRESS'
    );
    await store.update('migration_batches', batch.id, { status: 'APPROVED' });
    await store.update('vouchers', voucher.id, { migration_status: 'POSTED' });
    await assert.rejects(
      () => changeBranchLocation(ctxFor(store), { branchCode: 'B01', locationId: NEW_LOC, reason: 'r' }),
      (err) => err.code === 'VOUCHER_SENT'
    );
    assert.equal((await store.get('branches', 'B01')).zoho_location_id, OLD_LOC);
    assert.equal((await store.get('migration_batches', batch.id)).status, 'APPROVED');
  } finally {
    await store.close();
  }
});

test('location change: input checks', async () => {
  const { store } = await seedApproved();
  try {
    const ctx = ctxFor(store);
    await assert.rejects(() => checkLocationChange(ctx, { branchCode: 'B01', locationId: 'LOC-X', reason: 'r' }), (e) => e.code === 'BAD_LOCATION_ID');
    await assert.rejects(() => checkLocationChange(ctx, { branchCode: 'B01', locationId: NEW_LOC, reason: ' ' }), (e) => e.code === 'REASON_REQUIRED');
    await assert.rejects(() => checkLocationChange(ctx, { branchCode: 'NOPE', locationId: NEW_LOC, reason: 'r' }), (e) => e.code === 'NOT_FOUND');
  } finally {
    await store.close();
  }
});

// ---- route: POST /api/branches/:code/location -------------------------------------------

import { createHash } from 'node:crypto';
import { createApp } from '../src/server/app.js';
import * as transform from '../src/core/transform.js';
import * as batchModule from '../src/core/batch.js';

const sha = (t) => createHash('sha256').update(t, 'utf8').digest('hex');
const TOKENS = { admin: 'tok-loc-admin', operator: 'tok-loc-operator', bot: 'tok-loc-bot' };

async function startApp() {
  const { store } = await seedApproved();
  const users = [
    { id: 'u_admin', role: 'admin', branches: ['*'], token_sha256: sha(TOKENS.admin) },
    { id: 'u_op', role: 'operator', branches: ['B01'], token_sha256: sha(TOKENS.operator) },
    { id: 'bot:agent', role: 'operator', branches: ['*'], token_sha256: sha(TOKENS.bot) },
  ];
  const app = createApp({ store, audit: createAudit(store), users, deps: { transform, batch: batchModule } });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (who, method, url, body) => fetch(base + url, {
    method,
    headers: { Authorization: `Bearer ${TOKENS[who]}`, 'X-Correlation-Id': `c-${Math.random()}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { store, call, close: async () => { await new Promise((r) => server.close(r)); await store.close(); } };
}

test('route: only a human admin may change the location; the change runs as a job', async () => {
  const { store, call, close } = await startApp();
  try {
    const body = { location_id: NEW_LOC, location_name: 'Branch 461', reason: 'Test org location' };
    assert.equal((await call('operator', 'POST', '/api/branches/B01/location', body)).status, 403);
    assert.equal((await call('bot', 'POST', '/api/branches/B01/location', body)).status, 403);
    assert.equal((await call('admin', 'POST', '/api/branches/B01/location', { ...body, location_id: 'x' })).status, 400);

    const res = await call('admin', 'POST', '/api/branches/B01/location', body);
    assert.equal(res.status, 202);
    const { jobId } = await res.json();
    let job;
    for (let i = 0; i < 100; i += 1) {
      job = await (await call('admin', 'GET', `/api/runs/retransform-jobs/${jobId}`)).json();
      if (job.stage === 'DONE' || job.stage === 'FAILED') break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(job.stage, 'DONE', JSON.stringify(job.error));
    assert.equal(job.trigger, 'location_change');
    assert.equal(job.result.after, NEW_LOC);
    assert.equal((await store.get('branches', 'B01')).zoho_location_id, NEW_LOC);
  } finally {
    await close();
  }
});
