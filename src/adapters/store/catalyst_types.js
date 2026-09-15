// Shared constants + helpers for the Catalyst Data Store adapter (catalyst.js) and its
// Catalyst-shaped fake (catalyst_fake.js). See CONTRACTS.md §S and
// docs/CATALYST_REFERENCES.md. Kept in one module so both sides agree on table/column
// whitelisting, ZCQL literal escaping, and the raw-row -> Store-contract-row shape.
//
// Catalyst behaviour ASSUMED here (per the coordinator's observed live Development
// shapes, 2026-09-14 — not independently re-verified beyond that note):
//   - insertRow/insertRows echo back every input column plus CREATORID (string),
//     CREATEDTIME/MODIFIEDTIME ('YYYY-MM-DD HH:mm:ss:SSS') and ROWID as a NUMBER.
//   - getRow/getPagedRows return the same shape but ROWID as a STRING; paged
//     responses carry `more_records` (boolean) and, when true, `next_token`.
//   - A ZCQL SELECT result is an array of `{ "<physical_table_name>": { ...selected
//     columns, ROWID: '<string>' } }` — only the selected columns are present,
//     nulls come back as null.
//   - `text` columns are created with max_length 10000 automatically.
// Every adapter/fake read path normalises ROWID to a plain string `id` (never leaking
// ROWID/CREATORID/CREATEDTIME/MODIFIEDTIME into the Store-contract row shape, which is
// "plain objects with column names exactly as in schema.sql", per CONTRACTS.md).
import { TABLES as SCHEMA_TABLES } from '../../../catalyst/iac/schema.catalyst.js';

export const TEXT_MAX_LENGTH = 10000;

// ZCQL caps a single SELECT at 30 selected columns. OBSERVED LIVE against the real
// Catalyst Data Store (Development), 2026-09-15: the synthetic seed's CLASSIFY_TRANSFORM
// stage ran `SELECT <all 43 columns> FROM vouchers` and the platform rejected it with:
//   "More than 30 select columns are not allowed"
// This is a live-observed limit, not one listed on the ZCQL syntax-exceptions page
// consulted for docs/CATALYST_REFERENCES.md's 300-row-cap entry (2026-09-14) — see that
// doc's Data Store limits table for the dated citation. Shared by catalyst.js (which
// chunks a wide SELECT into multiple <=30-column queries and re-joins them by ROWID) and
// catalyst_fake.js (which enforces the same cap so this can never silently regress).
export const ZCQL_MAX_SELECT_COLUMNS = 30;

// Logical (Store-interface / schema.sql) table name -> physical Catalyst table name.
// Only `summaries` differs, per schema.catalyst.js's header comment (curated as
// `source_summaries`). Every other table keeps its schema.sql name.
const LOGICAL_TO_PHYSICAL = Object.freeze({ summaries: 'source_summaries' });
const PHYSICAL_TO_LOGICAL = Object.freeze(
  Object.fromEntries(Object.entries(LOGICAL_TO_PHYSICAL).map(([logical, physical]) => [physical, logical]))
);

export function toPhysicalTable(logicalTable) {
  return LOGICAL_TO_PHYSICAL[logicalTable] ?? logicalTable;
}

export function toLogicalTable(physicalTable) {
  return PHYSICAL_TO_LOGICAL[physicalTable] ?? physicalTable;
}

const TABLE_DEFS = new Map(SCHEMA_TABLES.map((t) => [t.name, t]));

export const LOGICAL_TABLES = Object.freeze([
  'audit_events',
  'extraction_runs',
  'source_files',
  'vouchers',
  'source_txn_lines',
  'summaries',
  'recon_runs',
  'recon_results',
  'exceptions',
  'branches',
  'cutover_matrix',
  'mapping_rules',
  'trial_balance_lines',
  'overlap_candidates',
  'preview_payloads',
  'migration_batches',
  'approvals',
  'queue_items',
  'api_attempts',
  'books_snapshots',
  'branch_summaries',
  'app_users',
  'branch_period_assignments',
  'books_connections',
  'books_locations',
]);

export class TableNotAllowedError extends Error {
  constructor(table) {
    super(`Table not allowed: ${table}`);
    this.code = 'TABLE_NOT_ALLOWED';
    this.table = table;
  }
}

