# SMART_PHARMA_OVERLAP.md — Cutover Matrix and Overlap Specification

Status: **in progress (wave 1) / largely OPEN pending vendor input**. Smart Pharma is
the new WMS/POS, already integrated with Zoho Books, posting summarized inventory-related
B2C data by date and payment/receipt method (`PROJECT_CONTEXT.md`). No Smart Pharma
interface facts, go-live dates, or real evidence feed have been received; the fixture
evidence in `DATA_CONTRACT.md` §7 is entirely synthetic.

## 1. Cutover matrix semantics (`cutover_matrix` table, `src/core/cutover.js`)

Each row scopes a branch, transaction class, and payment method to a migration window
and a Smart Pharma coverage status:

```text
branch_code | zoho_location_id | migration_from_date | live_system_start_date
historical_migration_end_date | transaction_class | payment_method
smart_pharma_coverage_status | cutover_rule_version | approval_status | approved_by
```

`transaction_class` and `payment_method` may be `'*'` (wildcard) or a specific value.
`smart_pharma_coverage_status` is one of `COVERED`, `NOT_COVERED`, `PARTIAL`, `UNKNOWN`.
Only rows with `approval_status = APPROVED` are resolvable — a `DRAFT` row is inert.

## 2. Resolution order

`resolveCutover` picks the **most specific** approved row for a voucher's
`(branchCode, voucherType, paymentMethod)`:

1. `(class, payment_method)` exact match
2. `(class, '*')`
3. `('*', '*')`

A voucher matching no approved row at all resolves to `null` — evaluated as
`CUTOVER_RULE_MISSING` (see §3), always blocking.

## 3. Eligibility reasons (`evaluateEligibility`)

| Reason | Meaning |
|---|---|
| `IN_WINDOW` | `migration_from_date ≤ transaction_date < live_system_start_date` |
| `BEFORE_MIGRATION_FROM` | Transaction predates the agreed migration start |
| `AFTER_CUTOVER` | Transaction date is at or after the verified live-system start date |
| `RULE_MISSING` | No approved cutover row resolved for this voucher |
| `LIVE_START_UNVERIFIED` | Row resolved but `live_system_start_date` is null |
| `LATE_OR_BACK_POSTED` | `source_modified_at` date ≥ `live_system_start_date` — the source row was touched after the branch went live, so its true business date is suspect |

Default eligibility rule, per `PROJECT_CONTEXT.md`:
`transaction_date >= 2026-04-01 and transaction_date < verified live_system_start_date`.
Date alone is never sufficient — class, payment method, and Smart Pharma coverage
status all narrow eligibility further via the matrix row that actually resolves.

## 4. Overlap classifications and evidence strength (`classifyOverlap`)

| Coverage rule | Evidence | Classification | Match strength |
|---|---|---|---|
| `NOT_COVERED` | n/a | `NOT_APPLICABLE` | — |
| `COVERED` or `PARTIAL` | Full match on branch, date, class, payment method, tax bucket, amount, **and** a stable `sp_batch_ref` or `books_record_id` | `SMART_PHARMA_ALREADY_POSTED` | `FULL_EVIDENCE` |
| `COVERED` or `PARTIAL` | Match on the stable reference alone (no full field match) | `SMART_PHARMA_ALREADY_POSTED` | `REFERENCE_MATCH` |
| `COVERED` or `PARTIAL` | No evidence, or evidence matching only amount and/or only date | `PARTIAL_OR_AMBIGUOUS_OVERLAP` | `DATE_ONLY` / `NONE` (never treated as a match) |
| `UNKNOWN` | any | `PARTIAL_OR_AMBIGUOUS_OVERLAP` | — |

Amount-only or date-only matches **never** count as overlap evidence
(`PROJECT_CONTEXT.md`, `CONTRACTS.md` §K) — they downgrade to
`PARTIAL_OR_AMBIGUOUS_OVERLAP`, which blocks.

## 5. What blocks

- `PARTIAL_OR_AMBIGUOUS_OVERLAP` → voucher `BLOCKED`, exception
  `SMART_PHARMA_OVERLAP` (P1).
- `CUTOVER_RULE_MISSING` (no resolvable approved row) → voucher `BLOCKED`, exception
  `CUTOVER_RULE_MISSING` (P1).
- `LATE_OR_BACK_POSTED` → voucher `BLOCKED`, exception `LATE_OR_BACK_POSTED` (P1).
- Missing `MODULE_ROUTE` mapping for an otherwise-eligible voucher type (e.g. the
  fixture's deliberately unmapped `SALES_B2C`) → voucher `BLOCKED`, exception
  `UNMAPPED_MODULE` (P1).
- `STOCK_ADJ` (inventory adjustment) is never a posting candidate: it resolves directly
  to `OTHER_EXCLUDED`, reason `INV_CONTROL_ONLY_v1`, audit-only, no exception —
  inventory movements may be retained for historical control validation but must never
  become a target posting population (`PROJECT_CONTEXT.md`).
- `SMART_PHARMA_ALREADY_POSTED` is an **exclusion**, not a block: the voucher is
  correctly kept out of migration and is accounted for in the Layer B bridge
  (`RECONCILIATION.md`), with the matching evidence retained for audit.

Every disposition and its evidence are retained in `overlap_candidates` — bulk
overrides are prohibited unless rule-based, previewed, scoped, approved, and
auditable (`PROJECT_CONTEXT.md`).

## 6. Evidence required from Smart Pharma vendor (OPEN — from `PROJECT_CONTEXT.md`)

None of the following has been supplied:

- The verified Smart Pharma go-live date for each of the ~326 branches.
- Exactly what is posted to Books: which modules, aggregation grain, tax detail,
  payment methods, references, and correction/reversal behavior.
- Whether Smart Pharma back-posts or updates historical dates.
- Which Books fields reliably identify a Smart Pharma-originated record
  (`sp_batch_ref`, a custom field, a contact/reference pattern, or something else).
- How partial-day, partial-branch, late, reversed, or corrected overlaps should be
  handled.
- Who signs off the overlap/exclusion rules and tolerances (see §7).

Until supplied, every real `SALES_B2C` voucher resolves through the `UNKNOWN` or
evidence-absent paths above and is blocked or excluded conservatively — never migrated
on an assumption.

## 7. Sign-off owner

Per `PROJECT_CONTEXT.md`, overlap/exclusion rule and tolerance sign-off sits with
Finance, informed by Smart Pharma vendor facts. Named-owner placeholder: **Finance
lead**, with required input from **Smart Pharma vendor**. No sign-off has occurred; the
cutover matrix in fixtures is synthetic and `APPROVED` only for demonstration purposes,
never as a stand-in for a real approval.
