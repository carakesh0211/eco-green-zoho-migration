// Bulk mapping for one branch run: list every source ledger and party that still has no
// APPROVED rule, propose a Zoho Books target by name (src/core/mapping_proposals.js) from
// the uploaded Books reference lists (src/core/books_reference.js), and turn either the
// confident proposals or a reviewer-filled sheet into DRAFT mapping rules. Approval stays a
// separate, human step (POST /api/mappings/approve), which then re-applies the mapping.
//
// The sheet carries Books NAMES, never ids: on upload each name is resolved against the
// reference lists. Source codes survive spreadsheet edits (Excel drops leading zeros:
// "000939" comes back as "939"), so a code is matched exactly, then without leading zeros,
// then by the source name.
import { parseCsv } from './csv.js';
import { readXlsx } from '../sources/ecogreen/xlsx.js';
import { parseMoney, formatMoney } from './money.js';
import { normaliseName, proposeAccountMappings, proposeContactMappings } from './mapping_proposals.js';

export class SheetError extends Error {
  constructor(message) {
    super(message);
    this.code = 'BAD_SHEET';
  }
}

const text = (v) => (v === null || v === undefined ? '' : String(v).trim());
const stripZeros = (s) => s.replace(/^0+(?=.)/, '');

/** Ledgers and parties used by the run's lines, with entry counts and debit amounts. */
export async function collectRunEntities(store, runId) {
  const lines = await store.find('source_txn_lines', { run_id: runId });
  const ledgers = new Map();
  const parties = new Map();
  for (const l of lines) {
    const code = text(l.ledger_code);
    const amount = parseMoney(l.debit ?? '0') + parseMoney(l.credit ?? '0');
    if (code) {
      const e = ledgers.get(code) ?? { ledger_code: code, ledger_name: text(l.ledger_name), vouchers: new Set(), amount: 0n };
      if (!e.ledger_name && l.ledger_name) e.ledger_name = text(l.ledger_name);
      e.vouchers.add(l.voucher_id);
      e.amount += amount;
      ledgers.set(code, e);
    }
    const party = text(l.party_code);
    if (party) {
      const e = parties.get(party) ?? { party_code: party, party_name: text(l.party_name), vouchers: new Set(), ledger_codes: new Set(), amount: 0n };
      if (!e.party_name && l.party_name) e.party_name = text(l.party_name);
      e.vouchers.add(l.voucher_id);
      if (code) e.ledger_codes.add(code);
      e.amount += amount;
      parties.set(party, e);
    }
  }
  const done = (e) => ({ ...e, usage_count: e.vouchers.size, amount: formatMoney(e.amount), vouchers: undefined });
  return {
    ledgers: [...ledgers.values()].map((e) => done(e)),
    parties: [...parties.values()].map((e) => ({ ...done(e), ledger_codes: [...e.ledger_codes] })),
  };
}

function approvedKeys(rules) {
  const keys = new Set();
  for (const r of rules) if (r.status === 'APPROVED') keys.add(`${r.rule_type}|${r.source_key}`);
  return keys;
}

/**
 * Rows for the sheet / screen: one per ledger or party without an APPROVED rule.
 * Each: { rule_type, source_code, source_name, entries, amount, match, books_kind,
 *         books_name, books_id, alternatives[], note }
 */
