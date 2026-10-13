# Eco Green Ledger Extraction — Optimisation Plan

| Item | Detail |
|---|---|
| Scope | Accounting extraction from Eco Green for ~350 stores, FY code `c_year = 26` (period from 1 Apr 2026), for migration to Zoho Books |
| Status | Recommendation, ready for DBA review and pilot. Nothing has been run against the real Eco Green database yet |
| Inputs reviewed | The current per-store extraction query (ledger + `act_mst` + five remark sources), `PROJECT_CONTEXT.md`, `DATA_CONTRACT.md`, `RECONCILIATION.md` |
| SQL pack | `docs/extraction-sql/` (§10). Checked on a synthetic dataset in DuckDB only (§7.1) |

---

## 1. Executive summary

**Root cause.** The current process runs one query per store, so it runs **350 times**. On every run, the remark subquery reads and groups the **whole year of all five detail tables for all stores**, because it filters only on `c_year = 26`. After that, the result is reduced to one store. Across 350 runs, that means about 350 full-year reads of the detail tables to produce data that a single read could provide. The account joins also wrap both sides in `CONVERT()`, which stops the database from using an index.

**Recommendation: extract once, join in staging.**

1. Pull each source table **once for all stores**, with only the columns needed and **no joins on the Eco Green server**:
   - ledger
   - the five remark sources
   - the account master
   - the payment and receipt tagging tables
2. Load these into the migration staging database. Do the joins there once, then split the output into the per-store files required by `DATA_CONTRACT.md`.
3. Run against a **restored backup copy** of the Eco Green database, not production. This gives a fixed point-in-time snapshot, has no effect on store operations, and lets us add indexes freely.
4. Export with the database engine's **native bulk-unload tool**, written directly to compressed CSV. Do not export through a GUI result grid or Excel.
5. Every step has a control check: unique keys, no row multiplication from joins, totals by store/account/flag matching the source, and a tie-out to the Trial Balance.

**Expected effect.** Detail-table reads drop from about 350 per migration to one per table. The work done on the Eco Green server becomes a few simple read-only queries without joins. The pilot (§7) measures the actual improvement against a baseline before any rollout decision.

> **Engine conflict — please confirm.** `PROJECT_CONTEXT.md` says the source is MySQL. The current query cannot run on MySQL as written: MySQL does not support `'''' + convert(varchar(50), …)` or the `dba.` owner prefix used here. That syntax matches **SAP SQL Anywhere (Sybase)** or **Microsoft SQL Server**. This plan does not depend on the engine. All extraction SQL is written in standard SQL, and the only engine-specific step is the export command (§4.4).

---

## 2. Diagnosis of the current query

| # | Finding | Performance impact | Accuracy risk |
|---|---|---|---|
| F1 | Remark subquery is filtered only by `c_year`, not by store or date. All five detail tables are read and grouped for all stores on every run | **Very high.** Main cost, repeated 350× | — |
| F2 | Account joins use `convert(varchar(50), …)` on **both** sides | High. The `act_mst.c_code` index cannot be used | — |
| F3 | The same unchanging account master is joined twice on every one of the 350 runs | Medium | — |
| F4 | `MAX(c_remark)` keeps one remark per document and silently drops the others | — | **Medium.** In the synthetic test, 52 of 302 rows lost a remark |
| F5 | The remark key `(br, year, prefix, srno)` is combined across five tables. If two tables share a prefix, their remarks merge | — | Medium. A remark can attach to the wrong voucher |
| F6 | If `act_mst.c_code` is not unique, each ledger row is **duplicated** | — | **High.** Overstated amounts |
| F7 | `d_date BETWEEN '…' AND '2026-07-05'` misses last-day rows if `d_date` stores a time | — | Medium. Missing transactions |
| F8 | Filtering on `c_ref_br_code = '462'` never picks up rows where `c_ref_br_code` is NULL or blank. Store filter (`c_ref_br_code`) and remark key (`c_br_code`) use different columns | — | Medium. Missing or misallocated rows |
| F9 | `c_grp_no` and `n_type` come from the **opposite** account (`o`), not the primary account (`a`) | — | Confirm this is intended |
| F10 | The `''''` text prefix is Excel formatting done inside the database | Low | Low. Codes no longer match their master value |
| F11 | Payment and receipt tagging (bill-wise adjustments) is **not extracted at all** | — | Requirement gap (§9) |

Script `00_source_diagnostics.sql` (checks D1–D8) confirms or rules out F4–F8 on real data with eight small read-only queries.

---

## 3. Recommended extraction approach

