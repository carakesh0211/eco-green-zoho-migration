import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildPayload, humanSummary, UnmappedEntityError, InvalidRouteError } from '../src/core/transform.js';
import { hashCanonical } from '../src/core/hash.js';

function approvedRule(overrides) {
  return { effective_from: '2026-01-01', effective_to: null, status: 'APPROVED', mapping_version: 'map_v1', ...overrides };
}

const BASE_RULES = [
  approvedRule({ rule_type: 'PARTY', source_key: 'V-PARTY-007', target_value: 'CONTACT-707' }),
  approvedRule({ rule_type: 'LEDGER_ACCOUNT', source_key: 'LEDG-EXP', target_value: 'ACC-EXP' }),
  approvedRule({ rule_type: 'LEDGER_ACCOUNT', source_key: 'LEDG-EXP2', target_value: 'ACC-EXP2' }),
  approvedRule({ rule_type: 'LEDGER_ACCOUNT', source_key: 'LEDG-CASH', target_value: 'ACC-CASH' }),
  approvedRule({ rule_type: 'LEDGER_ACCOUNT', source_key: 'LEDG-BANK', target_value: 'ACC-BANK' }),
  approvedRule({ rule_type: 'LEDGER_ACCOUNT', source_key: 'LEDG-SALES', target_value: 'ACC-SALES' }),
  approvedRule({ rule_type: 'PAYMENT_MODE', source_key: 'CASH', target_value: 'Cash' }),
  approvedRule({ rule_type: 'TAX', source_key: 'GST5', target_value: 'TAX-GST5' }),
];

function voucher(overrides = {}) {
  return {
    source_transaction_type: 'PURCHASE',
    transaction_date: '2026-04-03',
    zoho_location_id: 'LOC-1',
    party_code: 'V-PARTY-007',
    payment_method: 'CASH',
    source_transaction_hash: 'HASH-1',
    source_document_no: 'V-PARTY-007',
    debit_total: '12340.00',
    credit_total: '12340.00',
    tax_bucket: 'GST5',
    narration: null,
    ...overrides,
  };
}

