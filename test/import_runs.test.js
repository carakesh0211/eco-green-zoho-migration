// POST /api/import/runs — a normalised run uploaded by an operator/admin is ingested,
// reconciled (Layer A), classified and summarised as a detached job. Synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from '../src/adapters/store/memory.js';
import { createAudit } from '../src/core/audit.js';
import { createApp } from '../src/server/app.js';
import { hashToken } from '../src/server/auth.js';
import { decodeFiles } from '../src/server/routes/import_runs.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUN_DIR = path.join(__dirname, '..', 'fixtures', 'synthetic', 'branch-PILOT01', 'run-001');

const USERS = [
  { id: 'op1', role: 'operator', principal_type: 'human', branches: ['PILOT01'], token_sha256: hashToken('t-op1') },
  { id: 'op-other', role: 'operator', principal_type: 'human', branches: ['OTHER'], token_sha256: hashToken('t-other') },
  { id: 'viewer1', role: 'viewer', principal_type: 'human', branches: ['*'], token_sha256: hashToken('t-view') },
  { id: 'admin1', role: 'admin', principal_type: 'human', branches: ['*'], token_sha256: hashToken('t-admin') },
];

function fakeArchive() {
  const puts = [];
  return { puts, async put({ runId, branchCode, fileName }) { puts.push(fileName); return `mem://${branchCode}/${runId}/${fileName}`; } };
}

async function fixtureFiles() {
  const files = {};
  for (const name of ['manifest.json', 'transactions.csv', 'trial_balance.csv']) {
    files[name] = (await readFile(path.join(RUN_DIR, name))).toString('base64');
  }
  return files;
}

async function startApp({ importEnabled = true, environment = 'Development' } = {}) {
  const store = await openStore();
  const audit = createAudit(store);
  const archive = fakeArchive();
  const app = createApp({ store, audit, users: USERS, deps: {}, devDeps: { archive }, environment, importEnabled, devSeedEnabled: false });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (method, p, token, body) => fetch(`${base}${p}`, {
    method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'x-correlation-id': 'test' }, body: body ? JSON.stringify(body) : undefined,
  });
  return { store, archive, base, call, close: async () => { await new Promise((r) => server.close(r)); await store.close(); } };
}

async function waitForJob(call, jobId, token) {
  for (let i = 0; i < 200; i += 1) {
    const r = await call('GET', `/api/import/runs/${jobId}`, token);
    const job = await r.json();
    if (job.stage === 'DONE') return job;
    await new Promise((res) => setTimeout(res, 25));
  }
  throw new Error('job did not finish');
}

test('decodeFiles: validates names, base64 content, required files and the size cap', () => {
  assert.equal(decodeFiles(null).error, 'files must be an object of file_name -> base64');
  assert.match(decodeFiles({ '../x': 'AA==' }).error, /invalid file name/);
  assert.match(decodeFiles({ 'manifest.json': 42 }).error, /base64 string/);
  assert.match(decodeFiles({ 'manifest.json': '' }).error, /empty/);
  assert.match(decodeFiles({ 'manifest.json': 'AA==' }).error, /transactions.csv is required/);
  const ok = decodeFiles({ 'manifest.json': 'AA==', 'transactions.csv': 'AA==', 'trial_balance.csv': 'AA==' });
  assert.equal(ok.totalBytes, 3);
  assert.ok(Buffer.isBuffer(ok.files['manifest.json']));
  // gzip-compressed content is unpacked transparently
  const gz = gzipSync(Buffer.from('a,b\n1,2\n')).toString('base64');
  const unpacked = decodeFiles({ 'manifest.json': gz, 'transactions.csv': gz, 'trial_balance.csv': 'AA==' });
  assert.equal(unpacked.files['transactions.csv'].toString('utf8'), 'a,b\n1,2\n');
  assert.equal(unpacked.totalBytes, 8 + 8 + 1);
  const badGz = Buffer.concat([Buffer.from([0x1f, 0x8b]), Buffer.from('nope')]).toString('base64');
  assert.match(decodeFiles({ 'manifest.json': badGz, 'transactions.csv': 'AA==', 'trial_balance.csv': 'AA==' }).error, /gzip/);
});

