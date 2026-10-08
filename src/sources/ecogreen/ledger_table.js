// Eco Green "ledger table" source (docs/ECOGREEN_SOURCE.md §Ledger-table format).
//
// Second delivery format (from 2026-10-07): per branch, ONE ledger table holding every
// transaction of the period (one row per account line, with the opposite account, who
// pushes the document - Smartpharma or ZOHO - and, for party lines, the control ledger
// the party belongs to), plus the opening and closing trial-balance reports.
//
// normaliseLedgerTable({ files, profile, now }) -> contract-v1 run (manifest +
// transactions.csv + trial_balance.csv) for the rows "to be pushed by" us, plus:
//   - trial_balance_components.csv: per ledger, Eco Green opening, Smartpharma movement,
//     our movement, closing - the three-way proof that the whole population ties;
//   - report: bridge (every row emitted or excluded under one reason), split by pusher,
//     the date-cell repair applied, and the 31 March vs 1 April opening differences.
//
// Trial balance emitted to the contract: opening = Eco Green 1 April opening PLUS the
// Smartpharma-pushed movement (what Books holds once Smartpharma's documents are in),
// period = our movement, closing = Eco Green closing. It is internally consistent, so
// Layer A can tie; the raw components are in trial_balance_components.csv.
import { readXlsx, sheetToObjects } from './xlsx.js';
import { parseCsv, detectEncoding, decode } from '../../core/csv.js';
import { parseMoney, formatMoney } from '../../core/money.js';
import { sha256Bytes, sha256Text } from '../../core/hash.js';
import { isIsoDate } from '../../core/ids.js';
import { TRANSACTIONS_COLUMNS, TRIAL_BALANCE_COLUMNS } from '../../core/manifest.js';
import { NormaliseError, parseSourceDate, cleanCode } from './normalise.js';

export const LEDGER_COLUMNS = ['c_br_code', 'c_year', 'c_prefix', 'd_date', 'n_tran_no', 'c_act_code', 'act_name', 'Debit', 'Credit', 'Status', 'To be pushed by'];
export const TB_COLUMNS = ['Act Code', 'Description', 'Op.Debit', 'Op.Credit', 'Tran. Debit', 'Tran. Credit', 'Cl.Debit', 'Cl.Credit'];
export const EXCLUSION_REASONS = Object.freeze(['PUSHED_BY_OTHER', 'PUSHED_BY_UNKNOWN', 'UNKNOWN_PREFIX', 'BAD_DATE', 'OUT_OF_WINDOW', 'ZERO_AMOUNT', 'FOOTER']);
export const CREDIT_SIGN_VALUES = Object.freeze(['auto', 'negative', 'positive']);

const VOUCHER_TYPES = new Set(['JOURNAL', 'PAYMENT', 'RECEIPT', 'CONTRA', 'EXPENSE']);

function validateProfile(profile) {
  const errors = [];
  for (const k of ['branch_code', 'from_date', 'to_date', 'prefix_types']) {
    if (!profile || profile[k] === undefined || profile[k] === null || profile[k] === '') errors.push(`${k} is required`);
  }
  if (profile?.from_date && !isIsoDate(profile.from_date)) errors.push('from_date must be YYYY-MM-DD');
  if (profile?.to_date && !isIsoDate(profile.to_date)) errors.push('to_date must be YYYY-MM-DD');
  if (profile?.from_date && profile?.to_date && profile.from_date > profile.to_date) errors.push('from_date is after to_date');
  for (const [p, t] of Object.entries(profile?.prefix_types ?? {})) if (!VOUCHER_TYPES.has(t)) errors.push(`prefix_types.${p}: unknown voucher type ${t}`);
  if (profile?.credit_sign !== undefined && !CREDIT_SIGNS.has(profile.credit_sign)) errors.push(`credit_sign must be one of ${[...CREDIT_SIGNS].join(', ')}`);
  if (errors.length) throw new NormaliseError('INVALID_PROFILE', `invalid ledger-table profile: ${errors.join('; ')}`);
}

const CREDIT_SIGNS = new Set(CREDIT_SIGN_VALUES);

