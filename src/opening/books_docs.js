// Zoho Books payloads and the posting order for an opening plan (src/opening/plan.js).
//
//   gl lines          -> Settings > Opening Balances (POST /settings/openingbalances, one per location)
//   customer invoice  -> Invoices        (marked sent so it reaches receivables)
//   customer credit   -> Credit Notes
//   customer debit    -> Debit Notes     (Books needs the original invoice: refused here, see below)
//   vendor bill       -> Bills
//   vendor credit     -> Vendor Credits
//   vendor advance    -> Payments Made with no bill applied (an unused vendor advance)
//
// Every document's other side is the offset account (Opening Balance Adjustments by default),
// which the Opening Balances entry balances back to nil. Idempotency is by document number
// (and vendor), looked up in Books before anything is created. Pure: no network here.
import { formatMoney } from '../core/money.js';

export class OpeningPostError extends Error {
  constructor(message) { super(message); this.code = 'OPENING_POST'; }
}

const rupees = (paise) => Number(formatMoney(paise < 0n ? -paise : paise));

/** The order documents are posted in: invoices before notes, bills before credits/advances. */
export const POST_ORDER = Object.freeze(['invoice', 'credit_note', 'debit_note', 'bill', 'vendor_credit', 'vendor_advance']);

// `sort` keeps Books' paging stable (a list sorted on a non-unique column repeats some records
// across pages and skips others); `exactLookup` modules have no number uniqueness in Books, so
// each document is also looked up by its number right before it is created.
export const MODULES = Object.freeze({
  invoice: { path: 'invoices', list: 'invoices', key: 'invoice', id: 'invoice_id', number: 'invoice_number', search: 'invoice_number', sort: 'invoice_number', open: 'status/sent' },
  credit_note: { path: 'creditnotes', list: 'creditnotes', key: 'creditnote', id: 'creditnote_id', number: 'creditnote_number', search: 'creditnote_number', sort: 'creditnote_number', open: 'status/open' },
  bill: { path: 'bills', list: 'bills', key: 'bill', id: 'bill_id', number: 'bill_number', search: 'bill_number', sort: 'bill_number', open: 'status/open' },
  vendor_credit: { path: 'vendorcredits', list: 'vendor_credits', key: 'vendor_credit', id: 'vendor_credit_id', number: 'vendor_credit_number', search: 'vendor_credit_number', sort: 'vendor_credit_number', open: 'status/open' },
  vendor_advance: { path: 'vendorpayments', list: 'vendorpayments', key: 'vendorpayment', id: 'payment_id', number: 'reference_number', search: 'reference_number', sort: 'reference_number', exactLookup: true, open: null },
});

/** Stable key for a document in the run log. */
export const docKey = (d) => `${d.kind}|${d.side}|${d.partyCode}|${d.number}`;
export const partyKey = (d) => `${d.side}:${d.partyCode}`;

/** The Opening Balances body for the plan's GL lines. `accounts`: zohoCode -> { account_id }. */
export function openingBalanceBody(plan, res) {
  const lines = plan.gl.map((g) => {
    const a = res.accounts[g.zohoCode];
    if (!a?.account_id) throw new OpeningPostError(`GL ${g.zohoCode}: no Books account resolved`);
    // Books refuses an Opening Balances line without its account's currency (code 22006).
    if (!a.currency_id) throw new OpeningPostError(`GL ${g.zohoCode}: no currency on the resolved Books account; rerun preflight`);
    return { account_id: a.account_id, currency_id: a.currency_id, debit_or_credit: g.net > 0n ? 'debit' : 'credit', exchange_rate: 1, amount: rupees(g.net) };
  });
  // Vendor advances are paid out of a clearing account (Books will not pay out of Opening
  // Balance Adjustments); its opening debit refills it, so it ends the opening at nil.
  const advances = plan.documents.filter((d) => d.kind === 'vendor_advance').reduce((a, d) => a + d.amount, 0n);
  if (advances > 0n && res.advancePaidThroughId) {
    if (!res.advancePaidThroughCurrencyId) throw new OpeningPostError('advance clearing account: no currency resolved; rerun preflight');
    lines.push({ account_id: res.advancePaidThroughId, currency_id: res.advancePaidThroughCurrencyId, debit_or_credit: 'debit', exchange_rate: 1, amount: rupees(advances) });
  }
  return { date: plan.asOf, location_id: plan.locationId, accounts: lines };
}

/**
 * Books answers GET /settings/openingbalances with its lines grouped by account type (each group
 * holding its own array of lines); flatten that to the lines themselves.
 */
