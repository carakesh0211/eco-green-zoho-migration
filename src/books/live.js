// Zoho Books v3 live driver.
//
// PORTED (shape only) from tally-zoho-dataMigrator/server/src/services/zoho.js#liveApi: native
// `fetch`, `Authorization: Zoho-oauthtoken <token>` header, `organization_id` query param,
// `AbortSignal.timeout(...)`, JSON request/response bodies. DROPPED: the Tally tool's per-record
// `record_type` switch (`account`/`contact`/`journal`/`opening_balance` push/fetch handlers),
// its module-scoped name-resolution caches (`liveNameCaches`), and all multi-client/tenant
// plumbing — this driver exposes exactly the generic surface CONTRACTS.md §Z asks for
// (`getOrganization`, `getLocations`, `getTrialBalance`, `searchByMigrationTag`,
// `listRecordsInWindow`, `create`) and lets the caller (src/core/transform.js, out of scope here)
// decide the module/payload shape.
//
// Written fresh for this adapter: the guard integration (`assertPostingAllowed`/`assertOrgAllowed`
// from guard.js), routing every call through `limiter.js` (rate limit + concurrency + retry),
// response classification via `classify.js`, and the UNKNOWN-vs-RETRYABLE "sent" flag described
// below (the Tally tool had no equivalent distinction).
//
// UNKNOWN-outcome detection ("sent" flag):
//   We cannot observe, with native fetch, the exact moment request bytes left the process. As a
//   conservative proxy, `sent` is set to true immediately after `fetch()` is invoked (before
//   awaiting it) — i.e. as soon as we know the runtime has begun dispatching the request. If the
//   fetch call itself throws synchronously (before that flag is set — e.g. a malformed URL), the
//   request never left, so it is always safe to retry. If a timeout/AbortError fires AFTER that
//   point, we conservatively assume the request MAY have reached Zoho:
//     - for WRITE calls (`create`) this is classified UNKNOWN and is NEVER retried automatically
//       (a blind retry could create a duplicate financial transaction);
//     - for READ calls this is classified RETRYABLE (a read has no side effect to duplicate).
//   This mirrors CONTRACTS.md §Z / PROJECT_CONTEXT.md "Identity and idempotency": "If a request
//   times out after submission, treat the result as unknown."

import { assertPostingAllowed, assertOrgAllowed } from './guard.js';
import { classifyResponse } from './classify.js';
import { createLimiter, withRetry } from './limiter.js';
import { getAccessToken } from './oauth.js';

// VERIFIED(docs/ZOHO_BOOKS_API_REFERENCES.md#modules-used-by-srcbookslivejs-module_path, 2026-09-15):
// module -> Books v3 endpoint segment mapping, checked against the official per-module doc pages
// under https://www.zoho.com/books/api/v3/ (journals, bills, credit-notes, vendor-credits,
// customer-payments, vendor-payments, bank-transactions all confirmed present in the v3 REST
// nav) plus the plain `/expenses` path (module confirmed present in the same nav enumeration).
// One bug fixed by this verification pass: `bank_transfer` previously mapped to `banktransfers`,
// which is NOT a real Zoho Books v3 endpoint — the confirmed endpoint is `/banktransactions`
// (Zoho's "Bank Transactions" module: deposit/refund/transfer_fund/card_payment/... transaction
// types). NOTE: Zoho's "Bank Transactions" module is the bank-feed/reconciliation list, which may
// not be a perfect semantic match for this repo's `bank_transfer` concept (an internal transfer
// between two of our own GL bank accounts, see gl_effects.js/transform.js) — Zoho also exposes a
// separate "Transfer Funds" action under Bank Accounts for that exact case. Left as `banktransactions`
// here (the only real endpoint under that name) but flagged: confirm against a live sandbox org
// before this path is used to actually post a bank_transfer record.
const MODULE_PATH = Object.freeze({
  bill: 'bills',
  vendor_payment: 'vendorpayments',
  customer_payment: 'customerpayments',
  expense: 'expenses',
  credit_note: 'creditnotes',
  vendor_credit: 'vendorcredits',
  bank_transfer: 'banktransactions',
  journal: 'journals',
});

