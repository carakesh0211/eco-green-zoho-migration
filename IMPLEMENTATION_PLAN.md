# IMPLEMENTATION_PLAN.md — Eco Green to Zoho Books Migration Pilot

Status: **MVP scaffold complete on synthetic data (waves 1–2 + bridge fix); production posting disabled; no real data received**. This plan tracks the rapid-MVP pilot described in
`PROJECT_CONTEXT.md`, `CLAUDE_IMPLEMENTATION_PROMPT.md`, and the module contracts in
`CONTRACTS.md`/`DATA_CONTRACT.md`. Code for the modules below is being written
concurrently by other agents against `CONTRACTS.md`; this plan does not claim any
module is finished, tested, or deployed unless the evidence column says so.

## 1. Confirmed facts

- Workspace was not a git repository at plan time; Node 24.13 and Catalyst CLI 1.27.2 present locally; `gh` authenticated.
- The RapGuru Tally migration tool exists locally: Node/Express + SQLite/Catalyst Data Store dual adapter, React/Vite UI, `node --test`, a 22-table Catalyst schema verified against a live Catalyst Development project (India DC).
- Hermes is the open-source `hermes-agent` AI framework, installed locally as a desktop app. No deterministic worker code existed before this repository — `src/worker` is that worker.
- A RapGuru VPS exists and is reachable by SSH.
- The connected Zoho Books credential can see several RapGuru client orgs but **not** the Eco Green org.
- A free-plan sandbox org `UT_Test` exists and could be used read-only for baseline tests, subject to owner authorization.
- No WorkDrive credential is configured in this environment.
- No Eco Green CSV, trial balance, manifest, cutover dates, or mappings have been received; `DATA_CONTRACT.md` is a synthetic placeholder, not the real Eco Green schema.
- MVP architecture decisions already made (not open): single Node package/modular monolith; `node:sqlite` locally behind a Data Store adapter boundary; local-folder inbox with a WorkDrive stub; local immutable archive with a Stratus stub; mock Books driver by default; `POSTING_ENABLED=false` plus an org allowlist as a hard posting guard; plain-HTML console (no framework/build step); Hermes/bot reach the system only through the governed HTTP API (§H/§G).

## 2. Assumptions (ASSUMED — revisit when contradicted by evidence)

- ASSUMED: the Tally tool's 60–70% conceptual reuse estimate is directional only; §7's reuse matrix reflects module-level intent from `CONTRACTS.md`, not a line-count audit.
- ASSUMED: a new Catalyst project (India DC, Development first) is preferable to reusing the Tally tool's project, to avoid mixing an unrelated client's schema/data — a recommendation, not a decision (D-1).
- ASSUMED: `UT_Test` is suitable only for read-only Books API shape/latency checks, never anything resembling Eco Green data.
- ASSUMED: the VPS runs the Hermes worker under a standard supervisor (`systemd` or `pm2`); nothing installed or verified there yet.
- ASSUMED: WorkDrive endpoint names in `WORKDRIVE_INGESTION.md` follow the general API shape; each needs re-verification against current docs before implementation (marked TODO there).

## 3. Open decisions (owner placeholders)

| ID | Decision needed | Owner |
|---|---|---|
| D-1 | New Catalyst project vs. reuse the Tally tool's existing project | Project owner |
| D-2 | Public repository name and license | Project owner |
| D-3 | Which one/few branches, CSV format, and trial balance will be used for the pilot | Eco Green team + Project owner |
| D-4 | Real Eco Green query inventory, CSV schemas, keys, and control reports | Eco Green team |
| D-5 | Smart Pharma go-live dates, posting grain, and stable Books identifiers per branch | Smart Pharma vendor |
| D-6 | Reconciliation tolerances, exception write-off authority, and sign-off roles | Finance lead |
| D-7 | Confirmed Books plan, org ID(s) for pilot, API limits, and enabled locations | RapGuru ops + Project owner |
| D-8 | Whether `UT_Test` may be used at all, and under what data restrictions | RapGuru ops |
| D-9 | VPS process manager, log retention, and access control for the Hermes worker | RapGuru ops |
| D-10 | Segregation-of-duties enforcement exceptions, if any, for the pilot | Finance lead |

