# SECURITY.md — Threat Model and Controls

Status: **in progress (wave 1)**. This describes the design in `CONTRACTS.md` and the
`.env.example` configuration surface. No security review, penetration test, or
production deployment has occurred. This is a pilot handling no real financial or
personal data yet (CONFIRMED — no Eco Green data has been received).

## 1. Threat model (summary)

| Threat | Primary control |
|---|---|
| Accidental live posting to a real Zoho Books org during development | Four independent gates in `assertPostingAllowed()` (§3) |
| Leaked OAuth/API credentials | `.env`-only secrets, never in code/logs/fixtures; encrypted-at-rest tokens |
| Cross-branch data access | Server-side branch scoping on every route, not UI-only |
| Duplicate financial postings from a retried or replayed request | Database-enforced uniqueness on `source_transaction_hash` and `idempotency_key`; atomic claims |
| Malicious or malformed uploaded CSV/manifest | Strict schema, encoding, hash, and content validation before any data is trusted |
| Prompt injection via CSV/exception text reaching the bot | Text is always data, never instructions (`BOT_AND_MCP_SECURITY.md` §5) |
| Self-approval of a financial batch | Segregation-of-duties check (approver ≠ preparer), enforced server-side |
| Silent audit tampering | Audit is append-only; no update/delete path exists |
| Secrets committed to a public repository | `.gitignore`, `.env.example` only, `scripts/check-secrets.js` pre-publish gate |

## 2. Secrets handling

- All secrets (`WORKDRIVE_CLIENT_SECRET`, `WORKDRIVE_REFRESH_TOKEN`, `BOOKS_CLIENT_SECRET`,
  `BOOKS_REFRESH_TOKEN`, `APP_ENCRYPTION_KEY`, `JWT_SECRET`) live only in `.env`
  (git-ignored); `.env.example` ships empty/placeholder values only.
- Stored OAuth refresh tokens are encrypted at rest using `APP_ENCRYPTION_KEY`, following
  the pattern ported from the Tally tool's `server/src/services/zoho.js` (`CONTRACTS.md`
  §Z).
- Catalyst configuration, once a project exists (D-1), follows the same rule: no tenant
  IDs, project IDs, or credentials committed.
- No script ever prints a secret value. `scripts/seed-fixtures.js` prints dev tokens
  **once** to stdout for local convenience, never persisted in plaintext elsewhere.

## 3. Org allowlist and posting guard

`client.isPostingEnabled()` (`CONTRACTS.md` §Z) returns true only when **all four** are
simultaneously true:

1. `POSTING_ENABLED === 'true'`
2. `POSTING_AUTHORIZATION_REF` is non-empty
3. `config.organizationId` is present in `BOOKS_ORG_ALLOWLIST`
4. the active driver is `'live'` (not `'mock'`)

The live driver throws `POSTING_DISABLED` **before any network call** if the guard
fails — a misconfigured environment cannot accidentally reach a real Books org even
transiently. Default configuration ships with `POSTING_ENABLED=false` and an empty
allowlist. No route in the HTTP API can flip `POSTING_ENABLED` (`CONTRACTS.md` §H) —
enabling it requires an operator to edit environment configuration directly, which is
itself the intended friction point before production posting (`DEPLOYMENT.md`).

## 4. RBAC and segregation of duties

Roles: `viewer`, `operator`, `approver`, `admin` (`config/users.json`, hashed bearer
tokens). `requireRole(...)`/`scopeBranch` enforce access server-side on every route; a
request whose branch is outside the caller's `branches` list gets 403 and an audited
`DENIED` decision. Segregation of duties: `approveBatch` requires `approver`/`admin` and
rejects `approver === batch.created_by`, controlled by `SOD_ENFORCED` (default `true`).
Any exception requires Finance-lead sign-off (D-10) and has not been granted.

## 5. Audit immutability

`audit_events` is append-only — `src/core/audit.js#emit` only inserts; there is no
update or delete path anywhere in the codebase for this table. Every mutating action,
allowed or denied, is recorded with actor, role, action, entity, before/after (redacted),
reason, authorization decision, correlation ID, and branch/period/batch context.
Resolving an exception or invalidating an approval updates the owning row's status but
never erases the exception's or approval's history — new audit rows are added instead.

## 6. Upload validation

Every CSV/manifest is validated before being trusted, in order: encoding detection
(reject `unknown`), RFC 4180 parsing with explicit error codes, manifest schema and
`contract_version` check, per-file sha256/size against the manifest, header exact match,
then row-level content checks (branch match, date range, exactly one of debit/credit
non-zero, enum membership, money parseability). Malformed or mismatched files are
quarantined, never partially trusted — the pipeline's only entry point for uncontrolled
external content.

## 7. Environment isolation

Each environment (development, test/UAT, production) runs its own `.env`,
`BOOKS_ORG_ALLOWLIST`, and adapter targets. Development/UAT must be structurally unable
to reach a live production org — enforced by the §3 allowlist check, not convention: an
org ID absent from an environment's allowlist can never be posted to from it regardless
of any other flag. No environment split has been deployed or tested yet; carried into
`DEPLOYMENT.md` as a design requirement.

## 8. Logging redaction

`src/core/log.js#log` redacts any field whose key matches
`/token|secret|password|authorization|refresh/i` before writing a JSON line to stdout.
`redact()` is exported and reused by the audit module for `before`/`after` payloads.
API attempt records (`api_attempts.error_message`) are explicitly documented as
redacted, never a full request/response payload (`CONTRACTS.md` §Z).

## 9. Vulnerability reporting

This is a pilot repository with no production deployment. Until a dedicated security
contact is designated, report a suspected vulnerability or exposed secret to the
**Project owner** (see `IMPLEMENTATION_PLAN.md` owner list) rather than opening a public
issue, and do not include the sensitive value itself in the report.

## 10. Pre-publish checklist

Before any push to a public repository:

1. Run `npm run check:secrets` (`scripts/check-secrets.js`) — scans for token/secret
   patterns and real-looking GSTIN/PAN/phone/email; must exit zero.
2. Review the full staged diff manually (`git diff --staged`) — do not rely on the
   secret scanner alone.
3. Confirm `.env` is not staged and `.gitignore` covers it.
4. Confirm no fixture contains anything other than the synthetic data described in
   `DATA_CONTRACT.md` §8 (obviously fake codes/names, no real people, companies,
   GSTINs, or amounts).
5. Confirm `POSTING_ENABLED=false` and `BOOKS_ORG_ALLOWLIST` empty in every committed
   `.env.example`/config template.
6. Confirm no Catalyst project ID, data-center detail, or org ID appears anywhere in
   committed files.