describe('buildPayload module shapes', () => {
  test('bill', () => {
    const lines = [
      { ledger_code: 'LEDG-EXP', debit: '12000.00', credit: '0.00', tax_bucket: 'GST5' },
      { ledger_code: 'LEDG-EXP2', debit: '340.00', credit: '0.00', tax_bucket: 'GST5' },
      { ledger_code: 'LEDG-PAYABLE', debit: '0.00', credit: '12340.00' }, // party leg, excluded
    ];
    const payload = buildPayload({ module: 'bill', voucher: voucher(), lines, rules: BASE_RULES });
    assert.equal(payload.vendor, 'CONTACT-707');
    assert.equal(payload.date, '2026-04-03');
    assert.deepEqual(payload.line_items, [
      { account: 'ACC-EXP', amount: '12000.00', tax: 'TAX-GST5' },
      { account: 'ACC-EXP2', amount: '340.00', tax: 'TAX-GST5' },
    ]);
    assert.equal(payload.location_id, 'LOC-1');
    assert.equal(payload.reference_number, 'V-PARTY-007');
    assert.deepEqual(payload.custom_fields, { cf_migration_source_hash: 'HASH-1', cf_migration_batch: null });
    assert.equal(humanSummary('bill', payload), 'bill V-PARTY-007 2026-04-03 ₹12,340.00 (2 lines)');
  });

  test('vendor_payment', () => {
    const v = voucher({ source_transaction_type: 'PAYMENT', source_document_no: 'PAY-001', debit_total: '500.00', credit_total: '500.00' });
    const payload = buildPayload({ module: 'vendor_payment', voucher: v, lines: [], rules: BASE_RULES });
    assert.equal(payload.contact, 'CONTACT-707');
    assert.equal(payload.amount, '500.00');
    assert.equal(payload.payment_mode, 'Cash');
    assert.equal(payload.reference, 'PAY-001');
    assert.equal(payload.reference_number, 'PAY-001');
    assert.equal(payload.location_id, 'LOC-1');
  });

  test('customer_payment', () => {
    const v = voucher({ source_transaction_type: 'RECEIPT', source_document_no: 'RCPT-001', debit_total: '500.00', credit_total: '500.00' });
    const payload = buildPayload({ module: 'customer_payment', voucher: v, lines: [], rules: BASE_RULES });
    assert.equal(payload.contact, 'CONTACT-707');
    assert.equal(payload.payment_mode, 'Cash');
    assert.equal(payload.amount, '500.00');
  });

  test('expense (with optional vendor when party_code present, omitted when absent)', () => {
    const lines = [
      { ledger_code: 'LEDG-EXP', debit: '750.00', credit: '0.00' },
      { ledger_code: 'LEDG-CASH', debit: '0.00', credit: '750.00' },
    ];
    const v = voucher({ source_transaction_type: 'EXPENSE', source_document_no: 'EXP-001', debit_total: '750.00', credit_total: '750.00', party_code: null, tax_bucket: null });
    const payload = buildPayload({ module: 'expense', voucher: v, lines, rules: BASE_RULES });
    assert.equal(payload.account, 'ACC-EXP');
    assert.equal(payload.paid_through, 'ACC-CASH');
    assert.equal(payload.amount, '750.00');
    assert.equal('vendor' in payload, false);

    const v2 = { ...v, party_code: 'V-PARTY-007' };
    const payload2 = buildPayload({ module: 'expense', voucher: v2, lines, rules: BASE_RULES });
    assert.equal(payload2.vendor, 'CONTACT-707');
  });

  test('credit_note', () => {
    const lines = [
      { ledger_code: 'LEDG-SALES', debit: '200.00', credit: '0.00' },      // revenue reversal (content)
      { ledger_code: 'LEDG-RECEIVABLE', debit: '0.00', credit: '200.00' }, // customer leg, excluded
    ];
    const v = voucher({ source_transaction_type: 'CREDIT_NOTE', source_document_no: 'CN-001', tax_bucket: null });
    const payload = buildPayload({ module: 'credit_note', voucher: v, lines, rules: BASE_RULES });
    assert.equal(payload.contact, 'CONTACT-707');
    assert.deepEqual(payload.line_items, [{ account: 'ACC-SALES', amount: '200.00' }]);
  });

  test('vendor_credit', () => {
    const lines = [
      { ledger_code: 'LEDG-PAYABLE', debit: '150.00', credit: '0.00' }, // vendor leg, excluded
      { ledger_code: 'LEDG-EXP', debit: '0.00', credit: '150.00' },     // expense reversal (content)
    ];
    const v = voucher({ source_transaction_type: 'DEBIT_NOTE', source_document_no: 'DN-001', tax_bucket: null });
    const payload = buildPayload({ module: 'vendor_credit', voucher: v, lines, rules: BASE_RULES });
    assert.equal(payload.contact, 'CONTACT-707');
    assert.deepEqual(payload.line_items, [{ account: 'ACC-EXP', amount: '150.00' }]);
  });

  test('bank_transfer', () => {
    const lines = [
      { ledger_code: 'LEDG-BANK', debit: '2000.00', credit: '0.00' },
      { ledger_code: 'LEDG-CASH', debit: '0.00', credit: '2000.00' },
    ];
    const v = voucher({ source_transaction_type: 'CONTRA', source_document_no: 'CTR-001', party_code: null, tax_bucket: null, debit_total: '2000.00', credit_total: '2000.00' });
    const payload = buildPayload({ module: 'bank_transfer', voucher: v, lines, rules: BASE_RULES });
    assert.equal(payload.to_account, 'ACC-BANK');
    assert.equal(payload.from_account, 'ACC-CASH');
    assert.equal(payload.amount, '2000.00');
    assert.equal(payload.reference, 'CTR-001');
  });

  test('journal (pure JOURNAL type, no fallback warning)', () => {
    const lines = [
      { ledger_code: 'LEDG-EXP', debit: '100.00', credit: '0.00' },
      { ledger_code: 'LEDG-CASH', debit: '0.00', credit: '100.00' },
    ];
    const v = voucher({ source_transaction_type: 'JOURNAL', source_document_no: 'JNL-001', party_code: null, tax_bucket: null, narration: 'Adjustment entry' });
    const payload = buildPayload({ module: 'journal', voucher: v, lines, rules: BASE_RULES });
    assert.deepEqual(payload.line_items, [
      { account: 'ACC-EXP', debit: '100.00' },
      { account: 'ACC-CASH', credit: '100.00' },
    ]);
    assert.equal(payload.notes, 'Adjustment entry');
    assert.equal(payload.warnings, undefined);
    assert.equal(humanSummary('journal', payload), 'journal JNL-001 2026-04-03 ₹200.00 (2 lines)');
  });
});