## 4. Rapid-MVP scope (in)

- One agreed synthetic CSV/manifest format (`DATA_CONTRACT.md` v1), one pilot branch fixture (`PILOT01`).
- Local-folder inbox pickup, manifest/schema/hash/duplicate validation, immutable local archive (§I/§R/§C/§V).
- Branch/date/ledger/voucher-type summarisation and Layer A reconciliation (§M).
- Cutover evaluation, Smart Pharma overlap classification, Layer B bridge (§K).
- Versioned mapping rules, dry-run transformation preview, no live posting (§T).
- Batch creation, role-checked approval with SoD, immutable scope hash (§B).
- Mock Books driver, queue executor, retry/backoff/unknown-outcome handling (§Z/§Q).
- Layer C reconciliation and the live-balance bridge against the mock driver (§Y).
- Exceptions as first-class, deduplicated, auditable records (§X).
- A single-process worker loop, idempotent on restart (§W).
- A minimal HTTP API and single-page plain-HTML console with drilldown links (§H).
- A governed, read-mostly bot/MCP surface bound to console authorization (§G).
- Fixture seeding and a dry-run pipeline script (§P).

## 5. Explicitly deferred hardening (out) — acceptance gate that reopens each

| Deferred item | Reopens when |
|---|---|
| Live Zoho Books posting | `POSTING_ENABLED=true`, a non-empty `POSTING_AUTHORIZATION_REF`, an allowlisted org ID, and written finance/project-owner authorization all exist together |
| Real WorkDrive adapter (currently `NOT_CONFIGURED`/`NOT_IMPLEMENTED` stub) | WorkDrive credentials are supplied and the API surface in `WORKDRIVE_INGESTION.md` is verified against current Zoho docs |
| Catalyst Stratus/Data Store adapters (currently stubs) | A Catalyst project decision (D-1) is made and the target project/environment exists |
| Real Eco Green CSV schema and control reports | Eco Green team supplies query inventory and signed control reports (D-4) |
| Smart Pharma evidence feed beyond the synthetic fixture | Smart Pharma vendor supplies posting facts and stable references (D-5) |
| ~351-branch scale, volume/performance testing (see `docs/CAPACITY_REVIEW.md`) | Pilot branch(es) succeed end-to-end and finance signs off on the pilot pattern |
| Full RBAC/user directory beyond the local hashed-token file | An identity provider or Catalyst Authentication integration is agreed |
| Multi-branch/multi-worker horizontal scaling | Single-worker pilot throughput is proven insufficient |
| Formal retention/backup/restore/RTO-RPO procedures | Retention and recovery targets are agreed (open in `PROJECT_CONTEXT.md`) |

## 6. Workstreams and tasks

Each task cites the `CONTRACTS.md` section it implements. Status is **in progress
(wave 1)** for every task; none are claimed complete, tested against real data, or
deployed. Format: Purpose · Prereqs · Invariants · Tests · Evidence · Definition of done.

**WS1 — Core primitives and store (§S/§L/§A).** Durable state, redacted logging,
append-only audit. Prereqs: none. Invariants: no floats for money; every write audited;
secrets never logged. Tests: unique-violation semantics, atomic `claim`/`releaseClaim`,
redaction of token-like fields. Evidence: `node --test test/` for `store`/`log`/`audit`.
DoD: SQLite adapter passes all store-contract tests offline; Catalyst stub documented
only.

**WS2 — Ingestion pipeline (§I/§R/§C/§V).** Pick up a complete run, validate, archive
immutably, stage. Prereqs: WS1. Invariants: partial folders never picked up; duplicate
manifest/file hashes rejected, not reprocessed; archive idempotent on same sha256,
rejects on conflicting sha256. Tests: malformed CSV, wrong encoding, size/hash mismatch,
duplicate manifest/file, orphaned ledger code, unbalanced voucher, duplicate
`(voucher_id, line_no)`. Evidence: `DATA_CONTRACT.md` §8 fixture reproduced by
`node --test` and `scripts/run-pipeline.js --dry-run`. DoD: all nine fixture defects
produce the documented outcome/exception.