export class ColumnNotAllowedError extends Error {
  constructor(table, column) {
    super(`Column not allowed on ${table}: ${column}`);
    this.code = 'COLUMN_NOT_ALLOWED';
    this.table = table;
    this.column = column;
  }
}

export class UniqueViolationError extends Error {
  constructor({ table, constraint }) {
    super(`UNIQUE violation on ${table}.${constraint}`);
    this.code = 'UNIQUE_VIOLATION';
    this.table = table;
    this.constraint = constraint;
  }
}

export class AppendOnlyViolationError extends Error {
  constructor(table) {
    super(`${table} is append-only on the Catalyst Data Store adapter: no update/claim allowed`);
    this.code = 'APPEND_ONLY';
    this.table = table;
  }
}

export class RawSqlNotReadOnlyError extends Error {
  constructor(sql) {
    super('store.raw() only accepts read-only SELECT statements');
    this.code = 'RAW_SQL_NOT_READONLY';
    this.sql = sql;
  }
}

/**
 * Thrown by catalyst.js's column-chunk merge (see ZCQL_MAX_SELECT_COLUMNS) when two
 * chunk queries for the SAME logical page (identical WHERE/ORDER BY/LIMIT/OFFSET, only
 * the selected columns differ) disagree on which ROWIDs they returned. This should only
 * be possible if rows are inserted/deleted between the chunk queries (the adapter has no
 * transaction/snapshot isolation to prevent that — see the module header's other
 * BEST_EFFORT notes) or a chunk merge bug. Either way, silently merging whatever
 * ROWIDs overlap would produce a row spliced from two DIFFERENT logical rows — a
 * correctness risk against financial data — so this is thrown instead of ever returning
 * a partially-merged row.
 */
export class ZcqlChunkMismatchError extends Error {
  constructor(table, detail) {
    super(`ZCQL column-chunk mismatch on ${table}: ${detail}`);
    this.code = 'ZCQL_CHUNK_MISMATCH';
    this.table = table;
  }
}

/** Look up the schema.catalyst.js table definition for a logical (Store-contract) table name. */
export function tableDef(logicalTable) {
  const physical = toPhysicalTable(logicalTable);
  const def = TABLE_DEFS.get(physical);
  if (!def) throw new TableNotAllowedError(logicalTable);
  return def;
}

export function assertTableAllowed(logicalTable) {
  tableDef(logicalTable);
}

/** Injection guard: every column name used in a query must be declared in schema.catalyst.js. */
export function assertColumnsAllowed(logicalTable, columns) {
  const def = tableDef(logicalTable);
  const known = new Set(def.columns.map((c) => c.column_name));
  for (const c of columns) {
    if (!known.has(c)) throw new ColumnNotAllowedError(logicalTable, c);
  }
}

export function logicalKeyOf(logicalTable) {
  return tableDef(logicalTable).logicalKey;
}

export function columnTypeOf(logicalTable, column) {
  const def = tableDef(logicalTable);
  const c = def.columns.find((x) => x.column_name === column);
  return c?.data_type;
}

