// POST /api/batches from the branch page's "Build batch for approval" (step 4): the batch is
// created and the branch summary moves with it, so the step list shows the batch at once.
// All codes and amounts are synthetic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { openStore } from '../src/adapters/store/memory.js';
import { createAudit } from '../src/core/audit.js';
import { createApp } from '../src/server/app.js';
import { nowIso } from '../src/core/ids.js';
import * as batch from '../src/core/batch.js';

const sha = (t) => createHash('sha256').update(t, 'utf8').digest('hex');
const TOKEN = 'tok-build-batch-operator';

async function start() {
  const store = await openStore();
  const audit = createAudit(store);
  const now = nowIso();
  await store.insert('branches', { branch_code: 'PILOT01', branch_name: 'Pilot', zoho_location_id: 'LOC-1', created_at: now, updated_at: now });
  const run = await store.insert('extraction_runs', {
    id: 'run-P1', branch_code: 'PILOT01', query_id: 'Q', query_version: 'v1', from_date: '2026-04-01', to_date: '2026-05-31',
    manifest_json: '{}', manifest_sha256: 'msha-1', status: 'TRANSFORMED', created_at: now, updated_at: now,
  });
  const file = await store.insert('source_files', {
    run_id: run.id, file_name: 'transactions.csv', file_role: 'TRANSACTIONS', sha256: 'fsha', size_bytes: 10,
    encoding: 'utf-8', delimiter: ',', status: 'ARCHIVED', created_at: now, updated_at: now,
  });
  for (const [i, period] of [[1, '2026-04'], [2, '2026-05']]) {
    await store.insert('vouchers', {
      source_query_id: 'Q', source_query_version: 'v1', extraction_run_id: run.id, source_file_id: file.id, source_file_hash: 'fsha',
      source_record_id: `V-${i}`, branch_code: 'PILOT01', financial_year: '2026-27', period, transaction_date: `${period}-05`,
      source_transaction_type: 'JOURNAL', source_transaction_hash: `h-${i}`, debit_total: '100.00', credit_total: '100.00',
      line_count: 2, is_balanced: 1, disposition: 'MIGRATE', target_module: 'journal', target_payload_hash: `p-${i}`,
      created_at: now, updated_at: now,
    });
  }
  const users = [{ id: 'u_op', role: 'operator', branches: ['PILOT01'], token_sha256: sha(TOKEN) }];
  const app = createApp({ store, audit, users, deps: { batch } });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (method, url, body) => fetch(base + url, {
    method, headers: { Authorization: `Bearer ${TOKEN}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { call, close: async () => { await new Promise((r) => server.close(r)); await store.close(); } };
}

test('building a batch per month updates the branch summary straight away', async () => {
  const { call, close } = await start();
  try {
    const res = await call('POST', '/api/batches', { runId: 'run-P1', branchCode: 'PILOT01', period: '2026-04' });
    assert.equal(res.status, 201);
    const b = await res.json();
    assert.equal(b.voucher_count, 1, 'only the April voucher');
    assert.equal(b.status, 'DRAFT', 'no source reconciliation run yet');
    assert.equal(JSON.parse(b.totals_json).reason, 'NO_LAYER_A_RECON_RUN');
    const summary = await (await call('GET', '/api/branches/PILOT01')).json();
    assert.equal(summary.batch_approval_status, 'DRAFT', 'summary refreshed by the batch route');
    const again = await (await call('POST', '/api/batches', { runId: 'run-P1', branchCode: 'PILOT01', period: '2026-04' })).json();
    assert.equal(again.id, b.id, 'building again returns the same batch');
  } finally {
    await close();
  }
});

test('POST /api/snapshots takes a Books balance snapshot with the deps the server builds (was INTERNAL_ERROR)', async () => {
  const { buildDeps } = await import('../src/server/index.js');
  const { createBooksClient } = await import('../src/books/index.js');
  const store = await openStore();
  const audit = createAudit(store);
  const now = nowIso();
  await store.insert('branches', { branch_code: 'PILOT01', branch_name: 'Pilot', zoho_location_id: 'loc_head_office', created_at: now, updated_at: now });
  const deps = await buildDeps({ store, audit });
  deps.books = createBooksClient({ driver: 'mock', config: {} });
  const app = createApp({ store, audit, users: [{ id: 'u_op', role: 'operator', branches: ['PILOT01'], token_sha256: sha(TOKEN) }], deps });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/snapshots`, {
      method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ branchCode: 'PILOT01', kind: 'BASELINE' }),
    });
    assert.equal(res.status, 201, await res.clone().text());
  } finally {
    await new Promise((r) => server.close(r));
    await store.close();
  }
});