**WS3 — Summarisation and Layer A (§M).** Branch/ledger/voucher-type summaries, source
TB reconciliation. Prereqs: WS2. Invariants: `opening + period − closing = 0` within the
TB itself; summaries reproducible from `source_txn_lines`. Tests: exact-match pass,
deliberate diff, `PASS_WITH_APPROVED_EXCEPTIONS` only when every diff has an approved
exception referencing it. Evidence: `recon_runs`/`recon_results` rows matching
`RECONCILIATION.md` control keys. DoD: fixture run reports exactly the diffs the corrupt
vouchers were designed to cause.

**WS4 — Cutover, overlap, Layer B bridge (§K).** Eligibility, Smart Pharma
classification, CSV-to-population bridge. Prereqs: WS3. Invariants: amount-only/date-only
never counts as overlap evidence; most-specific cutover row wins; any `PENDING`
disposition fails the bridge. Tests: covered+evidence, covered+no-evidence, partial,
unknown coverage, late/back-posted, missing rule, inventory-control-only. Evidence:
`overlap_candidates` and Layer B `recon_results`. DoD: `DATA_CONTRACT.md` §8 overlap
fixtures each land in the documented disposition/classification.

**WS5 — Mapping and transform preview (§T).** Versioned mapping resolution, Books-shaped
dry-run payloads. Prereqs: WS4. Invariants: only `MIGRATE` vouchers transformed; missing
ledger/party/payment-mode mapping blocks with `UNMAPPED_ENTITY`, never a silent default;
journal routing only for `voucher_type = JOURNAL` or an approved exception rule. Tests:
each module shape, unmapped `SALES_B2C` → `UNMAPPED_MODULE`, re-run idempotency. Evidence:
`preview_payloads` and `humanSummary` output. DoD: every fixture `MIGRATE` voucher has one
preview payload per version pair; nothing is ever sent anywhere.

**WS6 — Batch and approval (§B).** Immutable batch scope, role-checked approval, SoD.
Prereqs: WS5. Invariants: approval recomputes/compares `scope_hash`; input drift
invalidates approval; approver ≠ preparer when `SOD_ENFORCED=true`. Tests:
approve-then-mutate invalidation, self-approval rejection, enqueue only from `APPROVED`.
Evidence: `migration_batches`/`approvals` rows and audit trail for a full
draft→approve→enqueue cycle. DoD: a batch cannot reach `QUEUED` without a live,
un-invalidated approval matching the current scope hash.

**WS7 — Books adapter and queue executor (§Z/§Q).** Mock/live client, org-wide rate
limiting, retry/backoff, unknown-outcome handling. Prereqs: WS6. Invariants:
`assertPostingAllowed()` blocks the live driver unless all four §Z gates hold;
`UNKNOWN_OUTCOME` never auto-retried; attempts durable before the network call. Tests:
mock fault injection (4xx/5xx/429/timeout-after-send), concurrent claim race, attempt cap
→ `DEAD_LETTER`. Evidence: `api_attempts`/`queue_items` state against the mock driver
only. DoD: no path causes a live network call; every outcome matches `states.js`.

**WS8 — Layer C and balance bridge (§Y).** Reconcile posted population against
migration-tagged Books records; prove the live balance bridge. Prereqs: WS7. Invariants:
only stable-tagged records count as "migration population"; unexplained movement blocks
sign-off. Tests: present/missing/duplicate/unexpected/partial cases against the mock
driver. Evidence: `books_snapshots` (BASELINE/POST_RUN) and Layer C/`BALANCE_BRIDGE`
`recon_runs`. DoD: fixture bridge nets to zero unexplained movement, or produces the
expected `TARGET_MISMATCH` when deliberately perturbed.