```
Eco Green (restored backup copy, read-only)
  10_extract_ledger           1 pass, all stores, no joins     ─┐
  11_extract_remarks          1 pass per source, DISTINCT      ─┤  native bulk unload
  12_extract_account_master   once                             ─┤  → gzip CSV + SHA-256
  1x_extract_payment_tags     once (tables to be named by DBA) ─┤
  13_source_control_totals    same snapshot                    ─┘
                │
                ▼
Staging DB (DuckDB on the worker VPS, or PostgreSQL)
  30_staging_build: key checks → aggregate remarks (one row per document)
                    → enrich ledger → reconcile to 13_ totals
                │
                ▼
Per-store transactions.csv + trial_balance.csv + manifest.json
  (DATA_CONTRACT.md §1)  →  WorkDrive inbox  →  existing pipeline / Layer A recon
```

**Why this is the right design:**
- The Eco Green server only runs simple filtered reads, which is the cheapest work it can do.
- Each table is read exactly once.
- Joins happen once, in a database we control, with automated checks against row multiplication.
- Store-wise splitting is free in staging. In DuckDB, one `COPY … PARTITION_BY` statement writes all 350 store files.
- The current branch-wise delivery unit and reconciliation layers in this repository stay unchanged.

---

## 4. Evaluation of the optimisation methods

### 4.1 Join optimisation — **adopt; highest priority**
- **Recommendation**
  - Remove all joins from the source extraction (§3).
  - If per-store queries must continue for a while, use `20_interim_single_store_optimized.sql`. It limits each remark source to this store's documents with `EXISTS`, joins on native column types, and uses a half-open date range. In the synthetic test it returns **the same rows and values** as the current query.
- **Benefit:** removes the 350× repeated reads of the detail tables (F1) and the non-indexable joins (F2–F3).
- **Risks and mitigation**
  - Row multiplication from joins (F6): checked by CHECK 2 and CHECK 4.
  - Prefix collisions (F5): checked by CHECK 3.
  - Dropped remarks (F4): remarks are concatenated, not reduced with `MAX`.

### 4.2 Staging and intermediate datasets — **adopt**
- **Recommendation:** land the raw extracts unchanged as files (kept as immutable evidence in Stratus, per `PROJECT_CONTEXT.md`), load them into staging, and build `stg_remark` and `stg_ledger_enriched` once.
- **Benefit:**
  - No repeated processing.
  - Joins can be re-run without touching Eco Green.
  - Full audit trail from source file to Books payload.
- **Risk:** the staging copy goes stale if Eco Green is still being posted to.
- **Mitigation:**
  - Extract from a single backup snapshot.
  - Record the snapshot time in `manifest.json`.
  - Re-extract the whole snapshot, never individual pieces.

### 4.3 Parallel processing — **adopt, controlled**
- **Recommendation**
  - Run at most **2–3 concurrent unloads**, and only on the restored copy.
  - Run different tables in parallel, or split the ledger by **month with half-open date ranges**.
  - Do **not** run 350 store queries in parallel.
  - Never page with `OFFSET`/`LIMIT`. Without a fixed sort order, paging repeats or skips rows. This repository already hit this defect in Catalyst paging (commit `40ec7a5`). If row-based batching is unavoidable, use key ranges on `n_pk`.
- **Benefit:** shorter elapsed time once the work per query is already minimal.
- **Risks and mitigation**
  - I/O contention: raise concurrency one stream at a time and stop when elapsed time stops improving.
  - Overlapping or missing partitions: CHECK 1 (duplicate `n_pk`) and CHECK 5 (totals versus source).

### 4.4 Data export optimisation — **adopt**
- **Recommendation:** use the engine's server-side bulk unload, write UTF-8 CSV, compress it, and record a SHA-256 hash.

  | Engine (to be confirmed) | Bulk export |
  |---|---|
  | SAP SQL Anywhere | `UNLOAD SELECT … TO 'file.csv' DELIMITED BY ',' QUOTES ON`, or the `dbunload` utility |
  | SQL Server | `bcp "SELECT …" queryout file.csv -c -t, -S … -T` |
  | MySQL | `SELECT … INTO OUTFILE` (needs `secure_file_priv`), or `mysql --batch --quick -e "…"` |

- **Avoid:**
  - GUI result grids
  - Excel as an intermediate step
  - Row-by-row ODBC fetch loops
  - Text formatting inside the query
- **Benefit:** often the largest saving that nobody measures. Client-side grid rendering and fetching frequently take longer than the query itself (§4.5).
- **Risk:** CSV quoting or encoding issues in free-text remarks. **Mitigation:** RFC 4180 quoting, UTF-8, and row-count and hash checks in the manifest.

