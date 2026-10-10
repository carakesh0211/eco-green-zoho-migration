import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { openStore } from '../src/adapters/store/memory.js';
import { createAudit } from '../src/core/audit.js';
import { createApp } from '../src/server/app.js';
import { computeLedgerPushSummary } from '../src/core/ledger_summary.js';

const NOW = '2026-10-10T00:00:00.000Z';
const TOKEN = 'tok-ledger-summary-viewer';
const sha = (t) => createHash('sha256').update(t, 'utf8').digest('hex');

/**
 * Run R1 (branch B1) with four vouchers:
 *   V1 MIGRATE      : Dr EXP 100 / Cr BANK 100
 *   V2 MIGRATE      : Dr DEBTORS 40 (party P-ACC, posted to an account) / Cr SALES 40
 *   V3 MIGRATE+POSTED: Dr EXP 10 / Cr BANK 10
 *   V4 BLOCKED UNMAPPED_ENTITY: Dr UNMAPPED 25 / Cr BANK 25
 */
async function seed(store) {
  await store.insert('extraction_runs', {
    id: 'R1', branch_code: 'B1', query_id: 'Q', query_version: 'v1', from_date: '2026-04-01', to_date: '2026-07-05',
    manifest_json: '{}', manifest_sha256: 'm1', status: 'TRANSFORMED', created_at: NOW, updated_at: NOW,
  });
  const file = await store.insert('source_files', {
    run_id: 'R1', file_name: 'transactions.csv', file_role: 'TRANSACTIONS', sha256: 'f1', size_bytes: 1,
    encoding: 'utf-8', delimiter: ',', status: 'ARCHIVED', created_at: NOW, updated_at: NOW,
  });
  const vouchers = [
    ['V1', 'MIGRATE', null, null],
    ['V2', 'MIGRATE', null, null],
    ['V3', 'MIGRATE', null, 'POSTED'],
    ['V4', 'BLOCKED', 'UNMAPPED_ENTITY', null],
  ];
  for (const [id, disposition, reason, migration] of vouchers) {
    await store.insert('vouchers', {
      source_query_id: 'Q', source_query_version: 'v1', extraction_run_id: 'R1', source_file_id: file.id, source_file_hash: 'f1',
      source_record_id: id, branch_code: 'B1', financial_year: '2026-27', period: '2026-04', transaction_date: '2026-04-05',
      source_transaction_type: 'JOURNAL', source_transaction_hash: `h-${id}`, debit_total: '0.00', credit_total: '0.00',
      line_count: 2, is_balanced: 1, disposition, disposition_reason: reason, migration_status: migration ?? 'NOT_QUEUED', created_at: NOW, updated_at: NOW,
    });
  }
  let row = 0;
  const line = (voucher, ledger, debit, credit, party = null) => {
    row += 1;
    return store.insert('source_txn_lines', {
      run_id: 'R1', file_id: file.id, row_number: row, branch_code: 'B1', voucher_id: voucher, voucher_no: voucher,
      voucher_type: 'JOURNAL', voucher_date: '2026-04-05', line_no: row, ledger_code: ledger, ledger_name: `${ledger} name`,
      debit, credit, party_code: party, row_hash: `r${row}`, uk: `${file.id}|${voucher}|${row}`, created_at: NOW,
    });
  };
  await line('V1', 'EXP', '100.00', '0.00');
  await line('V1', 'BANK', '0.00', '100.00');
  await line('V2', 'DEBTORS', '40.00', '0.00', 'P-ACC');
  await line('V2', 'SALES', '0.00', '40.00');
  await line('V3', 'EXP', '10.00', '0.00');
  await line('V3', 'BANK', '0.00', '10.00');
  await line('V4', 'UNMAPPED', '25.00', '0.00');
  await line('V4', 'BANK', '0.00', '25.00');

  const rule = (rule_type, source_key, target_value, meta) => store.insert('mapping_rules', {
    rule_type, source_key, target_value, target_meta: meta ? JSON.stringify(meta) : null, mapping_version: 'v1',
    effective_from: '2026-04-01', status: 'APPROVED', uk: `${rule_type}|${source_key}|v1`, created_at: NOW, updated_at: NOW,
  });
  await rule('LEDGER_ACCOUNT', 'EXP', 'ACC-EXP', { account_name: 'Office Expenses' });
  await rule('LEDGER_ACCOUNT', 'BANK', 'ACC-BANK', { account_name: 'HDFC Bank' });
  await rule('LEDGER_ACCOUNT', 'SALES', 'ACC-SALES', { account_name: 'Sales' });
  await rule('LEDGER_ACCOUNT', 'DEBTORS', 'ACC-DEBT', { account_name: 'Sundry Debtors' });
  await rule('PARTY', 'P-ACC', 'ACC-UPI', { kind: 'account', account_name: 'UPI Collections' });
}

