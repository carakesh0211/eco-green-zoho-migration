// Zoho Books REST client for the migration CLIs (opening balances, transactions): one call at a
// time under the per-minute rate, hard stops on a rate block or a spent daily allowance, and
// never a blind re-send of a write whose outcome is unknown.
import { loadBooksConfig, assertOrgAllowed } from './guard.js';
import { getAccessToken } from './oauth.js';
import { createLimiter } from './limiter.js';

export class UnknownOutcome extends Error {}
export class DailyLimit extends Error {}
export class RateBlocked extends Error {}

// Books allows about 100 calls a minute per organisation, shared with every other client of the
// org; staying well under it avoids the hour-long block (code 43) that follows a breach.
export const RATE_PER_MINUTE = 40;
// Calls kept in hand from the org's daily allowance; the run stops cleanly below this.
export const DAILY_RESERVE = 25;
// For optional reads: fall back on an ordinary error, but never on a rate block or the daily limit.
export const orStop = (fallback) => (err) => {
  if (err instanceof RateBlocked || err instanceof DailyLimit) throw err;
  return fallback(err);
};
export const progress = (msg) => process.stderr.write(`[${new Date().toISOString().slice(11, 19)}] ${msg}\n`);

export function booksClient(config) {
  const limiter = createLimiter({ ratePerMinute: Math.min(config.rateLimitPerMinute, RATE_PER_MINUTE), maxConcurrency: 1 });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const usage = { calls: 0, remaining: null, limit: null };
  async function call(method, path, { query = {}, body } = {}) {
    const url = new URL(`${config.apiBase}${path}`);
    for (const [k, v] of Object.entries({ organization_id: config.organizationId, ...query })) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
    const write = method !== 'GET';
    if (usage.remaining !== null && usage.remaining < DAILY_RESERVE) {
      throw new DailyLimit(`only ${usage.remaining} of today's ${usage.limit ?? '?'} Books API calls left`);
    }
    for (let attempt = 1; ; attempt += 1) {
      const token = await getAccessToken(config);
      let res;
      let json = null;
      try {
        res = await limiter.schedule(() => fetch(url, {
          method,
          headers: { Authorization: `Zoho-oauthtoken ${token}`, 'Content-Type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(config.requestTimeoutMs ?? 30_000),
        }));
        const t = await res.text();
        json = t ? JSON.parse(t) : {};
      } catch (err) {
        // A write that may have reached Books is never blindly re-sent: the next run looks it up.
        if (write) throw new UnknownOutcome(`${method} ${path}: ${err.name === 'TimeoutError' ? 'timeout' : err.code || err.message}`);
        if (attempt >= 5) throw err;
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      usage.calls += 1;
      const remaining = Number(res.headers.get('x-rate-limit-remaining'));
      if (Number.isFinite(remaining) && res.headers.get('x-rate-limit-remaining') !== null) {
        usage.remaining = remaining;
        usage.limit = Number(res.headers.get('x-rate-limit-limit')) || usage.limit;
      }
      if (res.status === 429) {
        const retryAfter = Number(res.headers.get('retry-after') ?? 0);
        if (/per day|daily/i.test(json?.message ?? '')) throw new DailyLimit(json.message);
        // A long Retry-After (or Books code 43) is a block, not a pause: stop and say so.
        if (json?.code === 43 || retryAfter > 60) {
          throw new RateBlocked(`Books has blocked this organisation for ${retryAfter ? `${Math.round(retryAfter / 60)} min` : 'a while'} (code ${json?.code ?? '?'}: ${json?.message ?? 'too many requests'})`);
        }
        if (attempt >= 4) throw new RateBlocked(`${method} ${path}: still rate-limited after ${attempt} tries`);
        progress(`rate-limited; waiting ${Math.max(10, retryAfter)} s`);
        await sleep(Math.max(10, retryAfter) * 1000);
        continue;
      }
      if (res.status >= 500) {
        if (write) throw new UnknownOutcome(`${method} ${path}: http ${res.status}`);
        if (attempt >= 5) throw new Error(`${method} ${path}: http ${res.status}`);
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      if (res.status >= 400 || (json && json.code !== undefined && json.code !== 0)) {
        const e = new Error(`${method} ${path}: http ${res.status} code ${json?.code}: ${json?.message ?? ''}`);
        e.books = json;
        throw e;
      }
      return json;
    }
  }
  // Pages are only stable when the list is sorted on a unique column; records are de-duplicated
  // by `idKey` either way.
  async function listAll(path, listKey, query = {}, idKey = null) {
    const out = new Map();
    for (let page = 1; ; page += 1) {
      const j = await call('GET', path, { query: { ...query, page, per_page: 200 } });
      for (const r of j[listKey] ?? []) out.set(idKey ? String(r[idKey]) : `${out.size}`, r);
      if (!j.page_context?.has_more_page) return [...out.values()];
    }
  }
  return { call, listAll, usage };
}

export function liveConfig() {
  const config = loadBooksConfig(process.env);
  if (config.driver !== 'live') throw new Error('BOOKS_DRIVER must be "live" to reach Zoho Books');
  assertOrgAllowed(config);
  return config;
}
