// Curated Catalyst Data Store schema for the pilot vertical slice.
// See CONTRACTS.md §S/§R, docs/CATALYST_REFERENCES.md, and src/adapters/store/schema.sql
// (the sqlite source of truth this file is a curated, hand-derived translation of).
//
// Scope: only the 9 tables this pilot's adapters touch —
//   audit_events, extraction_runs, source_files, vouchers, source_txn_lines,
//   source_summaries (physical name for sqlite's `summaries` table), recon_runs,
//   recon_results, exceptions.
// Every other schema.sql table (branches, cutover_matrix, mapping_rules,
// trial_balance_lines, overlap_candidates, preview_payloads, migration_batches,
// approvals, queue_items, api_attempts, books_snapshots) is out of scope for the
// Catalyst adapter in this pilot and is intentionally absent here.
//
// TYPE MAPPING (sqlite -> Catalyst), decided and applied uniformly below:
//   - Physical primary key is Catalyst ROWID for EVERY table. A sqlite INTEGER
//     AUTOINCREMENT `id` therefore is NOT a column here (it is ROWID at the
//     Catalyst layer; the adapter's logicalKey for these tables is 'ROWID').
//   - Tables whose sqlite PK is TEXT (extraction_runs.id, recon_runs.id) keep
//     that value in an explicit `varchar` column literally named `id`, with
//     is_unique: true. The adapter resolves get(table, id) by that column for
//     these tables (logicalKey 'id' below) instead of by ROWID.
//   - A column that is a foreign-key reference to another table's integer
//     (ROWID-backed) sqlite id -> `bigint` (e.g. vouchers.source_file_id,
//     source_txn_lines.file_id, exceptions.file_id/voucher_id).
//   - A column that is a foreign-key reference to another table's TEXT id
//     (extraction_runs.id, recon_runs.id) -> `varchar` (e.g. *.run_id,
//     recon_results.recon_run_id), sized like an id (128).
//   - sha256 hex digests -> varchar(64). ISO date ("YYYY-MM-DD") and ISO
//     timestamp ("...T...Z") strings are both treated as the same "timestamp"
//     bucket -> varchar(40) (a date is a strict prefix of the timestamp shape,
//     so one width covers both safely).
//   - Money decimal strings ("1234.50") -> varchar(24).
//   - Short codes/enums (status, layer, severity, voucher_type, file_role,
//     encoding, category, disposition, migration_status, response_class-ish
//     fields, etc.) -> varchar(32), except a couple of table-specific narrower
//     widths noted inline (severity P0..P3 -> 8; delimiter -> 8; financial_year
//     "2026-27" -> 16; period "YYYY-MM" -> 7, matching audit_events.period).
//   - Free-form identifiers (voucher_id, party_code, reference numbers, actor
//     ids, workerId-shaped claimed_by, batch/approval/zoho record ids) ->
//     varchar(128).
//   - Human-readable names (ledger_name, party_name) -> varchar(255).
//   - Synthetic composite `uk` columns (kept from schema.sql, see its header
//     comment) -> varchar(255), is_unique: true.
//   - `*_json` columns, `message`, `narration`, `error_message`/`last_error_message`,
//     `reason`, `disposition_reason`, `root_cause`, `validation_json`,
//     `manifest_json`, `summary_json`, `detail_json`, `evidence_json` /
//     `disposition_evidence_json` -> `text`. Catalyst caps `text` at 10,000
//     characters (auto-applied at column creation, see docs/CATALYST_REFERENCES.md);
//     overflow-to-Stratus for oversized payloads is a documented follow-up, NOT
//     implemented in this pilot.
//   - sqlite INTEGER counts/flags (row counts, line_no, attempts, is_balanced,
//     txn_count, line_count) -> `int`.
//   - A column UNIQUE in schema.sql -> is_unique: true.
//   - A column NOT NULL in schema.sql -> is_mandatory: true.
//   - `audit_consent` and `search_index_enabled` are always false for every
//     column; they are Create_Column API properties, not part of the table
//     definitions below, so they are only emitted by
//     scripts/generate-iac-template.js's `--emit-columns` output.
//   - Reserved Catalyst column names (`date`, `key`, `result`, `priority`) do
//     not occur in this schema; asserted at module load below.

