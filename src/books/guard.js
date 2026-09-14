// Zoho Books production-posting guard (CONTRACTS.md §Z).
//
// Production posting is disabled by default and must be impossible to enable by
// accident. `isPostingEnabled`/`assertPostingAllowed` are the single choke point
// every write path must go through (see `live.js#create` and `worker/executor.js`).
//
// Truth table — ALL of the following must hold for posting to be allowed:
//   1. config.driver === 'live'                       (mock can never "live post")
//   2. config.postingEnabled === true                  (strict boolean; a raw 'true'/'True'/'1'
//                                                        string is never treated as enabled here —
//                                                        the string->boolean parse happens once,
//                                                        strictly, in loadBooksConfig)
//   3. config.postingAuthorizationRef is a non-empty string (explicit human sign-off reference)
//   4. config.orgAllowlist is a non-empty array
//   5. config.organizationId is a member of config.orgAllowlist
//
// Reads are governed separately by `assertOrgAllowed`: a live driver may only ever read the
// organisation(s) it has been explicitly allow-listed for, so a dev/UAT deployment pointed at
// the wrong (or real) organisation id cannot even perform a read against it.

export class PostingDisabledError extends Error {
  constructor(reason) {
    super(`Zoho Books posting is disabled: ${reason}`);
    this.code = 'POSTING_DISABLED';
    this.reason = reason;
  }
}

function hasNonEmptyAllowlist(config) {
  return Array.isArray(config?.orgAllowlist) && config.orgAllowlist.length > 0;
}

function hasAuthorizationRef(config) {
  return typeof config?.postingAuthorizationRef === 'string' && config.postingAuthorizationRef.trim() !== '';
}

function isOrgAllowlisted(config) {
  return Boolean(config?.organizationId) && hasNonEmptyAllowlist(config) && config.orgAllowlist.includes(config.organizationId);
}

/** Returns true only when every condition in the truth table above holds. Never throws. */
export function isPostingEnabled(config) {
  if (!config) return false;
  if (config.driver !== 'live') return false;
  if (config.postingEnabled !== true) return false;
  if (!hasAuthorizationRef(config)) return false;
  if (!isOrgAllowlisted(config)) return false;
  return true;
}

/**
 * Throws PostingDisabledError naming exactly which condition failed. Use before any write.
 * `opts.store` is optional (existing callers pass none); when given and the store reports
 * `claimSemantics === 'BEST_EFFORT'` (the Catalyst Data Store adapter's documented
 * non-atomic claim()/releaseClaim() — see src/adapters/store/catalyst.js), posting is
 * refused with reason `BEST_EFFORT_CLAIMS`: a queue item could be claimed by two racing
 * workers, and posting a financial record twice is not an acceptable failure mode even
 * once every other posting condition is otherwise satisfied.
 */
export function assertPostingAllowed(config, { store } = {}) {
  if (!config || config.driver !== 'live') {
    throw new PostingDisabledError('driver is not "live"');
  }
  if (config.postingEnabled !== true) {
    throw new PostingDisabledError('POSTING_ENABLED is not strictly boolean true');
  }
  if (!hasAuthorizationRef(config)) {
    throw new PostingDisabledError('postingAuthorizationRef is missing or empty');
  }
  if (!hasNonEmptyAllowlist(config)) {
    throw new PostingDisabledError('orgAllowlist is empty');
  }
  if (!isOrgAllowlisted(config)) {
    throw new PostingDisabledError(`organizationId "${config.organizationId}" is not in orgAllowlist`);
  }
  if (store?.claimSemantics === 'BEST_EFFORT') {
    throw new PostingDisabledError(
      'BEST_EFFORT_CLAIMS: store.claim()/releaseClaim() are not atomic on this adapter (see ' +
        'src/adapters/store/catalyst.js) — two racing workers could both win the same claim and ' +
        'post the same voucher twice, so live posting is refused regardless of every other condition'
    );
  }
}

/**
 * Enumerates every reason posting is currently blocked, as short SCREAMING_SNAKE codes
 * (never throws) — used by GET /api/health so an operator can see the whole picture in
 * one call instead of tripping conditions one at a time via assertPostingAllowed.
 */
export function postingBlockedReasons(config, { store } = {}) {
  const reasons = [];
  if (!config || config.driver !== 'live') reasons.push('DRIVER_NOT_LIVE');
  if (config?.postingEnabled !== true) reasons.push('POSTING_ENABLED_FALSE');
  if (!hasAuthorizationRef(config)) reasons.push('NO_AUTHORIZATION_REF');
  if (!isOrgAllowlisted(config)) reasons.push('ORG_NOT_ALLOWLISTED');
  if (store?.claimSemantics === 'BEST_EFFORT') reasons.push('BEST_EFFORT_CLAIMS');
  return reasons;
}

/**
 * Guards READS against the live driver: even a read must target an allow-listed
 * organisation, so a dev/UAT deployment cannot silently browse the live org.
 * Non-live drivers (mock) are unrestricted — there is no real organisation to leak.
 */
export function assertOrgAllowed(config) {
  if (!config || config.driver !== 'live') return;
  if (!hasNonEmptyAllowlist(config)) {
    throw new PostingDisabledError('orgAllowlist is empty (reads blocked)');
  }
  if (!isOrgAllowlisted(config)) {
    throw new PostingDisabledError(`organizationId "${config.organizationId}" is not in orgAllowlist (reads blocked)`);
  }
}

function parseIntEnv(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Builds the Books config strictly from environment (see .env.example). The only strict
 * boolean parse in the whole guard lives here: POSTING_ENABLED must be exactly the string
 * 'true' (case-sensitive) to become the boolean `true` — 'True', 'TRUE', '1', 'yes', etc. all
 * resolve to `false`.
 *
 * NOTE: .env.example does not currently define an active-organisation variable distinct from
 * BOOKS_ORG_ALLOWLIST. We read it from BOOKS_ORGANIZATION_ID here (documented gap — the owner
 * should add `BOOKS_ORGANIZATION_ID=` to .env.example); until then it defaults to ''.
 */
export function loadBooksConfig(env = process.env) {
  const orgAllowlist = String(env.BOOKS_ORG_ALLOWLIST ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  return {
    driver: env.BOOKS_DRIVER ?? 'mock',
    apiBase: env.BOOKS_API_BASE ?? 'https://www.zohoapis.in/books/v3',
    accountsBase: env.BOOKS_ACCOUNTS_BASE ?? 'https://accounts.zoho.in',
    clientId: env.BOOKS_CLIENT_ID ?? '',
    clientSecret: env.BOOKS_CLIENT_SECRET ?? '',
    refreshToken: env.BOOKS_REFRESH_TOKEN ?? '',
    organizationId: env.BOOKS_ORGANIZATION_ID ?? '',
    orgAllowlist,
    postingEnabled: env.POSTING_ENABLED === 'true',
    postingAuthorizationRef: env.POSTING_AUTHORIZATION_REF ?? '',
    rateLimitPerMinute: parseIntEnv(env.BOOKS_RATE_LIMIT_PER_MINUTE, 100),
    maxConcurrency: parseIntEnv(env.BOOKS_MAX_CONCURRENCY, 2),
    requestTimeoutMs: parseIntEnv(env.BOOKS_REQUEST_TIMEOUT_MS, 30000),
    maxAttempts: parseIntEnv(env.BOOKS_MAX_ATTEMPTS, 5),
  };
}