export function openingBalanceLines(accounts = []) {
  const out = [];
  for (const a of accounts) {
    if (a && a.account_id !== undefined) { out.push(a); continue; }
    for (const v of Object.values(a ?? {})) if (Array.isArray(v)) out.push(...openingBalanceLines(v));
  }
  return out;
}

/** Lines of an Opening Balances entry as comparable keys (Books may answer with debit/credit columns). */
export function openingBalanceKeys(accounts) {
  return accounts.map((a) => {
    // Books may answer with debit/credit columns (one of them 0) instead of debit_or_credit+amount.
    const debit = Number(a.debit ?? 0);
    const credit = Number(a.credit ?? 0);
    const dc = a.debit_or_credit ?? (debit ? 'debit' : 'credit');
    // …or, as the test org answers, debit_or_credit with the amount in bcy_amount.
    const given = [a.amount, a.bcy_amount].find((v) => v !== undefined && v !== null && v !== '');
    const amount = given !== undefined ? Number(given) : Math.max(debit, credit);
    return `${a.account_id}|${dc}|${Math.abs(amount).toFixed(2)}`;
  }).filter((k) => !k.endsWith('|0.00')).sort();
}

/** What differs between Books' Opening Balances and the plan (for review when they do not match). */
export function openingBalanceDiff(existing, body, ignoreAccountId = null) {
  const a = openingBalanceKeys(openingBalanceLines(existing).filter((x) => String(x.account_id) !== String(ignoreAccountId)));
  const b = openingBalanceKeys(body.accounts);
  return { onlyInBooks: a.filter((k) => !b.includes(k)), onlyInPlan: b.filter((k) => !a.includes(k)) };
}

/**
 * True when Books' current Opening Balances lines are exactly the ones this plan would post. The
 * balancing line Books adds itself (Opening Balance Adjustments, `ignoreAccountId`) is left out.
 */
export function sameOpeningBalance(existing, body, ignoreAccountId = null) {
  const a = openingBalanceKeys(openingBalanceLines(existing).filter((x) => String(x.account_id) !== String(ignoreAccountId)));
  const b = openingBalanceKeys(body.accounts);
  return a.length === b.length && a.every((k, i) => k === b[i]);
}

/**
 * Create body for one document. `res` is the preflight resolution:
 * { contacts: { 'side:code': contact_id }, offsetAccountId, itemId, taxExemptionId?, docDate: 'original'|'asof' }.
 */
export function documentBody(d, plan, res) {
  const contactId = res.contacts[partyKey(d)];
  if (!contactId) throw new OpeningPostError(`${d.number}: no Books contact for ${partyKey(d)} ${d.partyName}`);
  const date = res.docDate === 'asof' ? plan.asOf : d.date;
  const due = res.docDate === 'asof' ? plan.asOf : (d.dueDate && d.dueDate >= date ? d.dueDate : date);
  const amount = rupees(d.amount);
  const description = `Opening balance ${plan.asOf} – Eco Green ${d.sourceType} ${d.sourceRef}`;
  // An item-level exemption goes on the line; on a customer document's header Books reads it as a
  // customer-level exemption and refuses it (code 110823).
  const exemption = res.taxExemptionId ? { tax_exemption_id: res.taxExemptionId } : {};
  const loc = { location_id: plan.locationId };
  // Org-specific fields Books insists on (for example the GST invoice / bill type of a note that
  // has no original document), as settled at preflight; they never override what is set below.
  const extra = res.extras?.[d.kind] ?? {};
  let refType = {};
  if (d.kind === 'credit_note' || d.kind === 'vendor_credit') {
    const t = referenceInvoiceType(res.gstTreatment?.[partyKey(d)]);
    if (!t && !extra.reference_invoice_type) throw new OpeningPostError(`${d.number}: no GST treatment for ${partyKey(d)} ${d.partyName}; rerun preflight`);
    if (t) refType = { reference_invoice_type: t };
  }
  switch (d.kind) {
    case 'invoice':
      return {
        ...extra, customer_id: contactId, invoice_number: d.number, reference_number: d.sourceRef, date, due_date: due, ...loc,
        line_items: [{ item_id: res.itemId, description, quantity: 1, rate: amount, ...exemption, ...loc }],
        notes: description,
      };
    case 'credit_note':
      return {
        ...refType, ...extra, customer_id: contactId, creditnote_number: d.number, reference_number: d.sourceRef, date, ...loc,
        line_items: [{ account_id: res.offsetAccountId, name: 'Opening balance', description, quantity: 1, rate: amount, ...exemption, ...loc }],
        notes: description,
      };
    case 'bill':
      return {
        ...extra, vendor_id: contactId, bill_number: d.number, reference_number: d.vendorInvoiceNo ?? d.sourceRef, date, due_date: due, ...loc,
        line_items: [{ account_id: res.offsetAccountId, description, quantity: 1, rate: amount, ...exemption, ...loc }],
        notes: description,
      };
    case 'vendor_credit':
      return {
        ...refType, ...extra, vendor_id: contactId, vendor_credit_number: d.number, reference_number: d.vendorInvoiceNo ?? d.sourceRef, date, ...loc,
        line_items: [{ account_id: res.offsetAccountId, description, quantity: 1, rate: amount, ...exemption, ...loc }],
        notes: description,
      };
    case 'vendor_advance':
      // Books pays only out of a cash or bank account (code 11016 otherwise); the clearing account
      // it is paid through gets the same amount as an Opening Balances debit (openingBalanceBody).
      if (!res.advancePaidThroughId) throw new OpeningPostError(`${d.number}: vendor advances need a cash/bank clearing account (--advance-paid-through-id at preflight)`);
      return {
        ...extra, vendor_id: contactId, amount, date, reference_number: d.number, paid_through_account_id: res.advancePaidThroughId,
        description, ...loc,
      };
    case 'debit_note':
      // Books' customer debit note must reference an existing invoice (reference_invoice_id);
      // an opening debit note has none, so it is refused rather than guessed.
      throw new OpeningPostError(`${d.number}: customer debit notes need an original Books invoice; post it as an invoice or supply the reference`);
    default:
      throw new OpeningPostError(`${d.number}: unknown document kind ${d.kind}`);
  }
}

