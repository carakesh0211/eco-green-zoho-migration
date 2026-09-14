# DEPLOYMENT.md — Local Dev, VPS Worker, and Catalyst Target

Status: **in progress (wave 1)**. Nothing described here beyond "local dev" has been
deployed or verified (CONFIRMED: workspace is not yet a git repository; no Catalyst
project exists; nothing is running on the VPS).

## 1. Local development

```bash
npm install
cp .env.example .env            # fill in local values; never commit .env
npm run fixtures:seed           # loads fixtures/synthetic/* into INBOX_LOCAL_PATH,
                                 # config/cutover-matrix.json, config/mapping-rules.json,
                                 # config/users.json (dev tokens printed once)
npm run pipeline:dry-run        # runs worker.runOnce end-to-end with the mock Books
                                 # driver; --dry-run is the only mode this script has —
                                 # posting still requires the guard in SECURITY.md §3
                                 # regardless
npm start                       # starts the console/API (src/server/index.js)
npm run worker                  # starts the worker loop in a second process
npm test                        # node --test test/
```

`STORE_ADAPTER=sqlite`, `INBOX_ADAPTER=local`, `ARCHIVE_ADAPTER=local`, and
`BOOKS_DRIVER=mock` are the defaults in `.env.example` — a clean checkout runs fully
offline with no external credentials.

## 2. VPS worker (Hermes host)

A RapGuru VPS exists and is reachable by SSH (CONFIRMED). Nothing has been installed on
it for this project. The intended shape, none of it yet executed:

1. Provision a dedicated, least-privileged system user for the worker process.
2. Deploy this repository to the VPS; `npm install --omit=dev`.
3. Populate `.env` from `.env.example`, scoped to whichever environment (dev/UAT) this
   VPS represents — never production credentials on a shared/lower-trust host without
   explicit authorization.
4. Run `npm run worker` under a process supervisor — ASSUMED `systemd`/`pm2`, open
   decision D-9 — configured to restart on crash (idempotent by design, `HERMES_WORKER.md`
   §3).
5. Point Hermes's configuration at this system's API base URL with an `operator`-role
   bearer token (`HERMES_WORKER.md` §5) — never shell or database access.
6. Restrict inbound access to the API port to the hosts that need it; not yet configured.

## 3. Catalyst target design (no tenant details — none exist yet)

Whether to create a new Catalyst project or reuse the Tally tool's existing project is
an open decision (`IMPLEMENTATION_PLAN.md` D-1); the working recommendation is a **new**
project, India data center, Development environment first, to avoid mixing an unrelated
client's Catalyst resources with Eco Green data. What such a project would need, once
created:

| Catalyst service | Role | Manual step |
|---|---|---|
| Data Store | Replaces `sqlite.js` behind the `Store` interface (`ARCHITECTURE.md` §6) | Create tables from `schema.sql` via Catalyst tooling; no multi-row tx, so writes stay single-row-idempotent as designed |
| Stratus | Replaces the local archive folder behind the `Archive` interface | Create a bucket per environment; same immutability rule (reject on sha256 conflict) |
| AppSail | Hosts the API/console and/or worker instead of a bare VPS process | Respect the 30s request timeout — the worker already processes bounded slices, not whole batches |
| Job Scheduling | Could later replace the poll loop for individual worker steps | Not required for the pilot; steps are already idempotent, so this is a later optimization |

No Catalyst CLI deployment command has been run against a real project for this
repository. The Catalyst CLI **cannot deploy to Production** — promotion from
Development to Production is always a separate, manual, documented step performed by
whoever owns the Catalyst project, never an automated script action here.

## 4. Environment matrix

| Environment | Store | Inbox | Archive | Books driver | Org allowlist | Posting |
|---|---|---|---|---|---|---|
| Local dev | sqlite | local | local | mock | empty | Disabled (`POSTING_ENABLED=false`) |
| Development (Catalyst, once created) | Data Store | local or WorkDrive stub | Stratus | mock | empty | Disabled |
| UAT / test | Data Store or sqlite | WorkDrive (once credentialed) | Stratus | mock, or live read-only against `UT_Test` only if separately authorized | Empty, or `UT_Test` only | Disabled |
| Production | Data Store | WorkDrive | Stratus | live | Eco Green org only, added after §5 gates pass | Disabled until §5 is satisfied |

No environment beyond local dev exists today. `UT_Test` is a free-plan sandbox org the
connected credential can already reach; it is explicitly **not** the Eco Green org and
must never receive anything resembling real Eco Green data (`IMPLEMENTATION_PLAN.md` D-8).

## 4b. Verification runs vs incremental reruns

