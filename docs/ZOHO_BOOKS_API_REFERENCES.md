# Zoho Books / Zoho OAuth API references (verified 2026-09-15)

Owner: this file (docs/ZOHO_BOOKS_API_REFERENCES.md). Access date for every row below is
**2026-09-15** unless noted otherwise. "Official" = a `zoho.com` or `help.zoho.com` page reached
directly; anything else consulted (blogs, third-party API directories, GitHub issues, community
forum questions with no staff answer) is called out explicitly as **not an official source** and
is never the sole basis for a `VERIFIED` marker in code.

Tooling note: pages were retrieved through an AI-summarizing fetch tool, not raw HTML capture, so
exact byte-for-byte header/field spelling should be treated as best-effort even where marked
VERIFIED. Where the summarizer could not surface a literal quote, that is called out below and the
corresponding code comment says `UNVERIFIED` instead of `VERIFIED`.

## OAuth 2.0

Source: https://www.zoho.com/books/api/v3/oauth/ (official, accessed 2026-09-15)

| Item | Value |
|---|---|
| Authorize URL | `{accounts_base}/oauth/v2/auth` |
| Authorize required params | `client_id`, `response_type=code`, `redirect_uri`, `scope` |
| Authorize optional params | `access_type=offline` (to receive a refresh token), `prompt=consent`, `state` |
| Token exchange URL | `{accounts_base}/oauth/v2/token` (POST) |
| Token exchange params | `grant_type=authorization_code`, `client_id`, `client_secret`, `redirect_uri`, `code` |
| Refresh URL | same as token exchange, `grant_type=refresh_token` + `refresh_token` |
| Token response | `access_token` (1 hour), `refresh_token` (until revoked), `expires_in` |
| Revoke URL | `{accounts_base}/oauth/v2/token/revoke` — **UNVERIFIED**: the fetched OAuth page did not surface this path in the summarized content; used here as the documented Zoho-wide revoke endpoint (consistent across Zoho accounts products), not independently re-confirmed against the Books-specific page on this pass. |

Per-DC `accounts_base` domains (VERIFIED, same page):
`accounts.zoho.com` (US/Global), `accounts.zoho.in` (India), `accounts.zoho.eu` (Europe),
`accounts.zoho.com.au` (Australia), `accounts.zoho.jp` (Japan), `accounts.zoho.com.cn` (China),
`accounts.zoho.sa` (Saudi Arabia), `accounts.zoho.ca` (Canada).

Multi-DC callback params (`location`, `accounts-server`): **UNVERIFIED** against this specific
page in this pass — Zoho's cross-product OAuth docs document these on the redirect back to
`redirect_uri` for multi-DC accounts, but the summarized Books OAuth page content did not quote
them verbatim. `src/books/connection.js#completeCallback` accepts and stores/ignores them
defensively without hard-failing if absent.

### Scopes

VERIFIED (same page + corroborated by search of the modules list): scope shape is
`ZohoBooks.<module>.<operation>` with operations `CREATE|READ|UPDATE|DELETE|ALL`. Module names
enumerated include: `contacts`, `settings`, `estimates`, `invoices`, `customerpayments`,
`creditnotes`, `projects`, `expenses`, `salesorder`, `purchaseorder`, `bills`, `debitnotes`,
`vendorpayments`, `banking`, `accountants`.

- `ZohoBooks.fullaccess.all` — VERIFIED (full-access convenience scope; documented as
  discouraged for production because a leaked refresh token then has full access).
- `ZohoBooks.settings.READ`, `ZohoBooks.contacts.READ`, `ZohoBooks.bills.READ`,
  `ZohoBooks.invoices.READ`, `ZohoBooks.accountants.READ` — VERIFIED (module names confirmed
  present; `READ` operation confirmed as a valid operation suffix).
- `ZohoBooks.reports.READ` — **UNVERIFIED**: no `reports` module was found in the enumerated
  scope-module list above. Zoho Books reports may be covered under `settings.READ` or another
  module instead of a dedicated `reports` scope; do not request `ZohoBooks.reports.READ` without
  confirming it is accepted by the authorize endpoint (Zoho silently drops unrecognised scope
  tokens rather than erroring, which can produce a token that looks fine but lacks the intended
  grant).

