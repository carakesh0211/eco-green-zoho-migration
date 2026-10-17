// WorkDrive branch inbox on the service: the hosted job (files kept in a blob store, plans run in
// a temporary folder) and GET/POST /api/workdrive/sync. Synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildXlsx } from './helpers/xlsx_builder.js';
import { runSync } from '../src/workdrive/job.js';
import { createWorkdriveService } from '../src/server/workdrive_service.js';
import { openStore } from '../src/adapters/store/memory.js';
import { createAudit } from '../src/core/audit.js';
import { createApp } from '../src/server/app.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const USERS = JSON.parse(readFileSync(path.join(ROOT, 'config', 'users.example.json'), 'utf8'));

const HDR = ['c_br_code', 'c_year', 'c_prefix', 'n_tran_no', 'c_act_code', 'd_date', 'n_amount', 'c_opp_act_code', 'c_ref_br_code', 'n_pk', 'c_name', 'n_type', 'c_grp_no', 'c_remarks', 'cust_pay_ref_no', 'supp_pay_ref_no', 'To be pushed by'];
const ledger = buildXlsx([{ name: 'ledger', rows: [HDR,
  [461, 26, 'J', 1, "'IE223", '01/05/26', 100, '', 461, 1, 'SALES PROMOTION', 6, 4001000000, 'promo', null, null, 'ZOHO'],
  [461, 26, 'J', 1, "'000903", '01/05/26', -100, '', 461, 1, 'INDUSIND BANK', 1, 1002003003, 'promo', null, null, 'ZOHO'],
] }]);
const closingTb = buildXlsx([{ name: 'tb', rows: [['Trial Balance'],
  ['Act Code', 'Description', 'Op.Debit', 'Op.Credit', 'Tran. Debit', 'Tran. Credit', 'Cl.Debit', 'Cl.Credit'],
  ['IE223', 'Sales Promotion', 0, 0, 100, 0, 100, null], ['000903', 'Indusind Bank', 0, 0, 0, 100, null, 100],
] }]);

function memoryBlobs() {
  const m = new Map();
  return { kind: 'memory', m, async get(k) { return m.get(k) ?? null; }, async put(k, b) { m.set(k, Buffer.from(b)); } };
}

function fakeWd() {
  const uploads = [];
  const file = (id, name, bytes) => ({ id, name, isFolder: false, modified: 1, size: bytes.length, bytes });
  const tree = {
    ROOT: [{ id: 'TRI', name: 'tripura', isFolder: true }],
    TRI: [{ id: 'B461', name: '461', isFolder: true }],
    B461: [file('L', 'Ledger_01042026_to_05072026 V2.xlsx', ledger), file('T', 'Closing_tb_report_05072026.xlsx', closingTb)],
    CFG: [file('M', 'accounts_master.csv', Buffer.from('account,eco_code,name,lines,zoho_code\nIE223,IE223,SALES PROMOTION,,IE140\n903,903,INDUSIND BANK,,AL0054\n'))],
  };
  const all = Object.values(tree).flat();
  return {
    uploads,
    async list(id) { return tree[id] ?? []; },
    async download(f) { return all.find((x) => x.id === f.id).bytes; },
    async upload(folderId, name, content) { uploads.push({ folderId, name, content: String(content) }); },
  };
}

test('runSync (hosted): files kept in the blob store, branch planned in a temporary folder, report + tracker uploaded', async () => {
  const wd = fakeWd();
  const blobs = memoryBlobs();
  const s = await runSync({ wd, blobs, rootFolderId: 'ROOT', configFolderId: 'CFG' });
  assert.deepEqual(s.planned, ['461']);
  assert.ok(blobs.m.has('var/raw461/txn/ledger_v2.xlsx'));
  const row = s.tracker[0];
  assert.deepEqual([row.region, row.branch, row.status, row.our_vouchers], ['tripura', '461', 'WAITING FOR OPENING', 1]);
  assert.deepEqual(wd.uploads.map((u) => [u.folderId, u.name]), [['B461', 'Migration Report 461.md'], ['ROOT', 'Migration Tracker.csv']]);
  assert.match(wd.uploads[0].content, /OK {2}ledger ties to the Eco Green closing TB movement: 2 TB codes/);

  const again = await runSync({ wd, blobs, rootFolderId: 'ROOT', configFolderId: 'CFG' });
  assert.deepEqual([again.pulled, again.planned, again.tracker[0].status], [[], [], 'WAITING FOR OPENING'], 'state kept in the blob store');
});