export function proposeForRun({ entities, reference, rules }) {
  const approved = approvedKeys(rules);
  const accounts = reference?.accounts ?? [];
  const contacts = reference?.contacts ?? [];
  const ledgers = entities.ledgers.filter((l) => !approved.has(`LEDGER_ACCOUNT|${l.ledger_code}`));
  const parties = entities.parties.filter((p) => !approved.has(`PARTY|${p.party_code}`));
  const byLedger = new Map(ledgers.map((l) => [l.ledger_code, l]));
  const byParty = new Map(parties.map((p) => [p.party_code, p]));

  const rows = [];
  for (const p of proposeAccountMappings({ ledgers, accounts })) {
    const src = byLedger.get(p.source_key);
    rows.push({
      rule_type: 'LEDGER_ACCOUNT', source_code: p.source_key, source_name: p.source_name, entries: src.usage_count, amount: src.amount,
      match: p.status, books_kind: 'account', books_name: p.target_name ?? '', books_id: p.target_id ?? '',
      alternatives: p.candidates.filter((c) => c.id !== p.target_id).map((c) => c.name), note: p.note || '',
    });
  }
  for (const p of proposeContactMappings({ parties, contacts, accounts })) {
    const src = byParty.get(p.source_key);
    rows.push({
      rule_type: 'PARTY', source_code: p.source_key, source_name: p.source_name, entries: src.usage_count, amount: src.amount,
      match: p.status, books_kind: p.kind, books_name: p.target_name ?? '', books_id: p.target_id ?? '',
      alternatives: p.candidates.filter((c) => c.id !== p.target_id).map((c) => c.name), note: p.note || '',
    });
  }
  // Biggest first: what holds back the most entries is fixed first.
  rows.sort((a, b) => b.entries - a.entries || (a.source_code < b.source_code ? -1 : 1));
  return rows;
}

export const CONFIDENT = new Set(['EXACT', 'FUZZY', 'ACCOUNT']);

const SHEET_HEADER = ['type', 'source_code', 'source_name', 'entries', 'amount', 'suggestion', 'books_kind', 'books_name', 'other_candidates', 'note'];
const TYPE_WORD = { LEDGER_ACCOUNT: 'Ledger', PARTY: 'Party' };
const MATCH_WORD = { EXACT: 'Exact match', FUZZY: 'Close match - check', ACCOUNT: 'Party is a Books account', REVIEW: 'Possible match - choose', AMBIGUOUS: 'Several matches - choose', NONE: 'No match - fill in' };

function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** The sheet a reviewer fills in (CSV, opens in Excel). Edit books_name (and books_kind). */
export function sheetCsv(rows) {
  const lines = [SHEET_HEADER.join(',')];
  for (const r of rows) {
    lines.push([
      TYPE_WORD[r.rule_type], r.source_code, r.source_name, r.entries, r.amount, MATCH_WORD[r.match] ?? r.match,
      r.books_kind, r.books_name, r.alternatives.join(' | '), r.note,
    ].map(csvCell).join(','));
  }
  return `﻿${lines.join('\r\n')}\r\n`;
}

/** A filled sheet (CSV or XLSX) -> [{ line, type, source_code, source_name, books_kind, books_name }]. */
export function parseSheet(bytes) {
  let table;
  if (bytes.length > 2 && bytes[0] === 0x50 && bytes[1] === 0x4b) {
    let wb;
    try { wb = readXlsx(bytes, { rawNumbers: true }); } catch (e) { throw new SheetError(`Excel file could not be read: ${e.message}`); }
    const sheet = wb.sheets[0];
    if (!sheet) throw new SheetError('the Excel file has no sheet');
    table = sheet.rows.map((r) => r.map((c) => (c === null || c === undefined ? '' : String(c))));
  } else {
    let s = bytes.toString('utf8');
    if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
    const { header, rows } = parseCsv(s);
    table = [header, ...rows];
  }
  const header = (table[0] ?? []).map((h) => text(h).toLowerCase().replace(/\s+/g, '_'));
  const idx = (n) => header.indexOf(n);
  for (const need of ['type', 'source_code', 'books_name']) {
    if (idx(need) === -1) throw new SheetError(`the sheet has no "${need}" column; download a fresh mapping sheet and fill that one in`);
  }
  return table.slice(1)
    .map((r, i) => ({
      line: i + 2,
      type: text(r[idx('type')]).toLowerCase(),
      source_code: text(r[idx('source_code')]),
      source_name: idx('source_name') === -1 ? '' : text(r[idx('source_name')]),
      books_kind: idx('books_kind') === -1 ? '' : text(r[idx('books_kind')]).toLowerCase(),
      books_name: text(r[idx('books_name')]),
    }))
    .filter((r) => r.type || r.source_code || r.books_name);
}