const RESERVED_COLUMN_NAMES = new Set(['date', 'key', 'result', 'priority']);

/** Build one column definition. `text` columns may never carry max_length/is_unique. */
function col(column_name, data_type, { max_length, is_mandatory = false, is_unique = false } = {}) {
  if (data_type === 'text') {
    if (max_length !== undefined || is_unique) {
      throw new Error(`schema.catalyst.js: text column ${column_name} must not carry max_length/is_unique`);
    }
    return { column_name, data_type, is_mandatory };
  }
  const def = { column_name, data_type, is_mandatory };
  if (max_length !== undefined) def.max_length = max_length;
  if (is_unique) def.is_unique = true;
  return def;
}

const varchar = (name, max_length, opts = {}) => col(name, 'varchar', { max_length, ...opts });
const text = (name, opts = {}) => col(name, 'text', opts);
const int = (name, opts = {}) => col(name, 'int', opts);
const bigint = (name, opts = {}) => col(name, 'bigint', opts);

// Widths reused across tables (see TYPE MAPPING above).
const W = {
  SHA256: 64,
  TS: 40,
  MONEY: 24,
  CODE: 32,
  ID: 128,
  NAME: 255,
  UK: 255,
  PERIOD: 7,
  FY: 16,
  SEVERITY: 8,
  DELIM: 8,
};

