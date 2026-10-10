// Bulk mapping: Books reference lists (src/core/books_reference.js), proposals and the
// mapping sheet (src/core/bulk_mapping.js), and the routes (src/server/routes/bulk_mapping.js).
// All names, codes and ids are synthetic.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openStore } from '../src/adapters/store/memory.js';
import { openArchive } from '../src/adapters/archive/local.js';
import { createAudit } from '../src/core/audit.js';
import { createApp } from '../src/server/app.js';
import {
  parseBooksExport, buildReference, referenceSummary, saveReference, loadReference, BooksExportError,
} from '../src/core/books_reference.js';
import {
  collectRunEntities, proposeForRun, sheetCsv, parseSheet, resolveSheet, autoRules, ruleDefaults, SheetError,
} from '../src/core/bulk_mapping.js';
import { buildXlsx } from './helpers/xlsx_builder.js';

const NOW = '2026-10-10T00:00:00.000Z';
const BIG_ID = '3370193000000412037'; // 19 digits: not representable as a JS Number

const ACCOUNTS_CSV = [
  'Account ID,Account Name,Account Code,Account Type,Parent Account,Account Status',
  `${BIG_ID},Office Rent,R01,expense,,Active`,
  '3370193000000000002,Freight Inward,F01,expense,,Active',
  '3370193000000000003,HDFC Bank Current,B01,bank,,Active',
  '3370193000000000004,Old Ledger,O01,expense,,Inactive',
  '3370193000000000005,UPI Collections,U01,other_current_asset,,Active',
].join('\n');
const VENDORS_CSV = [
  'Contact ID,Display Name,Company Name,Status',
  '3370193000000100001,Acme Traders,Acme Traders Pvt Ltd,Active',
  '3370193000000100002,Beta Supplies,,Active',
].join('\n');
const CUSTOMERS_CSV = [
  'Contact ID,Display Name,Status',
  '3370193000000200001,Gamma Stores,Active',
].join('\n');

const buf = (s) => Buffer.from(s, 'utf8');

function reference() {
  return buildReference([
    parseBooksExport(buf(ACCOUNTS_CSV), { kindHint: 'accounts' }),
    parseBooksExport(buf(VENDORS_CSV), { kindHint: 'vendors' }),
    parseBooksExport(buf(CUSTOMERS_CSV), { kindHint: 'customers' }),
  ], { uploadedBy: 'u_operator', uploadedAt: NOW });
}

describe('parseBooksExport', () => {
  test('chart of accounts CSV: columns matched loosely, ids kept exact, status read', () => {
    const p = parseBooksExport(buf(ACCOUNTS_CSV), { fileName: 'Chart_of_Accounts.csv' });
    assert.equal(p.kind, 'accounts');
    assert.equal(p.accounts.length, 5);
    assert.equal(p.accounts[0].account_id, BIG_ID);
    assert.equal(p.accounts[0].account_name, 'Office Rent');
    assert.equal(p.accounts[3].is_active, false);
  });

  test('vendor / customer exports: type from the hint or file name; company name as fallback', () => {
    const v = parseBooksExport(buf(VENDORS_CSV), { fileName: 'Vendors.csv' });
    assert.equal(v.kind, 'contacts');
    assert.equal(v.contactType, 'vendor');
    assert.deepEqual(v.contacts.map((c) => c.contact_type), ['vendor', 'vendor']);
    const c = parseBooksExport(buf('Contact ID,Company Name\n1,Delta Co\n'), { kindHint: 'customers' });
    assert.equal(c.contacts[0].contact_name, 'Delta Co');
    assert.equal(c.contacts[0].contact_type, 'customer');
  });

  test('XLSX: a 19-digit numeric id cell keeps every digit', () => {
    const bytes = buildXlsx([{ name: 'Accounts', rows: [
      ['Account ID', 'Account Name', 'Account Type'],
      [BigInt(BIG_ID), 'Office Rent', 'expense'],
    ] }]);
    const p = parseBooksExport(bytes, { kindHint: 'accounts' });
    assert.equal(p.accounts[0].account_id, BIG_ID);
  });

  test('missing id / name columns is a BooksExportError naming the headers found', () => {
    assert.throws(() => parseBooksExport(buf('Foo,Bar\n1,2\n'), { kindHint: 'accounts' }), (e) => e instanceof BooksExportError && /Foo, Bar/.test(e.message));
    assert.throws(() => parseBooksExport(buf('Foo,Bar\n1,2\n'), { kindHint: 'vendors' }), BooksExportError);
  });

  test('buildReference + referenceSummary count lists', () => {
    const s = referenceSummary(reference());
    assert.equal(s.accounts, 5);
    assert.equal(s.active_accounts, 4);
    assert.equal(s.vendors, 2);
    assert.equal(s.customers, 1);
    assert.equal(referenceSummary(null), null);
  });
});

