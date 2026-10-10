# OPERATIONS_RUNBOOK.md — Operating the Pilot

Status: **in progress (wave 1)**. Procedures below describe intended behavior of the
design in `CONTRACTS.md`; none has been exercised against a real incident or live data.
Use this against the mock Books driver and fixtures until stated otherwise.

## 1. Pause and resume

- Pause: `POST /api/batches/:id/pause` (operator). Batch → `PAUSED`; claimed items
  finish their current attempt, no new items are claimed.
- Resume: `POST /api/batches/:id/resume` (operator). Batch → `QUEUED`; next drain cycle
  picks it back up.
- The Hermes bot may also pause/resume through the governed surface
  (`BOT_AND_MCP_SECURITY.md` §1), audited identically to a console action.
- Pausing never touches already-`POSTED` items or reconciliation state.

## 2. Retry rules — never blind-retry `UNKNOWN_OUTCOME`

- `POST /api/queue/:id/retry` (operator) is valid only for `FAILED_RETRYABLE` or
  `DEAD_LETTER`; the route rejects `UNKNOWN_OUTCOME` outright.
- `UNKNOWN_OUTCOME` is resolved only by the worker's `resolveUnknownOutcomes` step:
  `client.searchByMigrationTag` looks up the item, then found → `POSTED`, proven absent
  → back to `QUEUED`. No manual override route exists for it, by design (`CONTRACTS.md`
  §Q).
- A retry reuses the same `idempotency_key` (`source_transaction_hash`) and can never
  create a second target transaction.

## 3. Dead-letter handling

- An item reaching `attempts ≥ BOOKS_MAX_ATTEMPTS` moves to `DEAD_LETTER` with an
  exception, and is not retried automatically again.
- Manual requeue back to `QUEUED` (`QUEUE_TRANSITIONS`) must be explicit and audited,
  taken only after the underlying cause is understood and fixed — never a reflexive
  re-run.

## 4. OAuth failure containment

- A `401`/`AUTH` classification trips a circuit breaker: the batch moves to `PAUSED` and
  an `AUTHENTICATION_ERROR` exception (P1) is raised immediately, rather than letting
  every queued item fail individually.
- Containment: confirm the batch is `PAUSED`; rotate/refresh the OAuth credential out of
  band; verify the new credential with a read-only `getOrganization` call; resume only
  after that check succeeds.
- Never resume against an unverified credential — a second `AUTH` wave repeats the same
  exception without new information.

## 5. Rate-limit storms

- All Books calls go through the organisation-wide limiter (`src/books/limiter.js`):
  sliding window, bounded concurrency, exponential backoff with full jitter, and
  `Retry-After` honored when present.
- A burst of `429`/`RATE_LIMIT` should self-correct via backoff. If not, reduce
  `BOOKS_RATE_LIMIT_PER_MINUTE`/`BOOKS_MAX_CONCURRENCY` and restart the worker — a
  configuration change, not code, so it can be tuned to the actual Books plan once
  confirmed (`IMPLEMENTATION_PLAN.md` D-7).
- Because the limiter is organisation-wide, a storm on one branch throttles every branch
  sharing that organisation — intentional given the shared API budget.

## 6. Partial batch

- A mix of `POSTED` and other-status items is `PARTIALLY_MIGRATED` — a normal
  intermediate state, not itself an incident.
- Resolve by draining remaining `QUEUED`/`FAILED_RETRYABLE` items, then resolving any
  `DEAD_LETTER`/`UNKNOWN_OUTCOME` items per §2–§3, before running Layer C and the balance
  bridge.
- Never treat a partially migrated batch as reconciled — Layer C explicitly reports
  missing/partial target records for this case.

## 7. Systemic mapping defect

- Symptom: a wave of `UNMAPPED_ENTITY`/`UNMAPPED_MODULE` exceptions, or one exception
  category concentrated across many vouchers.
- Response: pause affected batches; do not bulk-fix by overriding dispositions directly
  — correct the versioned mapping rule (approver role), then **re-run transform**
  (idempotent and versioned, §T). A new mapping version never silently overwrites old
  preview payloads; both stay traceable.
- If the defect was already approved into a batch, treat the approval as materially
  changed input — `invalidateApprovalIfChanged` should fire, forcing re-approval rather
  than proceeding on stale mappings.

## 8. Smart Pharma mismatch

- Symptom: a `SMART_PHARMA_OVERLAP` spike, or a Layer C/balance-bridge discrepancy
  traced to `SALES_B2C`.
- Response: never reclassify or override overlap dispositions manually. Escalate to
  Smart Pharma vendor and Finance lead (`SMART_PHARMA_OVERLAP.md` §6–§7) for the missing
  evidence or corrected coverage rule; update the matrix/evidence feed through the
  normal approved-rule path, then re-run classification.
- Any Smart Pharma-related balance-bridge discrepancy hard-blocks sign-off
  (`RECONCILIATION.md` §5) — never written off without an approved exception referencing
  specific evidence.

## 9. Restart recovery

- Restart the worker at any time; it resumes from durable state (`HERMES_WORKER.md`
  §3). No manual state repair is normally required.