function findSource(row, list, codeOf, nameOf) {
  const exact = list.find((e) => codeOf(e) === row.source_code);
  if (exact) return exact;
  if (row.source_code) {
    const bare = stripZeros(row.source_code);
    const loose = list.filter((e) => stripZeros(codeOf(e)) === bare);
    if (loose.length === 1) return loose[0];
  }
  if (row.source_name) {
    const n = normaliseName(row.source_name);
    const byName = list.filter((e) => normaliseName(nameOf(e)) === n);
    if (byName.length === 1) return byName[0];
  }
  return null;
}

/** Books target by name (or exact id) -> { target } | { error }. */
function findTarget(name, { accounts, contacts }, kind) {
  const n = normaliseName(name);
  const pickAccounts = () => {
    const hits = accounts.filter((a) => a.account_id === name || (a.is_active && normaliseName(a.account_name) === n));
    if (hits.length === 1) return { target: { kind: 'account', id: hits[0].account_id, name: hits[0].account_name, type: hits[0].account_type, parent: hits[0].parent_account_name || null } };
    return hits.length > 1 ? { error: 'AMBIGUOUS', count: hits.length } : null;
  };
  const pickContacts = () => {
    const hits = contacts.filter((c) => c.contact_id === name || (c.status === 'active' && normaliseName(c.contact_name) === n));
    if (hits.length === 1) return { target: { kind: 'contact', id: hits[0].contact_id, name: hits[0].contact_name, type: hits[0].contact_type || null } };
    return hits.length > 1 ? { error: 'AMBIGUOUS', count: hits.length } : null;
  };
  if (kind === 'account') return pickAccounts() ?? { error: 'NOT_FOUND' };
  if (kind === 'contact') return pickContacts() ?? { error: 'NOT_FOUND' };
  return pickContacts() ?? pickAccounts() ?? { error: 'NOT_FOUND' };
}

function ruleRow({ ruleType, sourceKey, target, mappingVersion, effectiveFrom, booksOrgId, match }) {
  const meta = target.kind === 'account'
    ? { ...(ruleType === 'PARTY' ? { kind: 'account' } : {}), account_name: target.name, account_type: target.type, parent_account_name: target.parent, books_org_id: booksOrgId, match }
    : { kind: 'contact', contact_name: target.name, contact_type: target.type, books_org_id: booksOrgId, match };
  return {
    rule_type: ruleType, source_key: sourceKey, target_value: target.id, target_meta: meta,
    mapping_version: mappingVersion, effective_from: effectiveFrom, effective_to: null, status: 'DRAFT',
    notes: match.status === 'REVIEWER' ? 'Chosen in the bulk mapping sheet; pending approval' : `Bulk auto-map (${match.status}); pending approval`,
  };
}

/** DRAFT rules for every confident proposal (EXACT / FUZZY / party-is-account). */
export function autoRules(rows, { mappingVersion, effectiveFrom, booksOrgId }) {
  return rows
    .filter((r) => CONFIDENT.has(r.match) && r.books_id)
    .map((r) => ruleRow({
      ruleType: r.rule_type, sourceKey: r.source_code, mappingVersion, effectiveFrom, booksOrgId,
      target: { kind: r.books_kind === 'account' ? 'account' : 'contact', id: r.books_id, name: r.books_name, type: null, parent: null },
      match: { status: r.match, source_name: r.source_name },
    }));
}

/**
 * Filled sheet rows -> { rules, results }. results: one per sheet row with outcome
 * RULE | BLANK | ALREADY_APPROVED | UNKNOWN_SOURCE | NOT_FOUND | AMBIGUOUS | BAD_TYPE.
 */
