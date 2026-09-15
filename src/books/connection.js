// Zoho Books connection module — Administration > Connections > Zoho Books.
//
// Owns the OAuth "connect this deployment to a real Zoho Books organisation" lifecycle
// (begin -> callback -> connected), independent of and strictly weaker than the production
// posting guard in guard.js: connecting Books here NEVER touches POSTING_ENABLED and never
// enables `isPostingEnabled(config)` — see `controls().productionPostingEnabled`, which reports
// that guard's verdict verbatim and must stay `false` regardless of anything this module does.
//
// Hard safety rules enforced here (see CONTRACTS.md §Z, SECURITY.md, and the task brief this
// module was built against):
//   1. No live Zoho Books network call happens from this module unless the connection row's
//      status is CONNECTED *and* `config.readAuthorized === true` (i.e. env
//      BOOKS_READ_AUTHORIZED === 'true', parsed once by the caller). Both conditions are checked
//      with `assertReadGate()` immediately, before any `fetchImpl` call, and return a structured
//      refusal (a thrown error carrying `.code`) rather than ever reaching the network.
//   2. The third leg of that gate — "the caller is an admin" — is enforced one layer up, by
//      `src/server/routes/admin_books.js` requiring `auth.requireRole('admin')` on every gated
//      route before it ever calls into this module (this module's methods accept only an actor
//      *id* string, the same convention `ctxFor()` uses elsewhere in this codebase, not a role).
//      The combination of (1) here and the route-level admin check is what makes the full
//      three-part rule hold end to end.
//   3. Refresh tokens are AES-256-GCM encrypted at rest under `BOOKS_SECRET_KEY`
//      (`encryptSecret`/`decryptSecret` below) and are NEVER placed on any object returned to a
//      caller, written to `audit.emit()`, or interpolated into any thrown Error's message — every
//      error message below carries only a short redacted reason/code, never response bodies or
//      token material. (`src/core/audit.js` also independently redacts any before/after key whose
//      name matches /token|secret|password|authorization|refresh|client_secret/i, which is a
//      second, coarser safety net on top of this module's own discipline.)
//   4. `oauth_state_sha256` is single-use: the in-memory `stateExpiry` map (keyed by the sha256 of
//      the state, per-instance — this module is a factory, so each `createBooksConnection()` call
//      gets its own map) is consulted AND the entry deleted before the token exchange begins, so a
//      replayed/reused `state` value is rejected even if the first callback is still in flight.
import { randomBytes as nodeRandomBytes, createHash, createCipheriv, createDecipheriv } from 'node:crypto';
import { nowIso, newCorrelationId } from '../core/ids.js';
import { loadBooksConfig, isPostingEnabled } from './guard.js';
import { getAccessToken, clearTokenCache as clearOauthTokenCache } from './oauth.js';

export const CONNECTION_ID = 'default';

// ---------------------------------------------------------------------------- errors

export class BooksConnectionError extends Error {
  constructor(code, message) {
    super(message ?? code);
    this.code = code;
  }
}

// ---------------------------------------------------------------------------- region tables
// VERIFIED(docs/ZOHO_BOOKS_API_REFERENCES.md#oauth-20, 2026-09-15) and
// VERIFIED(docs/ZOHO_BOOKS_API_REFERENCES.md#books-rest-api--base-auth-envelope, 2026-09-15).
export const REGION_ACCOUNTS_BASE = Object.freeze({
  in: 'https://accounts.zoho.in',
  com: 'https://accounts.zoho.com',
  eu: 'https://accounts.zoho.eu',
  'com.au': 'https://accounts.zoho.com.au',
  jp: 'https://accounts.zoho.jp',
  'com.cn': 'https://accounts.zoho.com.cn',
  sa: 'https://accounts.zoho.sa',
  ca: 'https://accounts.zoho.ca',
});

export const REGION_API_BASE = Object.freeze({
  in: 'https://www.zohoapis.in/books/v3',
  com: 'https://www.zohoapis.com/books/v3',
  eu: 'https://www.zohoapis.eu/books/v3',
  'com.au': 'https://www.zohoapis.com.au/books/v3',
  jp: 'https://www.zohoapis.jp/books/v3',
  'com.cn': 'https://www.zohoapis.com.cn/books/v3',
  sa: 'https://www.zohoapis.sa/books/v3',
  ca: 'https://www.zohoapis.ca/books/v3',
});