## Books REST API — base, auth, envelope

Source: https://www.zoho.com/books/api/v3/introduction/ (official, accessed 2026-09-15)

| DC | API base |
|---|---|
| US | `https://www.zohoapis.com/books/v3` |
| India | `https://www.zohoapis.in/books/v3` |
| Europe | `https://www.zohoapis.eu/books/v3` |
| Australia | `https://www.zohoapis.com.au/books/v3` |
| Japan | `https://www.zohoapis.jp/books/v3` |
| Canada | `https://www.zohoapis.ca/books/v3` |
| China | `https://www.zohoapis.com.cn/books/v3` |
| Saudi Arabia | `https://www.zohoapis.sa/books/v3` |

- Every request carries `organization_id` as a query parameter — VERIFIED.
- Auth header: `Authorization: Zoho-oauthtoken {access_token}` — VERIFIED.
- Response envelope: `{ "code": 0, "message": "success", ...payload }` on success — VERIFIED
  shape (module-specific payload key varies, e.g. `organizations`, `locations`, `invoices`).

### Rate limits

VERIFIED (numbers, from the official Introduction page): 100 requests/minute per organisation;
daily call caps by plan (Free 1,000/day, Standard 2,000/day, Professional 5,000/day, higher paid
tiers 10,000/day); concurrency caps by plan (Free 5 simultaneous calls, paid plans ~10, described
as a soft limit); exceeding the per-minute/daily cap returns HTTP 429 with Zoho error code 45
(daily) or 44 (per-minute); exceeding concurrency returns HTTP 429 with error code 1070.

**UNVERIFIED**: the exact rate-limit response header names. The official Introduction page (as
fetched) did not literally document `X-Rate-Limit-Limit` / `X-Rate-Limit-Remaining` /
`X-Rate-Limit-Reset` (or any header names at all) for Books specifically. Third-party sources
(a GitHub issue on an unofficial Zoho Books SDK, assorted blogs) mention `X-Rate-Limit-Limit`,
`X-Rate-Limit-Remaining`, `X-Rate-Limit-Reset` — this is plausible (Zoho's other products use this
convention) but is **not** independently confirmed against an official zoho.com/help.zoho.com
page in this pass, so `src/books/connection.js#testConnection` reads these header names
opportunistically (best-effort, tolerant of absence) rather than assuming they will be present.

## Organizations

Source: https://www.zoho.com/books/api/v3/organizations/ (official, accessed 2026-09-15)

- `GET /organizations` — list; scope `ZohoBooks.settings.READ`. Envelope:
  `{ code, message, organizations: [...] }`.
- `GET /organizations/{organization_id}` — single; envelope `{ code, message, organization: {...} }`.
- Fields (VERIFIED present): `organization_id`, `name`, `currency_code`, `time_zone`,
  `country` (nested inside the organization's address-shaped fields — used here as the "region"
  proxy since the docs did not surface a flat top-level `region` field), `is_default_org`,
  `is_org_active`.

## Locations

Source: https://www.zoho.com/books/api/v3/locations/ (official, accessed 2026-09-15, reached via
search after `.../branches/` 404'd — Zoho Books v3 API docs use **"Locations"**, not "Branches";
the nav enumeration of https://www.zoho.com/books/api/v3/ confirms "Locations" as the only such
entry, no "Branches" entry exists in the v3 REST reference)

- `GET /locations` — list; requires `organization_id`. Envelope: `{ code, message, locations: [...] }`.
- Fields (VERIFIED present): `location_id`, `location_name`, `status` (`"active"` | `"inactive"`
  — string, not boolean), `is_primary`, `type` (`"general"` | `"line_item_only"`), `address`,
  `email`, `phone`.

## Reports — Trial Balance

**UNVERIFIED / likely not present in the current public v3 REST reference.** The full navigation
of https://www.zoho.com/books/api/v3/ was enumerated on 2026-09-15 (50 entries, from
"Introduction" through "Reporting Tags") and contains **no** "Reports", "Trial Balance", "Profit
and Loss", "Balance Sheet", or "Cash Flow" entry at all. A Zoho community post
(https://help.zoho.com/portal/en/community/topic/trial-balance-via-rest-api, accessed
2026-09-15) shows a user asking "Is there a way to pull a trial balance via the REST API?" with
**no answer visible** in the fetched content — i.e. this is a known open question in the Zoho
community, not a documented gap on our side.

