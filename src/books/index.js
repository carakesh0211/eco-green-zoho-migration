// Zoho Books adapter entry point (CONTRACTS.md §Z).
//
// This module owns no ported logic itself; see guard.js/classify.js/limiter.js/oauth.js/live.js
// header comments for what was ported from tally-zoho-dataMigrator vs written fresh.

import { createLiveClient } from './live.js';
import { createMockClient } from './mock.js';

export {
  isPostingEnabled,
  assertPostingAllowed,
  assertOrgAllowed,
  loadBooksConfig,
  PostingDisabledError,
} from './guard.js';
export { classifyResponse, parseRetryAfterMs } from './classify.js';
export { createLimiter, withRetry, Semaphore, SlidingWindow } from './limiter.js';
export { getAccessToken, clearTokenCache, BooksAuthError } from './oauth.js';
export { createLiveClient } from './live.js';
export { createMockClient } from './mock.js';

/**
 * @param {object} opts
 * @param {'mock'|'live'} opts.driver
 * @param {object} opts.config - see guard.js#loadBooksConfig for shape.
 * @param {object} [opts.store] - accepted for future wiring (e.g. persisting books_snapshots
 *   from src/core/recon_c.js / balance_bridge.js, §Y — out of scope for this module); unused here.
 * @param {object} [opts.audit] - accepted for future wiring (audit emission on posting decisions
 *   is currently the caller's responsibility, e.g. src/worker/executor.js §Q); unused here.
 */
export function createBooksClient({ driver, config = {}, store, audit } = {}) {
  const effectiveDriver = driver ?? config.driver ?? 'mock';
  const effectiveConfig = { ...config, driver: effectiveDriver };

  let client;
  if (effectiveDriver === 'live') {
    client = createLiveClient(effectiveConfig);
  } else if (effectiveDriver === 'mock') {
    client = createMockClient(effectiveConfig);
  } else {
    throw new Error(`Unknown Books driver: "${effectiveDriver}" (expected "mock" or "live")`);
  }

  return { ...client, driver: effectiveDriver, config: effectiveConfig, store, audit };
}
