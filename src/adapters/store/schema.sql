-- Eco Green -> Zoho Books migration pilot: operational schema (SQLite, node:sqlite).
--
-- Portability rule: every table that needs a composite unique key ALSO carries a
-- synthetic `uk` TEXT column (pipe-joined) with a single-column UNIQUE. Catalyst
-- Data Store has no multi-column unique index, so the Data Store adapter relies on
-- `uk` alone. SQLite gets both. Never remove `uk`.
--
-- Money: stored as TEXT decimal strings with exactly 2 dp ("1234.50"). Arithmetic is
-- done in integer paise (BigInt) via src/core/money.js. Never store floats.
-- Dates: ISO-8601 (YYYY-MM-DD). Timestamps: ISO-8601 UTC with ms.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------- reference

CREATE TABLE IF NOT EXISTS branches (
  branch_code            TEXT PRIMARY KEY,
  branch_name            TEXT NOT NULL,
  zoho_location_id       TEXT,                  -- NULL until mapped
  status                 TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL
);

-- Branch / transaction-class cutover matrix (PROJECT_CONTEXT "Branch cutover matrix").
CREATE TABLE IF NOT EXISTS cutover_matrix (
  id                             INTEGER PRIMARY KEY AUTOINCREMENT,
  branch_code                    TEXT NOT NULL REFERENCES branches(branch_code),
  zoho_location_id               TEXT,
  migration_from_date            TEXT NOT NULL,          -- default 2026-04-01
  live_system_start_date         TEXT,                   -- NULL = unverified -> blocks
  historical_migration_end_date  TEXT,                   -- normally live_start - 1 day
  transaction_class              TEXT NOT NULL,          -- '*' or a voucher_type
  payment_method                 TEXT NOT NULL DEFAULT '*',
  smart_pharma_coverage_status   TEXT NOT NULL,          -- COVERED | NOT_COVERED | PARTIAL | UNKNOWN
  cutover_rule_version           TEXT NOT NULL,
  approval_status                TEXT NOT NULL DEFAULT 'DRAFT', -- DRAFT | APPROVED | REVOKED
  approved_by                    TEXT,
  approved_at                    TEXT,
  evidence_ref                   TEXT,
  uk                             TEXT NOT NULL UNIQUE,   -- branch|class|payment_method|rule_version
  created_at                     TEXT NOT NULL,
  updated_at                     TEXT NOT NULL
);

