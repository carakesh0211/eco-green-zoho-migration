// Zoho OAuth refresh-token -> access-token flow.
//
// PORTED (shape only) from tally-zoho-dataMigrator/server/src/services/zoho.js#getAccessToken
// and #exchangeCode: POST `${accountsBase}/oauth/v2/token` with
// `grant_type=refresh_token&client_id=...&client_secret=...&refresh_token=...`, cache the
// resulting access token until shortly before `expires_in` elapses.
//
// DROPPED from the Tally version (per this task's MVP scope):
//   - the encrypted-at-rest token row in the settings/tokens DB tables (`settingsRepo`,
//     `tokensRepo`, `encrypt`/`decrypt`) — this adapter is single-tenant and the refresh token
//     comes from `config.refreshToken` (env `BOOKS_REFRESH_TOKEN`), never persisted by this module;
//     the access token lives ONLY in an in-memory `Map` for the life of the process.
//   - multi-datacenter domain table (`DC_DOMAINS`) and the authorization-code exchange
//     (`buildAuthorizeUrl`/`exchangeCode`) — this MVP only ever refreshes an already-issued
//     refresh token; interactive OAuth consent is out of scope here.
//   - multi-client/tenant scoping (`clientId` parameter threaded through everything) — one
//     configured organisation per process.
//
// Written fresh: single-flight de-duplication (`inflight` map) so concurrent callers during a
// token expiry share one refresh call instead of firing N parallel requests at Zoho, and an
// injectable `fetchImpl`/`clock` for deterministic, network-free tests.
//
// The access/refresh tokens are NEVER logged: errors below carry only Zoho's `error` code, never
// request/response bodies, and nothing here calls `log()`/`console.*` with token material.

const EXPIRY_MARGIN_MS = 60_000; // refresh a bit before Zoho actually expires the token
const DEFAULT_EXPIRES_IN_S = 3600;

const tokenCache = new Map(); // cacheKey -> { accessToken, expiresAt }
const inflightRefresh = new Map(); // cacheKey -> Promise<string>

export class BooksAuthError extends Error {
  constructor(message) {
    super(message);
    this.code = 'AUTH';
    this.classification = { class: 'AUTH', reason: message };
  }
}

function cacheKeyFor(config) {
  return `${config.accountsBase}::${config.clientId}::${config.organizationId}`;
}

/**
 * Returns a valid access token for `config`, refreshing (and caching) as needed. Concurrent
 * callers for the same cache key share a single in-flight refresh (single-flight).
 */
export async function getAccessToken(config, { fetchImpl = fetch, clock = Date.now } = {}) {
  const key = cacheKeyFor(config);
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt - EXPIRY_MARGIN_MS > clock()) {
    return cached.accessToken;
  }

  const existing = inflightRefresh.get(key);
  if (existing) return existing;

  const refreshPromise = (async () => {
    try {
      if (!config.refreshToken || !config.clientId || !config.clientSecret) {
        throw new BooksAuthError('Books OAuth refresh is missing clientId/clientSecret/refreshToken');
      }

      const body = new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: config.clientId,
        client_secret: config.clientSecret,
        refresh_token: config.refreshToken,
      });

      let res;
      try {
        res = await fetchImpl(`${config.accountsBase}/oauth/v2/token`, {
          method: 'POST',
          body,
          signal: AbortSignal.timeout(config.requestTimeoutMs ?? 30_000),
        });
      } catch (networkErr) {
        throw new BooksAuthError(`Books OAuth refresh network error: ${networkErr.code || networkErr.message}`);
      }

      let json;
      try {
        json = await res.json();
      } catch {
        throw new BooksAuthError('Books OAuth refresh: unparseable token response');
      }

      if (!res.ok || json.error) {
        throw new BooksAuthError(`Books OAuth refresh failed: ${json.error || `http_${res.status}`}`);
      }
      if (!json.access_token) {
        throw new BooksAuthError('Books OAuth refresh response had no access_token');
      }

      const expiresIn = Number(json.expires_in);
      const expiresAt = clock() + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : DEFAULT_EXPIRES_IN_S) * 1000;
      tokenCache.set(key, { accessToken: json.access_token, expiresAt });
      return json.access_token;
    } finally {
      inflightRefresh.delete(key);
    }
  })();

  inflightRefresh.set(key, refreshPromise);
  return refreshPromise;
}

/** Test/ops seam: drops every cached token and in-flight refresh. */
export function clearTokenCache() {
  tokenCache.clear();
  inflightRefresh.clear();
}
