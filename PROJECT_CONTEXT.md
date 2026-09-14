# Eco Green to Zoho Books Migration & Reconciliation Platform

## Document purpose

This file is the authoritative project context for planning, implementation, and review. It records the currently confirmed business and architecture decisions for the Eco Green migration. It is not a substitute for signed accounting rules, extraction specifications, or cutover approval.

When repository code, an implementation plan, or an informal discussion conflicts with this document, the conflict must be raised and resolved explicitly. Do not silently reinterpret the scope.

## Project summary

Eco Green is the legacy source application. Accounting and inventory data is held in MySQL, but the migration team does not have a direct application-level source connector. Data can be obtained only by running the Eco Green team's existing extraction queries and exporting the results as CSV files.

The target is one live Zoho Books organisation containing approximately 326 branches represented as Books locations. The historical migration period begins on 1 April 2026. Smart Pharma/live Books activity began from June 2026 for some branches and August 2026 for others, with additional branches moving in phases. Therefore migration eligibility and reconciliation must be controlled by a branch-wise, and where necessary transaction-class-wise, cutover matrix rather than one organisation-wide end date.

Smart Pharma is the new WMS/POS for all branches. It is already integrated with Zoho Books and posts inventory-related, summarized B2C accounting data grouped by date and payment/receipt method. Therefore this project is primarily a historical accounting migration and reconciliation platform. It must not repost inventory or B2C populations already posted by Smart Pharma.

Zoho Catalyst will be the staging, transformation, reconciliation, exception, approval, migration-control, and audit hub. WorkDrive will be the controlled CSV landing zone, Catalyst Stratus will retain the immutable evidence copy, and a deterministic Hermes worker on the VPS will perform pickup, validation, transformation, reconciliation, and governed Books delivery. The user interface must be a lightweight, crisp, one-time migration control console rather than a large permanent product. The existing RapGuru Tally migration tool should be reused and refactored into a source-pluggable migration engine rather than replaced with an unrelated new system.

## Confirmed decisions and constraints

- Source: Eco Green MySQL, accessed only through existing extraction queries whose outputs are CSV files.
- File landing: extracted CSV files and manifests arrive in a controlled Zoho WorkDrive folder; WorkDrive is an inbox, not the immutable system of record.
- Worker: Hermes on the VPS performs deterministic pickup, parsing, summarisation, mapping, reconciliation, and approved migration work. MCP/LLM calls are not the per-record execution path.
- Scale: approximately 326 branches, with data beginning 1 April 2026.
- Target topology: one Zoho Books organisation with approximately 326 branches/locations.
- Live-target constraint: Zoho Books is already live. Some branches have captured new-system activity from June 2026, some from August 2026, and others begin as they are phased in.
- Cutover rule: maintain an explicit branch and transaction-class cutover matrix. The default historical window is from 1 April 2026 through the day before the verified live-system start date, subject to signed coverage rules and gap/overlap investigation.
- New operational system: Smart Pharma, serving as WMS/POS and already posting summarized inventory-related B2C/payment-method/date-wise data to Zoho Books.
- Migration emphasis: historical accounting, opening/outstanding balances where applicable, and end-to-end reconciliation.
- Duplicate-prevention rule: do not migrate Eco Green inventory/B2C transactions already represented by Smart Pharma postings.
- Platform: Zoho Catalyst as the migration control hub.
- Catalyst components: Stratus for immutable/raw files, Data Store for structured operational data, AppSail/services for application and processing workloads, and Job Scheduling for queued/background work, subject to detailed design and current platform limits.
- Reuse strategy: refactor the RapGuru Tally migration tool; replace its Tally source connector with an Eco Green CSV/query-extraction connector while preserving reusable workflow components.
- Target integration: use Zoho Books APIs and supported import mechanisms for deterministic bulk posting.
- MCP/agent boundary: MCP or an agent may orchestrate, answer status questions, investigate exceptions, and trigger approved jobs, retries, reconciliation, or approvals. It must not perform per-record bulk migration.
- Books throughput: all locations share one Books organisation's limits; implement organisation-wide queueing, throttling, retry/backoff, and observability. Confirm actual limits and plan entitlements before sizing.
- Reconciliation: three-way comparison across Eco Green extract/control totals, Catalyst raw/transformed/staged data, and Zoho Books results.
- Accounting fidelity: create the correct Zoho Books transaction type where supported. Do not default all transactions to journals.
- Traceability: preserve source hashes, target identifiers, source-to-target lineage, approval evidence, and a complete audit trail.
- Delivery posture: prioritize a rapid, lightweight pilot and migration console. Do not introduce microservices, elaborate UI, multiple agents, or other platform weight that is not necessary for the one-time migration.
- Bot: provide one minimal Hermes-connected bot for authorized status, reconciliation, exception, and governed operational actions; it must use the same backend authorization and approval gates as the console.