**WS9 — Exceptions (§X).** First-class, deduplicated, auditable records across every
workstream. Prereqs: WS2–WS8 raise into this module. Invariants: `dedupe_key` prevents
duplicate rows on rerun; `RESOLVED` rows reopen, never deleted; `APPROVED_EXCEPTION`
requires approver/admin. Tests: rerun does not duplicate an open exception; resolve/
re-open preserves history. Evidence: exception counts by category matching
`DATA_CONTRACT.md` §8. DoD: every fixture defect produces exactly one exception row of
the documented category/severity.

**WS10 — Worker loop (§W).** Single deterministic cycle: ingest → summarise → recon A →
classify → transform → recon B → drain queue → resolve unknown outcomes. Prereqs:
WS2–WS9. Invariants: every step keys off durable status so a restart resumes rather than
reprocesses/skips; expired claims reclaimable. Tests: kill-and-restart mid-run, two
workers racing the same claim. Evidence: `runOnce` test output plus dry-run pipeline
report. DoD: a restarted worker converges to the same terminal state as an uninterrupted
run.

**WS11 — HTTP API and console (§H).** Role/branch-scoped API, single-page plain-HTML
console. Prereqs: WS1–WS10. Invariants: server-side role/branch enforcement on every
route; no route can flip `POSTING_ENABLED`; every mutating call audits a correlation ID.
Tests: cross-branch denial, role-gated mutating routes, correlation ID propagation.
Evidence: route-level tests plus a manual console walkthrough against fixtures. DoD:
every console number links to its drilldown endpoint; unauthorized calls return 403 with
a `DENIED` audit row.

**WS12 — Governed bot/MCP surface (§G).** Read routes plus a narrow, pre-approved
mutating subset for Hermes/bot callers. Prereqs: WS11. Invariants: bot role ceiling
`operator`, never `approver`; CSV/exception text returned marked `untrusted: true`; no
shell/DB access exposed. Tests: role-ceiling enforcement; injected exception text does
not alter authorization behavior. Evidence: documented route list in
`BOT_AND_MCP_SECURITY.md` cross-checked against router source. DoD: the bot cannot reach
any route absent from the documented allowlist.

**WS13 — Fixtures and scripts (§P).** Reproducible synthetic fixtures, dry-run pipeline,
pre-publish secret scan. Prereqs: none. Invariants: fixtures contain no real people,
companies, GSTINs, or amounts; `check-secrets.js` exits non-zero on any hit. Tests:
secret scan against a deliberately seeded secret-like string. Evidence: `npm run
check:secrets` output before any push. DoD: `fixtures:seed` and `pipeline:dry-run` both
complete against `DATA_CONTRACT.md` §8 with the documented outcomes.

**WS-D -- Branch Control Dashboard (§D).** Denormalised per-branch summary, server-side
search/filter/sort/pagination, CSV export. Prereqs: WS1-WS9 (summary fields derive from
their tables). Invariants: `branch_summaries` <= `EXPECTED_BRANCH_COUNT` rows in normal
operation; every field reproducible from source tables; browser never receives more
than one page. Tests: filter/sort/pagination correctness against a seeded set exceeding
one ZCQL page; CSV export matches the filtered/sorted set. Evidence:
`docs/CAPACITY_REVIEW.md` row projections; route tests for `/api/branches*`. DoD:
dashboard renders the full ~351-branch scenario within the 300-row/2-page ZCQL budget
with no client-side pagination fallback.

**WS-U -- Team, assignments, and authentication (§U/§E).** `app_users` directory,
`branch_period_assignments`, SoD checks, `AUTH_MODE` (token/Catalyst). Prereqs: WS1
(store), WS6 (existing SoD pattern). Invariants: operator != approver per assignment;
optimistic-lock `version` conflicts return 409; bot principals never authenticate via
Catalyst; plaintext bot tokens returned exactly once. Tests: SoD violation rejected,
stale-version write rejected, bot-cannot-hold-approver-role, mixed `AUTH_MODE` fallback.
Evidence: `CONTRACTS.md` §U/§E route tests; audit rows for invite/rotate/reassign. DoD:
no route allows an operator to also be recorded as approver on the same assignment,
under either auth mode.

