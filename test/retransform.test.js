import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/adapters/store/memory.js';
import { createAudit } from '../src/core/audit.js';
import { retransformRun } from '../src/core/transform.js';
import { nowIso } from '../src/core/ids.js';

const RUN_ID = 'run-rt1';

function ctxFor(store) {
  return { store, audit: createAudit(store), correlationId: 'corr-rt', actor: 'tester' };
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

async function seed({ runStatus = 'TRANSFORMED' } = {}) {
  const store = await openStore();
  const now = nowIso();
  const run = await store.insert('extraction_runs', {
    id: RUN_ID, branch_code: 'B01', query_id: 'Q', query_version: 'v1', from_date: '2026-04-01', to_date: '2026-04-30',
    manifest_json: '{}', manifest_sha256: 'sha-rt1', status: runStatus, created_at: now, updated_at: now,
  });
  const file = await store.insert('source_files', {
    run_id: run.id, file_name: 'txns.csv', file_role: 'TRANSACTIONS', sha256: 'file-sha-rt1', size_bytes: 10,
    encoding: 'utf-8', delimiter: ',', status: 'VALIDATED', created_at: now, updated_at: now,
  });
  const voucher = await store.insert('vouchers', {
    source_query_id: 'Q', source_query_version: 'v1', extraction_run_id: run.id, source_file_id: file.id,
    source_file_hash: 'file-sha-rt1', source_record_id: 'V-RT1', source_document_no: 'JNL-RT1', branch_code: 'B01',
    zoho_location_id: 'LOC-1', financial_year: '2026-27', period: '2026-04', transaction_date: '2026-04-05',
    source_transaction_type: 'JOURNAL', source_transaction_hash: 'txn-hash-rt1', debit_total: '250.00',
    credit_total: '250.00', line_count: 2, is_balanced: 1, disposition: 'BLOCKED', disposition_reason: 'UNMAPPED_ENTITY',
    created_at: now, updated_at: now,
  });
  const mkLine = (n, over) => ({
    run_id: run.id, file_id: file.id, row_number: n, branch_code: 'B01', voucher_id: 'V-RT1', voucher_no: 'JNL-RT1',
    voucher_type: 'JOURNAL', voucher_date: '2026-04-05', line_no: n, debit: '0.00', credit: '0.00',
    row_hash: `h${n}`, uk: `${file.id}|V-RT1|${n}`, created_at: now, ...over,
  });
  await store.insert('source_txn_lines', mkLine(1, { ledger_code: 'LEDG-AR', debit: '250.00', party_code: 'CUST-1' }));
  await store.insert('source_txn_lines', mkLine(2, { ledger_code: 'LEDG-SALES', credit: '250.00' }));
  const exception = await store.insert('exceptions', {
    category: 'UNMAPPED_ENTITY', severity: 'P1', branch_code: 'B01', period: '2026-04', run_id: run.id, voucher_id: voucher.id,
    financial_impact: '0.00', status: 'OPEN', message: 'No APPROVED mapping rule for PARTY/CUST-1',
    dedupe_key: `tx:${voucher.id}:PARTY:CUST-1`, created_at: now, updated_at: now,
  });
  await store.insert('mapping_rules', rule({ rule_type: 'MODULE_ROUTE', source_key: 'JOURNAL', target_value: 'journal' }));
  return { store, run, file, voucher, exception };
}

async function addLedgerAndPartyRules(store) {
  await store.insert('mapping_rules', rule({ rule_type: 'LEDGER_ACCOUNT', source_key: 'LEDG-AR', target_value: 'ACC-AR' }));
  await store.insert('mapping_rules', rule({ rule_type: 'LEDGER_ACCOUNT', source_key: 'LEDG-SALES', target_value: 'ACC-SALES' }));
  await store.insert('mapping_rules', rule({
    rule_type: 'PARTY', source_key: 'CUST-1', target_value: 'CONTACT-C1',
    target_meta: JSON.stringify({ kind: 'contact', contact_type: 'customer' }),
  }));
}

/** Re-shape the seeded voucher as classification left it when no MODULE_ROUTE was approved
 * yet (src/core/overlap.js): BLOCKED / UNMAPPED_MODULE with its own open exception. */
async function blockAtClassification(store, voucher, exception) {
  await store.update('vouchers', voucher.id, { disposition_reason: 'UNMAPPED_MODULE' });
  await store.update('exceptions', exception.id, {
    category: 'UNMAPPED_MODULE', message: 'No approved MODULE_ROUTE for JOURNAL', dedupe_key: `cls:${voucher.id}:UNMAPPED_MODULE`,
  });
}

describe('retransformRun', () => {
  test('without the missing rules the voucher stays BLOCKED and the exception is open again', async () => {
    const { store, voucher, exception } = await seed();
    try {
      const res = await retransformRun(ctxFor(store), { runId: RUN_ID });
      assert.equal(res.reset, 1);
      assert.equal(res.stillBlocked, 1);
      assert.equal(res.status, 'TRANSFORMED');
      const v = await store.get('vouchers', voucher.id);
      assert.equal(v.disposition, 'BLOCKED');
      assert.equal(v.disposition_reason, 'UNMAPPED_ENTITY');
      const exc = await store.get('exceptions', exception.id);
      assert.equal(exc.status, 'OPEN'); // resolved, then reopened by the same dedupeKey
      assert.equal((await store.find('exceptions', { voucher_id: voucher.id })).length, 1);
      const reopened = await store.find('audit_events', { action: 'EXCEPTION.REOPENED' });
      assert.equal(reopened.length, 1);
      assert.equal((await store.get('extraction_runs', RUN_ID)).status, 'TRANSFORMED');
    } finally {
      await store.close();
    }
  });

  test('after the rules are approved the voucher migrates with a contact on the party line', async () => {
    const { store, voucher, exception } = await seed();
    try {
      await addLedgerAndPartyRules(store);
      const res = await retransformRun(ctxFor(store), { runId: RUN_ID });
      assert.equal(res.reset, 1);
      assert.equal(res.stillBlocked, 0);
      assert.equal(res.status, 'TRANSFORMED');

      const v = await store.get('vouchers', voucher.id);
      assert.equal(v.disposition, 'MIGRATE');
      assert.equal(v.disposition_reason, null);
      assert.equal(v.disposition_by, 'tester');
      assert.equal(v.target_module, 'journal');
      assert.ok(v.target_payload_hash);

      const previews = await store.find('preview_payloads', { voucher_id: voucher.id });
      assert.equal(previews.length, 1);
      const payload = JSON.parse(previews[0].payload_json);
      assert.deepEqual(payload.line_items, [
        { account: 'ACC-AR', contact: 'CONTACT-C1', contact_type: 'customer', debit: '250.00' },
        { account: 'ACC-SALES', credit: '250.00' },
      ]);

      assert.equal((await store.get('exceptions', exception.id)).status, 'RESOLVED');
      assert.equal((await store.get('extraction_runs', RUN_ID)).status, 'TRANSFORMED');
      const rerun = await store.find('audit_events', { action: 'TRANSFORM.RERUN' });
      assert.equal(rerun.length, 1);
      assert.deepEqual(JSON.parse(rerun[0].after_json), { reset: 1, resetUnmappedModule: 0 });
    } finally {
      await store.close();
    }
  });

  test('a voucher blocked at classification (UNMAPPED_MODULE) migrates once its route and rules are approved', async () => {
    const { store, voucher, exception } = await seed();
    try {
      await blockAtClassification(store, voucher, exception);
      await addLedgerAndPartyRules(store);
      const res = await retransformRun(ctxFor(store), { runId: RUN_ID });
      assert.equal(res.reset, 1);
      assert.equal(res.stillBlocked, 0);
      assert.equal(res.stillUnmappedModule, 0);

      const v = await store.get('vouchers', voucher.id);
      assert.equal(v.disposition, 'MIGRATE');
      assert.equal(v.disposition_reason, null);
      assert.equal(v.target_module, 'journal');
      const exc = await store.get('exceptions', exception.id);
      assert.equal(exc.status, 'RESOLVED');
      assert.equal(exc.category, 'UNMAPPED_MODULE');
      const rerun = await store.find('audit_events', { action: 'TRANSFORM.RERUN' });
      assert.deepEqual(JSON.parse(rerun[0].after_json), { reset: 1, resetUnmappedModule: 1 });
    } finally {
      await store.close();
    }
  });

  test('a voucher blocked at classification is released once its route is approved and re-blocked as UNMAPPED_ENTITY while ledger rules are missing', async () => {
    const { store, voucher, exception } = await seed();
    try {
      await blockAtClassification(store, voucher, exception);
      // Route approved, ledger/party rules still missing: released, then re-blocked by the transform.
      const res = await retransformRun(ctxFor(store), { runId: RUN_ID });
      assert.equal(res.reset, 1);
      assert.equal(res.stillBlocked, 1);
      assert.equal(res.stillUnmappedModule, 0);
      const v = await store.get('vouchers', voucher.id);
      assert.equal(v.disposition, 'BLOCKED');
      assert.equal(v.disposition_reason, 'UNMAPPED_ENTITY');
      assert.equal((await store.get('exceptions', exception.id)).status, 'RESOLVED');
      const open = (await store.find('exceptions', { voucher_id: voucher.id })).filter((e) => e.status === 'OPEN');
      assert.equal(open.length, 1);
      assert.equal(open[0].category, 'UNMAPPED_ENTITY');
    } finally {
      await store.close();
    }
  });

  test('a voucher blocked at classification stays UNMAPPED_MODULE while its route is still not approved', async () => {
    const { store, voucher, exception } = await seed();
    try {
      await blockAtClassification(store, voucher, exception);
      const [route] = await store.find('mapping_rules', { rule_type: 'MODULE_ROUTE' });
      await store.update('mapping_rules', route.id, { status: 'DRAFT' });
      await addLedgerAndPartyRules(store);
      const res = await retransformRun(ctxFor(store), { runId: RUN_ID });
      assert.equal(res.reset, 0);
      assert.equal(res.stillBlocked, 1);
      assert.equal(res.stillUnmappedModule, 1);
      const v = await store.get('vouchers', voucher.id);
      assert.equal(v.disposition, 'BLOCKED');
      assert.equal(v.disposition_reason, 'UNMAPPED_MODULE');
      assert.equal((await store.get('exceptions', exception.id)).status, 'OPEN');
      assert.equal((await store.find('exceptions', { voucher_id: voucher.id })).length, 1);
    } finally {
      await store.close();
    }
  });

  test('a READY_FOR_APPROVAL run is stepped back through CLASSIFIED and ends TRANSFORMED', async () => {
    const { store } = await seed({ runStatus: 'READY_FOR_APPROVAL' });
    try {
      await addLedgerAndPartyRules(store);
      const res = await retransformRun(ctxFor(store), { runId: RUN_ID });
      assert.equal(res.status, 'TRANSFORMED');
      assert.equal((await store.get('extraction_runs', RUN_ID)).status, 'TRANSFORMED');
    } finally {
      await store.close();
    }
  });

  test('refuses a run in the wrong state (STAGED -> INVALID_RUN_STATE)', async () => {
    const { store, voucher } = await seed({ runStatus: 'STAGED' });
    try {
      await assert.rejects(
        () => retransformRun(ctxFor(store), { runId: RUN_ID }),
        (err) => err.code === 'INVALID_RUN_STATE' && /STAGED/.test(err.message),
      );
      assert.equal((await store.get('vouchers', voucher.id)).disposition, 'BLOCKED');
    } finally {
      await store.close();
    }
  });

  test('refuses an unknown run (NOT_FOUND)', async () => {
    const { store } = await seed();
    try {
      await assert.rejects(
        () => retransformRun(ctxFor(store), { runId: 'nope' }),
        (err) => err.code === 'NOT_FOUND',
      );
    } finally {
      await store.close();
    }
  });

  test('refuses while a batch is APPROVED (BATCH_IN_PROGRESS) and changes nothing', async () => {
    const { store, voucher, exception } = await seed();
    try {
      const now = nowIso();
      await store.insert('migration_batches', {
        id: 'batch-rt1', branch_code: 'B01', period: '2026-04', run_id: RUN_ID, scope_hash: 's', mapping_version: 'map_v1',
        transformation_version: 'tx_v1', cutover_rule_version: 'cut_v1', voucher_count: 1, debit_total: '250.00',
        credit_total: '250.00', totals_json: '{}', status: 'APPROVED', created_by: 'seed', created_at: now, updated_at: now,
      });
      await addLedgerAndPartyRules(store);
      await assert.rejects(
        () => retransformRun(ctxFor(store), { runId: RUN_ID }),
        (err) => err.code === 'BATCH_IN_PROGRESS',
      );
      assert.equal((await store.get('vouchers', voucher.id)).disposition, 'BLOCKED');
      assert.equal((await store.get('exceptions', exception.id)).status, 'OPEN');
    } finally {
      await store.close();
    }
  });

  test('DRAFT / REJECTED / APPROVAL_INVALIDATED batches do not block a re-transform', async () => {
    const { store } = await seed();
    try {
      const now = nowIso();
      let i = 0;
      for (const status of ['DRAFT', 'REJECTED', 'APPROVAL_INVALIDATED']) {
        await store.insert('migration_batches', {
          id: `batch-rt-${i++}`, branch_code: 'B01', period: '2026-04', run_id: RUN_ID, scope_hash: 's', mapping_version: 'map_v1',
          transformation_version: 'tx_v1', cutover_rule_version: 'cut_v1', voucher_count: 1, debit_total: '250.00',
          credit_total: '250.00', totals_json: '{}', status, created_by: 'seed', created_at: now, updated_at: now,
        });
      }
      await addLedgerAndPartyRules(store);
      const res = await retransformRun(ctxFor(store), { runId: RUN_ID });
      assert.equal(res.stillBlocked, 0);
    } finally {
      await store.close();
    }
  });
});
