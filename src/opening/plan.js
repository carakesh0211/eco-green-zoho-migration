// Branch opening balances from the native Eco Green reports (one workbook per branch):
//   "TB - <br>"                        trial balance FY end, with a "New Code_Zoho" column
//   "CUSTOMER TRACES-<br>(...)"        open customer documents, bill-wise
//   "BRANCH BALANCE-<br>(002000)"      inter-branch balances, one line per branch
//   "SUPP TRACES WORKING FILE - <br>"  open supplier documents, bill-wise, by creditor group
//
// buildOpeningPlan() turns them into what Zoho Books needs, as on the opening date:
//   - gl:        Opening Balances screen lines (balance-sheet ledgers not carried by documents,
//                closing stock, and the year's result moved to reserves);
//   - documents: invoices / credit notes / debit notes (customers, inter-branch),
//                bills / vendor credits / advance payments (suppliers);
//   - checks:    every control ledger's TB balance against the sum of its documents.
// Nothing here talks to Zoho; accounts and contacts are resolved later (scripts/opening-balance.js).
import { formatMoney } from '../core/money.js';
import { readXlsx } from '../sources/ecogreen/xlsx.js';

export class OpeningPlanError extends Error {
  constructor(message) { super(message); this.code = 'OPENING_PLAN'; }
}

/** Number or numeric string from a report cell -> BigInt paise (reports carry float noise). */
export function toPaise(v) {
  if (v === null || v === undefined || v === '' || v === '-') return 0n;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/,/g, ''));
  if (!Number.isFinite(n)) throw new OpeningPlanError(`not an amount: ${JSON.stringify(v)}`);
  return BigInt(Math.round(n * 100));
}
const fmt = (p) => formatMoney(p);
const text = (v) => (v === null || v === undefined ? '' : String(v).trim());
const dateOf = (v) => (v && typeof v === 'object' && v.date ? v.date : null);
const norm = (s) => text(s).toUpperCase().replace(/[^A-Z0-9]/g, '');

function sheet(wb, prefix) {
  const s = wb.sheets.find((x) => x.name.toUpperCase().startsWith(prefix));
  if (!s) throw new OpeningPlanError(`sheet "${prefix}…" not found (sheets: ${wb.sheets.map((x) => x.name).join(', ')})`);
  return s;
}

// ---- trial balance --------------------------------------------------------------------

const SECTIONS = new Set(['ASSETS', 'LIABILITIES', 'INCOME', 'EXPENDITURE', 'EXPENSES']);

/** -> { bs: [{ code, name, net, zohoCode, zohoNote }], plNet } (net = Dr − Cr, paise) */
export function readTrialBalance(s) {
  const hdr = s.rows.findIndex((r) => norm(r[0]) === 'ACTCODE');
  if (hdr < 0) throw new OpeningPlanError(`${s.name}: no "Act Code" header row`);
  const col = (label) => s.rows[hdr].findIndex((c) => norm(c) === norm(label));
  const cDr = col('Cl.Debit');
  const cCr = col('Cl.Credit');
  const cZ = s.rows[hdr].findIndex((c) => norm(c).startsWith('NEWCODEZOHO'));
  if (cDr < 0 || cCr < 0 || cZ < 0) throw new OpeningPlanError(`${s.name}: needs Cl.Debit, Cl.Credit and New Code_Zoho columns`);
  let section = null;
  const bs = [];
  let plNet = 0n;
  for (const r of s.rows.slice(hdr + 1)) {
    const code = text(r[0]);
    const name = text(r[1]);
    if (!code) {
      if (SECTIONS.has(name.toUpperCase())) section = name.toUpperCase();
      continue;
    }
    if (!name) continue;
    if (!section) throw new OpeningPlanError(`${s.name}: ledger ${code} before any section heading`);
    const net = toPaise(r[cDr]) - toPaise(r[cCr]);
    if (section === 'INCOME' || section === 'EXPENDITURE' || section === 'EXPENSES') { plNet += net; continue; }
    const z = text(r[cZ]);
    bs.push({ code, name, net, zohoCode: z.split(/\s+/)[0] || '', zohoNote: z.replace(/\s+/g, ' ') });
  }
  return { bs, plNet };
}

