// Transaction posting: Books request bodies (src/txn/books.js) and scripts/txn-post.js against a
// fake Books server (preflight, post, rerun posts nothing twice). Synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { booksNumber, voucherRequests, creditRequests, splitApplications, isDirect } from '../src/txn/books.js';

const res = {
  locationId: 'LOC', clearingAccountId: 'CLR', taxExemptionId: 'EX',
  accountMap: { UR_REC: 'AL0069', IE611: 'IE215', INTERBRANCH: 'FRP0026G', CASH: 'AL0077', IE135: 'IE097' },
  accounts: { AL0069: { account_id: 'A-UR', type: 'other_current_asset' }, IE215: { account_id: 'A-CH', type: 'expense' }, FRP0026G: { account_id: 'A-IB', type: 'accounts_receivable' }, AL0077: { account_id: 'A-CASH', type: 'cash' }, IE097: { account_id: 'A-RENT', type: 'expense' } },
  contacts: { 'customer:H1': 'C1', 'customer:000': 'C-HO', 'vendor:V1': 'V-1', 'vendor:V2': 'V-2' },
  controls: { 'customer:H1': 'AR', 'vendor:V1': 'AP' },
  gstTreatment: { 'vendor:V2': 'business_none' },
  docs: { '25/S/900|H1': { module: 'invoices', id: 'INV-900' }, '25/K/29|V1': { module: 'bills', id: 'BILL-29' }, '25/I/3|V1': { module: 'vendorcredits', id: 'VC-3' } },
};

test('booksNumber: Smart Pharma convention <branch>/<yy>/<prefix>/<6 digits>', () => {
  assert.equal(booksNumber('460', '26/S/2474'), '460/26/S/002474');
  assert.equal(booksNumber('460', '26/Q/-3909'), '460/26/Q/-003909');
});

test('receipt via clearing: customer payment applied to Books documents + clearing journal', () => {
  const p = {
    key: '26/J/1', kind: 'receipt', date: '2026-05-01', description: 'Receipt J/1 – UPI', amount: '100.00',
    party: { side: 'customer', code: 'H1', name: 'UPI' },
    offset: [{ account: 'IE611', amount: '1.00' }, { account: 'INTERBRANCH', amount: '99.00' }],
    applications: [{ doc: '25/S/900', party: 'H1', amount: '15.00', source: 'opening' }, { doc: '26/S/10', party: 'H1', amount: '60.00', source: 'smartpharma' }],
  };
  assert.equal(isDirect(p, res), false);
  const [pay, jnl] = voucherRequests(p, res, '460');
  assert.equal(pay.module, 'customerpayments');
  assert.deepEqual(pay.body, {
    customer_id: 'C1', payment_mode: 'banktransfer', amount: 100, date: '2026-05-01', reference_number: '460/26/J/000001',
    description: 'Receipt J/1 – UPI', account_id: 'CLR', location_id: 'LOC', invoices: [{ invoice_id: 'INV-900', amount_applied: 15 }],
  });
  assert.deepEqual(jnl.body.line_items.map((l) => [l.account_id, l.debit_or_credit, l.amount, l.customer_id]), [
    ['A-CH', 'debit', 1, undefined], ['A-IB', 'debit', 99, 'C-HO'], ['CLR', 'credit', 100, undefined],
  ]);
  assert.deepEqual(splitApplications(p, res).waiting.map((a) => a.doc), ['26/S/10']);
});

test('payment direct from cash; bill lines with exemption (none for an unregistered vendor); journal party line', () => {
  const pay = voucherRequests({ key: '26/Q/7', kind: 'payment', date: '2026-04-16', description: 'Payment Q/7', amount: '70.00', party: { side: 'vendor', code: 'V1' }, offset: [{ account: 'CASH', amount: '-70.00' }], applications: [{ doc: '25/K/29', party: 'V1', amount: '70.00', source: 'opening' }] }, res, '460');
  assert.equal(pay.length, 1);
  assert.equal(pay[0].body.paid_through_account_id, 'A-CASH');
  assert.deepEqual(pay[0].body.bills, [{ bill_id: 'BILL-29', amount_applied: 70 }]);

  const [bill] = voucherRequests({ key: '26/J/3', kind: 'bill', date: '2026-05-03', description: 'Bill', amount: '500.00', party: { side: 'vendor', code: 'V1' }, offset: [{ account: 'IE135', name: 'RENT', amount: '500.00' }] }, res, '460');
  assert.equal(bill.body.bill_number, '460/26/J/000003');
  assert.equal(bill.body.line_items[0].tax_exemption_id, 'EX');
  const [bill2] = voucherRequests({ key: '26/J/4', kind: 'bill', date: '2026-05-03', description: 'Bill', amount: '5.00', party: { side: 'vendor', code: 'V2' }, offset: [{ account: 'IE135', name: 'RENT', amount: '5.00' }] }, res, '460');
  assert.equal(bill2.body.line_items[0].tax_exemption_id, undefined);

  const [j] = voucherRequests({ key: '26/J/5', kind: 'journal', date: '2026-05-04', description: 'Adj', lines: [{ account: 'H1', code: 'H1', party: 'customer', amount: '-10.00' }, { account: 'CASH', amount: '10.00' }] }, res, '460');
  assert.deepEqual(j.body.line_items.map((l) => [l.account_id, l.debit_or_credit, l.customer_id]), [['AR', 'credit', 'C1'], ['A-CASH', 'debit', undefined]]);
});

