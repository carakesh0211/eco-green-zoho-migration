// Eco Green raw-extract normaliser (docs/ECOGREEN_SOURCE.md).
//
// Converts the per-branch folder the Eco Green team delivers (raw table dumps: jv_det.csv,
// supp_pay_det.csv, set_det.csv, payment.csv, ...) into ONE contract-v1 extraction run
// (DATA_CONTRACT.md: manifest.json + transactions.csv + trial_balance.csv) so the existing
// ingest pipeline consumes it unchanged. Pure: bytes in, bytes out, no I/O, no clock unless
// the profile omits extracted_at.
//
// Scope rules live in the profile, never in code: which document prefixes are in scope,
// which are inventory (already in Books via Smart Pharma), which are on hold, the date
// window, and which party-code patterns / TB groups roll up to an AP/AR control ledger.
// Every raw row is either emitted or counted under exactly one exclusion reason, so
// report.bridge always ties raw rows to output rows.
import { parseCsv, detectEncoding, decode } from '../../core/csv.js';
import { parseMoney, formatMoney } from '../../core/money.js';
import { sha256Bytes, sha256Text } from '../../core/hash.js';
import { isIsoDate } from '../../core/ids.js';
import { TRANSACTIONS_COLUMNS, TRIAL_BALANCE_COLUMNS } from '../../core/manifest.js';

export const EXCLUSION_REASONS = Object.freeze([
  'OTHER_BRANCH', 'CANCELLED', 'EXCLUDED_INVENTORY', 'ON_HOLD', 'UNKNOWN_PREFIX',
  'BAD_DATE', 'BEFORE_WINDOW', 'AFTER_WINDOW', 'ZERO_AMOUNT', 'UNSUPPORTED_GST_SPLIT',
]);

const VOUCHER_TYPES = new Set(['JOURNAL', 'PAYMENT', 'RECEIPT', 'CONTRA', 'EXPENSE']);
const SETTLEMENT = 'SETTLEMENT';

export const TB_INPUT_COLUMNS = ['code', 'name', 'top', 'group', 'opdr', 'opcr', 'trdr', 'trcr', 'cldr', 'clcr'];

// Tables with one row per document and an explicit debit and credit account.
// Direction is configurable per profile (profile.simple_tables) because it has only been
// confirmed against data for supplier payments; these are the defaults.
export const DEFAULT_SIMPLE_TABLES = Object.freeze([
  { file: 'payment.csv', debit_col: 'c_act_code', credit_col: 'c_credit_act_code', amount_col: 'n_total', gst_guard: true },
  { file: 'receipt.csv', debit_col: 'c_debit_act_code', credit_col: 'c_act_code', amount_col: 'n_total' },
  { file: 'cash_depo.csv', debit_col: 'c_act_code', credit_col: 'c_opp_act_code', amount_col: 'n_total' },
  { file: 'cash_with.csv', debit_col: 'c_act_code', credit_col: 'c_opp_act_code', amount_col: 'n_total' },
  { file: 'bank_to_bank.csv', debit_col: 'c_act_code', credit_col: 'c_opp_act_code', amount_col: 'n_total' },
  { file: 'b2b.csv', debit_col: 'c_act_code', credit_col: 'c_opp_act_code', amount_col: 'n_total' },
]);

const GST_AMOUNT_COLS = ['n_cgst_amt', 'n_sgst_amt', 'n_igst_amt', 'n_cess_amt'];

export class NormaliseError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/** dd/mm/yy (optionally followed by a time) -> YYYY-MM-DD, or null. */
export function parseSourceDate(value) {
  const m = /^(\d{2})\/(\d{2})\/(\d{2})(?:\D|$)/.exec(String(value ?? '').trim());
  if (!m) return null;
  const iso = `20${m[3]}-${m[2]}-${m[1]}`;
  return isIsoDate(iso) ? iso : null;
}