describe('saveReference / loadReference', () => {
  test('round-trips through the archive; the newest upload wins', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'books-ref-'));
    const store = await openStore();
    try {
      const archive = await openArchive({ root });
      const ctx = { store, audit: createAudit(store), actor: 'u_operator', actorRole: 'operator', correlationId: 'c1' };
      assert.equal(await loadReference(ctx, { archive }), null);
      await saveReference(ctx, { archive, reference: reference() });
      const later = buildReference([parseBooksExport(buf(ACCOUNTS_CSV), { kindHint: 'accounts' })], { uploadedBy: 'u_operator', uploadedAt: '2026-10-11T00:00:00.000Z' });
      await saveReference(ctx, { archive, reference: later });
      const got = await loadReference(ctx, { archive });
      assert.equal(got.uploaded_at, '2026-10-11T00:00:00.000Z');
      assert.equal(got.accounts[0].account_id, BIG_ID);
      assert.equal(got.contacts.length, 0);
    } finally {
      await store.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------- proposals and the sheet

const ENTITIES = {
  ledgers: [
    { ledger_code: '000101', ledger_name: 'Office Rent', usage_count: 5, amount: '500.00' },
    { ledger_code: '000102', ledger_name: 'Freight Inwards', usage_count: 9, amount: '900.00' },
    { ledger_code: '000103', ledger_name: 'Misc Charges', usage_count: 1, amount: '10.00' },
    { ledger_code: '000104', ledger_name: 'Bank', usage_count: 2, amount: '20.00' },
  ],
  parties: [
    { party_code: 'P1', party_name: 'Acme Traders', usage_count: 3, amount: '300.00', ledger_codes: ['000102'] },
    { party_code: 'P2', party_name: 'UPI Collections', usage_count: 4, amount: '40.00', ledger_codes: ['000104'] },
  ],
};
const APPROVED_BANK = { rule_type: 'LEDGER_ACCOUNT', source_key: '000104', status: 'APPROVED', mapping_version: 'map_test_v1', effective_from: '2026-04-01', target_meta: '{"books_org_id":"ORG1"}' };

describe('proposeForRun', () => {
  test('skips sources with an approved rule, sorts by entries, and labels matches', () => {
    const rows = proposeForRun({ entities: ENTITIES, reference: reference(), rules: [APPROVED_BANK] });
    assert.deepEqual(rows.map((r) => r.source_code), ['000102', '000101', 'P2', 'P1', '000103']);
    const by = Object.fromEntries(rows.map((r) => [r.source_code, r]));
    assert.equal(by['000101'].match, 'EXACT');
    assert.equal(by['000101'].books_id, BIG_ID);
    assert.equal(by.P1.books_kind, 'contact');
    assert.equal(by.P1.books_name, 'Acme Traders');
    assert.equal(by.P2.match, 'ACCOUNT');
    assert.equal(by.P2.books_kind, 'account');
    assert.equal(by['000103'].match, 'NONE');
  });

  test('autoRules: DRAFT rules only for confident rows, with the approved version and org', () => {
    const rows = proposeForRun({ entities: ENTITIES, reference: reference(), rules: [APPROVED_BANK] });
    const defaults = ruleDefaults([APPROVED_BANK], { from_date: '2026-05-01' });
    assert.deepEqual(defaults, { mappingVersion: 'map_test_v1', effectiveFrom: '2026-04-01', booksOrgId: 'ORG1' });
    const rules = autoRules(rows, defaults);
    const confident = rows.filter((r) => ['EXACT', 'FUZZY', 'ACCOUNT'].includes(r.match)).map((r) => r.source_code).sort();
    assert.deepEqual(rules.map((r) => r.source_key).sort(), confident);
    for (const r of rules) {
      assert.equal(r.status, 'DRAFT');
      assert.equal(r.mapping_version, 'map_test_v1');
      assert.equal(r.target_meta.books_org_id, 'ORG1');
    }
    const p2 = rules.find((r) => r.source_key === 'P2');
    assert.equal(p2.target_meta.kind, 'account');
  });

  test('ruleDefaults with no approved rules falls back to map_v1 and the run start', () => {
    assert.deepEqual(ruleDefaults([], { from_date: '2026-05-01' }), { mappingVersion: 'map_v1', effectiveFrom: '2026-05-01', booksOrgId: null });
  });
});

describe('mapping sheet', () => {
  test('sheetCsv -> parseSheet round trip (BOM, quoted names)', () => {
    const rows = proposeForRun({ entities: ENTITIES, reference: reference(), rules: [] });
    const csv = sheetCsv(rows);
    assert.equal(csv.charCodeAt(0), 0xfeff);
    const back = parseSheet(buf(csv));
    assert.equal(back.length, rows.length);
    assert.equal(back[0].line, 2);
    assert.equal(back[0].type, 'ledger');
    assert.equal(back[0].source_code, rows[0].source_code);
  });

  test('parseSheet reads XLSX and rejects a sheet without the needed columns', () => {
    const bytes = buildXlsx([{ name: 'Sheet1', rows: [['type', 'source_code', 'books_name'], ['Ledger', 103, 'Freight Inward']] }]);
    assert.deepEqual(parseSheet(bytes), [{ line: 2, type: 'ledger', source_code: '103', source_name: '', books_kind: '', books_name: 'Freight Inward' }]);
    assert.throws(() => parseSheet(buf('type,code\nLedger,1\n')), SheetError);
  });

  test('resolveSheet: every outcome, leading zeros restored, names resolved to ids', () => {
    const sheet = [
      { line: 2, type: 'ledger', source_code: '103', source_name: '', books_kind: '', books_name: 'freight inward' },
      { line: 3, type: 'ledger', source_code: '000101', source_name: '', books_kind: '', books_name: '' },
      { line: 4, type: 'ledger', source_code: '000104', source_name: '', books_kind: '', books_name: 'HDFC Bank Current' },
      { line: 5, type: 'ledger', source_code: '999', source_name: '', books_kind: '', books_name: 'Office Rent' },
      { line: 6, type: 'ledger', source_code: 'X', source_name: 'Office Rent', books_kind: '', books_name: 'Old Ledger' },
      { line: 7, type: 'party', source_code: 'P1', source_name: '', books_kind: 'contact', books_name: 'Acme Traders' },
      { line: 8, type: 'party', source_code: 'P2', source_name: '', books_kind: 'account', books_name: 'UPI Collections' },
      { line: 9, type: 'item', source_code: 'P1', source_name: '', books_kind: '', books_name: 'x' },
      { line: 10, type: 'party', source_code: 'P1', source_name: '', books_kind: '', books_name: 'Beta Supplies' },
    ];
    const { rules, results } = resolveSheet(sheet, {
      entities: ENTITIES, reference: reference(), rules: [APPROVED_BANK], mappingVersion: 'map_test_v1', effectiveFrom: '2026-04-01', booksOrgId: 'ORG1',
    });
    assert.deepEqual(results.map((r) => r.outcome), [
      'RULE', 'BLANK', 'ALREADY_APPROVED', 'UNKNOWN_SOURCE', 'NOT_FOUND', 'RULE', 'RULE', 'BAD_TYPE', 'DUPLICATE_ROW',
    ]);
    assert.equal(results[0].source_code, '000103');
    assert.equal(results[4].source_code, '000101', 'matched by source name');
    assert.deepEqual(rules.map((r) => [r.rule_type, r.source_key, r.target_value]), [
      ['LEDGER_ACCOUNT', '000103', '3370193000000000002'],
      ['PARTY', 'P1', '3370193000000100001'],
      ['PARTY', 'P2', '3370193000000000005'],
    ]);
    assert.equal(rules[2].target_meta.kind, 'account');
    assert.ok(rules.every((r) => r.status === 'DRAFT'));
  });
});

// ---------------------------------------------------------------- routes

const sha = (t) => createHash('sha256').update(t, 'utf8').digest('hex');
const TOKENS = { operator: 'tok-bulk-operator', approver: 'tok-bulk-approver', viewer: 'tok-bulk-viewer', bot: 'tok-bulk-bot', other: 'tok-bulk-other' };
const USERS = [
  { id: 'u_operator', role: 'operator', branches: ['B1'], token_sha256: sha(TOKENS.operator) },
  { id: 'u_approver', role: 'approver', branches: ['B1'], token_sha256: sha(TOKENS.approver) },
  { id: 'u_viewer', role: 'viewer', branches: ['B1'], token_sha256: sha(TOKENS.viewer) },
  { id: 'bot:hermes', role: 'operator', branches: ['B1'], token_sha256: sha(TOKENS.bot) },
  { id: 'u_other', role: 'operator', branches: ['B2'], token_sha256: sha(TOKENS.other) },
];

async function seedRun(store) {
  await store.insert('extraction_runs', {
    id: 'R1', branch_code: 'B1', query_id: 'Q', query_version: 'v1', from_date: '2026-04-01', to_date: '2026-07-05',
    manifest_json: '{}', manifest_sha256: 'm1', status: 'TRANSFORMED', created_at: NOW, updated_at: NOW,
  });
  const file = await store.insert('source_files', {
    run_id: 'R1', file_name: 'transactions.csv', file_role: 'TRANSACTIONS', sha256: 'f1', size_bytes: 1,
    encoding: 'utf-8', delimiter: ',', status: 'ARCHIVED', created_at: NOW, updated_at: NOW,
  });
  let row = 0;
  const line = (voucher, code, name, debit, credit, party = null, partyName = null) => {
    row += 1;
    return store.insert('source_txn_lines', {
      run_id: 'R1', file_id: file.id, row_number: row, branch_code: 'B1', voucher_id: voucher, voucher_no: voucher,
      voucher_type: 'JOURNAL', voucher_date: '2026-04-05', line_no: row, ledger_code: code, ledger_name: name,
      debit, credit, party_code: party, party_name: partyName, row_hash: `r${row}`, uk: `${file.id}|${voucher}|${row}`, created_at: NOW,
    });
  };
  await line('V1', '000101', 'Office Rent', '100.00', '0.00');
  await line('V1', '000104', 'Bank', '0.00', '100.00');
  await line('V2', '000102', 'Freight Inwards', '50.00', '0.00', 'P1', 'Acme Traders');
  await line('V2', '000104', 'Bank', '0.00', '50.00');
  await store.insert('mapping_rules', {
    ...APPROVED_BANK, target_value: '3370193000000000003', uk: 'LEDGER_ACCOUNT|000104|map_test_v1', created_at: NOW, updated_at: NOW,
  });
}

async function startApp() {
  const root = await mkdtemp(path.join(tmpdir(), 'bulk-map-'));
  const store = await openStore();
  const audit = createAudit(store);
  await seedRun(store);
  const archive = await openArchive({ root });
  const app = createApp({ store, audit, users: USERS, deps: { mapping: await import('../src/core/mapping.js') }, devDeps: { archive } });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (method, p, role, body) => {
    const res = await fetch(`${base}${p}`, {
      method, headers: { Authorization: `Bearer ${TOKENS[role]}`, 'Content-Type': 'application/json', 'X-Correlation-Id': `c-${Math.random()}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const textBody = await res.text();
    let json = null;
    try { json = JSON.parse(textBody); } catch { /* csv */ }
    return { status: res.status, body: json, text: textBody };
  };
  return {
    store, call,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      await store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const UPLOAD = { files: [
  { name: 'accounts.csv', kind: 'accounts', content: b64(ACCOUNTS_CSV) },
  { name: 'vendors.csv', kind: 'vendors', content: b64(VENDORS_CSV) },
] };

describe('bulk mapping routes', () => {
  test('auto-map needs the Books lists first (409), then creates DRAFT rules that an approver approves', async () => {
    const t = await startApp();
    try {
      assert.equal((await t.call('POST', '/branches/B1/mapping-auto', 'operator', {})).status, 409);
      const ref0 = await t.call('GET', '/books-reference', 'viewer');
      assert.equal(ref0.body.reference, null);

      const up = await t.call('POST', '/books-reference', 'operator', UPLOAD);
      assert.equal(up.status, 200, JSON.stringify(up.body));
      assert.equal(up.body.reference.accounts, 5);
      assert.equal(up.body.reference.vendors, 2);

      // A partial upload (customers only) keeps the accounts and vendors.
      const part = await t.call('POST', '/books-reference', 'operator', { files: [{ name: 'customers.csv', kind: 'customers', content: b64(CUSTOMERS_CSV) }] });
      assert.equal(part.status, 200, JSON.stringify(part.body));
      assert.deepEqual([part.body.reference.accounts, part.body.reference.vendors, part.body.reference.customers], [5, 2, 1]);

      const props = await t.call('GET', '/branches/B1/mapping-proposals', 'viewer');
      assert.equal(props.status, 200);
      assert.deepEqual(props.body.rows.map((r) => r.source_code).sort(), ['000101', '000102', 'P1']);

      const sheet = await t.call('GET', '/branches/B1/mapping-sheet.csv', 'viewer');
      assert.equal(sheet.status, 200);
      assert.match(sheet.text, /source_code/);

      const auto = await t.call('POST', '/branches/B1/mapping-auto', 'operator', {});
      assert.equal(auto.status, 200, JSON.stringify(auto.body));
      assert.ok(auto.body.created >= 2);
      const drafts = await t.store.find('mapping_rules', { status: 'DRAFT' });
      assert.equal(drafts.length, auto.body.created);
      assert.ok(drafts.every((r) => r.mapping_version === 'map_test_v1'));
      assert.equal((await t.store.find('audit_events', { action: 'MAPPING.BULK_UPSERT' })).length, 1);

      const approve = await t.call('POST', '/mappings/approve', 'approver', { ids: auto.body.ids });
      assert.equal(approve.status, 200, JSON.stringify(approve.body));
    } finally {
      await t.close();
    }
  });

  test('filled sheet upload creates DRAFT rules and reports each row', async () => {
    const t = await startApp();
    try {
      await t.call('POST', '/books-reference', 'operator', UPLOAD);
      const csv = 'type,source_code,books_name\nLedger,102,Freight Inward\nParty,P1,Nobody\n';
      const res = await t.call('POST', '/branches/B1/mapping-sheet', 'operator', { name: 'sheet.csv', content: b64(csv) });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.created, 1);
      assert.deepEqual(res.body.outcomes, { RULE: 1, NOT_FOUND: 1 });
      const [rule] = await t.store.find('mapping_rules', { status: 'DRAFT' });
      assert.equal(rule.source_key, '000102');
      assert.equal(rule.target_value, '3370193000000000002');

      const bad = await t.call('POST', '/branches/B1/mapping-sheet', 'operator', { name: 'x.csv', content: b64('a,b\n1,2\n') });
      assert.equal(bad.status, 400);
      assert.equal(bad.body.error, 'BAD_SHEET');
    } finally {
      await t.close();
    }
  });

  test('roles, bots and branch scope', async () => {
    const t = await startApp();
    try {
      assert.equal((await t.call('POST', '/books-reference', 'viewer', UPLOAD)).status, 403);
      assert.equal((await t.call('POST', '/books-reference', 'bot', UPLOAD)).status, 403);
      assert.equal((await t.call('POST', '/books-reference', 'approver', UPLOAD)).status, 200);
      assert.equal((await t.call('POST', '/branches/B1/mapping-auto', 'approver', {})).status, 403);
      assert.equal((await t.call('POST', '/branches/B1/mapping-auto', 'bot', {})).status, 403);
      assert.equal((await t.call('GET', '/branches/B1/mapping-proposals', 'other')).status, 403);
      assert.equal((await t.call('POST', '/branches/B1/mapping-sheet', 'other', { name: 'x.csv', content: b64('type,source_code,books_name\n') })).status, 403);
      assert.equal((await t.call('GET', '/branches/B9/mapping-proposals', 'viewer')).status, 403);
      const bad = await t.call('POST', '/books-reference', 'operator', { files: [{ name: 'v.csv', kind: 'vendors', content: b64(VENDORS_CSV) }] });
      assert.equal(bad.status, 200, 'vendors alone are fine once accounts were uploaded');
      assert.equal((await t.store.find('mapping_rules', { status: 'DRAFT' })).length, 0);
    } finally {
      await t.close();
    }
  });

  test('vendors alone, with no chart of accounts yet, is refused', async () => {
    const t = await startApp();
    try {
      const res = await t.call('POST', '/books-reference', 'operator', { files: [{ name: 'v.csv', kind: 'vendors', content: b64(VENDORS_CSV) }] });
      assert.equal(res.status, 400);
      assert.equal(res.body.error, 'BAD_BOOKS_EXPORT');
    } finally {
      await t.close();
    }
  });
});
