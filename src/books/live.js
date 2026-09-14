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

// TODO(verify-against-zoho-docs): module -> Books v3 endpoint segment mapping. Confirmed common
// ones are listed; anything else falls back to `${module}s`, which is very likely wrong for some
// modules (e.g. bills vs bill, creditnotes vs credit_note) — verify each against the current
// https://www.zoho.com/books/api/v3/ reference before wiring real transform.js payloads through this.
const MODULE_PATH = Object.freeze({
  bill: 'bills',
  vendor_payment: 'vendorpayments',
  customer_payment: 'customerpayments',
  expense: 'expenses',
  credit_note: 'creditnotes',
  vendor_credit: 'vendorcredits',
  bank_transfer: 'banktransfers',
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
    async getOrganization() {
      const json = await read(`/organizations/${config.organizationId}`);
      return json.organization ?? json;
    },

    async getLocations() {
      const json = await read('/locations');
      return json.locations ?? [];
    },

    async getTrialBalance({ locationId, fromDate, toDate } = {}) {
      // TODO(verify-against-zoho-docs): assumed endpoint GET /reports/trialbalance with
      // location_id/from_date/to_date query params. Zoho's Reports API parameter names and
      // response shape have changed across API versions/plans — confirm against the current
      // https://www.zoho.com/books/api/v3/trialbalance/ reference before relying on this.
      return read('/reports/trialbalance', { location_id: locationId, from_date: fromDate, to_date: toDate });
    },

    async searchByMigrationTag({ module, sourceHash } = {}) {
      // TODO(verify-against-zoho-docs): assumes the module's list endpoint supports filtering by
      // a custom field via a `cf_migration_source_hash` query parameter. Zoho's custom-field
      // search syntax/param naming varies by module and API version (some require
      // `custom_field_filter` or a JSON-encoded filter) — confirm the exact mechanism for each
      // module actually used by transform.js before relying on this for idempotency lookups.
      const path = `/${modulePath(module)}`;
      const json = await read(path, { cf_migration_source_hash: sourceHash });
      return json[modulePath(module)] ?? [];
    },

    async listRecordsInWindow({ locationId, module, fromDate, toDate } = {}) {
      // TODO(verify-against-zoho-docs): date range / location filter param names assumed
      // (`location_id`, `date_start`, `date_end`); confirm per-module against current docs.
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