## Objectives

1. Prove that data extracted from Eco Green is complete and internally consistent using independent query-level control totals.
2. Reconstruct the relationships lost when multiple MySQL result sets were exported as independent CSV files.
3. Normalize, map, validate, preview, approve, and migrate eligible accounting data to the correct Zoho Books location and transaction type.
4. Detect and quarantine data that overlaps Smart Pharma postings before any migration request reaches Zoho Books.
5. Reconcile every approved population at branch, period, ledger/voucher type, document, and transaction drilldown levels.
6. Make every post retry-safe and auditable, including uncertain API outcomes.
7. Provide operational dashboards and exception workflows that support controlled, period-by-period rollout across all branches.
8. Reuse proven parts of the RapGuru Tally tool and evolve it into a source-pluggable Data Migration & Reconciliation Engine.

## In scope

- Inventory of Eco Green extraction queries, CSV schemas, keys, file naming, versions, and control totals.
- Ingestion and immutable retention of raw extracts.
- File validation, schema validation, hash calculation, duplicate-file detection, and import control totals.
- Relationship reconstruction between extracted datasets.
- Branch/location, account/ledger, customer, vendor, tax, bank, payment method, voucher type, and other required mappings.
- Accounting transformation into correct Zoho Books modules, subject to agreed business rules.
- Transformation preview and pre-push validation.
- Branch-period workflow, approvals, segregation of duties, batch creation, queueing, migration, retries, and sign-off.
- Migration ledger and source-to-target lineage.
- Extraction, transformation, and post-migration reconciliation.
- Exceptions, assignment, remediation, reprocessing, and evidence.
- Smart Pharma overlap detection and exclusion controls.
- Dashboards and drilldowns for branch, period, ledger, voucher/document, batch, and status.
- Secure Zoho OAuth/API integration and operational monitoring.
- Reuse/refactoring of suitable Tally-tool components.
- Optional MCP/agent control surface limited to governed operational actions.

Likely accounting populations, subject to discovery and signed mapping, include chart of accounts/ledgers, customers and vendors, opening balances, receivables, payables, bills/purchases, customer receipts, vendor payments, expenses, journals, credit notes, debit notes/vendor credits, cash, bank transactions, taxes/GST, branch balances, and supporting voucher details.

## Out of scope unless explicitly approved

- Replacing Smart Pharma as WMS/POS.
- Reposting detailed inventory movements or B2C summaries already posted by Smart Pharma.
- Treating MCP/LLM calls as the bulk record transport.
- Uncontrolled direct writes to the Eco Green MySQL database.
- Changing Smart Pharma's Books integration.
- Building a separate greenfield migration product while reusable Tally-tool components are available.
- Default conversion of all source activity into general journals.
- Automatic approval of financial batches solely because technical checks passed.
- Production posting before mappings, overlap rules, control totals, rollback/containment procedures, and sign-off gates are approved.
- Assuming that a CSV-to-Catalyst row-count match proves the original Eco Green database extract was complete.

## Target architecture

```text
Eco Green MySQL
  -> versioned existing extraction queries
  -> CSV files + source control totals + extraction manifest
  -> Zoho WorkDrive controlled inbox
  -> Hermes VPS worker pickup/claim/hash validation
  -> Catalyst Stratus immutable raw archive
  -> ingestion/schema/hash/manifest validation
  -> Catalyst Data Store raw metadata and structured staging
  -> relationship reconstruction and normalization
  -> source-to-Zoho mappings
  -> Smart Pharma overlap detection and exclusions
  -> accounting transformation + preview
  -> three-way reconciliation and exception management
  -> human approval by branch/period/batch
  -> organisation-wide migration queue/rate limiter
  -> Zoho Books APIs or supported imports
  -> post-migration retrieval/reconciliation
  -> sign-off and audit evidence
```

