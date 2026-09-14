import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { openStore } from '../src/adapters/store/memory.js';
import { createAudit } from '../src/core/audit.js';
import { createApp } from '../src/server/app.js';
import { nowIso } from '../src/core/ids.js';

function sha(token) {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

const TOKENS = { operator: 'tok-mutate-operator', viewer: 'tok-mutate-viewer' };

function users() {
  return [
    { id: 'u_operator', role: 'operator', branches: ['PILOT01'], token_sha256: sha(TOKENS.operator) },
    { id: 'u_viewer', role: 'viewer', branches: ['PILOT01'], token_sha256: sha(TOKENS.viewer) },
  ];
}

async function seedChain(store, { batchStatus = 'QUEUED' } = {}) {
  const now = nowIso();
  const run = await store.insert('extraction_runs', {
    id: 'run-m1',
    branch_code: 'PILOT01',
    query_id: 'Q',
    query_version: 'v1',
    from_date: '2026-04-01',
    to_date: '2026-04-30',
    manifest_json: '{}',
    manifest_sha256: 'sha-run-m1',
    status: 'STAGED',
    created_at: now,
    updated_at: now,
  });
  const file = await store.insert('source_files', {
    run_id: run.id,
    file_name: 'txns.csv',
    file_role: 'TRANSACTIONS',
    sha256: 'file-sha-m1',
    size_bytes: 10,
    encoding: 'utf-8',
    delimiter: ',',
    status: 'VALIDATED',
    created_at: now,
    updated_at: now,
  });
  const voucher = await store.insert('vouchers', {
    source_query_id: 'Q',
    source_query_version: 'v1',
    extraction_run_id: run.id,
    source_file_id: file.id,
    source_file_hash: 'file-sha-m1',
    source_record_id: 'V-M1',
    branch_code: 'PILOT01',
    financial_year: '2026-27',
    period: '2026-04',
    transaction_date: '2026-04-05',
    source_transaction_type: 'PAYMENT',
    source_transaction_hash: 'txn-hash-m1',
    debit_total: '100.00',
    credit_total: '100.00',
    line_count: 1,
    is_balanced: 1,
    disposition: 'MIGRATE',
    created_at: now,
    updated_at: now,
  });
  const batch = await store.insert('migration_batches', {
    id: 'batch-m1',
    branch_code: 'PILOT01',
    period: '2026-04',
    run_id: run.id,
    scope_hash: 'scope-1',
    mapping_version: 'map_v1',
    transformation_version: 'tx_v1',
    cutover_rule_version: 'cut_v1',
    voucher_count: 1,
    debit_total: '100.00',
    credit_total: '100.00',
    totals_json: '{}',
    status: batchStatus,
    created_by: 'seed',
    created_at: now,
    updated_at: now,
  });
  return { run, file, voucher, batch };
}

async function insertQueueItem(store, { batch, voucher, status, idempotencyKey }) {
  const now = nowIso();
  return store.insert('queue_items', {
    batch_id: batch.id,
    voucher_id: voucher.id,
    idempotency_key: idempotencyKey,
    status,
    attempts: 0,
    created_at: now,
    updated_at: now,
  });
}

async function startApp({ batchStatus = 'QUEUED' } = {}) {
  const store = await openStore();
  const audit = createAudit(store);
  const seeded = await seedChain(store, { batchStatus });
  const app = createApp({ store, audit, users: users(), deps: {} });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;
  return {
    store,
    seeded,
    base: `http://127.0.0.1:${port}`,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      await store.close();
    },
  };
}

function opHeaders(extra = {}) {
  return { Authorization: `Bearer ${TOKENS.operator}`, 'Content-Type': 'application/json', ...extra };
}

test('server mutate: retry refuses UNKNOWN_OUTCOME with 409', async () => {
  const { base, store, seeded, close } = await startApp();
  try {
    const item = await insertQueueItem(store, { batch: seeded.batch, voucher: seeded.voucher, status: 'UNKNOWN_OUTCOME', idempotencyKey: 'idem-unknown' });
    const res = await fetch(`${base}/api/queue/${item.id}/retry`, { method: 'POST', headers: opHeaders(), body: '{}' });
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.error, 'UNKNOWN_OUTCOME_NOT_RETRYABLE');
    assert.match(body.message, /resolveUnknownOutcomes/);
  } finally {
    await close();
  }
});

