// Data validation and reconciliation (branch page -> Data validation).
//
// The user uploads three files - Opening TB, Closing TB and the transactional ledger - and
// every account is reconciled on:
//
//     Opening balance + (total debit - total credit) = calculated closing  ==  Closing TB
//
// Files are read loosely so the Eco Green reports (Act Code / Op.Debit / Cl.Credit ...,
// c_act_code / Debit / Credit ...) and plain exports (Account Code, Account Name, Debit,
// Credit, Balance ...) all work. Accounts are matched across the files by code (numeric codes
// compared without leading zeros, as Excel drops them), then by name, and through the
// confirmed manual mappings, which are kept for later runs.
//
// Amounts are exact (BigInt paise, src/core/money.js). Debit balances are positive.
// Pure: no store or archive access here; the routes persist runs and mappings.
import { readXlsx } from '../sources/ecogreen/xlsx.js';
import { parseCsv, detectEncoding, decode } from './csv.js';
import { parseMoney, formatMoney } from './money.js';
import { sha256Bytes } from './hash.js';
import { similarity } from './mapping_proposals.js';

export class ValidationError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export const ROLES = Object.freeze(['opening', 'closing', 'ledger']);
const ROLE_WORDS = { opening: 'Opening TB', closing: 'Closing TB', ledger: 'Ledger' };
export const OPENING_BASIS = Object.freeze(['auto', 'closing_columns', 'opening_columns', 'closing_tb_opening']);