function modulePath(module) {
  return MODULE_PATH[module] ?? `${module}s`;
}

function buildUrl(config, path, query = {}) {
  const url = new URL(`${config.apiBase}${path}`);
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  return url;
}

function attachClassification(err, classification) {
  err.classification = classification;
  return err;
}

/**
 * Performs a single classified HTTP attempt (no retry, no rate limiting — that's the caller's
 * job). Never throws for an HTTP-level failure: it resolves `{ classification, value, error }` so
 * `withRetry` can decide what to do without needing exceptions for control flow.
 */
async function attemptOnce(config, { method, path, query, body, idempotencyKey, isWrite }) {
  let sent = false;

  let accessToken;
  try {
    accessToken = await getAccessToken(config);
  } catch (authErr) {
    return { classification: authErr.classification ?? { class: 'AUTH', reason: authErr.message }, error: authErr };
  }

  const headers = { 'Content-Type': 'application/json' };
  headers.Authorization = `Zoho-oauthtoken ${accessToken}`;
  if (idempotencyKey) {
    // Zoho Books may or may not honour/store this header — it is not documented as an
    // idempotency mechanism for every module. Our REAL idempotency guarantee is the
    // migration tag (custom_fields.cf_migration_source_hash) plus queue_items' unique
    // idempotency_key (source_transaction_hash), enforced at our own database level and via
    // `searchByMigrationTag` lookups — this header is best-effort defence in depth only.
    headers['X-Idempotency-Key'] = idempotencyKey;
  }

  const url = buildUrl(config, path, { organization_id: config.organizationId, ...query });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs ?? 30_000);

  try {
    const fetchPromise = fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    sent = true; // request dispatch has begun; see UNKNOWN-detection doc above
    const res = await fetchPromise;
    clearTimeout(timer);

    let json = null;
    let bodyParseError = false;
    try {
      const text = await res.text();
      json = text ? JSON.parse(text) : {};
    } catch {
      bodyParseError = true;
    }

    const classification = classifyResponse({
      status: res.status,
      retryAfterHeader: res.headers.get('retry-after'),
      bodyParseError,
    });

    if (classification.class === 'SUCCESS') {
      return { classification, value: json };
    }
    const err = attachClassification(
      new Error(`Zoho Books API ${classification.class} (http ${res.status}): ${json?.message ?? classification.reason}`),
      classification,
    );
    err.httpStatus = res.status;
    err.body = json;
    return { classification, error: err };
  } catch (err) {
    clearTimeout(timer);
    const aborted = err.name === 'AbortError';
    let cls;
    if (aborted) {
      cls = sent ? (isWrite ? 'UNKNOWN' : 'RETRYABLE') : 'RETRYABLE';
    } else {
      cls = 'RETRYABLE';
    }
    const classification = { class: cls, reason: aborted ? 'timeout_or_abort' : (err.code || err.message || 'network_error') };
    return { classification, error: attachClassification(err, classification) };
  }
}

function doRequest(config, limiter, opts) {
  return withRetry(
    (attempt) => limiter.schedule(() => attemptOnce(config, { ...opts, attempt })),
    {
      maxAttempts: config.maxAttempts ?? 5,
      baseMs: 500,
      maxMs: 30_000,
      honourRetryAfter: true,
    },
  );
}