test('creditRequests: debit note set off against a bill when both are in Books', () => {
  const out = creditRequests({ creditApplications: [{ credit: '25/I/3', doc: '25/K/29', party: 'V1', amount: '20.00' }, { credit: '25/I/9', doc: '25/K/29', party: 'V1', amount: '1.00' }] }, res);
  assert.deepEqual(out.map((c) => [c.path, c.body]), [['/vendorcredits/VC-3/bills', { bills: [{ bill_id: 'BILL-29', amount_applied: 20 }] }]]);
});

// ---- CLI against a fake Books ----------------------------------------------------------------

function fakeBooks({ contactAccount = 'AR' } = {}) {
  const posted = [];
  const store = { customerpayments: [], journals: [], vendorpayments: [], bills: [] };
  const accounts = [
    { account_id: 'A-UR', account_code: 'AL0069', account_name: 'Cheques in transit', account_type: 'other_current_asset' },
    { account_id: 'A-CH', account_code: 'IE215', account_name: 'UPI charges', account_type: 'expense' },
    { account_id: 'AR', account_code: 'FRP0013G', account_name: 'Sundry Debtors', account_type: 'accounts_receivable' },
    { account_id: 'AP', account_code: 'FRP0040G', account_name: 'Sundry Creditors', account_type: 'accounts_payable' },
    { account_id: 'CLR', account_code: 'CLR1', account_name: 'Opening Advances Clearing', account_type: 'cash' },
  ];
  const server = createServer((req, res2) => {
    const url = new URL(req.url, 'http://x');
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const send = (j) => { res2.writeHead(200, { 'content-type': 'application/json' }); res2.end(JSON.stringify({ code: 0, ...j })); };
      const p = url.pathname.replace('/books/v3', '');
      if (url.pathname === '/oauth/v2/token') return send({ access_token: 't', expires_in: 3600 });
      if (p === '/chartofaccounts') {
        const code = url.searchParams.get('account_code');
        const id = url.searchParams.get('account_id');
        return send({ chartofaccounts: accounts.filter((a) => (code ? a.account_code === code : a.account_id === id)) });
      }
      if (p.startsWith('/contacts/')) return send({ contact: { contact_id: p.split('/')[2], gst_treatment: 'consumer', account_id: contactAccount, account_name: contactAccount === 'AR' ? 'Sundry Debtors' : 'Accounts Receivable' } });
      if (p === '/contacts') return send({ contacts: [{ contact_id: 'C1', contact_name: 'UPI TERMINAL', gst_treatment: 'consumer' }], page_context: { has_more_page: false } });
      if (p === '/invoices') return send({ invoices: [{ invoice_id: 'INV-900', invoice_number: '460/25/S-900' }], page_context: { has_more_page: false } });
      const mod = p.slice(1);
      if (store[mod] && req.method === 'GET') return send({ [mod]: store[mod], page_context: { has_more_page: false } });
      if (store[mod] && req.method === 'POST') {
        const b = JSON.parse(body);
        const idKey = mod === 'journals' ? 'journal_id' : mod === 'bills' ? 'bill_id' : 'payment_id';
        const rec = { ...b, [idKey]: `${mod}-${store[mod].length + 1}` };
        store[mod].push(rec);
        posted.push([mod, b]);
        return send({ [mod.replace(/s$/, '')]: rec });
      }
      res2.writeHead(404, { 'content-type': 'application/json' });
      res2.end(JSON.stringify({ code: 1, message: `no route ${req.method} ${p}` }));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, posted, base: `http://127.0.0.1:${server.address().port}` })));
}