/** Single-quote-escape a ZCQL string literal (doubles embedded quotes, like sqlite.js's SQL). */
export function escapeZcqlString(value) {
  return String(value).replace(/'/g, "''");
}

/** Render one WHERE-clause value as a ZCQL literal for the column's declared type. */
export function zcqlLiteral(logicalTable, column, value) {
  if (value === null || value === undefined) return 'NULL';
  const type = columnTypeOf(logicalTable, column);
  if (type === 'int' || type === 'bigint') return String(Number(value));
  return `'${escapeZcqlString(value)}'`;
}

/**
 * Coerce one raw Catalyst scalar (as returned by insertRow/getRow/updateRow/ZCQL) to the
 * JS value the rest of the codebase expects, per the column's declared data_type.
 */
export function coerceScalar(dataType, value) {
  if (value === null || value === undefined) return null;
  if (dataType === 'int') return typeof value === 'number' ? value : Number(value);
  // bigint-typed columns here are FK-style row references (see schema.catalyst.js's TYPE
  // MAPPING). Keep them as decimal strings: Catalyst assigns ROWID-scale bigints and JSON
  // round-tripping large integers as JS numbers risks silent precision loss, and every
  // caller in this codebase already treats id-like FK columns as strings (mirrors how
  // ROWID itself is normalised to a string `id`, never a number, outside of insertRow).
  if (dataType === 'bigint') return String(value);
  if (dataType === 'boolean') return value === true || value === 'true';
  return value;
}

/**
 * Turn a raw Catalyst row (the insertRow/getRow/updateRow shape, or one table's slice of
 * a ZCQL row) into the plain-object shape the Store contract promises: declared columns
 * exactly as in schema.sql, plus the table's key column — never ROWID/CREATORID/
 * CREATEDTIME/MODIFIEDTIME.
 *
 * Three logicalKey styles (see schema.catalyst.js's TYPE MAPPING header):
 *   - 'ROWID': the table has no explicit key column; synthesise `id` from ROWID (mirrors
 *     sqlite.js's literal `id INTEGER PRIMARY KEY AUTOINCREMENT` column).
 *   - 'id': the table declares an explicit `varchar` column literally named `id`
 *     (extraction_runs, recon_runs, migration_batches, approvals).
 *   - any other column name (currently only 'branch_code', for `branches`): the table
 *     declares an explicit `varchar` column under that name, which is its own sqlite PK.
 * The last two styles both fall through the same "explicit key column" branch below —
 * only the column name differs.
 */
export function normaliseRow(logicalTable, raw) {
  if (!raw) return null;
  const def = tableDef(logicalTable);
  const key = def.logicalKey;
  const out = {};
  for (const c of def.columns) {
    if (key !== 'ROWID' && c.column_name === key) continue; // handled specially below
    if (Object.prototype.hasOwnProperty.call(raw, c.column_name)) {
      out[c.column_name] = coerceScalar(c.data_type, raw[c.column_name]);
    }
  }
  if (key === 'ROWID') {
    out.id = raw.ROWID !== undefined ? String(raw.ROWID) : raw.id;
  } else {
    const keyCol = def.columns.find((c) => c.column_name === key);
    if (raw[key] !== undefined) {
      out[key] = coerceScalar(keyCol?.data_type, raw[key]);
    } else if (key === 'id' && raw.ROWID !== undefined) {
      out.id = String(raw.ROWID); // defensive fallback only; explicit id-keyed tables always carry their own id
    }
  }
  return out;
}

/**
 * Best-effort detection of a Catalyst unique-constraint violation. ASSUMPTION (documented
 * in catalyst.js and catalyst_fake.js): the fake raises `{ code: 'INVALID_INPUT', message:
 * "The given column value '<v>' for the column '<c>' is already present." }`; real Catalyst
 * responses are not guaranteed to match verbatim, so this also treats any message/code
 * mentioning "unique" or "duplicate" as a unique violation.
 */
export function looksLikeUniqueViolation(err) {
  const msg = String(err?.message ?? '').toLowerCase();
  const code = String(err?.code ?? '').toLowerCase();
  return (
    msg.includes('already present') ||
    msg.includes('unique') ||
    msg.includes('duplicate') ||
    code.includes('unique') ||
    code.includes('duplicate')
  );
}

/** Best-effort extraction of the offending column name from a unique-violation message. */
export function extractUniqueColumn(err) {
  const msg = String(err?.message ?? '');
  // Requires the quote immediately after "column" so "given column value '<v>'" (the
  // OFFENDING VALUE, not the column name) never matches before "for the column '<name>'".
  const m = msg.match(/column\s+'([A-Za-z0-9_]+)'/i);
  return err?.column ?? (m ? m[1] : 'unknown');
}

/** Best-effort detection of a Catalyst "row not found" response (getRow/updateRow on a
 *  missing ROWID). ASSUMPTION: the fake raises `{ code: 'ROW_NOT_FOUND' }`; real Catalyst
 *  errors are matched defensively via message text too. */
export function looksLikeNotFound(err) {
  const msg = String(err?.message ?? '').toLowerCase();
  const code = String(err?.code ?? '').toLowerCase();
  return code === 'row_not_found' || code === 'no_content' || msg.includes('not found') || msg.includes('no rows');
}
