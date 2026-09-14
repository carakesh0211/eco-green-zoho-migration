import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/adapters/store/memory.js';
import { createAudit } from '../src/core/audit.js';
import {
  createBatch, approveBatch, invalidateApprovalIfChanged, enqueueBatch,
  RoleForbiddenError, SegregationOfDutiesError, ScopeChangedError,
} from '../src/core/batch.js';

async function makeCtx() {
  const store = await openStore();
  const audit = createAudit(store);
  return { store, audit, ctx: { store, audit, correlationId: 'corr-batch', actor: 'tester', actorRole: 'operator' } };
}

async function seedRunAndFile(store, runId) {
  const now = new Date().toISOString();
  await store.insert('extraction_runs', {
    id: runId, branch_code: 'PILOT01', query_id: 'Q1', query_version: 'v1',
    from_date: '2026-04-01', to_date: '2026-04-30', manifest_json: '{}', manifest_sha256: `msha-${runId}`,
    inbox_ref: null, archive_uri: null, status: 'STAGED', claimed_by: null, claimed_at: null, claim_expires_at: null,
    error_code: null, error_message: null, created_at: now, updated_at: now,
  });
  const file = await store.insert('source_files', {
    run_id: runId, file_name: 'transactions.csv', file_role: 'TRANSACTIONS', sha256: `fsha-${runId}`,
    size_bytes: 10, encoding: 'utf-8', delimiter: ',', declared_row_count: 1, actual_row_count: 1,
    declared_debit_total: '0.00', declared_credit_total: '0.00', actual_debit_total: '0.00', actual_credit_total: '0.00',
    archive_uri: null, status: 'ARCHIVED', validation_json: '[]', created_at: now, updated_at: now,
  });
  return file;
}

async function seedVoucher(store, { runId, fileId, voucherId, period = '2026-04', payloadHash }) {
  const now = new Date().toISOString();
  return store.insert('vouchers', {
    source_query_id: 'Q1', source_query_version: 'v1', extraction_run_id: runId, source_file_id: fileId,
    source_file_hash: 'fsha', source_record_id: voucherId, branch_code: 'PILOT01',
    zoho_location_id: 'LOC-PILOT01', financial_year: '2026-27', period, transaction_date: '2026-04-10',
    source_transaction_type: 'PURCHASE', source_transaction_hash: `hash-${voucherId}`,
    debit_total: '100.00', credit_total: '100.00', line_count: 2, is_balanced: 1, disposition: 'MIGRATE',
    disposition_rule_version: 'cut_v1', disposition_reason: 'IN_WINDOW', mapping_version: 'map_v1',
    transformation_version: 'tx_v1', target_module: 'bill', target_payload_hash: payloadHash ?? `payload-${voucherId}`,
    created_at: now, updated_at: now,
  });
}

async function passRecons(store, runId) {
  const now = new Date().toISOString();
  await store.insert('recon_runs', {
    id: `reconA-${runId}`, run_id: runId, batch_id: null, layer: 'A', branch_code: 'PILOT01',
    tolerance: '0.00', status: 'PASS', summary_json: '{}', inputs_version: 'v1', created_by: 'tester', created_at: now,
  });
  await store.insert('recon_runs', {
    id: `reconB-${runId}`, run_id: runId, batch_id: null, layer: 'B', branch_code: 'PILOT01',
    tolerance: '0.00', status: 'PASS', summary_json: '{}', inputs_version: 'v1', created_by: 'tester', created_at: now,
  });
}

