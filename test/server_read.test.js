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

const TOKENS = { pilot01: 'tok-read-pilot01', pilot02: 'tok-read-pilot02', admin: 'tok-read-admin' };

function users() {
  return [
    { id: 'u_pilot01', role: 'operator', branches: ['PILOT01'], token_sha256: sha(TOKENS.pilot01) },
    { id: 'u_pilot02', role: 'operator', branches: ['PILOT02'], token_sha256: sha(TOKENS.pilot02) },
    { id: 'u_admin', role: 'admin', branches: ['*'], token_sha256: sha(TOKENS.admin) },
  ];
}

async function seed(store) {
  const now = nowIso();

  const run = await store.insert('extraction_runs', {
    id: 'run-001',
    branch_code: 'PILOT01',
    query_id: 'EG_ACCT_VOUCHERS',
    query_version: 'v3',
    from_date: '2026-04-01',
    to_date: '2026-04-30',
    manifest_json: '{}',
    manifest_sha256: 'sha-run-001',
    status: 'CLASSIFIED',
    created_at: now,
    updated_at: now,
  });

  const file = await store.insert('source_files', {
    run_id: run.id,
    file_name: 'txns.csv',
    file_role: 'TRANSACTIONS',
    sha256: 'file-sha-1',
    size_bytes: 1234,
    encoding: 'utf-8',
    delimiter: ',',
    declared_row_count: 1,
    actual_row_count: 1,
    status: 'VALIDATED',
    created_at: now,
    updated_at: now,
  });

  const voucher = await store.insert('vouchers', {
    source_query_id: 'EG_ACCT_VOUCHERS',
    source_query_version: 'v3',
    extraction_run_id: run.id,
    source_file_id: file.id,
    source_file_hash: 'file-sha-1',
    source_record_id: 'V-1001',
    source_document_no: 'DOC-1',
    branch_code: 'PILOT01',
    financial_year: '2026-27',
    period: '2026-04',
    transaction_date: '2026-04-05',
    source_transaction_type: 'PAYMENT',
    source_transaction_hash: 'txn-hash-1001',
    debit_total: '100.00',
    credit_total: '100.00',
    line_count: 2,
    is_balanced: 1,
    disposition: 'MIGRATE',
    target_module: 'bill',
    created_at: now,
    updated_at: now,
  });

  await store.insert('source_txn_lines', {
    run_id: run.id,
    file_id: file.id,
    row_number: 1,
    branch_code: 'PILOT01',
    voucher_id: 'V-1001',
    voucher_no: 'DOC-1',
    voucher_type: 'PAYMENT',
    voucher_date: '2026-04-05',
    line_no: 1,
    ledger_code: 'L100',
    ledger_name: 'Cash',
    debit: '100.00',
    credit: '0.00',
    party_name: 'Acme Traders',
    narration: 'Office rent payment',
    row_hash: 'row-hash-1',
    uk: `${file.id}|V-1001|1`,
    created_at: now,
  });

  await store.insert('overlap_candidates', {
    voucher_id: voucher.id,
    population_key: 'PILOT01|2026-04-05|PAYMENT',
    classification: 'MIGRATE',
    match_strength: 'NONE',
    evidence_json: '{}',
    rule_version: 'cut_v1',
    uk: `${voucher.id}|cut_v1`,
    created_at: now,
  });

  await store.insert('preview_payloads', {
    voucher_id: voucher.id,
    target_module: 'bill',
    payload_json: JSON.stringify({ vendor: 'Acme Traders', amount: '100.00' }),
    payload_hash: 'payload-hash-1',
    human_summary: 'bill V-1001 2026-04-05 ₹100.00 (2 lines)',
    mapping_version: 'map_v1',
    transformation_version: 'tx_v1',
    uk: `${voucher.id}|tx_v1|map_v1`,
    created_at: now,
  });

  await store.insert('exceptions', {
    category: 'SMART_PHARMA_OVERLAP',
    severity: 'P1',
    branch_code: 'PILOT01',
    period: '2026-04',
    run_id: run.id,
    voucher_id: voucher.id,
    financial_impact: '50.00',
    status: 'OPEN',
    message: 'Possible overlap with Smart Pharma posting',
    dedupe_key: 'exc-1',
    created_at: now,
    updated_at: now,
  });

  return { run, file, voucher };
}

