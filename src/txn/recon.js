// Closing reconciliation for a branch as on the cut-off (₹1 tolerance), in three parts:
//   A. Eco Green integrity: the closing TB's movement for each TB code equals the ledger table's
//      lines rolled up to that code (parties to their control group, "#NAME?" codes by name) –
//      proves the ledger file is the whole period.
//   B. Books vs expectation, account by account (Zoho code): opening plan (GL lines + documents on
//      their control) + every ledger line posted to Books (ours; Smart Pharma's too once they are
//      in Books), mapped to Zoho codes.
//   C. Parties: each customer / vendor net balance in Books vs opening documents + posted lines;
//      Eco Green's own closing per party (all lines) alongside, the difference being Smart Pharma's.
import { formatMoney } from '../core/money.js';
import { toPaise, INTER_BRANCH } from './plan.js';

const fmt = (p) => formatMoney(p);
const text = (v) => (v === null || v === undefined ? '' : String(v).trim());
const norm = (s) => text(s).toUpperCase().replace(/[^A-Z0-9]/g, '');
const abs = (p) => (p < 0n ? -p : p);
export const TOLERANCE = 100n; // ₹1
const addTo = (m, k, v) => m.set(k, (m.get(k) ?? 0n) + v);

/** Closing TB report rows -> Map(code -> { code, name, op, tran, cl }), Dr − Cr, duplicates summed. */
export function readClosingTb(rows) {
  const hdr = rows.findIndex((r) => norm(r[0]) === 'ACTCODE');
  if (hdr < 0) throw new Error('closing TB: no "Act Code" header row');
  const out = new Map();
  for (const r of rows.slice(hdr + 1)) {
    const code = text(r[0]);
    if (!code || norm(code) === 'ACTCODE') continue;
    const e = out.get(code) ?? { code, name: text(r[1]), op: 0n, tran: 0n, cl: 0n };
    e.op += toPaise(r[2]) - toPaise(r[3]);
    e.tran += toPaise(r[4]) - toPaise(r[5]);
    e.cl += toPaise(r[6]) - toPaise(r[7]);
    out.set(code, e);
  }
  return out;
}

/** Ledger line -> closing TB code. */
export function tbCodeOf(l, byName) {
  if (l.party || l.type === 3 || l.account === INTER_BRANCH) return l.control || '';
  if (l.account.startsWith('NAME:')) return byName.get(norm(l.account.slice(5))) ?? l.account;
  return /^\d+$/.test(l.code) ? l.code.padStart(6, '0') : l.code;
}

/** A. closing TB movement vs ledger, per TB code. */
export function ecoIntegrity(lines, tb) {
  const byName = new Map([...tb.values()].map((e) => [norm(e.name), e.code]));
  const ledger = new Map();
  for (const l of lines) addTo(ledger, tbCodeOf(l, byName), l.amount);
  const rows = [];
  for (const code of new Set([...tb.keys(), ...ledger.keys()])) {
    const t = tb.get(code)?.tran ?? 0n;
    const g = ledger.get(code) ?? 0n;
    if (t === 0n && g === 0n) continue;
    rows.push({ code, name: tb.get(code)?.name ?? '(not in closing TB)', tb: t, ledger: g, diff: g - t, ok: abs(g - t) <= TOLERANCE });
  }
  return rows.sort((a, b) => a.code.localeCompare(b.code));
}

/** Zoho code a ledger line posts to (null when it cannot be mapped). */
export function zohoCodeOf(l, accountMap, groupZoho) {
  if (l.party) return groupZoho.get(l.control) ?? null;
  return accountMap[l.account] ?? null;
}

/** B. expected Books net per Zoho code: opening plan + posted lines. */
export function expectedBooks({ opening, lines, accountMap, groupZoho }) {
  const exp = new Map();
  for (const g of opening.gl) addTo(exp, g.zohoCode, BigInt(g.net));
  for (const d of opening.documents) addTo(exp, d.controlZoho, BigInt(d.net));
  const unmapped = new Map();
  for (const l of lines) {
    const z = zohoCodeOf(l, accountMap, groupZoho);
    if (z) addTo(exp, z, l.amount); else addTo(unmapped, `${l.account} ${l.name}`, l.amount);
  }
  return { exp, unmapped };
}

/** Books trial balance report JSON -> Map(code or "name:<name>" -> { name, net }). */
export function readBooksTb(json) {
  const out = new Map();
  const walk = (nodes) => {
    for (const n of nodes ?? []) {
      if (n.account_id) {
        const key = text(n.account_code) || `name:${text(n.name)}`;
        const e = out.get(key) ?? { name: text(n.name), net: 0n };
        e.net += toPaise(n.net_debit_total === '' ? 0 : n.net_debit_total) - toPaise(n.net_credit_total === '' ? 0 : n.net_credit_total);
        out.set(key, e);
      }
      walk(n.account_transactions);
    }
  };
  walk(json.trialbalance);
  return out;
}

export function compareTb(exp, books, names = new Map()) {
  const rows = [];
  for (const key of new Set([...exp.keys(), ...books.keys()])) {
    const e = exp.get(key) ?? 0n;
    const b = books.get(key)?.net ?? 0n;
    if (e === 0n && b === 0n) continue;
    rows.push({ code: key, name: books.get(key)?.name ?? names.get(key) ?? '', expected: e, books: b, diff: b - e, ok: abs(b - e) <= TOLERANCE });
  }
  return rows.sort((a, b) => (a.ok === b.ok ? a.code.localeCompare(b.code) : a.ok ? 1 : -1));
}

