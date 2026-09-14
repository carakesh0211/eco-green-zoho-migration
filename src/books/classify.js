// Classifies the outcome of a single Zoho Books HTTP attempt into the buckets
// limiter.js#withRetry and worker/executor.js (§Q) act on. Written fresh for this
// adapter (the Tally rateLimiter.js only recognised "rate limited" vs "everything
// else" — see limiter.js header for what was ported from it).
//
// Mapping table (CONTRACTS.md §Z / PROJECT_CONTEXT.md "Queueing, rate limiting, and
// resilience"):
//
//   status                                            -> class          notes
//   -------------------------------------------------------------------------------
//   200-299                                           -> SUCCESS        unless body is unparseable, see below
//   200-299 with an unparseable/undecodable body       -> UNKNOWN        we cannot prove what happened server-side
//   429                                                -> RATE_LIMIT     retry_after_ms parsed from Retry-After
//                                                                        header (seconds -> ms), or null if absent
//   500 / 502 / 503 / 504                              -> RETRYABLE      transient server-side failure
//   401 / 403                                          -> AUTH           invalid/expired/insufficient-scope token
//   other 4xx (400, 404, 409, 422, ...)                -> NON_RETRYABLE  validation/client error, retrying is futile
//   no HTTP status at all (network error before any     -> RETRYABLE      connection refused/reset/DNS failure etc.,
//     response, request never dispatched)                                 before send: safe to retry
//   timedOutAfterSend: true (abort/timeout that fires   -> UNKNOWN        request bytes may already have been
//     once we know the request was actually dispatched)                   accepted server-side; NEVER retried
//     automatically (see live.js "sent" flag doc)
//   any other/unexpected status code                   -> UNKNOWN        conservative default: never guess

const RETRYABLE_HTTP_STATUSES = new Set([500, 502, 503, 504]);

/** Parses a Retry-After header value (seconds, per HTTP spec) into milliseconds, or null. */
export function parseRetryAfterMs(retryAfterHeader) {
  if (retryAfterHeader === undefined || retryAfterHeader === null || retryAfterHeader === '') return null;
  const seconds = Number(retryAfterHeader);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.round(seconds * 1000);
}

/**
 * @param {object} input
 * @param {number} [input.status] - HTTP status code; absent/undefined means no response was ever received.
 * @param {*} [input.error] - the underlying error/exception, if any (used only for the reason string).
 * @param {boolean} [input.timedOutAfterSend] - true when an abort/timeout fired after the request was
 *   dispatched (see live.js's "sent" flag). Takes priority over `status`.
 * @param {string|number|null} [input.retryAfterHeader] - raw Retry-After header value (seconds).
 * @param {boolean} [input.bodyParseError] - true when a 2xx response body could not be parsed.
 * @returns {{ class: 'SUCCESS'|'RATE_LIMIT'|'RETRYABLE'|'AUTH'|'NON_RETRYABLE'|'UNKNOWN', reason?: string, retry_after_ms?: number|null }}
 */
export function classifyResponse({ status, error, timedOutAfterSend = false, retryAfterHeader = null, bodyParseError = false } = {}) {
  if (timedOutAfterSend) {
    return { class: 'UNKNOWN', reason: 'timeout_or_abort_after_request_sent' };
  }

  if (status === undefined || status === null) {
    return { class: 'RETRYABLE', reason: describeError(error) || 'network_error_before_send' };
  }

  if (status >= 200 && status < 300) {
    if (bodyParseError) return { class: 'UNKNOWN', reason: 'unparseable_success_body' };
    return { class: 'SUCCESS' };
  }

  if (status === 429) {
    return { class: 'RATE_LIMIT', reason: 'http_429', retry_after_ms: parseRetryAfterMs(retryAfterHeader) };
  }

  if (status === 401 || status === 403) {
    return { class: 'AUTH', reason: `http_${status}_invalid_or_expired_token` };
  }

  if (RETRYABLE_HTTP_STATUSES.has(status)) {
    return { class: 'RETRYABLE', reason: `http_${status}` };
  }

  if (status >= 400 && status < 500) {
    return { class: 'NON_RETRYABLE', reason: `http_${status}` };
  }

  // Any other/unexpected status (1xx, 3xx leaking through, >=600, ...): never guess.
  return { class: 'UNKNOWN', reason: `unexpected_status_${status}` };
}

function describeError(error) {
  if (!error) return null;
  if (typeof error === 'string') return error;
  return error.code || error.message || null;
}
