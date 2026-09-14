# WORKDRIVE_INGESTION.md — WorkDrive Inbox Contract

Status: **in progress (wave 1)**. Describes the inbox contract implemented against
`CONTRACTS.md` §I and `DATA_CONTRACT.md`. No WorkDrive credential is configured in this
environment (CONFIRMED); the WorkDrive adapter is a stub. All statements about the real
WorkDrive REST API below are marked TODO and must be verified against current Zoho
WorkDrive documentation before implementation.

## 1. Folder contract

One extraction run = one branch × one date range × one versioned query set, delivered as
a folder:

```
<inbox>/<branch_code>/<extraction_run_id>/
  manifest.json
  transactions.csv
  trial_balance.csv
```

`manifest.json` is written **last** by the extractor so a folder is never picked up
half-written. See `DATA_CONTRACT.md` §1–§2 for the manifest schema.

## 2. Completeness rule

`inbox.listRuns()` returns a run only when `manifest.json` is present **and** every
file it lists in `files[]` exists in the folder. A folder missing any listed file, or
with `manifest.json` absent, is not returned — it is neither accepted nor rejected,
simply not yet visible to the worker. This avoids the extractor's temporary
write-in-progress state ever being ingested.

## 3. Pickup and claim

1. Worker calls `inbox.listRuns()`, receiving complete runs only (§2).
2. Registers the run (`extraction_runs`, status `RECEIVED`) keyed by `manifest_sha256` —
   an already-registered hash is a duplicate delivery, rejected without a second row.
3. `store.claim('extraction_runs', id, {expectedStatus:'RECEIVED', newStatus:'CLAIMED'})`
   — a single atomic UPDATE guarded by expected status and claim expiry, so two workers
   racing the same run converge on exactly one winner (`CONTRACTS.md` §S).
4. `inbox.markPicked(inboxRef, { workerId })` records pickup (local: a
   `.picked-by-<workerId>` marker file; WorkDrive: same call, still a stub, §6).
5. A lost claim leaves the run `RECEIVED` for the next poll — nothing is duplicated or
   discarded.

## 4. Hashing

Every file's raw bytes are hashed (sha256) and compared against the manifest's declared
hash before anything else happens. File hash and size are independent checks; a
mismatch on either quarantines the file (`VALIDATION_FAILED`, `validation_json` records
the reason) rather than being silently accepted. File hashes are stored separately from
the per-voucher `source_transaction_hash` — a file-level duplicate (same sha256 as an
already-registered file) and a transaction-level duplicate (same canonical business key)
are distinct failure modes and are reported as distinct exception categories
(`DUPLICATE_FILE` vs `DUPLICATE_SOURCE`).

## 5. Quarantine and archive

- A file that fails hash, size, encoding, header, or content checks is marked
  `QUARANTINED` in `source_files`; the owning run moves to `VALIDATION_FAILED` and is
  not staged.
- A file that passes validation is copied byte-for-byte into the immutable archive
  (`archive.put`, `CONTRACTS.md` §R) before any transformation happens. The archive
  write is idempotent for an identical sha256 at the same logical path and throws
  `IMMUTABLE_CONFLICT` if a different sha256 is ever written to the same path — raw
  evidence is never overwritten in place.
- Archived originals are the system of record for "what was actually received";
  WorkDrive itself is the landing inbox only, not the immutable store
  (`PROJECT_CONTEXT.md`).

## 6. What the real WorkDrive adapter will need (TODO — verify against current docs)

The stub (`src/adapters/inbox/workdrive.js`) throws `NOT_CONFIGURED` unless all
`WORKDRIVE_*` environment variables are set, and `NOT_IMPLEMENTED` even then. When
implemented, it needs, at minimum, calls broadly equivalent to:

- **List folder contents** under `WORKDRIVE_FOLDER_ID`, filtered to run subfolders — TODO: confirm the current Files API listing endpoint and pagination model.
- **Download file content** by file ID — TODO: confirm the current download endpoint and whether range requests are needed for large files.
- **Read folder/file metadata** (name, size, modified time) to detect a folder still being written — TODO: confirm whether WorkDrive exposes an atomic "upload complete" signal beyond file presence.
- **Mark a picked-up file** so a second worker does not reprocess it — TODO: confirm custom metadata/tag support, or track "picked" only in this system's own store (recommended — WorkDrive should stay a dumb inbox).
- **OAuth token refresh** for the WorkDrive scope, same encrypted-token pattern as the Books client (`CONTRACTS.md` §Z `live.js`) — TODO: confirm current scope names.

None of this has been implemented or tested against a real WorkDrive tenant.

## 7. Credentials — what is needed and where it lives

- `.env` (never committed) holds `WORKDRIVE_FOLDER_ID`, `WORKDRIVE_CLIENT_ID`,
  `WORKDRIVE_CLIENT_SECRET`, `WORKDRIVE_REFRESH_TOKEN` (see `.env.example`).
- No WorkDrive credential exists in this environment today (CONFIRMED). Obtaining one is
  an open dependency, not something this pilot can self-provision.
- When configured, refresh tokens must be encrypted at rest using `APP_ENCRYPTION_KEY`,
  the same mechanism used for the Books OAuth token (`CONTRACTS.md` §Z), and must never
  appear in logs, fixtures, or the audit trail (`src/core/log.js#redact`).