### Suggested Catalyst responsibility split

- **Stratus:** original CSVs, extraction manifests, control-query files, generated reconciliation evidence, and other large/immutable artifacts. Preserve originals; never overwrite a raw object in place.
- **Data Store:** extraction metadata, staging records, normalized records, mappings, exceptions, approvals, batches, migration ledger, reconciliation results, audit events, and job state.
- **AppSail/services:** ingestion coordination, validation, relationship reconstruction, transformation, reconciliation, dashboard/backend APIs, Books integration, and governed operational endpoints.
- **Job Scheduling:** chunked branch-period imports, transformations, reconciliations, post jobs, retry sweeps, status polling, and report generation.
- **Web control centre:** keep the UI lightweight: file status, branch/cutover readiness, reconciliation, exceptions, preview/approval, queue results, and audit drilldown only.
- **Hermes worker:** deterministically claim WorkDrive inputs, archive originals to Stratus, validate/parse/summarize, invoke approved transformations and reconciliation, and execute authorized queue work against Books.
- **Hermes MCP reconciliation agent:** read status, summarize/investigate exceptions, generate reports, and invoke explicitly authorized Catalyst commands. It must never transport every record or bypass deterministic services.
- **Single Hermes-connected bot:** authenticated conversational access to status and governed actions. All mutating actions require server-side authorization, previews/confirmation where consequential, and audit events.

Technology choices and current service constraints must be verified against current official documentation before implementation. Do not copy deprecated Catalyst patterns from old tutorials.

## Data model expectations

The physical schema may differ, but it must support the following concepts and invariants.

### Core dimensions and reference entities

- organisation and target Zoho Books organisation ID
- branch, Eco Green branch code, and Zoho Books location ID
- financial year and accounting period
- source query definition and version
- extraction run and extraction manifest
- source file/object and cryptographic file hash
- source system/table/entity and source record identifiers
- ledger/account, customer, vendor, item reference where needed, tax, payment method, bank/cash account, voucher/document type
- mapping rule, version, scope, effective period, status, approver, and evidence

### Operational entities

- raw import record or durable pointer to it
- normalized source transaction/header/line relationship
- transformed transaction and payload version
- Smart Pharma comparison/overlap candidate and disposition
- validation result and exception
- reconciliation run, control, result, tolerance, and drilldown link
- approval request/decision and approver identity
- migration batch, queue item, API attempt, response classification, and retry schedule
- migration ledger/source-to-target lineage
- audit event

### Mandatory transaction lineage fields

At minimum, each migratable unit should retain:

```text
source_system
source_query_id
source_query_version
extraction_run_id
source_file_id
source_file_hash
source_table_or_entity
source_record_id
source_document_no
branch_code
zoho_location_id
financial_year
period
transaction_date
source_transaction_type
source_transaction_hash
mapping_version
transformation_version
target_module
target_payload_hash
migration_batch_id
approval_id
zoho_record_id
migration_status
attempt_count
last_error_code
last_error_message
reconciliation_status
created_at
updated_at
```

### Identity and idempotency

- Define a canonical business key and canonical serialization for each transaction type.
- Generate a stable source transaction hash from normalized, material source fields. Include branch, source type, source ID/document number, date, amount, and other discriminators appropriate to the source.
- Store file hashes separately from record hashes.
- Enforce uniqueness at the database level where possible; do not rely only on application checks.
- A retry must reuse the same idempotency identity and must not create a second target transaction.
- If a request times out after submission, treat the result as unknown. Search/reconcile using stored reference fields before retrying.
- Store every target ID and sufficient payload/response metadata to prove lineage without exposing secrets.

## Source extraction contract

Every query/extract must be registered and versioned. A minimum manifest should contain:

```text
query_id
query_name
query_version_or_sql_hash
business_purpose
source_tables
branch_scope
from_date
to_date
extracted_at
file_name
file_hash
row_count
debit_total
credit_total
amount_total where applicable
currency
source_operator_or_job
```

The Eco Green team should supply independent control queries or signed reports for:

- branch-wise trial balance
- monthly trial balance
- voucher counts by type
- total debits and credits
- sales totals
- purchase totals
- receipt totals
- payment totals
- journal totals, with debit/credit integrity
- debtor closing balances
- creditor closing balances
- cash closing balances
- bank closing balances

