# CAPACITY_REVIEW.md — Data volume, platform limits, and posting throughput

Status: **draft, decision-ready — APPROVAL REQUIRED before any real (non-synthetic)
ingestion begins.** This review exists because the only volume data available today is
the synthetic `PILOT01` fixture; every branch/organisation-wide number below is a
scenario built from stated assumptions, not a measurement of real Eco Green data. See
`PROJECT_CONTEXT.md` (open questions, "Source and data") for the confirmed absence of
real row-count figures. Owner: see §8.

Access date for every external citation in this document: **2026-09-15**.

---

## 1. Per-branch-month transaction volume: fixture baseline and scenarios

### 1.1 What the fixture actually shows

`fixtures/synthetic/branch-PILOT01/run-001` (`EXPECTED.md`) is the only concrete data
point in this repository:

- `transactions.csv`: **81 data rows**, spanning `from_date`/`to_date` **2026-04-01 to
  2026-06-05** (manifest dates) — i.e. just over nine weeks, not one calendar month. This
  review follows the task framing of treating 81 lines as a single-branch-month baseline
  (a conservative one, since the real window is ~2.2 months), and flags the discrepancy
  here rather than silently rounding it away.
- Those 81 lines produced **40 vouchers** after grouping (`IMPLEMENTATION_PLAN.md`
  §11: "dispositions MIGRATE 31 / SMART_PHARMA_EXCLUDED 3 / BLOCKED 4 /
  OTHER_EXCLUDED 2 (total 40)") — an observed **lines-to-vouchers ratio of ~2.03**, close
  to but tighter than the 2.5 assumption this review is instructed to use for all
  scenarios below. Where the two disagree, this review states both.
- `trial_balance.csv`: **15 ledger rows** for the branch. Used below as the working
  assumption for chart-of-accounts breadth per branch (§2).

No real Eco Green branch has been profiled for actual monthly volume (`PROJECT_CONTEXT.md`
open question: "What are actual row counts, file sizes, ..."). Everything past this
point is a scenario, not a forecast.

### 1.2 Scenario assumptions (as instructed)

| Scenario | CSV lines / branch-month | Vouchers / branch-month (lines ÷ 2.5) |
|---|---:|---:|
| Low | 500 | 200 |
| Mid | 2,000 | 800 |
| High | 10,000 | 4,000 |

The fixture's own ratio (81 → 40, ÷2.03) would give slightly *more* vouchers per line
than the ÷2.5 assumption; treat the table above as the conservative (fewer-rows) case
and the fixture ratio as a sanity check, not a contradiction.

### 1.3 Historical window cases

Per `PROJECT_CONTEXT.md`, the historical migration window begins **1 April 2026** and
ends the day before each branch's verified live-system start date — June 2026 for some
branches, August 2026 for others, and later for the remainder (phased). This review
therefore treats window length as a per-cohort variable, not one organisation-wide
number, and evaluates three cases:

| Case | Approximate window | Representative cohort |
|---|---|---|
| 2 months | 1 Apr – ~31 May 2026 | Branches going live June 2026 |
| 4 months | 1 Apr – ~31 Jul 2026 | Branches going live August 2026 |
| 6 months | 1 Apr – ~30 Sep 2026 | Later-phased branches |

Each case below is computed **as if applied to all ~351 branches**, i.e. as an upper
and lower planning bound, not a claim that every branch shares one window. A real
blended total (mixed cohorts) would fall between the 2-month and 6-month totals; produce
it once the actual phased cutover matrix (`ARCHITECTURE.md` §3, `branch_period_assignments`)
is populated with real dates.

---

## 2. Total expected rows for ~351 branches, by table family

`EXPECTED_BRANCH_COUNT` = 351 throughout (see `PROJECT_CONTEXT.md`, `ARCHITECTURE.md` §4).
Two families of numbers below scale differently:

- **Volume-linear families** (raw lines, vouchers, exceptions, batches/queue/attempts,
  preview payloads, audit events) scale with `branches × months × per-branch-month volume`.
- **Chart-of-accounts-linear families** (summaries, recon results) scale with
  `branches × months × ledger/voucher-type breadth`, which this review assumes is
  **constant per branch-period regardless of transaction volume** (a bigger branch
  posts more lines against the same ~15 ledgers, it does not usually acquire more
  ledgers) — assumption, not fact; real chart-of-accounts breadth is an open question
  (`PROJECT_CONTEXT.md`).

### 2.1 Volume-linear families — raw lines and vouchers

| Scenario | Months | Branches | Total `source_txn_lines` rows | Total `vouchers` rows |
|---|---:|---:|---:|---:|
| Low | 2 | 351 | 351,000 | 140,400 |
| Low | 4 | 351 | 702,000 | 280,800 |
| Low | 6 | 351 | 1,053,000 | 421,200 |
| Mid | 2 | 351 | 1,404,000 | 561,600 |
| Mid | 4 | 351 | 2,808,000 | 1,123,200 |
| Mid | 6 | 351 | 4,212,000 | 1,684,800 |
| High | 2 | 351 | 7,020,000 | 2,808,000 |
| High | 4 | 351 | 14,040,000 | 5,616,000 |
| High | 6 | 351 | 21,060,000 | 8,424,000 |

### 2.2 Summaries and recon results (chart-of-accounts-linear, assumption-driven)

Working assumption from the fixture: **~15 ledgers/branch**. `summaries` carries one row
per `(ledger, voucher_type)` plus one `(ledger, '*')` aggregate row (§M contract); assume
an average of **2 voucher types observed per ledger in the low scenario and up to 3 in
mid/high** (more transaction variety at higher volume) — i.e. **~45 summary rows per
branch-period** (low) to **~60** (mid/high). `recon_results` carries roughly 4 controls
per ledger (`period_debit`, `period_credit`, `txn_count`, `balance_identity`) plus ~4
file/TB-level controls (§M) — **~64 recon-result rows per branch-period**, treated as
constant across scenarios.

| Scenario | Months | `summaries` total | `recon_results` total |
|---|---:|---:|---:|
| Low | 2 | 45 × 351 × 2 = 31,590 | 64 × 351 × 2 = 44,928 |
| Low | 4 | 63,180 | 89,856 |
| Low | 6 | 94,770 | 134,784 |
| Mid/High | 2 | 60 × 351 × 2 = 42,120 | 44,928 |
| Mid/High | 4 | 84,240 | 89,856 |
| Mid/High | 6 | 126,360 | 134,784 |

### 2.3 Exceptions (2–5% of vouchers, as instructed)

| Scenario | Months | Vouchers | Exceptions @2% | Exceptions @5% |
|---|---:|---:|---:|---:|
| Low | 2 | 140,400 | 2,808 | 7,020 |
| Low | 4 | 280,800 | 5,616 | 14,040 |
| Low | 6 | 421,200 | 8,424 | 21,060 |
| Mid | 2 | 561,600 | 11,232 | 28,080 |
| Mid | 4 | 1,123,200 | 22,464 | 56,160 |
| Mid | 6 | 1,684,800 | 33,696 | 84,240 |
| High | 2 | 2,808,000 | 56,160 | 140,400 |
| High | 4 | 5,616,000 | 112,320 | 280,800 |
| High | 6 | 8,424,000 | 168,480 | 421,200 |

### 2.4 Batches/approvals, queue items/API attempts, preview payloads

Assumptions, cross-checked against the fixture (31/40 = 77.5% `MIGRATE` disposition,
rounded down to **75%** to be conservative; retries assumed **1.1×** queue items):

- `migration_batches`/`approvals` ≈ 1 per branch-period ≈ `branches × months` (more if
  split by transaction class — this is a floor, not a ceiling).
- `queue_items` ≈ `vouchers × 0.75` (MIGRATE-disposition only).
- `api_attempts` ≈ `queue_items × 1.1` (allows for one retry on ~10% of items).
- `preview_payloads` ≈ `queue_items` (generated once per MIGRATE voucher at transform
  time, before batching).

| Scenario | Months | Batches/approvals | `queue_items` | `api_attempts` | `preview_payloads` |
|---|---:|---:|---:|---:|---:|
| Low | 2 | 702 | 105,300 | 115,830 | 105,300 |
| Low | 4 | 1,404 | 210,600 | 231,660 | 210,600 |
| Low | 6 | 2,106 | 315,900 | 347,490 | 315,900 |
| Mid | 2 | 702 | 421,200 | 463,320 | 421,200 |
| Mid | 4 | 1,404 | 842,400 | 926,640 | 842,400 |
| Mid | 6 | 2,106 | 1,263,600 | 1,389,960 | 1,263,600 |
| High | 2 | 702 | 2,106,000 | 2,316,600 | 2,106,000 |
| High | 4 | 1,404 | 4,212,000 | 4,633,200 | 4,212,000 |
| High | 6 | 2,106 | 6,318,000 | 6,949,800 | 6,318,000 |

### 2.5 Audit events (≈3× the number of state changes)

Rough estimate: each voucher passes through roughly 5 auditable state changes end to
end (ingest, classify, transform, enqueue, post outcome), plus batch-level and run-level
transitions that are small relative to per-voucher volume at mid/high scenarios. This
review therefore approximates **audit events ≈ 15 × total vouchers** (5 state changes ×
3). This is explicitly an order-of-magnitude estimate, not a count — it does not include
per-user auth/admin events (§7.2 of `ARCHITECTURE.md`), which are small and volume-independent.

| Scenario | Months | Vouchers | Estimated `audit_events` (≈15×) |
|---|---:|---:|---:|
| Low | 2 | 140,400 | 2,106,000 |
| Low | 4 | 280,800 | 4,212,000 |
| Low | 6 | 421,200 | 6,318,000 |
| Mid | 2 | 561,600 | 8,424,000 |
| Mid | 4 | 1,123,200 | 16,848,000 |
| Mid | 6 | 1,684,800 | 25,272,000 |
| High | 2 | 2,808,000 | 42,120,000 |
| High | 4 | 5,616,000 | 84,240,000 |
| High | 6 | 8,424,000 | 126,360,000 |

Audit events are append-only (`SECURITY.md` §5) and dominate the row count at mid/high
scenarios — this is the strongest single argument for the Stratus/Data Store split in §4.

### 2.6 Preview payloads text size

`preview_payloads` stores a serialized Books-shaped payload per voucher. The Data Store
`text` column cap is **10,000 characters** (§3). A multi-line-item bill/journal payload
for a large voucher could approach this in the high scenario; this review does not have
a real payload-size sample and flags it as an **open risk**, not a measured fact —
verify against real transformed payloads before high-volume ingestion.

---

## 3. Catalyst platform limits

### 3.1 Development environment (as used by this pilot today)

Re-verified 2026-09-15 against
<https://docs.catalyst.zoho.com/en/faq/cloud-scale/> (ZCQL 300-row cap, 100
columns/table, `text` 10,000-character cap all reconfirmed verbatim on this date). The
**5,000 rows/table, 25,000 rows/project** Development quota and the **30-select-column**
ZCQL cap are carried forward from `docs/CATALYST_REFERENCES.md` (accessed 2026-09-14,
the 30-column cap observed live rather than documented) — the 2026-09-15 re-fetch of the
FAQ page did not re-surface that specific line in the returned extract (likely a
collapsed FAQ item the automated fetch did not expand), so this review treats it as
carried, not independently re-confirmed today.