**WS-N -- Zoho Books connection (§N).** `books_connections`/`books_locations`, OAuth
connect flow, six independent controls. Prereqs: WS7 (existing Books adapter/guard).
Invariants: `secret_ciphertext` only, never a plaintext secret in any response/log;
connecting Books never sets `BOOKS_READ_AUTHORIZED` or `POSTING_ENABLED`; a live read is
refused without `BOOKS_READ_AUTHORIZED=true`. Tests: OAuth state mismatch rejected; read
attempted without authorization flag refused; disconnect preserves history. Evidence:
`CONTRACTS.md` §N route tests; `SECURITY.md` secret-handling checklist. DoD: all six
controls in `ARCHITECTURE.md` §7.3 are independently toggleable in tests, none implying
another.

**WS-C -- Capacity and archival planning (planning workstream, no code contract).**
Produce `docs/CAPACITY_REVIEW.md`: row/scenario projections, Catalyst Development and
Production plan limits, Stratus/Data Store placement decision, archival/purge strategy,
Books API throughput estimate. Prereqs: none (uses the `PILOT01` fixture and published
Catalyst/Books limits). Invariants: every number is either sourced from this repo's own
fixture/observed limits or cited with a URL and access date; every place the review does
not know a real number, it says so explicitly rather than guessing. Tests: n/a
(documentation workstream). Evidence: `docs/CAPACITY_REVIEW.md` itself, cross-checked
against `docs/CATALYST_REFERENCES.md`. DoD: the review's row projections are approved by
the owner before any real (non-synthetic) ingestion begins ("APPROVAL REQUIRED" block,
§8).

## 7. Reuse matrix (RapGuru Tally tool → this pilot)## 7. Reuse matrix (RapGuru Tally tool → this pilot)

| Component | Disposition | Notes |
|---|---|---|
| Zoho OAuth client | REUSE | Token refresh/encryption pattern ported into `src/books/live.js`; Tally specifics dropped |
| Sliding-window rate limiter + backoff | REUSE | Ported into `src/books/limiter.js`; scoped per organisation, not per branch |
| Push slice / idempotency executor pattern | REUSE | Basis for `src/worker/executor.js` (§Q) |
| Audit log with Stratus overflow | REUSE | Basis for `src/core/audit.js` (§A); Stratus target is a stub until D-1 is resolved |
| Jobs queue | REUSE | Basis for `queue_items`/`api_attempts` design |
| Batch confirm gate | REUSE | Basis for §B approval/segregation-of-duties |
| Catalyst IaC/schema-compare tooling | REUSE | Applies once a Catalyst project exists (D-1) |
| CATALYST_NOTES verified platform limits | REUSE | Encoded directly into `ARCHITECTURE.md` design constraints |
| Staging, mapping engine, transform, reconciliation, RBAC, UI shell | ADAPT | Reworked for Eco Green's canonical model, three-way reconciliation, and the plain-HTML console |
| Tally XML/Excel source connector | REPLACE | Replaced by the CSV/manifest connector in `DATA_CONTRACT.md` |
| "every voucher → journal" fallback | DO NOT INHERIT | This pilot requires explicit `MODULE_ROUTE` mapping; journal is only for `voucher_type = JOURNAL` or an approved exception |
| No `UNKNOWN_OUTCOME` state | DO NOT INHERIT | This pilot adds `UNKNOWN_OUTCOME` with mandatory target lookup before retry (§Z/§Q) |

## 8. Dependencies

- WS2 depends on a real or fixture-complete inbox folder; WS3–WS9 depend sequentially on the run reaching each prior state.
- WS7 (live driver) depends on Books OAuth credentials, an allowlisted org ID, and D-7.
- Any Catalyst-backed adapter (Stratus, Data Store) depends on D-1.
- WorkDrive adapter depends on WorkDrive credentials (currently absent).
- Pilot execution against real data depends on D-3, D-4, and D-5.
- Production posting depends on all items in §5's first row simultaneously.

