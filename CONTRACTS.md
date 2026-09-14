# CONTRACTS.md — internal module contracts (build-time coordination)

Every module below is plain Node 24 ESM (`.js`, `import`/`export`), no TypeScript, no build step,
no new runtime dependencies beyond `express`, `helmet`, `cors`. Tests use `node --test` under `test/`
and must run offline. Money is BigInt paise via `src/core/money.js`; storage/wire form is `"1234.50"`.
Timestamps via `src/core/ids.js#nowIso`. Composite keys via `ids.js#uk`. Hashes via `src/core/hash.js`.
State changes via `src/core/states.js#assertTransition`. **No floats for money anywhere.**

Conventions:
- Every exported function that writes state takes a `ctx` = `{ store, audit, correlationId, actor, now? }`.
- Every write emits an audit event through `ctx.audit.emit({...})` (contract §S).
- Errors are `class XError extends Error { code }`; codes are SCREAMING_SNAKE.
- Never `console.log` secrets or full payloads; use `src/core/log.js#log(level, msg, fields)` (§L).
- Row objects returned from the store are plain objects with column names exactly as in `schema.sql`.

---

## §S  Store adapter — `src/adapters/store/`

`index.js`:
```js
export async function openStore({ adapter = process.env.STORE_ADAPTER ?? 'sqlite', ...opts }) // -> Store
```
`sqlite.js` implements `Store` on `node:sqlite` (`DatabaseSync`), applying `schema.sql` on open.
`memory.js` = same `sqlite.js` with `':memory:'` (for tests). Catalyst Data Store adapter is a
documented stub (`catalyst.js` throws `NOT_IMPLEMENTED` with a pointer to the Tally tool's
`server/src/data/catalyst/*` pattern).

`Store` interface (all sync-safe wrappers, but exposed as `async` for adapter portability):
```js
store.insert(table, row)                    // -> row with id; throws UniqueViolationError{code:'UNIQUE_VIOLATION', table, constraint}
store.insertMany(table, rows)               // atomic in sqlite (transaction); same error semantics
store.update(table, id, patch)              // by primary key; returns updated row
store.get(table, id)
store.findOne(table, where)                 // where = {col: value, ...} exact match
store.find(table, where, { orderBy, limit, offset } = {})
store.count(table, where)
store.raw(sql, params)                      // read-only escape hatch (SELECT only; throws otherwise)
store.transaction(fn)                       // fn(store) runs atomically in sqlite; documented as best-effort in catalyst
/** Atomic claim: sets claimed_by/claimed_at/claim_expires_at + status only if
 *  current status == expectedStatus AND (claimed_by IS NULL OR claim_expires_at < now).
 *  Returns the row if won, null if lost. MUST be a single UPDATE ... WHERE ... RETURNING. */
store.claim(table, id, { workerId, expectedStatus, newStatus, ttlMs })
store.releaseClaim(table, id, { workerId, newStatus })
store.close()
```

## §L  Logging — `src/core/log.js`
```js
export function log(level, msg, fields = {})   // JSON line to stdout; redacts keys matching /token|secret|password|authorization|refresh/i
export function redact(obj)                     // same redaction, exported for tests
```

## §A  Audit — `src/core/audit.js`
```js
export function createAudit(store) // -> { emit }
audit.emit({ actor, actorRole, action, entityType, entityId, before, after, reason,
             authorizationDecision = 'ALLOWED', correlationId, branchCode, period, batchId })
```
Append-only insert into `audit_events`. `before`/`after` are JSON-serialised with `redact()`. Never updates or deletes.

## §I  Inbox adapter — `src/adapters/inbox/`
```js
export async function openInbox({ adapter = process.env.INBOX_ADAPTER ?? 'local' })   // -> Inbox
inbox.listRuns()            // -> [{ inboxRef, branchCode, runId, files: [{name, size}] }] only COMPLETE folders (manifest present + all listed files exist)
inbox.readFile(inboxRef, fileName)  // -> Buffer
inbox.markPicked(inboxRef, { workerId })   // local: writes `.picked-by-<workerId>` marker; workdrive: stub
```
`local.js` implemented. `workdrive.js` exports the same surface and throws `NOT_CONFIGURED` unless all `WORKDRIVE_*` env vars are set; when set it is still a stub returning `NOT_IMPLEMENTED` (document the real API calls needed in WORKDRIVE_INGESTION.md).