function run(args, base) {
  const env = {
    PATH: process.env.PATH, BOOKS_DRIVER: 'live', BOOKS_API_BASE: `${base}/books/v3`, BOOKS_ACCOUNTS_BASE: base,
    BOOKS_CLIENT_ID: 'c', BOOKS_CLIENT_SECRET: 's', BOOKS_REFRESH_TOKEN: 'r', BOOKS_REQUEST_TIMEOUT_MS: '5000',
    BOOKS_ORGANIZATION_ID: '60091274394', BOOKS_ORG_ALLOWLIST: '60091274394', POSTING_ENABLED: 'true', POSTING_AUTHORIZATION_REF: 'test-run',
  };
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['scripts/txn-post.js', ...args], { env });
    let text = '';
    child.stdout.on('data', (b) => { text += b; });
    child.stderr.on('data', (b) => { text += b; });
    const timer = setTimeout(() => child.kill(), 30_000);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, text }); });
  });
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'txn-post-'));
  const out = join(dir, 'txn');
  const opening = join(dir, 'opening');
  mkdirSync(out);
  mkdirSync(opening);
  writeFileSync(join(out, 'plan.json'), JSON.stringify({
    branch: '460', checks: [{ name: 'x', ok: true }], creditApplications: [],
    accounts: [{ account: 'UR_REC', name: 'CHQ RECD' }, { account: 'IE611', name: 'UPI CHARGES' }],
    postings: [{
      key: '26/J/1', kind: 'receipt', date: '2026-05-01', description: 'Receipt J/1 – UPI TERMINAL', amount: '100.00',
      party: { side: 'customer', code: 'H1', name: 'UPI TERMINAL', control: '002001' },
      offset: [{ account: 'IE611', amount: '1.00' }, { account: 'UR_REC', amount: '99.00' }],
      applications: [{ doc: '25/S/900', party: 'H1', amount: '15.00', source: 'opening' }], unapplied: '85.00',
    }],
  }));
  writeFileSync(join(out, 'accounts_zoho.csv'), 'account,eco_code,name,lines,zoho_code\nUR_REC,UR_REC,CHQ,1,AL0069\nIE611,IE611,UPI,1,IE215\n');
  writeFileSync(join(opening, 'plan.json'), JSON.stringify({
    locationId: 'LOC', documents: [{ kind: 'invoice', side: 'customer', partyCode: 'H1', partyName: 'UPI TERMINAL', controlCode: '002001', controlZoho: 'FRP0013G', number: '460/25/S-900', sourceRef: '25/S 900' }],
  }));
  return { out, opening };
}

test('txn-post preflight: a contact without its Eco Green group account stops the run (unless skipped)', async () => {
  const { out, opening } = fixture();
  const { server, base } = await fakeBooks({ contactAccount: 'DEFAULT-AR' });
  try {
    const args = ['preflight', '--out', out, '--opening', opening, '--account-map', join(out, 'accounts_zoho.csv'), '--clearing-account-id', 'CLR', '--tax-exemption-id', 'EX'];
    const pre = await run(args, base);
    assert.equal(pre.code, 1, pre.text);
    assert.match(pre.text, /1 contacts do not carry their Eco Green group's receivable \/ payable account/);
    assert.match(readFileSync(join(out, 'contact-controls.csv'), 'utf8'), /customer:H1,UPI TERMINAL,002001,FRP0013G Sundry Debtors,Accounts Receivable/);
    const skipped = await run([...args, '--contact-controls', 'skip'], base);
    assert.equal(skipped.code, 0, skipped.text);
  } finally {
    server.close();
  }
});

test('txn-post: preflight resolves, post creates payment + clearing journal, rerun finds them', async () => {
  const { out, opening } = fixture();
  const { server, posted, base } = await fakeBooks();
  try {
    const pre = await run(['preflight', '--out', out, '--opening', opening, '--account-map', join(out, 'accounts_zoho.csv'), '--clearing-account-id', 'CLR', '--tax-exemption-id', 'EX'], base);
    assert.equal(pre.code, 0, pre.text);
    const r = JSON.parse(readFileSync(join(out, 'resolution.json'), 'utf8'));
    assert.deepEqual(r.docs['25/S/900|H1'], { module: 'invoices', id: 'INV-900', number: '460/25/S-900' });
    assert.equal(r.contacts['customer:H1'], 'C1');

    const first = await run(['post', '--out', out, '--confirm-org', '60091274394'], base);
    assert.equal(first.code, 0, first.text);
    assert.deepEqual(posted.map(([m]) => m), ['customerpayments', 'journals']);
    assert.deepEqual(posted[0][1].invoices, [{ invoice_id: 'INV-900', amount_applied: 15 }]);
    assert.equal(posted[0][1].account_id, 'CLR');

    const again = await run(['post', '--out', out, '--confirm-org', '60091274394'], base);
    assert.equal(again.code, 0, again.text);
    assert.equal(posted.length, 2, 'nothing posted twice');
    assert.match(again.text, /posted 0, already in Books 2/);
  } finally {
    server.close();
  }
});