// ---- customer traces --------------------------------------------------------------------

/** -> [{ section, partyCode, partyName, type, number, date, dueDate, amount }] and section totals */
export function readCustomerTraces(s) {
  const hdr = s.rows.findIndex((r) => norm(r[0]) === 'CUSTOMERNAME');
  if (hdr < 0) throw new OpeningPlanError(`${s.name}: no "Customer Name" header row`);
  const docs = [];
  const sections = [];
  let current = null;
  for (const r of s.rows.slice(hdr + 1)) {
    const a = text(r[0]);
    if (!a) continue;
    const number = text(r[3]);
    if (!number) {
      const party = /^Cust\s*:\s*([^-\s]+)\s*-\s*(.+)$/i.exec(a);
      const clearing = /^\[\s*([A-Z0-9]+)\s*\]\s*(.+)$/i.exec(a);
      if (party) current = { kind: 'party', partyCode: party[1].trim(), partyName: party[2].trim(), total: toPaise(r[6]), docs: 0 };
      else if (clearing) current = { kind: 'clearing', account: clearing[1].trim(), partyCode: null, partyName: clearing[2].trim(), total: toPaise(r[6]), docs: 0 };
      else continue; // category headers and totals
      sections.push(current);
      continue;
    }
    if (!current) throw new OpeningPlanError(`${s.name}: document ${number} before any customer heading`);
    current.docs += 1;
    docs.push({
      section: current, type: text(r[2]).toUpperCase(), number, date: dateOf(r[4]), dueDate: dateOf(r[5]), amount: toPaise(r[6]),
    });
  }
  return { docs, sections };
}

/** Customer balance TB (002001 sheet): code -> closing net (paise), for the clearing sections. */
export function readPartyBalances(s) {
  const out = new Map();
  for (const r of s.rows) {
    const code = text(r[0]);
    if (!code || norm(code) === 'ACTCODE') continue;
    const net = toPaise(r[6]) - toPaise(r[7]);
    if (net !== 0n) out.set(code, { code, name: text(r[1]), net });
  }
  return out;
}

// ---- inter-branch -------------------------------------------------------------------------

export function readBranchBalances(s) {
  const out = [];
  for (const r of s.rows) {
    const code = text(r[0]);
    if (!code || norm(code) === 'ACTCODE') continue;
    const net = toPaise(r[6]) - toPaise(r[7]);
    if (net !== 0n) out.push({ partyCode: code, partyName: text(r[1]), net });
  }
  return out;
}

// ---- supplier working file ----------------------------------------------------------------

/** -> { groups: [{ name, stated (Cr positive), docs: [...], subtotals: [...] }] } */
export function readSupplierFile(s) {
  const groups = [];
  let g = null;
  for (const r of s.rows) {
    const a = text(r[0]);
    if (!a) continue;
    if (text(r[6]).toUpperCase() === 'GROUP TOTAL') {
      const stated = toPaise(r[8]);
      g = { name: a, stated, docs: [], subtotals: [] };
      groups.push(g);
      continue;
    }
    if (!g || norm(a) === 'SUPPLIERNAME') continue;
    const code = text(r[1]);
    const srno = text(r[4]);
    if (code && code !== '-' && srno && srno !== '-') {
      g.docs.push({
        partyCode: code, partyName: a, yr: text(r[2]), pfx: text(r[3]), srno, date: dateOf(r[5]), dueDate: dateOf(r[6]),
        original: toPaise(r[7]), balance: toPaise(r[8]), invoiceNo: text(r[9]), invoiceDate: dateOf(r[10]),
      });
    } else {
      g.subtotals.push({ label: a, balance: toPaise(r[8]) });
    }
  }
  return { groups };
}

// ---- plan ---------------------------------------------------------------------------------

