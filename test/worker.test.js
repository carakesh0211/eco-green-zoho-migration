import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/adapters/store/memory.js';
import { createAudit } from '../src/core/audit.js';
import { sha256Bytes } from '../src/core/hash.js';
import { createBooksClient } from '../src/books/index.js';
import { runOnce, health } from '../src/worker/index.js';

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

function txBuf() {
  return csv(TX_HEADER, [
    ['PILOT01', 'V-1', '', 'JOURNAL', '2026-04-05', '1', 'LEDG-A', 'LedgerA', '100.00', '0.00', '', '', '', '', '', '', '', ''],
    ['PILOT01', 'V-1', '', 'JOURNAL', '2026-04-05', '2', 'LEDG-B', 'LedgerB', '0.00', '100.00', '', '', '', '', '', '', '', ''],
    ['PILOT01', 'V-2', '', 'PURCHASE', '2026-04-06', '1', 'LEDG-A', 'LedgerA', '50.00', '0.00', 'V-PARTY-1', 'Vendor1', '', '', '', '', '', ''],
    ['PILOT01', 'V-2', '', 'PURCHASE', '2026-04-06', '2', 'LEDG-C', 'LedgerC', '0.00', '50.00', 'V-PARTY-1', 'Vendor1', '', '', '', '', '', ''],
  ]);
}

function tbBuf() {
  return csv(TB_HEADER, [
    ['PILOT01', 'LEDG-A', 'LedgerA', '0.00', '0.00', '150.00', '0.00', '150.00', '0.00', '2'],
    ['PILOT01', 'LEDG-B', 'LedgerB', '0.00', '0.00', '0.00', '100.00', '0.00', '100.00', '1'],
    ['PILOT01', 'LEDG-C', 'LedgerC', '0.00', '0.00', '0.00', '50.00', '0.00', '50.00', '1'],
  ]);
}

function buildManifest({ runId, tx, tb }) {
  return {
    contract_version: '1.0', extraction_run_id: runId, source_system: 'ECO_GREEN', query_id: 'EG_ACCT_VOUCHERS',
    query_name: 'test', query_version: 'v1', sql_hash: 'sha256:test', branch_code: 'PILOT01',
    from_date: '2026-04-01', to_date: '2026-04-30', currency: 'INR', extracted_at: '2026-04-01T00:00:00+05:30',
    source_operator_or_job: 'test-job',
    files: [
      { file_name: 'transactions.csv', file_role: 'TRANSACTIONS', sha256: sha256Bytes(tx), row_count: 4, debit_total: '150.00', credit_total: '150.00', encoding: 'utf-8', delimiter: ',' },
      { file_name: 'trial_balance.csv', file_role: 'TRIAL_BALANCE', sha256: sha256Bytes(tb), row_count: 3, debit_total: '150.00', credit_total: '150.00', encoding: 'utf-8', delimiter: ',' },
    ],
  };
}

function makeInbox() {
  const runs = new Map(); // inboxRef -> { files, picked }
  return {
    addRun(inboxRef, files) { runs.set(inboxRef, { files, picked: false }); },
    async listRuns() {
      const out = [];
      for (const [inboxRef, run] of runs.entries()) {
        if (run.picked) continue;
        const [branchCode, runId] = inboxRef.split('/');
        out.push({ inboxRef, branchCode, runId, files: Object.keys(run.files).map((name) => ({ name, size: run.files[name].length })) });
      }
      return out;
    },
    async readFile(inboxRef, fileName) {
      const run = runs.get(inboxRef);
      if (!run || !run.files[fileName]) throw new Error(`missing ${inboxRef}/${fileName}`);
      return run.files[fileName];
    },
    async markPicked(inboxRef) {
      const run = runs.get(inboxRef);
      if (run) run.picked = true;
    },
  };
}

function makeArchive() {
  const bytesByUri = new Map();
  return {
    async put({ runId, branchCode, fileName, bytes, sha256 }) {
      const sha = sha256 ?? sha256Bytes(bytes);
      const uri = `local://${branchCode}/${runId}/${sha}/${fileName}`;
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
  return { store, audit, ctx: { store, audit, correlationId: 'corr-worker', actor: 'worker-test', actorRole: 'operator' } };
}

test('worker.runOnce: ingests a complete inbox run and drives it through the pipeline to TRANSFORMED', async () => {
  const { store, ctx } = await makeCtx();
  try {
    const tx = txBuf();
    const tb = tbBuf();
    const manifest = buildManifest({ runId: 'RUN-WORKER-1', tx, tb });
    const inboxRef = 'PILOT01/RUN-WORKER-1';
    const inbox = makeInbox();
    inbox.addRun(inboxRef, { 'manifest.json': Buffer.from(JSON.stringify(manifest)), 'transactions.csv': tx, 'trial_balance.csv': tb });
    const archive = makeArchive();
    const client = createBooksClient({ driver: 'mock', config: {} });

    const deps = { inbox, archive, client, workerId: 'worker-1' };
    const first = await runOnce(ctx, deps);

    assert.equal(first.counts.ingested, 1);
    assert.equal(first.counts.ingestErrors, 0);
    assert.equal(first.counts.runErrors, 0);

    const run = await store.get('extraction_runs', 'RUN-WORKER-1');
    assert.equal(run.status, 'TRANSFORMED');

    const reconA = await store.find('recon_runs', { run_id: 'RUN-WORKER-1', layer: 'A' });
    assert.equal(reconA.length, 1);
    assert.equal(reconA[0].status, 'PASS');

    const reconB = await store.find('recon_runs', { run_id: 'RUN-WORKER-1', layer: 'B' });
    assert.equal(reconB.length, 1);
    assert.equal(reconB[0].status, 'PASS');

    const h = health();
    assert.equal(h.workerId, 'worker-1');
    assert.equal(h.lastOutcome, 'OK');

    // ---- second pass: nothing new in the inbox, run already TRANSFORMED ----
    const second = await runOnce(ctx, deps);
    assert.equal(second.counts.ingested, 0, 'the inbox folder was marked picked; it must not be re-ingested');
    assert.equal(second.counts.ingestErrors, 0);
    assert.equal(second.counts.runErrors, 0);

    const runAfter = await store.get('extraction_runs', 'RUN-WORKER-1');
    assert.equal(runAfter.status, 'TRANSFORMED');

    const reconAAfter = await store.find('recon_runs', { run_id: 'RUN-WORKER-1', layer: 'A' });
    assert.equal(reconAAfter.length, 1, 'Layer A must not be re-run once the run has moved past SUMMARISED');

    const reconBAfter = await store.find('recon_runs', { run_id: 'RUN-WORKER-1', layer: 'B' });
    assert.equal(reconBAfter.length, 1, 'Layer B must not be re-run once it has already run for this run');
  } finally {
    await store.close();
  }
});