### 4.5 Performance monitoring — **adopt first; baseline before change**
Measure the current process before changing anything. Record each of the following separately:

| Metric | How |
|---|---|
| Server execution time vs. fetch/transfer time vs. client write time | Time the query on the server with output discarded, then with full fetch, then with file export |
| Logical/physical reads and plan | SQL Anywhere: graphical plan / `PLAN()`; SQL Server: `SET STATISTICS IO, TIME ON` plus the actual plan; MySQL: `EXPLAIN ANALYZE` |
| Which part costs most | Run the remark subquery alone, the ledger slice alone, and the full query |
| Rows/sec and MB/sec of export | From the export tool's log |
| Server load | CPU, disk queue and blocking on the Eco Green server during the run |

Record each run as: run ID, scope, start, end, rows, bytes, server ms, fetch ms, export ms.

---

## 5. Prioritised optimisation checklist

| P | Action | Impact | Effort | Risk | Owner |
|---|---|---|---|---|---|
| 1 | Capture the baseline (§4.5) for 3 representative stores | Enables proof | Low | None | Migration + DBA |
| 2 | Run `00_source_diagnostics.sql`; resolve F4–F9 | Accuracy | Low | None | DBA |
| 3 | Restore a backup copy for extraction | High (no production impact, consistent snapshot) | Low–Med | Low | DBA |
| 4 | Switch to extract-once for ledger, remarks and account master (scripts 10–12) | **Very high** | Low | Low | DBA |
| 5 | Native bulk export to compressed CSV with SHA-256 | High | Low | Low | DBA |
| 6 | Staging build with CHECKs 1–6 (`30_staging_build.sql`) | High | Medium | Low | Migration |
| 7 | Source control totals (13) plus the independent branch Trial Balance report | Accuracy | Low | None | DBA + Finance |
| 8 | Add the payment/receipt tagging extracts (§9) | Completeness | Medium | Medium | DBA + Migration |
| 9 | Indexes on the restored copy (listed in script 20) | Medium | Low | None on the copy | DBA |
| 10 | Controlled parallelism (2–3 streams) | Medium | Low | Medium | DBA |
| — | Interim only: `20_interim_single_store_optimized.sql` if per-store runs must continue | Medium | Low | Low | DBA |

---

## 6. Step-by-step implementation plan

| Phase | Steps | Exit criterion |
|---|---|---|
| **0. Confirm** | Collect the DBA inputs (§9). Confirm the engine and version. Get finance sign-off on F4 (concatenated remarks) and F9 | Inputs received |
| **1. Baseline** | Time the current query for 3 stores (small, median, largest by row count). Capture plans and server load | Baseline sheet signed |
| **2. Diagnose** | Run `00_source_diagnostics.sql` on the restored copy | F4–F9 resolved or logged as exceptions |
| **3. Build** | Parameterise scripts 10–13 for the engine. Set up the bulk-export commands. Create the staging schema. Load the `30_` build | Scripts versioned with their `sql_hash` (`DATA_CONTRACT.md` §2) |
| **4. Pilot** | Run §7 on the 3 pilot stores, then on all stores for one month | All §7.2 acceptance criteria met |
| **5. Full run** | One snapshot, full period, all stores. Staging build, then per-store files, manifests and WorkDrive delivery | CHECKs 1–6 pass; Layer A PASS for every branch |
| **6. Repeat runs** | Delta or cut-over re-extracts use a new snapshot and a new `extraction_run_id`. Never patch an earlier run | Controlled by the existing manifest rules |

---

## 7. Pilot-testing procedure and comparison criteria

### 7.1 Validation already done (synthetic only)
- All scripts in `docs/extraction-sql/` were run in DuckDB against a synthetic three-store dataset:
  - The interim query (20) returned exactly the current query's output.
  - The extract-once staging build returned the same set of `n_pk` values.
  - The only difference was that remarks previously dropped by `MAX()` are now preserved (52 of 302 rows).
- None of this has been tested against real Eco Green data.

### 7.2 Pilot on real data

| Step | Procedure |
|---|---|
| 1 | Choose 3 stores (smallest, median and largest ledger volume) and one month, then the full period |
| 2 | Run the **current** query and the **new** process against the **same snapshot** |
| 3 | Compare outputs on `n_pk`: same key set, same amount, flag, accounts and date per key |
| 4 | Compare timings: total elapsed and Eco Green server time |
| 5 | Run reconciliation controls (§8) on the new output |

**Acceptance criteria**

