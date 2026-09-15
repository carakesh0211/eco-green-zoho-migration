// Archive readiness for /api/health (CONTRACTS.md §R). Turns "ARCHIVE_ADAPTER=stratus is
// configured" into "we actually touched the bucket" by calling the configured archive's
// `verify()` (src/adapters/archive/{stratus,local,disabled}.js) and caching the result for
// `ttlMs` so a health check does not hit Stratus on every poll.
//
// archiveStatus values:
//   ENABLED_VERIFIED    - archiveAdapter is 'stratus' and the last verify() succeeded.
//   ENABLED_UNVERIFIED  - archiveAdapter is 'stratus' but verify() failed, has not
//                         completed yet, or the archive has no verify() at all.
//   LOCAL               - archiveAdapter is 'local' (or anything else non-stratus,
//                         non-disabled — fails open to LOCAL rather than throwing on an
//                         adapter name this module doesn't recognise).
//   DISABLED_DEVELOPMENT - archiveAdapter is 'disabled'.
//
// Never includes a bucket or project id — only the bucket NAME (CONTRACTS.md "Unauthenticated,
// no IDs" note also referenced in src/server/app.js's /api/health handler). Never throws.
export function createArchiveHealth({ archive, archiveAdapter, ttlMs = 300000, clock = () => Date.now() } = {}) {
  let cached = null; // { result, expiresAt }
  let inFlight = null; // Promise<verifyResult> shared by concurrent callers (single-flight)

  function isoNow() {
    return new Date(clock()).toISOString();
  }

  async function runVerify() {
    if (typeof archive?.verify !== 'function') {
      return { ok: false, error: 'VERIFY_NOT_SUPPORTED', checkedAt: isoNow() };
    }
    try {
      const result = await archive.verify();
      return result ?? { ok: false, error: 'VERIFY_RETURNED_NOTHING', checkedAt: isoNow() };
    } catch (err) {
      // archive.verify() contracts promise never to throw, but a misbehaving adapter
      // (or test double) must not be able to take /api/health down with it.
      return { ok: false, error: err?.code ?? 'VERIFY_THREW', checkedAt: isoNow() };
    }
  }

  /** Cached + single-flight: the first caller (cold or post-expiry) performs the check;
   * concurrent callers share that one in-flight verify() instead of each starting their own. */
  function getVerifyResult() {
    const now = clock();
    if (cached && cached.expiresAt > now) return Promise.resolve(cached.result);
    if (inFlight) return inFlight;
    inFlight = runVerify().then(
      (result) => {
        cached = { result, expiresAt: clock() + ttlMs };
        inFlight = null;
        return result;
      },
      (err) => {
        // runVerify() itself never rejects (see try/catch above), but guard anyway so a
        // stray rejection can't wedge inFlight forever.
        inFlight = null;
        throw err;
      }
    );
    return inFlight;
  }

  async function status() {
    if (archiveAdapter === 'disabled') {
      return { archiveAdapter, archiveStatus: 'DISABLED_DEVELOPMENT', checkedAt: isoNow() };
    }
    if (archiveAdapter !== 'stratus') {
      // 'local' and any unrecognised adapter name both fail open to LOCAL — this module's
      // job is readiness reporting, not adapter validation (src/server/index.js already
      // refuses to boot on an unknown ARCHIVE_ADAPTER).
      return { archiveAdapter, archiveStatus: 'LOCAL', checkedAt: isoNow() };
    }

    let result;
    try {
      result = await getVerifyResult();
    } catch (err) {
      result = { ok: false, error: err?.code ?? 'VERIFY_THREW', checkedAt: isoNow() };
    }

    if (result?.ok) {
      return {
        archiveAdapter,
        archiveStatus: 'ENABLED_VERIFIED',
        bucket: {
          name: result.bucketName ?? null,
          protected: result.protected ?? null,
          encryption: result.encryption ?? null,
          versioning: result.versioning ?? null,
          audit: result.audit ?? null,
          caching: result.caching ?? null,
        },
        checkedAt: result.checkedAt ?? isoNow(),
      };
    }

    return {
      archiveAdapter,
      archiveStatus: 'ENABLED_UNVERIFIED',
      error: result?.error ?? 'UNKNOWN',
      checkedAt: result?.checkedAt ?? isoNow(),
    };
  }

  return { status };
}
