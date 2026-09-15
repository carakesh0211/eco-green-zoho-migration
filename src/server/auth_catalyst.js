// Catalyst Authentication (Zoho Catalyst User Management) as a second human-login path,
// composed with — never replacing — the existing bearer-token path in src/server/auth.js.
// See docs/CATALYST_AUTH.md for the research/decision behind this file.
//
// Catalyst Authentication only ever proves IDENTITY (an email address, a Catalyst
// user_id). It carries no opinion about this app's roles/branches — those still come
// exclusively from this app's own `app_users` table (via `resolveDirectoryUser`), exactly
// like the bearer path defers to `token_sha256` lookups. A Catalyst-authenticated email
// with no matching ACTIVE/INVITED app_users row is refused, never silently granted a role.
import { createHash } from 'node:crypto';
import { newCorrelationId, nowIso } from '../core/ids.js';

const LAST_LOGIN_DEDUPE_MS = 10 * 60 * 1000; // "at most once per 10 min per user"

function emailActorHash(email) {
  return `catalyst:${createHash('sha256').update(String(email), 'utf8').digest('hex').slice(0, 12)}`;
}

function hasBearerHeader(req) {
  return /^Bearer\s+.+/.test(req.headers.authorization || '');
}

function catalystModeEnabled() {
  return String(process.env.AUTH_MODE ?? 'token')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .includes('catalyst');
}

/**
 * createCatalystSessionAuth({ store, audit, currentApp, resolveDirectoryUser, clock })
 *  - store: the app's Store adapter (CONTRACTS.md §S) — used to read/activate the raw
 *    app_users row and to dedupe last_login_at writes; role/branch normalisation is
 *    delegated to `resolveDirectoryUser`, never re-derived here.
 *  - audit: src/core/audit.js's createAudit(store) result.
 *  - currentApp: () => Promise<CatalystApp> — src/server/catalyst_runtime.js's
 *    currentApp (per-request app via AsyncLocalStorage). Tests inject a fake.
 *  - resolveDirectoryUser: (store, { email }) => Promise<{id, role, principal_type,
 *    branches, email} | null> — owned by src/server/auth.js (concurrently developed).
 *  - clock: () => Date, defaults to `() => new Date()` — injectable for tests.
 * Returns { resolveSession, authenticateSession, deny }.
 */