/**
 * GST "reference invoice type" Books needs on a credit note or vendor credit that has no original
 * invoice / bill (codes 12069, 37034), from the party's GST treatment. Unregistered parties are
 * B2C Others: these opening notes are intra-state (Tripura) and under the B2C Large threshold.
 */
export function referenceInvoiceType(gstTreatment) {
  return {
    business_gst: 'registered', business_registered_composition: 'registered', tax_deductor: 'registered',
    business_registered_regular: 'registered',
    business_none: 'b2c_others', consumer: 'b2c_others',
    overseas: 'export_without_payment', business_sez: 'sez_without_payment', sez_developer: 'sez_without_payment',
    deemed_export: 'deemed_export',
  }[gstTreatment] ?? null;
}

/** True when an existing Books record is this document (same number and, for vendors, same vendor). */
export function sameDocument(d, record, contactId) {
  const m = MODULES[d.kind];
  if (!m || String(record[m.number] ?? '') !== d.number) return false;
  if (d.side === 'vendor') return String(record.vendor_id ?? '') === String(contactId);
  return String(record.customer_id ?? '') === String(contactId);
}

/** One Books account per code; anything else is a problem for preflight to report. */
export function pickAccount(code, rows) {
  const hits = rows.filter((a) => a.account_code === code);
  const seen = new Map(hits.map((a) => [String(a.account_id), a]));
  return seen.size === 1 ? { account: [...seen.values()][0] } : { problem: `GL ${code}: ${seen.size} Books accounts carry this code` };
}

/** Documents in posting order, optionally limited to `perKind` of each kind (smoke test). */
export function postingQueue(plan, { kinds = POST_ORDER, perKind = Infinity } = {}) {
  const out = [];
  for (const k of POST_ORDER) {
    if (!kinds.includes(k)) continue;
    out.push(...plan.documents.filter((d) => d.kind === k).slice(0, perKind));
  }
  return out;
}

/** The only organisation this tool may write to (Branch 460 test opening). */
export const OPENING_TEST_ORG = '60091274394';

/**
 * Write gate for `post`: the shared posting guard must pass (live driver, POSTING_ENABLED,
 * authorisation reference, allow-listed org), the org must be the test org and the only one on
 * the allow-list, and the operator must have named it on the command line.
 */
export function assertTestOrgPosting(config, confirmedOrg, assertPostingAllowed) {
  assertPostingAllowed(config);
  if (config.organizationId !== OPENING_TEST_ORG) {
    throw new OpeningPostError(`opening posting is limited to the test organisation ${OPENING_TEST_ORG}; BOOKS_ORGANIZATION_ID is ${config.organizationId || '(empty)'}`);
  }
  if (config.orgAllowlist.length !== 1 || config.orgAllowlist[0] !== OPENING_TEST_ORG) {
    throw new OpeningPostError(`BOOKS_ORG_ALLOWLIST must contain only ${OPENING_TEST_ORG} for opening posting`);
  }
  if (confirmedOrg !== OPENING_TEST_ORG) {
    throw new OpeningPostError(`pass --confirm-org ${OPENING_TEST_ORG} to post`);
  }
}
