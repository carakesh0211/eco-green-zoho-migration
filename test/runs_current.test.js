// GET /api/runs flags duplicate-only re-uploads (src/core/runs.js) so the branch workspace
// keeps showing the run that holds the data, and offers "Re-apply mapping" on it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { openStore } from '../src/adapters/store/memory.js';
import { createAudit } from '../src/core/audit.js';
import { createApp } from '../src/server/app.js';
import { currentRun } from '../src/core/runs.js';

const TOKEN = 'tok-runs-current-operator';
const sha = (t) => createHash('sha256').update(t, 'utf8').digest('hex');

async function seed(store) {
  const run = (id, created_at, extra = {}) => store.insert('extraction_runs', {
    id, branch_code: 'B461', query_id: 'Q', query_version: 'v1', from_date: '2026-04-01', to_date: '2026-07-05',
    manifest_json: '{}', manifest_sha256: `msha-${id}`, created_at, updated_at: created_at, ...extra,
  });
  await store.insert('branches', { branch_code: 'B461', branch_name: 'Branch 461', created_at: '2026-10-08T00:00:00.000Z', updated_at: '2026-10-08T00:00:00.000Z' });
  await run('run-held', '2026-10-08T11:31:00.000Z', { status: 'TRANSFORMED' });
  await store.insert('source_files', {
    run_id: 'run-held', file_name: 'transactions.csv', file_role: 'TRANSACTIONS', sha256: 'fsha-1',
    size_bytes: 10, encoding: 'utf-8', delimiter: ',', status: 'ARCHIVED', created_at: '2026-10-08T11:31:00.000Z', updated_at: '2026-10-08T11:31:00.000Z',
  });
  await run('run-reupload', '2026-10-09T07:40:40.000Z', { status: 'VALIDATION_FAILED' });
  await store.insert('exceptions', {
    category: 'DUPLICATE_FILE', severity: 'P2', branch_code: 'B461', run_id: 'run-reupload', financial_impact: '0.00',
    status: 'OPEN', message: 'Duplicate file content', dedupe_key: 'dupfile:run-reupload:transactions.csv:fsha-1',
    created_at: '2026-10-09T07:40:40.000Z', updated_at: '2026-10-09T07:40:40.000Z',
  });
}

test('GET /api/runs marks a duplicate-only re-upload and leaves the run holding the data unmarked', async () => {
  const store = await openStore();
  await seed(store);
  const app = createApp({
    store, audit: createAudit(store), deps: {},
    users: [{ id: 'u_op', role: 'operator', branches: ['B461'], token_sha256: sha(TOKEN) }],
  });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/runs?branch=B461`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(res.status, 200);
    const { runs } = await res.json();
    assert.deepEqual(runs.map((r) => [r.id, r.duplicate_only]), [['run-reupload', true], ['run-held', false]]);
    // The branch workspace's choice (src/server/public/views/branch-workspace.js#fetchLatestRun).
    assert.equal((runs.find((r) => !r.duplicate_only) ?? runs[0]).id, 'run-held');
  } finally {
    await new Promise((r) => server.close(r));
    await store.close();
  }
});

test('currentRun: an ordinary validation failure stays the current run', async () => {
  const store = await openStore();
  await seed(store);
  await store.insert('extraction_runs', {
    id: 'run-bad', branch_code: 'B461', query_id: 'Q', query_version: 'v1', from_date: '2026-04-01', to_date: '2026-07-05',
    manifest_json: '{}', manifest_sha256: 'msha-bad', status: 'VALIDATION_FAILED',
    created_at: '2026-10-10T00:00:00.000Z', updated_at: '2026-10-10T00:00:00.000Z',
  });
  await store.insert('source_files', {
    run_id: 'run-bad', file_name: 'transactions.csv', file_role: 'TRANSACTIONS', sha256: 'fsha-bad',
    size_bytes: 10, encoding: 'utf-8', delimiter: ',', status: 'VALIDATION_FAILED', created_at: '2026-10-10T00:00:00.000Z', updated_at: '2026-10-10T00:00:00.000Z',
  });
  try {
    const runs = await store.find('extraction_runs', { branch_code: 'B461' }, { orderBy: 'created_at DESC' });
    assert.equal((await currentRun(store, runs)).id, 'run-bad');
  } finally {
    await store.close();
  }
});
