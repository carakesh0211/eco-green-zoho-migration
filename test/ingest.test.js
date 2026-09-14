import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/adapters/store/memory.js';
import { createAudit } from '../src/core/audit.js';
import { sha256Bytes } from '../src/core/hash.js';
import { ingestRun } from '../src/core/ingest.js';

const TX_HEADER = [
  'branch_code', 'voucher_id', 'voucher_no', 'voucher_type', 'voucher_date', 'line_no',
  'ledger_code', 'ledger_name', 'debit', 'credit', 'party_code', 'party_name',
  'payment_method', 'tax_bucket', 'narration', 'reference_no', 'created_at', 'modified_at',
];
const TB_HEADER = [
  'branch_code', 'ledger_code', 'ledger_name', 'opening_debit', 'opening_credit',
  'period_debit', 'period_credit', 'closing_debit', 'closing_credit', 'txn_count',
];

function csv(header, rows) {
  return Buffer.from([header, ...rows].map((r) => r.join(',')).join('\r\n') + '\r\n', 'utf8');
}

function twoBalancedVouchers() {
  return csv(TX_HEADER, [
    ['PILOT01', 'V-1', '', 'JOURNAL', '2026-04-05', '1', 'LEDG-A', 'LedgerA', '100.00', '0.00', '', '', '', '', '', '', '', ''],
    ['PILOT01', 'V-1', '', 'JOURNAL', '2026-04-05', '2', 'LEDG-B', 'LedgerB', '0.00', '100.00', '', '', '', '', '', '', '', ''],
    ['PILOT01', 'V-2', '', 'PURCHASE', '2026-04-06', '1', 'LEDG-A', 'LedgerA', '50.00', '0.00', 'V-PARTY-1', 'Vendor1', '', '', '', '', '', ''],
    ['PILOT01', 'V-2', '', 'PURCHASE', '2026-04-06', '2', 'LEDG-C', 'LedgerC', '0.00', '50.00', 'V-PARTY-1', 'Vendor1', '', '', '', '', '', ''],
  ]);
}

function matchingTb() {
  return csv(TB_HEADER, [
    ['PILOT01', 'LEDG-A', 'LedgerA', '0.00', '0.00', '150.00', '0.00', '150.00', '0.00', '2'],
    ['PILOT01', 'LEDG-B', 'LedgerB', '0.00', '0.00', '0.00', '100.00', '0.00', '100.00', '1'],
    ['PILOT01', 'LEDG-C', 'LedgerC', '0.00', '0.00', '0.00', '50.00', '0.00', '50.00', '1'],
  ]);
}

function buildManifest({ runId, txBuf, tbBuf }) {
  return {
    contract_version: '1.0',
    extraction_run_id: runId,
    source_system: 'ECO_GREEN',
    query_id: 'EG_ACCT_VOUCHERS',
    query_name: 'test query',
    query_version: 'v1',
    sql_hash: 'sha256:test',
    branch_code: 'PILOT01',
    from_date: '2026-04-01',
    to_date: '2026-04-30',
    currency: 'INR',
    extracted_at: '2026-04-01T00:00:00+05:30',
    source_operator_or_job: 'test-job',
    files: [
      {
        file_name: 'transactions.csv', file_role: 'TRANSACTIONS', sha256: sha256Bytes(txBuf),
        row_count: 4, debit_total: '150.00', credit_total: '150.00', encoding: 'utf-8', delimiter: ',',
      },
      {
        file_name: 'trial_balance.csv', file_role: 'TRIAL_BALANCE', sha256: sha256Bytes(tbBuf),
        row_count: 3, debit_total: '150.00', credit_total: '150.00', encoding: 'utf-8', delimiter: ',',
      },
    ],
  };
}

function makeInbox(filesByRef) {
  return {
    async readFile(inboxRef, fileName) {
      const buf = filesByRef[inboxRef]?.[fileName];
      if (!buf) throw new Error(`no such file: ${inboxRef}/${fileName}`);
      return buf;
    },
    async markPicked() {},
    async listRuns() { return []; },
  };
}