## §R  Archive adapter — `src/adapters/archive/`
```js
export async function openArchive({ adapter = process.env.ARCHIVE_ADAPTER ?? 'local' })
archive.put({ runId, branchCode, fileName, bytes, sha256 })  // -> archiveUri (e.g. local://archive/<branch>/<run>/<sha256>/<fileName>)
archive.exists(archiveUri)
archive.get(archiveUri) // -> Buffer
```
Immutability rule: if the target path exists with a different sha256 → throw `IMMUTABLE_CONFLICT`; same sha256 → idempotent no-op returning the same uri. Local impl writes to a temp file then renames. `stratus.js` is a stub throwing `NOT_IMPLEMENTED`.

## §C  CSV + manifest — `src/core/csv.js`, `src/core/manifest.js`
```js
// csv.js — RFC4180, handles quoted fields, CRLF/LF, embedded newlines, BOM. No deps.
export function parseCsv(text, { delimiter = ',' } = {}) // -> { header: string[], rows: string[][] }  throws CsvParseError{code:'CSV_PARSE', line}
export function detectEncoding(buf)  // -> 'utf-8' | 'utf-8-bom' | 'utf-16le' | 'unknown'; reject 'unknown' upstream
export function decode(buf, encoding) // -> string (strips BOM)

// manifest.js
export function validateManifest(obj) // -> { ok: true, manifest } | { ok: false, errors: [{code, path, message}] }
```
Manifest schema = DATA_CONTRACT.md §2. Validate: contract_version==='1.0', required fields, ISO dates, from<=to, files[] non-empty, each file_role ∈ {TRANSACTIONS, TRIAL_BALANCE}, exactly one of each in v1, money strings parse.

## §V  Validation + ingestion — `src/core/ingest.js`
```js
export async function ingestRun(ctx, { inbox, archive, inboxRef, workerId })
```
Steps (each a numbered audit action `INGEST.<STEP>`):
1. Read + validate manifest; compute manifest sha256; `store.insert('extraction_runs', …status RECEIVED)`; if `UNIQUE_VIOLATION` on manifest_sha256 → return `{ outcome: 'DUPLICATE_MANIFEST' }` (no exception row; audit only).
2. `store.claim('extraction_runs', id, {expectedStatus:'RECEIVED', newStatus:'CLAIMED'})`; if null → `{ outcome: 'CLAIM_LOST' }`.
3. For each manifest file: read bytes, sha256, size, encoding detection, delimiter; compare sha256 & size & encoding to manifest; parse CSV; check header exactly matches DATA_CONTRACT §3/§4 columns (order-insensitive, names exact); count rows; compute Σdebit/Σcredit with `parseMoney`; compare row_count and totals to manifest. Insert `source_files` (status VALIDATED or VALIDATION_FAILED with `validation_json`). Duplicate sha256 → `UNIQUE_VIOLATION` → file status `QUARANTINED`, run → `VALIDATION_FAILED`, exception `DUPLICATE_FILE` (P2).
4. If any file failed → run `VALIDATION_FAILED`, release claim, return `{ outcome:'VALIDATION_FAILED', errors }`.
5. Archive manifest + every file (`archive.put`), store `archive_uri`, run → `ARCHIVED`.
6. Load rows: `source_txn_lines` (row_hash via `hash.rowHash`, uk = file_id|voucher_id|line_no; a `UNIQUE_VIOLATION` here → exception `DUPLICATE_SOURCE` P1 for that voucher, row skipped) and `trial_balance_lines`. Content checks per row: branch_code == manifest branch, ISO date within range, line_no int, exactly one of debit/credit non-zero, voucher_type in enum, money parse → violations become exceptions (`SCHEMA_FAILURE`/`MISSING_KEY`, P1) and the row is still loaded when parseable so the bridge stays complete; unparseable rows are counted and reported, run → `EXCEPTION`.
7. Build `vouchers` rows (one per voucher_id): totals, line_count, is_balanced, FY/period, `source_transaction_hash` via `hash.sourceTransactionHash`, all lineage fields, `disposition='PENDING'`. Unbalanced → exception `UNBALANCED_VOUCHER` (P1) and `disposition='BLOCKED'` immediately. Ledger_code not present in trial_balance_lines → exception `ORPHAN_RELATIONSHIP` (P1) + `BLOCKED`.
8. run → `STAGED`, release claim. Return `{ outcome:'STAGED', runId, counts }`.