/**
 * C. parties. Expected (Books) and Eco Green closing per "side:code", Dr − Cr; Books balances by
 * contact id mapped back through `contacts` ("side:code" -> contact id).
 */
export function compareParties({ opening, posted, all, contacts, customers, vendors }) {
  const exp = new Map();
  const eco = new Map();
  const names = new Map();
  for (const d of opening.documents) {
    const k = `${d.side}:${d.partyCode}`;
    addTo(exp, k, BigInt(d.net));
    addTo(eco, k, BigInt(d.net));
    names.set(k, d.partyName);
  }
  for (const l of posted) if (l.party) { addTo(exp, `${l.party}:${l.code}`, l.amount); names.set(`${l.party}:${l.code}`, l.name); }
  for (const l of all) if (l.party) { addTo(eco, `${l.party}:${l.code}`, l.amount); names.set(`${l.party}:${l.code}`, l.name); }
  const byContact = new Map(Object.entries(contacts).map(([k, id]) => [String(id), k]));
  const books = new Map();
  const extra = [];
  for (const c of customers ?? []) {
    const k = byContact.get(String(c.customer_id));
    const v = { net: toPaise(c.bcy_balance), open: toPaise(c.invoice_balance), credits: toPaise(c.available_credits), name: c.customer_name };
    if (k) books.set(k, v); else extra.push({ side: 'customer', name: c.customer_name, ...v });
  }
  for (const c of vendors ?? []) {
    const k = byContact.get(String(c.vendor_id));
    // vendor balances are payable-positive; Dr − Cr is the negative
    const v = { net: -toPaise(c.bcy_balance), open: -toPaise(c.bill_balance), credits: toPaise(c.excess_payment), name: c.vendor_name };
    if (k) books.set(k, v); else extra.push({ side: 'vendor', name: c.vendor_name, ...v });
  }
  const rows = [];
  for (const k of new Set([...exp.keys(), ...books.keys()])) {
    const e = exp.get(k) ?? 0n;
    const b = books.get(k)?.net ?? 0n;
    const g = eco.get(k) ?? 0n;
    if (e === 0n && b === 0n && g === 0n) continue;
    const [side, code] = k.split(':');
    rows.push({ side, code, name: names.get(k) ?? books.get(k)?.name ?? '', expected: e, books: b, diff: b - e, ok: abs(b - e) <= TOLERANCE, ecoClosing: g, smartPharma: g - e, open: books.get(k)?.open ?? 0n, credits: books.get(k)?.credits ?? 0n });
  }
  return { rows: rows.sort((a, b) => (a.ok === b.ok ? a.side.localeCompare(b.side) || a.code.localeCompare(b.code) : a.ok ? 1 : -1)), extra };
}

export function reconReport({ branch, asOf, integrity, tb, unmapped, parties }) {
  const L = [];
  const bad = (rows) => rows.filter((r) => !r.ok);
  L.push(`# Branch ${branch} – closing reconciliation as on ${asOf}`, '', `Tolerance ₹${fmt(TOLERANCE)} per line.`, '');
  L.push('## A. Eco Green: closing TB movement vs ledger table', '', `${integrity.length - bad(integrity).length}/${integrity.length} TB codes tie.`, '');
  if (bad(integrity).length) {
    L.push('| Code | Account | TB movement | Ledger | Difference |', '|---|---|---:|---:|---:|');
    for (const r of bad(integrity)) L.push(`| ${r.code} | ${r.name} | ${fmt(r.tb)} | ${fmt(r.ledger)} | ${fmt(r.diff)} |`);
    L.push('');
  }
  L.push('## B. Zoho Books trial balance vs opening + posted lines', '', `${tb.length - bad(tb).length}/${tb.length} accounts tie.`, '');
  if (bad(tb).length) {
    L.push('| Zoho code | Account | Expected (Dr+/Cr−) | Books | Difference |', '|---|---|---:|---:|---:|');
    for (const r of bad(tb)) L.push(`| ${r.code} | ${r.name} | ${fmt(r.expected)} | ${fmt(r.books)} | ${fmt(r.diff)} |`);
    L.push('');
  }
  if (unmapped.size) {
    L.push(`Posted lines with no Zoho code (left out of the expectation): ${unmapped.size}`, '');
    for (const [k, v] of unmapped) L.push(`- ${k}: ${fmt(v)}`);
    L.push('');
  }
  const pr = parties.rows;
  L.push('## C. Customers and vendors', '', `${pr.length - bad(pr).length}/${pr.length} parties tie (Books net = opening documents + posted lines).`, '');
  if (bad(pr).length) {
    L.push('| Side | Code | Party | Expected | Books | Difference |', '|---|---|---|---:|---:|---:|');
    for (const r of bad(pr)) L.push(`| ${r.side} | ${r.code} | ${r.name} | ${fmt(r.expected)} | ${fmt(r.books)} | ${fmt(r.diff)} |`);
    L.push('');
  }
  if (parties.extra.length) L.push(`Books contacts with a balance not in the plan: ${parties.extra.map((e) => `${e.side} ${e.name} ${fmt(e.net)}`).join('; ')}`, '');
  const sp = pr.filter((r) => r.smartPharma !== 0n);
  L.push(`Eco Green closing differs from Books by Smart Pharma's documents for ${sp.length} parties (total ${fmt(sp.reduce((t, r) => t + r.smartPharma, 0n))}); see parties.csv.`, '');
  return `${L.join('\n')}\n`;
}
