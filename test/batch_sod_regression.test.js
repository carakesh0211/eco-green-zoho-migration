// Regression test for the team-management workstream's deliverable #4: confirm
// approveBatch() (src/core/batch.js) already rejects a preparer approving their own
// batch (segregation of duties) with the documented SOD_VIOLATION code. It does —
// see SegregationOfDutiesError there — so this file only adds coverage; it does not
// change batch.js. See test/batch.test.js for the existing role/SoD test this
// complements (that one asserts the thrown class; this one asserts the wire-shape
// `.code` a router relies on to map the error to HTTP 409).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/adapters/store/memory.js';
import { createAudit } from '../src/core/audit.js';
import { createBatch, approveBatch } from '../src/core/batch.js';

async function seedReadyBatch(store, { runId, createdBy }) {
  const now = new Date().toISOString();
  await store.insert('extraction_runs', {
    id: runId, branch_code: 'PILOT01', query_id: 'Q1', query_version: 'v1',
    from_date: '2026-04-01', to_date: '2026-04-30', manifest_json: '{}', manifest_sha256: `msha-${runId}`,
    status: 'STAGED', created_at: now, updated_at: now,
  });
  const file = await store.insert('source_files', {
    run_id: runId, file_name: 'transactions.csv', file_role: 'TRANSACTIONS', sha256: `fsha-${runId}`,
    size_bytes: 10, encoding: 'utf-8', delimiter: ',', status: 'ARCHIVED', created_at: now, updated_at: now,
  });
  await store.insert('vouchers', {
    source_query_id: 'Q1', source_query_version: 'v1', extraction_run_id: runId, source_file_id: file.id,
    source_file_hash: 'fsha', source_record_id: 'V-1', branch_code: 'PILOT01',
    financial_year: '2026-27', period: '2026-04', transaction_date: '2026-04-10',
    source_transaction_type: 'PURCHASE', source_transaction_hash: `hash-${runId}-V-1`,
    debit_total: '100.00', credit_total: '100.00', line_count: 2, is_balanced: 1, disposition: 'MIGRATE',
    disposition_rule_version: 'cut_v1', disposition_reason: 'IN_WINDOW', mapping_version: 'map_v1',
    transformation_version: 'tx_v1', target_module: 'bill', target_payload_hash: `payload-${runId}-V-1`,
    created_at: now, updated_at: now,
  });
  await store.insert('recon_runs', {
    id: `reconA-${runId}`, run_id: runId, batch_id: null, layer: 'A', branch_code: 'PILOT01',
    tolerance: '0.00', status: 'PASS', summary_json: '{}', inputs_version: 'v1', created_by: 'tester', created_at: now,
  });
  await store.insert('recon_runs', {
    id: `reconB-${runId}`, run_id: runId, batch_id: null, layer: 'B', branch_code: 'PILOT01',
    tolerance: '0.00', status: 'PASS', summary_json: '{}', inputs_version: 'v1', created_by: 'tester', created_at: now,
  });
  const audit = createAudit(store);
  const ctx = { store, audit, correlationId: `corr-${runId}`, actor: createdBy, actorRole: 'operator' };
  return createBatch(ctx, { runId, branchCode: 'PILOT01', period: '2026-04', createdBy });
}

test('approveBatch: preparer cannot approve their own batch — SOD_VIOLATION, HTTP-mappable code', async () => {
  const store = await openStore();
  try {
    const audit = createAudit(store);
    const batch = await seedReadyBatch(store, { runId: 'RUN-SOD-1', createdBy: 'preparer-alice' });
    assert.equal(batch.status, 'READY_FOR_APPROVAL');

    const ctx = { store, audit, correlationId: 'corr-sod-1', actor: 'preparer-alice', actorRole: 'approver' };
    await assert.rejects(
      () => approveBatch(ctx, { batchId: batch.id, approver: 'preparer-alice', approverRole: 'approver', reason: 'self-approve attempt' }),
      (err) => {
        assert.equal(err.code, 'SOD_VIOLATION');
        return true;
      }
    );

    // The batch must be untouched by the refused attempt.
    const reloaded = await store.get('migration_batches', batch.id);
    assert.equal(reloaded.status, 'READY_FOR_APPROVAL');
    assert.equal(reloaded.approval_id, null);

    // A different approver succeeds.
    const approved = await approveBatch(ctx, { batchId: batch.id, approver: 'approver-bob', approverRole: 'approver' });
    assert.equal(approved.status, 'APPROVED');
  } finally {
    await store.close();
  }
});
