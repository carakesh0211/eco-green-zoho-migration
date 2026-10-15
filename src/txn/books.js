// Zoho Books request bodies for the transaction plan (src/txn/plan.js). Pure functions: every id
// comes from the preflight resolution `res`:
//   res.locationId, res.clearingAccountId (cash/bank), res.taxExemptionId
//   res.accountMap   eco ledger key -> Zoho account code       (accounts_zoho.csv)
//   res.accounts     Zoho account code -> { account_id, type, name }
//   res.contacts     "customer:H1" / "vendor:V1" -> contact_id ("customer:000" = HO / inter-branch)
//   res.controls     same keys -> receivable / payable account_id for journal party lines
//   res.gstTreatment same keys -> Books gst_treatment (vendors on bills)
//   res.docs         "<doc key>|<party>" -> { module, id }   documents payments are applied to
import { formatMoney } from '../core/money.js';
import { toPaise, INTER_BRANCH, INTER_BRANCH_CONTACT } from './plan.js';

export class TxnPostError extends Error {
  constructor(message) { super(message); this.code = 'TXN_POST'; }
}

export const BOOKS_NUMBER_MAX = 16;
const paise = (v) => (typeof v === 'bigint' ? v : toPaise(v));
const rupees = (v) => Number(formatMoney(paise(v)));
const UNREGISTERED = new Set(['business_none', 'consumer']);
const CASH_OR_BANK = /^(cash|bank)$/;
const CLEARING = 'CLEARING';

/** Eco Green voucher "26/S/2474" -> Books number "460/26/S/002474" (Smart Pharma's convention too). */
export function booksNumber(branch, key) {
  const [yy, prefix, no] = key.split('/');
  const n = no.startsWith('-') ? `-${no.slice(1).padStart(6, '0')}` : no.padStart(6, '0');
  return `${branch}/${yy}/${prefix}/${n}`;
}

const partyKey = (side, code) => `${side}:${code}`;

function accountId(res, ecoKey) {
  const code = res.accountMap[ecoKey];
  if (!code) throw new TxnPostError(`ledger ${ecoKey} has no Zoho account code (accounts_zoho.csv)`);
  const a = res.accounts[code];
  if (!a) throw new TxnPostError(`Zoho account ${code} (for ${ecoKey}) not resolved; rerun preflight`);
  return a.account_id;
}
function contactId(res, key) {
  const id = res.contacts[key];
  if (!id) throw new TxnPostError(`no Books contact for ${key}; rerun preflight`);
  return id;
}

/** True when the voucher's single counter-entry is a cash / bank account Books can deposit to / pay from. */
export function isDirect(p, res) {
  if (p.offset.length !== 1) return false;
  const code = res.accountMap[p.offset[0].account];
  return Boolean(code && CASH_OR_BANK.test(res.accounts[code]?.type ?? ''));
}

/** Applications that can be made now (document already in Books) and those waiting (pass 2). */
export function splitApplications(p, res) {
  const now = [];
  const waiting = [];
  for (const a of p.applications ?? []) {
    const d = res.docs[`${a.doc}|${a.party}`];
    if (d) now.push({ ...a, ...d });
    else waiting.push(a);
  }
  return { now, waiting };
}

/** One journal line. Party / HO lines go to their receivable or payable account with the contact. */
function journalLine(res, l, description) {
  const amount = paise(l.amount);
  const base = { debit_or_credit: amount > 0n ? 'debit' : 'credit', amount: rupees(amount < 0n ? -amount : amount), description };
  if (l.party) {
    const key = partyKey(l.party, l.code);
    const control = res.controls[key];
    if (!control) throw new TxnPostError(`no receivable / payable account for ${key}; rerun preflight`);
    return { ...base, account_id: control, customer_id: contactId(res, key) };
  }
  if (l.account === CLEARING) {
    if (!res.clearingAccountId) throw new TxnPostError('the clearing account is not resolved (preflight --clearing-account-id)');
    return { ...base, account_id: res.clearingAccountId };
  }
  if (l.account === INTER_BRANCH) return { ...base, account_id: accountId(res, l.account), customer_id: contactId(res, partyKey('customer', INTER_BRANCH_CONTACT)) };
  return { ...base, account_id: accountId(res, l.account) };
}

const journalBody = (p, res, reference, lines) => ({
  journal_date: p.date, reference_number: reference, notes: p.description, location_id: res.locationId,
  line_items: lines.map((l) => journalLine(res, l, p.description)),
});

