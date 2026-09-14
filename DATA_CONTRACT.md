# DATA_CONTRACT.md — Eco Green extraction contract (pilot v1, SYNTHETIC)

> Status: **DRAFT / ASSUMED.** No real Eco Green query inventory, CSV schema, or control report has been received. This contract defines the *one agreed format* the rapid MVP is built against so the pipeline is real end-to-end. When the Eco Green team supplies actual query outputs, this file is versioned (`contract_version` bump), the connector adapts, and every fixture is regenerated. Nothing here is a statement about the real Eco Green schema.

## 1. Delivery unit: an extraction run

One extraction run = one branch × one date range × one versioned query set, delivered as a folder in the WorkDrive inbox (local folder in dev):

```
<inbox>/<branch_code>/<extraction_run_id>/
  manifest.json
  transactions.csv
  trial_balance.csv
```

A run is picked up only when `manifest.json` is present and every file it lists exists. Partial folders are ignored until complete (the extractor writes `manifest.json` last).

## 2. manifest.json

```json
{
  "contract_version": "1.0",
  "extraction_run_id": "PILOT01-2026-04-run-001",
  "source_system": "ECO_GREEN",
  "query_id": "EG_ACCT_VOUCHERS",
  "query_name": "Accounting vouchers with lines",
  "query_version": "v3",
  "sql_hash": "sha256:<hash of the SQL text>",
  "branch_code": "PILOT01",
  "from_date": "2026-04-01",
  "to_date": "2026-05-31",
  "currency": "INR",
  "extracted_at": "2026-09-13T18:05:00+05:30",
  "source_operator_or_job": "eg-extract-cron",
  "files": [
    {
      "file_name": "transactions.csv",
      "file_role": "TRANSACTIONS",
      "sha256": "<hex>",
      "row_count": 1234,
      "debit_total": "1234567.00",
      "credit_total": "1234567.00",
      "encoding": "utf-8",
      "delimiter": ","
    },
    {
      "file_name": "trial_balance.csv",
      "file_role": "TRIAL_BALANCE",
      "sha256": "<hex>",
      "row_count": 57,
      "debit_total": "9876543.00",
      "credit_total": "9876543.00",
      "encoding": "utf-8",
      "delimiter": ","
    }
  ]
}
```

Rules:
- `row_count` = data rows (excluding header). `debit_total`/`credit_total` = sum over the file, 2dp strings.
- `sha256` is over the raw file bytes. Mismatch → `VALIDATION_FAILED`, file quarantined.
- `extraction_run_id` is globally unique; a re-run of the same scope gets a new id. A manifest whose sha256 was already registered is a duplicate delivery and is rejected.
- Unknown `contract_version` → rejected.

## 3. transactions.csv (file_role TRANSACTIONS)

RFC 4180, UTF-8 (BOM tolerated), header row mandatory, one row per **voucher line**.

| column | type | required | notes |
|---|---|---|---|
| branch_code | text | yes | must equal manifest.branch_code on every row |
| voucher_id | text | yes | Eco Green primary key of the voucher (stable) |
| voucher_no | text | no | user-visible document number |
| voucher_type | enum | yes | see §5 |
| voucher_date | YYYY-MM-DD | yes | must be within manifest from/to |
| line_no | int ≥1 | yes | unique within voucher |
| ledger_code | text | yes | Eco Green account code; must exist in trial_balance.csv |
| ledger_name | text | no | |
| debit | money | yes | "0.00" when none; exactly one of debit/credit non-zero per line |
| credit | money | yes | |
| party_code | text | no | customer/vendor code, required for PURCHASE/PAYMENT/RECEIPT/CREDIT_NOTE/DEBIT_NOTE |
| party_name | text | no | |
| payment_method | enum | no | CASH, CARD, UPI, BANK, CREDIT, WALLET, OTHER — required for RECEIPT/PAYMENT/SALES_B2C |
| tax_bucket | text | no | e.g. GST5, GST12, GST18, EXEMPT, NA |
| narration | text | no | |
| reference_no | text | no | bank/UTR/bill ref |
| created_at | ISO datetime | no | source row creation |
| modified_at | ISO datetime | no | source row last change (late/back-posting detection) |

Voucher-level invariants (checked at staging, violations → exception `UNBALANCED_VOUCHER` / `MISSING_KEY` / `DUPLICATE_SOURCE`):
- Σdebit == Σcredit per voucher_id.
- All lines of a voucher share voucher_type, voucher_date, branch_code.
- (voucher_id, line_no) unique in the file.

## 4. trial_balance.csv (file_role TRIAL_BALANCE)

Independent control report for the same branch and date range. One row per ledger.

| column | type | notes |
|---|---|---|
| branch_code | text | |
| ledger_code | text | unique in file |
| ledger_name | text | |
| opening_debit / opening_credit | money | balance at from_date 00:00 |
| period_debit / period_credit | money | movements in [from_date, to_date] |
| closing_debit / closing_credit | money | |
| txn_count | int | number of vouchers touching this ledger in period |

Layer A control: for every ledger, `Σ transactions.debit` (by ledger, in range) must equal `period_debit` and likewise credit; `Σ distinct voucher_id` must equal `txn_count`; and `opening + period − closing` must net to zero. Tolerance default `0.00`; any other tolerance is a finance-approved config value recorded on the recon run.

## 5. voucher_type enumeration (synthetic) and default module routing