const CREDIT_NOTE_TYPES = new Set(['CRNT', 'CN', 'CREDIT NOTE']);
const DEBIT_NOTE_TYPES = new Set(['DRNT', 'DN', 'DEBIT NOTE']);

/**
 * opts: { branch, asOf: 'YYYY-MM-DD', closingStock: paise, stockCode: 'AL0052', locationId }
 * -> { branch, asOf, locationId, gl: [...], documents: [...], checks: [...], warnings: [...] }
 */
export function buildOpeningPlan(buffer, opts) {
  const { branch, asOf, closingStock = 0n, stockCode = 'AL0052', locationId = null } = opts;
  if (!branch || !/^\d{4}-\d{2}-\d{2}$/.test(asOf ?? '')) throw new OpeningPlanError('branch and asOf (YYYY-MM-DD) are required');
  const wb = readXlsx(buffer);
  const tb = readTrialBalance(sheet(wb, 'TB'));
  const traces = readCustomerTraces(sheet(wb, 'CUSTOMER TRACES'));
  const partyBal = readPartyBalances(sheet(wb, 'CUSTOMER BALANCE'));
  const branches = readBranchBalances(sheet(wb, 'BRANCH BALANCE'));
  const suppliers = readSupplierFile(sheet(wb, 'SUPP TRACES WORKING'));
  const warnings = [];
  const checks = [];
  const documents = [];
  const covered = new Map(); // TB ledger code -> documents' net (Dr − Cr)
  const cover = (code, net) => covered.set(code, (covered.get(code) ?? 0n) + net);
  const tbByName = (name) => tb.bs.filter((l) => norm(l.name) === norm(name));
  const tbLine = (code) => tb.bs.find((l) => l.code === code && l.net !== 0n) ?? tb.bs.find((l) => l.code === code);

  // Customers. A clearing section (card / UPI) belongs to the customer whose balance equals its total.
  for (const sec of traces.sections) {
    if (sec.kind !== 'clearing') continue;
    const hits = [...partyBal.values()].filter((p) => p.net === sec.total);
    if (hits.length !== 1) throw new OpeningPlanError(`customer traces: section [${sec.account}] ${sec.partyName} (${fmt(sec.total)}) matches ${hits.length} customers in the customer balance sheet`);
    sec.partyCode = hits[0].code;
    sec.partyName = hits[0].name;
  }
  // Which TB control ledger each customer sits in: the customer balance sheet is one control
  // (002001 or 002022 ...); match each section's total to the TB line holding it.
  const custControls = tb.bs.filter((l) => /^0020\d\d$/.test(l.code) && l.code !== '002000' && l.net !== 0n);
  const controlFor = (sec) => {
    const exact = custControls.filter((l) => l.net === sec.total);
    if (exact.length === 1) return exact[0];
    return null;
  };
  // Group sections by control: if no single TB line equals a section, try the sum of clearing sections.
  const clearingTotal = traces.sections.filter((s) => s.kind === 'clearing').reduce((a, s) => a + s.total, 0n);
  const clearingControl = custControls.filter((l) => l.net === clearingTotal);
  for (const sec of traces.sections) {
    sec.control = controlFor(sec) ?? (sec.kind === 'clearing' && clearingControl.length === 1 ? clearingControl[0] : null);
    if (!sec.control) throw new OpeningPlanError(`customer traces: no TB debtors ledger holds ${sec.partyName}'s ${fmt(sec.total)}`);
  }
  for (const d of traces.docs) {
    const sec = d.section;
    const kind = DEBIT_NOTE_TYPES.has(d.type) ? 'debit_note' : (d.amount < 0n || CREDIT_NOTE_TYPES.has(d.type) ? 'credit_note' : 'invoice');
    if (kind === 'credit_note' && d.amount > 0n) warnings.push(`customer ${sec.partyCode} ${d.number}: credit-note type with a debit amount; posted as a credit note of ${fmt(d.amount)}`);
    const number = /^OPENING\s*BALANCE/i.test(d.number) ? `OB/${sec.partyCode}` : d.number;
    documents.push({
      kind, side: 'customer', partyCode: sec.partyCode, partyName: sec.partyName, controlCode: sec.control.code, controlZoho: sec.control.zohoCode,
      number: `${branch}/${number}`, date: d.date ?? asOf, dueDate: d.dueDate ?? d.date ?? asOf, amount: d.amount < 0n ? -d.amount : d.amount,
      sourceType: d.type, sourceRef: d.number, net: d.amount,
    });
    cover(sec.control.code, d.amount);
  }

  // Inter-branch: one document per branch, dated the opening date.
  const ib = tbLine('002000');
  for (const b of branches) {
    documents.push({
      kind: b.net > 0n ? 'invoice' : 'credit_note', side: 'customer', partyCode: b.partyCode, partyName: b.partyName,
      controlCode: '002000', controlZoho: ib?.zohoCode ?? '', number: `${branch}/IB/${b.partyCode}`, date: asOf, dueDate: asOf,
      amount: b.net > 0n ? b.net : -b.net, sourceType: 'BRANCH_BALANCE', sourceRef: `002000/${b.partyCode}`, net: b.net,
    });
    cover('002000', b.net);
  }

  // Suppliers: positive balance = owed (bill); negative = debit note (vendor credit), or an
  // advance (payment made) in an advance group.
  for (const g of suppliers.groups) {
    const lines = tbByName(g.name);
    const line = lines.find((l) => l.net !== 0n) ?? lines[0];
    if (!line) throw new OpeningPlanError(`supplier group "${g.name}" has no TB ledger of that name`);
    const isAdvance = /ADVANCE/i.test(g.name);
    let groupNet = 0n;
    for (const d of g.docs) {
      const voucher = `${d.yr}/${d.pfx}/${d.srno}`;
      const kind = d.balance > 0n ? 'bill' : (isAdvance ? 'vendor_advance' : 'vendor_credit');
      documents.push({
        kind, side: 'vendor', partyCode: d.partyCode, partyName: d.partyName, controlCode: line.code, controlZoho: line.zohoCode,
        number: `${branch}/${voucher}`, vendorInvoiceNo: d.invoiceNo || null, date: d.invoiceDate ?? d.date ?? asOf, dueDate: d.dueDate ?? d.date ?? asOf,
        amount: d.balance < 0n ? -d.balance : d.balance, sourceType: g.name, sourceRef: voucher, net: -d.balance,
      });
      groupNet += d.balance;
      cover(line.code, -d.balance);
    }
    checks.push({ check: `Supplier group "${g.name}": documents vs group total`, expected: fmt(g.stated), actual: fmt(groupNet), ok: groupNet === g.stated });
  }

  // Control ledgers: TB balance must equal its documents.
  for (const [code, net] of covered) {
    const lines = tb.bs.filter((l) => l.code === code);
    const tbNet = lines.reduce((a, l) => a + l.net, 0n);
    checks.push({ check: `TB ${code} ${lines[0]?.name ?? ''}: TB balance vs documents`, expected: fmt(tbNet), actual: fmt(net), ok: tbNet === net });
  }

  // GL: every balance-sheet ledger not carried by documents, by its Zoho code; reserves take
  // the year's result less the closing stock carried as an asset.
  const glByCode = new Map();
  const addGl = (zohoCode, net, source) => {
    if (net === 0n) return;
    if (!zohoCode) throw new OpeningPlanError(`TB ledger ${source} has a balance of ${fmt(net)} but no New Code_Zoho`);
    const e = glByCode.get(zohoCode) ?? { zohoCode, net: 0n, sources: [] };
    e.net += net;
    e.sources.push(source);
    glByCode.set(zohoCode, e);
  };
  const reserve = tb.bs.find((l) => /RESERVE/i.test(l.name) && l.net !== 0n);
  if (!reserve) throw new OpeningPlanError('TB: no Reserve & Surplus ledger with a balance');
  for (const l of tb.bs) {
    if (covered.has(l.code)) continue;
    if (l === reserve) continue;
    addGl(l.zohoCode, l.net, `${l.code} ${l.name}`);
  }
  const reserveNet = reserve.net + tb.plNet - closingStock;
  addGl(reserve.zohoCode, reserveNet, `${reserve.code} ${reserve.name} (TB ${fmt(reserve.net)} + year result ${fmt(tb.plNet)} − closing stock ${fmt(closingStock)})`);
  if (closingStock !== 0n) addGl(stockCode, closingStock, `closing stock as on ${asOf}`);
  if (closingStock === 0n) warnings.push('closing stock is 0: the stock asset and reserves will be understated unless that is right');
  const gl = [...glByCode.values()].filter((e) => e.net !== 0n);

  const glNet = gl.reduce((a, e) => a + e.net, 0n);
  const docNet = documents.reduce((a, d) => a + d.net, 0n);
  checks.push({ check: 'GL lines + documents balance (Dr = Cr)', expected: '0.00', actual: fmt(glNet + docNet), ok: glNet + docNet === 0n });

  assignBooksNumbers(documents);
  const tooLong = documents.filter((d) => d.number.length > BOOKS_NUMBER_MAX);
  checks.push({ check: `Books document numbers: at most ${BOOKS_NUMBER_MAX} characters, letters / digits / - / only`, expected: '0', actual: String(tooLong.length), ok: tooLong.length === 0 });
  const seen = new Set();
  const dupes = documents.filter((d) => { const k = `${d.kind}|${d.number}`; const hit = seen.has(k); seen.add(k); return hit; });
  checks.push({ check: 'Books document numbers: unique within each module', expected: '0', actual: String(dupes.length), ok: dupes.length === 0 });

  return { branch, asOf, locationId, gl, documents, checks, warnings, totals: { glNet, docNet, plNet: tb.plNet, closingStock, reserveNet } };
}