test('computeLedgerPushSummary: per-ledger amounts to push, already posted and held back', async () => {
  const store = await openStore();
  try {
    await seed(store);
    const s = await computeLedgerPushSummary(store, 'R1');
    assert.deepEqual(s.run, { id: 'R1', branch_code: 'B1', status: 'TRANSFORMED', from_date: '2026-04-01', to_date: '2026-07-05' });
    assert.deepEqual(s.totals, {
      push_debit: '140.00', push_credit: '140.00', push_balanced: true, push_vouchers: 2,
      posted_debit: '10.00', posted_credit: '10.00', posted_vouchers: 1,
      held_debit: '25.00', held_credit: '25.00', held_vouchers: 1,
      vouchers: 4, ledgers: 5, ledgers_pushing: 4,
    });
    const by = Object.fromEntries(s.ledgers.map((r) => [r.ledger_code, r]));
    assert.deepEqual(s.ledgers.map((r) => r.ledger_code), ['BANK', 'DEBTORS', 'EXP', 'SALES', 'UNMAPPED']);
    assert.equal(by.EXP.push_debit, '100.00');
    assert.equal(by.EXP.posted_debit, '10.00');
    assert.deepEqual(by.EXP.books_accounts, ['Office Expenses']);
    assert.equal(by.BANK.push_credit, '100.00');
    assert.equal(by.BANK.held_credit, '25.00');
    assert.deepEqual(by.BANK.held_reasons, { UNMAPPED_ENTITY: 1 });
    // the party is posted to an account, which replaces the ledger's own account on that line
    assert.deepEqual(by.DEBTORS.books_accounts, ['UPI Collections']);
    assert.equal(by.DEBTORS.ledger_rule, true);
    assert.equal(by.UNMAPPED.ledger_rule, false);
    assert.deepEqual(by.UNMAPPED.books_accounts, []);
    assert.equal(by.UNMAPPED.push_lines, 0);
    assert.equal(by.UNMAPPED.held_debit, '25.00');
    assert.equal(by.UNMAPPED.ledger_name, 'UNMAPPED name');
  } finally {
    await store.close();
  }
});

test('computeLedgerPushSummary: an unbalanced push is flagged; unknown run is NOT_FOUND', async () => {
  const store = await openStore();
  try {
    await seed(store);
    const [line] = await store.find('source_txn_lines', { voucher_id: 'V1', ledger_code: 'BANK' });
    await store.update('source_txn_lines', line.id, { credit: '99.00' });
    const s = await computeLedgerPushSummary(store, 'R1');
    assert.equal(s.totals.push_balanced, false);
    assert.equal(s.totals.push_credit, '139.00');
    await assert.rejects(() => computeLedgerPushSummary(store, 'nope'), (e) => e.code === 'NOT_FOUND');
  } finally {
    await store.close();
  }
});

test('GET /api/branches/:code/ledger-summary and /api/runs/:id/ledger-summary: scoped, current run', async () => {
  const store = await openStore();
  await seed(store);
  await store.insert('branches', { branch_code: 'B1', branch_name: 'B1', created_at: NOW, updated_at: NOW });
  // a newer duplicate-only re-upload must not replace R1 as the branch's current run
  await store.insert('extraction_runs', {
    id: 'R-dup', branch_code: 'B1', query_id: 'Q', query_version: 'v1', from_date: '2026-04-01', to_date: '2026-07-05',
    manifest_json: '{}', manifest_sha256: 'm2', status: 'VALIDATION_FAILED', error_code: 'DUPLICATE_FILE',
    created_at: '2026-10-11T00:00:00.000Z', updated_at: NOW,
  });
  const app = createApp({
    store, audit: createAudit(store), deps: {},
    users: [{ id: 'u_v', role: 'viewer', branches: ['B1'], token_sha256: sha(TOKEN) }],
  });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const get = (p) => fetch(base + p, { headers: { Authorization: `Bearer ${TOKEN}` } });
  try {
    let res = await get('/branches/B1/ledger-summary');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.run.id, 'R1');
    assert.equal(body.totals.push_debit, '140.00');
    res = await get('/runs/R1/ledger-summary');
    assert.equal(res.status, 200);
    assert.equal((await get('/branches/B2/ledger-summary')).status, 403);
    assert.equal((await get('/runs/nope/ledger-summary')).status, 404);
  } finally {
    await new Promise((r) => server.close(r));
    await store.close();
  }
});