## §M  Summarisation + Layer A — `src/core/summarise.js`, `src/core/recon_a.js`
```js
export async function summariseRun(ctx, { runId, summaryVersion = 'sum_v1' })
// writes `summaries` rows: per (ledger_code, voucher_type) and per (ledger_code, '*'); run -> SUMMARISED
export async function reconcileLayerA(ctx, { runId, tolerance = '0.00' })
// -> { reconRunId, status, controls: n, diffs: n }
```
Controls (one `recon_results` row each, `control_key` documented in RECONCILIATION.md):
`file:row_count`, `file:debit_total`, `file:credit_total` (manifest vs actual);
`ledger:<code>:period_debit`, `ledger:<code>:period_credit`, `ledger:<code>:txn_count` (TB vs summary);
`ledger:<code>:balance_identity` (opening+period−closing = 0 within TB itself);
`tb:total_debit_equals_credit`; `ledger:<code>:missing_in_tb` / `missing_in_csv`.
`detail_json` carries voucher ids / line ids for drilldown. Status PASS only if zero DIFF and zero MISSING; else FAIL, run → `SOURCE_RECON_FAILED`, exception `RECONCILIATION_DIFFERENCE` (P1) per failing ledger with `financial_impact`. `PASS_WITH_APPROVED_EXCEPTIONS` when every DIFF has an `exceptions.status='APPROVED_EXCEPTION'` row referencing it (dedupe_key = `recon:<runId>:<control_key>`).

## §K  Cutover + overlap + bridge — `src/core/cutover.js`, `src/core/overlap.js`, `src/core/bridge.js`
```js
// cutover.js
export async function loadCutoverMatrix(ctx, rows)      // upsert by uk; DRAFT unless approval_status APPROVED
export function resolveCutover(matrixRows, { branchCode, voucherType, paymentMethod }) // -> row | null (most specific wins, APPROVED only)
export function evaluateEligibility(rule, voucher) // -> { eligible: bool, reason: 'IN_WINDOW'|'BEFORE_MIGRATION_FROM'|'AFTER_CUTOVER'|'RULE_MISSING'|'LIVE_START_UNVERIFIED'|'LATE_OR_BACK_POSTED' }
//   LATE_OR_BACK_POSTED when voucher.source_modified_at date >= live_system_start_date

// overlap.js
export function classifyOverlap({ rule, voucher, spEvidence }) // -> { classification, matchStrength, evidence }
//   NOT_COVERED rule -> NOT_APPLICABLE
//   COVERED/PARTIAL + evidence match on (branch, date, class, payment_method, tax_bucket, amount, sp_batch_ref|books_record_id) -> SMART_PHARMA_ALREADY_POSTED, strength FULL_EVIDENCE/REFERENCE_MATCH
//   COVERED/PARTIAL + no/partial evidence -> PARTIAL_OR_AMBIGUOUS_OVERLAP (amount-only or date-only NEVER counts as a match)
//   UNKNOWN coverage -> PARTIAL_OR_AMBIGUOUS_OVERLAP
export async function classifyRun(ctx, { runId, spEvidence, ruleVersion })
//   for every voucher: eligibility -> overlap -> mapping presence (MODULE_ROUTE APPROVED for voucher_type)
//   writes overlap_candidates, sets vouchers.disposition/_reason/_rule_version/_evidence_json, raises exceptions:
//     CUTOVER_RULE_MISSING (P1, BLOCKED), LATE_OR_BACK_POSTED (P1, BLOCKED), SMART_PHARMA_OVERLAP (P1, BLOCKED for PARTIAL_OR_AMBIGUOUS),
//     UNMAPPED_MODULE (P1, BLOCKED), INVENTORY_CONTROL_ONLY -> disposition OTHER_EXCLUDED reason INV_CONTROL_ONLY_v1 (no exception, audit only)
//   run -> CLASSIFIED

// bridge.js  (Layer B)
export async function reconcileLayerB(ctx, { runId })
//   recon_runs layer 'B'. Controls: bridge:count, bridge:debit, bridge:credit each proving
//   CSV population == MIGRATE + SMART_PHARMA_EXCLUDED + OTHER_EXCLUDED + BLOCKED (and PENDING must be 0).
//   Fails if any PENDING or if sums don't tie. Also per-disposition subtotal controls with voucher-id drilldown.
```