| voucher_type | meaning | default Books module (MODULE_ROUTE rule) | overlap class |
|---|---|---|---|
| PURCHASE | vendor bill | `bill` | NOT_APPLICABLE |
| PAYMENT | vendor payment | `vendor_payment` | NOT_APPLICABLE |
| RECEIPT | customer receipt (B2B) | `customer_payment` | NOT_APPLICABLE |
| EXPENSE | direct expense | `expense` | NOT_APPLICABLE |
| CREDIT_NOTE | customer credit note | `credit_note` | NOT_APPLICABLE |
| DEBIT_NOTE | vendor credit | `vendor_credit` | NOT_APPLICABLE |
| CONTRA | cash↔bank movement | `bank_transfer` | NOT_APPLICABLE |
| JOURNAL | pure accounting adjustment | `journal` | NOT_APPLICABLE |
| SALES_B2C | daily B2C sales summary | *none in fixtures — unmapped on purpose* | **Smart Pharma overlap class** |
| STOCK_ADJ | inventory adjustment | *never migrated* (`OTHER_EXCLUDED`, rule `INV_CONTROL_ONLY_v1`) | NOT_APPLICABLE |

`SALES_B2C` is the only class Smart Pharma also posts. Its disposition is decided by the cutover matrix + overlap gate, never by date alone. It is intentionally left without an approved `MODULE_ROUTE` in fixtures so that the `UNMAPPED_MODULE` exception path is exercised; a real mapping needs finance sign-off.

Journal routing is **only** for `JOURNAL`. Any other type reaching `journal` requires an explicit approved rule with `notes` explaining the reporting effect.

## 6. Cutover matrix input (config/cutover-matrix.json in fixtures)

Array of rows matching `cutover_matrix` table. Fixture pilot branch:

```json
[
  { "branch_code": "PILOT01", "zoho_location_id": "LOC-PILOT01", "migration_from_date": "2026-04-01",
    "live_system_start_date": "2026-06-01", "historical_migration_end_date": "2026-05-31",
    "transaction_class": "*", "payment_method": "*", "smart_pharma_coverage_status": "NOT_COVERED",
    "cutover_rule_version": "cut_v1", "approval_status": "APPROVED", "approved_by": "finance.lead" },
  { "branch_code": "PILOT01", "zoho_location_id": "LOC-PILOT01", "migration_from_date": "2026-04-01",
    "live_system_start_date": "2026-06-01", "historical_migration_end_date": "2026-05-31",
    "transaction_class": "SALES_B2C", "payment_method": "*", "smart_pharma_coverage_status": "COVERED",
    "cutover_rule_version": "cut_v1", "approval_status": "APPROVED", "approved_by": "finance.lead" }
]
```

Resolution order for a voucher: most specific row wins — (class, payment_method) > (class, `*`) > (`*`, `*`). A voucher with no APPROVED row, or whose row has `live_system_start_date` null / `UNKNOWN` coverage → `BLOCKED` with exception `CUTOVER_RULE_MISSING`.

## 7. Smart Pharma evidence input (fixtures/synthetic/.../smart_pharma_postings.json)

Synthetic stand-in for "records Smart Pharma already posted to Books" in the pilot window. Fields: `branch_code, business_date, transaction_class, payment_method, tax_bucket, amount, sp_batch_ref, books_record_id, books_module`. Used by the overlap gate to produce `REFERENCE_MATCH` / `FULL_EVIDENCE` classifications. Absent evidence + `COVERED` rule → `PARTIAL_OR_AMBIGUOUS_OVERLAP` (blocked), never `SMART_PHARMA_ALREADY_POSTED`.

## 8. Fixture set (fixtures/synthetic/branch-PILOT01/run-001)

Designed to exercise every path. Must contain, at minimum:
- ~40 vouchers across all types in §5, dated 2026-04-01..2026-06-05.
- Balanced vouchers that reconcile to `trial_balance.csv` exactly.
- 3 `SALES_B2C` vouchers in April/May with matching Smart Pharma evidence (→ `SMART_PHARMA_ALREADY_POSTED`), 1 in May with **no** evidence (→ `PARTIAL_OR_AMBIGUOUS_OVERLAP`), 1 dated 2026-06-02 (→ outside window, `OTHER_EXCLUDED` reason `AFTER_CUTOVER`).
- 1 `STOCK_ADJ` voucher (→ `OTHER_EXCLUDED`, `INV_CONTROL_ONLY_v1`).
- 1 voucher with `modified_at` after `live_system_start_date` (late-modified → exception `LATE_OR_BACK_POSTED`, `BLOCKED`).
- 1 voucher with a ledger_code absent from the trial balance (→ `ORPHAN_RELATIONSHIP`).
- 1 deliberately unbalanced voucher (→ `UNBALANCED_VOUCHER`).
- 1 duplicate (voucher_id, line_no) row (→ `DUPLICATE_SOURCE`).
- A second manifest/run (`run-002-dup`) whose transactions.csv has the same sha256 as run-001 (→ duplicate file rejection).
- Names/codes are obviously synthetic (`PILOT01`, `LEDG-1001`, `V-PARTY-007`). No real people, companies, GSTINs, or amounts.

Because the bad rows above break the TB tie-out, the fixture TB is computed **excluding** the intentionally corrupt vouchers, and the Layer A run must report exactly those diffs — proving the control catches them.
