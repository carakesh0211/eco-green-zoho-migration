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

Increment 2 (§7) adds five tables -- `branch_summaries`, `app_users`,
`branch_period_assignments`, `books_connections`, `books_locations` -- bringing the
schema to **25 tables total**. Status: in progress -- verify against code on merge
against `src/adapters/store/schema.sql` before relying on this count.

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


## 7. Team-operable console (increment 2)

Status: **in progress -- verify against code on merge.** This section describes the
design/contract for the increment-2 build other agents are implementing concurrently
against `CONTRACTS.md` §U/§D/§N/§E and the schema already added to
`src/adapters/store/schema.sql`; it is not evidence that any increment-2 route or table
is complete, tested, or deployed.

### 7.1 Branch Control Dashboard

Backed by a denormalised `branch_summaries` table: one row per branch, 27 columns (kept
<= 30 so a single Catalyst ZCQL `SELECT` never needs column chunking -- the 30-select-
column cap is documented in `docs/CATALYST_REFERENCES.md`), refreshed from the
transactional tables (`extraction_runs`, `recon_runs`, `exceptions`,
`migration_batches`, `queue_items`, ...) rather than queried live. All server-side
search, filter, sort, and pagination over this table live in `src/core/branch_list.js`;
the browser never sees more than one page. At the configured `EXPECTED_BRANCH_COUNT`
(~351, `PROJECT_CONTEXT.md`), the whole summary table fits in <= 2 ZCQL pages (the
300-row-per-query cap from §6); the dashboard fetches those <=2 pages server-side,
applies filter/sort/pagination in-process, and returns one page to the client. CSV
export of the filtered/sorted result set is generated server-side, never assembled
client-side from multiple page fetches.

The branch workspace (single-branch drilldown) reuses the existing Layer A/B/C,
cutover, and exception views already described in §§3-5 -- it does not introduce a
parallel data model, only a branch-scoped lens over the same tables.

### 7.2 Team directory and assignments

`app_users` is the operable team directory; the config-file user list
(`config/users.json`) remains the bootstrap/fallback, not replaced. Humans authenticate
via Catalyst Authentication (§7.4); bots keep hashed bearer tokens (`token_sha256`),
never a Catalyst session. Roles: `admin`, `operator`, `approver`, `viewer` (auditor).

`branch_period_assignments` tracks who works which `(branch_code, period,
transaction_class)`: `assigned_operator`, `assigned_approver`, `status`,
`priority_level` (named `priority_level` rather than `priority` because `priority` is a
reserved Catalyst Data Store column name -- the API/UI may still expose it as
`priority`), `assigned_at`, `due_at`, `version` (optimistic lock), `assigned_by`,
`reassignment_reason`, and a synthetic `uk` (`branch_code|period|transaction_class`) for
uniqueness.

Segregation-of-duties rules, enforced in `src/core/assignments.js`:

- Operator != approver on the same assignment.
- A preparer cannot approve their own batch (existing §B rule, unchanged).
- The assigned operator on a `branch_period_assignments` row cannot also be its
  assigned approver.

Every write to `branch_period_assignments` is optimistically locked on `version`; a
stale write returns `409 VERSION_CONFLICT` rather than silently overwriting a concurrent
reassignment. Server-side branch scope is enforced on every route touching assignments
or the dashboard, exactly as in §H's existing `scopeBranch` middleware -- covered by a
scope-matrix test, not by UI-only filtering.

### 7.3 Zoho Books connection state

`books_connections` is a singleton row (`id='default'`) recording connection status,
organisation, region, and token health; `books_locations` mirrors the last-synchronised
Books locations. Secrets (OAuth client secret, refresh token) are stored **only** as
`secret_ciphertext` -- AES-256-GCM under `BOOKS_SECRET_KEY` -- and are never returned by
any API response or written to logs.

Connecting Books to the console is deliberately decoupled from posting: none of the six
controls below imply another. They are independent and all must hold before a live post
can occur:

1. **Books connected** -- an OAuth connection exists and `books_connections.status =
   CONNECTED`.
2. **Correct organisation verified** -- an operator has confirmed `org_id`/`org_name`
   matches the intended Eco Green organisation (not merely "some org the credential can
   see").
3. **Locations synchronised/mapped** -- `books_locations` has been refreshed and each
   in-scope branch has a `zoho_location_id` mapping.
4. **Read-only reconciliation access approved** -- `BOOKS_READ_AUTHORIZED=true`; without
   it, no live Books read (baseline, trial balance, drilldown) is permitted even though
   the connection exists.
5. **Batch financially approved** -- the existing per-batch approval gate (§B),
   unchanged.
6. **Production posting explicitly enabled** -- the existing four-gate
   `assertPostingAllowed()` guard (`DEPLOYMENT.md` §5, `SECURITY.md` §3):
   `POSTING_ENABLED=true`, a non-empty `POSTING_AUTHORIZATION_REF`, an allowlisted
   `organizationId`, and the `live` driver, set through controlled deployment
   configuration, never through an API route.

Connecting Books (control 1) never advances controls 4-6; each is checked independently
at the point of use.

### 7.4 Authentication

`AUTH_MODE` selects one or both of `token` (existing hashed-bearer-token auth,
unchanged, still how bots authenticate) and `catalyst` (Catalyst Authentication for
human sessions), e.g. `AUTH_MODE=token,catalyst` while migrating from one to the other.
New routes: `GET /api/auth/me` (current principal, redacted), `GET /api/auth/config`
(which mode(s) are active, login/logout URLs, never secrets), `GET /auth/login` /
`GET /auth/logout` (Catalyst session bridge). See `CONTRACTS.md` §E for the terse route
contract.