describe('journal fallback routing', () => {
  const lines = [
    { ledger_code: 'LEDG-CASH', debit: '1000.00', credit: '0.00' },
    { ledger_code: 'LEDG-SALES', debit: '0.00', credit: '1000.00' },
  ];
  const v = voucher({ source_transaction_type: 'SALES_B2C', source_document_no: 'SB2C-01', party_code: null, tax_bucket: null });

  test('non-JOURNAL type routed to journal WITH an approved rule carrying notes -> warning + accepted', () => {
    const rules = [
      ...BASE_RULES,
      approvedRule({ rule_type: 'MODULE_ROUTE', source_key: 'SALES_B2C', target_value: 'journal', notes: 'Finance-approved: SALES_B2C summarised as a journal per rule SP-J1.' }),
    ];
    const payload = buildPayload({ module: 'journal', voucher: v, lines, rules });
    assert.ok(payload.warnings.includes('JOURNAL_FALLBACK_RULE'));
  });

  test('non-JOURNAL type routed to journal with a rule that has EMPTY notes -> InvalidRouteError', () => {
    const rules = [
      ...BASE_RULES,
      approvedRule({ rule_type: 'MODULE_ROUTE', source_key: 'SALES_B2C', target_value: 'journal', notes: '   ' }),
    ];
    assert.throws(
      () => buildPayload({ module: 'journal', voucher: v, lines, rules }),
      (err) => err instanceof InvalidRouteError && err.code === 'INVALID_TARGET_TYPE',
    );
  });

  test('non-JOURNAL type routed to journal with NO MODULE_ROUTE rule at all -> InvalidRouteError', () => {
    assert.throws(
      () => buildPayload({ module: 'journal', voucher: v, lines, rules: BASE_RULES }),
      (err) => err instanceof InvalidRouteError,
    );
  });
});

describe('buildPayload unmapped entity errors', () => {
  test('missing zoho_location_id', () => {
    const v = voucher({ zoho_location_id: null });
    assert.throws(
      () => buildPayload({ module: 'bill', voucher: v, lines: [{ ledger_code: 'LEDG-EXP', debit: '1.00', credit: '0.00' }, { ledger_code: 'LEDG-PAYABLE', debit: '0.00', credit: '1.00' }], rules: BASE_RULES }),
      (err) => err instanceof UnmappedEntityError && err.code === 'UNMAPPED_ENTITY' && err.sourceKey === 'zoho_location_id',
    );
  });

  test('missing PARTY rule', () => {
    const v = voucher({ party_code: 'UNKNOWN-PARTY' });
    assert.throws(
      () => buildPayload({ module: 'bill', voucher: v, lines: [{ ledger_code: 'LEDG-EXP', debit: '1.00', credit: '0.00' }, { ledger_code: 'LEDG-PAYABLE', debit: '0.00', credit: '1.00' }], rules: BASE_RULES }),
      (err) => err instanceof UnmappedEntityError && err.ruleType === 'PARTY' && err.sourceKey === 'UNKNOWN-PARTY',
    );
  });

  test('missing LEDGER_ACCOUNT rule', () => {
    const v = voucher();
    assert.throws(
      () => buildPayload({ module: 'bill', voucher: v, lines: [{ ledger_code: 'LEDG-UNKNOWN', debit: '1.00', credit: '0.00' }, { ledger_code: 'LEDG-PAYABLE', debit: '0.00', credit: '1.00' }], rules: BASE_RULES }),
      (err) => err instanceof UnmappedEntityError && err.ruleType === 'LEDGER_ACCOUNT' && err.sourceKey === 'LEDG-UNKNOWN',
    );
  });

  test('missing PAYMENT_MODE rule', () => {
    const v = voucher({ source_transaction_type: 'PAYMENT', payment_method: 'WALLET' });
    assert.throws(
      () => buildPayload({ module: 'vendor_payment', voucher: v, lines: [], rules: BASE_RULES }),
      (err) => err instanceof UnmappedEntityError && err.ruleType === 'PAYMENT_MODE' && err.sourceKey === 'WALLET',
    );
  });

  test('missing TAX rule', () => {
    const v = voucher({ tax_bucket: 'GST18' });
    assert.throws(
      () => buildPayload({ module: 'bill', voucher: v, lines: [{ ledger_code: 'LEDG-EXP', debit: '1.00', credit: '0.00' }, { ledger_code: 'LEDG-PAYABLE', debit: '0.00', credit: '1.00' }], rules: BASE_RULES }),
      (err) => err instanceof UnmappedEntityError && err.ruleType === 'TAX' && err.sourceKey === 'GST18',
    );
  });
});