/**
 * Sign convention of the Credit column. The first deliveries wrote credits as negatives
 * (net = Debit + Credit); the branch 460 delivery of 2026-10-08 writes both columns as
 * positive magnitudes (net = Debit - Credit). Unless the profile fixes it with
 * `credit_sign: 'negative' | 'positive'`, the convention is read from the non-footer rows:
 * only negatives (or no credits at all) means negative, only positives means positive, and
 * a column mixing both is refused (CREDIT_SIGN_AMBIGUOUS) rather than guessed per row.
 */
function resolveCreditSign(rows, fileName, profile) {
  let positive = 0; let negative = 0;
  for (const r of rows) {
    const prefix = cell(r.c_prefix); const tranNo = cell(r.n_tran_no);
    if (!prefix || !tranNo) continue; // footer / total rows do not vote
    const v = cellMoney(fileName, r, 'Credit', `${cell(r.c_year)}/${prefix}/${tranNo}`);
    if (v > 0n) positive += 1; else if (v < 0n) negative += 1;
  }
  const configured = profile.credit_sign ?? 'auto';
  let sign = configured;
  if (configured === 'auto') {
    if (positive > 0 && negative > 0) {
      throw new NormaliseError('CREDIT_SIGN_AMBIGUOUS', `${fileName}: the Credit column mixes ${positive} positive and ${negative} negative values; set credit_sign in the profile`);
    }
    sign = positive > 0 ? 'positive' : 'negative';
  }
  return { sign, source: configured === 'auto' ? 'detected' : 'profile', positive_cells: positive, negative_cells: negative };
}

/** A file may arrive as .xlsx (Buffer) or as .csv; both become rows of objects. */
function readTable(files, name, { headerMatch }) {
  const raw = files[name];
  if (raw === undefined || raw === null) return null;
  const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), 'utf8');
  let rows;
  if (bytes.length > 4 && bytes.readUInt32LE(0) === 0x04034b50) {
    let wb;
    try { wb = readXlsx(bytes); } catch (e) { throw new NormaliseError('XLSX_PARSE', `${name}: ${e.message}`); }
    rows = wb.sheets[0]?.rows ?? [];
  } else {
    const enc = detectEncoding(bytes);
    if (enc === 'unknown') throw new NormaliseError('UNKNOWN_ENCODING', `${name}: unsupported encoding`);
    const parsed = parseCsv(decode(bytes, enc));
    rows = parsed.header.length ? [parsed.header, ...parsed.rows] : [];
  }
  const headerRow = rows.findIndex((r) => headerMatch(r.map((c) => String(c ?? '').trim())));
  if (headerRow < 0) throw new NormaliseError('HEADER_MISMATCH', `${name}: header row not found`);
  const header = rows[headerRow].map((c) => String(c ?? '').trim());
  const objects = rows.slice(headerRow + 1)
    .filter((r) => r.some((c) => c !== null && c !== ''))
    .map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? null]).filter(([h]) => h !== '')));
  return { name, header, rows: objects, sha256: sha256Bytes(bytes) };
}

const cell = (v) => (v === null || v === undefined ? '' : typeof v === 'object' && v.date ? v.date : String(v)).trim();
function cellMoney(name, row, col, key) {
  const v = row[col];
  const s = typeof v === 'number' ? v.toFixed(2) : cell(v);
  try { return parseMoney(s === '' ? '0' : s); } catch {
    throw new NormaliseError('MONEY_PARSE', `${name} ${key}: ${col}=${JSON.stringify(s)} is not an amount`);
  }
}

/**
 * Date cells: the extractor writes dd/mm/yy text, but Excel re-reads some of them as
 * dates with day and month swapped (9 April stored as 4 September). Strings are parsed as
 * dd/mm/yy; date-typed cells are tried as-is first, and if that leaves any date-typed
 * cell outside the window while the swapped reading puts every one inside, the swapped
 * reading is used for ALL date-typed cells and the repair is reported.
 */
