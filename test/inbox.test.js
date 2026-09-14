import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openInbox as openLocalInbox } from '../src/adapters/inbox/local.js';
import { openInbox as openDispatchInbox } from '../src/adapters/inbox/index.js';
import { openInbox as openWorkdriveInbox, NotConfiguredError } from '../src/adapters/inbox/workdrive.js';

async function withTempInbox(fn) {
  const root = await mkdtemp(path.join(tmpdir(), 'inbox-test-'));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeManifest(root, branch, run, files) {
  const dir = path.join(root, branch, run);
  await mkdir(dir, { recursive: true });
  const manifest = {
    contract_version: '1.0',
    extraction_run_id: run,
    branch_code: branch,
    files: files.map((f) => ({ file_name: f.name, file_role: f.role ?? 'TRANSACTIONS' })),
  };
  await writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  return dir;
}

test('inbox/local: listRuns returns only complete runs', async () => {
  await withTempInbox(async (root) => {
    // Complete run.
    const completeDir = await writeManifest(root, 'PILOT01', 'run-001', [
      { name: 'transactions.csv' },
      { name: 'trial_balance.csv' },
    ]);
    await writeFile(path.join(completeDir, 'transactions.csv'), 'a,b\n1,2\n');
    await writeFile(path.join(completeDir, 'trial_balance.csv'), 'x,y\n3,4\n');

    // Incomplete run: manifest lists a file that was never written.
    const incompleteDir = await writeManifest(root, 'PILOT01', 'run-002-incomplete', [
      { name: 'transactions.csv' },
      { name: 'trial_balance.csv' },
    ]);
    await writeFile(path.join(incompleteDir, 'transactions.csv'), 'only one file');

    // No manifest at all yet (extractor still writing).
    const noManifestDir = path.join(root, 'PILOT01', 'run-003-no-manifest');
    await mkdir(noManifestDir, { recursive: true });
    await writeFile(path.join(noManifestDir, 'transactions.csv'), 'x');

    const inbox = await openLocalInbox({ root });
    const runs = await inbox.listRuns();
    const runIds = runs.map((r) => r.runId).sort();
    assert.deepEqual(runIds, ['run-001']);

    const run = runs[0];
    assert.equal(run.branchCode, 'PILOT01');
    assert.equal(run.inboxRef, 'PILOT01/run-001');
    const names = run.files.map((f) => f.name).sort();
    assert.deepEqual(names, ['transactions.csv', 'trial_balance.csv'].sort());
    for (const f of run.files) assert.ok(f.size > 0);
  });
});

test('inbox/local: a folder with a .picked-by-* marker is skipped', async () => {
  await withTempInbox(async (root) => {
    const dir = await writeManifest(root, 'PILOT01', 'run-picked', [{ name: 'transactions.csv' }]);
    await writeFile(path.join(dir, 'transactions.csv'), 'data');
    await writeFile(path.join(dir, '.picked-by-worker-1'), '{}');

    const inbox = await openLocalInbox({ root });
    const runs = await inbox.listRuns();
    assert.equal(runs.length, 0);
  });
});

test('inbox/local: readFile returns the exact bytes written', async () => {
  await withTempInbox(async (root) => {
    const dir = await writeManifest(root, 'PILOT01', 'run-read', [{ name: 'transactions.csv' }]);
    await writeFile(path.join(dir, 'transactions.csv'), 'hello,world\n');

    const inbox = await openLocalInbox({ root });
    const buf = await inbox.readFile('PILOT01/run-read', 'transactions.csv');
    assert.equal(buf.toString('utf8'), 'hello,world\n');
  });
});

test('inbox/local: markPicked writes a marker atomically and listRuns then skips it', async () => {
  await withTempInbox(async (root) => {
    const dir = await writeManifest(root, 'PILOT01', 'run-mark', [{ name: 'transactions.csv' }]);
    await writeFile(path.join(dir, 'transactions.csv'), 'data');

    const inbox = await openLocalInbox({ root });
    let runs = await inbox.listRuns();
    assert.equal(runs.length, 1);

    const markerPath = await inbox.markPicked('PILOT01/run-mark', { workerId: 'worker-9' });
    assert.equal(path.basename(markerPath), '.picked-by-worker-9');

    const entries = await readdir(dir);
    assert.ok(entries.includes('.picked-by-worker-9'));
    assert.ok(!entries.some((e) => e.includes('.tmp-')), 'temp file must be renamed away, not left behind');

    runs = await inbox.listRuns();
    assert.equal(runs.length, 0, 'a picked run must no longer be listed');
  });
});

test('inbox/local: missing root directory yields an empty list, not a throw', async () => {
  await withTempInbox(async (root) => {
    const inbox = await openLocalInbox({ root: path.join(root, 'does-not-exist') });
    assert.deepEqual(await inbox.listRuns(), []);
  });
});

test('inbox/index: dispatches to the local adapter by default', async () => {
  await withTempInbox(async (root) => {
    const dir = await writeManifest(root, 'PILOT01', 'run-dispatch', [{ name: 'transactions.csv' }]);
    await writeFile(path.join(dir, 'transactions.csv'), 'data');

    const inbox = await openDispatchInbox({ adapter: 'local', root });
    const runs = await inbox.listRuns();
    assert.equal(runs.length, 1);
  });
});

test('inbox/workdrive: throws NOT_CONFIGURED unless every WORKDRIVE_* env var is set', async () => {
  await assert.rejects(() => openWorkdriveInbox({ env: {} }), NotConfiguredError);

  await assert.rejects(
    () =>
      openWorkdriveInbox({
        env: {
          WORKDRIVE_FOLDER_ID: 'f',
          WORKDRIVE_CLIENT_ID: 'c',
          WORKDRIVE_CLIENT_SECRET: '',
          WORKDRIVE_REFRESH_TOKEN: 'r',
        },
      }),
    NotConfiguredError
  );
});

test('inbox/workdrive: NOT_IMPLEMENTED once configured', async () => {
  const inbox = await openWorkdriveInbox({
    env: {
      WORKDRIVE_FOLDER_ID: 'f',
      WORKDRIVE_CLIENT_ID: 'c',
      WORKDRIVE_CLIENT_SECRET: 's',
      WORKDRIVE_REFRESH_TOKEN: 'r',
    },
  });
  await assert.rejects(() => inbox.listRuns(), { code: 'NOT_IMPLEMENTED' });
  await assert.rejects(() => inbox.readFile('x', 'y'), { code: 'NOT_IMPLEMENTED' });
  await assert.rejects(() => inbox.markPicked('x', { workerId: 'w' }), { code: 'NOT_IMPLEMENTED' });
});