describe('payload determinism and money representation', () => {
  test('identical inputs (different key order) hash identically via hashCanonical', () => {
    const lines = [{ ledger_code: 'LEDG-EXP', debit: '100.00', credit: '0.00' }, { ledger_code: 'LEDG-PAYABLE', debit: '0.00', credit: '100.00' }];
    const vA = voucher({ debit_total: '100.00', credit_total: '100.00' });
    const base = voucher({ debit_total: '100.00', credit_total: '100.00' });
    const vB = { credit_total: base.credit_total, debit_total: base.debit_total, ...base }; // different key order, same values
    const p1 = buildPayload({ module: 'bill', voucher: vA, lines, rules: BASE_RULES });
    const p2 = buildPayload({ module: 'bill', voucher: vB, lines, rules: BASE_RULES });
    assert.equal(hashCanonical(p1), hashCanonical(p2));
  });

  test('changing a line amount changes the hash', () => {
    const linesA = [{ ledger_code: 'LEDG-EXP', debit: '100.00', credit: '0.00' }, { ledger_code: 'LEDG-PAYABLE', debit: '0.00', credit: '100.00' }];
    const linesB = [{ ledger_code: 'LEDG-EXP', debit: '101.00', credit: '0.00' }, { ledger_code: 'LEDG-PAYABLE', debit: '0.00', credit: '101.00' }];
    const p1 = buildPayload({ module: 'bill', voucher: voucher(), lines: linesA, rules: BASE_RULES });
    const p2 = buildPayload({ module: 'bill', voucher: voucher(), lines: linesB, rules: BASE_RULES });
    assert.notEqual(hashCanonical(p1), hashCanonical(p2));
  });

  test('money fields are strings, never JS numbers', () => {
    const lines = [{ ledger_code: 'LEDG-EXP', debit: '100.50', credit: '0.00' }, { ledger_code: 'LEDG-PAYABLE', debit: '0.00', credit: '100.50' }];
    const payload = buildPayload({ module: 'bill', voucher: voucher(), lines, rules: BASE_RULES });
    assert.equal(typeof payload.line_items[0].amount, 'string');
    assert.equal(payload.line_items[0].amount, '100.50');

    const payV = buildPayload({ module: 'vendor_payment', voucher: voucher({ source_transaction_type: 'PAYMENT' }), lines: [], rules: BASE_RULES });
    assert.equal(typeof payV.amount, 'string');
  });
});


describe('contact modules never double-count the party leg (regression)', () => {
  test('bill total equals voucher total, payable ledger is not a line item', () => {
    const lines = [
      { ledger_code: 'LEDG-EXP', debit: '100.00', credit: '0.00' },
      { ledger_code: 'LEDG-PAYABLE', debit: '0.00', credit: '100.00' },
    ];
    const v = voucher({ debit_total: '100.00', credit_total: '100.00', tax_bucket: null });
    const payload = buildPayload({ module: 'bill', voucher: v, lines, rules: BASE_RULES });
    assert.equal(payload.line_items.length, 1);
    assert.equal(payload.line_items[0].amount, '100.00');
    assert.ok(!payload.line_items.some(li => li.account === 'ACC-PAYABLE'));
  });

  test('bill whose content legs do not tie to party legs is rejected', () => {
    const lines = [
      { ledger_code: 'LEDG-EXP', debit: '100.00', credit: '0.00' },
      { ledger_code: 'LEDG-PAYABLE', debit: '0.00', credit: '90.00' },
    ];
    assert.throws(
      () => buildPayload({ module: 'bill', voucher: voucher({ tax_bucket: null }), lines, rules: BASE_RULES }),
      (err) => err instanceof InvalidRouteError,
    );
  });

  test('bill with no party leg is rejected', () => {
    const lines = [{ ledger_code: 'LEDG-EXP', debit: '100.00', credit: '0.00' }];
    assert.throws(
      () => buildPayload({ module: 'bill', voucher: voucher({ tax_bucket: null }), lines, rules: BASE_RULES }),
      (err) => err instanceof InvalidRouteError,
    );
  });
});

describe('InvalidRouteError carries a usable diagnostic (regression)', () => {
  test('the ledger-shape guards report module and reason, not "undefined -> undefined"', () => {
    const lines = [{ ledger_code: 'LEDG-EXP', debit: '100.00', credit: '0.00' }];
    let thrown;
    try { buildPayload({ module: 'bill', voucher: voucher({ tax_bucket: null }), lines, rules: BASE_RULES }); }
    catch (err) { thrown = err; }
    assert.ok(thrown instanceof InvalidRouteError);
    assert.equal(thrown.code, 'INVALID_TARGET_TYPE');
    assert.equal(thrown.module, 'bill');
    assert.match(thrown.message, /content side and a party side/);
    assert.doesNotMatch(thrown.message, /undefined/);
  });

  test('a bare string reason still yields a readable message', () => {
    const e = new InvalidRouteError('something specific went wrong');
    assert.match(e.message, /something specific went wrong/);
    assert.doesNotMatch(e.message, /undefined/);
  });
});