## §T  Mapping + transform preview — `src/core/mapping.js`, `src/core/transform.js`
```js
export async function loadMappingRules(ctx, rows)                        // upsert by uk
export function resolveRule(rules, ruleType, sourceKey, onDate)           // APPROVED + effective window
export async function transformRun(ctx, { runId, transformationVersion = 'tx_v1' })
//   only vouchers with disposition MIGRATE. Route via MODULE_ROUTE; build Books-shaped payload per module:
//     bill{vendor, date, line_items[{account, amount, tax}], reference_number, location_id, custom_fields:{cf_migration_source_hash, cf_migration_batch}}
//     vendor_payment / customer_payment {contact, amount, date, payment_mode, reference, location_id, custom_fields}
//     expense {account, paid_through, amount, date, vendor?, location_id, custom_fields}
//     credit_note / vendor_credit {contact, date, line_items, location_id, custom_fields}
//     bank_transfer {from_account, to_account, amount, date, reference, location_id, custom_fields}
//     journal {date, line_items[{account, debit|credit}], reference_number, notes, location_id, custom_fields}
//   Every payload carries custom_fields.cf_migration_source_hash = source_transaction_hash (stable migration tag for Layer C).
//   Missing LEDGER_ACCOUNT / PARTY / PAYMENT_MODE rule -> exception UNMAPPED_ENTITY (P1), voucher BLOCKED, no payload.
//   Writes preview_payloads (payload_hash = hashCanonical(payload)), sets vouchers.target_module/_payload_hash/mapping_version/transformation_version.
//   run -> TRANSFORMED. Re-running with same versions is idempotent (uk).
export function humanSummary(module, payload) // one line, e.g. "bill V-PARTY-007 2026-04-03 ₹12,340.00 (2 lines)"
```

## §B  Batch + approval — `src/core/batch.js`
```js
export async function createBatch(ctx, { runId, branchCode, period, createdBy })
//   collects MIGRATE vouchers with payloads for run+period; scope_hash via hash.scopeHash; status DRAFT -> READY_FOR_APPROVAL if Layer A & B PASS for run, else stays DRAFT with reason.
export async function approveBatch(ctx, { batchId, approver, approverRole, reason })
//   role must be 'approver' or 'admin'; approver !== batch.created_by (segregation of duties; env SOD_ENFORCED=true default);
//   recomputes scope_hash and refuses if it differs from stored (inputs changed); inserts approvals; batch -> APPROVED; stamps vouchers.approval_id/migration_batch_id.
export async function invalidateApprovalIfChanged(ctx, { batchId, reason }) // recompute scope_hash; if differs -> approvals.invalidated_at, batch -> APPROVAL_INVALIDATED, vouchers.approval_id=null
export async function enqueueBatch(ctx, { batchId })  // APPROVED only; inserts queue_items (idempotency_key = source_transaction_hash); batch -> QUEUED
```

## §Z  Books adapter — `src/books/`
```js
export function createBooksClient({ driver, config, store, audit })  // driver: 'mock' | 'live'
client.isPostingEnabled()  // TRUE only if POSTING_ENABLED==='true' AND POSTING_AUTHORIZATION_REF non-empty AND config.organizationId ∈ BOOKS_ORG_ALLOWLIST AND driver==='live'. Otherwise false. Also exported as guard `assertPostingAllowed()` throwing POSTING_DISABLED.
client.getOrganization()
client.getLocations()
client.getTrialBalance({ locationId, fromDate, toDate })                       // read
client.searchByMigrationTag({ module, sourceHash })                            // read; deterministic target lookup for UNKNOWN_OUTCOME
client.listRecordsInWindow({ locationId, module, fromDate, toDate })          // read; returns records with tags: {migration_source_hash?, sp_batch_ref?, created_by}
client.create(module, payload, { idempotencyKey })                             // WRITE — mock only unless posting enabled; live driver throws POSTING_DISABLED before any network call
```
`live.js`: OAuth refresh-token flow (port from Tally tool `server/src/services/zoho.js`, keep encryption-at-rest of tokens via `APP_ENCRYPTION_KEY`, drop Tally specifics), native `fetch`, `AbortSignal.timeout`, base URL `.in`. Every request goes through `src/books/limiter.js` (port Tally `rateLimiter.js`: sliding window per **organisation**, bounded concurrency, exponential backoff + full jitter, honour `Retry-After` header when present, classify responses SUCCESS/RETRYABLE(5xx,429)/NON_RETRYABLE(4xx validation)/AUTH(401)/UNKNOWN(timeout after send)). Never log tokens; `error_message` redacted.
`mock.js`: in-memory org with locations + accounts; `create` returns synthetic ids and records the tag; supports fault injection via `mock.failNext({ status | timeoutAfterSend: true })` for tests; `listRecordsInWindow` returns migration-tagged, SP-tagged (seeded from spEvidence) and manual (seeded) records.