Consequence for `src/books/live.js#getTrialBalance`: the assumed path
`GET /reports/trialbalance` (with `location_id`/`from_date`/`to_date`/`organization_id`) is
**left as UNVERIFIED**, not upgraded to VERIFIED. It is the most defensible guess (Zoho's other
report-shaped endpoints, e.g. `reports/profitandloss`, `reports/balancesheet`,
`reports/cashflow`, follow the `reports/<snake-ish-name>` convention per third-party
directories — not independently confirmed as an official source, only used to justify the guess's
shape), but a caller relying on it MUST confirm the actual path/params against a live sandbox
organisation (or an authenticated support ticket) before this path goes anywhere near a real
migration run. `mock.js#getTrialBalance` (derived from stored double-entry `effects`, never
calling this endpoint) remains the only trial-balance source this MVP actually depends on.

## Modules used by `src/books/live.js` MODULE_PATH

Sources: module-specific pages under https://www.zoho.com/books/api/v3/ (official, accessed
2026-09-15) plus the full nav enumeration above (confirms every module name/slug exists as a
top-level doc page).

| Module key (this repo) | Zoho doc page | Endpoint path segment | Status |
|---|---|---|---|
| `journal` | `.../journals/` | `/journals` | VERIFIED (GET + POST both `/journals`) |
| `bill` | `.../bills/` | `/bills` | VERIFIED (GET + POST both `/bills`) |
| `invoice` (not yet in MODULE_PATH; listed for completeness) | `.../invoices/` | `/invoices` | VERIFIED |
| `credit_note` | `.../credit-notes/` (nav slug `Credit Notes`) | `/creditnotes` | VERIFIED (path segment confirmed via search of the live API path, distinct from the doc-page URL slug which uses a hyphen) |
| `vendor_credit` | `.../vendor-credits/` | `/vendorcredits` | VERIFIED |
| `customer_payment` | `.../customer-payments/` | `/customerpayments` | VERIFIED |
| `vendor_payment` | `.../vendor-payments/` | `/vendorpayments` | VERIFIED |
| `expense` | `.../expenses/` | `/expenses` | VERIFIED (nav entry confirms module exists; standard `/expenses` path corroborated by the same source that confirmed the other `/…s` module paths) |
| `bank_transfer` → renamed `bank_transaction` in the fixed MODULE_PATH below | `.../bank-transactions/` | `/banktransactions` | **VERIFIED — corrects a prior bug.** The old code mapped `bank_transfer` to `banktransfers`, which is not a real Zoho Books v3 endpoint; the confirmed endpoint is `/banktransactions` (nav entry "Bank Transactions"; endpoint `https://www.zohoapis.com/books/v3/banktransactions/` per search of the official doc page, with documented transaction types `deposit`, `refund`, `transfer_fund`, `card_payment`, `sales_without_invoices`, `expense_refund`, `owner_contribution`, `interest_income`, `other_income`, `owner_drawings`, `sales_return`). |

Note on doc-page URL slugs vs. API path segments: Zoho's documentation pages use hyphenated
slugs (`credit-notes`, `vendor-credits`, `customer-payments`, `vendor-payments`,
`bank-transactions`) but the actual REST path segments are the un-hyphenated, pluralised forms
shown in the table (`creditnotes`, `vendorcredits`, `customerpayments`, `vendorpayments`,
`banktransactions`) — this repo's `MODULE_PATH` map in `src/books/live.js` uses the API path
segments, not the doc slugs.

### Date-range filters and custom-field search

**UNVERIFIED, with specifics.** The Journals and Bills doc pages, as fetched, did not surface an
explicit `date_start`/`date_end`/`from_date`/`to_date` query-parameter section in the summarized
content, so `live.js#listRecordsInWindow`'s `date_start`/`date_end` parameter names remain
best-effort/UNVERIFIED — they match Zoho's general list-endpoint convention seen elsewhere in the
product family, but were not confirmed verbatim on the Books v3 pages reached this pass.