test('/api/workdrive/sync: Hermes (bot) and operators start a sync; viewers only read', async () => {
  const store = await openStore();
  const audit = createAudit(store);
  const wd = fakeWd();
  const service = createWorkdriveService({ env: {}, deps: { wd, blobs: memoryBlobs(), rootFolderId: 'ROOT' } });
  const app = createApp({ store, audit, users: USERS, workdriveService: service });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (token, method) => fetch(`${base}/api/workdrive/sync`, { method, headers: { Authorization: `Bearer ${token}` } });
  try {
    assert.equal((await call('dev-token-viewer', 'POST')).status, 403);
    const started = await call('dev-token-bot', 'POST');
    assert.equal(started.status, 202);
    const { job } = await started.json();
    assert.equal(job.trigger, 'agent');
    for (let i = 0; i < 200; i += 1) {
      const st = await (await call('dev-token-viewer', 'GET')).json();
      if (st.last) { assert.equal(st.last.stage, 'DONE', JSON.stringify(st.last)); assert.equal(st.last.summary.tracker[0].branch, '461'); break; }
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(wd.uploads.some((u) => u.name === 'Migration Tracker.csv'));
  } finally {
    await new Promise((r) => server.close(r));
    await store.close();
  }
});

test('hosted service: a scheduled run waits for a request context, then runs inside the captured app', async () => {
  const entered = [];
  const runtime = {
    currentApp: async () => ({ id: 'request-app' }),
    runWithApp: (app, fn) => { entered.push(app.id); return fn(); },
  };
  const wd = fakeWd();
  const service = createWorkdriveService({ env: {}, runtime, deps: { wd, blobs: memoryBlobs(), rootFolderId: 'ROOT' } });
  assert.equal(service.start('schedule').error, 'NO_APP_CONTEXT', 'no request seen yet');
  await service.capture();
  const { job } = service.start('schedule');
  await job.done;
  assert.equal(job.stage, 'DONE', job.error);
  assert.deepEqual(entered, ['request-app']);
});

test('runSync: a new app version prepares every pulled branch again, once', async () => {
  const wd = fakeWd();
  const blobs = memoryBlobs();
  assert.deepEqual((await runSync({ wd, blobs, rootFolderId: 'ROOT', configFolderId: 'CFG', planVersion: 'v1' })).planned, ['461']);
  assert.deepEqual((await runSync({ wd, blobs, rootFolderId: 'ROOT', configFolderId: 'CFG', planVersion: 'v1' })).planned, [], 'same version, no changes');
  assert.deepEqual((await runSync({ wd, blobs, rootFolderId: 'ROOT', configFolderId: 'CFG', planVersion: 'v2' })).planned, ['461'], 'new version');
  assert.deepEqual((await runSync({ wd, blobs, rootFolderId: 'ROOT', configFolderId: 'CFG', planVersion: 'v2' })).planned, []);
});

test('runSync: branches listed in branch_exclusions.csv are not pulled or prepared, and show as EXCLUDED', async () => {
  const wd = fakeWd();
  const cfg = await wd.list('CFG');
  cfg.push({ id: 'X', name: 'branch_exclusions.csv', isFolder: false, modified: 1, size: 1, bytes: Buffer.from('branch,reason\n461,closed branch\n') });
  const download = wd.download.bind(wd);
  wd.download = async (f) => (f.id === 'X' ? Buffer.from('branch,reason\n461,closed branch\n') : download(f));
  const blobs = memoryBlobs();
  const s = await runSync({ wd, blobs, rootFolderId: 'ROOT', configFolderId: 'CFG' });
  assert.deepEqual([s.pulled, s.planned], [[], []]);
  assert.deepEqual([s.tracker[0].status, s.tracker[0].problems], ['EXCLUDED', 'closed branch']);
});

test('publishToDashboard: WorkDrive branches appear on the dashboard with their WorkDrive status', async () => {
  const { publishToDashboard } = await import('../src/workdrive/publish.js');
  const store = await openStore();
  try {
    const row = (branch, status, missing, ours, problems = '') => ({ region: 'tripura', branch, status, missing_files: missing, our_vouchers: ours, problems });
    await publishToDashboard(store, [
      row('461', 'WAITING FOR OPENING', 'openingItems', 589),
      row('463', 'FIX', 'openingItems', 491, 'ledger ties to the Eco Green closing TB movement: 2 of 65 TB codes differ'),
      row('464', 'WAITING FOR FILES', 'ledger; openingItems', ''),
      row('469', 'EXCLUDED', '', ''),
    ]);
    const b = await store.get('branches', '461');
    assert.equal(b.branch_name, 'Tripura 461');
    const pick = async (c) => { const s = await store.get('branch_summaries', c); return [s.receipt_status, s.layer_a_status, s.total_count, s.readiness_status]; };
    assert.deepEqual(await pick('461'), ['RECEIVED', 'PASS', 589, 'IN_PROGRESS']);
    assert.deepEqual(await pick('463'), ['RECEIVED', 'FAIL', 491, 'BLOCKED']);
    assert.deepEqual(await pick('464'), ['PARTIAL', 'NOT_RUN', 0, 'NOT_STARTED']);
    assert.deepEqual(await pick('469'), ['NOT_RECEIVED', 'NOT_RUN', 0, 'NOT_STARTED']);
    await publishToDashboard(store, [row('461', 'WAITING FOR OPENING', 'openingItems', 600)]);
    assert.deepEqual(await pick('461'), ['RECEIVED', 'PASS', 600, 'IN_PROGRESS'], 'updated, not duplicated');
  } finally {
    await store.close();
  }
});

test('runSync: each branch is planned on its own window (Tripura to 05-07-2026, Bengaluru to 05-08-2026)', async () => {
  const blr = buildXlsx([{ name: 'ledger', rows: [HDR,
    [302, 26, 'J', 1, "'IE223", '20/07/26', 100, '', 302, 1, 'SALES PROMOTION', 6, 4001000000, 'promo', null, null, 'ZOHO'],
    [302, 26, 'J', 1, "'000903", '20/07/26', -100, '', 302, 1, 'INDUSIND BANK', 1, 1002003003, 'promo', null, null, 'ZOHO'],
  ] }]);
  const wd = fakeWd();
  const file = (id, name, bytes) => ({ id, name, isFolder: false, modified: 1, size: bytes.length, bytes });
  const tree = { ROOT: [{ id: 'BLR', name: 'Bengaluru', isFolder: true }], BLR: [{ id: 'B302', name: '302', isFolder: true }],
    B302: [file('L2', 'Ledger_01042026_to_05082026 V1.xlsx', blr)] };
  const inner = wd.list.bind(wd);
  const all = Object.values(tree).flat();
  wd.list = async (id) => tree[id] ?? inner(id);
  const dl = wd.download.bind(wd);
  wd.download = async (f) => all.find((x) => x.id === f.id)?.bytes ?? dl(f);
  const s = await runSync({ wd, blobs: memoryBlobs(), rootFolderId: 'ROOT', configFolderId: 'CFG' });
  const row = s.tracker.find((r) => r.branch === '302');
  assert.equal(row.window, '2026-04-01 to 2026-08-05');
  assert.doesNotMatch(row.problems, /dates inside the window/, '20-07-2026 is inside the Bengaluru window');
  assert.equal(row.status, 'WAITING FOR OPENING');
});