Detail extracts must be reconciled to independent controls, not merely re-summed and compared to themselves. Query changes require a new version, impact analysis, and revalidation.

## Migration workflow and state model

Process data by branch and accounting period, optionally grouped into controlled multi-branch batches. Do not release all branches and periods as one undifferentiated migration.

Recommended states:

```text
NOT_EXTRACTED
EXTRACTED
INGESTING
VALIDATION_FAILED
STAGED
MAPPING_REQUIRED
TRANSFORMED
EXCEPTION
SOURCE_RECONCILED
READY_FOR_APPROVAL
APPROVED
QUEUED
MIGRATING
PARTIALLY_MIGRATED
MIGRATED
POST_RECONCILIATION
RECONCILIATION_FAILED
SIGNED_OFF
```

States must have explicit transition rules. Approval applies to an immutable batch definition and transformation/mapping version. Any material input, mapping, rule, or payload change after approval invalidates approval and requires revalidation/reapproval.

### End-to-end flow

1. Register query definitions and expected schemas.
2. Receive CSVs and manifests; store immutable originals in Stratus.
3. Calculate hashes; reject/quarantine duplicate, corrupt, unknown, or schema-incompatible files.
4. Load structured staging records and compare counts/totals with the manifest and Eco Green control queries.
5. Reconstruct primary/foreign-key relationships. Quarantine orphaned, ambiguous, and duplicate relationships.
6. Apply versioned mappings and transformations.
7. Detect Smart Pharma overlap and classify each relevant population as migrate, exclude/already posted, or investigate.
8. Generate a human-readable transformation preview and target payload summary.
9. Run pre-migration three-way controls and exception thresholds.
10. Obtain authorized approval for an immutable branch-period/batch scope.
11. Enqueue approved work; apply organisation-wide rate limits, bounded concurrency, retry/backoff, and circuit breaking.
12. Persist each attempt and target ID in the migration ledger.
13. Retrieve/verify target results and perform post-migration reconciliation.
14. Resolve exceptions, rerun only safe/idempotent units, and obtain final accounting sign-off.

## Zoho Books transaction mapping principle

Use the closest semantically correct Books module, subject to Books capabilities and signed accounting mapping. Examples:

- purchase -> bill
- vendor payment -> vendor payment
- customer receipt -> customer payment
- expense -> expense
- credit note -> credit note
- debit note -> vendor credit or other approved equivalent
- bank movement -> transfer/banking transaction where supported
- pure accounting adjustment -> journal

Do not force transactions into journals merely because journals are technically easier. Any fallback to a journal must be an explicit, documented mapping rule with accounting approval and an explanation of downstream reporting effects.

## Smart Pharma coexistence and overlap rules

Smart Pharma is authoritative for new WMS/POS operations and already posts summarized inventory-related B2C data by date and payment/receipt method. The exact start date, posting granularity, identifiers, correction behavior, and branch rollout schedule must be obtained before migration.

The system must model three populations:

1. Historical Eco Green source transactions.
2. Smart Pharma-generated Books transactions.
3. Migration-generated Books transactions.

For every potentially overlapping branch/date/type/payment-method population, classify it as:

- `MIGRATE` — proven outside Smart Pharma scope.
- `SMART_PHARMA_ALREADY_POSTED` — exclude from migration and link to supporting target evidence.
- `PARTIAL_OR_AMBIGUOUS_OVERLAP` — block migration and investigate.
- `NOT_APPLICABLE` — transaction class cannot overlap under the approved rule.

Overlap matching should use the strongest available evidence: branch/location, business date, transaction class, payment/receipt method, tax bucket, amount, Smart Pharma reference/batch ID, and target metadata. Amount-only matching is insufficient. Tolerances and aggregation rules require finance approval.

Do not post inventory movements from Eco Green merely to make an inventory reconciliation match. Inventory data may be retained for historical/control validation without becoming a target posting population.

## Reconciliation framework

Final status is `MIGRATION_VERIFIED` only when all applicable layers pass or have formally approved exceptions.

Because Zoho Books is live, its complete trial balance cannot be compared directly with only the historical migration CSV. Reconciliation must isolate migration-created records and separately bridge concurrent Smart Pharma and authorized manual activity.

### Layer A: Eco Green branch trial balance vs extracted transactional CSV

