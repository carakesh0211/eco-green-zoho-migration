# ARCHITECTURE.md — Eco Green to Zoho Books Migration Pilot

Status: **in progress (wave 1)**. Describes the design specified in `CONTRACTS.md` and
`DATA_CONTRACT.md`. Module code is being written concurrently against these contracts;
this document is not evidence that any module is complete or deployed.

## 1. Current state (as inspected)

```text
+------------------------------------------------------------+
|  Local workspace (not yet a git repository)                |
|                                                              |
|  src/core/{hash,ids,money,states}.js   -- primitives, done  |
|  src/adapters/store/schema.sql         -- schema, defined   |
|  package.json, .env.example            -- scaffold, defined |
|  CONTRACTS.md, DATA_CONTRACT.md        -- contracts, defined|
|                                                              |
|  Everything else in CONTRACTS.md (§S,§I,§R,§C,§V,§M,§K,§T,  |
|  §B,§Z,§Q,§Y,§X,§W,§H,§G,§P) is being implemented           |
|  concurrently by other agents -- NOT YET VERIFIED HERE.     |
+------------------------------------------------------------+

  Separately, on disk elsewhere: the RapGuru Tally migration tool
  (Node/Express + SQLite/Catalyst dual adapter, React/Vite UI),
  a source of reuse per IMPLEMENTATION_PLAN.md §7. Not part of
  this repository.
```

No live WorkDrive, Stratus, or Catalyst Data Store connection exists from this workspace
today. No Eco Green data has been received. The available Zoho Books credential cannot
see the Eco Green org.

## 2. Target architecture (pilot)

```text
Eco Green MySQL (existing extraction queries, out of this repo's control)
        |
        v  CSV + manifest.json  (DATA_CONTRACT.md)
Zoho WorkDrive controlled inbox   <-- ADAPTER STUB in MVP (local folder today)
        |
        v  pickup / claim
Hermes VPS worker  (src/worker -- §W)
        |
        +--> Catalyst Stratus immutable archive   <-- ADAPTER STUB (local folder today)
        |
        v
Catalyst Data Store  <-- ADAPTER STUB (node:sqlite today, src/adapters/store)
        |
        v  ingest -> summarise -> Layer A -> classify -> transform -> Layer B
        |
        v  batch -> approval (role + SoD)
        |
        v  organisation-wide rate-limited queue (§Q)
        |
        v
Zoho Books  (mock driver by default; live driver gated by 4 independent flags, §Z)
        |
        v  Layer C + live balance bridge (§Y)
        |
        v
Audit trail + lightweight HTML console (§H) + governed bot/MCP surface (§G)
```

## 3. Module map (mirrors CONTRACTS.md)

| Area | Path | Contract | Purpose |
|---|---|---|---|
| Store adapter | `src/adapters/store/` | §S | SQLite today; Catalyst Data Store stub |
| Logging | `src/core/log.js` | §L | Redacted structured logs |
| Audit | `src/core/audit.js` | §A | Append-only audit events |
| Inbox adapter | `src/adapters/inbox/` | §I | Local folder today; WorkDrive stub |
| Archive adapter | `src/adapters/archive/` | §R | Local immutable folder today; Stratus stub |
| CSV + manifest | `src/core/csv.js`, `src/core/manifest.js` | §C | RFC 4180 parsing, manifest validation |
| Ingestion | `src/core/ingest.js` | §V | Validate, archive, stage a run |
| Summarisation + Layer A | `src/core/summarise.js`, `src/core/recon_a.js` | §M | Branch/ledger summaries, source TB reconciliation |
| Cutover, overlap, Layer B | `src/core/cutover.js`, `src/core/overlap.js`, `src/core/bridge.js` | §K | Eligibility, Smart Pharma classification, CSV-to-population bridge |
| Mapping + transform | `src/core/mapping.js`, `src/core/transform.js` | §T | Versioned rules, dry-run Books payloads |
| Batch + approval | `src/core/batch.js` | §B | Immutable scope, role-checked approval |
| Books adapter | `src/books/` | §Z | Mock/live client, posting guard |
| Queue executor | `src/worker/executor.js` | §Q | Claim, attempt, classify, retry |
| Layer C + balance bridge | `src/core/recon_c.js`, `src/core/balance_bridge.js` | §Y | Target reconciliation, live balance proof |
| Exceptions | `src/core/exceptions.js` | §X | First-class, deduplicated exception records |
| Worker loop | `src/worker/index.js` | §W | Single-process deterministic cycle |
| HTTP API + console | `src/server/` | §H | Role/branch-scoped API, plain-HTML console |
| Bot/MCP surface | `src/server/routes/agent.js` | §G | Governed subset for Hermes/bot |
| Scripts | `scripts/` | §P | Fixture seeding, dry-run pipeline, secret scan |

## 4. Data model summary (`src/adapters/store/schema.sql`)

Reference tables: `branches`, `cutover_matrix`, `mapping_rules`.
Ingestion tables: `extraction_runs`, `source_files`, `source_txn_lines`, `trial_balance_lines`.
Canonical unit: `vouchers` — one row per source voucher, carrying the mandatory lineage
fields named in `PROJECT_CONTEXT.md`: `source_system`, `source_query_id`,
`source_query_version`, `extraction_run_id`, `source_file_id`/`source_file_hash`,
`source_record_id`, `source_document_no`, `branch_code`, `zoho_location_id`,
`financial_year`, `period`, `transaction_date`, `source_transaction_type`,
`source_transaction_hash` (idempotency key, `UNIQUE`), `mapping_version`,
`transformation_version`, `target_module`, `target_payload_hash`,
`migration_batch_id`, `approval_id`, `zoho_record_id`, `migration_status`,
`attempt_count`, `last_error_code`/`last_error_message`, `reconciliation_status`,
`created_at`/`updated_at`.