function makeArchive() {
  const bytesByUri = new Map();
  return {
    async put({ runId, branchCode, fileName, bytes, sha256 }) {
      const sha = sha256 ?? sha256Bytes(bytes);
      const uri = `local://${branchCode}/${runId}/${sha}/${fileName}`;
      const existing = bytesByUri.get(uri);
      if (existing && !existing.equals(bytes)) {
        const e = new Error('IMMUTABLE_CONFLICT'); e.code = 'IMMUTABLE_CONFLICT'; throw e;
      }
      bytesByUri.set(uri, bytes);
      return uri;
    },
    async exists(uri) { return bytesByUri.has(uri); },
    async get(uri) { return bytesByUri.get(uri); },
  };
}

async function makeCtx() {
  const store = await openStore();
  const audit = createAudit(store);
  return { store, audit, ctx: { store, audit, correlationId: 'corr-ingest', actor: 'tester', actorRole: 'operator' } };
}

function runOf(manifest, txBuf, tbBuf) {
  const inboxRef = `PILOT01/${manifest.extraction_run_id}`;
  return { inboxRef, files: { [inboxRef]: { 'manifest.json': Buffer.from(JSON.stringify(manifest)), 'transactions.csv': txBuf, 'trial_balance.csv': tbBuf } } };
}

test('ingest: happy path stages a run and builds two balanced PENDING vouchers', async () => {
  const { store, ctx } = await makeCtx();
  try {
    const txBuf = twoBalancedVouchers();
    const tbBuf = matchingTb();
    const manifest = buildManifest({ runId: 'RUN-HAPPY-1', txBuf, tbBuf });
    const { inboxRef, files } = runOf(manifest, txBuf, tbBuf);
    const inbox = makeInbox(files);
    const archive = makeArchive();

    const result = await ingestRun(ctx, { inbox, archive, inboxRef, workerId: 'worker-1' });

    assert.equal(result.outcome, 'STAGED');
    assert.equal(result.counts.txnRowsLoaded, 4);
    assert.equal(result.counts.txnRowsSkipped, 0);
    assert.equal(result.counts.vouchersBuilt, 2);
    assert.equal(result.counts.vouchersBlocked, 0);

    const run = await store.get('extraction_runs', 'RUN-HAPPY-1');
    assert.equal(run.status, 'STAGED');
    assert.equal(run.claimed_by, null);

    const vouchers = await store.find('vouchers', { extraction_run_id: 'RUN-HAPPY-1' });
    assert.equal(vouchers.length, 2);
    for (const v of vouchers) {
      assert.equal(v.disposition, 'PENDING');
      assert.equal(v.is_balanced, 1);
    }
  } finally {
    await store.close();
  }
});

test('ingest: duplicate manifest sha256 is rejected without an exception row', async () => {
  const { store, ctx } = await makeCtx();
  try {
    const txBuf = twoBalancedVouchers();
    const tbBuf = matchingTb();
    const manifest = buildManifest({ runId: 'RUN-DUPMAN-1', txBuf, tbBuf });
    const { inboxRef, files } = runOf(manifest, txBuf, tbBuf);
    const inbox = makeInbox(files);
    const archive = makeArchive();

    const first = await ingestRun(ctx, { inbox, archive, inboxRef, workerId: 'worker-1' });
    assert.equal(first.outcome, 'STAGED');

    const second = await ingestRun(ctx, { inbox, archive, inboxRef, workerId: 'worker-1' });
    assert.equal(second.outcome, 'DUPLICATE_MANIFEST');

    const runCount = await store.count('extraction_runs', {});
    assert.equal(runCount, 1);
    const exceptionCount = await store.count('exceptions', {});
    assert.equal(exceptionCount, 0);
  } finally {
    await store.close();
  }
});