test('server mutate: retry allows FAILED_RETRYABLE -> QUEUED and writes an ALLOWED audit row', async () => {
  const { base, store, seeded, close } = await startApp();
  try {
    const item = await insertQueueItem(store, { batch: seeded.batch, voucher: seeded.voucher, status: 'FAILED_RETRYABLE', idempotencyKey: 'idem-retryable' });
    const res = await fetch(`${base}/api/queue/${item.id}/retry`, { method: 'POST', headers: opHeaders(), body: '{}' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'QUEUED');

    const events = await store.find('audit_events', { action: 'QUEUE.RETRY' });
    assert.equal(events.length, 1);
    assert.equal(events[0].authorization_decision, 'ALLOWED');
    assert.equal(events[0].entity_id, String(item.id));
  } finally {
    await close();
  }
});

test('server mutate: DEAD_LETTER retry requires a reason', async () => {
  const { base, store, seeded, close } = await startApp();
  try {
    const item = await insertQueueItem(store, { batch: seeded.batch, voucher: seeded.voucher, status: 'DEAD_LETTER', idempotencyKey: 'idem-dead' });
    const noReason = await fetch(`${base}/api/queue/${item.id}/retry`, { method: 'POST', headers: opHeaders(), body: '{}' });
    assert.equal(noReason.status, 400);

    const withReason = await fetch(`${base}/api/queue/${item.id}/retry`, {
      method: 'POST',
      headers: opHeaders(),
      body: JSON.stringify({ reason: 'manual review complete' }),
    });
    assert.equal(withReason.status, 200);
  } finally {
    await close();
  }
});

test('server mutate: pause/resume transitions the batch and audits both, correlation id echoed', async () => {
  const { base, store, seeded, close } = await startApp({ batchStatus: 'QUEUED' });
  try {
    const correlationId = 'corr-fixed-123';
    const pauseRes = await fetch(`${base}/api/batches/${seeded.batch.id}/pause`, {
      method: 'POST',
      headers: opHeaders({ 'X-Correlation-Id': correlationId }),
      body: '{}',
    });
    assert.equal(pauseRes.status, 200);
    assert.equal(pauseRes.headers.get('x-correlation-id'), correlationId);
    const paused = await pauseRes.json();
    assert.equal(paused.status, 'PAUSED');

    const resumeRes = await fetch(`${base}/api/batches/${seeded.batch.id}/resume`, { method: 'POST', headers: opHeaders(), body: '{}' });
    assert.equal(resumeRes.status, 200);
    assert.ok(resumeRes.headers.get('x-correlation-id'));
    const resumed = await resumeRes.json();
    assert.equal(resumed.status, 'QUEUED');

    const pauseAudit = await store.find('audit_events', { action: 'BATCH.PAUSE' });
    assert.equal(pauseAudit.length, 1);
    assert.equal(pauseAudit[0].correlation_id, correlationId);
    assert.equal(pauseAudit[0].authorization_decision, 'ALLOWED');
    assert.equal(JSON.parse(pauseAudit[0].before_json).status, 'QUEUED');
    assert.equal(JSON.parse(pauseAudit[0].after_json).status, 'PAUSED');

    const resumeAudit = await store.find('audit_events', { action: 'BATCH.RESUME' });
    assert.equal(resumeAudit.length, 1);
  } finally {
    await close();
  }
});

test('server mutate: pausing an already-MIGRATED batch is an illegal transition (409)', async () => {
  const { base, close } = await startApp({ batchStatus: 'MIGRATED' });
  try {
    const res = await fetch(`${base}/api/batches/batch-m1/pause`, { method: 'POST', headers: opHeaders(), body: '{}' });
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.error, 'ILLEGAL_TRANSITION');
  } finally {
    await close();
  }
});

test('server mutate: viewer role cannot pause a batch', async () => {
  const { base, seeded, close } = await startApp();
  try {
    const res = await fetch(`${base}/api/batches/${seeded.batch.id}/pause`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKENS.viewer}`, 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(res.status, 403);
  } finally {
    await close();
  }
});