async function startApp() {
  const store = await openStore();
  const audit = createAudit(store);
  const seeded = await seed(store);
  const app = createApp({ store, audit, users: users(), deps: {} });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;
  return {
    seeded,
    base: `http://127.0.0.1:${port}`,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      await store.close();
    },
  };
}

function auth(token) {
  return { Authorization: `Bearer ${token}` };
}

test('server read: GET /api/runs lists only the caller branch by default', async () => {
  const { base, close } = await startApp();
  try {
    const res = await fetch(`${base}/api/runs`, { headers: auth(TOKENS.pilot01) });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.runs.length, 1);
    assert.equal(body.runs[0].id, 'run-001');

    const other = await fetch(`${base}/api/runs`, { headers: auth(TOKENS.pilot02) });
    const otherBody = await other.json();
    assert.equal(otherBody.runs.length, 0);
  } finally {
    await close();
  }
});

test('server read: GET /api/runs/:id returns files + voucher counts, 403 outside branch scope', async () => {
  const { base, seeded, close } = await startApp();
  try {
    const res = await fetch(`${base}/api/runs/${seeded.run.id}`, { headers: auth(TOKENS.pilot01) });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.files.length, 1);
    assert.equal(body.files[0].file_name, 'txns.csv');
    assert.equal(body.voucher_total, 1);
    assert.equal(body.voucher_counts.MIGRATE, 1);

    const denied = await fetch(`${base}/api/runs/${seeded.run.id}`, { headers: auth(TOKENS.pilot02) });
    assert.equal(denied.status, 403);
  } finally {
    await close();
  }
});

test('server read: GET /api/vouchers filters by run and disposition', async () => {
  const { base, seeded, close } = await startApp();
  try {
    const res = await fetch(`${base}/api/vouchers?run=${seeded.run.id}&disposition=MIGRATE`, { headers: auth(TOKENS.pilot01) });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.vouchers.length, 1);
    assert.equal(body.vouchers[0].id, seeded.voucher.id);
  } finally {
    await close();
  }
});

test('server read: GET /api/vouchers/:id joins lines, overlap, payloads, audit', async () => {
  const { base, seeded, close } = await startApp();
  try {
    const res = await fetch(`${base}/api/vouchers/${seeded.voucher.id}`, { headers: auth(TOKENS.pilot01) });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.voucher.id, seeded.voucher.id);
    assert.equal(body.lines.length, 1);
    assert.equal(body.lines[0].ledger_code, 'L100');
    assert.equal(body.overlap_candidates.length, 1);
    assert.equal(body.preview_payloads.length, 1);
    assert.equal(body.preview_payloads[0].payload_json.vendor, 'Acme Traders');
    assert.ok(Array.isArray(body.api_attempts));
    assert.ok(Array.isArray(body.audit_events));
  } finally {
    await close();
  }
});

test('server read: GET /api/exceptions scopes by branch', async () => {
  const { base, close } = await startApp();
  try {
    const res = await fetch(`${base}/api/exceptions?branch=PILOT01`, { headers: auth(TOKENS.pilot01) });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.exceptions.length, 1);
    assert.equal(body.exceptions[0].category, 'SMART_PHARMA_OVERLAP');

    const wrongBranch = await fetch(`${base}/api/exceptions?branch=PILOT02`, { headers: auth(TOKENS.pilot01) });
    assert.equal(wrongBranch.status, 403);
  } finally {
    await close();
  }
});

test('server read: GET /api/audit requires admin or operator role', async () => {
  const { base, close } = await startApp();
  try {
    const res = await fetch(`${base}/api/audit`, { headers: auth(TOKENS.admin) });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.audit_events));
  } finally {
    await close();
  }
});

test('server read: GET /api/worker/health degrades gracefully when worker module is absent', async () => {
  const { base, close } = await startApp();
  try {
    const res = await fetch(`${base}/api/worker/health`, { headers: auth(TOKENS.admin) });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, false);
  } finally {
    await close();
  }
});