- expected files received
- query/file version correct
- file hashes recorded
- source row count vs imported count
- transactional CSV summarized by branch, date range, ledger/account, voucher/transaction type, debit, credit, count, and closing balance
- summarized CSV totals and balances vs independent Eco Green branch-wise trial balance/control reports
- branch and period completeness
- orphan, duplicate, and referential-integrity checks
- unexplained differences block migration

### Layer B: Extracted CSV vs approved migration population

- raw-to-normalized record/amount bridge
- complete bridge: CSV population = migratable population + Smart Pharma exclusions + other approved exclusions + blocked exceptions
- excluded population bridge, including rule version, evidence, reviewer, and Smart Pharma overlap
- mapping completeness and mapping version
- transformation debit/credit integrity
- source type to target module bridge
- tax, currency, branch/location, party, cash/bank, and rounding controls
- approved tolerances with reason codes

### Layer C: Approved migration population vs migration-tagged Zoho Books records

- queued/attempted/succeeded/failed/unknown counts
- source amount vs target amount by module
- target IDs captured for every success
- branch/location assignment
- document/reference/date/tax/party checks
- post count and monetary control totals
- missing, duplicate, partial, and unexpected target records
- opening/closing and trial-balance controls where applicable
- compare approved migration deltas only to records carrying the stable migration batch/source identity

### Live Books balance bridge

For each branch and migration window, capture a target baseline immediately before posting and a post-run target snapshot. Prove:

```text
Books balance before migration
  + migration-created movement
  + Smart Pharma/live movement during the migration window
  + authorized manual movement during the migration window
  = Books balance after migration
```

Every concurrent movement must be isolated using the strongest available identifiers. An unexplained balance movement or target record blocks sign-off.

### Branch cutover matrix

Maintain, at minimum:

```text
branch_code
zoho_location_id
migration_from_date
live_system_start_date
historical_migration_end_date
transaction_class
smart_pharma_coverage_status
cutover_rule_version
approval_status
approved_by
```

The default eligibility rule is `transaction_date >= 2026-04-01` and `transaction_date < verified live_system_start_date`. Date alone is not sufficient: transaction class, payment/receipt method, Smart Pharma coverage, late/back-posted entries, reversals, and corrections must be evaluated. Gaps and partial or ambiguous overlaps block posting.

### Drilldown hierarchy

```text
Organisation
  -> branch/location
    -> financial year/period
      -> reconciliation control or module
        -> ledger/voucher type
          -> document/voucher
            -> source line, transformed payload, API attempt, target record
```

Every dashboard total must be reproducible from stored detail and tied to a specific extraction, mapping, transformation, and reconciliation version.

## Exception management

Exceptions should be first-class records with category, severity, branch, period, source references, financial impact, owner, status, root cause, disposition, evidence, timestamps, and audit history.

Important categories include schema failure, missing key, orphan relationship, duplicate source, unmapped entity, ambiguous mapping, unbalanced voucher, invalid target type, Smart Pharma overlap, API validation error, authentication error, rate limit, transient failure, unknown API outcome, target mismatch, and reconciliation difference.

Bulk overrides are prohibited unless rule-based, previewed, scoped, approved, and auditable. Closing an exception must not erase its history.

## Queueing, rate limiting, and resilience

- Apply a single organisation-wide rate limiter across all 326 locations.
- Read configurable limits from deployment configuration; confirm them from the current Books plan and official documentation.
- Use bounded concurrency, token/leaky-bucket-style throttling as appropriate, exponential backoff with jitter, and `Retry-After` when supplied.
- Separate retryable, non-retryable, authorization, data-validation, and unknown-outcome errors.
- Cap attempts and route exhausted items to a dead-letter/manual-review state.
- Persist queue and attempt state so restarts do not lose work.
- Support safe pause/resume by batch, branch, period, and transaction class.
- Implement circuit breakers for systemic authentication, configuration, or target errors.
- Never log OAuth secrets or full sensitive payloads indiscriminately.

## Security, privacy, and audit requirements

