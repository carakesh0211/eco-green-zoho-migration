// Organisation-wide pacing + retry for Zoho Books calls.
//
// PORTED (adapted) from tally-zoho-dataMigrator/server/src/services/rateLimiter.js:
//   - `SlidingWindow` class and its `take()` sliding-window-of-timestamps algorithm
//     (per-organisation quota, not fixed-window) -> kept almost verbatim below, extended
//     with an injectable clock/sleep (for deterministic tests) and a `stats()`/`count()` accessor.
//   - `limiterFor(key)` (one limiter per organisation) -> `createLimiter()` is the per-organisation
//     instance itself; the Tally tool's module-level `Map` keyed by clientId is replaced by the
//     caller (books/live.js) holding one limiter per client instance, since this adapter talks to
//     exactly one organisation per process/config rather than many tenants.
//   - `withRateLimitRetry(fn, {attempts, baseMs})` (exponential backoff + quarter jitter, retries
//     only rate-limit errors) -> `withRetry()` below, generalised: it now retries RATE_LIMIT *and*
//     RETRYABLE (5xx/network) outcomes, uses FULL jitter (not quarter) per PROJECT_CONTEXT.md
//     "Queueing, rate limiting, and resilience", honours a server-supplied `retry_after_ms` when
//     present (Zoho documents no Retry-After for /books, but classify.js still forwards one if a
//     future response carries it), and NEVER retries UNKNOWN/AUTH/NON_RETRYABLE — the Tally version
//     had no such classification to consult since classify.js/guard.js did not exist there.
//
// Written fresh for this adapter (no Tally equivalent): `Semaphore` (bounded concurrency — the
// Tally tool only paced call *rate*, not concurrent in-flight calls), and `createLimiter()`'s
// `schedule()`/`stats()` wrapper tying the window + semaphore together per CONTRACTS.md §Z.

const DEFAULT_WINDOW_MS = 60_000;

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Sliding window of call timestamps — ported from Tally's `SlidingWindow` (see header). */
export class SlidingWindow {
  constructor(limit, { clock = Date.now, sleep = defaultSleep, windowMs = DEFAULT_WINDOW_MS } = {}) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.clock = clock;
    this.sleep = sleep;
    this.timestamps = [];
  }

  #evict(now) {
    while (this.timestamps.length && now - this.timestamps[0] >= this.windowMs) this.timestamps.shift();
  }

  /** Resolves once a slot is available, having reserved it. Never rejects. */
  async take() {
    for (;;) {
      const now = this.clock();
      this.#evict(now);
      if (this.timestamps.length < this.limit) {
        this.timestamps.push(now);
        return;
      }
      const waitMs = this.windowMs - (now - this.timestamps[0]) + 1;
      await this.sleep(Math.max(waitMs, 0));
    }
  }

  /** Calls currently counted inside the window (evicts stale entries first). */
  count() {
    this.#evict(this.clock());
    return this.timestamps.length;
  }
}

/** Bounded-concurrency gate. Written fresh — no Tally equivalent (see header). */
export class Semaphore {
  constructor(max) {
    this.max = Math.max(1, max);
    this.active = 0;
    this.queue = [];
  }

  acquire() {
    return new Promise((resolve) => {
      const tryAcquire = () => {
        if (this.active < this.max) {
          this.active += 1;
          resolve(() => this.#release());
        } else {
          this.queue.push(tryAcquire);
        }
      };
      tryAcquire();
    });
  }

  #release() {
    this.active -= 1;
    const next = this.queue.shift();
    if (next) next();
  }
}

/**
 * One limiter instance per organisation: a sliding-window rate gate plus a bounded-concurrency
 * semaphore. `schedule(fn)` waits for both before running `fn`, and `stats()` reports current
 * load for observability/tests.
 */
export function createLimiter({
  ratePerMinute = 100,
  maxConcurrency = 2,
  windowMs = DEFAULT_WINDOW_MS,
  clock = Date.now,
  sleep = defaultSleep,
} = {}) {
  const window = new SlidingWindow(ratePerMinute, { clock, sleep, windowMs });
  const semaphore = new Semaphore(maxConcurrency);
  let inFlight = 0;

  async function schedule(fn) {
    await window.take();
    const release = await semaphore.acquire();
    inFlight += 1;
    try {
      return await fn();
    } finally {
      inFlight -= 1;
      release();
    }
  }

  function stats() {
    return {
      callsInWindow: window.count(),
      limit: ratePerMinute,
      inFlight,
      maxConcurrency,
    };
  }

  return { schedule, stats };
}

const RETRYABLE_CLASSES = new Set(['RATE_LIMIT', 'RETRYABLE']);

function fullJitterBackoff(attempt, baseMs, maxMs, random) {
  const cap = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
  return Math.floor(random() * cap);
}

/**
 * Runs `attemptFn(attemptNumber)` up to `maxAttempts` times.
 *
 * `attemptFn` must resolve (never reject) with `{ classification, value, error }`:
 *   - `classification.class === 'SUCCESS'` -> `value` is returned immediately.
 *   - `classification.class` is `RATE_LIMIT` or `RETRYABLE` and attempts remain -> backs off
 *     (honouring `classification.retry_after_ms` when `honourRetryAfter` is true and present,
 *     otherwise full-jitter exponential backoff) and retries.
 *   - any other class (`UNKNOWN`, `AUTH`, `NON_RETRYABLE`) or attempts exhausted -> throws `error`
 *     (or a synthesised error carrying `.classification` if none was supplied). UNKNOWN/AUTH/
 *     NON_RETRYABLE are NEVER retried, regardless of remaining attempts.
 */
export async function withRetry(attemptFn, {
  maxAttempts = 5,
  baseMs = 500,
  maxMs = 30_000,
  honourRetryAfter = true,
  sleep = defaultSleep,
  random = Math.random,
} = {}) {
  let attempt = 0;
  for (;;) {
    attempt += 1;
    const outcome = await attemptFn(attempt);
    const cls = outcome?.classification?.class;

    if (cls === 'SUCCESS' || cls === undefined) {
      return outcome?.value;
    }

    const canRetry = RETRYABLE_CLASSES.has(cls) && attempt < maxAttempts;
    if (!canRetry) {
      throw outcome.error ?? Object.assign(new Error(`Books request failed: ${cls}`), { classification: outcome.classification });
    }

    const retryAfterMs = honourRetryAfter ? outcome.classification.retry_after_ms : null;
    const delay = retryAfterMs != null ? retryAfterMs : fullJitterBackoff(attempt, baseMs, maxMs, random);
    await sleep(delay);
  }
}
