# HERMES_WORKER.md — Deterministic Worker and Hermes Agent Boundary

Status: **in progress (wave 1)**. Hermes is the open-source `hermes-agent` AI agent
framework, installed locally as a desktop app (CONFIRMED). No deterministic worker code
existed before this repository — `src/worker` **is** that deterministic worker. A
RapGuru VPS exists and is reachable by SSH (CONFIRMED); nothing has been deployed to it
yet.

## 1. What Hermes is, and is not, in this system

Hermes is an AI agent framework used for monitoring, investigation, summaries, reports,
and issuing narrowly governed commands. It is **not** the per-record migration transport.
All deterministic work — pickup, hashing, validation, summarisation, mapping, transform,
reconciliation, and queued Books posting — runs in `src/worker` as plain Node code with
no LLM in the execution path (`PROJECT_CONTEXT.md`, `CLAUDE_IMPLEMENTATION_PROMPT.md`).
The Hermes agent talks to this system only through the governed HTTP API (`CONTRACTS.md`
§H/§G) — never through shell access, direct database access, or file-system access on
the worker's host.

## 2. The deterministic worker loop (§W)

`src/worker/index.js` runs a single process that repeats:

```text
poll inbox
  -> ingestRun            (§V: validate, hash, archive, stage)
  -> summariseRun         (§M: branch/ledger/voucher-type summaries)
  -> reconcileLayerA       (§M: source TB vs CSV)
  -> if PASS: classifyRun (§K: cutover + Smart Pharma overlap)
  -> transformRun          (§T: dry-run Books payload preview)
  -> reconcileLayerB       (§K: CSV-to-population bridge)
  -> drain queue slices for QUEUED batches (§Q, mock/live per config)
  -> resolveUnknownOutcomes (§Z/§Q: target lookup before any retry)
  -> sleep WORKER_POLL_INTERVAL_MS
```

`runOnce(ctx, deps)` executes exactly one such cycle and is what tests and
`scripts/run-pipeline.js` call directly; `main()` loops it forever with the configured
poll interval.

## 3. Restart and claim-expiry semantics

Every step keys off a durable status column (`extraction_runs.status`,
`migration_batches.status`, `queue_items.status`), never off in-memory state. A process
crash or restart therefore does not lose or duplicate work:

- A claimed run/item that dies before finishing keeps `claimed_by`/`claim_expires_at`
  until `WORKER_CLAIM_TTL_MS` elapses, then becomes reclaimable by any worker (including
  a restarted instance of itself), via the same atomic `store.claim` UPDATE used for
  pickup — two racing workers converge on exactly one winner.
- Every write is state-machine-guarded (`assertTransition`), so a resumed run cannot
  skip a step or silently re-enter one it already passed; it re-evaluates from its
  current durable status.
- `UNKNOWN_OUTCOME` items are never touched by the normal retry path on restart — only
  `resolveUnknownOutcomes` moves them, via a deterministic target lookup
  (`client.searchByMigrationTag`) before deciding `POSTED` or requeueing.

## 4. Running on the VPS

Nothing has been deployed to the RapGuru VPS yet (CONFIRMED). The design intent:

- **Process manager**: ASSUMED — `systemd` (preferred) or `pm2` as fallback, running
  `npm run worker` under a dedicated, least-privileged system user. Neither installed
  nor verified on the VPS (open decision `IMPLEMENTATION_PLAN.md` D-9).
- **Environment**: `.env` on the VPS is populated from `.env.example`, permission-
  restricted to the service user, never committed. Development/UAT and production must
  not share credentials or an org allowlist (`SECURITY.md`).
- **Log redaction**: worker output goes through `src/core/log.js#log`, redacting any
  field matching `/token|secret|password|authorization|refresh/i` before writing a JSON
  line to stdout; the process manager's log capture inherits this automatically — no
  additional downstream filtering is assumed.
- **Restart policy**: the process manager should restart the worker on crash
  unconditionally, since it is idempotent on restart by design (§3). Not yet configured
  or tested on the VPS.

## 5. How the Hermes agent connects

- Hermes authenticates as a bot user with `role: 'operator'` at most (never `approver`),
  using a bearer token from the same hashed-token config as human console users
  (`CONTRACTS.md` §H). ASSUMED: the agent token is provisioned the same way as any other
  operator token in `config/users.json` — no separate Hermes-specific auth mechanism has
  been designed or implemented.
- Hermes calls only the routes documented in `BOT_AND_MCP_SECURITY.md` (`src/server/routes/agent.js`,
  §G): the read routes plus `pause`, `resume`, eligible-only `retry`, and
  `exceptions/:id/assign`.
- Hermes never receives shell access to the VPS worker process, never receives direct
  database credentials, and never bypasses the HTTP API to reach the store, inbox, or
  archive adapters directly.
- Every Hermes-initiated call carries a correlation ID and is audited exactly like a
  console action, including the actor identity (`bot:<user>`), per `CONTRACTS.md` §A.

## 6. Health endpoint

`GET /api/worker/health` (read route, §H) reports worker liveness for both the console
and Hermes. Expected shape — ASSUMED, to be finalized with the API implementation —
includes at minimum: last successful cycle timestamp, current run/batch being processed
(if any), and counts of runs/batches stuck in a non-terminal state beyond a configurable
staleness threshold. No implementation of this endpoint has been verified yet.