- Least-privilege service identities and Books OAuth scopes.
- Secrets in an approved secret store/configuration mechanism; never in source code, logs, CSVs, or prompts.
- Environment isolation for development, test/UAT, and production.
- Role-based access for ingestion, mapping, review, approval, migration operation, and audit.
- Segregation of duties: preparer/mapping operator should not self-approve production migration unless explicitly accepted by governance.
- Immutable or append-only audit events for file receipt, rule/mapping changes, previews, approvals, state transitions, job actions, API attempts, retries, exception decisions, and sign-off.
- Record actor identity, timestamp, before/after values, reason, correlation ID, branch/period/batch, and evidence link.
- Encrypt data in transit and at rest; define retention, archival, purge, and backup/restore requirements.
- Minimize personal/sensitive data in dashboards, logs, test fixtures, and agent context.
- Validate uploaded CSV content, file type/size, delimiters, encoding, formulas, and malicious payloads.
- Protect against injection, broken authorization, insecure direct object references, cross-branch data leakage, and replay/duplicate submission.
- Define incident response and containment: pause queue, revoke credentials, identify affected batches, and reconcile before resume.

## Tally tool reuse and refactoring plan

The reuse estimate is a hypothesis to validate from the repository, not a commitment. Earlier discussion suggested approximately 60–70% conceptual reuse, but actual reuse must follow code and dependency inspection.

### Likely reusable capabilities

- staging and validation workflow
- mapping/remapping engine
- transformation preview
- approval workflow and permissions
- Zoho OAuth/API client foundations
- migration queue and per-record status tracking
- retry/backoff and failure handling
- migration ledger
- reconciliation framework
- exception management
- dashboard/reporting concepts
- audit events and `needs_review`/pre-push controls

### Components to replace or materially adapt

- Tally XML/Excel/source connector -> Eco Green query-contract/CSV connector
- Tally-specific schema and voucher assumptions -> Eco Green relationship reconstruction
- Tally ledger mappings -> Eco Green-to-Books mapping namespace
- client/company scoping -> one organisation with branch/location and period as mandatory dimensions
- journal fallback logic -> correct Books module routing
- two-way reconciliation -> three-way reconciliation with transformation bridge
- generic duplicate checks -> canonical source hashing plus Smart Pharma overlap detection
- throughput assumptions -> organisation-wide Books queue/rate limiting for all locations

### Refactoring goal

Evolve the product into a `RapGuru Data Migration & Reconciliation Engine` with explicit source connector, canonical accounting model, target adapter, control/reconciliation, workflow, and audit boundaries. Preserve behavior with characterization tests before invasive refactoring. Avoid copying Tally-specific code into a second parallel application.

## Implementation phases

### Rapid MVP — lightweight foundation and pilot

The immediate delivery target is a small, usable pilot rather than the full hardened 326-branch platform. Subject to credentials, representative inputs, and approved mappings, the first increment should provide:

- one agreed CSV/manifest format and WorkDrive inbox
- one or a few representative pilot branches
- Hermes pickup, hashing, validation, Stratus archival, and durable registration
- branch/date/account debit-credit summarisation
- Eco Green trial balance vs CSV reconciliation
- Zoho Books baseline/report retrieval or controlled import for reconciliation
- CSV-to-approved-population bridge with Smart Pharma exclusions and exceptions
- dry-run transformation preview; production posting disabled by default
- a lightweight console for file status, cutover matrix, reconciliation, exceptions, approval, and posting results
- one minimal Hermes-connected bot, initially read-oriented with only narrowly governed actions

Do not compromise financial safeguards to meet the rapid timeline. Full production readiness for 326 branches, all mappings, volume, recovery, and live posting remains subject to later acceptance gates.

### Phase 0 — Repository and platform discovery

- inventory the Tally tool architecture, technologies, dependencies, tests, security posture, and deployability
- identify reusable modules and coupling to Tally-specific models
- verify current Catalyst and Zoho Books capabilities/limits using official documentation
- produce an architecture decision record and reuse matrix

### Phase 1 — Source/data relationship audit

- obtain one representative branch's complete CSV set, query definitions, schemas, sample control reports, and data dictionary
- profile keys, nulls, duplicates, formats, volumes, encoding, branch/period coverage, and PII
- reconstruct relationships and measure unmatched/ambiguous rows
- define extraction contracts and control-query requirements

### Phase 2 — Foundation and ingestion

- establish environments, configuration, secrets, roles, audit, Stratus layout, and Data Store schema
- implement extraction-run manifests, immutable raw storage, file/record hashing, schema validation, chunking, and import controls
- create operational observability and failure recovery