test('createBatch: requires PASS Layer A & B recon runs, else stays DRAFT with a reason', async () => {
  const { store, ctx } = await makeCtx();
  try {
    const file = await seedRunAndFile(store, 'RUN-1');
    await seedVoucher(store, { runId: 'RUN-1', fileId: file.id, voucherId: 'V-1' });
    await seedVoucher(store, { runId: 'RUN-1', fileId: file.id, voucherId: 'V-2' });

    const noRecon = await createBatch(ctx, { runId: 'RUN-1', branchCode: 'PILOT01', period: '2026-04', createdBy: 'alice' });
    assert.equal(noRecon.status, 'DRAFT');
    const totals = JSON.parse(noRecon.totals_json);
    assert.equal(totals.reason, 'NO_LAYER_A_RECON_RUN');

    await passRecons(store, 'RUN-1');

    const ready = await createBatch(ctx, { runId: 'RUN-1', branchCode: 'PILOT01', period: '2026-04', createdBy: 'alice' });
    assert.equal(ready.status, 'READY_FOR_APPROVAL');
    assert.equal(ready.voucher_count, 2);
    assert.equal(ready.debit_total, '200.00');
  } finally {
    await store.close();
  }
});

test('approveBatch: role must be approver|admin, and segregation of duties refuses the creator', async () => {
  const { store, ctx } = await makeCtx();
  try {
    const file = await seedRunAndFile(store, 'RUN-2');
    await seedVoucher(store, { runId: 'RUN-2', fileId: file.id, voucherId: 'V-1' });
    await passRecons(store, 'RUN-2');
    const batch = await createBatch(ctx, { runId: 'RUN-2', branchCode: 'PILOT01', period: '2026-04', createdBy: 'alice' });
    assert.equal(batch.status, 'READY_FOR_APPROVAL');

    await assert.rejects(
      () => approveBatch(ctx, { batchId: batch.id, approver: 'bob', approverRole: 'operator' }),
      RoleForbiddenError,
    );
    await assert.rejects(
      () => approveBatch(ctx, { batchId: batch.id, approver: 'alice', approverRole: 'approver' }),
      SegregationOfDutiesError,
    );

    const approved = await approveBatch(ctx, { batchId: batch.id, approver: 'bob', approverRole: 'approver', reason: 'looks good' });
    assert.equal(approved.status, 'APPROVED');
    assert.ok(approved.approval_id);

    const voucher = await store.findOne('vouchers', { source_record_id: 'V-1', extraction_run_id: 'RUN-2' });
    assert.equal(voucher.approval_id, approved.approval_id);
    assert.equal(voucher.migration_batch_id, batch.id);
  } finally {
    await store.close();
  }
});

test('approveBatch: SOD_ENFORCED=false allows the creator to self-approve', async () => {
  const { store, ctx } = await makeCtx();
  const prev = process.env.SOD_ENFORCED;
  process.env.SOD_ENFORCED = 'false';
  try {
    const file = await seedRunAndFile(store, 'RUN-3');
    await seedVoucher(store, { runId: 'RUN-3', fileId: file.id, voucherId: 'V-1' });
    await passRecons(store, 'RUN-3');
    const batch = await createBatch(ctx, { runId: 'RUN-3', branchCode: 'PILOT01', period: '2026-04', createdBy: 'alice' });

    const approved = await approveBatch(ctx, { batchId: batch.id, approver: 'alice', approverRole: 'approver' });
    assert.equal(approved.status, 'APPROVED');
  } finally {
    if (prev === undefined) delete process.env.SOD_ENFORCED; else process.env.SOD_ENFORCED = prev;
    await store.close();
  }
});

test('approveBatch: refuses with SCOPE_CHANGED when the voucher/payload set moved since createBatch', async () => {
  const { store, ctx } = await makeCtx();
  try {
    const file = await seedRunAndFile(store, 'RUN-4');
    const v1 = await seedVoucher(store, { runId: 'RUN-4', fileId: file.id, voucherId: 'V-1' });
    await passRecons(store, 'RUN-4');
    const batch = await createBatch(ctx, { runId: 'RUN-4', branchCode: 'PILOT01', period: '2026-04', createdBy: 'alice' });
    assert.equal(batch.status, 'READY_FOR_APPROVAL');

    // Simulate a re-transform changing the payload hash after the batch was created.
    await store.update('vouchers', v1.id, { target_payload_hash: 'payload-V-1-CHANGED' });

    await assert.rejects(
      () => approveBatch(ctx, { batchId: batch.id, approver: 'bob', approverRole: 'approver' }),
      ScopeChangedError,
    );
    const stillReady = await store.get('migration_batches', batch.id);
    assert.equal(stillReady.status, 'READY_FOR_APPROVAL');
  } finally {
    await store.close();
  }
});