export function resolveSheet(sheetRows, { entities, reference, rules: existing, mappingVersion, effectiveFrom, booksOrgId }) {
  const approved = approvedKeys(existing);
  const ref = { accounts: reference?.accounts ?? [], contacts: reference?.contacts ?? [] };
  const rules = [];
  const seen = new Set();
  const results = sheetRows.map((r) => {
    const base = { line: r.line, source_code: r.source_code, source_name: r.source_name, books_name: r.books_name };
    const ruleType = r.type.startsWith('ledger') || r.type === 'ledger_account' ? 'LEDGER_ACCOUNT' : r.type.startsWith('party') ? 'PARTY' : null;
    if (!ruleType) return { ...base, outcome: 'BAD_TYPE', message: 'type must be Ledger or Party' };
    const src = ruleType === 'LEDGER_ACCOUNT'
      ? findSource(r, entities.ledgers, (e) => e.ledger_code, (e) => e.ledger_name)
      : findSource(r, entities.parties, (e) => e.party_code, (e) => e.party_name);
    if (!src) return { ...base, rule_type: ruleType, outcome: 'UNKNOWN_SOURCE', message: 'this code is not in the branch run' };
    const sourceKey = ruleType === 'LEDGER_ACCOUNT' ? src.ledger_code : src.party_code;
    const out = { ...base, rule_type: ruleType, source_code: sourceKey };
    if (approved.has(`${ruleType}|${sourceKey}`)) return { ...out, outcome: 'ALREADY_APPROVED', message: 'already has an approved rule; left unchanged' };
    if (!r.books_name) return { ...out, outcome: 'BLANK', message: 'no Books name filled in; skipped' };
    const kind = ruleType === 'LEDGER_ACCOUNT' ? 'account' : (r.books_kind === 'account' || r.books_kind === 'contact' ? r.books_kind : null);
    const found = findTarget(r.books_name, ref, kind);
    if (found.error === 'NOT_FOUND') return { ...out, outcome: 'NOT_FOUND', message: `"${r.books_name}" is not an active ${kind ?? 'contact or account'} in the uploaded Books lists` };
    if (found.error === 'AMBIGUOUS') return { ...out, outcome: 'AMBIGUOUS', message: `${found.count} Books records are named "${r.books_name}"; make the name unique in Books or ask an admin` };
    const uk = `${ruleType}|${sourceKey}`;
    if (seen.has(uk)) return { ...out, outcome: 'DUPLICATE_ROW', message: 'this source appears twice in the sheet; the first row was used' };
    seen.add(uk);
    rules.push(ruleRow({ ruleType, sourceKey, target: found.target, mappingVersion, effectiveFrom, booksOrgId, match: { status: 'REVIEWER', source_name: r.source_name } }));
    return { ...out, outcome: 'RULE', books_kind: found.target.kind, books_target: found.target.name };
  });
  return { rules, results };
}

/** The mapping_version and effective_from new rules should use: those of the approved rules. */
export function ruleDefaults(rules, run) {
  const counts = new Map();
  let effectiveFrom = null;
  for (const r of rules) {
    if (r.status !== 'APPROVED') continue;
    counts.set(r.mapping_version, (counts.get(r.mapping_version) ?? 0) + 1);
    if (!effectiveFrom || r.effective_from < effectiveFrom) effectiveFrom = r.effective_from;
  }
  const mappingVersion = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'map_v1';
  let booksOrgId = null;
  for (const r of rules) {
    if (r.status !== 'APPROVED' || !r.target_meta) continue;
    try { booksOrgId = (typeof r.target_meta === 'string' ? JSON.parse(r.target_meta) : r.target_meta)?.books_org_id ?? booksOrgId; } catch { /* skip */ }
    if (booksOrgId) break;
  }
  return { mappingVersion, effectiveFrom: effectiveFrom ?? run.from_date, booksOrgId };
}