## 9. Risks

| Risk | Impact | Likelihood | Mitigation | Owner | Status |
|---|---|---|---|---|---|
| Real Eco Green schema differs from `DATA_CONTRACT.md` v1 | Rework of connector, mappings, fixtures | High | Contract is versioned; connector/fixtures regenerate on version bump | Eco Green team | Open |
| Smart Pharma evidence unavailable at pilot time | Overlap gate cannot clear `SALES_B2C` | High | Fixture proves the `PARTIAL_OR_AMBIGUOUS_OVERLAP` block works; class stays blocked | Smart Pharma vendor | Open |
| Catalyst decision (D-1) delayed | Stratus/Data Store stay stubs | Medium | SQLite/local path is fully functional for pilot scope | Project owner | Open |
| Accidental live posting in dev | Duplicate/incorrect live postings | Low (4 gates) | `POSTING_ENABLED`+allowlist+auth ref+live driver all required, default false, no API route can flip it | RapGuru ops | Mitigated by design, untested live |
| No WorkDrive credentials | Cannot validate real adapter surface | High | Local inbox exercises the same `Inbox` interface; stub documents required calls | RapGuru ops | Open |
| VPS hardening undefined (D-9) | Restart behavior unverified in real target | Medium | Restart/claim logic is adapter-agnostic, covered by WS10 tests locally | RapGuru ops | Open |
| SoD exception requested under time pressure | Approval control weakened | Low | `SOD_ENFORCED=true` default; exception needs Finance sign-off (D-10) | Finance lead | Open |

## 10. Acceptance evidence per gate

| Gate | Required evidence |
|---|---|
| Ingestion accepted | `extraction_runs.status = ARCHIVED` or later, with `manifest_sha256` and per-file `sha256` recorded |
| Layer A pass | `recon_runs` row, layer `A`, status `PASS` or `PASS_WITH_APPROVED_EXCEPTIONS` with linked `exceptions` |
| Layer B pass | `recon_runs` row, layer `B`, zero `PENDING` dispositions, bridge controls all `MATCH` |
| Batch approved | `approvals` row with `scope_hash` equal to the batch's current `scope_hash`, approver role `approver`/`admin`, approver ≠ preparer |
| Migration executed (mock only in this wave) | `queue_items`/`api_attempts` rows and `vouchers.zoho_record_id` populated from the mock driver |
| Layer C pass | `recon_runs` row, layer `C`, no missing/duplicate/unexpected target records against `searchByMigrationTag` |
| Balance bridge pass | `recon_runs` row, layer `BALANCE_BRIDGE`, zero unexplained movement |
| Production posting authorized | Written authorization reference in `POSTING_AUTHORIZATION_REF`, allowlisted org ID, and all prior gates passed for that scope — not yet issued |

## 11. Status log