| Limit | Value | Source |
|---|---|---|
| Rows per table (Development) | 5,000 | `docs/CATALYST_REFERENCES.md` (2026-09-14); not re-confirmed 2026-09-15 |
| Rows per project (Development) | 25,000 | same |
| ZCQL rows per query | 300 | <https://docs.catalyst.zoho.com/en/cloud-scale/help/zcql/syntax-exceptions/> (2026-09-14); reconfirmed via FAQ page 2026-09-15 |
| ZCQL SELECT columns per query | 30 | observed live, `docs/CATALYST_REFERENCES.md` (2026-09-15) |
| Columns per table | 100 | <https://docs.catalyst.zoho.com/en/cloud-scale/help/data-store/tables/> (2026-09-14); reconfirmed via FAQ page 2026-09-15 |
| `text` column character cap | 10,000 | reconfirmed via FAQ page 2026-09-15 |
| Cache value length | 16,000 characters | FAQ page, 2026-09-15 |
| Catalyst Authentication app users (Development) | 25 max; 0 at project start | `docs/CATALYST_AUTH.md` §2 (local skill reference, 2026-09-15) — no cap stated for Production |

**Every scenario in §2 vastly exceeds the Development 5,000-row/table and 25,000-row/project
quotas** except the synthetic/dev-seed rows deliberately capped at `EXPECTED_BRANCH_COUNT`.
Real ingestion at any of the low/mid/high scenarios is **not possible in a Catalyst
Development environment** — this is a hard platform constraint, not a design choice, and
is the primary reason production posting requires a Production (paid) Catalyst project.