// Books document numbers: at most 16 characters of letters, digits, hyphen and slash (code
// 71530), and unique within a module (one Eco Green voucher can carry several suppliers).
export const BOOKS_NUMBER_MAX = 16;

/** Books-safe form of a document number: other characters become '-'. */
export function booksSafeNumber(n) {
  return String(n).replace(/[^A-Za-z0-9/-]+/g, '-').replace(/-{2,}/g, '-').replace(/-$/, '');
}

/** Shorter form: the separator between a two-digit year and the voucher prefix goes (460/25/J/1 -> 460/25J/1). */
function compactNumber(n) {
  return n.replace(/^(\d+)\/(\d{2})\/([A-Za-z0-9]+)\//, '$1/$2$3/');
}

/**
 * Gives every document its Books number in place (the Eco Green voucher stays in sourceRef):
 * Books-safe, compacted when too long, and suffixed -2, -3 … when a module repeats a number.
 */
export function assignBooksNumbers(documents) {
  const fit = (n) => (n.length > BOOKS_NUMBER_MAX ? compactNumber(n) : n);
  const count = new Map();
  for (const d of documents) {
    const base = fit(booksSafeNumber(d.number));
    const k = `${d.kind}|${base}`;
    count.set(k, (count.get(k) ?? 0) + 1);
  }
  const used = new Map();
  for (const d of documents) {
    const base = fit(booksSafeNumber(d.number));
    const k = `${d.kind}|${base}`;
    const i = (used.get(k) ?? 0) + 1;
    used.set(k, i);
    d.number = count.get(k) > 1 && i > 1 ? fit(`${compactNumber(base)}-${i}`) : base;
  }
  return documents;
}

/** Plain summary for the report. */
export function summarisePlan(plan) {
  const byKind = {};
  for (const d of plan.documents) {
    const k = `${d.side}:${d.kind}`;
    byKind[k] ??= { count: 0, amount: 0n };
    byKind[k].count += 1;
    byKind[k].amount += d.amount;
  }
  return Object.fromEntries(Object.entries(byKind).map(([k, v]) => [k, { count: v.count, amount: fmt(v.amount) }]));
}