Reconciliation/workflow tables: `summaries`, `recon_runs`, `recon_results`,
`overlap_candidates`, `exceptions`, `preview_payloads`, `migration_batches`,
`approvals`, `queue_items`, `api_attempts`, `books_snapshots`, `audit_events`.

Money is stored as 2-decimal-place TEXT and computed in integer paise (`src/core/money.js`)
— never as floats. Dates are ISO-8601; timestamps are ISO-8601 UTC with milliseconds.
Every table needing a composite unique key carries a synthetic pipe-joined `uk` TEXT
column with a single-column `UNIQUE` constraint (see §5, Data Store limits).

## 5. State machines (`src/core/states.js`)

```text
RUN:    RECEIVED -> CLAIMED -> ARCHIVED -> STAGED -> SUMMARISED
          -> SOURCE_RECONCILED -> CLASSIFIED -> TRANSFORMED -> READY_FOR_APPROVAL
        (VALIDATION_FAILED / SOURCE_RECON_FAILED / EXCEPTION are recoverable side states)

BATCH:  DRAFT -> READY_FOR_APPROVAL -> APPROVED -> QUEUED -> MIGRATING
          -> {PARTIALLY_MIGRATED | MIGRATED} -> POST_RECONCILIATION -> SIGNED_OFF
        (APPROVAL_INVALIDATED, PAUSED, RECONCILIATION_FAILED, REJECTED are recoverable)

QUEUE ITEM: QUEUED -> CLAIMED -> {POSTED | FAILED_RETRYABLE | FAILED_FINAL | UNKNOWN_OUTCOME}
        FAILED_RETRYABLE -> QUEUED | DEAD_LETTER | PAUSED
        UNKNOWN_OUTCOME  -> POSTED (found) | QUEUED (proven absent) | DEAD_LETTER
        (never UNKNOWN_OUTCOME -> automatic retry)

DISPOSITION: PENDING -> {MIGRATE | SMART_PHARMA_EXCLUDED | OTHER_EXCLUDED | BLOCKED}
```

All transitions go through `assertTransition`, which throws `IllegalTransitionError`
rather than allowing a silent, out-of-band state jump. This is the single mechanism
that keeps approval, posting, and reconciliation state machines honest across restarts
and concurrent workers.

## 6. Adapter boundaries and the Catalyst swap

Every external dependency is behind a small adapter interface so the local/mock
implementation and the eventual Catalyst-backed implementation are interchangeable
without touching core logic:

| Boundary | Local/mock (MVP) | Catalyst target | Known limit -> design accommodation |
|---|---|---|---|
| Store | `node:sqlite` | Data Store (stub `NOT_IMPLEMENTED`) | No composite unique index -> synthetic single-column `uk` on every table needing one |
| Inbox | Local folder polling | WorkDrive | Same `Inbox` interface; stub throws `NOT_CONFIGURED` then `NOT_IMPLEMENTED` (`WORKDRIVE_INGESTION.md`) |
| Archive | Local immutable folder | Stratus | Same `put`/`exists`/`get`; immutability rule (reject conflicting sha256, idempotent on same) enforced identically |
| Compute/API | Local Express process | AppSail | 30s request timeout -> worker already processes one bounded slice (`maxItems`/`timeBudgetMs`) per drain, not a whole batch |
| Large text fields | SQLite `TEXT` (unbounded) | Data Store | 10,000-char Text ceiling -> oversized payloads/evidence overflow to Stratus with a reference stored in the row (not yet implemented) |
| Multi-row atomicity | SQLite `transaction()` | Data Store (no multi-row tx) | Every multi-step write is a sequence of idempotent single-row steps keyed by stable identity, so partial failure is resumable, not rolled back |
| Bulk reads | `store.raw()` (SELECT only) | ZCQL | 300-row cap per query -> `find()` already exposes `limit`/`offset` for pagination |
| Deployment target | N/A (local dev) | Catalyst CLI | CLI cannot deploy to Production -> promotion is a manual, documented step (`DEPLOYMENT.md`) |
| Scheduled work | Single worker process | Job Scheduling | Worker steps are already discrete/idempotent, so they can split into scheduled jobs later without redesign |

No Catalyst resource exists for this pilot yet (open decision D-1). The limits above are
used as design constraints now so the eventual swap needs no rearchitecting.

## Catalyst Data Store claiming is BEST_EFFORT (current limitation)

`src/adapters/store/catalyst.js` cannot implement `claim()` as a single conditional
`UPDATE … WHERE … RETURNING` because Catalyst Data Store exposes no conditional update; it is a
read-then-write and the store reports `claimSemantics: 'BEST_EFFORT'`. Consequences enforced in code:

- `src/books/guard.js#assertPostingAllowed(config, { store })` refuses posting with reason
  `BEST_EFFORT_CLAIMS` whenever the store is not atomic — Catalyst-backed production posting is
  structurally disabled until an atomic lease exists (Catalyst Job/Cron target with a lease row, or a
  different store for the queue).
- `src/worker/index.js` refuses to start on a Catalyst store unless `WORKER_MODE=singleton`, and a
  singleton refuses to start while another `WORKER.START` audit event (different `WORKER_ID`, no
  matching `WORKER.STOP`, within `WORKER_LEASE_MS`) exists — best-effort mutual exclusion, documented as
  such. The deployed dashboard runs with `WORKER_MODE=disabled`.
- `/api/health` exposes `claimSemantics` and lists `BEST_EFFORT_CLAIMS` in `postingBlockedBy`.