-- Versioned mapping rules. rule_type examples:
--   MODULE_ROUTE   source_key=voucher_type          target_value=books module (bill|vendor_payment|...)
--   LEDGER_ACCOUNT source_key=ledger_code           target_value=zoho account id/name
--   PARTY          source_key=party_code            target_value=zoho contact id
--   PAYMENT_MODE   source_key=payment_method        target_value=zoho payment mode
--   TAX            source_key=tax_bucket            target_value=zoho tax id
CREATE TABLE IF NOT EXISTS mapping_rules (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_type       TEXT NOT NULL,
  source_key      TEXT NOT NULL,
  target_value    TEXT NOT NULL,
  target_meta     TEXT,                        -- JSON, optional
  mapping_version TEXT NOT NULL,
  effective_from  TEXT NOT NULL,
  effective_to    TEXT,
  status          TEXT NOT NULL DEFAULT 'DRAFT', -- DRAFT | APPROVED | RETIRED
  approved_by     TEXT,
  approved_at     TEXT,
  notes           TEXT,
  uk              TEXT NOT NULL UNIQUE,        -- rule_type|source_key|mapping_version
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

-- ---------------------------------------------------------------- ingestion

CREATE TABLE IF NOT EXISTS extraction_runs (
  id                    TEXT PRIMARY KEY,           -- extraction_run_id from manifest
  branch_code           TEXT NOT NULL,
  query_id              TEXT NOT NULL,
  query_version         TEXT NOT NULL,
  from_date             TEXT NOT NULL,
  to_date               TEXT NOT NULL,
  manifest_json         TEXT NOT NULL,
  manifest_sha256       TEXT NOT NULL UNIQUE,
  inbox_ref             TEXT,                       -- inbox object/path
  archive_uri           TEXT,                       -- immutable archive location of manifest
  status                TEXT NOT NULL,              -- see src/core/states.js RUN_STATES
  claimed_by            TEXT,
  claimed_at            TEXT,
  claim_expires_at      TEXT,
  error_code            TEXT,
  error_message         TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS source_files (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id            TEXT NOT NULL REFERENCES extraction_runs(id),
  file_name         TEXT NOT NULL,
  file_role         TEXT NOT NULL,                 -- TRANSACTIONS | TRIAL_BALANCE
  sha256            TEXT NOT NULL UNIQUE,          -- duplicate-file detection (file level)
  size_bytes        INTEGER NOT NULL,
  encoding          TEXT NOT NULL,
  delimiter         TEXT NOT NULL,
  declared_row_count INTEGER,
  actual_row_count  INTEGER,
  declared_debit_total  TEXT,
  declared_credit_total TEXT,
  actual_debit_total    TEXT,
  actual_credit_total   TEXT,
  archive_uri       TEXT,
  status            TEXT NOT NULL,                 -- RECEIVED | VALIDATED | VALIDATION_FAILED | ARCHIVED | LOADED | QUARANTINED
  validation_json   TEXT,                          -- JSON array of {code, severity, message, row?}
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

-- Raw transactional lines exactly as loaded (normalised types, no business transformation).
CREATE TABLE IF NOT EXISTS source_txn_lines (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id          TEXT NOT NULL REFERENCES extraction_runs(id),
  file_id         INTEGER NOT NULL REFERENCES source_files(id),
  row_number      INTEGER NOT NULL,                -- 1-based data row in CSV
  branch_code     TEXT NOT NULL,
  voucher_id      TEXT NOT NULL,
  voucher_no      TEXT,
  voucher_type    TEXT NOT NULL,
  voucher_date    TEXT NOT NULL,
  line_no         INTEGER NOT NULL,
  ledger_code     TEXT NOT NULL,
  ledger_name     TEXT,
  debit           TEXT NOT NULL,                   -- "0.00" if none
  credit          TEXT NOT NULL,
  party_code      TEXT,
  party_name      TEXT,
  payment_method  TEXT,
  tax_bucket      TEXT,
  narration       TEXT,
  reference_no    TEXT,
  source_created_at  TEXT,
  source_modified_at TEXT,
  row_hash        TEXT NOT NULL,                   -- sha256 of canonical material fields
  uk              TEXT NOT NULL UNIQUE,            -- file_id|voucher_id|line_no
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_txn_lines_run_voucher ON source_txn_lines(run_id, voucher_id);
CREATE INDEX IF NOT EXISTS ix_txn_lines_run_ledger  ON source_txn_lines(run_id, ledger_code);

CREATE TABLE IF NOT EXISTS trial_balance_lines (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id          TEXT NOT NULL REFERENCES extraction_runs(id),
  file_id         INTEGER NOT NULL REFERENCES source_files(id),
  branch_code     TEXT NOT NULL,
  ledger_code     TEXT NOT NULL,
  ledger_name     TEXT,
  opening_debit   TEXT NOT NULL,
  opening_credit  TEXT NOT NULL,
  period_debit    TEXT NOT NULL,
  period_credit   TEXT NOT NULL,
  closing_debit   TEXT NOT NULL,
  closing_credit  TEXT NOT NULL,
  txn_count       INTEGER,
  uk              TEXT NOT NULL UNIQUE,            -- file_id|ledger_code
  created_at      TEXT NOT NULL
);

-- ---------------------------------------------------------------- canonical vouchers (migratable unit)
-- One row per source voucher. Carries the MANDATORY lineage fields from PROJECT_CONTEXT.

CREATE TABLE IF NOT EXISTS vouchers (
  id                        INTEGER PRIMARY KEY AUTOINCREMENT,
  -- lineage
  source_system             TEXT NOT NULL DEFAULT 'ECO_GREEN',
  source_query_id           TEXT NOT NULL,
  source_query_version      TEXT NOT NULL,
  extraction_run_id         TEXT NOT NULL REFERENCES extraction_runs(id),
  source_file_id            INTEGER NOT NULL REFERENCES source_files(id),
  source_file_hash          TEXT NOT NULL,
  source_table_or_entity    TEXT NOT NULL DEFAULT 'vouchers',
  source_record_id          TEXT NOT NULL,         -- voucher_id
  source_document_no        TEXT,                  -- voucher_no
  branch_code               TEXT NOT NULL,
  zoho_location_id          TEXT,
  financial_year            TEXT NOT NULL,         -- e.g. 2026-27
  period                    TEXT NOT NULL,         -- YYYY-MM
  transaction_date          TEXT NOT NULL,
  source_transaction_type   TEXT NOT NULL,         -- voucher_type
  source_transaction_hash   TEXT NOT NULL UNIQUE,  -- canonical business identity (idempotency key)
  -- content summary
  debit_total               TEXT NOT NULL,
  credit_total              TEXT NOT NULL,
  line_count                INTEGER NOT NULL,
  payment_method            TEXT,
  tax_bucket                TEXT,
  party_code                TEXT,
  is_balanced               INTEGER NOT NULL,      -- 1/0
  -- disposition (Layer B bridge)
  disposition               TEXT NOT NULL,         -- PENDING | MIGRATE | SMART_PHARMA_EXCLUDED | OTHER_EXCLUDED | BLOCKED
  disposition_rule_version  TEXT,
  disposition_reason        TEXT,
  disposition_evidence_json TEXT,
  disposition_by            TEXT,
  disposition_at            TEXT,
  -- transformation
  mapping_version           TEXT,
  transformation_version    TEXT,
  target_module             TEXT,
  target_payload_hash       TEXT,
  -- migration
  migration_batch_id        TEXT,
  approval_id               TEXT,
  zoho_record_id            TEXT,
  migration_status          TEXT NOT NULL DEFAULT 'NOT_QUEUED', -- NOT_QUEUED|QUEUED|IN_FLIGHT|POSTED|FAILED|UNKNOWN_OUTCOME|DEAD_LETTER|SKIPPED
  attempt_count             INTEGER NOT NULL DEFAULT 0,
  last_error_code           TEXT,
  last_error_message        TEXT,
  reconciliation_status     TEXT NOT NULL DEFAULT 'NOT_RECONCILED',
  created_at                TEXT NOT NULL,
  updated_at                TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_vouchers_run ON vouchers(extraction_run_id);
CREATE INDEX IF NOT EXISTS ix_vouchers_branch_period ON vouchers(branch_code, period);
CREATE INDEX IF NOT EXISTS ix_vouchers_batch ON vouchers(migration_batch_id);

-- ---------------------------------------------------------------- summarisation & reconciliation

CREATE TABLE IF NOT EXISTS summaries (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id          TEXT NOT NULL REFERENCES extraction_runs(id),
  branch_code     TEXT NOT NULL,
  from_date       TEXT NOT NULL,
  to_date         TEXT NOT NULL,
  ledger_code     TEXT NOT NULL,
  voucher_type    TEXT NOT NULL,                   -- '*' for ledger total across types
  debit           TEXT NOT NULL,
  credit          TEXT NOT NULL,
  txn_count       INTEGER NOT NULL,
  line_count      INTEGER NOT NULL,
  summary_version TEXT NOT NULL,
  uk              TEXT NOT NULL UNIQUE,            -- run_id|ledger_code|voucher_type|summary_version
  created_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS recon_runs (
  id              TEXT PRIMARY KEY,
  run_id          TEXT REFERENCES extraction_runs(id),
  batch_id        TEXT,
  layer           TEXT NOT NULL,                   -- A | B | C | BALANCE_BRIDGE
  branch_code     TEXT NOT NULL,
  tolerance       TEXT NOT NULL DEFAULT '0.00',
  status          TEXT NOT NULL,                   -- PASS | FAIL | PASS_WITH_APPROVED_EXCEPTIONS
  summary_json    TEXT NOT NULL,
  inputs_version  TEXT NOT NULL,                   -- hash of (run, summary_version, mapping_version, ...)
  created_by      TEXT NOT NULL,
  created_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS recon_results (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  recon_run_id    TEXT NOT NULL REFERENCES recon_runs(id),
  control_key     TEXT NOT NULL,                   -- e.g. ledger:1001:period_debit
  expected        TEXT NOT NULL,
  actual          TEXT NOT NULL,
  difference      TEXT NOT NULL,
  status          TEXT NOT NULL,                   -- MATCH | DIFF | MISSING_EXPECTED | MISSING_ACTUAL
  detail_json     TEXT,                            -- drilldown refs (line ids, voucher ids, target ids)
  uk              TEXT NOT NULL UNIQUE,            -- recon_run_id|control_key
  created_at      TEXT NOT NULL
);

-- Smart Pharma overlap classification per voucher (or per aggregated population key).
CREATE TABLE IF NOT EXISTS overlap_candidates (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  voucher_id         INTEGER NOT NULL REFERENCES vouchers(id),
  population_key     TEXT NOT NULL,                -- branch|date|class|payment_method|tax_bucket
  classification     TEXT NOT NULL,               -- MIGRATE | SMART_PHARMA_ALREADY_POSTED | PARTIAL_OR_AMBIGUOUS_OVERLAP | NOT_APPLICABLE
  match_strength     TEXT NOT NULL,               -- NONE | DATE_ONLY | COVERAGE_RULE | REFERENCE_MATCH | FULL_EVIDENCE
  evidence_json      TEXT NOT NULL,
  rule_version       TEXT NOT NULL,
  reviewer           TEXT,
  reviewed_at        TEXT,
  uk                 TEXT NOT NULL UNIQUE,         -- voucher_id|rule_version
  created_at         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS exceptions (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  category          TEXT NOT NULL,                 -- see src/core/exceptions.js CATEGORIES
  severity          TEXT NOT NULL,                 -- P0 | P1 | P2 | P3
  branch_code       TEXT,
  period            TEXT,
  run_id            TEXT,
  file_id           INTEGER,
  voucher_id        INTEGER,
  batch_id          TEXT,
  financial_impact  TEXT NOT NULL DEFAULT '0.00',
  owner             TEXT,
  status            TEXT NOT NULL DEFAULT 'OPEN',  -- OPEN | ASSIGNED | RESOLVED | APPROVED_EXCEPTION | REJECTED
  root_cause        TEXT,
  disposition       TEXT,
  evidence_json     TEXT,
  message           TEXT NOT NULL,
  dedupe_key        TEXT NOT NULL UNIQUE,          -- prevents duplicate exception rows on reruns
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

-- ---------------------------------------------------------------- transformation, approval, queue

CREATE TABLE IF NOT EXISTS preview_payloads (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  voucher_id             INTEGER NOT NULL REFERENCES vouchers(id),
  target_module          TEXT NOT NULL,
  payload_json           TEXT NOT NULL,            -- Books-shaped payload (dry-run)
  payload_hash           TEXT NOT NULL,
  human_summary          TEXT NOT NULL,            -- one-line readable description
  mapping_version        TEXT NOT NULL,
  transformation_version TEXT NOT NULL,
  warnings_json          TEXT,
  uk                     TEXT NOT NULL UNIQUE,     -- voucher_id|transformation_version|mapping_version
  created_at             TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS migration_batches (
  id                     TEXT PRIMARY KEY,
  branch_code            TEXT NOT NULL,
  period                 TEXT NOT NULL,
  run_id                 TEXT NOT NULL REFERENCES extraction_runs(id),
  scope_hash             TEXT NOT NULL,            -- sha256 over sorted voucher source_transaction_hash + payload_hash
  mapping_version        TEXT NOT NULL,
  transformation_version TEXT NOT NULL,
  cutover_rule_version   TEXT NOT NULL,
  voucher_count          INTEGER NOT NULL,
  debit_total            TEXT NOT NULL,
  credit_total           TEXT NOT NULL,
  totals_json            TEXT NOT NULL,            -- per-module counts/amounts
  status                 TEXT NOT NULL,            -- see src/core/states.js BATCH_STATES
  approval_id            TEXT,
  created_by             TEXT NOT NULL,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS approvals (
  id                    TEXT PRIMARY KEY,
  batch_id              TEXT NOT NULL REFERENCES migration_batches(id),
  scope_hash            TEXT NOT NULL,             -- must equal batch.scope_hash at decision time
  decision              TEXT NOT NULL,             -- APPROVED | REJECTED
  approver              TEXT NOT NULL,
  approver_role         TEXT NOT NULL,
  reason                TEXT,
  invalidated_at        TEXT,
  invalidation_reason   TEXT,
  created_at            TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS queue_items (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id        TEXT NOT NULL REFERENCES migration_batches(id),
  voucher_id      INTEGER NOT NULL REFERENCES vouchers(id),
  idempotency_key TEXT NOT NULL UNIQUE,            -- = voucher.source_transaction_hash
  status          TEXT NOT NULL,                   -- QUEUED | CLAIMED | POSTED | FAILED_RETRYABLE | FAILED_FINAL | UNKNOWN_OUTCOME | DEAD_LETTER | PAUSED
  claimed_by      TEXT,
  claimed_at      TEXT,
  claim_expires_at TEXT,
  run_after       TEXT,
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_error_code TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_queue_status ON queue_items(status, run_after);

CREATE TABLE IF NOT EXISTS api_attempts (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  queue_item_id    INTEGER NOT NULL REFERENCES queue_items(id),
  attempt_no       INTEGER NOT NULL,
  target_module    TEXT NOT NULL,
  request_hash     TEXT NOT NULL,
  response_class   TEXT NOT NULL,                  -- SUCCESS | RETRYABLE | NON_RETRYABLE | AUTH | RATE_LIMIT | UNKNOWN
  http_status      INTEGER,
  zoho_record_id   TEXT,
  error_code       TEXT,
  error_message    TEXT,                           -- REDACTED, never full payload
  retry_after_ms   INTEGER,
  started_at       TEXT NOT NULL,
  finished_at      TEXT,
  uk               TEXT NOT NULL UNIQUE,           -- queue_item_id|attempt_no
  created_at       TEXT NOT NULL
);

-- ---------------------------------------------------------------- live Books balance bridge

CREATE TABLE IF NOT EXISTS books_snapshots (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  branch_code       TEXT NOT NULL,
  zoho_location_id  TEXT,
  organization_id   TEXT NOT NULL,
  kind              TEXT NOT NULL,                 -- BASELINE | POST_RUN
  batch_id          TEXT,
  driver            TEXT NOT NULL,                 -- mock | live
  taken_at          TEXT NOT NULL,
  balances_json     TEXT NOT NULL,                 -- [{account_id, account_name, debit, credit, balance}]
  records_json      TEXT,                          -- migration-tagged / SP-tagged / manual record refs in window
  snapshot_hash     TEXT NOT NULL,
  created_at        TEXT NOT NULL
);

-- ---------------------------------------------------------------- audit (append-only)

CREATE TABLE IF NOT EXISTS audit_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  actor           TEXT NOT NULL,                   -- user id / worker id / bot:<user>
  actor_role      TEXT,
  action          TEXT NOT NULL,
  entity_type     TEXT NOT NULL,
  entity_id       TEXT,
  before_json     TEXT,
  after_json      TEXT,
  reason          TEXT,
  authorization_decision TEXT,                     -- ALLOWED | DENIED
  correlation_id  TEXT NOT NULL,
  branch_code     TEXT,
  period          TEXT,
  batch_id        TEXT,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_audit_entity ON audit_events(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS ix_audit_corr ON audit_events(correlation_id);

-- Users are loaded from config (hashed tokens), not stored here in the MVP.