| Criterion | Target |
|---|---|
| `n_pk` set: old vs new | 100% match: zero missing, zero extra |
| Amount difference per store/account/flag | 0.00 |
| Duplicate `n_pk` | 0 |
| Trial Balance tie-out (Layer A) | PASS for every pilot store |
| Remark differences | Only multi-remark documents identified in D7 |
| Total elapsed time (extraction for all stores) | Target to be agreed after the baseline. Proposed: at least 80% reduction |
| Eco Green production load during extraction | None (restored copy) |

---

## 8. Data completeness and accounting reconciliation controls

| Control | Detects | Where |
|---|---|---|
| No store filter at source; NULL or blank `c_ref_br_code` reported (D3) | Rows invisible to store-wise extraction | 10, 00 |
| Half-open date range plus the D8 time-of-day check | Last-day rows dropped | 10, 00 |
| `n_pk` unique (CHECK 1) | Duplicate delivery, overlapping partitions | 30 |
| `act_mst.c_code` unique (CHECK 2) | Row multiplication from joins | 30 |
| Remark key collision across sources (CHECK 3) | Remark attached to the wrong voucher | 30 |
| Enriched row count equals raw row count (CHECK 4) | Any join changing the row count | 30 |
| Staging vs source totals by store × account × flag (CHECK 5) | Rows lost or altered in transfer | 13 vs 30 |
| Master and remark coverage report (CHECK 6) | Unmapped accounts, missing descriptions | 30 |
| Manifest row count, debit/credit totals and SHA-256 | File truncation, tampering, re-delivery | `DATA_CONTRACT.md` §2 |
| Store-wise extract vs **independent** Eco Green Trial Balance report (opening + period − closing) | Accounting incompleteness | Layer A (`RECONCILIATION.md` §2) |
| Debit = credit per voucher (`n_flag`-signed) | Broken double entry | Staging invariant (`DATA_CONTRACT.md` §3) |
| Sum of store files = all-store total | Store split losing rows | After the staging split |

**Note:** CHECK 5 proves that the transfer is complete. It does not prove that the accounting is complete. Accounting completeness needs the separate comparison against the Eco Green application's own Trial Balance report.

---

## 9. Minimum information required from the DBA

1. **Engine and version** (SQL Anywhere / SQL Server / MySQL), and whether a backup can be restored to a separate server.
2. **Row counts for FY 26:** `ledger` and the five detail tables (D1, D6), plus overall database size.
3. **Keys and indexes** on `ledger`, `act_mst`, `cash_depo`, `crnt_det`, `inv_det`, `jv_det`, `pur_det`. Is `n_pk` unique? Is `act_mst.c_code` unique?
4. **Column data types** of `ledger.c_act_code`, `ledger.c_opp_act_code` and `act_mst.c_code`, which explain why `CONVERT` was added. Also: does `d_date` include a time?
5. **Column meanings:**
   - `c_br_code` vs `c_ref_br_code`: which one defines store ownership in the Trial Balance?
   - `n_flag`: the Dr/Cr convention.
   - `c_prefix`: document type, and whether prefixes are unique across the five sources.
6. **Payment and receipt tagging:** the table names and key columns that hold bill-wise payment and receipt adjustments, and the cheque/UTR/instrument references.
7. **Header vs line remarks:** do the voucher **header** tables hold the narration? Header tables have one row per document, so they are smaller and avoid `MAX()`.
8. **Independent control report:** how to produce the store-wise Trial Balance (opening, period Dr/Cr, closing) for the same snapshot.
9. **Run window and limits:** permitted hours, maximum concurrent sessions, and the export path and disk space on the server.
10. **Current timing:** how the query is run today (tool, export path) and the observed duration per store.

---

## 10. SQL pack — `docs/extraction-sql/`

| Script | Runs on | Purpose |
|---|---|---|
| `00_source_diagnostics.sql` | Eco Green (read-only) | D1–D8 fact-finding for F4–F8 |
| `10_extract_ledger.sql` | Eco Green | All-store ledger, one pass, no joins |
| `11_extract_remarks.sql` | Eco Green | Five remark sources, `DISTINCT`, year filter only |
| `12_extract_account_master.sql` | Eco Green | Account master, once |
| `13_source_control_totals.sql` | Eco Green | Totals by store × account × flag for CHECK 5 |
| `20_interim_single_store_optimized.sql` | Eco Green | Interim per-store query; output identical to the current query |
| `30_staging_build.sql` | Staging (DuckDB/PostgreSQL) | Checks, remark aggregation, enrichment, reconciliation, per-store split |

Parameters: `:fy`, `:from_date`, `:to_date_excl` (the day **after** the last day), `:last_day`, `:branch`. Before running against the real database, adjust literal syntax and the export wrapper for the confirmed engine.