- After a restart, verify: no run is stuck `CLAIMED` past `claim_expires_at` without
  progressing; `GET /api/worker/health` reports a recent successful cycle; items claimed
  by the dead instance have completed or reverted to `QUEUED` after claim expiry.
- A permanently stuck row past its claim TTL is a claim-expiry bug, not something to fix
  by manually editing rows.

## 10. Incident containment (general)

For any suspected credential compromise, unexpected posting behavior, or data-integrity
concern:

1. **Pause the queue** — pause every affected batch (§1); if the concern is systemic,
   pause all batches for the affected organisation.
2. **Revoke credentials** — rotate the Books (and, later, WorkDrive) OAuth credential
   immediately; confirm the old refresh token no longer works.
3. **Identify affected batches** — use the audit trail (`GET /api/audit`) and
   `api_attempts` records, filtered by correlation ID and time window, to enumerate
   exactly which batches/queue items were active during the incident window.
4. **Reconcile before resume** — run Layer C and the balance bridge for every
   identified batch before resuming or re-enabling posting; do not assume the incident
   caused no financial effect without this evidence.
5. Document the incident, root cause, and remediation in the exception/audit trail
   before closing — closing an exception must never erase its history
   (`PROJECT_CONTEXT.md`).

## 11. Importing a ledger-table delivery from a cloud session

Where the branch files are (Zoho WorkDrive, team "Upsourced Consultancy Services Pvt Ltd",
workspace "Prospecting - Client SOW"):

- `FRANKROSS / TRANSACTIONAL DATA MIGRATION / branch-extract_data / tripura / <branch>`:
  `Ledger_01042026_to_05072026.xlsx`, `Closing_tb_report_05072026.xlsx`,
  `opening_tb_report_31032026.xlsx` (branches 460 to 469; 460 and 461 verified on 2026-10-09).
- `FRANKROSS / TRANSACTIONAL DATA MIGRATION / ECOGREEN_TABLE DATA / <branch>`: the older raw
  table dumps (`jv_det.csv`, `set_det.csv`, ...), plus `Transaction_Prefix_Mapping.xlsx` and the
  Rule Book for the ledger-table format.

Steps (real data stays under `var/`, which is gitignored):

1. Download the three ledger-table files through the WorkDrive connector into
   `var/raw<branch>/run-in/` as `ledger.xlsx`, `closing_tb.xlsx`, `opening_tb.xlsx`. A 4-column
   opening file (`Act Code, Description, Op.Debit, Op.Credit`) is not the report format and must be
   left out of the folder; the normaliser then skips the 31 March check.
2. Write `var/profiles/<branch>-ledger-table.json` from
   `config/source-profiles/ecogreen-ledger-table.example.json`: `branch_code`, window
   `2026-04-01` to `2026-07-05`, `prefix_types` from the branch's prefix sheet (Zoho-pushed
   prefixes so far: `J` JOURNAL, `Q` PAYMENT, `211` RECEIPT, `213` PAYMENT, `F` CONTRA).
   Leave `credit_sign` and `date_typed_cells` on `auto`; the report says what was detected.
3. `node scripts/normalise-ecogreen.js --in var/raw<branch>/run-in --profile var/profiles/<branch>-ledger-table.json --out var/inbox-real`.
   Expect `unbalanced_vouchers` empty, `trial_balance_ties.all` true and `bridge.ties` true before
   going further. Branch 460 (749 vouchers) and 461 (589 vouchers) both meet this.
4. Import into the hosted console. In a cloud session the bearer token is a network secret that
   the egress proxy injects on requests to the console host, so the process never holds it:
   `node scripts/import-run.js --dir var/inbox-real/<branch>/<run-id> --url https://<console-host> --proxy-auth --branch-name "Branch <branch>"`.
   The job reports INGEST, LAYER_A and CLASSIFY_TRANSFORM; vouchers come out BLOCKED until mapping
   rules are approved. The import endpoint cannot post to Zoho Books.
5. For a run whose mapping is already approved, `POST /api/runs/:id/retransform` applies the rules.
   This needs a human operator or admin token. The proxy-injected console token is a bot
   principal, and bots may only pause/resume batches, retry queue items and assign exceptions
   (`src/server/routes/agent.js`), so a cloud session gets `403 BOT_CEILING:retransform`. Ask the
   owner to click "Re-apply mapping to the latest run" (branch page, step 3) instead.
   Re-transform releases vouchers blocked at transform (`UNMAPPED_ENTITY`) and vouchers blocked
   at classification for a missing voucher-type route (`UNMAPPED_MODULE`) once that route is
   approved; the rest are re-checked and stay blocked with their exception open.

Re-importing a branch whose normalised `transactions.csv` / `trial_balance.csv` are byte-identical
to an earlier run is refused at INGEST (`DUPLICATE_FILE`, file sha256 already registered). That
attempt leaves a `VALIDATION_FAILED` run row with no vouchers, marked `error_code =
DUPLICATE_FILE`. The branch summary and branch page skip such a row (`src/core/runs.js`), so the
earlier run stays the current one; act on that run. Compare `sha256sum` of the two CSVs with the
existing run before uploading to avoid the extra row.
