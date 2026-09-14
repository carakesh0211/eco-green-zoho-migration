# RECONCILIATION.md — Three-Way Reconciliation and Live Balance Bridge

Status: **in progress (wave 1)**. Implements `CONTRACTS.md` §M (Layer A), §K (Layer B),
§Y (Layer C and balance bridge). No real Eco Green control reports or live Books
baseline have been captured; all worked examples below refer to the synthetic fixture
in `DATA_CONTRACT.md` §8.

## 1. Why the live Books trial balance can never be compared directly to the migration CSV

Zoho Books is already live for the target organisation. Some branches have Smart
Pharma/new-system activity from June 2026, some from August 2026, others as phased in
(`PROJECT_CONTEXT.md`). The full live trial balance therefore always contains
migration-created movement **plus** concurrent Smart Pharma movement **plus** any
authorized manual movement. Comparing that combined balance to a CSV representing only
the historical Eco Green population would always show a difference that is not a
migration defect. Reconciliation instead isolates the migration-created population
using stable identifiers (the migration tag on every posted payload) and bridges the
remainder explicitly (§5).

## 2. Layer A — Eco Green trial balance vs transactional CSV (`recon_a.js`)

Compares independent Eco Green control totals against the CSV actually received and
staged, **not** against a re-summation of itself. Control keys (one `recon_results` row
each):

| `control_key` | Compares |
|---|---|
| `file:row_count` | Manifest-declared row count vs actual staged rows |
| `file:debit_total` / `file:credit_total` | Manifest-declared totals vs actual computed totals |
| `ledger:<code>:period_debit` / `period_credit` | Trial-balance file's period movement vs summarized CSV movement for that ledger |
| `ledger:<code>:txn_count` | Trial-balance `txn_count` vs distinct `voucher_id` count touching that ledger |
| `ledger:<code>:balance_identity` | `opening + period − closing = 0`, checked within the trial balance file itself |
| `tb:total_debit_equals_credit` | Trial balance file's own debit/credit totals tie out |
| `ledger:<code>:missing_in_tb` / `missing_in_csv` | A ledger present in one file but not the other |

Status is `PASS` only with zero `DIFF` and zero `MISSING` results. Otherwise `FAIL`, the
run moves to `SOURCE_RECON_FAILED`, and every failing ledger raises a
`RECONCILIATION_DIFFERENCE` exception (P1) carrying its financial impact. Unexplained
differences block migration entirely (`PROJECT_CONTEXT.md`).

## 3. Layer B — CSV vs approved migration population (`bridge.js`)

Proves a complete count and amount bridge, per `CONTRACTS.md` §K:

```text
Extracted CSV population
  = MIGRATE
  + SMART_PHARMA_EXCLUDED
  + OTHER_EXCLUDED
  + BLOCKED
```

Control keys: `bridge:count`, `bridge:debit`, `bridge:credit`, plus a subtotal control
per disposition with voucher-id drilldown. The bridge fails if any voucher is still
`PENDING` (classification incomplete) or if the sums do not tie exactly. Nothing may
disappear silently — every exclusion carries its rule version, reason, and evidence in
`overlap_candidates`/`vouchers.disposition_evidence_json`.

## 4. Layer C — approved migration population vs Books (`recon_c.js`)

Compares the approved (queued) population against `client.searchByMigrationTag` results
by module: count/amount controls, plus a per-item classification of present, missing,
duplicate (more than one target record with the same tag), unexpected (a tagged record
with no matching queue item), or partial. Only records carrying the stable
`cf_migration_source_hash` tag count as "the migration population" — the isolation
mechanism that lets Layer C run against a live organisation without confusion from
Smart Pharma or manual activity.

## 5. Live Books balance bridge (`balance_bridge.js`)

Per account, per branch, per migration window:

```text
Books balance before migration (BASELINE snapshot)
  + migration-created movement       (from POSTED queue items, this batch)
  + Smart Pharma/live movement       (SP-tagged records in the window)
  + authorized manual movement       (untagged records in the window, must be
                                       explicitly listed as authorized —
                                       otherwise "unexplained")
  = Books balance after migration    (POST_RUN snapshot)
```

`books_snapshots` stores both the `BASELINE` and `POST_RUN` snapshot per branch/batch,
each with a `snapshot_hash`. Any movement that cannot be attributed to one of the three
named sources is `unexplained` and fails the bridge with a `TARGET_MISMATCH` exception
(P1) — this is a hard block on sign-off, not a warning.

## 6. Tolerance policy

Default tolerance is `0.00` (exact match) at every layer. Any non-zero tolerance is a
finance-approved configuration value, recorded on the specific `recon_runs` row that
used it (`tolerance` column) — never a silent global relaxation. No non-zero tolerance
has been approved for this pilot; exact financial tolerances remain an open decision
(`PROJECT_CONTEXT.md`, `IMPLEMENTATION_PLAN.md` D-6).

## 7. `PASS_WITH_APPROVED_EXCEPTIONS`

A reconciliation run may report `PASS_WITH_APPROVED_EXCEPTIONS` instead of `FAIL` only
when **every** `DIFF` result on that run has a corresponding `exceptions` row with
`status = 'APPROVED_EXCEPTION'` whose `dedupe_key` references that exact
`recon:<runId>:<control_key>`. This requires an approver/admin-role decision per
exception (`src/core/exceptions.js#resolve`) — it is never granted automatically by
passing technical checks (`PROJECT_CONTEXT.md`: "Automatic approval of financial
batches solely because technical checks passed" is explicitly out of scope).

## 8. Drilldown hierarchy

```text
Organisation
  -> branch/location
    -> financial year/period
      -> reconciliation control or module
        -> ledger/voucher type
          -> document/voucher
            -> source line, transformed payload, API attempt, target record
```

Every number shown in the console links to the drilldown endpoint that produced it
(`CONTRACTS.md` §H); `recon_results.detail_json` and `overlap_candidates.evidence_json`
carry the voucher/line/target IDs needed to walk from an aggregate down to a single
source row. Every dashboard total must be reproducible from stored detail and tied to a
specific extraction, mapping, transformation, and reconciliation version
(`PROJECT_CONTEXT.md`).