### Phase 3 — Canonical model, mappings, and transformation

- implement source connector and normalized accounting model
- implement versioned mappings and correct target-module routing
- create preview and validation reports
- create characterization/unit/property tests for totals, balance, rounding, and idempotency

### Phase 4 — Reconciliation and Smart Pharma controls

- implement the source-TB-to-CSV summary control, CSV-to-approved-population bridge, and drilldowns
- implement the branch/transaction-class cutover matrix and live Books baseline/post-run bridge
- obtain Smart Pharma interface facts and target identifiers
- implement overlap classification, evidence, blocking rules, and exception workflows
- validate against one representative branch and period

### Phase 5 — Zoho Books target adapter and migration workflow

- implement Books API/import adapter, queue, rate limiter, retry/backoff, unknown-outcome recovery, and migration ledger
- implement immutable approval scopes and role checks
- implement Layer C post-migration reconciliation
- test in sandbox/test organisation with non-production data

### Phase 6 — Pilot and controlled rollout

- pilot selected branches/periods representing normal and edge cases
- run finance/UAT sign-off and performance/volume tests
- roll out by controlled branch-period batches with monitoring and reconciliation gates
- document runbooks, rollback/containment, support, and final certification

### Phase 7 — Hardening and handover

- close security, reliability, and audit findings
- validate backup/restore and restart recovery
- finalize operating procedures, evidence packs, training, ownership, and retention
- baseline production metrics and archive signed migration records

## Acceptance criteria

The platform is acceptable only when, at minimum:

1. Every input file is tied to a versioned query/extraction contract, branch/period scope, and immutable hash.
2. Detail extracts reconcile to independent Eco Green control queries at agreed levels and tolerances.
3. Relationship reconstruction reports all missing, duplicate, and ambiguous links; unresolved material items block approval.
4. Every transformed amount can be bridged back to source and forward to the target payload.
5. Every target posting uses an approved Books module/mapping and correct location.
6. Smart Pharma overlap rules are approved and prevent duplicate B2C/inventory-related posting.
7. Repeating an import, job, or retry does not create duplicate target transactions.
8. Unknown API outcomes are resolved by target lookup/reconciliation before any repost.
9. Rate limiting and queueing operate across the whole Books organisation and recover safely after restart.
10. Approval is role-controlled, auditable, tied to immutable batch inputs/rules, and invalidated by material changes.
11. Three-way reconciliation supports organisation, branch, period, ledger/voucher type, document, and transaction drilldown.
12. Migration ledger records target IDs, attempts, errors, hashes, actors, timestamps, and reconciliation state.
13. Automated tests cover critical accounting invariants, mappings, duplicate prevention, retries, overlap rules, and authorization.
14. Pilot branches and periods complete source, transformation, target, and final finance sign-off with no unexplained material difference.
15. Security review finds no exposed secrets, cross-branch access flaw, unauthorized approval/post path, or material sensitive-data leakage.
16. Operational runbooks demonstrate safe pause, resume, retry, exception handling, credential failure containment, and recovery.

Exact financial tolerances, completeness thresholds, performance targets, retention periods, RTO/RPO, and sign-off authorities must be agreed and recorded before production acceptance.

## Open questions and required decisions

### Source and data

- What are the verified live-system start date and historical migration end date for each branch and transaction class?
- Are all 326 branch codes stable and mapped to existing Books location IDs?
- What queries/files exist, what tables feed them, and are original primary/foreign keys included?
- Are header/line relationships reconstructable without fuzzy matching?
- What are actual row counts, file sizes, currencies, tax regimes, encodings, and historical corrections?
- Can the Eco Green team rerun extracts consistently and provide signed query versions/control results?
- Are opening balances, outstanding receivables/payables, and historical documents all required, or only selected populations?
- What data retention and privacy classifications apply?

### Smart Pharma boundary

- What was the Smart Pharma go-live date for each branch?
- What exactly is posted to Books: modules, aggregation grain, tax detail, payment methods, references, and correction/reversal behavior?
- Does Smart Pharma back-post or update historical dates?
- Which Books fields identify Smart Pharma batches reliably?
- How should partial-day, partial-branch, late, reversed, or corrected overlaps be handled?
- Who signs off the overlap/exclusion rules and tolerances?

### Zoho Books and accounting