/**
 * Books requests for one planned voucher, in posting order:
 *   [{ part: 'bill' | 'payment' | 'journal', module, body }]
 * Receipts / payments with more than one counter-entry (or a non cash / bank one) go through the
 * clearing account, and a journal moves the clearing amount to the voucher's own ledgers.
 */
export function voucherRequests(p, res, branch) {
  const reference = booksNumber(branch, p.key);
  if (p.kind === 'journal') return [{ part: 'journal', module: 'journals', body: journalBody(p, res, reference, p.lines) }];

  const key = partyKey(p.party.side, p.party.code);
  const amount = paise(p.amount);
  if (p.kind === 'bill') {
    if (reference.length > BOOKS_NUMBER_MAX) throw new TxnPostError(`${p.key}: bill number ${reference} is longer than ${BOOKS_NUMBER_MAX}`);
    if (p.offset.some((o) => paise(o.amount) <= 0n)) throw new TxnPostError(`${p.key}: a bill line would be a credit; post this voucher as a journal`);
    const exempt = res.taxExemptionId && !UNREGISTERED.has(res.gstTreatment?.[key]) ? { tax_exemption_id: res.taxExemptionId } : {};
    return [{
      part: 'bill', module: 'bills', body: {
        vendor_id: contactId(res, key), bill_number: reference, reference_number: reference, date: p.date, due_date: p.date,
        notes: p.description, location_id: res.locationId,
        line_items: p.offset.map((o) => ({ account_id: accountId(res, o.account), description: o.name, rate: rupees(o.amount), quantity: 1, ...exempt })),
      },
    }];
  }

  const direct = isDirect(p, res);
  const through = direct ? accountId(res, p.offset[0].account) : res.clearingAccountId;
  if (!through) throw new TxnPostError(`${p.key}: needs the clearing account (preflight --clearing-account-id)`);
  const { now } = splitApplications(p, res);
  const out = [];
  if (p.kind === 'receipt') {
    out.push({
      part: 'payment', module: 'customerpayments', body: {
        customer_id: contactId(res, key), payment_mode: 'banktransfer', amount: rupees(amount), date: p.date,
        reference_number: reference, description: p.description, account_id: through, location_id: res.locationId,
        invoices: now.map((a) => ({ invoice_id: a.id, amount_applied: rupees(a.amount) })),
      },
    });
    // clearing -> the voucher's own debits (bank, charges, HO, TDS ...)
    if (!direct) out.push({ part: 'journal', module: 'journals', body: journalBody(p, res, reference, [...p.offset, { account: CLEARING, amount: -amount }]) });
  } else if (p.kind === 'payment') {
    out.push({
      part: 'payment', module: 'vendorpayments', body: {
        vendor_id: contactId(res, key), payment_mode: 'banktransfer', amount: rupees(amount), date: p.date,
        reference_number: reference, description: p.description, paid_through_account_id: through, location_id: res.locationId,
        bills: now.map((a) => ({ bill_id: a.id, amount_applied: rupees(a.amount) })),
      },
    });
    if (!direct) out.push({ part: 'journal', module: 'journals', body: journalBody(p, res, reference, [{ account: CLEARING, amount }, ...p.offset]) });
  } else throw new TxnPostError(`${p.key}: unknown kind ${p.kind}`);
  return out;
}

/** Credit / debit note set-offs that can be made now: [{ path, body, credit, doc }]. */
export function creditRequests(plan, res) {
  const out = [];
  for (const c of plan.creditApplications ?? []) {
    const cr = res.docs[`${c.credit}|${c.party}`];
    const doc = res.docs[`${c.doc}|${c.party}`];
    if (!cr || !doc) continue;
    if (cr.module === 'vendorcredits') out.push({ path: `/vendorcredits/${cr.id}/bills`, body: { bills: [{ bill_id: doc.id, amount_applied: rupees(c.amount) }] }, credit: c.credit, doc: c.doc, key: `${c.credit}>${c.doc}` });
    else if (cr.module === 'creditnotes') out.push({ path: `/creditnotes/${cr.id}/invoices`, body: { invoices: [{ invoice_id: doc.id, amount_applied: rupees(c.amount) }] }, credit: c.credit, doc: c.doc, key: `${c.credit}>${c.doc}` });
  }
  return out;
}