test('invalidateApprovalIfChanged: invalidates a standing approval when scope drifts, clears voucher links', async () => {
  const { store, ctx } = await makeCtx();
  try {
    const file = await seedRunAndFile(store, 'RUN-5');
    const v1 = await seedVoucher(store, { runId: 'RUN-5', fileId: file.id, voucherId: 'V-1' });
    await passRecons(store, 'RUN-5');
    const batch = await createBatch(ctx, { runId: 'RUN-5', branchCode: 'PILOT01', period: '2026-04', createdBy: 'alice' });
    const approved = await approveBatch(ctx, { batchId: batch.id, approver: 'bob', approverRole: 'approver' });
    assert.equal(approved.status, 'APPROVED');

    const noop = await invalidateApprovalIfChanged(ctx, { batchId: batch.id, reason: 'check' });
    assert.equal(noop.changed, false);

    await store.update('vouchers', v1.id, { target_payload_hash: 'payload-V-1-CHANGED' });

    const result = await invalidateApprovalIfChanged(ctx, { batchId: batch.id, reason: 'retransformed' });
    assert.equal(result.changed, true);
    assert.equal(result.invalidated, true);
    assert.equal(result.batch.status, 'APPROVAL_INVALIDATED');
    assert.equal(result.batch.approval_id, null);

    const approvalRow = await store.get('approvals', approved.approval_id);
    assert.ok(approvalRow.invalidated_at);

    const voucher = await store.get('vouchers', v1.id);
    assert.equal(voucher.approval_id, null);
  } finally {
    await store.close();
  }
});

test('enqueueBatch: APPROVED only, idempotent on the source_transaction_hash key (safe to retry)', async () => {
  const { store, ctx } = await makeCtx();
  try {
    const file = await seedRunAndFile(store, 'RUN-6');
    const v1 = await seedVoucher(store, { runId: 'RUN-6', fileId: file.id, voucherId: 'V-1' });
    await seedVoucher(store, { runId: 'RUN-6', fileId: file.id, voucherId: 'V-2' });
    await passRecons(store, 'RUN-6');
    const batch = await createBatch(ctx, { runId: 'RUN-6', branchCode: 'PILOT01', period: '2026-04', createdBy: 'alice' });
    const approved = await approveBatch(ctx, { batchId: batch.id, approver: 'bob', approverRole: 'approver' });

    // Simulate a prior enqueue attempt that inserted V-1's queue_item then crashed
    // before the batch status flip.
    const now = new Date().toISOString();
    await store.insert('queue_items', {
      batch_id: approved.id, voucher_id: v1.id, idempotency_key: 'hash-V-1', status: 'QUEUED',
      claimed_by: null, claimed_at: null, claim_expires_at: null, run_after: null, attempts: 0,
      last_error_code: null, created_at: now, updated_at: now,
    });

    const result = await enqueueBatch(ctx, { batchId: approved.id });
    assert.equal(result.batch.status, 'QUEUED');
    assert.equal(result.enqueued, 1);
    assert.equal(result.skippedExisting, 1);

    const items = await store.find('queue_items', { batch_id: approved.id });
    assert.equal(items.length, 2);
    const keys = items.map((i) => i.idempotency_key).sort();
    assert.deepEqual(keys, ['hash-V-1', 'hash-V-2']);
  } finally {
    await store.close();
  }
});
