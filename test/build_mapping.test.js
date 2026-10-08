import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBuildMapping } from '../scripts/build-mapping.js';
import { parseCsv } from '../src/core/csv.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Everything below is synthetic.
const TRANSACTIONS = [
  'branch_code,voucher_id,voucher_no,voucher_type,voucher_date,line_no,ledger_code,ledger_name,debit,credit,party_code,party_name,payment_method,tax_bucket,narration,reference_no,created_at,modified_at',
  'B1,V1,1,JOURNAL,2026-04-02,1,L100,Office Rent,100.00,0.00,,,,,,,,',
  'B1,V1,1,JOURNAL,2026-04-02,2,L200,Sundry Debtors Corporate,0.00,100.00,P1,Acme Traders,,,,,,',
  'B1,V2,2,RECEIPT,2026-04-03,1,L200,Sundry Debtors Corporate,0.00,50.00,P1,Acme Traders,,,,,,',
  'B1,V2,2,RECEIPT,2026-04-03,2,L300,Bank Clearing,50.00,0.00,PC001,Bank Clearing,,,,,,',
  'B1,V3,3,PAYMENT,2026-04-04,1,L100,Office Rent,20.00,0.00,,,,,,,,',
  'B1,V3,3,PAYMENT,2026-04-04,2,L300,Bank Clearing,0.00,20.00,,,,,,,,',
  'B1,V3,3,PAYMENT,2026-04-04,3,L400,Mystery Ledger,0.00,0.00,,,,,,,,',
].join('\n') + '\n';

const TRIAL_BALANCE = [
  'branch_code,ledger_code,ledger_name,opening_debit,opening_credit,period_debit,period_credit,closing_debit,closing_credit,txn_count',
  'B1,L100,Office Rent,0,0,120.00,0,120.00,0,2',
  'B1,L200,Sundry Debtors Corporate,0,0,0,150.00,0,150.00,2',
  'B1,L300,Bank Clearing,0,0,50.00,20.00,30.00,0,2',
  'B1,L400,Mystery Ledger,0,0,0,0,0,0,1',
  'B1,L999,Unused Ledger,0,0,0,0,0,0,0',
].join('\n') + '\n';

const ACCOUNTS = [
  { account_id: 'a1', account_name: 'OFFICE RENT', account_code: '5001', account_type: 'expense', parent_account_id: '', parent_account_name: '', depth: 0, is_active: true, is_system_account: false },
  { account_id: 'a2', account_name: 'Sundry Debtors-Corporate', account_code: '1101', account_type: 'accounts_receivable', parent_account_id: 'a9', parent_account_name: 'SUNDRY DEBTORS', depth: 1, is_active: true, is_system_account: false },
  { account_id: 'a9', account_name: 'SUNDRY DEBTORS', account_code: '1100', account_type: 'accounts_receivable', parent_account_id: '', parent_account_name: '', depth: 0, is_active: true, is_system_account: false },
  { account_id: 'a3', account_name: 'Bank Clearing', account_code: 'PC001', account_type: 'other_current_asset', parent_account_id: '', parent_account_name: '', depth: 0, is_active: true, is_system_account: false },
];
const CONTACTS = [
  { contact_id: 'c1', contact_name: 'Acme Traders', company_name: 'Acme Traders', contact_type: 'customer', customer_sub_type: 'business', status: 'active', gst_no: '', vendor_name: '' },
];

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'build-mapping-'));
  const run = path.join(root, 'run');
  const ref = path.join(root, 'ref');
  await mkdir(run);
  await mkdir(ref);
  await writeFile(path.join(run, 'transactions.csv'), TRANSACTIONS);
  await writeFile(path.join(run, 'trial_balance.csv'), TRIAL_BALANCE);
  await writeFile(path.join(run, 'manifest.json'), JSON.stringify({ extraction_run_id: 'run-synthetic-1' }));
  await writeFile(path.join(ref, 'accounts.json'), JSON.stringify(ACCOUNTS));
  await writeFile(path.join(ref, 'contacts.json'), JSON.stringify(CONTACTS));
  return { root, run, ref, out: path.join(root, 'out') };
}

