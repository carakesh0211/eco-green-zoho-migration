// Branch transactions for the migration window (opening date + 1 .. cut-off), from the
// revised Eco Green ledger table ("Ledger_<from>_to_<to> V2.xlsx"), one row per ledger line:
//   c_prefix / n_tran_no   voucher (negative numbers are bank-clearance twins, e.g. Q/-3909)
//   c_act_code / c_name    ledger; n_type 4 = customer, 5 = vendor, 3 = HO / inter-branch
//   n_amount               signed, Dr positive
//   c_remarks              narration (pushed with the transaction)
//   To be pushed by        "ZOHO" = ours, "Smartpharma" = Smart Pharma's
//
// Settlement files (who-paid-what, Eco Green's own knock-offs):
//   supplier_payment_details_act.csv   payment voucher -> bills / debit notes it settled
//   invoice_receipt_det_act_<br>.csv   settlement (E) -> invoices and the receipts / credits set off
//
// buildTxnPlan() turns our vouchers into Books postings and works out, for every receipt and
// payment of ours, which invoices / bills it is applied to:
//   1. exact  - Eco Green's own settlement, when both documents exist in Books
//               (opening open items, or this year's documents in the ledger);
//   2. fifo   - what is left, oldest open opening item of the same party first
//               (net opening: knock-offs against pre-opening documents that are not in the
//               opening open-item list fall through to here);
//   3. what is still left stays unapplied (customer excess payment / vendor advance).
// Nothing here talks to Zoho; accounts and contacts are resolved at posting time.
import { formatMoney } from '../core/money.js';
import { parseCsv } from '../core/csv.js';

export class TxnPlanError extends Error {
  constructor(message) { super(message); this.code = 'TXN_PLAN'; }
}

const fmt = (p) => formatMoney(p);
const text = (v) => (v === null || v === undefined ? '' : String(v).trim());
// Excel's text marker: some extracts keep it on codes ('V01833, '-CGSTR)
const codeText = (v) => text(v).replace(/^'/, '');
const abs = (p) => (p < 0n ? -p : p);
const min = (a, b) => (a < b ? a : b);

/** Number or numeric string -> BigInt paise. */
export function toPaise(v) {
  if (v === null || v === undefined || v === '' || v === '-') return 0n;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/,/g, ''));
  if (!Number.isFinite(n)) throw new TxnPlanError(`not an amount: ${JSON.stringify(v)}`);
  return BigInt(Math.round(n * 100));
}

/**
 * Ledger date cell -> 'YYYY-MM-DD'. Text cells are dd/mm/yy. Excel turned every text date whose
 * day was <= 12 into a real date read as mm/dd, so date cells are swapped back by default
 * (excelDates: 'swapped'); pass 'asis' for a file whose date cells are genuine.
 */
export function ledgerDate(v, { excelDates = 'swapped' } = {}) {
  if (v && typeof v === 'object' && v.date) {
    const [y, m, d] = v.date.split('-');
    return excelDates === 'swapped' ? `${y}-${d}-${m}` : v.date;
  }
  const s = text(v);
  const t = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(s);
  if (!t) return null;
  const y = t[3].length === 2 ? `20${t[3]}` : t[3];
  return `${y}-${t[2].padStart(2, '0')}-${t[1].padStart(2, '0')}`;
}

const PARTY_TYPES = new Map([[4, 'customer'], [5, 'vendor']]);
export const INTER_BRANCH = 'INTERBRANCH';
/** HO / inter-branch lines post to Sundry Debtors – Inter Branch with this contact (as the opening did). */
export const INTER_BRANCH_CONTACT = '000';
const contactOf = (l) => (l.account === INTER_BRANCH ? INTER_BRANCH_CONTACT : undefined);

/**
 * Ledger account key. Excel shows some codes as "#NAME?" (codes that start with "=" / "-"):
 * those are keyed by ledger name. Code 0 (HO, type 3) is the inter-branch account.
 */
export function accountKey(code, name, type) {
  const c = text(code);
  if (type === 3 || c === '0') return INTER_BRANCH;
  if (c.startsWith('#')) return `NAME:${text(name).toUpperCase()}`;
  return /^\d+$/.test(c) ? String(Number(c)) : c; // 000939 and 939 are the same ledger
}