test('ingest: a second run whose transactions.csv shares the same sha256 is quarantined (DUPLICATE_FILE)', async () => {
  const { store, ctx } = await makeCtx();
  try {
    const sharedTxBuf = twoBalancedVouchers();
    const tbBuf1 = matchingTb();
    const manifest1 = buildManifest({ runId: 'RUN-A', txBuf: sharedTxBuf, tbBuf: tbBuf1 });
    const run1 = runOf(manifest1, sharedTxBuf, tbBuf1);
    const inbox1 = makeInbox(run1.files);
    const archive = makeArchive();

    const first = await ingestRun(ctx, { inbox: inbox1, archive, inboxRef: run1.inboxRef, workerId: 'worker-1' });
    assert.equal(first.outcome, 'STAGED');

    // Second run: different id/manifest, but byte-identical transactions.csv -> same sha256.
    // Give it a distinct trial_balance.csv so only the transactions file collides.
    const tbBuf2 = csv(TB_HEADER, [
      ['PILOT01', 'LEDG-A', 'LedgerA', '0.00', '0.00', '150.00', '0.00', '150.00', '0.00', '2'],
      ['PILOT01', 'LEDG-B', 'LedgerB', '0.00', '0.00', '0.00', '100.00', '0.00', '100.00', '1'],
      ['PILOT01', 'LEDG-C', 'LedgerC', '0.00', '0.00', '0.00', '50.00', '0.00', '50.00', '1'],
      ['PILOT01', 'LEDG-D', 'LedgerD', '0.00', '0.00', '0.00', '0.00', '0.00', '0.00', '0'],
    ]);
    const manifest2 = buildManifest({ runId: 'RUN-B-DUP', txBuf: sharedTxBuf, tbBuf: tbBuf2 });
    manifest2.files[1].row_count = 4;
    const run2 = runOf(manifest2, sharedTxBuf, tbBuf2);
    const inbox2 = makeInbox(run2.files);

    const second = await ingestRun(ctx, { inbox: inbox2, archive, inboxRef: run2.inboxRef, workerId: 'worker-1' });
    assert.equal(second.outcome, 'VALIDATION_FAILED');

    const run2Row = await store.get('extraction_runs', 'RUN-B-DUP');
    assert.equal(run2Row.status, 'VALIDATION_FAILED');
    assert.equal(run2Row.claimed_by, null);

    const dupExceptions = await store.find('exceptions', { category: 'DUPLICATE_FILE' });
    assert.equal(dupExceptions.length, 1);
    assert.equal(dupExceptions[0].run_id, 'RUN-B-DUP');
  } finally {
    await store.close();
  }
});

test('ingest: a lost claim race returns CLAIM_LOST and leaves the run claimed by the winner', async () => {
  const { store, ctx } = await makeCtx();
  try {
    const txBuf = twoBalancedVouchers();
    const tbBuf = matchingTb();
    const manifest = buildManifest({ runId: 'RUN-RACE-1', txBuf, tbBuf });
    const { inboxRef, files } = runOf(manifest, txBuf, tbBuf);
    const inbox = makeInbox(files);
    const archive = makeArchive();

    // Wrap store.claim so the FIRST invocation (ingestRun's own step-2 claim) is preceded
    // by a competing claim from a different worker, deterministically simulating the race
    // where another worker wins the claim first.
    let claimCalls = 0;
    const racingStore = new Proxy(store, {
      get(target, prop, receiver) {
        if (prop === 'claim') {
          return async (table, id, opts) => {
            claimCalls += 1;
            if (claimCalls === 1) {
              await target.claim(table, id, { ...opts, workerId: 'competitor-worker' });
            }
            return target.claim(table, id, opts);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const racingCtx = { ...ctx, store: racingStore };

    const result = await ingestRun(racingCtx, { inbox, archive, inboxRef, workerId: 'worker-1' });
    assert.equal(result.outcome, 'CLAIM_LOST');

    const run = await store.get('extraction_runs', 'RUN-RACE-1');
    assert.equal(run.status, 'CLAIMED');
    assert.equal(run.claimed_by, 'competitor-worker');
  } finally {
    await store.close();
  }
});