- **2026-09-14** — Plan created. Wave 1 in progress: contracts (`CONTRACTS.md`, `DATA_CONTRACT.md`) and schema (`src/adapters/store/schema.sql`, `src/core/states.js`) are defined; module implementation is proceeding concurrently against these contracts. No workstream is complete, tested end-to-end, or deployed. No real Eco Green data has been received. Production posting remains disabled by configuration default and by the absence of any authorization reference.
- **2026-09-14 (later)** — Waves 1–2 delivered and verified locally by the lead (not by sub-agent report alone):
  - `node --test`: **351 tests, 351 pass, 0 fail** (offline; `node:sqlite` experimental warning only).
  - `node scripts/run-pipeline.js --branch PILOT01 --run run-001 --dry-run --approve-known-diffs --through-mock-books` on the synthetic branch: ingest `STAGED`; Layer A `FAIL` with exactly the 7 controls documented in `fixtures/.../EXPECTED.md`; after approving those 7 as `finance.lead` (approver role) Layer A re-runs to `PASS_WITH_APPROVED_EXCEPTIONS`; dispositions MIGRATE 31 / SMART_PHARMA_EXCLUDED 3 / BLOCKED 4 / OTHER_EXCLUDED 2 (total 40); Layer B `PASS` including file→population bridge with a `REJECTED_ROWS` bucket for the rejected duplicate line; preview payloads across 8 Books modules (no journal fallback); two period batches created by `operator.local`, approved by `finance.lead` (SoD enforced), enqueued, posted to the **mock** driver (31/31 `POSTED`), Layer C `PASS`, balance bridge `PASS`.
  - Re-run is idempotent (`DUPLICATE_MANIFEST`); `run-002-dup` (same transactions sha256) is rejected (`VALIDATION_FAILED`).
  - `node scripts/check-secrets.js`: clean. Git initialised locally (`main`), no remote, nothing pushed; `.gitattributes` pins LF and marks fixtures binary so manifest sha256s survive Windows checkouts.
  - Defects found and fixed during lead review (each with a regression test): (1) `transform.js` put the party/payable leg into `bill`/`credit_note`/`vendor_credit` line items (double-counted totals; would have posted the payable ledger as an expense) — now only the content side is emitted and it must tie to the party side; (2) `recon_a.js` flagged an opening-balance-only ledger (`txn_count 0`) as `missing_in_csv`; (3) `bridge.js` required the whole population to balance, which made Layer B unpassable whenever an unbalanced voucher was correctly quarantined in `BLOCKED` — replaced by "no unbalanced voucher outside BLOCKED" plus file-to-population controls; (4) balance bridge was unprovable because the mock ledger had no per-account balances and movement used an ad-hoc heuristic — replaced by shared `src/books/gl_effects.js` double-entry rules used by both the mock ledger and the bridge.
  - Known limitations carried forward (not defects): `PAYMENT_MODE:<mode>` is a proxy account until a PAYMENT_MODE→ledger mapping is approved; `mapping_version` selection is lexicographic (`map_v10` < `map_v9`) — fine for the pilot, must become numeric before multiple versions coexist; live Books endpoint shapes in `src/books/live.js` are marked `TODO(verify-against-zoho-docs)` and untested against any org; WorkDrive and Stratus adapters are stubs; console verified manually only.
  - Still blocked on owner/Eco Green inputs: real CSV/TB/manifest format, per-branch cutover dates, Smart Pharma Books identifiers, finance-approved module and ledger mappings, Eco Green Books org access, WorkDrive credentials, pilot branch choice, public repo name/license, Catalyst project decision.
- **2026-09-14 (Catalyst slice)** — Catalyst Development vertical slice, verified by the lead:
  - Docs verified and recorded with access dates in `docs/CATALYST_REFERENCES.md` (SDK `zcatalyst-sdk-node` 3.4.0 chosen; modular `@zcatalyst/*` is 0.0.x). Finding: the SDK runs outside Catalyst only with `CATALYST_AUTH` (OAuth self-client refresh token) + `CATALYST_CONFIG` — not provisioned, so live smoke ran through the authenticated Catalyst MCP against the real Development tables; the SDK transport is contract-tested against a Catalyst-shaped fake.
  - Live Development resources created in project EcoGreenMigration: 9 Data Store tables (audit_events, extraction_runs, source_files, vouchers, source_txn_lines, source_summaries, recon_runs, recon_results, exceptions; 168 columns) from `catalyst/iac/schema.catalyst.js` via the generator's `--emit-columns` bodies. Identifiers are kept only in the gitignored `var/iac/live-ids.json` and in reports.
  - Live smoke (audit_events): one clearly synthetic row inserted (`actor smoke:synthetic-tester`, `entity_id SYNTHETIC-0001`), read back by row id, and found by ZCQL on `correlation_id`. Observed shapes recorded (ROWID number on insert / string on read; ZCQL wraps rows as `[{table:{…}}]`; `text` capped at 10,000).
  - Code: `src/adapters/store/catalyst.js` (+ `catalyst_fake.js`, `catalyst_types.js`) implementing §S with append-only enforcement for `audit_events`, ZCQL pagination past the 300-row cap, identifier whitelist; `src/adapters/archive/stratus.js` (+ `stratus_fake.js`) with content-addressed immutable keys and integrity verification on read; 36 new contract tests; suite **398/398**.
  - Platform limits discovered: `claim()` is not atomic on Data Store (`claimSemantics: 'BEST_EFFORT'` — no multi-instance worker on this adapter); `insertMany` is not atomic; Development quota 5,000 rows/table, 25,000/project; ZCQL 300 rows/query; 100 columns/table.
  - **Blocked:** Stratus bucket creation returns `OPERATION_NOT_ALLOWED — user needs to be in session when accessing Stratus for the first time`; the owner must open Stratus once in the console for the project. Bucket (`ecogreen-pilot-evidence-dev`: protected, encryption, versioning, audit) and the live Stratus smoke are pending that action.