### 3.2 Production / pay-as-you-go plan limits

Researched 2026-09-15 against <https://catalyst.zoho.com/pricing.html> (redirected from
`www.zoho.com/catalyst/pricing.html`). **Official Catalyst pricing documentation does not
publish a maximum stored-row-count or GB storage cap per Data Store table/project for
paid plans** — unlike Development's fixed 5,000/25,000 quota, paid tiers are metered by
*usage* (API/SDK calls, GB-seconds, GB transferred), not by a hard stored-row ceiling.
The published Lite-tier monthly allowances (higher tiers "scale these limits
proportionally" per the same page; Enterprise is custom/negotiated):

| Metered quantity | Lite plan monthly allowance | Notes |
|---|---|---|
| Data Store SELECT rows | up to 0.175 Mn (175,000) | a **read-operation** quota (rows returned by SELECT), not a stored-row cap |
| AppSail | up to 131.25 GB-seconds | compute usage, relevant to worker/API hosting under load |
| Stratus (uploads + downloads) | up to 26.25 Mn (operations, not GB — page does not state a GB figure) | |
| Functions | up to 0.65625 Mn GB-seconds | |
| Webclient hosting calls | up to 26.25 Mn | |

**Explicit gaps in what the docs state** (do not guess past these):

- No published maximum number of rows a Production Data Store table or project may
  *hold* (only read-quota metering).
- No published maximum object size or per-project bucket count for Stratus (also noted
  as open in `docs/CATALYST_REFERENCES.md`).
- No published AppSail maximum instance count or per-instance memory/CPU ceiling beyond
  the `app-config.json`-selected stack size already used in this repo (`DEPLOYMENT.md` §4c).
- ZCQL's 300-row/30-column caps are **not** stated as Development-only anywhere found;
  this review treats them as applying in Production too (they are query-shape limits,
  not quota limits) — the dashboard design in `ARCHITECTURE.md` §7.1 already assumes
  this.

**Implication for the scenario totals in §2:** at mid/high scenarios (hundreds of
thousands to tens of millions of rows across `source_txn_lines`, `vouchers`,
`audit_events`, etc.), the binding constraint in Production is very likely **cost**
(row-read/write and storage billing) rather than a hard rejection, but this cannot be
confirmed from published limits alone — get a quote/plan recommendation from Zoho/Catalyst
sales before committing to the mid or high scenario at ~351-branch scale. This is listed
as an open decision in §8.

### 3.3 What this means for the pilot's own schema (25 tables)

The 25-table schema (`src/adapters/store/schema.sql`, 20 original + 5 increment-2 —
`ARCHITECTURE.md` §4/§7) already respects the *shape* limits (≤100 columns/table,
`branch_summaries` deliberately kept to 27 columns to stay ≤30 for ZCQL SELECT); the
open question is purely the *volume* limits in §3.1/§3.2 for real data, not the schema
design.

---

## 4. Placement decision: Stratus vs Data Store

### 4.1 What stays in Stratus

- **Already there:** immutable raw CSV/manifest files, control-query files, and
  generated reconciliation evidence (`ARCHITECTURE.md` §2, `src/adapters/archive/`).
- **New for this review:** line-level detail and per-run derived artefacts —
  `source_txn_lines` and `vouchers` payload detail — move to Stratus as **content-addressed
  JSONL/CSV objects, one object per extraction run**, referenced by URI from a Data Store
  index row. This is the only placement that keeps Data Store within the row budgets in
  §2 vs. §3 at mid/high scenarios: the high-6-month scenario's 21M `source_txn_lines`
  rows and 8.4M `vouchers` rows are Stratus objects (a few thousand *run* objects, not
  millions of Data Store rows), not Data Store rows.

### 4.2 What stays in Data Store

- `branch_summaries` (≤351 rows, §2.2 analogue at dashboard grain — see `ARCHITECTURE.md` §7.1)
- Per-period summaries and recon results (§2.2 — chart-of-accounts-linear, not
  transaction-volume-linear, so these stay comfortably small: even the high-6-month case
  is ~126,000 `summaries` + ~135,000 `recon_results` rows total across all 351 branches)
- Exceptions, mapping rules, the cutover matrix, batches/approvals/queue items
- Lineage/audit *index* — see §4.3 for the audit-event volume problem specifically
- `branch_period_assignments`, `app_users`, `books_connections`, `books_locations`
  (increment 2, `ARCHITECTURE.md` §7)

### 4.3 The audit-event problem specifically

§2.5's audit-event estimate (up to ~126 million rows in the high-6-month case) would
alone blow through any per-project row budget by two to three orders of magnitude.
Recommendation: **audit events for per-voucher/per-line-level state changes are batched
into a Stratus-stored audit log object per run** (append-only JSONL, one object per
`extraction_run_id`, hash-chained for tamper-evidence), with **one Data Store
`audit_events` row per run/batch-level milestone** (not per voucher) acting as the
index/pointer. **Branch/user/admin-level audit events** (approvals, connection changes,
assignment changes, login events) stay as individual Data Store rows as designed today —
their volume is small and independent of transaction volume. This is a design
**recommendation from this review**, not yet reflected in `src/core/audit.js`; flag as a
decision for the owner (§8) since it changes an already-implemented append-only
invariant (`SECURITY.md` §5) and needs its own tamper-evidence proof before adoption.

### 4.4 Resulting Data Store row projections vs. limits

Using the placement above (line/voucher detail in Stratus; summaries, recon, exceptions,
batches/queue, run-level audit index, and increment-2 tables in Data Store):

| Scenario | Months | Data Store rows (summaries+recon+exceptions@5%+batches+queue+preview+audit-index) | Fits Development (25,000/project)? | Fits Production? |
|---|---:|---:|---|---|
| Low | 2 | ~31,590+44,928+7,020+702+105,300+105,300+~1,000(run index) ≈ 295,840 | No | Yes, cost TBD (§3.2) |
| Mid | 4 | ~84,240+89,856+56,160+1,404+842,400+842,400+~2,000 ≈ 1,918,460 | No | Yes, cost TBD |
| High | 6 | ~126,360+134,784+421,200+2,106+6,318,000+6,318,000+~3,000 ≈ 13,323,450 | No | Cost/plan review required (§8) |

**Every scenario exceeds the Development 25,000-row/project quota** even after moving
line/voucher detail to Stratus, once `queue_items`/`preview_payloads` are included at
mid/high volume — Development remains viable only for the pilot's current single-branch,
short-window synthetic testing, never for a real multi-branch or multi-month run. A
Production Catalyst project is required before any scenario above "Low/2-month" can be
attempted for real, and the High scenario specifically needs a capacity/cost
conversation with Zoho before committing (§3.2, §8).

### 4.5 Pipeline module implications

- `src/core/ingest.js` (§V) gains a Stratus-object-write step for `source_txn_lines`
  instead of (or in addition to, during transition) individual Data Store row inserts;
  the Data Store side keeps a per-run index row (file/run metadata, counts, totals —
  already close to what `extraction_runs`/`source_files` store today).
- Layer A/B (`src/core/recon_a.js`, `src/core/bridge.js`, §M/§K) are computed **from
  summaries**, not from re-reading every line — this is already true today; no change
  needed beyond ensuring summaries remain the reconciliation source of truth as line
  detail moves to Stratus.
- Drilldown (console "every number links to its drilldown endpoint", `CONTRACTS.md` §H)
  reads the relevant Stratus object **on demand** when a user opens a specific voucher's
  detail, rather than the API returning line-level data from a Data Store query. This
  changes `GET /api/vouchers/:id` (§H) to fetch from Stratus using the URI stored in the
  Data Store `vouchers`/index row — an implementation change flagged here, not yet made.

---

## 5. Archival, retention, and purge strategy

### 5.1 Never purged

- `audit_events` (or its Stratus-backed successor per §4.3) — append-only by design
  (`SECURITY.md` §5); no purge path exists or should exist.
- Extraction manifests and original CSVs in Stratus (`ARCHITECTURE.md` §2) — the
  immutable evidence trail.
- `approvals` rows and their `scope_hash` history — required to prove what was approved
  and by whom, for the life of the engagement plus whatever statutory retention period
  Finance specifies (open decision, §8).

### 5.2 Time-boxed purge candidates

- `preview_payloads` and `api_attempts` — proposed retention: **90 days after the owning
  batch reaches a terminal state** (`SIGNED_OFF`, `REJECTED`), then purge the payload
  body (keep the `payload_hash` for lineage) rather than the whole row, so drilldown
  links do not 404 silently. Exact period is an open decision (§8), not yet approved.
- Dev-seed synthetic rows (`is_synthetic=1` on `branch_summaries`/`books_locations`, or
  the `[SYNTHETIC DEMO]`-tagged approvals from `DEPLOYMENT.md` §4c) — purged entirely on
  the Development-reset procedure below, never mixed into a Production purge cycle.

### 5.3 Archival of completed branch-periods

Once a branch-period reaches `SIGNED_OFF` (`PROJECT_CONTEXT.md` state model), its
summaries/recon-results/exceptions rows move from "live Data Store" to a Stratus-archived
JSON snapshot (one object per branch-period), leaving only a small index row
(`branch_code`, `period`, `signed_off_at`, `archive_uri`) in Data Store. This keeps the
live `branch_summaries`/dashboard-adjacent tables bounded by *in-flight* work rather than
growing unboundedly as more branch-periods finish — directly protects the Development
25,000-row/project quota during the pilot and reduces Production storage cost afterward.

### 5.4 Development-reset procedure (synthetic data only)

1. Confirm no Development row is anything but synthetic (`is_synthetic=1` or the
   `[SYNTHETIC DEMO]` approval tag) — never run this against a Production project.
2. Truncate the 25 tables via Catalyst console/CLI table-truncate, or delete and
   recreate from `schema.sql`'s generated column bodies (`DEPLOYMENT.md` §4d).
3. Clear the Stratus Development bucket's synthetic prefixes (`SMOKE01/`, `PILOT01/`,
   etc. — `IMPLEMENTATION_PLAN.md`'s 2026-09-15 Stratus entry names the exact prefixes in
   use today); never delete evidence prefixes without owner instruction
   (`IMPLEMENTATION_PLAN.md` explicitly says "delete only on owner instruction" for the
   Stratus smoke objects).