export function createLiveClient(config) {
  const limiter = createLimiter({
    ratePerMinute: config.rateLimitPerMinute ?? 100,
    maxConcurrency: config.maxConcurrency ?? 2,
  });

  function read(path, query) {
    assertOrgAllowed(config); // dev/UAT pointed at the wrong org cannot even read it
    return doRequest(config, limiter, { method: 'GET', path, query, isWrite: false });
  }

  return {
    // VERIFIED(https://www.zoho.com/books/api/v3/organizations/, 2026-09-15): GET
    // /organizations/{organization_id} returns { code, message, organization: {...} }.
    async getOrganization() {
      const json = await read(`/organizations/${config.organizationId}`);
      return json.organization ?? json;
    },

    // VERIFIED(https://www.zoho.com/books/api/v3/locations/, 2026-09-15): GET /locations returns
    // { code, message, locations: [...] }. Zoho Books v3 uses "Locations" terminology exclusively
    // — there is no "Branches" endpoint in the current v3 REST reference (confirmed by enumerating
    // the full nav of https://www.zoho.com/books/api/v3/ on the access date above).
    async getLocations() {
      const json = await read('/locations');
      return json.locations ?? [];
    },

    async getTrialBalance({ locationId, fromDate, toDate } = {}) {
      // UNVERIFIED (docs/ZOHO_BOOKS_API_REFERENCES.md#reports--trial-balance, 2026-09-15): the
      // full nav of https://www.zoho.com/books/api/v3/ was enumerated on the access date above
      // and contains NO "Reports"/"Trial Balance" entry at all in the current public v3 REST
      // reference; a Zoho community post asking the same question has no visible answer. The path
      // below (`/reports/trialbalance` with location_id/from_date/to_date) is the most defensible
      // guess (matches the `reports/<name>` shape used by Zoho's other report-style endpoints
      // referenced in third-party directories) but is NOT confirmed against an official page —
      // do not rely on this for a real migration run without confirming against a live sandbox
      // organisation first. `mock.js#getTrialBalance` (derived from stored double-entry effects)
      // is the only trial-balance source this MVP actually depends on.
      return read('/reports/trialbalance', { location_id: locationId, from_date: fromDate, to_date: toDate });
    },

    async searchByMigrationTag({ module, sourceHash } = {}) {
      // UNVERIFIED (docs/ZOHO_BOOKS_API_REFERENCES.md#date-range-filters-and-custom-field-search,
      // 2026-09-15): a Zoho community thread shows real callers filtering by custom field via
      // `custom_field_startswith`/`custom_field_contains` query params, a different shape from
      // the flat `cf_<fieldname>` equality filter assumed below; neither shape is confirmed
      // end-to-end against an official page. `cf_migration_source_hash` (exact-match) is kept as
      // the primary attempt (simpler, and the more commonly documented shape across Zoho's REST
      // APIs for custom-field equality filtering) — confirm against a live sandbox org for each
      // module actually used by transform.js before relying on this for idempotency lookups.
      const path = `/${modulePath(module)}`;
      const json = await read(path, { cf_migration_source_hash: sourceHash });
      return json[modulePath(module)] ?? [];
    },

    async listRecordsInWindow({ locationId, module, fromDate, toDate } = {}) {
      // UNVERIFIED (docs/ZOHO_BOOKS_API_REFERENCES.md#date-range-filters-and-custom-field-search,
      // 2026-09-15): the Journals/Bills doc pages did not surface an explicit date-range query
      // parameter section in this verification pass. `location_id`/`date_start`/`date_end` are
      // kept as the assumed param names (consistent with the `location_id` field name VERIFIED
      // on the Locations endpoint) — confirm per-module against a live sandbox org before relying
      // on this for real windowed listing.
      const path = `/${modulePath(module)}`;
      const json = await read(path, { location_id: locationId, date_start: fromDate, date_end: toDate });
      return json[modulePath(module)] ?? [];
    },

    async create(module, payload, { idempotencyKey } = {}) {
      // MUST run before building/sending any request — this is the single production-posting
      // choke point (CONTRACTS.md §Z).
      assertPostingAllowed(config);
      const path = `/${modulePath(module)}`;
      const json = await doRequest(config, limiter, {
        method: 'POST',
        path,
        body: payload,
        idempotencyKey,
        isWrite: true,
      });
      return json;
    },

    // Test/ops seam only — not part of the §Z contract surface.
    _limiterStats: () => limiter.stats(),
  };
}