/**
 * Eco Green code -> Zoho account code from a Books chart-of-accounts export whose custom field
 * "Eco Green Account Code" tags each Zoho account with the Eco Green ledger(s) it stands for
 * (several per cell: newline / comma separated). A code tagged on two Zoho accounts is ambiguous
 * and left out, for the account map to decide.
 */
export function coaCrosswalk(csvText) {
  const { header, rows } = parseCsv(csvText);
  const h = header.map((x) => text(x).replace(/^\uFEFF/, '').toLowerCase());
  const code = h.indexOf('account code');
  const tag = h.findIndex((x) => /eco ?green/.test(x));
  const status = h.indexOf('account status');
  if (code < 0 || tag < 0) throw new TxnPlanError('chart of accounts: needs "Account Code" and an "Eco Green Account Code" column');
  const seen = new Map();
  for (const r of rows) {
    const z = text(r[code]);
    if (!z || (status >= 0 && /inactive/i.test(text(r[status])))) continue;
    for (const t of text(r[tag]).split(/[\n,]+/)) {
      const e = accountKey(codeText(t.replace(/^"|"$/g, '')), '', null);
      if (e) seen.set(e, new Set([...(seen.get(e) ?? []), z]));
    }
  }
  const map = new Map();
  const ambiguous = [];
  for (const [e, zs] of seen) {
    if (zs.size === 1) map.set(e, [...zs][0]);
    else ambiguous.push([e, [...zs]]);
  }
  return { map, ambiguous };
}

/** Sheet rows (header first) -> normalised ledger lines. */
export function readLedgerRows(rows, opts = {}) {
  const h = rows[0].map((c) => text(c).toLowerCase());
  const col = (name) => {
    const i = h.indexOf(name.toLowerCase());
    if (i < 0) throw new TxnPlanError(`ledger table: column "${name}" not found`);
    return i;
  };
  const c = {
    prefix: col('c_prefix'), no: col('n_tran_no'), code: col('c_act_code'), date: col('d_date'), amount: col('n_amount'),
    name: col('c_name'), type: col('n_type'), remarks: col('c_remarks'), custRef: col('cust_pay_ref_no'),
    suppRef: col('supp_pay_ref_no'), owner: col('to be pushed by'), year: col('c_year'), group: col('c_grp_no'),
  };
  // Date cells: Excel turns a dd/mm/yy text into a date only when the day reads as a month
  // (<= 12), swapping them; a file with a date cell past the 12th holds genuine dates.
  if (!opts.excelDates || opts.excelDates === 'auto') {
    const genuine = rows.slice(1).some((r) => r[c.date] && typeof r[c.date] === 'object' && Number(String(r[c.date].date).slice(8, 10)) > 12);
    opts = { ...opts, excelDates: genuine ? 'asis' : 'swapped' };
  }
  const out = [];
  for (const r of rows.slice(1)) {
    if (r.every((x) => x === null || x === '') || codeText(r[c.code]) === '') continue; // blank / total rows
    const code = codeText(r[c.code]);
    // parties kept as GL ledgers in Books (e.g. card / UPI terminal collection accounts)
    const glParty = opts.glParties?.has(code);
    const type = glParty ? 0 : Number(r[c.type]);
    out.push({
      year: text(r[c.year]), prefix: text(r[c.prefix]), no: text(r[c.no]),
      code, account: accountKey(code, r[c.name], type), name: text(r[c.name]),
      type, party: PARTY_TYPES.get(type) ?? null, glParty: Boolean(glParty),
      // TB control (Sundry Debtors / Creditors group) = last 6 digits of the ledger group, e.g. 1002002022 -> 002022
      control: text(r[c.group]).slice(-6),
      date: ledgerDate(r[c.date], opts), rawDate: r[c.date], amount: toPaise(r[c.amount]),
      remarks: text(r[c.remarks]), custRef: text(r[c.custRef]), suppRef: text(r[c.suppRef]),
      owner: text(r[c.owner]).toUpperCase(),
    });
  }
  return out;
}