/** Account codes are exported with a leading apostrophe by some queries ('V05416). */
export function cleanCode(value) {
  return String(value ?? '').trim().replace(/^'/, '');
}

function validateProfile(profile) {
  const errors = [];
  const need = (k) => { if (!profile || profile[k] === undefined || profile[k] === null || profile[k] === '') errors.push(`${k} is required`); };
  ['branch_code', 'from_date', 'to_date', 'in_scope_prefixes'].forEach(need);
  if (profile?.from_date && !isIsoDate(profile.from_date)) errors.push('from_date must be YYYY-MM-DD');
  if (profile?.to_date && !isIsoDate(profile.to_date)) errors.push('to_date must be YYYY-MM-DD');
  if (profile?.from_date && profile?.to_date && profile.from_date > profile.to_date) errors.push('from_date is after to_date');
  for (const [prefix, type] of Object.entries(profile?.in_scope_prefixes ?? {})) {
    if (type !== SETTLEMENT && !VOUCHER_TYPES.has(type)) errors.push(`in_scope_prefixes.${prefix}: unknown voucher type ${type}`);
  }
  const seen = new Map();
  for (const [list, label] of [[Object.keys(profile?.in_scope_prefixes ?? {}), 'in_scope'], [profile?.excluded_prefixes ?? [], 'excluded'], [profile?.hold_prefixes ?? [], 'hold']]) {
    for (const p of list) {
      if (seen.has(p)) errors.push(`prefix ${p} is listed as both ${seen.get(p)} and ${label}`);
      seen.set(p, label);
    }
  }
  for (const c of profile?.party_controls ?? []) {
    if (!c.control || !c.party_type) errors.push('party_controls entries need control and party_type');
  }
  if (errors.length) throw new NormaliseError('INVALID_PROFILE', `invalid source profile: ${errors.join('; ')}`);
}

function readTable(files, name) {
  const raw = files[name];
  if (raw === undefined || raw === null) return null;
  const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), 'utf8');
  const encoding = detectEncoding(bytes);
  if (encoding === 'unknown') throw new NormaliseError('UNKNOWN_ENCODING', `${name}: unsupported encoding`);
  const { header, rows } = parseCsv(decode(bytes, encoding));
  const objects = rows
    .filter((cells) => cells.length > 1 || (cells[0] ?? '') !== '')
    .map((cells) => Object.fromEntries(header.map((col, i) => [col, cells[i] ?? ''])));
  return { name, header, rows: objects, sha256: sha256Bytes(bytes) };
}

function requireColumns(table, columns) {
  const missing = columns.filter((c) => !table.header.includes(c));
  if (missing.length) throw new NormaliseError('HEADER_MISMATCH', `${table.name}: missing column(s) ${missing.join(', ')}`);
}

function docKey(row) {
  return [row.c_br_code, row.c_year, row.c_prefix, row.n_srno].map((v) => String(v ?? '').trim()).join('/');
}

function invoiceRef(row) {
  const no = row.n_inv_no ?? row.c_inv_no ?? '';
  return [row.c_ref_br_code, row.c_inv_year, row.c_inv_prefix, no].map((v) => String(v ?? '').trim()).join('/');
}

/**
 * @param {object} args
 * @param {Record<string, Buffer|string>} args.files  raw extract files keyed by file name
 * @param {object} args.profile                        see config/source-profiles/ecogreen.example.json
 * @param {() => string} [args.now]                    ISO clock, used only when profile.extracted_at is absent
 */
