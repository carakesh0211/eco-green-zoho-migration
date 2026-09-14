# ADR 0001 — One Catalyst AppSail service for the Development visual MVP

Date: 2026-09-14 · Status: **Accepted**

## Context

The pilot needs a usable, visible Development deployment today: the Express API, the plain-HTML
dashboard, the governed bot/MCP endpoints and the Catalyst Data Store adapter. Two Catalyst
shapes were considered:

1. **AppSail** (persistent Node process) hosting everything.
2. **Web client** (static hosting) for the dashboard + one **Advanced I/O function** for the API.

Verified platform facts (docs/CATALYST_REFERENCES.md; AppSail facts confirmed on the earlier
`TallyZohoMigrator` Development deployment): AppSail managed runtimes include **Node 24**; the
process listens on `X_ZOHO_CATALYST_LISTEN_PORT`; requests time out at **30 s**; the working
directory is write-restricted; up to five instances may serve concurrently; configuration is
`app-config.json` (`command`, `build_path`, `stack: "node24"`, `memory`) plus per-environment
environment variables; `catalyst deploy` targets Development only.

## Decision

Deploy **one AppSail service** (`stack: node24`, 512 MB) that serves the API, the static
dashboard, the bot surface and the Data Store adapter. No web client, no functions, no worker
loop in the deployed process (`WORKER_MODE=disabled`; the seed endpoint runs the pipeline
stages in-process for the synthetic demo only).

## Why

- The application is already an Express app serving its own static files; AppSail runs it
  unchanged except for the listen port and the Catalyst SDK bootstrap (per-request
  `initialize(req, {scope:'admin'})` via AsyncLocalStorage; request-less `initialize()` for
  background stages). A function + web client would split one app in two deployables, two
  domains and a CORS surface for no gain.
- Node 24 is a supported managed runtime, so no runtime adaptation is needed.
- The 30 s request timeout is respected by design: dashboard reads are small ZCQL queries; the
  only long operation (the synthetic seed) is detached from its request and reports progress.
- Write-restricted filesystem: no SQLite, no inbox marker files (bundled read-only inbox), no
  local archive — the archive adapter is explicitly `disabled` in Development until Stratus is
  activated, and the health endpoint and dashboard say so. There is no silent local-disk path.

## Consequences

- Claiming on Data Store is **BEST_EFFORT** (no atomic conditional update): production posting
  is structurally blocked while the store reports `claimSemantics: 'BEST_EFFORT'`, and only a
  single guarded worker may ever run against this store (fail-closed checks in
  `src/books/guard.js` and `src/worker/index.js`).
- Multiple AppSail instances are fine for reads; any future queue execution must move to a
  Catalyst Job/Cron target with a proper lease, not to the AppSail request path.
- Secrets and identifiers live only in AppSail environment variables (`USERS_CONFIG_JSON`,
  `DEV_SEED_ENABLED`, adapter selectors); nothing in the repository.

## Rejected alternative

Web client + Advanced I/O function: rejected for this MVP because it duplicates deployables and
adds a cross-domain boundary between dashboard and API without solving any constraint AppSail
does not already meet.