test('runBuildMapping writes the four outputs with the expected counts', async () => {
  const f = await fixture();
  try {
    const { report, rules } = await runBuildMapping({
      runDir: f.run, booksRefDir: f.ref, orgId: 'ORG-T', outDir: f.out, decidedOn: '2026-10-08',
      now: () => '2026-10-08T00:00:00.000Z',
    });
    for (const name of ['mapping-rules.json', 'review-accounts.csv', 'review-contacts.csv', 'mapping-report.json']) {
      await access(path.join(f.out, name));
    }
    assert.equal(report.run_id, 'run-synthetic-1');
    assert.equal(report.books_org_id, 'ORG-T');
    assert.equal(report.mapping_version, 'map_test_v1');
    assert.equal(report.ledgers_in_transactions, 4);
    assert.equal(report.trial_balance_only_ledgers, 1);
    assert.equal(report.parties, 2);
    // L100 EXACT, L200 EXACT (leaf), L300 EXACT, L400 NONE
    assert.deepEqual(report.accounts, { EXACT: 3, NONE: 1 });
    // P1 contact EXACT, PC001 is a GL account in Books
    assert.deepEqual(report.contacts, { EXACT: 1, ACCOUNT: 1 });
    assert.deepEqual(report.module_routes.map((m) => m.voucher_type), ['JOURNAL', 'PAYMENT', 'RECEIPT']);
    assert.deepEqual(report.rules, { MODULE_ROUTE: 3, LEDGER_ACCOUNT: 3, PARTY: 2 });
    assert.equal(report.generated_at, '2026-10-08T00:00:00.000Z');

    const onDisk = JSON.parse(await readFile(path.join(f.out, 'mapping-rules.json'), 'utf8'));
    assert.equal(onDisk.length, rules.length);
    assert.equal(onDisk.length, 8);
    assert.ok(onDisk.every((r) => r.status === 'DRAFT' && r.mapping_version === 'map_test_v1' && r.effective_from === '2026-04-01'));
    const party = onDisk.find((r) => r.rule_type === 'PARTY' && r.source_key === 'PC001');
    assert.equal(party.target_value, 'a3');
    assert.equal(party.target_meta.kind, 'account');
    assert.equal(party.target_meta.books_org_id, 'ORG-T');
    assert.ok(onDisk.filter((r) => r.rule_type === 'MODULE_ROUTE' && r.source_key !== 'JOURNAL').every((r) => r.notes.length > 0));

    const accountsSheet = parseCsv(await readFile(path.join(f.out, 'review-accounts.csv'), 'utf8'));
    assert.equal(accountsSheet.rows.length, 4);
    assert.equal(accountsSheet.rows[0][0], 'L100'); // most used first (ties by code)
    const contactsSheet = parseCsv(await readFile(path.join(f.out, 'review-contacts.csv'), 'utf8'));
    assert.equal(contactsSheet.rows.length, 2);
    assert.ok(contactsSheet.header.includes('kind'));

    const onDiskReport = JSON.parse(await readFile(path.join(f.out, 'mapping-report.json'), 'utf8'));
    assert.deepEqual(onDiskReport, report);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('runBuildMapping refuses an output folder inside the repo but outside var/', async () => {
  const f = await fixture();
  try {
    const bad = path.join(PROJECT_ROOT, 'mapping-out-should-not-exist');
    await assert.rejects(
      runBuildMapping({ runDir: f.run, booksRefDir: f.ref, orgId: 'ORG-T', outDir: bad }),
      /only var\/ is allowed/,
    );
    await assert.rejects(access(bad));
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('runBuildMapping rejects a missing input file and a bad threshold', async () => {
  const f = await fixture();
  try {
    await rm(path.join(f.ref, 'contacts.json'));
    await assert.rejects(runBuildMapping({ runDir: f.run, booksRefDir: f.ref, orgId: 'ORG-T', outDir: f.out }), /contacts\.json/);
    await assert.rejects(runBuildMapping({ runDir: f.run, booksRefDir: f.ref, orgId: 'ORG-T', outDir: f.out, threshold: 'abc' }), /threshold/);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