export const voucherKey = (year, prefix, no) => `${year}/${prefix}/${no}`;

/** Lines -> Map(voucherKey -> voucher). Party lines are netted per contact. */
export function groupVouchers(lines) {
  const out = new Map();
  for (const l of lines) {
    const key = voucherKey(l.year, l.prefix, l.no);
    let v = out.get(key);
    if (!v) {
      v = { key, year: l.year, prefix: l.prefix, no: l.no, owner: l.owner, dates: new Set(), lines: [], remarks: '' };
      out.set(key, v);
    }
    v.lines.push(l);
    if (l.date) v.dates.add(l.date);
    if (!v.remarks && l.remarks) v.remarks = l.remarks;
  }
  for (const v of out.values()) {
    v.date = [...v.dates].sort()[0] ?? null;
    v.total = v.lines.reduce((t, l) => t + l.amount, 0n);
    const parties = new Map();
    for (const l of v.lines.filter((x) => x.party)) {
      const p = parties.get(l.code) ?? { code: l.code, name: l.name, side: l.party, control: l.control, net: 0n };
      p.net += l.amount;
      parties.set(l.code, p);
    }
    v.parties = [...parties.values()].filter((p) => p.net !== 0n);
    // Party lines that cancel out inside the voucher (pass-through control accounts) drop out.
    const live = new Set(v.parties.map((p) => p.code));
    v.gl = v.lines.filter((l) => !l.party);
    v.passThrough = v.lines.filter((l) => l.party && !live.has(l.code)).length;
    v.liveLines = v.lines.filter((l) => !l.party || live.has(l.code));
  }
  return out;
}

/**
 * Posting kind of one of our vouchers:
 *   receipt  one customer, net credit   -> customer payment (+ offset journal when > 1 offset line)
 *   payment  one vendor, net debit      -> vendor payment
 *   bill     one vendor, net credit     -> bill (liability booked by journal, e.g. rent)
 *   journal  anything else (contra, bank clearance, adjustments, party-to-party)
 */
export function classifyVoucher(v) {
  const glOffset = v.gl.map((l) => ({ account: l.account, code: l.code, name: l.name, contact: contactOf(l), amount: l.amount }));
  if (v.parties.length === 1) {
    const p = v.parties[0];
    const base = { party: { code: p.code, name: p.name, side: p.side, control: p.control }, amount: abs(p.net), offset: glOffset, direct: glOffset.length === 1 };
    if (p.side === 'customer' && p.net < 0n) return { kind: 'receipt', ...base };
    if (p.side === 'vendor' && p.net > 0n) return { kind: 'payment', ...base };
    if (p.side === 'vendor' && p.net < 0n) return { kind: 'bill', ...base };
  }
  return { kind: 'journal', lines: v.liveLines.map((l) => ({ account: l.account, code: l.code, name: l.name, party: l.party, control: l.party ? l.control : undefined, contact: l.party ? l.code : contactOf(l), amount: l.amount })) };
}

const KIND_LABEL = { receipt: 'Receipt', payment: 'Payment', bill: 'Bill', journal: 'Journal' };

/** Narration pushed with the transaction: Eco Green's remarks, else a built one. */
export function description(v, c) {
  if (v.remarks) return v.remarks;
  const who = c.party?.name ?? v.gl[0]?.name ?? v.lines[0]?.name ?? '';
  return `${KIND_LABEL[c.kind]} ${v.prefix}/${v.no} – ${who}`.trim();
}

// ---- documents that exist (or will exist) in Books ------------------------------------------

/** "25/T 5960", "25/K/1700" -> "25/T/5960"; null for refs without year/prefix/number. */
export function refKey(ref) {
  const p = text(ref).split(/[\s/]+/).filter(Boolean);
  if (p.length !== 3 || !/^\d{2}$/.test(p[0])) return null;
  return voucherKey(p[0], p[1], p[2]);
}

const OPEN_DEBIT = new Set(['invoice', 'bill']);