- Confirm organisation ID, plan, edition/region, API concurrency/minute/day limits, import facilities, and enabled locations.
- Which target transaction type is approved for each Eco Green voucher type?
- How will document numbering, taxes/GST, withholding, rounding, currency, contacts, credit allocation, bank reconciliation, and locked periods be handled?
- How should target references support deterministic lookup after a timeout?
- What target-side changes may users or Smart Pharma make during migration windows?
- What constitutes rollback: deletion, reversal, credit/debit correction, or containment and compensating entries?

### Existing Tally tool

- Where is the repository and which version is the baseline?
- What architecture, language, schema, deployment model, test coverage, and licenses/dependencies exist?
- Which components are production-proven versus prototypes?
- Does it already support Catalyst Stratus/Data Store/AppSail/Job Scheduling and current Books APIs?
- What security or technical debt must be corrected before reuse?

### Governance and operations

- Who owns extraction, mapping, accounting approval, Smart Pharma confirmation, production operation, and final sign-off?
- What financial tolerances are permitted at each reconciliation level?
- What are required batch sizes, maintenance windows, throughput, RTO/RPO, retention, and evidence formats?
- Which one or few branches, CSV format, trial balance, and target baseline will be used for the rapid pilot?
- What is the exact scope that must be demonstrated tonight, and which production-hardening items are explicitly deferred?
- What environments and test Books organisation are available?
- Are approval and sign-off electronic records legally/audit acceptable?

## Principal risks and mitigations

| Risk | Impact | Primary mitigation |
|---|---|---|
| Missing source keys after CSV extraction | Relationships may be ambiguous or wrong | Audit one full branch/period first; require IDs or improved queries; block fuzzy material matches |
| Extract matches Catalyst but not Eco Green | False assurance of completeness | Independent control queries and signed extraction manifests |
| Smart Pharma overlap | Duplicate sales/inventory/accounting in Books | Branch/date/type/payment-method overlap engine; target evidence; hard approval gate |
| Shared Books API limits | Slow migration, 429s, partial batches | Organisation-wide limiter, queue, batching/imports, backoff, capacity test |
| Timeout followed by blind retry | Duplicate financial transaction | Stable idempotency identity, target lookup, unknown-outcome state |
| Incorrect journal fallback | Poor reporting and accounting semantics | Signed type mapping; explicit journal exceptions only |
| Mapping changes after approval | Approved figures no longer match posted payload | Version and freeze inputs/rules; invalidate approval on change |
| Tally code is tightly coupled | Reuse may introduce defects or delay | Repository discovery, characterization tests, adapter boundaries, phased refactor |
| Excessive sensitive data in logs/agent prompts | Privacy/security breach | Redaction, least data, access control, retention, secure secrets |
| Concurrent user/Smart Pharma changes in Books | Post-reconciliation differences | Migration windows, target markers, snapshots, change monitoring, rerunnable reconciliation |
| Accounting requirements remain implicit | Technically successful but financially incorrect migration | Finance-owned mapping and acceptance matrix with signed tolerances |

## Required first deliverables

Before major implementation begins, produce:

1. Repository assessment and Tally reuse matrix.
2. Current-state and target architecture diagrams plus architecture decision records.
3. Source extraction inventory and one-branch data relationship audit.
4. Source-to-Zoho Books mapping blueprint by voucher/transaction type.
5. Smart Pharma coexistence and overlap specification.
6. Canonical data model and migration-ledger design.
7. Three-way reconciliation control matrix.
8. Security, roles, approval, audit, and secrets design.
9. Queue/rate-limit/idempotency/retry design.
10. Phased implementation plan with dependencies, tests, risks, and acceptance gates.

## Working principles

- Preserve accounting truth before optimizing throughput.
- Make every total drillable and every target record traceable.
- Automate deterministic work; reserve AI for investigation and orchestration.
- No production post without reconciled source, preview, authorized approval, and duplicate protection.
- Treat exclusions and transformations as explicit, versioned, testable rules.
- Prefer small, reversible branch-period pilots over a single large cutover.
- Record unresolved facts as open questions; do not turn assumptions into code silently.
- Keep the one-time migration console light and crisp; add complexity only when it protects accounting truth, live-system safety, security, or auditability.
- Reconcile migration-created Books records separately from concurrent Smart Pharma and manual activity, then prove the overall live Books balance bridge.
