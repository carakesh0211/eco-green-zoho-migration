# Eco Green → Zoho Books Migration Pilot

> **MVP scaffold — production posting disabled — no real data.**
> This is a one-time migration pilot, not a product. Production Zoho Books posting is
> hard-disabled by default (`POSTING_ENABLED=false` plus an empty org allowlist) and
> requires a separate written authorization to enable — see `DEPLOYMENT.md` §5. No real
> Eco Green data, credentials, or Smart Pharma evidence exists in this repository; all
> fixtures are synthetic (`DATA_CONTRACT.md`).

## What this is

A rapid, lightweight pilot for migrating historical Eco Green accounting data into a
live Zoho Books organisation, with three-way reconciliation against independent Eco
Green controls and against Books itself, and explicit exclusion of anything already
posted by Smart Pharma (the new WMS/POS). The target scope is approximately
351 branches (configurable via `EXPECTED_BRANCH_COUNT`, see `PROJECT_CONTEXT.md`). It reuses proven parts of an existing RapGuru
Tally migration tool, refactored into a source-pluggable migration engine. Full context
and constraints are in `PROJECT_CONTEXT.md`; this repository implements only the
rapid-MVP slice described there and in `CLAUDE_IMPLEMENTATION_PROMPT.md`.

This is **not** a permanent product. It is intentionally a small modular monolith with
a plain-HTML console — no framework, no build step, no microservices, no multi-agent
system.

## Quick start (local, offline, mock data only)

```bash
npm install
cp .env.example .env
npm run fixtures:seed
npm run pipeline:dry-run   # incremental; add --fresh --approve-known-diffs --through-mock-books for a clean end-to-end verification (see DEPLOYMENT.md §4b)
npm start        # console + API on http://localhost:4100
npm run worker   # separate process, in another terminal
npm test
```

Everything above runs against synthetic fixtures with `STORE_ADAPTER=sqlite`,
`INBOX_ADAPTER=local`, `ARCHIVE_ADAPTER=local`, and `BOOKS_DRIVER=mock` — no external
credentials or network access are required.

## Layout

```
src/core/        primitives (money, ids, hash, states, csv/manifest, ingest,
                 summarise, cutover/overlap/bridge, mapping/transform, batch, exceptions)
src/adapters/    store, inbox, archive adapters — local/sqlite today, Catalyst/WorkDrive/
                 Stratus stubs for later
src/books/       Zoho Books client (mock + live), rate limiter
src/worker/      deterministic worker loop and queue executor (Hermes host)
src/server/      HTTP API, plain-HTML console, governed bot/MCP routes
scripts/         fixture seeding, dry-run pipeline, pre-publish secret scan
fixtures/, config/, test/, docs/   synthetic data, local config templates, tests
```

## Documentation index

| File | Covers |
|---|---|
| `PROJECT_CONTEXT.md` | Authoritative business/architecture context and constraints |
| `CONTRACTS.md` / `DATA_CONTRACT.md` | Module-level build contracts and the pilot CSV/manifest format |
| `IMPLEMENTATION_PLAN.md` | Confirmed facts, assumptions, open decisions, scope, workstreams, risks, status |
| `ARCHITECTURE.md` | Current/target diagrams, module map, data model, state machines, Catalyst swap design |
| `WORKDRIVE_INGESTION.md` | Inbox folder contract, hashing, quarantine, and the WorkDrive adapter TODOs |
| `HERMES_WORKER.md` | The deterministic worker loop, restart semantics, VPS operation, Hermes API boundary |
| `SMART_PHARMA_OVERLAP.md` | Cutover matrix, overlap classification, evidence, and open vendor questions |
| `RECONCILIATION.md` | Layers A/B/C, the live balance bridge, tolerances, drilldown |
| `BOT_AND_MCP_SECURITY.md` | The governed bot/MCP surface, role ceiling, and prompt-injection posture |
| `SECURITY.md` | Threat model, secrets, RBAC, audit, environment isolation, pre-publish checklist |
| `DEPLOYMENT.md` | Local dev, VPS worker, Catalyst target design, environment matrix, posting enablement procedure |
| `OPERATIONS_RUNBOOK.md` | Pause/resume, retry rules, incident containment, restart recovery |

## Console views (increment 2, in progress)

Status: in progress -- verify against code on merge; see `ARCHITECTURE.md` §7 and
`CONTRACTS.md` §U/§D/§N/§E.

- **Branch dashboard** -- one row per branch (~351, configurable via
  `EXPECTED_BRANCH_COUNT`), server-side filter/sort/pagination, CSV export.
- **Branch workspace** -- single-branch drilldown reusing the existing Layer A/B/C,
  cutover, and exception views.
- **Team & assignments** -- who is assigned to each branch-period, SoD-checked.
- **Books connection** -- connection/organisation/location status and the six
  independent posting controls (`ARCHITECTURE.md` §7.3).

## Safety notice

Do not point this repository at a real Zoho Books organisation, real Eco Green data, or
real Smart Pharma evidence without first reading `SECURITY.md` and `DEPLOYMENT.md` §5.
Production posting requires reconciliation gates to pass **and** a separate written
authorization outside this repository — no configuration flag or API route in this
codebase enables it unilaterally. If you find a real secret, credential, or Eco Green
data record committed here, treat it as an incident per `OPERATIONS_RUNBOOK.md` §10 and
do not open a public issue containing it.