// Read-only-first scope list for the Administration connect flow (this MVP never requests
// ZohoBooks.fullaccess.all — see docs/ZOHO_BOOKS_API_REFERENCES.md#scopes). `settings.READ` is
// what authorises GET /organizations; the others cover the modules live.js actually reads today.
export const DEFAULT_OAUTH_SCOPES = Object.freeze([
  'ZohoBooks.settings.READ',
  'ZohoBooks.contacts.READ',
  'ZohoBooks.bills.READ',
  'ZohoBooks.invoices.READ',
  'ZohoBooks.accountants.READ',
]);

const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes, single-use
const SYNTHETIC_MOCK_LOCATIONS = Object.freeze([
  { location_id: 'SYN-LOC-001', location_name: '[SYNTHETIC] Location 001', status: 'ACTIVE' },
  { location_id: 'SYN-LOC-002', location_name: '[SYNTHETIC] Location 002', status: 'ACTIVE' },
]);

/**
 * Builds the connection config this module needs, from `loadBooksConfig(env)` plus the extra
 * env vars introduced by this task. Callers (src/server/index.js, tests) may also build this
 * object by hand — nothing here requires calling this specific helper.
 */
export function loadConnectionConfig(env = process.env) {
  const base = loadBooksConfig(env);
  return {
    ...base,
    region: env.BOOKS_REGION || 'in',
    redirectUri: env.BOOKS_REDIRECT_URI || '',
    secretKey: env.BOOKS_SECRET_KEY || '',
    readAuthorized: env.BOOKS_READ_AUTHORIZED === 'true',
  };
}

// ---------------------------------------------------------------------------- crypto helpers

/** AES-256-GCM encrypt, versioned `v1:<ivBase64>:<ciphertext+tagBase64>`. Never throws for a
 *  wrong-length key — callers must validate the key (see `assertSecretKey`) before calling this. */