## §Q  Queue executor — `src/worker/executor.js`
```js
export async function runQueueSlice(ctx, { client, batchId, workerId, maxItems, timeBudgetMs })
```
Per item: `store.claim(queue_items…)` → `assertPostingAllowed()` (mock passes; live requires guard) → `assertTransition` → insert `api_attempts` row BEFORE the call (request_hash) → `client.create` → classify: SUCCESS → POSTED + zoho_record_id on voucher; RETRYABLE → FAILED_RETRYABLE with `run_after` backoff, attempts++ ; NON_RETRYABLE → FAILED_FINAL + exception `API_VALIDATION_ERROR`; AUTH → circuit-break (batch → PAUSED, exception `AUTHENTICATION_ERROR` P1); UNKNOWN → `UNKNOWN_OUTCOME` (NEVER retried automatically). `resolveUnknownOutcomes(ctx,{client,batchId})` does `searchByMigrationTag`; found → POSTED; proven absent → QUEUED. attempts ≥ BOOKS_MAX_ATTEMPTS → DEAD_LETTER + exception. Batch status derived: all POSTED → MIGRATED; mix → PARTIALLY_MIGRATED.

## §Y  Layer C + balance bridge — `src/core/recon_c.js`, `src/core/balance_bridge.js`
```js
export async function reconcileLayerC(ctx, { client, batchId })
//   approved population (queue_items) vs client.searchByMigrationTag per item: controls per module: count, amount; per item: present/missing/duplicate(>1 target with same tag)/unexpected(target tag with no queue item)/partial.
export async function takeSnapshot(ctx, { client, branchCode, kind, batchId })   // BASELINE | POST_RUN -> books_snapshots
export async function balanceBridge(ctx, { batchId })
//   per account: baseline + migration_movement (from POSTED items) + sp_movement (SP-tagged in window) + manual_movement (untagged in window, must be listed as authorised or -> unexplained) == post_run
//   recon_runs layer BALANCE_BRIDGE; any unexplained -> FAIL, exception TARGET_MISMATCH P1
```

## §X  Exceptions — `src/core/exceptions.js`
```js
export const CATEGORIES = [ 'SCHEMA_FAILURE','MISSING_KEY','ORPHAN_RELATIONSHIP','DUPLICATE_SOURCE','DUPLICATE_FILE','UNMAPPED_ENTITY','UNMAPPED_MODULE','AMBIGUOUS_MAPPING','UNBALANCED_VOUCHER','INVALID_TARGET_TYPE','SMART_PHARMA_OVERLAP','CUTOVER_RULE_MISSING','LATE_OR_BACK_POSTED','API_VALIDATION_ERROR','AUTHENTICATION_ERROR','RATE_LIMIT','TRANSIENT_FAILURE','UNKNOWN_API_OUTCOME','TARGET_MISMATCH','RECONCILIATION_DIFFERENCE','POSTING_DISABLED' ]
export async function raise(ctx, { category, severity, message, dedupeKey, branchCode, period, runId, fileId, voucherId, batchId, financialImpact = '0.00', evidence })
//   upsert on dedupe_key: existing OPEN row is touched (updated_at), never duplicated; RESOLVED rows are re-opened with audit.
export async function resolve(ctx, { id, status: 'RESOLVED'|'APPROVED_EXCEPTION'|'REJECTED', rootCause, disposition, actor })
//   APPROVED_EXCEPTION requires role approver/admin. History preserved via audit.
```