function resolveDates(rows, profile) {
  const parsed = rows.map((r) => {
    const v = r.d_date;
    if (v && typeof v === 'object' && v.date) return { kind: 'date', asIs: v.date, swapped: `${v.date.slice(0, 4)}-${v.date.slice(8, 10)}-${v.date.slice(5, 7)}` };
    const iso = parseSourceDate(cell(v));
    return { kind: 'text', asIs: iso, swapped: iso };
  });
  const inWindow = (d) => d && d >= profile.from_date && d <= profile.to_date;
  const dateCells = parsed.filter((p) => p.kind === 'date');
  const asIsBad = dateCells.filter((p) => !inWindow(p.asIs)).length;
  const swappedBad = dateCells.filter((p) => !inWindow(p.swapped) || !isIsoDate(p.swapped)).length;
  const useSwapped = dateCells.length > 0 && asIsBad > 0 && swappedBad === 0;
  return {
    dates: parsed.map((p) => (useSwapped && p.kind === 'date' ? p.swapped : p.asIs)),
    repair: { date_typed_cells: dateCells.length, text_cells: parsed.length - dateCells.length, swapped_day_month: useSwapped, out_of_window_as_is: asIsBad, out_of_window_swapped: swappedBad },
  };
}

function readTrialBalance(files, name, required) {
  const t = readTable(files, name, { headerMatch: (r) => r[0] === 'Act Code' && r.includes('Cl.Debit') });
  if (!t) { if (required) throw new NormaliseError('MISSING_FILE', `${name} (trial balance) is required`); return null; }
  const missing = TB_COLUMNS.filter((c) => !t.header.includes(c));
  if (missing.length) throw new NormaliseError('HEADER_MISMATCH', `${name}: missing column(s) ${missing.join(', ')}`);
  const ledgers = new Map();
  for (const r of t.rows) {
    const code = cleanCode(cell(r['Act Code']));
    const desc = cell(r.Description);
    if (!code || !desc) continue; // group headings and totals carry no account code
    const entry = ledgers.get(code) ?? { code, name: desc, op: 0n, tr: 0n, cl: 0n };
    entry.op += cellMoney(name, r, 'Op.Debit', code) - cellMoney(name, r, 'Op.Credit', code);
    entry.tr += cellMoney(name, r, 'Tran. Debit', code) - cellMoney(name, r, 'Tran. Credit', code);
    entry.cl += cellMoney(name, r, 'Cl.Debit', code) - cellMoney(name, r, 'Cl.Credit', code);
    ledgers.set(code, entry);
  }
  return { ...t, ledgers };
}

const nameKey = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const drcr = (net) => [net > 0n ? formatMoney(net) : '0.00', net < 0n ? formatMoney(-net) : '0.00'];

