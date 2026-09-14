import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { glEffects, GlEffectsError } from '../src/books/gl_effects.js';
import { parseMoney } from '../src/core/money.js';

function totalDebit(effects) { return effects.reduce((t, e) => t + parseMoney(e.debit), 0n); }
function totalCredit(effects) { return effects.reduce((t, e) => t + parseMoney(e.credit), 0n); }

function assertBalancedMoneyStrings(effects) {
  for (const e of effects) {
    assert.equal(typeof e.debit, 'string');
    assert.equal(typeof e.credit, 'string');
    assert.match(e.debit, /^\d+\.\d{2}$/);
    assert.match(e.credit, /^\d+\.\d{2}$/);
  }
  assert.equal(totalDebit(effects), totalCredit(effects));
}

describe('glEffects (pure)', () => {
  test('journal: each line posts its own debit/credit as given', () => {
    const effects = glEffects('journal', {
      line_items: [
        { account: 'ZB-ACC-1001', debit: '100.00' },
        { account: 'ZB-ACC-1003', credit: '100.00' },
      ],
    });
    assert.deepEqual(effects, [
      { account_id: 'ZB-ACC-1001', debit: '100.00', credit: '0.00' },
      { account_id: 'ZB-ACC-1003', debit: '0.00', credit: '100.00' },
    ]);
    assertBalancedMoneyStrings(effects);
  });

  test('bill: line_items are debited, CONTACT:<vendor> is credited for the total', () => {
    const effects = glEffects('bill', {
      vendor: 'ZB-CONTACT-001',
      line_items: [{ account: 'ZB-ACC-1004', amount: '60.00' }, { account: 'ZB-ACC-1007', amount: '40.00' }],
    });
    assertBalancedMoneyStrings(effects);
    const contact = effects.find((e) => e.account_id === 'CONTACT:ZB-CONTACT-001');
    assert.equal(contact.credit, '100.00');
    assert.equal(contact.debit, '0.00');
    assert.equal(effects.find((e) => e.account_id === 'ZB-ACC-1004').debit, '60.00');
  });

  test('vendor_credit: line_items are credited, CONTACT:<contact> is debited for the total', () => {
    const effects = glEffects('vendor_credit', {
      contact: 'ZB-CONTACT-002',
      line_items: [{ account: 'ZB-ACC-1004', amount: '25.00' }],
    });
    assertBalancedMoneyStrings(effects);
    assert.deepEqual(effects, [
      { account_id: 'ZB-ACC-1004', debit: '0.00', credit: '25.00' },
      { account_id: 'CONTACT:ZB-CONTACT-002', debit: '25.00', credit: '0.00' },
    ]);
  });

  test('credit_note: line_items are debited, CONTACT:<contact> is credited for the total', () => {
    const effects = glEffects('credit_note', {
      contact: 'ZB-CONTACT-C001',
      line_items: [{ account: 'ZB-ACC-1003', amount: '15.00' }],
    });
    assertBalancedMoneyStrings(effects);
    assert.deepEqual(effects, [
      { account_id: 'ZB-ACC-1003', debit: '15.00', credit: '0.00' },
      { account_id: 'CONTACT:ZB-CONTACT-C001', debit: '0.00', credit: '15.00' },
    ]);
  });

  test('vendor_payment: debits CONTACT:<contact>, credits the PAYMENT_MODE proxy (marked proxy:true)', () => {
    const effects = glEffects('vendor_payment', { contact: 'ZB-CONTACT-001', amount: '500.00', payment_mode: 'ZB-PAYMENT-MODE-BANK' });
    assertBalancedMoneyStrings(effects);
    assert.deepEqual(effects, [
      { account_id: 'CONTACT:ZB-CONTACT-001', debit: '500.00', credit: '0.00' },
      { account_id: 'PAYMENT_MODE:ZB-PAYMENT-MODE-BANK', debit: '0.00', credit: '500.00', proxy: true },
    ]);
  });

  test('customer_payment: debits the PAYMENT_MODE proxy (marked proxy:true), credits CONTACT:<contact>', () => {
    const effects = glEffects('customer_payment', { contact: 'ZB-CONTACT-C001', amount: '250.00', payment_mode: 'ZB-PAYMENT-MODE-UPI' });
    assertBalancedMoneyStrings(effects);
    assert.deepEqual(effects, [
      { account_id: 'PAYMENT_MODE:ZB-PAYMENT-MODE-UPI', debit: '250.00', credit: '0.00', proxy: true },
      { account_id: 'CONTACT:ZB-CONTACT-C001', debit: '0.00', credit: '250.00' },
    ]);
  });

  test('expense: debits account, credits paid_through', () => {
    const effects = glEffects('expense', { account: 'ZB-ACC-1007', paid_through: 'ZB-ACC-1001', amount: '75.00' });
    assertBalancedMoneyStrings(effects);
    assert.deepEqual(effects, [
      { account_id: 'ZB-ACC-1007', debit: '75.00', credit: '0.00' },
      { account_id: 'ZB-ACC-1001', debit: '0.00', credit: '75.00' },
    ]);
  });

  test('bank_transfer: debits to_account, credits from_account', () => {
    const effects = glEffects('bank_transfer', { from_account: 'ZB-ACC-1001', to_account: 'ZB-ACC-1002', amount: '300.00' });
    assertBalancedMoneyStrings(effects);
    assert.deepEqual(effects, [
      { account_id: 'ZB-ACC-1002', debit: '300.00', credit: '0.00' },
      { account_id: 'ZB-ACC-1001', debit: '0.00', credit: '300.00' },
    ]);
  });

  test('an unbalanced journal throws GlEffectsError{code: GL_EFFECTS_UNBALANCED}', () => {
    assert.throws(
      () => glEffects('journal', { line_items: [{ account: 'A', debit: '10.00' }, { account: 'B', credit: '9.00' }] }),
      (err) => {
        assert.ok(err instanceof GlEffectsError);
        assert.equal(err.code, 'GL_EFFECTS_UNBALANCED');
        return true;
      },
    );
  });

  test('an unknown module throws GlEffectsError{code: GL_EFFECTS_UNKNOWN_MODULE}', () => {
    assert.throws(
      () => glEffects('not_a_real_module', {}),
      (err) => {
        assert.ok(err instanceof GlEffectsError);
        assert.equal(err.code, 'GL_EFFECTS_UNKNOWN_MODULE');
        return true;
      },
    );
  });

  test('every module returns money as "x.yy" strings (never Number/BigInt)', () => {
    const modules = [
      ['journal', { line_items: [{ account: 'A', debit: '1.00' }, { account: 'B', credit: '1.00' }] }],
      ['bill', { vendor: 'V', line_items: [{ account: 'A', amount: '1.00' }] }],
      ['expense', { account: 'A', paid_through: 'B', amount: '1.00' }],
      ['bank_transfer', { from_account: 'A', to_account: 'B', amount: '1.00' }],
    ];
    for (const [module, payload] of modules) {
      assertBalancedMoneyStrings(glEffects(module, payload));
    }
  });
});
