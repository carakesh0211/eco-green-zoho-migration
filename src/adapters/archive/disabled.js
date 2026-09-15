// Development-only "archive disabled" adapter (CONTRACTS.md §R). Selectable only when a
// deployed environment does not yet have Stratus activated: it never stores a single
// byte, so it must never be reachable from Production — `openArchive()` throws if it is.
//
// `put()` still returns a well-shaped, content-addressed URI (matching local.js/stratus.js's
// `<scheme>://.../<branch>/<run>/<sha256>/<fileName>` convention) so the rest of the
// pipeline (which persists `archive_uri` on source_files/vouchers) keeps working
// end-to-end for the synthetic Development demo — the URI is simply never resolvable via
// `get()`/`exists()`. Every `put()` also emits an `ARCHIVE.DISABLED` audit event so the
// gap is visible in the audit trail, not just in the health banner.
import { sha256Bytes } from '../../core/hash.js';
import { newCorrelationId } from '../../core/ids.js';

export class ArchiveDisabledInProductionError extends Error {
  constructor() {
    super('ARCHIVE_ADAPTER=disabled may only be selected outside Production (Stratus must be activated in Production)');
    this.code = 'ARCHIVE_DISABLED_IN_PRODUCTION';
  }
}

export class ArchiveDisabledError extends Error {
  constructor(uri) {
    super(`Archive is disabled in this Development environment (Stratus not yet activated): ${uri}`);
    this.code = 'ARCHIVE_DISABLED';
    this.uri = uri;
  }
}

function buildUri(branchCode, runId, sha256, fileName) {
  return `disabled://development/${branchCode}/${runId}/${sha256}/${fileName}`;
}

/**
 * @param {object} [opts]
 * @param {string} [opts.environment] - 'Development'|'Production'|'local'|... (see
 *   src/server/index.js#resolveEnvironment). Any value other than 'Production' may select
 *   this adapter; 'Production' throws immediately, before any put()/get()/exists() call.
 * @param {object} [opts.audit] - createAudit(store) instance; when given, put() emits an
 *   ARCHIVE.DISABLED audit event. Optional so the adapter can still be unit-tested bare.
 */
export async function openArchive({ environment = process.env.CATALYST_ENVIRONMENT ?? 'local', audit } = {}) {
  if (environment === 'Production') {
    throw new ArchiveDisabledInProductionError();
  }

  return {
    async put({ runId, branchCode, fileName, bytes, sha256 }) {
      const sha = sha256 ?? sha256Bytes(bytes);
      const uri = buildUri(branchCode, runId, sha, fileName);
      if (audit) {
        try {
          await audit.emit({
            actor: 'system:archive-disabled',
            action: 'ARCHIVE.DISABLED',
            entityType: 'source_files',
            entityId: `${branchCode}/${runId}/${fileName}`,
            after: { uri, sha256: sha, bytes: bytes?.length ?? null },
            reason: 'Archive adapter is disabled in this Development environment (Stratus not activated); no bytes were stored.',
            correlationId: newCorrelationId(),
            branchCode,
          });
        } catch {
          // Never let an audit failure block the (already no-op) put().
        }
      }
      return uri;
    },

    async exists() {
      return false;
    },

    async get(archiveUri) {
      throw new ArchiveDisabledError(archiveUri);
    },

    /**
     * verify() -> readiness check for /api/health (src/server/archive_health.js). This
     * adapter never stores a byte, so it is always unverified/disabled by construction —
     * no bucket or disk to probe. Never throws.
     */
    async verify() {
      return { ok: false, kind: 'disabled', reason: 'DISABLED_DEVELOPMENT' };
    },
  };
}