- **2026-09-15 (Stratus live)** — Stratus activated and proven on Development:
  - Owner opened Stratus in the console (one-time session requirement); bucket `ecogreen-pilot-evidence-dev` created through the console form (protected, encryption, versioning, audit on; caching disabled — confirmed via `Get_Bucket_Details`). AppSail env now `ARCHIVE_ADAPTER=stratus`, `STRATUS_BUCKET=ecogreen-pilot-evidence-dev`; `/api/health` reports `archiveAdapter: "stratus", archiveStatus: "ENABLED"`.
  - Live smoke (`POST /api/dev/archive-smoke`, admin + Development + `DEV_SEED_ENABLED`, synthetic CSV under branch `SMOKE01`): first run 6/7 — `put_different_bytes_rejected` returned `NO_ERROR_THROWN`. Root cause: the adapter's immutability scan assumed a Table-style `listPagedObjects` response (`objects[].object_key`, `more_records`/`next_token`) and sent `nextToken`; the real SDK takes `continuationToken` and returns `{ truncated, next_continuation_token, contents: StratusObject[] }` (key at `keyDetails.key`), so live Stratus looked empty and a different-bytes put was allowed. The fake mirrored the wrong guess, so the suite could not catch it.
  - Fix (commit `48ffc44`): adapter reads the verified contract, follows `next_continuation_token` while `truncated === 'true'`, and fails closed (`LIST_SHAPE_UNEXPECTED`) when `contents` is not an array; the fake now returns the exact real shape and rejects unknown option names; 4 regression tests (real-shape conflict, multi-page scan, fail-closed on the old shape, fake option guard). Suite **461/461**. Contract recorded in `docs/CATALYST_REFERENCES.md`.
  - Redeployed (`buildSha 8aab133`, health `archiveAdapter: stratus`, `archiveStatus: ENABLED`) and re-ran the live smoke: **7/7 PASS** (put, exists, get sha-verified, same-bytes idempotent, different-bytes rejected with `IMMUTABLE_CONFLICT`, original intact after conflict, unwritten uri absent) — run `smoke-95c3618a31e0` under `SMOKE01/`. Bucket listing (`Get_All_Objects`, prefix `SMOKE01/`) is the before/after proof: the pre-fix run `smoke-864d5454aa75` holds **two** objects (94-byte original plus the 65-byte different-bytes file that leaked through), the post-fix run `smoke-95c3618a31e0` holds exactly **one**. All three are synthetic and remain as evidence; delete only on owner instruction.
- **2026-09-15 (increment 2 started)** -- Team-operable console workstreams
  (WS-D/WS-U/WS-N/WS-C) started, implemented concurrently by other agents against
  `CONTRACTS.md` §U/§D/§N/§E and the 5 new Data Store tables already defined in
  `src/adapters/store/schema.sql` (`branch_summaries`, `app_users`,
  `branch_period_assignments`, `books_connections`, `books_locations`; schema now 25
  tables total). Branch-count scope corrected from the earlier approximately-326
  estimate to approximately 351 everywhere across the documentation set
  (`docs/CAPACITY_REVIEW.md` created for the resulting capacity/throughput analysis --
  APPROVAL REQUIRED before any real ingestion). No increment-2 route or table is claimed
  complete, tested end-to-end, or deployed by this entry alone -- verify against code on
  merge.