export function normaliseLedgerTable({ files, profile, now }) {
  validateProfile(profile);
  const branch = String(profile.branch_code);
  const ourPusher = nameKey(profile.pushed_by_value ?? 'ZOHO');
  const ledgerFile = profile.ledger_file ?? 'ledger.xlsx';
  const closingFile = profile.closing_tb_file ?? 'closing_tb.xlsx';
  const openingFile = profile.opening_tb_file ?? 'opening_tb.xlsx';

  const ledger = readTable(files, ledgerFile, { headerMatch: (r) => r.includes('c_prefix') && r.includes('c_act_code') });
  if (!ledger) throw new NormaliseError('MISSING_FILE', `${ledgerFile} (ledger table) is required`);
  const missing = LEDGER_COLUMNS.filter((c) => !ledger.header.includes(c));
  if (missing.length) throw new NormaliseError('HEADER_MISMATCH', `${ledgerFile}: missing column(s) ${missing.join(', ')}`);
  const closing = readTrialBalance(files, closingFile, true);
  const opening = readTrialBalance(files, openingFile, false);

  // party control: Status names a control ledger (by description) for codes not in the TB
  const byName = new Map();
  for (const l of closing.ledgers.values()) if (!byName.has(nameKey(l.name))) byName.set(nameKey(l.name), l.code);
  for (const [alias, code] of Object.entries(profile.control_aliases ?? {})) byName.set(nameKey(alias), code);

  const { dates, repair } = resolveDates(ledger.rows, profile);
  const creditSign = resolveCreditSign(ledger.rows, ledgerFile, profile);

  const stats = new Map();
  const bump = (prefix, reason, key, paise) => {
    const k = `${prefix}|${reason}`;
    const s = stats.get(k) ?? { prefix, reason, rows: 0, documents: new Set(), paise: 0n };
    s.rows += 1; s.documents.add(key); s.paise += paise; stats.set(k, s);
  };
  const movement = new Map(); // ledger -> { ours, theirs } (signed, debit positive)
  const addMove = (ledgerCode, pusher, paise) => {
    const m = movement.get(ledgerCode) ?? { ours: 0n, theirs: 0n };
    if (pusher === 'ours') m.ours += paise; else m.theirs += paise;
    movement.set(ledgerCode, m);
  };
  const vouchers = new Map();
  const unknownControls = new Map();
  const pusherSummary = {};
  let emitted = 0;

  ledger.rows.forEach((r, i) => {
    const prefix = cell(r.c_prefix);
    const tranNo = cell(r.n_tran_no);
    const key = `${cell(r.c_year)}/${prefix}/${tranNo}`;
    const debit = cellMoney(ledgerFile, r, 'Debit', key);
    const credit = cellMoney(ledgerFile, r, 'Credit', key); // negative or a positive magnitude, per creditSign
    const net = creditSign.sign === 'positive' ? debit - credit : debit + credit;
    const absAmt = net < 0n ? -net : net;
    if (!prefix || !tranNo) { bump(prefix || '(none)', 'FOOTER', key, absAmt); return; }
    const pusherRaw = cell(r['To be pushed by']);
    const pusher = nameKey(pusherRaw) === ourPusher ? 'ours' : pusherRaw ? 'theirs' : 'unknown';
    const code = cleanCode(cell(r.c_act_code));
    const status = cell(r.Status);
    let ledgerCode = code; let party = null;
    if (!closing.ledgers.has(code)) {
      const ctl = byName.get(nameKey(status));
      if (ctl) { ledgerCode = ctl; party = code; } else { unknownControls.set(`${code}|${status}`, (unknownControls.get(`${code}|${status}`) ?? 0) + 1); }
    }
    const ps = pusherSummary[pusherRaw || '(blank)'] ??= { rows: 0, documents: new Set(), prefixes: new Set(), paise: 0n };
    ps.rows += 1; ps.documents.add(key); ps.prefixes.add(prefix); ps.paise += absAmt;
    if (pusher !== 'unknown') addMove(ledgerCode, pusher, net);

    if (pusher === 'theirs') { bump(prefix, 'PUSHED_BY_OTHER', key, absAmt); return; }
    if (pusher === 'unknown') { bump(prefix, 'PUSHED_BY_UNKNOWN', key, absAmt); return; }
    const type = profile.prefix_types[prefix];
    if (!type) { bump(prefix, 'UNKNOWN_PREFIX', key, absAmt); return; }
    const date = dates[i];
    if (!date) { bump(prefix, 'BAD_DATE', key, absAmt); return; }
    if (date < profile.from_date || date > profile.to_date) { bump(prefix, 'OUT_OF_WINDOW', key, absAmt); return; }
    if (net === 0n) { bump(prefix, 'ZERO_AMOUNT', key, 0n); return; }
    emitted += 1;
    const v = vouchers.get(key) ?? { type, date, lines: [] };
    if (v.date !== date) v.date = v.date < date ? v.date : date;
    v.lines.push({ ledger: ledgerCode, ledgerName: closing.ledgers.get(ledgerCode)?.name ?? cell(r.act_name), party, partyName: party ? cell(r.act_name) : '', debit: net > 0n ? net : 0n, credit: net < 0n ? -net : 0n, opp: cleanCode(cell(r.c_opp_act_code)), oppName: cell(r.opp_act_name) });
    vouchers.set(key, v);
  });

  // ---- transactions.csv ----
  const txnRows = []; const ledgerVouchers = new Map(); const unbalanced = []; const byType = {};
  const gross = new Map(); // ledger -> { dr, cr } of OUR lines (Layer A compares gross sides, not the net)
  let debitTotal = 0n; let creditTotal = 0n;
  const ids = [...vouchers.keys()].sort((a, b) => { const va = vouchers.get(a); const vb = vouchers.get(b); return va.date < vb.date ? -1 : va.date > vb.date ? 1 : a < b ? -1 : a > b ? 1 : 0; });
  for (const id of ids) {
    const v = vouchers.get(id); let dr = 0n; let cr = 0n;
    v.lines.forEach((l, i) => {
      dr += l.debit; cr += l.credit;
      (ledgerVouchers.get(l.ledger) ?? ledgerVouchers.set(l.ledger, new Set()).get(l.ledger)).add(id);
      const g = gross.get(l.ledger) ?? { dr: 0n, cr: 0n }; g.dr += l.debit; g.cr += l.credit; gross.set(l.ledger, g);
      const row = { branch_code: branch, voucher_id: id, voucher_no: id, voucher_type: v.type, voucher_date: v.date, line_no: i + 1, ledger_code: l.ledger, ledger_name: l.ledgerName, debit: formatMoney(l.debit), credit: formatMoney(l.credit), party_code: l.party ?? '', party_name: l.partyName, payment_method: '', tax_bucket: '', narration: l.opp ? `vs ${l.opp}${l.oppName ? ' ' + l.oppName : ''}` : '', reference_no: '', created_at: '', modified_at: '' };
      txnRows.push(TRANSACTIONS_COLUMNS.map((c) => row[c]));
    });
    debitTotal += dr; creditTotal += cr;
    const t = byType[v.type] ??= { vouchers: 0, lines: 0, paise: 0n }; t.vouchers += 1; t.lines += v.lines.length; t.paise += dr;
    if (dr !== cr) unbalanced.push({ voucher_id: id, debit: formatMoney(dr), credit: formatMoney(cr) });
  }

  // ---- trial balance: components + contract rows ----
  const compRows = []; const tbRows = []; let tiesAll = true; let closingDr = 0n; let closingCr = 0n;
  const codes = new Set([...closing.ledgers.keys(), ...movement.keys()]);
  for (const code of [...codes].sort()) {
    const l = closing.ledgers.get(code);
    const m = movement.get(code) ?? { ours: 0n, theirs: 0n };
    const op = l?.op ?? 0n; const cl = l?.cl ?? 0n; const tr = l?.tr ?? null;
    const ties = l ? op + m.ours + m.theirs === cl && (tr === null || tr === m.ours + m.theirs) : false;
    if (!ties) tiesAll = false;
    compRows.push([code, l?.name ?? '', formatMoney(op), formatMoney(m.theirs), formatMoney(m.ours), formatMoney(cl), tr === null ? '' : formatMoney(tr), formatMoney(op + m.ours + m.theirs - cl), l ? 'YES' : 'NO', ties ? 'YES' : 'NO']);
    if (!l) continue;
    const adjOpen = op + m.theirs;
    const [od, oc] = drcr(adjOpen); const [cd, cc] = drcr(cl);
    const g = gross.get(code) ?? { dr: 0n, cr: 0n };
    const [pd, pc] = [formatMoney(g.dr), formatMoney(g.cr)];
    closingDr += cl > 0n ? cl : 0n; closingCr += cl < 0n ? -cl : 0n;
    const row = { branch_code: branch, ledger_code: code, ledger_name: l.name, opening_debit: od, opening_credit: oc, period_debit: pd, period_credit: pc, closing_debit: cd, closing_credit: cc, txn_count: ledgerVouchers.get(code)?.size ?? 0 };
    tbRows.push(TRIAL_BALANCE_COLUMNS.map((c) => row[c]));
  }
  const COMP_COLUMNS = ['ledger_code', 'ledger_name', 'opening', 'movement_other_pusher', 'movement_ours', 'closing', 'closing_report_movement', 'difference', 'in_trial_balance', 'ties'];

  // 31 March closing vs 1 April opening (year-end close of income/expense is expected)
  const openingDiffs = [];
  if (opening) {
    for (const code of new Set([...opening.ledgers.keys(), ...closing.ledgers.keys()])) {
      const a = opening.ledgers.get(code)?.cl ?? 0n; const b = closing.ledgers.get(code)?.op ?? 0n;
      if (a !== b) openingDiffs.push({ ledger_code: code, ledger_name: (closing.ledgers.get(code) ?? opening.ledgers.get(code))?.name ?? '', closing_31_march: formatMoney(a), opening_1_april: formatMoney(b) });
    }
  }

  const transactionsCsv = toCsv(TRANSACTIONS_COLUMNS, txnRows);
  const trialBalanceCsv = toCsv(TRIAL_BALANCE_COLUMNS, tbRows);
  const componentsCsv = toCsv(COMP_COLUMNS, compRows);
  const inputHashes = Object.keys(files).sort().map((n) => `${n}:${sha256Bytes(Buffer.isBuffer(files[n]) ? files[n] : Buffer.from(String(files[n]), 'utf8'))}`);
  const digest = sha256Text(inputHashes.join('\n') + '\n' + JSON.stringify(profile));
  const runId = profile.extraction_run_id ?? `${branch}-${profile.from_date}-${profile.to_date}-ledger-${digest.slice(0, 8)}`;
  const manifest = {
    contract_version: '1.0', extraction_run_id: runId, source_system: 'ECO_GREEN', query_id: 'EG_LEDGER_TABLE',
    query_name: 'Eco Green ledger table (all transactions), rows to be pushed by Zoho; TB opening includes the other pusher\'s movement',
    query_version: profile.profile_version ?? 'v1', sql_hash: `sha256:${digest}`, branch_code: branch,
    from_date: profile.from_date, to_date: profile.to_date, currency: 'INR',
    extracted_at: profile.extracted_at ?? (now ? now() : new Date().toISOString()), source_operator_or_job: 'ecogreen-ledger-table-normaliser',
    files: [
      { file_name: 'transactions.csv', file_role: 'TRANSACTIONS', sha256: sha256Text(transactionsCsv), row_count: txnRows.length, debit_total: formatMoney(debitTotal), credit_total: formatMoney(creditTotal), encoding: 'utf-8', delimiter: ',' },
      { file_name: 'trial_balance.csv', file_role: 'TRIAL_BALANCE', sha256: sha256Text(trialBalanceCsv), row_count: tbRows.length, debit_total: formatMoney(closingDr), credit_total: formatMoney(closingCr), encoding: 'utf-8', delimiter: ',' },
    ],
  };
  const exclusions = [...stats.values()].map((s) => ({ prefix: s.prefix, reason: s.reason, rows: s.rows, documents: s.documents.size, amount: formatMoney(s.paise) })).sort((a, b) => (a.prefix + a.reason < b.prefix + b.reason ? -1 : 1));
  const excludedRows = exclusions.reduce((n, e) => n + e.rows, 0);
  const report = {
    branch_code: branch, extraction_run_id: runId, from_date: profile.from_date, to_date: profile.to_date, inputs: inputHashes,
    date_repair: repair,
    credit_sign: creditSign,
    pushers: Object.fromEntries(Object.entries(pusherSummary).map(([k, v]) => [k, { rows: v.rows, documents: v.documents.size, prefixes: [...v.prefixes].sort(), gross_amount: formatMoney(v.paise) }])),
    output: { vouchers: ids.length, lines: txnRows.length, debit_total: formatMoney(debitTotal), credit_total: formatMoney(creditTotal), by_type: Object.fromEntries(Object.entries(byType).map(([k, v]) => [k, { vouchers: v.vouchers, lines: v.lines, debit_total: formatMoney(v.paise) }])), trial_balance_ledgers: tbRows.length },
    bridge: { table: ledgerFile, source_rows: ledger.rows.length, emitted_rows: emitted, excluded_rows: excludedRows, ties: ledger.rows.length === emitted + excludedRows },
    exclusions,
    trial_balance_ties: { all: tiesAll, ledgers: compRows.length, failing: compRows.filter((r) => r[9] === 'NO').map((r) => ({ ledger_code: r[0], ledger_name: r[1], difference: r[7], in_trial_balance: r[8] })) },
    unknown_controls: [...unknownControls.entries()].map(([k, lines]) => { const [code, status] = k.split('|'); return { code, status, lines }; }),
    unbalanced_vouchers: unbalanced,
    opening_differences: openingDiffs,
  };
  return { manifest, transactionsCsv, trialBalanceCsv, componentsCsv, report };
}

function csvField(v) { const s = v === null || v === undefined ? '' : String(v); return /[",\n\r]/.test(s) || s !== s.trim() ? `"${s.replace(/"/g, '""')}"` : s; }
function toCsv(header, rows) { return [header, ...rows].map((r) => r.map(csvField).join(',')).join('\n') + '\n'; }