## §W  Worker loop — `src/worker/index.js`
Single process: poll inbox → `ingestRun` → `summariseRun` → `reconcileLayerA` → (if PASS) `classifyRun` → `transformRun` → `reconcileLayerB` → drain queue slices for QUEUED batches (mock/live per config) → `resolveUnknownOutcomes` → sleep. Idempotent on restart: every step keys off durable status; expired claims (`claim_expires_at < now`) are reclaimable. Exposes `runOnce(ctx, deps)` for tests and the pipeline script; `main()` loops.

## §H  HTTP API + console — `src/server/`
Express, `helmet`, JSON only, no sessions. Auth: `Authorization: Bearer <token>`; tokens are sha256-hashed in `config/users.json` (`USERS_CONFIG_PATH`), each user `{ id, principal_type: 'human'|'bot', role, branches: ['*'|codes] }`. `principal_type` is validated at load by `auth.normalizeUsers` (fail closed): a bot may only hold `viewer`/`operator`; a `bot:*` id or role `bot` contradicting `principal_type: 'human'` is a startup error. Bot principals are always served minimal/redacted responses regardless of `?minimal`. `requireRole(...roles)` and `scopeBranch` middleware enforce server-side; any request whose branch param ∉ user.branches → 403 + audit DENIED. Every mutating route requires `X-Correlation-Id` (generated if absent) and writes audit.

Routes (read):
`GET /api/health`, `GET /api/runs?branch=`, `GET /api/runs/:id` (files, counts, status), `GET /api/runs/:id/summary`, `GET /api/recon/:reconRunId` (+results), `GET /api/runs/:id/bridge`, `GET /api/vouchers?run=&disposition=&status=`, `GET /api/vouchers/:id` (lines, overlap, payload, attempts, audit), `GET /api/exceptions?branch=&status=`, `GET /api/cutover?branch=`, `GET /api/batches?branch=`, `GET /api/batches/:id` (queue counts, attempts, layer C, bridge), `GET /api/audit?entity=&id=`, `GET /api/worker/health`.
Routes (mutating, role in parentheses):
`POST /api/runs/:id/rerun-recon` (operator), `POST /api/cutover` (admin; upsert DRAFT), `POST /api/cutover/:id/approve` (approver), `POST /api/mappings` (admin), `POST /api/mappings/:id/approve` (approver), `POST /api/batches` (operator), `POST /api/batches/:id/approve` (approver; SoD), `POST /api/batches/:id/enqueue` (operator), `POST /api/batches/:id/pause|resume` (operator), `POST /api/queue/:id/retry` (operator; only FAILED_RETRYABLE/DEAD_LETTER, never UNKNOWN_OUTCOME), `POST /api/exceptions/:id/resolve` (operator/approver per §X), `POST /api/snapshots` (operator; read-only against Books).
There is deliberately **no** route that flips `POSTING_ENABLED`.

Console: `src/server/public/index.html` + `app.js` + `styles.css`, vanilla JS, single page with sections: Files, Cutover matrix, Layer A, Bridge (Layer B), Overlaps & Exceptions, Preview, Approval, Queue & Layer C, Balance bridge, Audit / Worker health. Every number links to the drilldown endpoint that produced it. No framework, no build.

## §G  Governed bot/MCP surface — `src/server/routes/agent.js`
Same auth + roles as the console; a bot user is `role: 'operator'` at most, never `approver`. Exposes only: the read routes above, plus `pause`, `resume`, `retry` (eligible-only), `exceptions/:id/assign`. All responses strip narration/party names when `?minimal=1` (default for agent token). Text fields from CSV/exceptions are returned as data with a `"untrusted": true` marker. Documented in BOT_AND_MCP_SECURITY.md.

## §P  Scripts — `scripts/`
`seed-fixtures.js` copies `fixtures/synthetic/*` into `INBOX_LOCAL_PATH` and loads `config/cutover-matrix.json`, `config/mapping-rules.json`, `config/users.json` (dev tokens printed ONCE to stdout, not stored plaintext).
`run-pipeline.js --branch --run [--dry-run]` runs `worker.runOnce` end-to-end with mock Books and prints a compact report (files, Layer A, dispositions, Layer B, preview count, exceptions). `--dry-run` is the only mode; posting requires the guard in §Z regardless.
`check-secrets.js` scans the tree for token/secret patterns and real-looking GSTIN/PAN/phone/email, exits non-zero on hit (used before any push).
