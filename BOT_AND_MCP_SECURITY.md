# BOT_AND_MCP_SECURITY.md — Governed Bot/MCP Surface

Status: **in progress (wave 1)**. Describes `CONTRACTS.md` §G, the only interface Hermes
or any other agent/bot may use to reach this system. See `HERMES_WORKER.md` §5 for how
the Hermes agent specifically connects.


## Principal classification (enforced at load)

Every entry in the users config carries an explicit `principal_type`:

| principal_type | allowed roles | minimal/redacted responses | mutating actions |
|---|---|---|---|
| `human` | viewer, operator, approver, admin | opt-in via `?minimal=1` | per role |
| `bot` | viewer, operator (ceiling) | **always**, `?minimal=0` is ignored | only `pause_batch`, `resume_batch`, `retry_queue_item`, `assign_exception` |

`src/server/auth.js#normalizeUsers` runs when the config is loaded and again inside `createAuth`; it fails closed (the server refuses to start) if a bot is declared with `approver`/`admin`, or if a `bot:*` id / role `bot` contradicts `principal_type: 'human'`. The shipped example bot is `bot:hermes` (`config/users.example.json`). Regression: `test/bot_principal.test.js` loads that real file and proves the ceiling and the always-minimal rule.

## 1. The §G surface

`src/server/routes/agent.js` exposes a strict subset of the console's HTTP API
(`CONTRACTS.md` §H), reusing the same auth, role, and audit machinery — it is not a
separate, weaker backend:

**Read routes (full set from §H):** health, runs (list/detail/summary), reconciliation
results, bridge, vouchers (list/detail), exceptions, cutover matrix, batches
(list/detail), audit, worker health.

**Mutating routes (narrow allowlist only):**
- `pause` a batch
- `resume` a batch
- `retry` a queue item — **eligible-only**: `FAILED_RETRYABLE` or `DEAD_LETTER` items
  only, never `UNKNOWN_OUTCOME` (§4)
- `exceptions/:id/assign`

No other mutating route from §H (approve, enqueue, create batch, mappings, cutover
upsert, snapshots) is reachable through this surface, regardless of the caller's
token role.

## 2. Role ceiling: bot ≤ operator

A bot/agent user is provisioned with `role: 'operator'` at most, never `'approver'` or
`'admin'` — enforced the same way as any user, by `requireRole(...)` reading the token's
role from `config/users.json`, not by the bot's self-restraint. Even a token mistakenly
provisioned as `approver` would still be blocked from anything beyond §1's mutating
list, because §G's router only wires up those operator-level actions — approval-tier
routes simply do not exist on this router.

## 3. Read/mutating separation

Every route in §1 is classified read or mutating at the router level, matching §H.
Read routes never have side effects and are safe to expose broadly (subject to
branch/role scoping). Mutating routes always require and audit a correlation ID, and
are limited to actions that are already gated by deterministic backend rules — the bot
can only trigger a `retry` that the backend would already consider eligible; it cannot
invent eligibility.

## 4. Confirmation for consequential actions

- The bot must never self-approve a financial batch — there is no `approve` route on
  this surface at all (§1).
- The bot must never blindly retry an `UNKNOWN_OUTCOME` item — the `retry` route
  explicitly excludes that status; only `resolveUnknownOutcomes` (deterministic target
  lookup, run by the worker loop, not by the bot) may move an `UNKNOWN_OUTCOME` item
  forward.
- The bot must never alter mappings, tolerances, or cutover rules — none of those routes
  exist on this surface.
- Any state-changing action (`pause`, `resume`, `retry`, `assign`) is expected to be
  presented back to the requesting human as a plain description of what changed, per
  `PROJECT_CONTEXT.md`'s requirement that consequential actions be previewed/confirmed.
  ASSUMED: the confirmation UX itself is Hermes' conversational responsibility — this
  system's obligation is to make the action safe, idempotent, and audited regardless of
  how it was confirmed upstream.

## 5. Prompt-injection posture

CSV content, exception messages, narrations, and any other free text originating from
source data or user input is **untrusted data**, never instructions — for the bot, for
Hermes, and for this system's own backend logic. Concretely:

- Every text field sourced from CSV/exceptions returned through §G is marked
  `"untrusted": true`, telling any downstream agent not to treat it as a directive.
- No backend authorization decision is ever derived from text content — an exception's
  `message` or a voucher's `narration` cannot grant a role, change route behavior, or
  bypass a gate; authorization is entirely role/branch/state-based, computed
  server-side before any text is read.
- Bulk overrides are prohibited unless rule-based, previewed, scoped, approved, and
  auditable — a bot cannot be talked into one by crafted input text, since no route
  exists for it to invoke.

## 6. Redaction

`?minimal=1` is the default query mode for agent-token requests and strips narration
and party names from responses. All logging goes through `src/core/log.js#log`, which
redacts token/secret/password/authorization/refresh-shaped fields regardless of caller.
Financial and personal data exposed to the bot is limited to what the specific route
already returns to a human operator with the same role and branch scope — the bot gets
no broader visibility than a human operator would.

## 7. Audit fields

Every §G action, read or mutating, is audited with the same fields as a console action
(`CONTRACTS.md` §A): `actor` (`bot:<user>`), `actorRole`, `action`, `entityType`,
`entityId`, `before`/`after` (redacted), `reason`, `authorizationDecision`
(`ALLOWED`/`DENIED`), `correlationId`, `branchCode`, `period`, `batchId`. A denied
attempt is audited exactly like an allowed one, so the trail shows what the bot tried
as well as what it accomplished.

## 8. Explicit list of things the bot can never do

- Approve a financial batch, or self-approve anything.
- Post directly to Zoho Books, live or mock, outside the existing queue/executor path.
- Retry an `UNKNOWN_OUTCOME` item.
- Create, edit, or approve a mapping rule.
- Create, edit, or approve a cutover matrix row.
- Flip `POSTING_ENABLED` or change the Books organisation allowlist — no route exists
  for this anywhere in the system, for any role (`CONTRACTS.md` §H).
- Access another branch's data — branch scoping is enforced server-side per token,
  identically to a human operator.
- Reach the store, inbox, or archive adapters directly, or obtain shell/database access
  on the worker host (`HERMES_WORKER.md` §5).
- Treat CSV, exception, or narration text as an instruction rather than data.