export function encryptSecret(plaintext, secretKeyBase64) {
  const key = Buffer.from(secretKeyBase64, 'base64');
  if (key.length !== 32) {
    throw new BooksConnectionError('BOOKS_SECRET_KEY_MISSING', 'BOOKS_SECRET_KEY must decode to exactly 32 bytes');
  }
  const iv = nodeRandomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${Buffer.concat([ciphertext, tag]).toString('base64')}`;
}

/** Inverse of encryptSecret. Throws BooksConnectionError('DECRYPT_FAILED', ...) — never leaks
 *  ciphertext/key material in the thrown message. */
export function decryptSecret(versioned, secretKeyBase64) {
  try {
    const key = Buffer.from(secretKeyBase64, 'base64');
    if (key.length !== 32) throw new Error('bad key length');
    const [version, ivB64, payloadB64] = String(versioned).split(':');
    if (version !== 'v1' || !ivB64 || !payloadB64) throw new Error('bad envelope');
    const iv = Buffer.from(ivB64, 'base64');
    const payload = Buffer.from(payloadB64, 'base64');
    const tag = payload.subarray(payload.length - 16);
    const ciphertext = payload.subarray(0, payload.length - 16);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    throw new BooksConnectionError('DECRYPT_FAILED', 'Unable to decrypt stored Books credential');
  }
}

function hasValidSecretKey(config) {
  try {
    return Buffer.from(config.secretKey ?? '', 'base64').length === 32;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------- factory

/**
 * @param {object} opts
 * @param {object} opts.store - see src/adapters/store/{sqlite,memory}.js contract.
 * @param {object} opts.audit - createAudit(store) from src/core/audit.js.
 * @param {object} opts.config - see loadConnectionConfig() above.
 * @param {typeof fetch} [opts.fetchImpl] - injected for tests; NEVER defaults to a real network
 *   call inside a test process — production wiring (src/server/index.js) passes real `fetch`.
 * @param {() => number} [opts.clock]
 * @param {(n: number) => Buffer} [opts.randomBytes]
 */
export function createBooksConnection({ store, audit, config, fetchImpl = fetch, clock = Date.now, randomBytes = nodeRandomBytes }) {
  if (!store) throw new TypeError('createBooksConnection requires a store');
  if (!audit) throw new TypeError('createBooksConnection requires an audit');
  if (!config) throw new TypeError('createBooksConnection requires a config');

  /** sha256(state) -> expiresAtMs. Single-use: deleted on first consumption. Per-instance, never
   *  persisted — a restart invalidates any in-flight (not yet completed) connect attempt, which
   *  is the correct, safe failure mode for a 10-minute window. */
  const stateExpiry = new Map();

  function accountsBaseFor(region) {
    return REGION_ACCOUNTS_BASE[region] ?? REGION_ACCOUNTS_BASE.in;
  }
  function apiBaseFor(region) {
    return REGION_API_BASE[region] ?? REGION_API_BASE.in;
  }

  async function ensureRow() {
    const existing = await store.get('books_connections', CONNECTION_ID);
    if (existing) return existing;
    const now = nowIso();
    try {
      return await store.insert('books_connections', {
        id: CONNECTION_ID,
        status: 'NOT_CONNECTED',
        org_id: null,
        org_name: null,
        region: null,
        api_domain: null,
        connected_by: null,
        connected_at: null,
        last_success_at: null,
        last_error_redacted: null,
        token_refresh_status: 'NONE',
        token_expires_at: null,
        secret_ciphertext: null,
        api_limit_json: null,
        locations_synced_at: null,
        oauth_state_sha256: null,
        version: 1,
        created_at: now,
        updated_at: now,
      });
    } catch (err) {
      // Concurrent callers (e.g. GET /connection running getStatus() and controls() in
      // parallel) can race here: both see no row, both try to insert. Whichever loses just
      // re-reads the winner's row instead of surfacing a spurious UNIQUE_VIOLATION.
      if (err?.code === 'UNIQUE_VIOLATION') {
        const row = await store.get('books_connections', CONNECTION_ID);
        if (row) return row;
      }
      throw err;
    }
  }

  async function patchRow(patch) {
    return store.update('books_connections', CONNECTION_ID, { ...patch, updated_at: nowIso() });
  }

  async function emitAudit({ action, before, after, reason, actor, correlationId, entityId = CONNECTION_ID }) {
    await audit.emit({
      actor: actor ?? 'system',
      actorRole: null,
      action,
      entityType: 'books_connections',
      entityId,
      before,
      after,
      reason: reason ?? null,
      correlationId: correlationId ?? newCorrelationId(),
    });
  }

  function redactedErrorReason(err) {
    // NEVER surface response bodies/tokens: only a short Zoho `error` code (or our own
    // classification reason) ever lands here.
    if (err?.zohoErrorCode) return String(err.zohoErrorCode);
    if (err?.code) return String(err.code);
    return 'ZOHO_ERROR';
  }

  /** Structured refusal: throws before any fetchImpl call. */
  function assertReadGate(row) {
    if (row.status !== 'CONNECTED') {
      throw new BooksConnectionError('NOT_CONNECTED', 'Books connection is not CONNECTED');
    }
    if (config.readAuthorized !== true) {
      throw new BooksConnectionError('READ_NOT_AUTHORIZED', 'BOOKS_READ_AUTHORIZED is not enabled');
    }
  }

  // ---- redacted view --------------------------------------------------------------

  async function getStatus() {
    const row = await ensureRow();
    let apiLimit = null;
    if (row.api_limit_json) {
      try {
        apiLimit = JSON.parse(row.api_limit_json);
      } catch {
        apiLimit = null;
      }
    }
    return {
      status: row.status,
      org: row.org_id ? { id: row.org_id, name: row.org_name, region: row.region, apiDomain: row.api_domain } : null,
      connectedBy: row.connected_by,
      connectedAt: row.connected_at,
      lastSuccessAt: row.last_success_at,
      lastErrorRedacted: row.last_error_redacted,
      tokenRefreshStatus: row.token_refresh_status,
      tokenExpiresAt: row.token_expires_at,
      apiLimit,
      locationsSyncedAt: row.locations_synced_at,
      readAuthorized: config.readAuthorized === true,
      driver: config.driver,
      postingEnabled: false,
      secretsConfigured: {
        clientId: Boolean(config.clientId),
        clientSecret: Boolean(config.clientSecret),
        secretKey: hasValidSecretKey(config),
      },
    };
  }

  // ---- connect lifecycle ------------------------------------------------------------

  async function beginConnect({ actor, region, redirectUri, correlationId } = {}) {
    if (!config.clientId) {
      throw new BooksConnectionError('BOOKS_NOT_CONFIGURED', 'BOOKS_CLIENT_ID is not configured');
    }
    const before = await ensureRow();
    const chosenRegion = region || config.region || 'in';
    const uri = redirectUri || config.redirectUri || '';

    const stateBytes = randomBytes(32);
    const state = Buffer.from(stateBytes).toString('hex');
    const stateHash = createHash('sha256').update(state, 'utf8').digest('hex');
    stateExpiry.set(stateHash, clock() + STATE_TTL_MS);

    const authorizeUrl = new URL(`${accountsBaseFor(chosenRegion)}/oauth/v2/auth`);
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('client_id', config.clientId);
    authorizeUrl.searchParams.set('scope', DEFAULT_OAUTH_SCOPES.join(','));
    authorizeUrl.searchParams.set('redirect_uri', uri);
    authorizeUrl.searchParams.set('access_type', 'offline');
    authorizeUrl.searchParams.set('prompt', 'consent');
    authorizeUrl.searchParams.set('state', state);

    const after = await patchRow({ status: 'PENDING_AUTH', region: chosenRegion, oauth_state_sha256: stateHash });
    await emitAudit({ action: 'BOOKS.CONNECT_BEGIN', before, after, actor, correlationId });

    return { authorizeUrl: authorizeUrl.toString() };
  }

  function consumeState(state) {
    const hash = createHash('sha256').update(String(state ?? ''), 'utf8').digest('hex');
    const expiresAt = stateExpiry.get(hash);
    stateExpiry.delete(hash); // single-use: gone whether or not it was valid/expired
    if (!expiresAt || expiresAt < clock()) return null;
    return hash;
  }

  async function completeCallback({ code, state, accountsServer, location, actor, correlationId } = {}) {
    const before = await ensureRow();
    const stateHash = consumeState(state);
    if (!stateHash || stateHash !== before.oauth_state_sha256) {
      await patchRow({ status: 'ERROR', last_error_redacted: 'INVALID_STATE', oauth_state_sha256: null });
      throw new BooksConnectionError('INVALID_STATE', 'OAuth state is missing, expired, reused, or does not match');
    }

    if (!hasValidSecretKey(config)) {
      throw new BooksConnectionError('BOOKS_SECRET_KEY_MISSING', 'BOOKS_SECRET_KEY is not configured (32 bytes, base64)');
    }

    const region = location || before.region || config.region || 'in';
    const accountsBase = accountsServer || accountsBaseFor(region);
    const apiBase = apiBaseFor(region);

    let tokenJson;
    try {
      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: config.clientId,
        client_secret: config.clientSecret,
        redirect_uri: config.redirectUri || '',
        code: String(code ?? ''),
      });
      const res = await fetchImpl(`${accountsBase}/oauth/v2/token`, { method: 'POST', body });
      tokenJson = await res.json();
      if (!res.ok || tokenJson.error || !tokenJson.refresh_token) {
        const err = new Error('token exchange failed');
        err.zohoErrorCode = tokenJson.error || `http_${res.status}`;
        throw err;
      }
    } catch (err) {
      const reason = redactedErrorReason(err);
      await patchRow({
        status: 'ERROR',
        token_refresh_status: 'FAILED',
        last_error_redacted: reason,
        oauth_state_sha256: null,
      });
      await emitAudit({ action: 'BOOKS.CONNECT_FAILED', before, reason, actor, correlationId });
      throw new BooksConnectionError('OAUTH_EXCHANGE_FAILED', `Books OAuth exchange failed: ${reason}`);
    }

    const secretCiphertext = encryptSecret(tokenJson.refresh_token, config.secretKey);
    const expiresIn = Number(tokenJson.expires_in);
    const tokenExpiresAt = new Date(clock() + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600) * 1000).toISOString();
    const resolvedApiDomain = tokenJson.api_domain || apiBase;

    let patch = {
      status: 'CONNECTED',
      region,
      api_domain: resolvedApiDomain,
      connected_by: actor ?? null,
      connected_at: nowIso(),
      token_refresh_status: 'OK',
      token_expires_at: tokenExpiresAt,
      secret_ciphertext: secretCiphertext,
      oauth_state_sha256: null,
      last_error_redacted: null,
    };

    if (config.readAuthorized === true) {
      try {
        const orgRes = await fetchImpl(`${resolvedApiDomain}/organizations/${config.organizationId}`, {
          method: 'GET',
          headers: { Authorization: `Zoho-oauthtoken ${tokenJson.access_token}` },
        });
        const orgJson = await orgRes.json();
        if (!orgRes.ok || orgJson.code) {
          throw Object.assign(new Error('organization fetch failed'), { zohoErrorCode: orgJson.message || `http_${orgRes.status}` });
        }
        const org = orgJson.organization ?? orgJson;
        patch = { ...patch, org_id: org.organization_id, org_name: org.name, last_success_at: nowIso() };
      } catch (err) {
        patch = { ...patch, last_error_redacted: redactedErrorReason(err) };
      }
    } else {
      patch = { ...patch, last_error_redacted: 'READ_NOT_AUTHORIZED' };
    }

    const after = await patchRow(patch);
    await emitAudit({ action: 'BOOKS.CONNECTED', before, after, actor, correlationId });
    return getStatus();
  }

  // ---- gated read-only actions ------------------------------------------------------

  async function testConnection({ actor, correlationId } = {}) {
    const row = await ensureRow();
    assertReadGate(row);

    const liveConfig = {
      accountsBase: accountsBaseFor(row.region),
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      refreshToken: decryptSecret(row.secret_ciphertext, config.secretKey),
      organizationId: config.organizationId,
      requestTimeoutMs: config.requestTimeoutMs,
    };

    try {
      clearOauthTokenCache(); // this admin-triggered "test" call must always hit Zoho, never a stale cache entry
      const accessToken = await getAccessToken(liveConfig, { fetchImpl, clock });
      const res = await fetchImpl(`${row.api_domain}/organizations/${config.organizationId}`, {
        method: 'GET',
        headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
      });
      const json = await res.json();
      if (!res.ok || json.code) {
        throw Object.assign(new Error('test failed'), { zohoErrorCode: json.message || `http_${res.status}` });
      }
      const apiLimit = {
        limit: res.headers?.get?.('X-Rate-Limit-Limit') ?? null,
        remaining: res.headers?.get?.('X-Rate-Limit-Remaining') ?? null,
        reset: res.headers?.get?.('X-Rate-Limit-Reset') ?? null,
      };
      const after = await patchRow({
        last_success_at: nowIso(),
        token_refresh_status: 'OK',
        last_error_redacted: null,
        api_limit_json: JSON.stringify(apiLimit),
      });
      await emitAudit({ action: 'BOOKS.TEST', before: row, after, actor, correlationId });
      return { ok: true };
    } catch (err) {
      const reason = redactedErrorReason(err);
      const after = await patchRow({ token_refresh_status: 'FAILED', last_error_redacted: reason });
      await emitAudit({ action: 'BOOKS.TEST', before: row, after, reason, actor, correlationId });
      throw new BooksConnectionError('BOOKS_TEST_FAILED', `Books connection test failed: ${reason}`);
    }
  }

  async function upsertLocation({ location_id, location_name, status, is_synthetic }) {
    const existing = await store.findOne('books_locations', { location_id });
    const now = nowIso();
    if (existing) {
      return store.update('books_locations', existing.id, {
        location_name,
        status,
        is_synthetic: is_synthetic ? 1 : 0,
        synced_at: now,
      });
    }
    return store.insert('books_locations', {
      location_id,
      location_name,
      status,
      is_synthetic: is_synthetic ? 1 : 0,
      branch_code: null,
      synced_at: now,
      created_at: now,
      updated_at: now,
    });
  }

  async function syncLocations({ actor, driver, correlationId } = {}) {
    const row = await ensureRow();
    const effectiveDriver = driver ?? config.driver ?? 'mock';

    let locations;
    if (effectiveDriver === 'mock') {
      // mock.js already exposes its own getLocations() for the mock Books client's internal GL
      // location list ('loc_head_office', non-synthetic — used by create()/getTrialBalance()
      // there). That is a different concern from this Admin UI's location-mapping demo, so this
      // module defines its own small, clearly-labelled synthetic seed list instead of repurposing
      // or extending a module owned by another workstream.
      locations = SYNTHETIC_MOCK_LOCATIONS.map((l) => ({ ...l, is_synthetic: true }));
    } else {
      assertReadGate(row);
      const liveConfig = {
        accountsBase: accountsBaseFor(row.region),
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        refreshToken: decryptSecret(row.secret_ciphertext, config.secretKey),
        organizationId: config.organizationId,
        requestTimeoutMs: config.requestTimeoutMs,
      };
      const accessToken = await getAccessToken(liveConfig, { fetchImpl, clock });
      const res = await fetchImpl(`${row.api_domain}/locations?organization_id=${config.organizationId}`, {
        method: 'GET',
        headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
      });
      const json = await res.json();
      if (!res.ok || json.code) {
        throw Object.assign(new BooksConnectionError('BOOKS_SYNC_FAILED', 'Books location sync failed'), {
          zohoErrorCode: json.message || `http_${res.status}`,
        });
      }
      locations = (json.locations ?? []).map((l) => ({
        location_id: l.location_id,
        location_name: l.location_name,
        status: (l.status ?? 'active').toUpperCase(),
        is_synthetic: false,
      }));
    }

    for (const loc of locations) {
      await upsertLocation(loc);
    }
    const after = await patchRow({ locations_synced_at: nowIso() });
    await emitAudit({
      action: 'BOOKS.LOCATIONS_SYNCED',
      before: row,
      after: { ...after, syncedCount: locations.length, driver: effectiveDriver },
      actor,
      correlationId,
    });
    return { count: locations.length, driver: effectiveDriver };
  }

  async function listLocations() {
    return store.find('books_locations', {}, { orderBy: 'location_id' });
  }

  async function setLocationMapping({ actor, mappings, correlationId } = {}) {
    if (!Array.isArray(mappings) || mappings.length === 0) {
      throw new BooksConnectionError('BAD_REQUEST', 'mappings must be a non-empty array');
    }

    // Validate every mapping before applying any of them.
    const resolved = [];
    for (const m of mappings) {
      const locationRow = await store.findOne('books_locations', { location_id: m.location_id });
      if (!locationRow) {
        throw new BooksConnectionError('LOCATION_NOT_FOUND', `location_id "${m.location_id}" is not known (run sync-locations first)`);
      }
      const branchRow = await store.get('branches', m.branch_code);
      const branchSummaryRow = await store.get('branch_summaries', m.branch_code);
      if (!branchRow && !branchSummaryRow) {
        throw new BooksConnectionError('BRANCH_NOT_FOUND', `branch_code "${m.branch_code}" does not exist`);
      }
      if (locationRow.branch_code && locationRow.branch_code !== m.branch_code) {
        throw new BooksConnectionError(
          'LOCATION_ALREADY_MAPPED',
          `location_id "${m.location_id}" is already mapped to branch "${locationRow.branch_code}"`,
        );
      }
      resolved.push({ m, locationRow, branchRow, branchSummaryRow });
    }

    const results = [];
    for (const { m, locationRow, branchRow, branchSummaryRow } of resolved) {
      const updatedLocation = await store.update('books_locations', locationRow.id, { branch_code: m.branch_code });
      if (branchRow) {
        await store.update('branches', branchRow.branch_code, { zoho_location_id: m.location_id, updated_at: nowIso() });
      }
      if (branchSummaryRow) {
        await store.update('branch_summaries', branchSummaryRow.branch_code, {
          zoho_location_id: m.location_id,
          zoho_location_name: locationRow.location_name,
        });
      }
      await emitAudit({
        action: 'BOOKS.LOCATION_MAPPED',
        before: locationRow,
        after: updatedLocation,
        actor,
        correlationId,
        entityId: m.location_id,
      });
      results.push(updatedLocation);
    }
    return results;
  }

  async function disconnect({ actor, reason, correlationId } = {}) {
    const before = await ensureRow();

    if (before.status === 'CONNECTED' && config.readAuthorized === true && before.secret_ciphertext) {
      try {
        const refreshToken = decryptSecret(before.secret_ciphertext, config.secretKey);
        await fetchImpl(`${accountsBaseFor(before.region)}/oauth/v2/token/revoke`, {
          method: 'POST',
          body: new URLSearchParams({ token: refreshToken }),
        });
      } catch {
        // Best-effort only: revocation failing must never block a local disconnect.
      }
    }

    const after = await patchRow({
      status: 'DISCONNECTED',
      secret_ciphertext: null,
      token_refresh_status: 'NONE',
      token_expires_at: null,
      oauth_state_sha256: null,
    });
    await emitAudit({ action: 'BOOKS.DISCONNECTED', before, after, reason, actor, correlationId });
    return getStatus();
  }

  async function refreshStatus({ actor, correlationId } = {}) {
    const row = await ensureRow();
    if (row.status !== 'CONNECTED' || config.readAuthorized !== true || !row.secret_ciphertext) {
      // Gated off: report what we already know, never touch the network.
      return { tokenRefreshStatus: row.token_refresh_status, tokenExpiresAt: row.token_expires_at };
    }
    try {
      const liveConfig = {
        accountsBase: accountsBaseFor(row.region),
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        refreshToken: decryptSecret(row.secret_ciphertext, config.secretKey),
        organizationId: config.organizationId,
        requestTimeoutMs: config.requestTimeoutMs,
      };
      clearOauthTokenCache();
      await getAccessToken(liveConfig, { fetchImpl, clock });
      const after = await patchRow({ token_refresh_status: 'OK' });
      await emitAudit({ action: 'BOOKS.TOKEN_REFRESHED', before: row, after, actor, correlationId });
      return { tokenRefreshStatus: after.token_refresh_status, tokenExpiresAt: after.token_expires_at };
    } catch (err) {
      const reason = redactedErrorReason(err);
      const after = await patchRow({ token_refresh_status: 'FAILED', last_error_redacted: reason });
      await emitAudit({ action: 'BOOKS.TOKEN_REFRESH_FAILED', before: row, after, reason, actor, correlationId });
      return { tokenRefreshStatus: after.token_refresh_status, tokenExpiresAt: after.token_expires_at };
    }
  }

  // ---- controls (Admin dashboard summary) --------------------------------------------

  async function controls() {
    const row = await ensureRow();
    const nonSynthetic = await store.count('books_locations', { is_synthetic: 0 });
    const synthetic = await store.count('books_locations', { is_synthetic: 1 });

    const booksConnected = row.status === 'CONNECTED';
    const organizationVerified = Boolean(row.org_id) && Boolean(config.organizationId) && row.org_id === config.organizationId;
    const locationsSynchronized = nonSynthetic > 0 || synthetic > 0;
    const readOnlyAccessApproved = config.readAuthorized === true;
    const productionPostingOk = isPostingEnabled(config);

    return {
      booksConnected: { ok: booksConnected, detail: booksConnected ? 'Books connection is CONNECTED' : `status is ${row.status}` },
      organizationVerified: {
        ok: organizationVerified,
        detail: organizationVerified
          ? `organization ${row.org_id} matches BOOKS_ORGANIZATION_ID`
          : 'connected organization id does not match BOOKS_ORGANIZATION_ID (or nothing is connected yet)',
      },
      locationsSynchronized: {
        ok: locationsSynchronized,
        detail:
          nonSynthetic > 0
            ? `${nonSynthetic} live location(s) synchronised`
            : synthetic > 0
              ? `${synthetic} synthetic location(s) synchronised (Development only)`
              : 'no locations synchronised yet',
        synthetic: nonSynthetic === 0 && synthetic > 0,
      },
      readOnlyAccessApproved: {
        ok: readOnlyAccessApproved,
        detail: readOnlyAccessApproved ? 'BOOKS_READ_AUTHORIZED=true' : 'BOOKS_READ_AUTHORIZED is not enabled',
      },
      batchFinanciallyApproved: null,
      productionPostingEnabled: {
        ok: productionPostingOk,
        detail: productionPostingOk
          ? 'PRODUCTION POSTING IS ENABLED'
          : 'production posting is disabled (POSTING_ENABLED/authorization ref/org allowlist gate)',
      },
    };
  }

  return {
    getStatus,
    beginConnect,
    completeCallback,
    testConnection,
    syncLocations,
    listLocations,
    setLocationMapping,
    disconnect,
    refreshStatus,
    controls,
  };
}