/**
 * Open items: opening documents (from the opening plan) plus this year's party documents in the
 * ledger (any owner). Each item: { key, side, party, date, debit (invoice/bill) or credit, open }.
 * Customer debit = invoice, vendor credit = bill (what payments are applied to).
 */
export function openItems({ openingDocs = [], vouchers }) {
  const items = new Map();
  const add = (it) => items.set(`${it.key}|${it.party}`, it);
  for (const d of openingDocs) {
    // "OPENING BALANCE" = the party's TB balance not carried by the open-item list (net opening):
    // it stands for the pre-opening documents Eco Green still knocks off in the window.
    const balancing = /^OPENING BALANCE/i.test(text(d.sourceRef));
    const key = balancing ? `OPENING/${d.partyCode}` : refKey(d.sourceRef);
    if (!key) continue;
    const amount = BigInt(d.amount);
    add({ key, party: d.partyCode, side: d.side, date: d.date, source: 'opening', kind: d.kind, payable: OPEN_DEBIT.has(d.kind), balancing, amount, open: amount });
  }
  for (const v of vouchers.values()) {
    for (const p of v.parties) {
      const payable = (p.side === 'customer' && p.net > 0n) || (p.side === 'vendor' && p.net < 0n);
      add({ key: v.key, party: p.code, side: p.side, date: v.date, source: v.owner === 'ZOHO' ? 'ours' : 'smartpharma', kind: payable ? (p.side === 'customer' ? 'invoice' : 'bill') : 'credit', payable, amount: abs(p.net), open: abs(p.net) });
    }
  }
  return items;
}

// ---- settlement files ------------------------------------------------------------------------

const csvRows = (csvText) => {
  const { header, rows } = parseCsv(csvText);
  const h = header.map((x) => x.trim().toLowerCase());
  const at = (name) => {
    const i = h.indexOf(name);
    if (i < 0) throw new TxnPlanError(`settlement file: column "${name}" not found`);
    return i;
  };
  return { rows, at };
};

/**
 * supplier_payment_details_act.csv: every allocation comes as a pair (paid-through side and
 * vendor side). Vendor side only: { payment (voucher key), party, doc (key), amount }, amount
 * positive for a bill, negative for a debit note.
 */
export function readSupplierAllocations(csvText, { year = '26' } = {}) {
  const { rows, at } = csvRows(csvText);
  const c = { prefix: at('c_prefix'), no: at('n_srno'), iy: at('c_inv_year'), ip: at('c_inv_prefix'), ino: at('c_inv_no'), amt: at('n_total'), date: at('d_date'), code: at('c_code'), name: at('account_name') };
  return rows.map((r) => ({
    payment: voucherKey(year, r[c.prefix], r[c.no]), party: r[c.code].trim(), partyName: r[c.name].trim(),
    doc: voucherKey(r[c.iy], r[c.ip], r[c.ino]), amount: toPaise(r[c.amt]), date: ledgerDate(r[c.date]),
  }));
}

/** invoice_receipt_det_act_<br>.csv: { group (E no), party, doc, amount (+ debit doc / - credit doc), date }. */
export function readCustomerSettlements(csvText) {
  const { rows, at } = csvRows(csvText);
  const c = { no: at('n_srno'), iy: at('c_inv_year'), ip: at('c_inv_prefix'), ino: at('n_inv_no'), amt: at('n_amount'), date: at('d_date'), party: at('c_cust_code'), cancel: at('n_cancel_flag') };
  return rows.filter((r) => r[c.cancel] !== '1').map((r) => ({
    group: r[c.no], party: r[c.party].trim(), doc: voucherKey(r[c.iy], r[c.ip], r[c.ino]), amount: toPaise(r[c.amt]), date: ledgerDate(r[c.date]),
  }));
}

/** Pair a settlement's debits with its credits in file order -> [{ credit, debit, amount }]. */
export function pairSettlement(debits, credits) {
  const out = [];
  const d = debits.map((x) => ({ ...x, left: abs(x.amount) }));
  const c = credits.map((x) => ({ ...x, left: abs(x.amount) }));
  let i = 0;
  let j = 0;
  while (i < d.length && j < c.length) {
    const amt = min(d[i].left, c[j].left);
    if (amt > 0n) out.push({ debit: d[i].doc, credit: c[j].doc, amount: amt });
    d[i].left -= amt;
    c[j].left -= amt;
    if (d[i].left === 0n) i += 1;
    if (c[j].left === 0n) j += 1;
  }
  return out;
}

