// WorkDrive branch inbox: file picking, change detection, tracker rows, and the sync CLI against a
// fake WorkDrive. Synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { fileKind, pickFiles, toPull, trackerRow, localName } from '../src/workdrive/sync.js';

const f = (id, name, modified = 1, size = 10) => ({ id, name, isFolder: false, modified, size });

test('fileKind / pickFiles: the highest ledger version, a csv over a zip, other files ignored', () => {
  assert.equal(fileKind('Rule Book'), null);
  assert.equal(fileKind('Customer and vendor_bill& invoice_TB-TRIPURA-460.xlsx'), 'openingItems');
  const p = pickFiles([
    f('a', 'Ledger_01042026_to_05072026 V1.xlsx', 5), f('b', 'Ledger_01042026_to_05072026 V2.xlsx', 3),
    f('c', 'invoice_receipt_det_act_461.zip', 9), f('d', 'invoice_receipt_det_act_461.csv', 2),
    f('e', 'Closing_tb_report_05072026.xlsx'), f('x', 'Exception List'),
  ]);
  assert.deepEqual(Object.fromEntries(Object.entries(p).map(([k, v]) => [k, v.id])), { ledger: 'b', customer: 'd', closingTb: 'e' });
  assert.equal(localName('461', 'ledger'), 'var/raw461/txn/ledger_v2.xlsx');
});

test('toPull: new files and files changed since the last pull; unchanged ones are skipped', () => {
  const branches = [{ branch: '461', picked: { ledger: f('b', 'L V2.xlsx', 3, 100), supplier: f('s', 'supplier_payment_details_act.csv', 1, 5) } }];
  const state = { files: { b: { kind: 'ledger', modified: 3, size: 100 }, s: { kind: 'supplier', modified: 1, size: 4 } } };
  assert.deepEqual(toPull(branches, state).map((x) => x.file.id), ['s']);
  assert.equal(toPull(branches, { files: {} }).length, 2);
});

test('trackerRow: missing files, and the plan status (opening received once its file is there)', () => {
  const b = { region: 'tripura', branch: '461', picked: { ledger: f('b', 'L V2.xlsx', Date.UTC(2026, 9, 16, 8, 0)), openingItems: f('o', 'x_bill_invoice.xlsx') } };
  const row = trackerRow(b, { status: 'WAITING FOR OPENING', ours: 589 }, { branches: { 461: { pulledAt: '2026-10-16 09:00' } } }, 'now');
  assert.equal(row.status, 'OPENING FILE RECEIVED');
  assert.equal(row.missing_files, 'supplier; customer; closingTb');
  assert.equal(row.last_upload, '2026-10-16 08:00');
  assert.equal(trackerRow({ region: 'x', branch: '470', picked: {} }, null, {}, 'now').status, 'WAITING FOR FILES');
});

// a one-entry zip (deflate) holding a csv
function zipOf(name, data) {
  const raw = deflateRawSync(data);
  const n = Buffer.from(name);
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8);
  local.writeUInt32LE(raw.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(n.length, 26);
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(8, 10);
  central.writeUInt32LE(raw.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(n.length, 28);
  central.writeUInt32LE(0, 42);
  const cdOff = 30 + n.length + raw.length;
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(46 + n.length, 12); end.writeUInt32LE(cdOff, 16);
  return Buffer.concat([local, n, raw, central, n, end]);
}

function fakeWorkdrive() {
  const uploads = [];
  const item = (id, name, isFolder, extra = {}) => ({ id, attributes: { name, is_folder: isFolder, type: isFolder ? 'folder' : 'file', modified_time_in_millisecond: 1000, storage_info: { size_in_bytes: 4 }, ...extra } });
  const folders = {
    ROOT: [item('TRI', 'tripura', true), item('NOTE', 'readme.txt', false)],
    TRI: [item('B461', '461', true), item('B999', '999', true)],
    B461: [item('L1', 'Ledger_x V1.xlsx', false), item('L2', 'Ledger_x V2.xlsx', false), item('Z', 'invoice_receipt_det_act_461.zip', false), item('RB', 'Rule Book', false)],
    B999: [],
  };
  const content = { L2: Buffer.from('not really a workbook'), Z: zipOf('invoice_receipt_det_act_461.csv', Buffer.from('c_br_code\n0\n')) };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (code, body, type = 'application/json') => { res.writeHead(code, { 'content-type': type }); res.end(body); };
    if (url.pathname === '/oauth/v2/token') return send(200, JSON.stringify({ access_token: 'tok', expires_in: 3600 }));
    if (req.headers.authorization !== 'Zoho-oauthtoken tok') return send(401, '{}');
    const list = /^\/api\/files\/(\w+)\/files$/.exec(url.pathname);
    if (list) return send(200, JSON.stringify({ data: url.searchParams.get('page[offset]') === '0' ? folders[list[1]] ?? [] : [] }));
    const dl = /^\/api\/download\/(\w+)$/.exec(url.pathname);
    if (dl) return send(200, content[dl[1]] ?? Buffer.alloc(0), 'application/octet-stream');
    if (url.pathname === '/api/upload' && req.method === 'POST') {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => { uploads.push({ query: Object.fromEntries(url.searchParams), body: Buffer.concat(chunks).toString() }); send(200, '{"data":[]}'); });
      return undefined;
    }
    return send(404, '{}');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, uploads, base: `http://127.0.0.1:${server.address().port}` })));
}

function sync(args, base, cwd) {
  const env = {
    PATH: process.env.PATH, WORKDRIVE_API_BASE: `${base}/api`, WORKDRIVE_ACCOUNTS_BASE: base, WORKDRIVE_FOLDER_ID: 'ROOT',
    WORKDRIVE_CLIENT_ID: 'c', WORKDRIVE_CLIENT_SECRET: 's', WORKDRIVE_REFRESH_TOKEN: 'r',
  };
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(process.cwd(), 'scripts/workdrive-sync.js'), ...args], { env, cwd });
    let text = '';
    child.stdout.on('data', (b) => { text += b; });
    child.stderr.on('data', (b) => { text += b; });
    child.on('close', (code) => resolve({ code, text }));
  });
}

test('workdrive-sync: pulls new branch files once (zip unpacked), prepares them, uploads the tracker', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'wd-sync-'));
  const { server, uploads, base } = await fakeWorkdrive();
  try {
    const dry = await sync(['--dry-run'], base, cwd);
    assert.match(dry.text, /2 branch folders; 2 files new or changed/);
    assert.equal(existsSync(join(cwd, 'var/raw461/txn/ledger_v2.xlsx')), false, 'dry run pulls nothing');

    const first = await sync([], base, cwd);
    assert.equal(first.code, 0, first.text);
    assert.equal(readFileSync(join(cwd, 'var/raw461/txn/ledger_v2.xlsx'), 'utf8'), 'not really a workbook');
    assert.equal(readFileSync(join(cwd, 'var/raw461/txn/invoice_receipt_det_act_461.csv'), 'utf8'), 'c_br_code\n0\n');
    assert.equal(uploads.length, 1);
    assert.deepEqual([uploads[0].query.filename, uploads[0].query.parent_id, uploads[0].query['override-name-exist']], ['Migration Tracker.csv', 'ROOT', 'true']);
    assert.match(uploads[0].body, /tripura,461,Ledger_x V2\.xlsx,2,supplier; closingTb; openingItems/);
    assert.match(uploads[0].body, /tripura,999,,0,.*WAITING FOR FILES/);

    const again = await sync([], base, cwd);
    assert.match(again.text, /2 branch folders; 0 files new or changed/);
  } finally {
    server.close();
  }
});