export function createCatalystSessionAuth({ store, audit, currentApp, resolveDirectoryUser, clock = () => new Date() }) {
  // userId -> epoch ms of the last last_login_at write. Process-local, best-effort —
  // exactly what "cheap dedupe in memory" calls for; a restart or a second AppSail
  // instance simply re-writes once more, which is harmless.
  const lastLoginWrites = new Map();

  function correlationIdOf(req) {
    return req.correlationId || req.headers['x-correlation-id'] || newCorrelationId();
  }

  /** Emit a DENIED audit event, then send the HTTP response. Never throws — mirrors
   * auth.js's own deny() so both paths produce an identically-shaped audit trail. */
  async function deny(req, res, { status, error, reason, message, actor, actorRole }) {
    const correlationId = correlationIdOf(req);
    try {
      await audit.emit({
        actor: actor ?? req.user?.id ?? 'anonymous',
        actorRole: actorRole ?? req.user?.role ?? null,
        action: 'HTTP.ACCESS',
        entityType: 'http_request',
        entityId: `${req.method} ${req.originalUrl || req.path}`,
        reason,
        authorizationDecision: 'DENIED',
        correlationId,
      });
    } catch {
      // Never let an audit failure hide the real deny from the caller.
    }
    res.status(status).json({ error, message: message ?? reason });
  }

  /**
   * resolveSession(req) -> { email, catalystUserId, displayName } | null
   * Wraps every possible failure shape of `userManagement().getCurrentUser()` — the
   * SDK's typings promise `Promise<ICatalystUser>` with no documented null case, and the
   * installed implementation makes a plain HTTP call with no visible null-guard, which
   * suggests an unauthenticated request THROWS rather than resolving falsy (see
   * docs/CATALYST_AUTH.md §3.3 — unconfirmed which actually happens on live Catalyst).
   * Handles both: a thrown error and a falsy/incomplete response both mean "no session".
   * NEVER throws — an unauthenticated request must fall through, not 500.
   */
  async function resolveSession(req) {
    try {
      const app = await currentApp(req);
      if (!app || typeof app.userManagement !== 'function') return null;
      const user = await app.userManagement().getCurrentUser();
      if (!user || !user.email_id) return null;
      const displayName = [user.first_name, user.last_name].filter(Boolean).join(' ').trim() || user.email_id;
      return { email: user.email_id, catalystUserId: user.user_id ?? null, displayName };
    } catch {
      return null;
    }
  }

  function shouldWriteLastLogin(userId) {
    const last = lastLoginWrites.get(userId);
    const now = clock().getTime();
    return !last || now - last >= LAST_LOGIN_DEDUPE_MS;
  }

  async function touchLastLogin(userId) {
    if (!shouldWriteLastLogin(userId)) return;
    lastLoginWrites.set(userId, clock().getTime());
    try {
      await store.update('app_users', userId, { last_login_at: clock().toISOString() });
    } catch {
      // Best-effort bookkeeping; never fail the request over a last_login_at write.
    }
  }

  /**
   * authenticateSession() express middleware.
   * Tried ONLY when no `Authorization: Bearer` header is present AND AUTH_MODE includes
   * 'catalyst' (both checked here too, defensively, even though composeAuthenticate()
   * below already only calls this when there is no bearer header — this keeps the guard
   * correct if authenticateSession() is ever wired up standalone).
   */
  function authenticateSession() {
    return async (req, res, next) => {
      if (hasBearerHeader(req) || !catalystModeEnabled()) {
        // No Catalyst session was even attempted: same outward behaviour as the
        // pre-existing bearer-only world (missing token -> 401), so a caller relying on
        // that message never sees a behaviour change when catalyst mode is off.
        return deny(req, res, { status: 401, error: 'UNAUTHORIZED', reason: 'MISSING_BEARER_TOKEN', actor: 'anonymous' });
      }

      const session = await resolveSession(req);
      if (!session) {
        return deny(req, res, { status: 401, error: 'UNAUTHORIZED', reason: 'NO_CATALYST_SESSION', actor: 'anonymous' });
      }

      const { email } = session;
      const directoryRow = await store.findOne('app_users', { email });
      if (!directoryRow || directoryRow.status === 'INACTIVE') {
        return deny(req, res, {
          status: 403,
          error: 'USER_NOT_PROVISIONED',
          reason: 'USER_NOT_PROVISIONED',
          message: 'This Catalyst-authenticated email has no active account on this console.',
          actor: emailActorHash(email),
        });
      }

      if (directoryRow.status === 'INVITED') {
        // First sign-in activates the account. Activate BEFORE calling
        // resolveDirectoryUser() so it observes the row as ACTIVE, not INVITED —
        // resolveDirectoryUser's contract (src/server/auth.js) is to normalise an
        // "active app_users row"; ordering it this way means this file never has to
        // guess at how that function treats an INVITED row.
        await store.update('app_users', directoryRow.id, { status: 'ACTIVE', updated_at: nowIso() });
        try {
          await audit.emit({
            actor: directoryRow.id,
            actorRole: directoryRow.role,
            action: 'USER.ACTIVATED',
            entityType: 'app_users',
            entityId: directoryRow.id,
            reason: 'First Catalyst sign-in activates an invited account',
            authorizationDecision: 'ALLOWED',
            correlationId: correlationIdOf(req),
          });
        } catch {
          // Best-effort audit; never block the sign-in over it.
        }
      }

      const directoryUser = await resolveDirectoryUser(store, { email });
      if (!directoryUser) {
        // Fail closed: resolveDirectoryUser disagreeing with the raw row we just read
        // (e.g. a race, or a stricter internal rule) means we do NOT know this
        // principal's role/branches — never grant a default.
        return deny(req, res, {
          status: 403,
          error: 'USER_NOT_PROVISIONED',
          reason: 'USER_NOT_PROVISIONED',
          message: 'This Catalyst-authenticated email has no active account on this console.',
          actor: emailActorHash(email),
        });
      }

      req.user = { ...directoryUser, authMode: 'catalyst' };
      await touchLastLogin(directoryUser.id);
      next();
    };
  }

  return { resolveSession, authenticateSession, deny };
}

/**
 * composeAuthenticate(bearerAuthenticate, sessionAuthenticate) -> middleware
 * Uses the bearer path (byte-for-byte identical to today) when an `Authorization:
 * Bearer` header is present, the session path otherwise. This is the single
 * `authenticate()` meant to be swapped in wherever routes currently call
 * `auth.authenticate()`.
 */
export function composeAuthenticate(bearerAuthenticate, sessionAuthenticate) {
  const bearerMiddleware = bearerAuthenticate();
  const sessionMiddleware = sessionAuthenticate();
  return (req, res, next) => {
    if (hasBearerHeader(req)) return bearerMiddleware(req, res, next);
    return sessionMiddleware(req, res, next);
  };
}