// ---- the plan ---------------------------------------------------------------------------------

/**
 * @param lines            readLedgerRows() output (all owners)
 * @param supplierAlloc    readSupplierAllocations() output
 * @param customerSettle   readCustomerSettlements() output
 * @param openingDocs      opening plan documents ({ kind, side, partyCode, date, amount (paise), sourceRef })
 * @param from / to        migration window (ISO dates, inclusive)
 * @param accountMap       optional Map(eco account key -> zoho account code)
 */
export function buildTxnPlan({ branch, lines, supplierAlloc = [], customerSettle = [], openingDocs = [], from, to, accountMap = null }) {
  const checks = [];
  const warnings = [];
  const check = (name, ok, detail) => checks.push({ name, ok, detail });

  const vouchers = groupVouchers(lines);
  const ours = [...vouchers.values()].filter((v) => v.owner === 'ZOHO');
  const outside = lines.filter((l) => !l.date || l.date < from || l.date > to);
  check('dates inside the window', outside.length === 0, outside.length ? `${outside.length} lines outside ${from}..${to} (first: ${outside[0].prefix}/${outside[0].no} ${text(outside[0].rawDate?.date ?? outside[0].rawDate)})` : `${lines.length} lines, ${from}..${to}`);
  const unbalanced = [...vouchers.values()].filter((v) => v.total !== 0n);
  check('every voucher balances', unbalanced.length === 0, unbalanced.length ? `${unbalanced.length} unbalanced, e.g. ${unbalanced.slice(0, 5).map((v) => `${v.key} ${fmt(v.total)}`).join(', ')}` : `${vouchers.size} vouchers`);
  const multiDate = ours.filter((v) => v.dates.size > 1);
  check('one date per voucher', multiDate.length === 0, multiDate.length ? multiDate.slice(0, 5).map((v) => v.key).join(', ') : 'ok');
  const owners = new Set(lines.map((l) => l.owner));
  for (const o of owners) if (o !== 'ZOHO' && o !== 'SMARTPHARMA') warnings.push(`unknown "To be pushed by" value: ${o}`);

  // postings
  const postings = ours.sort((a, b) => (a.date === b.date ? a.key.localeCompare(b.key) : a.date < b.date ? -1 : 1)).map((v) => {
    const c = classifyVoucher(v);
    return { key: v.key, prefix: v.prefix, no: v.no, date: v.date, kind: c.kind, description: description(v, c), passThroughLines: v.passThrough, ...c };
  });

  // accounts used by our postings
  const accounts = new Map();
  for (const v of ours) for (const l of v.liveLines.filter((x) => !x.party)) {
    const a = accounts.get(l.account) ?? { account: l.account, code: l.code, name: l.name, lines: 0 };
    a.lines += 1;
    accounts.set(l.account, a);
  }
  const byName = [...accounts.values()].filter((a) => a.account.startsWith('NAME:'));
  if (byName.length) warnings.push(`${byName.length} ledgers have no usable code in the file ("#NAME?"), keyed by name: ${byName.map((a) => a.name).join(', ')}`);
  if (accountMap) {
    const unmapped = [...accounts.values()].filter((a) => !accountMap.get(a.account));
    check('every ledger mapped to a Zoho account', unmapped.length === 0, unmapped.length ? `${unmapped.length} unmapped: ${unmapped.map((a) => `${a.account} ${a.name}`).join('; ')}` : `${accounts.size} ledgers`);
  }

  // ---- applications
  const items = openItems({ openingDocs, vouchers });
  const item = (doc, party) => items.get(`${doc}|${party}`);
  const payments = new Map(postings.filter((p) => p.kind === 'receipt' || p.kind === 'payment').map((p) => [p.key, { ...p, left: p.amount, applications: [] }]));
  const creditApplications = [];
  const exceptions = [];
  const apply = (pay, it, amount, method, ref) => {
    const amt = min(min(amount, pay.left), it.open);
    if (amt <= 0n) return 0n;
    pay.left -= amt;
    it.open -= amt;
    // one line per document on a payment
    const same = pay.applications.find((a) => a.doc === it.key && a.method === method);
    if (same) same.amount += amt;
    else pay.applications.push({ doc: it.key, party: it.party, source: it.source, amount: amt, method, ref });
    return amt;
  };

  // 1. exact: customer settlements (E groups) and supplier allocations, inside the window
  const groups = new Map();
  for (const s of customerSettle) {
    if (!s.date || s.date > to) continue;
    const g = groups.get(s.group) ?? [];
    g.push(s);
    groups.set(s.group, g);
  }
  const lateGroups = new Set(customerSettle.filter((s) => s.date && s.date > to).map((s) => s.group));
  if (lateGroups.size) warnings.push(`${lateGroups.size} customer settlements dated after ${to} ignored`);
  let toBalancing = 0;
  const settle = (ref, rawRows, method) => {
    // debits on documents older than the opening list -> the party's opening balance item
    const rows = rawRows.map((r) => {
      if (item(r.doc, r.party) || r.amount <= 0n) return r;
      const b = item(`OPENING/${r.party}`, r.party);
      if (!b || !b.payable) return r;
      toBalancing += 1;
      return { ...r, doc: b.key, original: r.doc };
    });
    const known = rows.filter((r) => item(r.doc, r.party));
    const debits = known.filter((r) => item(r.doc, r.party).payable);
    const credits = known.filter((r) => !item(r.doc, r.party).payable);
    if (!credits.some((r) => payments.has(r.doc))) return; // nothing of ours in it
    for (const pr of pairSettlement(debits, credits)) {
      const party = rows.find((r) => r.doc === pr.debit)?.party;
      const it = item(pr.debit, party);
      const pay = payments.get(pr.credit);
      if (pay) apply(pay, it, pr.amount, method, ref);
      else {
        // a credit note / debit note set off in the same knock-off as our receipt or payment
        const cr = item(pr.credit, party);
        const amt = min(min(pr.amount, cr.open), it.open);
        if (amt > 0n) {
          cr.open -= amt;
          it.open -= amt;
          creditApplications.push({ credit: pr.credit, doc: pr.debit, party, side: it.side, amount: amt, creditSource: cr.source, ref });
        }
      }
    }
  };
  for (const [g, rows] of groups) settle(`E/${g}`, rows, 'exact');

  const byPayment = new Map();
  const allocLate = [];
  const allocMissing = new Set();
  for (const a of supplierAlloc) {
    const pay = payments.get(a.payment);
    if (!pay) {
      if (a.date && a.date > to) allocLate.push(a); else allocMissing.add(a.payment);
      continue;
    }
    if (a.party !== pay.party.code) continue; // paid-through side of the pair
    const g = byPayment.get(a.payment) ?? [];
    g.push({ doc: a.doc, party: a.party, amount: a.amount });
    byPayment.set(a.payment, g);
  }
  if (allocLate.length) warnings.push(`${allocLate.length} supplier allocation rows dated after ${to} ignored`);
  if (allocMissing.size) exceptions.push(...[...allocMissing].map((k) => ({ type: 'allocation for a payment not in our ledger rows', ref: k })));
  for (const [k, rows] of byPayment) {
    const pay = payments.get(k);
    const known = rows.filter((r) => item(r.doc, r.party));
    for (const r of rows.filter((x) => !item(x.doc, x.party) && !(x.amount > 0n && item(`OPENING/${x.party}`, x.party)?.payable))) exceptions.push({ type: 'allocated document not in Books (not an opening open item, not in the ledger)', ref: k, doc: r.doc, party: r.party, amount: fmt(r.amount) });
    const bills = known.filter((r) => r.amount > 0n);
    const notes = known.filter((r) => r.amount < 0n);
    // debit notes are set off first, the payment takes what is left of the bills
    settle(k, [...bills, ...notes, { doc: k, party: pay.party.code, amount: -pay.amount }], 'exact');
  }

  // 2. fifo over the party's opening open items, oldest first; 3. leftover stays unapplied
  const fifoPool = new Map();
  for (const it of items.values()) {
    if (it.source !== 'opening' || !it.payable) continue;
    const l = fifoPool.get(it.party) ?? [];
    l.push(it);
    fifoPool.set(it.party, l);
  }
  // the opening balance item stands for the oldest documents, so it goes first
  const order = (a, b) => (a.balancing !== b.balancing ? (a.balancing ? -1 : 1)
    : a.date === b.date ? a.key.localeCompare(b.key, undefined, { numeric: true }) : a.date < b.date ? -1 : 1);
  for (const l of fifoPool.values()) l.sort(order);
  if (toBalancing) warnings.push(`${toBalancing} settlement rows against documents older than the opening list applied to the party's opening balance item`);
  for (const pay of payments.values()) {
    for (const it of fifoPool.get(pay.party.code) ?? []) {
      if (pay.left === 0n) break;
      apply(pay, it, pay.left, 'fifo', null);
    }
  }

  const sumBy = (method) => [...payments.values()].reduce((t, p) => t + p.applications.filter((a) => a.method === method).reduce((s, a) => s + a.amount, 0n), 0n);
  const unapplied = [...payments.values()].filter((p) => p.left > 0n);
  const kinds = {};
  for (const p of postings) kinds[p.kind] = (kinds[p.kind] ?? 0) + 1;
  const totals = {
    vouchers: postings.length, kinds,
    paymentsAmount: fmt([...payments.values()].reduce((t, p) => t + p.amount, 0n)),
    exact: fmt(sumBy('exact')), fifo: fmt(sumBy('fifo')),
    unapplied: fmt(unapplied.reduce((t, p) => t + p.left, 0n)), unappliedCount: unapplied.length,
    creditApplications: creditApplications.length,
    smartPharmaVouchers: [...vouchers.values()].filter((v) => v.owner !== 'ZOHO').length,
  };

  const out = postings.map((p) => {
    const pay = payments.get(p.key);
    return pay ? { ...p, applications: pay.applications, unapplied: pay.left } : p;
  });
  return { branch, from, to, checks, warnings, totals, postings: out, creditApplications, exceptions, accounts: [...accounts.values()] };
}