test('an operator in scope imports the synthetic PILOT01 run: branch + run + Layer A + summary land', async () => {
  const t = await startApp();
  try {
    const files = await fixtureFiles();
    const res = await t.call('POST', '/api/import/runs', 't-op1', {
      branch: { branch_code: 'PILOT01', branch_name: 'Pilot branch', zoho_location_id: 'LOC-PILOT01' },
      cutover: { zoho_location_id: 'LOC-PILOT01', migration_from_date: '2026-04-01', live_system_start_date: '2026-06-06', historical_migration_end_date: '2026-06-05', transaction_class: '*', payment_method: '*', smart_pharma_coverage_status: 'NOT_COVERED', cutover_rule_version: 'cut_v1', approval_status: 'DRAFT', approved_by: null },
      files,
    });
    assert.equal(res.status, 202);
    const { jobId, runId } = await res.json();
    assert.equal(runId, 'PILOT01-2026-04-run-001');
    const job = await waitForJob(t.call, jobId, 't-op1');
    assert.equal(job.failedStage, null, job.error ?? '');
    assert.equal(job.outcome, 'IMPORTED');
    assert.equal(job.ingest.outcome, 'STAGED');
    // the synthetic fixture is deliberately unbalanced, so Layer A must FAIL and classification is skipped
    assert.equal(job.layerA.status, 'FAIL');
    assert.equal(job.classification.skipped, true);
    assert.ok(job.requestedBy === undefined || job.requestedBy === 'op1');

    const branch = await t.store.findOne('branches', { branch_code: 'PILOT01' });
    assert.equal(branch.zoho_location_id, 'LOC-PILOT01');
    const run = await t.store.get('extraction_runs', runId);
    assert.equal(run.status, 'SOURCE_RECON_FAILED');
    const summary = await t.store.findOne('branch_summaries', { branch_code: 'PILOT01' });
    assert.equal(summary.layer_a_status, 'FAIL');
    assert.deepEqual([...new Set(t.archive.puts)].sort(), ['manifest.json', 'transactions.csv', 'trial_balance.csv']);
    const cut = await t.store.findOne('cutover_matrix', { branch_code: 'PILOT01' });
    assert.equal(cut.approval_status, 'DRAFT');
    const audit = (await t.store.find('audit_events', { action: 'IMPORT.RUN' }));
    assert.equal(audit.length, 1);

    // a second upload of the same manifest is reported as DUPLICATE, not re-ingested
    const again = await t.call('POST', '/api/import/runs', 't-op1', { branch: { branch_code: 'PILOT01' }, files });
    const job2 = await waitForJob(t.call, (await again.json()).jobId, 't-op1');
    assert.equal(job2.outcome, 'DUPLICATE');
  } finally {
    await t.close();
  }
});

test('gates: disabled flag, Production, viewer role, branch scope, bad manifest, APPROVED cutover by non-admin', async () => {
  const files = await fixtureFiles();
  const body = { branch: { branch_code: 'PILOT01' }, files };

  let t = await startApp({ importEnabled: false });
  try {
    assert.equal((await t.call('POST', '/api/import/runs', 't-admin', body)).status, 403);
  } finally { await t.close(); }

  t = await startApp({ environment: 'Production' });
  try {
    assert.equal((await t.call('POST', '/api/import/runs', 't-admin', body)).status, 403);
  } finally { await t.close(); }

  t = await startApp();
  try {
    assert.equal((await t.call('POST', '/api/import/runs', 't-view', body)).status, 403, 'viewer cannot import');
    assert.equal((await t.call('POST', '/api/import/runs', 't-other', body)).status, 403, 'out-of-scope operator');
    assert.equal((await t.call('POST', '/api/import/runs', 't-op1', { branch: { branch_code: 'PILOT01' }, files: { ...files, 'manifest.json': Buffer.from('{bad').toString('base64') } })).status, 400);
    assert.equal((await t.call('POST', '/api/import/runs', 't-op1', { branch: { branch_code: 'OTHERCODE' }, files })).status, 403, 'manifest/branch mismatch is caught after scope check');
    const mismatch = await t.call('POST', '/api/import/runs', 't-admin', { branch: { branch_code: 'OTHERCODE' }, files });
    assert.equal(mismatch.status, 400);
    const approvedByOp = await t.call('POST', '/api/import/runs', 't-op1', { ...body, cutover: { approval_status: 'APPROVED', cutover_rule_version: 'cut_v1' } });
    assert.equal(approvedByOp.status, 403);
    assert.equal((await t.call('GET', '/api/import/runs/nope', 't-op1')).status, 404);
  } finally { await t.close(); }
});