export const TABLES = [
  {
    name: 'audit_events',
    logicalKey: 'ROWID',
    // This exact column list is LIVE in the Catalyst Development project (created
    // ahead of this adapter). Keep byte-for-byte consistent with what exists.
    columns: [
      varchar('actor', 255, { is_mandatory: true }),
      varchar('actor_role', 64),
      varchar('action', 128, { is_mandatory: true }),
      varchar('entity_type', 64, { is_mandatory: true }),
      varchar('entity_id', 255),
      text('before_json'),
      text('after_json'),
      text('reason'),
      varchar('authorization_decision', 16),
      varchar('correlation_id', 128, { is_mandatory: true }),
      varchar('branch_code', 32),
      varchar('period', 7),
      varchar('batch_id', 128),
      varchar('created_at', 40, { is_mandatory: true }),
    ],
  },
  {
    name: 'extraction_runs',
    logicalKey: 'id',
    columns: [
      varchar('id', W.ID, { is_mandatory: true, is_unique: true }),
      varchar('branch_code', W.CODE, { is_mandatory: true }),
      varchar('query_id', W.ID, { is_mandatory: true }),
      varchar('query_version', W.CODE, { is_mandatory: true }),
      varchar('from_date', W.TS, { is_mandatory: true }),
      varchar('to_date', W.TS, { is_mandatory: true }),
      text('manifest_json', { is_mandatory: true }),
      varchar('manifest_sha256', W.SHA256, { is_mandatory: true, is_unique: true }),
      varchar('inbox_ref', W.NAME),
      varchar('archive_uri', W.NAME),
      varchar('status', W.CODE, { is_mandatory: true }),
      varchar('claimed_by', W.ID),
      varchar('claimed_at', W.TS),
      varchar('claim_expires_at', W.TS),
      varchar('error_code', W.SHA256),
      text('error_message'),
      varchar('created_at', W.TS, { is_mandatory: true }),
      varchar('updated_at', W.TS, { is_mandatory: true }),
    ],
  },
  {
    name: 'source_files',
    logicalKey: 'ROWID',
    columns: [
      varchar('run_id', W.ID, { is_mandatory: true }),
      varchar('file_name', W.NAME, { is_mandatory: true }),
      varchar('file_role', W.CODE, { is_mandatory: true }),
      varchar('sha256', W.SHA256, { is_mandatory: true, is_unique: true }),
      int('size_bytes', { is_mandatory: true }),
      varchar('encoding', W.CODE, { is_mandatory: true }),
      varchar('delimiter', W.DELIM, { is_mandatory: true }),
      int('declared_row_count'),
      int('actual_row_count'),
      varchar('declared_debit_total', W.MONEY),
      varchar('declared_credit_total', W.MONEY),
      varchar('actual_debit_total', W.MONEY),
      varchar('actual_credit_total', W.MONEY),
      varchar('archive_uri', W.NAME),
      varchar('status', W.CODE, { is_mandatory: true }),
      text('validation_json'),
      varchar('created_at', W.TS, { is_mandatory: true }),
      varchar('updated_at', W.TS, { is_mandatory: true }),
    ],
  },
  {
    name: 'source_txn_lines',
    logicalKey: 'ROWID',
    columns: [
      varchar('run_id', W.ID, { is_mandatory: true }),
      bigint('file_id', { is_mandatory: true }),
      int('row_number', { is_mandatory: true }),
      varchar('branch_code', W.CODE, { is_mandatory: true }),
      varchar('voucher_id', W.ID, { is_mandatory: true }),
      varchar('voucher_no', W.ID),
      varchar('voucher_type', W.CODE, { is_mandatory: true }),
      varchar('voucher_date', W.TS, { is_mandatory: true }),
      int('line_no', { is_mandatory: true }),
      varchar('ledger_code', W.CODE, { is_mandatory: true }),
      varchar('ledger_name', W.NAME),
      varchar('debit', W.MONEY, { is_mandatory: true }),
      varchar('credit', W.MONEY, { is_mandatory: true }),
      varchar('party_code', W.ID),
      varchar('party_name', W.NAME),
      varchar('payment_method', W.CODE),
      varchar('tax_bucket', W.CODE),
      text('narration'),
      varchar('reference_no', W.ID),
      varchar('source_created_at', W.TS),
      varchar('source_modified_at', W.TS),
      varchar('row_hash', W.SHA256, { is_mandatory: true }),
      varchar('uk', W.UK, { is_mandatory: true, is_unique: true }),
      varchar('created_at', W.TS, { is_mandatory: true }),
    ],
  },
  {
    name: 'vouchers',
    logicalKey: 'ROWID',
    columns: [
      varchar('source_system', W.CODE, { is_mandatory: true }),
      varchar('source_query_id', W.ID, { is_mandatory: true }),
      varchar('source_query_version', W.CODE, { is_mandatory: true }),
      varchar('extraction_run_id', W.ID, { is_mandatory: true }),
      bigint('source_file_id', { is_mandatory: true }),
      varchar('source_file_hash', W.SHA256, { is_mandatory: true }),
      varchar('source_table_or_entity', W.ID, { is_mandatory: true }),
      varchar('source_record_id', W.ID, { is_mandatory: true }),
      varchar('source_document_no', W.ID),
      varchar('branch_code', W.CODE, { is_mandatory: true }),
      varchar('zoho_location_id', W.ID),
      varchar('financial_year', W.FY, { is_mandatory: true }),
      varchar('period', W.PERIOD, { is_mandatory: true }),
      varchar('transaction_date', W.TS, { is_mandatory: true }),
      varchar('source_transaction_type', W.CODE, { is_mandatory: true }),
      varchar('source_transaction_hash', W.SHA256, { is_mandatory: true, is_unique: true }),
      varchar('debit_total', W.MONEY, { is_mandatory: true }),
      varchar('credit_total', W.MONEY, { is_mandatory: true }),
      int('line_count', { is_mandatory: true }),
      varchar('payment_method', W.CODE),
      varchar('tax_bucket', W.CODE),
      varchar('party_code', W.ID),
      int('is_balanced', { is_mandatory: true }),
      varchar('disposition', W.CODE, { is_mandatory: true }),
      varchar('disposition_rule_version', W.CODE),
      text('disposition_reason'),
      text('disposition_evidence_json'),
      varchar('disposition_by', W.ID),
      varchar('disposition_at', W.TS),
      varchar('mapping_version', W.CODE),
      varchar('transformation_version', W.CODE),
      varchar('target_module', W.CODE),
      varchar('target_payload_hash', W.SHA256),
      varchar('migration_batch_id', W.ID),
      varchar('approval_id', W.ID),
      varchar('zoho_record_id', W.ID),
      varchar('migration_status', W.CODE, { is_mandatory: true }),
      int('attempt_count', { is_mandatory: true }),
      varchar('last_error_code', W.SHA256),
      text('last_error_message'),
      varchar('reconciliation_status', W.CODE, { is_mandatory: true }),
      varchar('created_at', W.TS, { is_mandatory: true }),
      varchar('updated_at', W.TS, { is_mandatory: true }),
    ],
  },
  {
    name: 'source_summaries', // physical name for sqlite's `summaries` table
    logicalKey: 'ROWID',
    columns: [
      varchar('run_id', W.ID, { is_mandatory: true }),
      varchar('branch_code', W.CODE, { is_mandatory: true }),
      varchar('from_date', W.TS, { is_mandatory: true }),
      varchar('to_date', W.TS, { is_mandatory: true }),
      varchar('ledger_code', W.CODE, { is_mandatory: true }),
      varchar('voucher_type', W.CODE, { is_mandatory: true }),
      varchar('debit', W.MONEY, { is_mandatory: true }),
      varchar('credit', W.MONEY, { is_mandatory: true }),
      int('txn_count', { is_mandatory: true }),
      int('line_count', { is_mandatory: true }),
      varchar('summary_version', W.CODE, { is_mandatory: true }),
      varchar('uk', W.UK, { is_mandatory: true, is_unique: true }),
      varchar('created_at', W.TS, { is_mandatory: true }),
    ],
  },
  {
    name: 'recon_runs',
    logicalKey: 'id',
    columns: [
      varchar('id', W.ID, { is_mandatory: true, is_unique: true }),
      varchar('run_id', W.ID),
      varchar('batch_id', W.ID),
      varchar('layer', W.CODE, { is_mandatory: true }),
      varchar('branch_code', W.CODE, { is_mandatory: true }),
      varchar('tolerance', W.MONEY, { is_mandatory: true }),
      varchar('status', W.CODE, { is_mandatory: true }),
      text('summary_json', { is_mandatory: true }),
      varchar('inputs_version', W.SHA256, { is_mandatory: true }),
      varchar('created_by', W.ID, { is_mandatory: true }),
      varchar('created_at', W.TS, { is_mandatory: true }),
    ],
  },
  {
    name: 'recon_results',
    logicalKey: 'ROWID',
    columns: [
      varchar('recon_run_id', W.ID, { is_mandatory: true }),
      varchar('control_key', W.ID, { is_mandatory: true }),
      varchar('expected', W.MONEY, { is_mandatory: true }),
      varchar('actual', W.MONEY, { is_mandatory: true }),
      varchar('difference', W.MONEY, { is_mandatory: true }),
      varchar('status', W.CODE, { is_mandatory: true }),
      text('detail_json'),
      varchar('uk', W.UK, { is_mandatory: true, is_unique: true }),
      varchar('created_at', W.TS, { is_mandatory: true }),
    ],
  },
  {
    name: 'exceptions',
    logicalKey: 'ROWID',
    columns: [
      varchar('category', W.CODE, { is_mandatory: true }),
      varchar('severity', W.SEVERITY, { is_mandatory: true }),
      varchar('branch_code', W.CODE),
      varchar('period', W.PERIOD),
      varchar('run_id', W.ID),
      bigint('file_id'),
      bigint('voucher_id'),
      varchar('batch_id', W.ID),
      varchar('financial_impact', W.MONEY, { is_mandatory: true }),
      varchar('owner', W.ID),
      varchar('status', W.CODE, { is_mandatory: true }),
      text('root_cause'),
      varchar('disposition', W.CODE),
      text('evidence_json'),
      text('message', { is_mandatory: true }),
      varchar('dedupe_key', W.UK, { is_mandatory: true, is_unique: true }),
      varchar('created_at', W.TS, { is_mandatory: true }),
      varchar('updated_at', W.TS, { is_mandatory: true }),
    ],
  },
];

for (const t of TABLES) {
  for (const c of t.columns) {
    if (RESERVED_COLUMN_NAMES.has(c.column_name)) {
      throw new Error(`schema.catalyst.js: reserved Catalyst column name used at ${t.name}.${c.column_name}`);
    }
  }
}

export function columnsFor(table) {
  const t = TABLES.find((x) => x.name === table);
  if (!t) throw new Error(`schema.catalyst.js: unknown table ${table}`);
  return t.columns;
}