export function normaliseEcoGreen({ files, profile, now }) {
  validateProfile(profile);
  const branch = String(profile.branch_code);
  const inScope = profile.in_scope_prefixes;
  const excluded = new Set(profile.excluded_prefixes ?? []);
  const hold = new Set(profile.hold_prefixes ?? []);
  const cashAccounts = new Set(profile.cash_accounts ?? []);
  const controls = (profile.party_controls ?? []).map((c) => ({
    ...c,
    patterns: (c.party_prefixes ?? []).map((p) => new RegExp(`^${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\d+$`)),
    groups: new Set(c.tb_groups ?? []),
  }));

  const stats = new Map(); // `${table}|${prefix}|${reason}` -> { rows, documents:Set, amountPaise }
  const bump = (table, prefix, reason, key, amountPaise = 0n) => {
    const k = `${table}|${prefix}|${reason}`;
    if (!stats.has(k)) stats.set(k, { table, prefix, reason, rows: 0, documents: new Set(), amountPaise: 0n });
    const s = stats.get(k);
    s.rows += 1; s.documents.add(key); s.amountPaise += amountPaise;
  };

  /** -> { type, date } when the row is in scope, otherwise records the exclusion and returns null. */
  const admit = (table, row, amountPaise) => {
    const prefix = String(row.c_prefix ?? '').trim();
    const key = docKey(row);
    const refBranch = String(row.c_ref_br_code || row.c_br_code || '').trim();
    let reason = null;
    let date = null;
    if (refBranch !== branch) reason = 'OTHER_BRANCH';
    else if (String(row.n_cancel_flag ?? '0').trim() === '1') reason = 'CANCELLED';
    else if (excluded.has(prefix)) reason = 'EXCLUDED_INVENTORY';
    else if (hold.has(prefix)) reason = 'ON_HOLD';
    else if (!Object.hasOwn(inScope, prefix)) reason = 'UNKNOWN_PREFIX';
    else {
      date = parseSourceDate(row.d_date);
      if (!date) reason = 'BAD_DATE';
      else if (date < profile.from_date) reason = 'BEFORE_WINDOW';
      else if (date > profile.to_date) reason = 'AFTER_WINDOW';
    }
    if (reason) { bump(table, prefix, reason, key, amountPaise); return null; }
    return { type: inScope[prefix], date, prefix, key };
  };

  const money = (table, row, col) => {
    try { return parseMoney(row[col]); } catch (e) {
      throw new NormaliseError('MONEY_PARSE', `${table} ${docKey(row)}: ${col}=${JSON.stringify(row[col])} is not a 2dp amount`);
    }
  };
  const absPaise = (p) => (p < 0n ? -p : p);

  // ---- names lookup (optional *_act.csv companions carry c_code/c_name) ----
  const names = new Map();
  for (const companion of ['jv_act.csv']) {
    const t = readTable(files, companion);
    if (!t || !t.header.includes('c_code') || !t.header.includes('c_name')) continue;
    for (const r of t.rows) {
      const code = cleanCode(r.c_code);
      if (code && r.c_name && !names.has(code)) names.set(code, String(r.c_name).trim());
    }
  }

  // ---- trial balance: read, roll party-control groups up ----
  const tbTable = readTable(files, profile.tb_file ?? 'tb.csv');
  if (!tbTable) throw new NormaliseError('MISSING_FILE', `${profile.tb_file ?? 'tb.csv'} (trial balance) is required`);
  requireColumns(tbTable, TB_INPUT_COLUMNS);
  const controlByTbCode = new Map();
  const tb = new Map(); // ledger_code -> { name, cols: bigint[6] }
  const TB_MONEY = ['opdr', 'opcr', 'trdr', 'trcr', 'cldr', 'clcr'];
  for (const r of tbTable.rows) {
    const code = cleanCode(r.code);
    if (!code) continue;
    const control = controls.find((c) => c.groups.has(String(r.group).trim()));
    const ledger = control ? control.control : code;
    if (control) controlByTbCode.set(code, control);
    const entry = tb.get(ledger) ?? { name: control ? (control.name ?? control.control) : String(r.name).trim(), cols: TB_MONEY.map(() => 0n) };
    TB_MONEY.forEach((col, i) => {
      try { entry.cols[i] += parseMoney(r[col]); } catch {
        throw new NormaliseError('MONEY_PARSE', `${tbTable.name} ${code}: ${col}=${JSON.stringify(r[col])} is not a 2dp amount`);
      }
    });
    tb.set(ledger, entry);
    if (!names.has(code)) names.set(code, String(r.name).trim());
  }
  for (const c of controls) names.set(c.control, c.name ?? c.control);

  /** raw account code -> { ledger, party, partyType } */
  const resolve = (rawCode) => {
    const code = cleanCode(rawCode);
    const byGroup = controlByTbCode.get(code);
    if (byGroup) {
      // a per-party TB row inside a control group keeps its party on the line
      const isParty = byGroup.patterns.some((re) => re.test(code));
      return { ledger: byGroup.control, party: isParty ? code : null, partyType: isParty ? byGroup.party_type : null };
    }
    const byPattern = controls.find((c) => c.patterns.some((re) => re.test(code)));
    if (byPattern && !tb.has(code)) return { ledger: byPattern.control, party: code, partyType: byPattern.party_type };
    return { ledger: code, party: null, partyType: null };
  };

  const vouchers = new Map(); // voucher_id -> { type, date, lines: [] }
  const allocations = [];
  const sourceRows = {}; // table -> raw row count
  const emittedRows = {}; // table -> raw rows that produced output
  const addLine = (meta, { rawCode, debitPaise, creditPaise, narration, reference, method }) => {
    if (!vouchers.has(meta.key)) vouchers.set(meta.key, { type: meta.type, date: meta.date, lines: [] });
    const { ledger, party } = resolve(rawCode);
    vouchers.get(meta.key).lines.push({
      ledger, party, debitPaise, creditPaise,
      narration: narration ?? '', reference: reference ?? '', method: method ?? '',
    });
  };
  const methodFor = (rawCode) => (cashAccounts.has(cleanCode(rawCode)) ? 'CASH' : 'BANK');

  // ---- journals (jv_det.csv): already double-entry, one row per line ----
  const jv = readTable(files, 'jv_det.csv');
  if (jv) {
    requireColumns(jv, ['c_br_code', 'c_year', 'c_prefix', 'n_srno', 'c_act_code', 'n_credit', 'n_debit', 'd_date', 'c_ref_br_code', 'n_cancel_flag']);
    sourceRows[jv.name] = jv.rows.length; emittedRows[jv.name] = 0;
    const ordered = jv.rows.map((r, i) => ({ r, i })).sort((a, b) =>
      (Number(a.r.n_seq) || 0) - (Number(b.r.n_seq) || 0) || a.i - b.i);
    for (const { r } of ordered) {
      const debit = money(jv.name, r, 'n_debit');
      const credit = money(jv.name, r, 'n_credit');
      const meta = admit(jv.name, r, absPaise(debit) + absPaise(credit));
      if (!meta) continue;
      if (meta.type === SETTLEMENT) { bump(jv.name, meta.prefix, 'UNKNOWN_PREFIX', meta.key, absPaise(debit)); continue; }
      // net to one side; a negative amount flips sides (contract: exactly one side non-zero)
      const net = debit - credit;
      if (net === 0n) { bump(jv.name, meta.prefix, 'ZERO_AMOUNT', meta.key); continue; }
      emittedRows[jv.name] += 1;
      addLine(meta, { rawCode: r.c_act_code, debitPaise: net > 0n ? net : 0n, creditPaise: net < 0n ? -net : 0n, narration: r.c_remark });
    }
  }

  // ---- supplier payments (supp_pay_det.csv): one row per invoice paid ----
  const sp = readTable(files, 'supp_pay_det.csv');
  if (sp) {
    requireColumns(sp, ['c_br_code', 'c_year', 'c_prefix', 'n_srno', 'c_ref_br_code', 'c_inv_year', 'c_inv_prefix', 'n_inv_no', 'n_amount', 'd_date', 'c_supp_code', 'n_cancel_flag', 'c_opp_act_code']);
    sourceRows[sp.name] = sp.rows.length; emittedRows[sp.name] = 0;
    const creditSide = new Map(); // `${voucher}|${opp}` -> { meta, rawCode, paise, chq }
    for (const r of sp.rows) {
      const amount = money(sp.name, r, 'n_amount');
      const meta = admit(sp.name, r, absPaise(amount));
      if (!meta) continue;
      if (amount === 0n) { bump(sp.name, meta.prefix, 'ZERO_AMOUNT', meta.key); continue; }
      emittedRows[sp.name] += 1;
      const ref = invoiceRef(r);
      const method = methodFor(r.c_opp_act_code);
      addLine(meta, { rawCode: r.c_supp_code, debitPaise: amount > 0n ? amount : 0n, creditPaise: amount < 0n ? -amount : 0n, narration: `Supplier payment against ${ref}`, reference: ref, method });
      const k = `${meta.key}|${cleanCode(r.c_opp_act_code)}`;
      const agg = creditSide.get(k) ?? { meta, rawCode: r.c_opp_act_code, paise: 0n, chq: String(r.c_chq_no ?? '').trim(), method };
      agg.paise += amount;
      creditSide.set(k, agg);
      allocations.push({ voucher_id: meta.key, voucher_date: meta.date, source_table: 'supp_pay_det', party_code: cleanCode(r.c_supp_code), party_type: 'VENDOR', invoice_ref: ref, amount: formatMoney(amount) });
    }
    for (const agg of creditSide.values()) {
      if (agg.paise === 0n) continue;
      addLine(agg.meta, { rawCode: agg.rawCode, debitPaise: agg.paise < 0n ? -agg.paise : 0n, creditPaise: agg.paise > 0n ? agg.paise : 0n, narration: 'Supplier payment', reference: agg.chq, method: agg.method });
    }
  }

  // ---- single-row documents with explicit debit and credit accounts ----
  for (const spec of profile.simple_tables ?? DEFAULT_SIMPLE_TABLES) {
    const t = readTable(files, spec.file);
    if (!t) continue;
    sourceRows[t.name] = t.rows.length; emittedRows[t.name] = 0;
    if (t.rows.length === 0) continue; // header-only extract == the branch had no such documents
    requireColumns(t, ['c_br_code', 'c_year', 'c_prefix', 'n_srno', 'd_date', spec.debit_col, spec.credit_col, spec.amount_col]);
    for (const r of t.rows) {
      const amount = money(t.name, r, spec.amount_col);
      const meta = admit(t.name, r, absPaise(amount));
      if (!meta) continue;
      if (amount === 0n) { bump(t.name, meta.prefix, 'ZERO_AMOUNT', meta.key); continue; }
      if (spec.gst_guard && GST_AMOUNT_COLS.some((c) => t.header.includes(c) && money(t.name, r, c) !== 0n)) {
        bump(t.name, meta.prefix, 'UNSUPPORTED_GST_SPLIT', meta.key, absPaise(amount));
        continue;
      }
      emittedRows[t.name] += 1;
      const reference = String(r.c_chq_no ?? '').trim();
      const method = meta.type === 'CONTRA' ? '' : methodFor(meta.type === 'RECEIPT' ? r[spec.debit_col] : r[spec.credit_col]);
      const pos = amount > 0n ? amount : -amount;
      const [drCol, crCol] = amount > 0n ? [spec.debit_col, spec.credit_col] : [spec.credit_col, spec.debit_col];
      addLine(meta, { rawCode: r[drCol], debitPaise: pos, creditPaise: 0n, narration: r.c_remark, reference, method });
      addLine(meta, { rawCode: r[crCol], debitPaise: 0n, creditPaise: pos, narration: r.c_remark, reference, method });
    }
  }

  // ---- settlements (set_det.csv): allocation evidence only, no ledger lines ----
  const st = readTable(files, 'set_det.csv');
  if (st) {
    requireColumns(st, ['c_br_code', 'c_year', 'c_prefix', 'n_srno', 'c_ref_br_code', 'c_inv_year', 'c_inv_prefix', 'n_inv_no', 'n_amount', 'd_date', 'c_cust_code', 'n_cancel_flag']);
    sourceRows[st.name] = st.rows.length; emittedRows[st.name] = 0;
    for (const r of st.rows) {
      const amount = money(st.name, r, 'n_amount');
      const meta = admit(st.name, r, absPaise(amount));
      if (!meta) continue;
      emittedRows[st.name] += 1;
      const party = cleanCode(r.c_cust_code);
      allocations.push({ voucher_id: meta.key, voucher_date: meta.date, source_table: 'set_det', party_code: party, party_type: resolve(party).partyType ?? '', invoice_ref: invoiceRef(r), amount: formatMoney(amount) });
    }
  }

  // ---- render transactions.csv ----
  const txnRows = [];
  const ledgerVouchers = new Map(); // ledger -> Set(voucher)
  const unknownLedgers = new Map(); // ledger -> line count
  const unbalanced = [];
  const byType = {};
  let debitTotal = 0n; let creditTotal = 0n;
  const voucherIds = [...vouchers.keys()].sort((a, b) => {
    const va = vouchers.get(a); const vb = vouchers.get(b);
    return va.date < vb.date ? -1 : va.date > vb.date ? 1 : a < b ? -1 : a > b ? 1 : 0;
  });
  for (const id of voucherIds) {
    const v = vouchers.get(id);
    let dr = 0n; let cr = 0n;
    v.lines.forEach((l, i) => {
      dr += l.debitPaise; cr += l.creditPaise;
      if (!tb.has(l.ledger)) unknownLedgers.set(l.ledger, (unknownLedgers.get(l.ledger) ?? 0) + 1);
      if (!ledgerVouchers.has(l.ledger)) ledgerVouchers.set(l.ledger, new Set());
      ledgerVouchers.get(l.ledger).add(id);
      const row = {
        branch_code: branch, voucher_id: id, voucher_no: id, voucher_type: v.type, voucher_date: v.date,
        line_no: i + 1, ledger_code: l.ledger, ledger_name: names.get(l.ledger) ?? '',
        debit: formatMoney(l.debitPaise), credit: formatMoney(l.creditPaise),
        party_code: l.party ?? '', party_name: l.party ? (names.get(l.party) ?? '') : '',
        payment_method: l.method, tax_bucket: '', narration: String(l.narration).trim(), reference_no: l.reference,
        created_at: '', modified_at: '',
      };
      txnRows.push(TRANSACTIONS_COLUMNS.map((c) => row[c]));
    });
    debitTotal += dr; creditTotal += cr;
    byType[v.type] ??= { vouchers: 0, lines: 0, debitPaise: 0n };
    byType[v.type].vouchers += 1; byType[v.type].lines += v.lines.length; byType[v.type].debitPaise += dr;
    if (dr !== cr) unbalanced.push({ voucher_id: id, debit: formatMoney(dr), credit: formatMoney(cr) });
  }

  // ---- render trial_balance.csv ----
  const tbRows = [];
  let tbClosingDr = 0n; let tbClosingCr = 0n;
  for (const [ledger, entry] of tb) {
    tbClosingDr += entry.cols[4]; tbClosingCr += entry.cols[5];
    const row = {
      branch_code: branch, ledger_code: ledger, ledger_name: entry.name,
      opening_debit: formatMoney(entry.cols[0]), opening_credit: formatMoney(entry.cols[1]),
      period_debit: formatMoney(entry.cols[2]), period_credit: formatMoney(entry.cols[3]),
      closing_debit: formatMoney(entry.cols[4]), closing_credit: formatMoney(entry.cols[5]),
      txn_count: ledgerVouchers.get(ledger)?.size ?? 0,
    };
    tbRows.push(TRIAL_BALANCE_COLUMNS.map((c) => row[c]));
  }

  const transactionsCsv = toCsv(TRANSACTIONS_COLUMNS, txnRows);
  const trialBalanceCsv = toCsv(TRIAL_BALANCE_COLUMNS, tbRows);
  // Each allocation row says "document voucher_id set amount against invoice_ref". For the
  // later apply-credit step the row also carries which side it is (a negative amount is the
  // credit being consumed, a positive one the outstanding being cleared), the referenced
  // document's prefix, and whether that document is one of the vouchers in this run.
  const emittedByRef = new Map(); // year/prefix/srno -> [voucher_id]
  for (const id of voucherIds) {
    const k = id.split('/').slice(1).join('/');
    emittedByRef.set(k, [...(emittedByRef.get(k) ?? []), id]);
  }
  for (const a of allocations) {
    const parts = a.invoice_ref.split('/');
    const hits = emittedByRef.get(parts.slice(1).join('/')) ?? [];
    a.ref_prefix = parts[2] ?? '';
    a.side = a.amount.startsWith('-') ? 'CREDIT' : 'OUTSTANDING';
    a.ref_in_run = hits.length === 1 ? 'YES' : hits.length > 1 ? 'AMBIGUOUS' : 'NO';
    a.ref_voucher_id = hits.length === 1 ? hits[0] : '';
  }
  const ALLOC_COLUMNS = ['voucher_id', 'voucher_date', 'source_table', 'party_code', 'party_type', 'invoice_ref', 'ref_prefix', 'side', 'amount', 'ref_in_run', 'ref_voucher_id'];
  const allocationsCsv = toCsv(ALLOC_COLUMNS, allocations.map((a) => ALLOC_COLUMNS.map((c) => a[c])));

  const inputHashes = Object.keys(files).sort().map((n) => `${n}:${sha256Bytes(Buffer.isBuffer(files[n]) ? files[n] : Buffer.from(String(files[n]), 'utf8'))}`);
  const inputDigest = sha256Text(inputHashes.join('\n') + '\n' + JSON.stringify(profile));
  const runId = profile.extraction_run_id ?? `${branch}-${profile.from_date}-${profile.to_date}-raw-${inputDigest.slice(0, 8)}`;

  const manifest = {
    contract_version: '1.0',
    extraction_run_id: runId,
    source_system: 'ECO_GREEN',
    query_id: 'EG_RAW_NON_INVENTORY',
    query_name: 'Eco Green raw table extract, non-inventory documents (normalised)',
    query_version: profile.profile_version ?? 'v1',
    sql_hash: `sha256:${inputDigest}`,
    branch_code: branch,
    from_date: profile.from_date,
    to_date: profile.to_date,
    currency: 'INR',
    extracted_at: profile.extracted_at ?? (now ? now() : new Date().toISOString()),
    source_operator_or_job: 'ecogreen-normaliser',
    files: [
      { file_name: 'transactions.csv', file_role: 'TRANSACTIONS', sha256: sha256Text(transactionsCsv), row_count: txnRows.length, debit_total: formatMoney(debitTotal), credit_total: formatMoney(creditTotal), encoding: 'utf-8', delimiter: ',' },
      { file_name: 'trial_balance.csv', file_role: 'TRIAL_BALANCE', sha256: sha256Text(trialBalanceCsv), row_count: tbRows.length, debit_total: formatMoney(tbClosingDr), credit_total: formatMoney(tbClosingCr), encoding: 'utf-8', delimiter: ',' },
    ],
  };

  const exclusions = [...stats.values()]
    .map((s) => ({ table: s.table, prefix: s.prefix, reason: s.reason, rows: s.rows, documents: s.documents.size, amount: formatMoney(s.amountPaise) }))
    .sort((a, b) => (a.table + a.prefix + a.reason < b.table + b.prefix + b.reason ? -1 : 1));
  const bridge = Object.keys(sourceRows).sort().map((table) => {
    const excludedRows = exclusions.filter((e) => e.table === table).reduce((n, e) => n + e.rows, 0);
    return { table, source_rows: sourceRows[table], emitted_rows: emittedRows[table], excluded_rows: excludedRows, ties: sourceRows[table] === emittedRows[table] + excludedRows };
  });

  const report = {
    branch_code: branch, extraction_run_id: runId, from_date: profile.from_date, to_date: profile.to_date,
    inputs: inputHashes,
    output: {
      vouchers: voucherIds.length, lines: txnRows.length,
      debit_total: formatMoney(debitTotal), credit_total: formatMoney(creditTotal),
      by_type: Object.fromEntries(Object.entries(byType).map(([k, v]) => [k, { vouchers: v.vouchers, lines: v.lines, debit_total: formatMoney(v.debitPaise) }])),
      allocations: allocations.length, trial_balance_ledgers: tbRows.length,
      allocations_by_ref: summariseAllocations(allocations),
    },
    bridge,
    exclusions,
    unbalanced_vouchers: unbalanced,
    unknown_ledgers: [...unknownLedgers.entries()].map(([ledger_code, lines]) => ({ ledger_code, lines })).sort((a, b) => (a.ledger_code < b.ledger_code ? -1 : 1)),
  };

  return { manifest, transactionsCsv, trialBalanceCsv, allocationsCsv, report };
}

function summariseAllocations(allocations) {
  const out = {};
  for (const a of allocations) {
    const k = `${a.source_table}|${a.ref_prefix}|${a.side}|${a.ref_in_run}`;
    out[k] ??= { source_table: a.source_table, ref_prefix: a.ref_prefix, side: a.side, ref_in_run: a.ref_in_run, rows: 0, paise: 0n };
    out[k].rows += 1; out[k].paise += parseMoney(a.amount);
  }
  return Object.keys(out).sort().map((k) => { const { paise, ...rest } = out[k]; return { ...rest, amount: formatMoney(paise) }; });
}

function csvField(value) {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\n\r]/.test(s) || s !== s.trim() ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(header, rows) {
  return [header, ...rows].map((r) => r.map(csvField).join(',')).join('\n') + '\n';
}
