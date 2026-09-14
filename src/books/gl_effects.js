// Pure double-entry GL-effect deriver for Books-shaped payloads (CONTRACTS.md §T
// shapes; src/core/transform.js#buildPayload is the producer and is NOT modified here).
//
// Why this exists: the balance bridge (src/core/balance_bridge.js, CONTRACTS.md §Y)
// must prove that whatever we post actually explains the movement Books reports. That
// requires knowing, for every payload we send to `client.create(module, payload)`, which
// real ledger accounts move and by how much — i.e. the same double-entry effect Books
// itself will record. This module derives that effect from the payload alone, using only
// fields defined in CONTRACTS.md §T, so both the mock Books driver (src/books/mock.js,
// so mock trial balances are real double-entry books) and the balance bridge (so
// "migration movement" is derived, not guessed) can share one definition of "what this
// posting does to the ledger".
//
// CAVEAT — PAYMENT_MODE proxy accounts (documented simplification, not a bug):
// vendor_payment/customer_payment payloads carry a `payment_mode` (e.g. "BANK", "CASH")
// but no GL cash/bank account id — config/mapping-rules.json only maps PAYMENT_MODE to a
// Books payment-mode enum value, not a chart-of-accounts id, and no such mapping rule
// type/approval exists yet. Until a PAYMENT_MODE -> LEDGER_ACCOUNT mapping is approved,
// the cash/bank leg of a payment is booked to a synthetic `PAYMENT_MODE:<mode>` account
// id, and every effect touching it carries `proxy: true` so callers (notably the balance
// bridge) can see at a glance that this leg is not tied to a real chart-of-accounts entry.

import { parseMoney, formatMoney, add, ZERO } from '../core/money.js';

export class GlEffectsError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function eff(accountId, debit, credit, proxy = false) {
  const out = { account_id: accountId, debit: formatMoney(debit), credit: formatMoney(credit) };
  if (proxy) out.proxy = true;
  return out;
}

function lineAmount(li) {
  return parseMoney(li.amount ?? '0.00');
}

function sumLineAmounts(lineItems) {
  return (lineItems ?? []).reduce((t, li) => add(t, lineAmount(li)), ZERO);
}

function assertBalanced(module, effects) {
  const totalDebit = effects.reduce((t, e) => add(t, parseMoney(e.debit)), ZERO);
  const totalCredit = effects.reduce((t, e) => add(t, parseMoney(e.credit)), ZERO);
  if (totalDebit !== totalCredit) {
    throw new GlEffectsError(
      'GL_EFFECTS_UNBALANCED',
      `${module} GL effects do not balance: debit=${formatMoney(totalDebit)} credit=${formatMoney(totalCredit)} (${JSON.stringify(effects)})`,
    );
  }
}

/**
 * Pure. Derives the double-entry GL effect of posting `payload` to Books module
 * `module`, using only fields present in the payload (CONTRACTS.md §T shapes).
 *
 * @param {string} module  one of: journal | bill | vendor_credit | credit_note |
 *                          vendor_payment | customer_payment | expense | bank_transfer
 * @param {object} payload the Books-shaped payload (src/core/transform.js#buildPayload
 *                          output, or an equivalent already-posted record's stored shape)
 * @returns {Array<{account_id: string, debit: string, credit: string, proxy?: true}>}
 *          money as "x.yy" strings. Always balances (Sigma debit === Sigma credit).
 * @throws {GlEffectsError} code 'GL_EFFECTS_UNBALANCED' if the derived effects do not
 *                           balance, or 'GL_EFFECTS_UNKNOWN_MODULE' for an unrecognised
 *                           module.
 */
export function glEffects(module, payload) {
  let effects;

  switch (module) {
    case 'journal': {
      effects = (payload.line_items ?? []).map((li) => eff(
        li.account,
        parseMoney(li.debit ?? '0.00'),
        parseMoney(li.credit ?? '0.00'),
      ));
      break;
    }

    case 'bill': {
      const lineEffects = (payload.line_items ?? []).map((li) => eff(li.account, lineAmount(li), ZERO));
      const total = sumLineAmounts(payload.line_items);
      effects = [...lineEffects, eff(`CONTACT:${payload.vendor}`, ZERO, total)];
      break;
    }

    case 'vendor_credit': {
      const lineEffects = (payload.line_items ?? []).map((li) => eff(li.account, ZERO, lineAmount(li)));
      const total = sumLineAmounts(payload.line_items);
      effects = [...lineEffects, eff(`CONTACT:${payload.contact}`, total, ZERO)];
      break;
    }

    case 'credit_note': {
      const lineEffects = (payload.line_items ?? []).map((li) => eff(li.account, lineAmount(li), ZERO));
      const total = sumLineAmounts(payload.line_items);
      effects = [...lineEffects, eff(`CONTACT:${payload.contact}`, ZERO, total)];
      break;
    }

    case 'vendor_payment': {
      const amount = parseMoney(payload.amount ?? '0.00');
      effects = [
        eff(`CONTACT:${payload.contact}`, amount, ZERO),
        eff(`PAYMENT_MODE:${payload.payment_mode}`, ZERO, amount, true),
      ];
      break;
    }

    case 'customer_payment': {
      const amount = parseMoney(payload.amount ?? '0.00');
      effects = [
        eff(`PAYMENT_MODE:${payload.payment_mode}`, amount, ZERO, true),
        eff(`CONTACT:${payload.contact}`, ZERO, amount),
      ];
      break;
    }

    case 'expense': {
      const amount = parseMoney(payload.amount ?? '0.00');
      effects = [
        eff(payload.account, amount, ZERO),
        eff(payload.paid_through, ZERO, amount),
      ];
      break;
    }

    case 'bank_transfer': {
      const amount = parseMoney(payload.amount ?? '0.00');
      effects = [
        eff(payload.to_account, amount, ZERO),
        eff(payload.from_account, ZERO, amount),
      ];
      break;
    }

    default:
      throw new GlEffectsError('GL_EFFECTS_UNKNOWN_MODULE', `Unknown target module for GL effects: ${module}`);
  }

  assertBalanced(module, effects);
  return effects;
}
