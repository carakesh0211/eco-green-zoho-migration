// Deterministic hashing. Two distinct hash families, never mixed:
//   1. File hashes   — sha256 over raw bytes (duplicate-file detection).
//   2. Record hashes — sha256 over a CANONICAL serialisation of material fields
//      (idempotency identity). Canonical = stable key order, trimmed strings,
//      money normalised to "1234.50", dates ISO, nulls as "".
import { createHash } from 'node:crypto';

export function sha256Bytes(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

export function sha256Text(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Canonical serialisation of a flat object: sorted keys, values coerced to strings,
 * null/undefined -> "", strings trimmed. Nested objects/arrays are JSON-serialised
 * with sorted keys. Output is a single line, safe to hash.
 */
export function canonicalize(obj) {
  return JSON.stringify(sortDeep(obj));
}

function sortDeep(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'bigint') return v.toString();
  if (Array.isArray(v)) return v.map(sortDeep);
  if (typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = sortDeep(v[k]);
    return out;
  }
  if (typeof v === 'string') return v.trim();
  return v;
}

export function hashCanonical(obj) {
  return sha256Text(canonicalize(obj));
}

/**
 * Canonical source transaction identity for an Eco Green voucher.
 * Material discriminators only (PROJECT_CONTEXT "Identity and idempotency").
 * `lines` must be an array of {line_no, ledger_code, debit, credit} with money as "x.yy" strings.
 */
export function sourceTransactionHash({ source_system = 'ECO_GREEN', branch_code, voucher_type, voucher_id, voucher_no, voucher_date, lines }) {
  const material = {
    source_system,
    branch_code,
    voucher_type,
    voucher_id,
    voucher_no: voucher_no ?? '',
    voucher_date,
    lines: [...lines]
      .sort((a, b) => a.line_no - b.line_no)
      .map(l => ({ line_no: l.line_no, ledger_code: l.ledger_code, debit: l.debit, credit: l.credit })),
  };
  return hashCanonical(material);
}

/** Row-level hash for a single CSV line (change detection, not identity). */
export function rowHash(fields) {
  return hashCanonical(fields);
}

/** Immutable approval scope: sorted identities + payload hashes + rule versions. */
export function scopeHash({ identities, mapping_version, transformation_version, cutover_rule_version }) {
  const sorted = [...identities].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return hashCanonical({ identities: sorted, mapping_version, transformation_version, cutover_rule_version });
}