4. Re-run `npm run fixtures:seed` / `POST /api/dev/seed` / `POST /api/dev/seed-branches`
   to repopulate a clean synthetic baseline.

---

## 6. Server-side pagination strategy

- **ZCQL page size:** 300 rows/query, 30 selected columns/query (§3.1) — every list
  endpoint in `CONTRACTS.md` §H/§D paginates server-side using these as the underlying
  page size, never exposing them directly to the client as a page-size *choice*.
- **Keyset vs offset:** for the dashboard's `branch_summaries` table (≤351 rows total),
  simple offset pagination across ≤2 ZCQL pages is sufficient (§2 of `ARCHITECTURE.md`
  §7.1) — no keyset needed at this scale. For transactional tables at mid/high scenario
  volume (`vouchers`, `queue_items`, `api_attempts` — potentially millions of rows, §2),
  offset pagination degrades badly past a few hundred thousand rows; those list routes
  (`GET /api/vouchers?...`, `GET /api/batches/:id`'s queue listing) must use **keyset
  pagination** (`WHERE (created_at, id) > (?, ?) ORDER BY created_at, id LIMIT 300`) once
  real volume exceeds Development-testing scale.
- **Dashboard pattern (already the design, `ARCHITECTURE.md` §7.1):** summary table ≤~351
  rows, fetched server-side in ≤2 ZCQL pages, filtered/sorted/paginated entirely in
  `src/core/branch_list.js`, and only one page of the *final* result returned to the
  browser. CSV export follows the same filter/sort but streams the full result set
  server-side rather than paging.
- **Hard rule:** never list a transactional table (`source_txn_lines`, `vouchers`,
  `queue_items`, `api_attempts`, `audit_events`) without a `branch_code` **and** `period`
  predicate (or, once §4.1 lands, a `run_id` predicate resolving to a Stratus object).
  An unscoped list against any of these tables at mid/high scenario volume would exceed
  the 300-row ZCQL cap by three to five orders of magnitude and must be rejected at the
  route layer, not merely be slow.

---

## 7. Organisation-wide Zoho Books API throughput

### 7.1 Official limits (researched 2026-09-15)

Source: <https://www.zoho.com/books/api/v3/introduction/> (rate-limits section),
cross-checked with a second fetch of the same page on the same date for consistency, and
independently corroborated by `docs/ZOHO_BOOKS_API_REFERENCES.md` §"Rate limits" (same
source page, verified the same day by the concurrent Books-API-references workstream,
which additionally notes the Zoho error codes on violation: 45 daily, 44 per-minute,
1070 concurrency — not reproduced in full here, see that file).

| Limit | Value |
|---|---|
| Daily API calls — Free plan | 1,000 requests/day |
| Daily API calls — Standard plan | 2,000 requests/day |
| Daily API calls — Professional plan | 5,000 requests/day |
| Daily API calls — Premium/Elite/Ultimate plans | 10,000 requests/day |
| Per-minute limit (all plans) | 100 requests/minute per organisation |
| Concurrent calls — Free plan | 5 |
| Concurrent calls — paid plans | 10 (soft limit) |
| Over-limit response | HTTP 429 (daily/per-minute), HTTP 429 code 1070 (concurrency) |

The confirmed Books plan for the real Eco Green organisation is an **open decision**
(`IMPLEMENTATION_PLAN.md` D-7: "Confirmed Books plan, org ID(s) for pilot, API limits,
and enabled locations"). This review computes against the **10,000/day** ceiling (the
best case, Premium/Elite/Ultimate) as the working assumption, and separately against
5,000/day (Professional) since D-7 is unresolved — both are shown below.

### 7.2 Posting-days estimate

Per the task's own formula: **one API call per voucher to post, plus reconciliation
reads ≈ +30%** → total calls ≈ `vouchers_to_post × 1.3`. All ~351 branches share **one**
Books organisation and therefore **one** daily quota (`PROJECT_CONTEXT.md`: "all
locations share one Books organisation's limits").

Using the §2.4 `queue_items` figures (MIGRATE-disposition vouchers only — 75% of total
vouchers) as `vouchers_to_post`:

| Scenario | Months | `vouchers_to_post` | Total calls (×1.3) | Days @10,000/day | Days @5,000/day |
|---|---:|---:|---:|---:|---:|
| Low | 2 | 105,300 | 136,890 | 14 | 27 |
| Low | 4 | 210,600 | 273,780 | 28 | 55 |
| Low | 6 | 315,900 | 410,670 | 42 | 83 |
| Mid | 2 | 421,200 | 547,560 | 55 | 110 |
| Mid | 4 | 842,400 | 1,095,120 | 110 | 219 |
| Mid | 6 | 1,263,600 | 1,643,280 | 165 | 329 |
| High | 2 | 2,106,000 | 2,737,800 | 274 | 548 |
| High | 4 | 4,212,000 | 5,475,600 | 548 | 1,096 |
| High | 6 | 6,318,000 | 8,213,400 | 822 | 1,644 |

(Days rounded up; assumes the *entire* daily quota is dedicated to migration traffic,
which §7.3 explains is unrealistic in practice.)

### 7.3 Implication for the cutover schedule

- Even the **Low/2-month** case needs ~2 working weeks of dedicated, uninterrupted
  organisation-wide API quota to post — and that quota is shared with Smart Pharma's
  live daily posting and any concurrent manual Books activity
  (`PROJECT_CONTEXT.md`: "Books throughput: all locations share one Books organisation's
  limits"). Migration traffic cannot realistically consume 100% of the daily quota.
- The **Mid** scenario (110–329 days depending on window/plan) already exceeds a single
  quarter; the **High** scenario (1.5–4.5 *years* at full quota dedication) is not
  achievable under the current one-organisation-shared-quota model at any published plan
  tier — this is the single most important capacity finding in this review. If real
  per-branch volume is closer to High than Low, either the Books plan/quota needs
  contractual negotiation with Zoho beyond the published tiers, or the organisation-wide
  constraint itself needs revisiting (e.g. multiple orgs — out of scope per
  `PROJECT_CONTEXT.md`'s "one live Zoho Books organisation" target) before a cutover
  schedule can be committed.
- **What the migration limiter must be configured to:** per `src/books/limiter.js`
  (`CONTRACTS.md` §Z, ported Tally-tool sliding-window limiter), set
  `BOOKS_RATE_LIMIT_PER_MINUTE` comfortably under the 100/minute ceiling (the
  `.env.example` default of 100 already matches the *account* ceiling exactly and should
  be lowered — e.g. to 60–70/minute — to leave headroom for Smart Pharma/manual traffic
  sharing the same organisation) and set a **daily** budget (not currently a configured
  limiter dimension — `src/books/limiter.js` is a sliding window, not a daily counter;
  this is a gap to close before any real posting run) at a fraction of the confirmed
  plan's daily cap, reserving the remainder for Smart Pharma and manual use. `BOOKS_MAX_CONCURRENCY`
  (`.env.example` default 2) already sits safely under the 5–10 concurrent-call ceiling.
- Cutover should be **phased by branch cohort** (matching the 2/4/6-month windows in
  §1.3) rather than attempting all ~351 branches simultaneously, both because that
  matches the real phased live-start dates and because it keeps daily Books API
  consumption within a sustainable fraction of the shared organisation quota.

---

## 8. Open decisions for the owner — APPROVAL REQUIRED before real ingestion

1. **Which scenario (Low/Mid/High) reflects real Eco Green volume?** Nothing in this
   repository can answer this — it requires actual branch-level row counts from the Eco
   Green team (`PROJECT_CONTEXT.md` D-4/open questions).
2. **Confirmed Zoho Books plan and org ID** (`IMPLEMENTATION_PLAN.md` D-7) — directly
   changes the §7 posting-days estimate by 2×.
3. **Catalyst plan upgrade path** — Development cannot hold any real scenario (§3.1,
   §4.4); a Production/paid Catalyst project and, likely, a conversation with
   Zoho/Catalyst sales about actual capacity at Mid/High volume (§3.2, since published
   docs do not state a stored-row ceiling for paid plans) must happen before real
   ingestion.
4. **Retention periods** for `preview_payloads`/`api_attempts` purge (§5.2) and for
   archived branch-periods (§5.3) — proposed 90 days is this review's suggestion, not an
   approved policy.
5. **Per-branch prioritisation** for phased cutover (§7.3) — which branches/cohorts post
   first, and whether the 2/4/6-month cohort split in §1.3 matches the real cutover
   matrix once populated.
6. **Audit-event placement change** (§4.3, Stratus-backed batched audit log with a
   per-run/per-milestone Data Store index) — this changes an already-implemented
   append-only design (`SECURITY.md` §5) and needs explicit sign-off before
   `src/core/audit.js` is altered.
7. **Migration limiter's daily-budget dimension** (§7.3) — `src/books/limiter.js`
   currently has no daily counter; adding one, and deciding what fraction of the
   organisation's daily quota migration traffic may consume, needs an explicit decision
   before any live posting run.

**No real (non-synthetic) ingestion, and no live Books posting of any volume, should
begin until decisions 1–3 above are resolved and this review (or its successor once real
volume is known) is explicitly approved by the Project owner and Finance lead — the same
authorization gate already required for production posting in `DEPLOYMENT.md` §5.**