`node scripts/run-pipeline.js --branch PILOT01 --run run-001 --dry-run --fresh --approve-known-diffs --through-mock-books` wipes local state under `./var` and produces a clean end-to-end proof; it ends with `VERIFICATION: PASSED — 31/31 …` (exit 0) or `VERIFICATION: FAILED` (exit 3). Without `--fresh`, a rerun over the same manifest reports `IDEMPOTENT RERUN … NOT end-to-end verification evidence`; if `--through-mock-books` is added to such a rerun and zero items are exercised over a non-empty approved population, the run fails (exit 3). Layer C itself records `c:population:exercised` and FAILs on zero items over a non-empty batch. `--fresh` refuses to delete anything outside `./var`.

## 4c. Catalyst Development deployment (AppSail) — verified procedure

Decision: one AppSail service (`docs/adr/0001-appsail-single-service.md`). Verified 2026-09-14:

1. `catalyst.json` (gitignored, local): `{ "appsail": [{ "source": ".", "name": "EcoGreenMigrationConsole" }] }`.
   `app-config.json` (committed, no env values): `{ "command": "npm start", "build_path": ".", "stack": "node24", "memory": 512 }`.
2. Environment variables live ONLY in the gitignored `var/appsail-env.local.json` (array of `{key,value}`;
   `USERS_CONFIG_JSON` carries sha256 token hashes, never plaintext). `node scripts/deploy-appsail.js`
   merges them into a temporary `app-config.json`, runs
   `catalyst deploy appsail --name EcoGreenMigrationConsole --build-path . --stack node24 --command "npm start" --non-interactive`,
   and restores the tracked file even on failure. `--dry-run` prints the masked merged config.
3. Deployed configuration: `STORE_ADAPTER=catalyst`, `INBOX_ADAPTER=bundled`, `ARCHIVE_ADAPTER=disabled`
   (until Stratus is activated), `BOOKS_DRIVER=mock`, `POSTING_ENABLED=false`, `WORKER_MODE=disabled`,
   `DEV_SEED_ENABLED=true`, `APP_ENVIRONMENT=Development`, `NODE_ENV=production`, `BUILD_SHA=<git sha>`.
4. Seed the synthetic demo once: `POST /api/dev/seed` with an admin bearer token (Development only;
   idempotent; every approval tagged `[SYNTHETIC DEMO]`); poll `GET /api/dev/seed/status`.

Platform behaviours learned the hard way (all observed on CLI 1.27.2):
- `.catalystignore` is read line-by-line as raw **minimatch** patterns (`{dot:true}`) applied to files AND
  directories: comments are tolerated, but **negation (`!x`) is not** — `!README.md` excludes every file except
  README.md and produces an empty archive (the service then fails with `ENOENT /catalyst/package.json`).
  Directory lines need `dir/**`, not `dir/`. The CLI always excludes `catalyst.json`, `.catalystrc`,
  `app-config.json`, `.catalystignore` and `catalyst-debug.log` itself.
- The CLI uploads `node_modules` from the build path (no remote `npm install`); ship production deps only.
- AppSail rejects environment variable names with the `CATALYST_` prefix (`environment_variables must not
  contain reserved keywords`); the app therefore reads `APP_ENVIRONMENT` (and the runtime-provided
  `X_ZOHO_CATALYST_ENVIRONMENT`).
- The Catalyst MCP "application" env-variable tools address a different application ID space and reject
  AppSail IDs; env variables for AppSail go through `app-config.json` at deploy time or the console.
- The service listens on `X_ZOHO_CATALYST_LISTEN_PORT` (9000); requests time out at 30 s, so the seed job
  is detached from its request.

## 5. Production posting enablement procedure

Production posting is not authorized by any prompt, plan, or document in this
repository (`PROJECT_CONTEXT.md`, `CLAUDE_IMPLEMENTATION_PROMPT.md`). Enabling it
requires **all** of the following, in order, with evidence retained per
`IMPLEMENTATION_PLAN.md` §10:

1. Layer A `PASS` (or `PASS_WITH_APPROVED_EXCEPTIONS`) for the scope being posted.
2. Layer B bridge `PASS` — zero `PENDING` dispositions, all exclusions evidenced.
3. Smart Pharma overlap resolved for every in-scope voucher — no
   `PARTIAL_OR_AMBIGUOUS_OVERLAP` remaining.
4. Batch approval by an `approver`/`admin` distinct from the preparer, `scope_hash`
   matching current inputs (no drift).
5. A **separate written authorization**, outside this repository, from the Project
   owner and Finance lead, referenced in `POSTING_AUTHORIZATION_REF`.
6. Target `organizationId` added to `BOOKS_ORG_ALLOWLIST` for that environment only.
7. `POSTING_ENABLED=true` set by an operator directly in `.env` — never via an HTTP
   route, since none exists to do this.
8. `BOOKS_DRIVER=live` for that run only.

Steps 5–8 are configuration/authorization actions outside any script's control by
design — there is deliberately no automated path from "reconciliation passed" to "live
posting enabled." After a posting run, Layer C and the live balance bridge
(`RECONCILIATION.md` §4–§5) must both pass before sign-off, and any unexplained movement
blocks it.