const key = (h) => String(h ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const nameKey = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const text = (v) => (v === null || v === undefined ? '' : typeof v === 'object' && v.date ? v.date : String(v)).trim();
/** Codes lose the leading apostrophe Excel uses to keep them as text ('000939). */
const codeText = (v) => text(v).replace(/^'+/, '');

/** Account codes: trimmed, upper case; all-digit codes without leading zeros. */
export function normCode(code) {
  const s = codeText(code).toUpperCase();
  return /^\d+$/.test(s) ? s.replace(/^0+(?=\d)/, '') : s;
}

// Header aliases, compared after key().
const COLS = {
  code: ['actcode', 'accountcode', 'ledgercode', 'cactcode', 'acctcode', 'glcode', 'code', 'accountno', 'accountnumber'],
  name: ['accountname', 'ledgername', 'actname', 'description', 'name', 'account', 'particulars', 'ledger'],
  opDebit: ['opdebit', 'openingdebit', 'opdr', 'openingdr', 'openingbalancedebit'],
  opCredit: ['opcredit', 'openingcredit', 'opcr', 'openingcr', 'openingbalancecredit'],
  trDebit: ['trandebit', 'transactiondebit', 'trdebit', 'perioddebit', 'movementdebit'],
  trCredit: ['trancredit', 'transactioncredit', 'trcredit', 'periodcredit', 'movementcredit'],
  clDebit: ['cldebit', 'closingdebit', 'cldr', 'closingdr', 'closingbalancedebit'],
  clCredit: ['clcredit', 'closingcredit', 'clcr', 'closingcr', 'closingbalancecredit'],
  debit: ['debit', 'dr', 'debitamount', 'debitinr'],
  credit: ['credit', 'cr', 'creditamount', 'creditinr'],
  balance: ['balance', 'netbalance', 'closingbalance', 'openingbalance', 'amount', 'net'],
  date: ['ddate', 'date', 'voucherdate', 'transactiondate', 'txndate', 'postingdate'],
  voucher: ['voucherno', 'vouchernumber', 'voucher', 'documentno', 'docno', 'referenceno', 'transactionno'],
  year: ['cyear'],
  prefix: ['cprefix'],
  tranNo: ['ntranno'],
  narration: ['narration', 'remarks', 'memo', 'notes'],
  control: ['controlaccount', 'controlledger', 'status', 'parentaccount', 'group'],
};

function findCol(header, aliases, taken = new Set()) {
  const keys = header.map(key);
  for (const a of aliases) {
    const i = keys.indexOf(a);
    if (i !== -1 && !taken.has(i)) return i;
  }
  return -1;
}

/** Rows (arrays) of a CSV or the first sheet of an XLSX. */
function readRows(bytes, fileName) {
  if (bytes.length > 4 && bytes.readUInt32LE(0) === 0x04034b50) {
    let wb;
    try { wb = readXlsx(bytes); } catch (e) { throw new ValidationError('BAD_FILE', `${fileName}: Excel file could not be read (${e.message})`); }
    const sheet = wb.sheets.find((s) => s.rows.some((r) => r.some((c) => c !== null && c !== '')));
    if (!sheet) throw new ValidationError('BAD_FILE', `${fileName}: the Excel file has no data`);
    return sheet.rows;
  }
  const enc = detectEncoding(bytes);
  if (enc === 'unknown') throw new ValidationError('BAD_FILE', `${fileName}: unsupported text encoding; save it as CSV (UTF-8) or XLSX`);
  const { header, rows } = parseCsv(decode(bytes, enc));
  return header.length ? [header, ...rows] : [];
}

function money(fileName, row, idx, label) {
  if (idx < 0) return 0n;
  const cellValue = row[idx];
  if (typeof cellValue === 'number') {
    if (!Number.isFinite(cellValue)) throw new ValidationError('BAD_AMOUNT', `${fileName}: ${label} holds an invalid number`);
    return parseMoney(cellValue.toFixed(2));
  }
  const raw = text(cellValue).replace(/,/g, '');
  if (raw === '' || raw === '-') return 0n;
  // "(1,234.00)" and "1,234.00 Cr" / "1,234.00 Dr" style values
  const neg = /^\(.*\)$/.test(raw);
  const cr = /\s*cr$/i.test(raw);
  const cleaned = raw.replace(/[()]/g, '').replace(/\s*(dr|cr)$/i, '').trim();
  const n = Number(cleaned);
  if (cleaned === '' || !Number.isFinite(n)) throw new ValidationError('BAD_AMOUNT', `${fileName}: "${raw}" in ${label} is not an amount`);
  // Exact when the text has at most two decimals; otherwise rounded to paise.
  let v = /^-?\d*(\.\d{0,2})?$/.test(cleaned) ? parseMoney(cleaned) : parseMoney(n.toFixed(2));
  if (cr) v = -v;
  return neg ? -v : v;
}

const TOTAL_ROW = /^(grand\s*)?total\b|^sub\s*total\b/i;

/**
 * Read one trial balance. role 'opening' | 'closing'. Returns
 * { fileName, sha256, basis, columns, rows: [{ line, code, name, balance, op?, tr?, cl?, flags[] }] }.
 */
export function readTrialBalanceFile(bytes, { fileName, role, openingBasis = 'auto' }) {
  const table = readRows(bytes, fileName);
  const headerRow = table.slice(0, 40).findIndex((r) => {
    const h = r.map((c) => text(c));
    return (findCol(h, COLS.code) !== -1 || findCol(h, COLS.name) !== -1)
      && [COLS.clDebit, COLS.opDebit, COLS.debit, COLS.balance].some((a) => findCol(h, a) !== -1);
  });
  if (headerRow < 0) {
    throw new ValidationError('HEADER_NOT_FOUND', `${fileName} (${ROLE_WORDS[role]}): no header row with an account code or name and Debit/Credit or Balance columns was found in the first 40 rows`);
  }
  const header = table[headerRow].map((c) => text(c));
  const c = {};
  c.code = findCol(header, COLS.code);
  c.name = findCol(header, COLS.name, new Set([c.code]));
  for (const k of ['opDebit', 'opCredit', 'trDebit', 'trCredit', 'clDebit', 'clCredit']) c[k] = findCol(header, COLS[k]);
  const used = new Set(Object.values(c).filter((i) => i >= 0));
  c.debit = findCol(header, COLS.debit, used);
  c.credit = findCol(header, COLS.credit, used);
  c.balance = findCol(header, COLS.balance, used);

  const hasOp = c.opDebit >= 0 || c.opCredit >= 0;
  const hasCl = c.clDebit >= 0 || c.clCredit >= 0;
  const hasPair = c.debit >= 0 || c.credit >= 0;
  let basis;
  if (role === 'opening' && openingBasis === 'opening_columns') {
    if (!hasOp) throw new ValidationError('BASIS_UNAVAILABLE', `${fileName}: there are no opening (Op.) columns to use`);
    basis = 'opening_columns';
  } else if (role === 'opening' && openingBasis === 'closing_columns') {
    if (!hasCl) throw new ValidationError('BASIS_UNAVAILABLE', `${fileName}: there are no closing (Cl.) columns to use`);
    basis = 'closing_columns';
  } else if (hasCl) basis = 'closing_columns'; // balance as at the report date
  else if (hasOp && role === 'opening') basis = 'opening_columns';
  else if (hasPair) basis = 'debit_credit';
  else if (c.balance >= 0) basis = 'balance';
  else throw new ValidationError('HEADER_NOT_FOUND', `${fileName}: no balance columns found (expected Cl.Debit/Cl.Credit, Debit/Credit or Balance)`);
  const pairOf = { closing_columns: ['clDebit', 'clCredit'], opening_columns: ['opDebit', 'opCredit'], debit_credit: ['debit', 'credit'] };

  const rows = [];
  table.slice(headerRow + 1).forEach((r, i) => {
    const line = headerRow + i + 2;
    const code = c.code >= 0 ? codeText(r[c.code]) : '';
    const name = c.name >= 0 ? text(r[c.name]) : '';
    if (!code && !name) return;
    if (TOTAL_ROW.test(name) || TOTAL_ROW.test(code)) return;
    // Group headings in the Eco Green report carry a name but no code; skip them when the file has codes.
    if (c.code >= 0 && !code) return;
    const flags = [];
    let balance;
    if (basis === 'balance') {
      balance = money(fileName, r, c.balance, header[c.balance]);
    } else {
      const [dk, ck] = pairOf[basis];
      const d = money(fileName, r, c[dk], header[c[dk]] ?? dk);
      let cr = money(fileName, r, c[ck], header[c[ck]] ?? ck);
      if (cr < 0n) cr = -cr; // credits written as negatives
      if (d < 0n) flags.push({ type: 'NEGATIVE_DEBIT', detail: `${header[c[dk]]} is negative (${formatMoney(d)})` });
      if (d !== 0n && cr !== 0n) flags.push({ type: 'BOTH_SIDES', detail: `both ${header[c[dk]]} (${formatMoney(d)}) and ${header[c[ck]]} (${formatMoney(cr)}) are filled` });
      balance = d - cr;
    }
    const net = (dk, ck) => {
      if (c[dk] < 0 && c[ck] < 0) return null;
      const d = money(fileName, r, c[dk], dk);
      let cr = money(fileName, r, c[ck], ck);
      if (cr < 0n) cr = -cr;
      return d - cr;
    };
    rows.push({ line, code, name, balance, op: net('opDebit', 'opCredit'), tr: net('trDebit', 'trCredit'), cl: net('clDebit', 'clCredit'), flags });
  });
  if (rows.length === 0) throw new ValidationError('NO_ROWS', `${fileName} (${ROLE_WORDS[role]}): no account rows found under the header`);
  const columns = Object.fromEntries(Object.entries(c).filter(([, i]) => i >= 0).map(([k, i]) => [k, header[i]]));
  return { fileName, sha256: sha256Bytes(bytes), role, basis, columns, hasCode: c.code >= 0, rows };
}

/** Read the transactional ledger: one row per account line. */
export function readLedgerFile(bytes, { fileName }) {
  const table = readRows(bytes, fileName);
  const headerRow = table.slice(0, 40).findIndex((r) => {
    const h = r.map((c) => text(c));
    return (findCol(h, COLS.code) !== -1 || findCol(h, COLS.name) !== -1) && (findCol(h, COLS.debit) !== -1 || findCol(h, COLS.balance) !== -1);
  });
  if (headerRow < 0) {
    throw new ValidationError('HEADER_NOT_FOUND', `${fileName} (Ledger): no header row with an account code or name and Debit/Credit columns was found in the first 40 rows`);
  }
  const header = table[headerRow].map((c) => text(c));
  const c = {};
  c.code = findCol(header, COLS.code);
  c.name = findCol(header, ['actname', 'accountname', 'ledgername', 'name', 'account', 'particulars', 'ledger', 'description'], new Set([c.code]));
  c.debit = findCol(header, COLS.debit);
  c.credit = findCol(header, COLS.credit);
  c.amount = c.debit < 0 ? findCol(header, COLS.balance) : -1;
  c.date = findCol(header, COLS.date);
  c.voucher = findCol(header, COLS.voucher);
  c.year = findCol(header, COLS.year);
  c.prefix = findCol(header, COLS.prefix);
  c.tranNo = findCol(header, COLS.tranNo);
  c.narration = findCol(header, COLS.narration, new Set([c.name]));
  c.control = findCol(header, COLS.control);

  const lines = [];
  table.slice(headerRow + 1).forEach((r, i) => {
    const line = headerRow + i + 2;
    const code = c.code >= 0 ? codeText(r[c.code]) : '';
    const name = c.name >= 0 ? text(r[c.name]) : '';
    if (!code && !name) return; // footer / blank
    if (TOTAL_ROW.test(name) || TOTAL_ROW.test(code)) return;
    const flags = [];
    let debit; let credit;
    if (c.amount >= 0) {
      const v = money(fileName, r, c.amount, header[c.amount]);
      debit = v > 0n ? v : 0n; credit = v < 0n ? -v : 0n;
    } else {
      debit = money(fileName, r, c.debit, header[c.debit] ?? 'Debit');
      credit = money(fileName, r, c.credit, header[c.credit] ?? 'Credit');
      if (credit < 0n) credit = -credit;
      if (debit < 0n) { flags.push({ type: 'NEGATIVE_DEBIT', detail: `Debit is negative (${formatMoney(debit)})` }); }
      if (debit !== 0n && credit !== 0n) flags.push({ type: 'BOTH_SIDES', detail: `both Debit (${formatMoney(debit)}) and Credit (${formatMoney(credit)}) are filled` });
    }
    let voucher = c.voucher >= 0 ? text(r[c.voucher]) : '';
    if (!voucher && c.tranNo >= 0) voucher = [c.year, c.prefix, c.tranNo].filter((k) => k >= 0).map((k) => text(r[k])).filter(Boolean).join('/');
    lines.push({
      line, code, name, debit, credit, flags, control: c.control >= 0 ? text(r[c.control]) : '',
      date: c.date >= 0 ? text(r[c.date]) : '', voucher, narration: c.narration >= 0 ? text(r[c.narration]) : '',
    });
  });
  if (lines.length === 0) throw new ValidationError('NO_ROWS', `${fileName} (Ledger): no transaction rows found under the header`);
  const columns = Object.fromEntries(Object.entries(c).filter(([, i]) => i >= 0).map(([k, i]) => [k, header[i]]));
  return { fileName, sha256: sha256Bytes(bytes), role: 'ledger', columns, hasCode: c.code >= 0, lines };
}

/** The key a file row is known by: its code when the file has codes, else its name. */
const fileKey = (hasCode, code, name) => (hasCode && code ? `C:${normCode(code)}` : `N:${nameKey(name)}`);

/**
 * Reconcile. files: { opening?, closing, ledger } as returned by the readers.
 * mappings: [{ role, from_key, to_key }] confirmed by users (to_key is an account key).
 * -> { summary, accounts[], exceptions{...}, lines{ accountKey: [...] } }
 */
export function reconcile({ opening = null, closing, ledger }, { mappings = [], tolerance = '0.00' } = {}) {
  const tol = parseMoney(String(tolerance));
  const accounts = new Map(); // account key -> account
  const byCode = new Map(); // normCode -> account key
  const byName = new Map(); // nameKey -> Set(account key)
  const mapFor = new Map(mappings.map((m) => [`${m.role}|${m.from_key}`, m.to_key]));
  const duplicates = [];
  const inconsistencies = [];

  const addName = (acc, name) => {
    const n = nameKey(name);
    if (!n) return;
    if (!byName.has(n)) byName.set(n, new Set());
    byName.get(n).add(acc.key);
  };
  const newAccount = (fk, code, name) => {
    const acc = {
      key: fk, code: code || '', name: name || '', names: {}, keys: { opening: new Set(), closing: new Set(), ledger: new Set() },
      in: { opening: false, closing: false, ledger: false },
      opening: 0n, closing: 0n, debit: 0n, credit: 0n, lines: 0, mapped: {}, closingTbOpening: null, closingTbMovement: null,
    };
    accounts.set(fk, acc);
    if (code) byCode.set(normCode(code), fk);
    addName(acc, name);
    return acc;
  };
  /** Find (or create) the account a file row belongs to. */
  const resolve = (role, hasCode, code, name) => {
    const fk = fileKey(hasCode, code, name);
    const mapped = mapFor.get(`${role}|${fk}`);
    if (mapped && accounts.has(mapped)) return { acc: accounts.get(mapped), fk, how: 'mapping' };
    if (hasCode && code) {
      const k = byCode.get(normCode(code));
      if (k) return { acc: accounts.get(k), fk, how: 'code' };
    }
    const n = nameKey(name);
    const sameName = n ? [...(byName.get(n) ?? [])] : [];
    // A name match links rows only when the target has no code that contradicts this row's code.
    const candidates = sameName.map((k) => accounts.get(k)).filter((a) => !(hasCode && code && a.code && normCode(a.code) !== normCode(code)));
    if (candidates.length === 1) return { acc: candidates[0], fk, how: 'name' };
    const acc = newAccount(mapped ?? fk, hasCode ? code : '', name);
    return { acc, fk, how: mapped ? 'mapping' : 'new' };
  };

  const partyOf = new Map(); // ledger file key -> "code name" of a party routed to its control ledger
  /**
   * Eco Green ledgers carry party lines under the party's own code, with the control ledger
   * named in a Status / Control account column. A line whose code is not an account of the
   * trial balances goes to the account its control column names (by name or code).
   */
  const viaControl = (r) => {
    if (!r.control || !ledger.hasCode || !r.code) return null;
    const fk = fileKey(true, r.code, r.name);
    if (mapFor.has(`ledger|${fk}`) || byCode.has(normCode(r.code))) return null;
    const byCtlCode = byCode.get(normCode(r.control));
    const named = [...(byName.get(nameKey(r.control)) ?? [])];
    const target = byCtlCode ?? (named.length === 1 ? named[0] : null);
    if (!target) return null;
    const acc = accounts.get(target);
    if (!acc.in.closing && !acc.in.opening) return null;
    return { acc, fk, how: 'control' };
  };

  const place = (role, file) => {
    const seen = new Map(); // account key -> Set(file key) for duplicate detection
    const items = role === 'ledger' ? file.lines : file.rows;
    for (const r of items) {
      const { acc, fk, how } = (role === 'ledger' && viaControl(r)) || resolve(role, file.hasCode, r.code, r.name);
      if (how === 'control') {
        // A party line: it belongs to its control ledger; the party is shown in the drill-down.
        acc.in.ledger = true; acc.keys.ledger.add(fk); partyOf.set(fk, `${r.code} ${r.name}`.trim());
        acc.debit += r.debit; acc.credit += r.credit; acc.lines += 1; acc.partyLines = (acc.partyLines ?? 0) + 1;
        for (const f of r.flags) inconsistencies.push({ type: f.type, file: ROLE_WORDS[role], line: r.line, account_code: r.code, account_name: r.name, detail: f.detail });
        continue;
      }
      if (!acc.code && r.code && file.hasCode) { acc.code = r.code; byCode.set(normCode(r.code), acc.key); }
      if (!acc.name && r.name) acc.name = r.name;
      if (r.name) {
        acc.names[role] = acc.names[role] ?? new Set();
        acc.names[role].add(r.name);
        addName(acc, r.name);
      }
      acc.in[role] = true;
      acc.keys[role].add(fk);
      if (how === 'mapping') acc.mapped[role] = true;
      if (!seen.has(acc.key)) seen.set(acc.key, new Map());
      seen.get(acc.key).set(fk, r.name);
      if (role === 'ledger') {
        acc.debit += r.debit; acc.credit += r.credit; acc.lines += 1;
      } else if (role === 'opening') {
        acc.opening += r.balance;
      } else {
        acc.closing += r.balance;
        if (r.op !== null) acc.closingTbOpening = (acc.closingTbOpening ?? 0n) + r.op;
        if (r.tr !== null) acc.closingTbMovement = (acc.closingTbMovement ?? 0n) + r.tr;
      }
      for (const f of r.flags) {
        inconsistencies.push({ type: f.type, file: ROLE_WORDS[role], line: r.line, account_code: r.code, account_name: r.name, detail: f.detail });
      }
    }
    // Several different source rows landing on one account within the same file.
    for (const [accKey, keys] of seen) {
      if (keys.size > 1) {
        const acc = accounts.get(accKey);
        duplicates.push({
          file: ROLE_WORDS[role], account_key: accKey, account_code: acc.code, account_name: acc.name,
          sources: [...keys.entries()].map(([k, n]) => `${k.slice(2)}${n && k.startsWith('C:') ? ` (${n})` : ''}`),
          reason: [...keys.keys()].some((k) => mapFor.get(`${role}|${k}`) === accKey) ? 'Mapped together' : 'Same account matched more than once',
        });
      }
    }
    // One code with different names in the same file.
    const namesByCode = new Map();
    for (const r of items) {
      if (!r.code) continue;
      const nc = normCode(r.code);
      if (!namesByCode.has(nc)) namesByCode.set(nc, new Set());
      if (r.name) namesByCode.get(nc).add(r.name.trim());
    }
    for (const [nc, names] of namesByCode) {
      const distinct = new Set([...names].map(nameKey));
      if (distinct.size > 1) duplicates.push({ file: ROLE_WORDS[role], account_key: `C:${nc}`, account_code: nc, account_name: [...names][0], sources: [...names], reason: 'One code with different names' });
    }
    if (role !== 'ledger') {
      // One name under different codes in the same file.
      const codesByName = new Map();
      for (const r of items) {
        if (!r.code || !r.name) continue;
        const n = nameKey(r.name);
        if (!codesByName.has(n)) codesByName.set(n, new Set());
        codesByName.get(n).add(normCode(r.code));
      }
      for (const [, codes] of codesByName) {
        if (codes.size > 1) {
          const sample = items.find((r) => r.code && codes.has(normCode(r.code)));
          duplicates.push({ file: ROLE_WORDS[role], account_key: null, account_code: [...codes].join(', '), account_name: sample?.name ?? '', sources: [...codes], reason: 'One name under different codes' });
        }
      }
    }
  };

  // Closing TB first: its codes and names are the reference the other files are matched to.
  place('closing', closing);
  if (opening) place('opening', opening);
  place('ledger', ledger);

  // File-level checks.
  const tbTotals = (file) => {
    let dr = 0n; let cr = 0n;
    for (const r of file.rows) { if (r.balance > 0n) dr += r.balance; else cr -= r.balance; }
    return { debit: dr, credit: cr };
  };
  const fileChecks = [];
  for (const [role, file] of [['opening', opening], ['closing', closing]]) {
    if (!file) continue;
    const t = tbTotals(file);
    fileChecks.push({ file: ROLE_WORDS[role], check: 'Total debit = total credit', debit: formatMoney(t.debit), credit: formatMoney(t.credit), ok: t.debit === t.credit });
    if (t.debit !== t.credit) {
      inconsistencies.push({ type: 'TB_NOT_BALANCED', file: ROLE_WORDS[role], line: null, account_code: '', account_name: '', detail: `debit balances ${formatMoney(t.debit)} vs credit balances ${formatMoney(t.credit)} (difference ${formatMoney(t.debit - t.credit)})` });
    }
  }
  let ldr = 0n; let lcr = 0n;
  for (const l of ledger.lines) { ldr += l.debit; lcr += l.credit; }
  fileChecks.push({ file: 'Ledger', check: 'Total debit = total credit', debit: formatMoney(ldr), credit: formatMoney(lcr), ok: ldr === lcr });
  if (ldr !== lcr) inconsistencies.push({ type: 'LEDGER_NOT_BALANCED', file: 'Ledger', line: null, account_code: '', account_name: '', detail: `total debit ${formatMoney(ldr)} vs total credit ${formatMoney(lcr)} (difference ${formatMoney(ldr - lcr)})` });
  // Voucher-level balance, when the ledger names its vouchers.
  const vouchers = new Map();
  for (const l of ledger.lines) {
    if (!l.voucher) continue;
    const v = vouchers.get(l.voucher) ?? { dr: 0n, cr: 0n, line: l.line };
    v.dr += l.debit; v.cr += l.credit;
    vouchers.set(l.voucher, v);
  }
  let unbalancedVouchers = 0;
  for (const [id, v] of vouchers) {
    if (v.dr === v.cr) continue;
    unbalancedVouchers += 1;
    if (unbalancedVouchers <= 500) {
      inconsistencies.push({ type: 'VOUCHER_NOT_BALANCED', file: 'Ledger', line: v.line, account_code: '', account_name: `Voucher ${id}`, detail: `debit ${formatMoney(v.dr)} vs credit ${formatMoney(v.cr)} (difference ${formatMoney(v.dr - v.cr)})` });
    }
  }
  if (vouchers.size) fileChecks.push({ file: 'Ledger', check: 'Every voucher balances', debit: `${vouchers.size} vouchers`, credit: `${unbalancedVouchers} not balanced`, ok: unbalancedVouchers === 0 });

  // Account rows.
  const rows = [];
  for (const acc of accounts.values()) {
    const net = acc.debit - acc.credit;
    const calc = acc.opening + net;
    const diff = calc - acc.closing;
    const absDiff = diff < 0n ? -diff : diff;
    const presentIn = ROLES.filter((r) => acc.in[r]);
    const nameSets = Object.values(acc.names).map((s) => new Set([...s].map(nameKey)));
    const allNames = new Set(nameSets.flatMap((s) => [...s]));
    const flags = [];
    if (opening && !acc.in.opening) flags.push('MISSING_OPENING');
    if (!acc.in.closing) flags.push('MISSING_CLOSING');
    if (!acc.in.ledger) flags.push('NOT_IN_LEDGER');
    if (presentIn.length === 1 && !Object.keys(acc.mapped).length) flags.push('UNMAPPED');
    if (allNames.size > 1) flags.push('NAME_DIFFERS');
    if (acc.closingTbOpening !== null && opening && acc.in.opening && acc.closingTbOpening !== acc.opening) {
      flags.push('OPENING_MISMATCH');
      inconsistencies.push({
        type: 'OPENING_MISMATCH', file: 'Closing TB', line: null, account_code: acc.code, account_name: acc.name,
        detail: `opening in the Closing TB is ${formatMoney(acc.closingTbOpening)} but the Opening TB balance is ${formatMoney(acc.opening)} (difference ${formatMoney(acc.closingTbOpening - acc.opening)}); usually the year-end close of income and expense accounts`,
      });
    }
    if (acc.closingTbMovement !== null && acc.closingTbMovement !== net) {
      flags.push('MOVEMENT_MISMATCH');
    }
    rows.push({
      key: acc.key, code: acc.code, name: acc.name,
      names: Object.fromEntries(Object.entries(acc.names).map(([r, s]) => [r, [...s]])),
      in_opening: acc.in.opening, in_closing: acc.in.closing, in_ledger: acc.in.ledger,
      opening: formatMoney(acc.opening), debit: formatMoney(acc.debit), credit: formatMoney(acc.credit), net: formatMoney(net),
      calculated_closing: formatMoney(calc), closing_tb: formatMoney(acc.closing), difference: formatMoney(diff),
      closing_tb_movement: acc.closingTbMovement === null ? null : formatMoney(acc.closingTbMovement),
      line_count: acc.lines, party_lines: acc.partyLines ?? 0,
      movement_expected: !acc.in.ledger && acc.opening !== acc.closing,
      status: absDiff <= tol ? 'RECONCILED' : 'DIFFERENCE_FOUND',
      flags,
    });
  }
  rows.sort((a, b) => (a.status === b.status ? 0 : a.status === 'DIFFERENCE_FOUND' ? -1 : 1)
    || Math.abs(Number(b.difference)) - Math.abs(Number(a.difference))
    || (a.code || a.name).localeCompare(b.code || b.name));

  // Manual-mapping suggestions for accounts seen in one file only.
  const unmapped = rows.filter((r) => r.flags.includes('UNMAPPED'));
  for (const u of unmapped) {
    const role = ROLES.find((r) => u[`in_${r}`]);
    const pool = rows.filter((r) => r.key !== u.key && !r[`in_${role}`]);
    u.suggestions = pool
      .map((r) => ({ key: r.key, code: r.code, name: r.name, score: similarity(u.name, r.name) }))
      .filter((s) => s.score >= 0.4)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .map((s) => ({ ...s, score: Math.round(s.score * 100) / 100 }));
    u.source_role = role;
    u.source_key = [...accounts.get(u.key).keys[role]][0];
  }

  const sum = (k) => formatMoney(rows.reduce((a, r) => a + parseMoney(r[k]), 0n));
  const differences = rows.filter((r) => r.status === 'DIFFERENCE_FOUND');
  const totalAbsDiff = differences.reduce((a, r) => { const d = parseMoney(r.difference); return a + (d < 0n ? -d : d); }, 0n);
  const exceptions = {
    differences: differences.map((r) => r.key),
    missing_opening: opening ? rows.filter((r) => r.flags.includes('MISSING_OPENING')).map((r) => r.key) : [],
    missing_closing: rows.filter((r) => r.flags.includes('MISSING_CLOSING')).map((r) => r.key),
    not_in_ledger: rows.filter((r) => r.flags.includes('NOT_IN_LEDGER')).map((r) => r.key),
    unmapped: unmapped.map((r) => r.key),
    name_differs: rows.filter((r) => r.flags.includes('NAME_DIFFERS')).map((r) => r.key),
    duplicates,
    inconsistencies,
  };

  // Ledger lines per account, for the drill-down.
  const ledgerOwner = new Map();
  for (const acc of accounts.values()) for (const fk of acc.keys.ledger) ledgerOwner.set(fk, acc.key);
  const lines = {};
  for (const l of ledger.lines) {
    const owner = ledgerOwner.get(fileKey(ledger.hasCode, l.code, l.name));
    if (!owner) continue;
    const fk = fileKey(ledger.hasCode, l.code, l.name);
    (lines[owner] ??= []).push({ line: l.line, date: l.date, voucher: l.voucher, party: partyOf.get(fk) ?? '', debit: formatMoney(l.debit), credit: formatMoney(l.credit), narration: l.narration });
  }

  return {
    summary: {
      accounts: rows.length,
      reconciled: rows.length - differences.length,
      differences: differences.length,
      total_difference: formatMoney(totalAbsDiff),
      equation_holds: differences.length === 0,
      tolerance: formatMoney(tol),
      totals: {
        opening: sum('opening'), debit: sum('debit'), credit: sum('credit'), net: sum('net'),
        calculated_closing: sum('calculated_closing'), closing_tb: sum('closing_tb'), difference: sum('difference'),
      },
      counts: {
        missing_opening: exceptions.missing_opening.length, missing_closing: exceptions.missing_closing.length,
        not_in_ledger: exceptions.not_in_ledger.length, unmapped: exceptions.unmapped.length, name_differs: exceptions.name_differs.length,
        duplicates: duplicates.length, inconsistencies: inconsistencies.length, unbalanced_vouchers: unbalancedVouchers,
      },
      file_checks: fileChecks,
    },
    accounts: rows,
    exceptions,
    lines,
  };
}

/** Read the three files and reconcile them. files: { opening?, closing, ledger } each { name, bytes }. */
export function runValidation(files, { mappings = [], tolerance = '0.00', openingBasis = 'auto' } = {}) {
  if (!files.closing) throw new ValidationError('MISSING_FILE', 'The Closing TB file is required');
  if (!files.ledger) throw new ValidationError('MISSING_FILE', 'The Ledger file is required');
  if (!OPENING_BASIS.includes(openingBasis)) throw new ValidationError('BAD_REQUEST', `opening_basis must be one of ${OPENING_BASIS.join(', ')}`);
  const closing = readTrialBalanceFile(files.closing.bytes, { fileName: files.closing.name, role: 'closing' });
  let opening = null;
  // Without an Opening TB file, the Closing TB's own opening columns are the opening.
  if (openingBasis === 'auto' && !files.opening && closing.rows.some((r) => r.op !== null)) openingBasis = 'closing_tb_opening';
  if (openingBasis === 'closing_tb_opening') {
    // Opening balances from the Op. columns of the Closing TB (the period's own opening).
    if (closing.rows.every((r) => r.op === null)) throw new ValidationError('BASIS_UNAVAILABLE', `${closing.fileName}: the Closing TB has no opening (Op.) columns`);
    opening = { ...closing, role: 'opening', basis: 'closing_tb_opening_columns', rows: closing.rows.map((r) => ({ ...r, balance: r.op ?? 0n, op: null, tr: null, cl: null, flags: [] })) };
  } else if (files.opening) {
    opening = readTrialBalanceFile(files.opening.bytes, { fileName: files.opening.name, role: 'opening', openingBasis });
  }
  const ledger = readLedgerFile(files.ledger.bytes, { fileName: files.ledger.name });
  const result = reconcile({ opening, closing, ledger }, { mappings, tolerance });
  const describe = (f, extra) => (f ? { name: f.fileName, sha256: f.sha256, columns: f.columns, ...extra } : null);
  result.opening_basis = opening ? opening.basis : 'none';
  result.inputs = {
    opening: describe(opening, opening && { basis: opening.basis, rows: opening.rows.length }),
    closing: describe(closing, { basis: closing.basis, rows: closing.rows.length }),
    ledger: describe(ledger, { rows: ledger.lines.length }),
  };
  return result;
}

// ---------------------------------------------------------------- CSV report

export const REPORT_VIEWS = Object.freeze({
  all: 'All accounts',
  differences: 'Difference found',
  missing_opening: 'Missing from Opening TB',
  missing_closing: 'Missing from Closing TB',
  not_in_ledger: 'Not in the ledger',
  unmapped: 'Unmapped accounts',
  name_differs: 'Name differs between files',
  duplicates: 'Duplicate mappings',
  inconsistencies: 'Debit/credit and balance inconsistencies',
});

function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const STATUS_WORD = { RECONCILED: 'Reconciled', DIFFERENCE_FOUND: 'Difference Found' };

export function reportCsv(result, view = 'all') {
  const lines = [];
  if (view === 'duplicates') {
    lines.push(['File', 'Account code', 'Account name', 'Rows / names involved', 'Reason'].join(','));
    for (const d of result.exceptions.duplicates) lines.push([d.file, d.account_code, d.account_name, d.sources.join(' | '), d.reason].map(csvCell).join(','));
  } else if (view === 'inconsistencies') {
    lines.push(['Type', 'File', 'Row', 'Account code', 'Account name', 'Detail'].join(','));
    for (const d of result.exceptions.inconsistencies) lines.push([d.type, d.file, d.line ?? '', d.account_code, d.account_name, d.detail].map(csvCell).join(','));
  } else {
    const keys = view === 'all' ? null : new Set(result.exceptions[view] ?? []);
    lines.push(['Account Code', 'Account Name', 'Opening Balance', 'Total Debit', 'Total Credit', 'Net Transaction', 'Calculated Closing Balance', 'Closing TB Balance', 'Difference', 'Reconciliation Status', 'In Opening TB', 'In Closing TB', 'In Ledger', 'Notes'].join(','));
    for (const r of result.accounts) {
      if (keys && !keys.has(r.key)) continue;
      lines.push([
        r.code, r.name, r.opening, r.debit, r.credit, r.net, r.calculated_closing, r.closing_tb, r.difference, STATUS_WORD[r.status],
        r.in_opening ? 'Yes' : 'No', r.in_closing ? 'Yes' : 'No', r.in_ledger ? 'Yes' : 'No', r.flags.join(' '),
      ].map(csvCell).join(','));
    }
    if (view === 'all') {
      const t = result.summary.totals;
      lines.push(['TOTAL', '', t.opening, t.debit, t.credit, t.net, t.calculated_closing, t.closing_tb, t.difference, result.summary.equation_holds ? 'Reconciled' : 'Difference Found', '', '', '', ''].map(csvCell).join(','));
    }
  }
  return `﻿${lines.join('\r\n')}\r\n`;
}