/** Markdown summary for people. */
export function planReport(plan) {
  const t = plan.totals;
  const L = [];
  L.push(`# Branch ${plan.branch} – transactions ${plan.from} to ${plan.to}`, '');
  L.push('## Checks', '');
  for (const c of plan.checks) L.push(`- ${c.ok ? 'OK ' : 'FAIL'} ${c.name}: ${c.detail}`);
  if (plan.warnings.length) { L.push('', '## Warnings', ''); for (const w of plan.warnings) L.push(`- ${w}`); }
  L.push('', '## Our postings', '', '| Kind | Vouchers |', '|---|---|');
  for (const [k, n] of Object.entries(t.kinds)) L.push(`| ${k} | ${n} |`);
  L.push(`| **total** | **${t.vouchers}** |`, '', `Smart Pharma vouchers in the file (not posted by us): ${t.smartPharmaVouchers}`, '');
  L.push('## Receipt / payment application', '', '| | Amount |', '|---|---|');
  L.push(`| Receipts + payments | ${t.paymentsAmount} |`, `| Applied exactly (Eco Green settlement) | ${t.exact} |`, `| Applied oldest-first (opening items) | ${t.fifo} |`, `| Unapplied (excess / advance), ${t.unappliedCount} vouchers | ${t.unapplied} |`);
  L.push('', `Credit / debit notes set off with them: ${t.creditApplications}`, '');
  if (plan.exceptions.length) {
    L.push('## Exceptions', '', `${plan.exceptions.length} – see exceptions.csv`, '');
    const by = {};
    for (const e of plan.exceptions) by[e.type] = (by[e.type] ?? 0) + 1;
    for (const [k, n] of Object.entries(by)) L.push(`- ${k}: ${n}`);
  }
  return `${L.join('\n')}\n`;
}