For custom-field search, a Zoho community thread
(https://help.zoho.com/portal/en/community/topic/books-api-search-invoices-by-custom-fields-variants-custom-field-startswith-and-custom-field-contains,
accessed 2026-09-15) shows a real caller using `custom_field_startswith` /
`custom_field_contains` as list-filter query parameters (e.g.
`params.put("custom_field_startswith", "zcrm_potential_id")`), which is a **different** shape
from this repo's prior assumption of a flat `cf_migration_source_hash` query parameter. Neither
shape is fully confirmed end-to-end (the thread itself is a caller asking Zoho to clarify the
rest of the syntax, with no staff answer visible in the fetched content) — `live.js` is updated
to try the `cf_<fieldname>` exact-match style query param (the simpler, more commonly documented
shape across Zoho's REST APIs for custom-field equality filtering) and this is called out as
UNVERIFIED in-line; do not depend on this for production idempotency checks without a live-sandbox
confirmation.

## Sources consulted (official only, unless explicitly marked otherwise)

- https://www.zoho.com/books/api/v3/oauth/ — 2026-09-15
- https://www.zoho.com/books/api/v3/introduction/ — 2026-09-15
- https://www.zoho.com/books/api/v3/organizations/ — 2026-09-15
- https://www.zoho.com/books/api/v3/locations/ — 2026-09-15
- https://www.zoho.com/books/api/v3/journals/ — 2026-09-15
- https://www.zoho.com/books/api/v3/bills/ — 2026-09-15
- https://www.zoho.com/books/api/v3/invoices/ — 2026-09-15
- https://www.zoho.com/books/api/v3/ (nav enumeration) — 2026-09-15
- https://help.zoho.com/portal/en/community/topic/trial-balance-via-rest-api — 2026-09-15 (community, no staff answer visible; used only to corroborate the absence of a documented endpoint)
- https://help.zoho.com/portal/en/community/topic/books-api-search-invoices-by-custom-fields-variants-custom-field-startswith-and-custom-field-contains — 2026-09-15 (community, partial answer; used only to corroborate custom-field filter shape)

Not official (referenced only to sanity-check path shapes already corroborated by an official
source above; never the sole basis for a VERIFIED marker): third-party API directories and blogs
surfaced by search (e.g. getknit.dev, aiproductivity.ai) and a GitHub issue on an unofficial
Zoho Books client library (mentions of `X-Rate-Limit-*` headers).

## Connection readiness

Short, non-secret summary — the full private checklist (with the exact redirect URL, per-scope
verified/assumed status, and env var list) lives at `var/private/BOOKS_CONNECTION_CHECKLIST.md`
(gitignored; not part of this repo's history). Access date for the citations below: 2026-09-15.

### Zoho API Console client type

Register a **Server-based Applications** client (not Self Client, which has no redirect URL and
is meant for backend-only, no-user-interaction access). Source:
https://www.zoho.com/books/api/v3/oauth/ and
https://www.zoho.com/accounts/protocol/oauth/self-client/overview.html (official, 2026-09-15).

### Required READ-only scopes

Read-only scopes only, never `ZohoBooks.fullaccess.all`. Verified module names (confirmed present
in the official scopes table): `settings`, `contacts`, `bills`, `invoices`, `creditnotes`,
`customerpayments`, `vendorpayments`, `expenses`, `accountants`. Assumed/unconfirmed module names
used for chart of accounts, journals, vendor credits, and bank transactions, plus the absence of
any `reports` scope — see the private checklist §3 for the full per-scope table and citations.

### India region endpoints

Accounts/OAuth: `https://accounts.zoho.in`. Books REST API base:
`https://www.zohoapis.in/books/v3`. (Same values already in this file's OAuth and REST sections
above.)

### Who must authorise

Two separate approvals are required before any read access goes live: (1) the Zoho Books
organisation admin of the Eco Green org performs the OAuth consent itself, and (2) the project
owner separately approves read-only access in writing before `BOOKS_READ_AUTHORIZED` is set. See
the private checklist §6 for the full statement.
