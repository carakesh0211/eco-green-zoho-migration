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

function normalizeEmailForCompare(email) {
  return String(email ?? '').trim().toLowerCase();
}

/**
 * Pure decision for the one-time owner bootstrap (see docs/CATALYST_AUTH.md, "Owner
 * bootstrap (Development only)"). All four conditions must hold:
 *  - environment === 'Development' (never Production/UAT/local, regardless of the env
 *    var or the latch)
 *  - activeHumanAdminExists is false — the durable, data-driven latch: once ANY
 *    app_users row has role='admin' AND principal_type='human' AND status='ACTIVE',
 *    this permanently returns false even if OWNER_BOOTSTRAP_EMAIL is left set
 *  - both ownerEmail and sessionEmail are non-empty
 *  - ownerEmail === sessionEmail, compared case-insensitively and trimmed
 * No I/O — callers are responsible for computing `activeHumanAdminExists` (see
 * `findActiveHumanAdmin`) and for actually performing the bootstrap write.
 */
export function shouldBootstrapOwner({ environment, ownerEmail, sessionEmail, activeHumanAdminExists }) {
  if (environment !== 'Development') return false;
  if (activeHumanAdminExists) return false;
  const owner = normalizeEmailForCompare(ownerEmail);
  const session = normalizeEmailForCompare(sessionEmail);
  if (!owner || !session) return false;
  return owner === session;
}

/**
 * findActiveHumanAdmin(store) -> Promise<app_users row | null>
 * The latch check itself: is there already an ACTIVE human admin? Deliberately not
 * scoped to any particular email — the latch is global, not per-owner-email.
 */
export async function findActiveHumanAdmin(store) {
  if (!store) return null;
  return store.findOne('app_users', { role: 'admin', principal_type: 'human', status: 'ACTIVE' });
}

/** Strip `email` from an app_users row before it ever reaches an audit payload.
 *  audit.emit()'s redact() only strips token/secret-shaped keys — email is not one
 *  of them — so the owner-bootstrap audit event must omit it itself. */
function stripEmail(row) {
  if (!row) return row;
  // eslint-disable-next-line no-unused-vars
  const { email, ...rest } = row;
  return rest;
}

/**
 * createCatalystSessionAuth({ store, audit, currentApp, resolveDirectoryUser, clock, environment })
 *  - store: the app's Store adapter (CONTRACTS.md §S) — used to read/activate the raw
 *    app_users row and to dedupe last_login_at writes; role/branch normalisation is
 *    delegated to `resolveDirectoryUser`, never re-derived here.
 *  - audit: src/core/audit.js's createAudit(store) result.
 *  - currentApp: () => Promise<CatalystApp> — src/server/catalyst_runtime.js's
 *    currentApp (per-request app via AsyncLocalStorage). Tests inject a fake.
 *  - resolveDirectoryUser: (store, { email }) => Promise<{id, role, principal_type,
 *    branches, email} | null> — owned by src/server/auth.js (concurrently developed).
 *  - clock: () => Date, defaults to `() => new Date()` — injectable for tests.
 *  - environment: 'Development' | 'Production' | ... — passed by the caller (e.g.
 *    createApp()) so the owner-bootstrap mechanism (see docs/CATALYST_AUTH.md) can be
 *    gated to Development only. Any value other than the literal string 'Development'
 *    (including undefined, i.e. a caller that hasn't wired this yet) disables it.
 * Returns { resolveSession, authenticateSession, deny }.
 */
export function createCatalystSessionAuth({ store, audit, currentApp, resolveDirectoryUser, clock = () => new Date(), environment }) {
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
   * resolveSession(req) -> { email, catalystUserId, displayName, firstName, lastName } | null
   * Wraps every possible failure shape of `userManagement().getCurrentUser()` — the
   * SDK's typings promise `Promise<ICatalystUser>` with no documented null case, and the
   * installed implementation makes a plain HTTP call with no visible null-guard, which
   * suggests an unauthenticated request THROWS rather than resolving falsy (see
   * docs/CATALYST_AUTH.md §3.3 — unconfirmed which actually happens on live Catalyst).
   * Handles both: a thrown error and a falsy/incomplete response both mean "no session".
   * NEVER throws — an unauthenticated request must fall through, not 500.
   * `firstName`/`lastName` are the raw Catalyst fields (no email fallback) — needed by
   * the owner-bootstrap path, which wants a 'Owner' fallback instead of leaking the
   * email into display_name; `displayName` keeps its existing email-fallback shape for
   * any other caller.
   */
  async function resolveSession(req) {
    try {
      const app = await currentApp(req);
      if (!app || typeof app.userManagement !== 'function') return null;
      const user = await app.userManagement().getCurrentUser();
      if (!user || !user.email_id) return null;
      const displayName = [user.first_name, user.last_name].filter(Boolean).join(' ').trim() || user.email_id;
      return {
        email: user.email_id,
        catalystUserId: user.user_id ?? null,
        displayName,
        firstName: user.first_name ?? null,
        lastName: user.last_name ?? null,
      };
    } catch {
      return null;
    }
  }

  /**
   * Owner bootstrap (Development only) — see docs/CATALYST_AUTH.md, "Owner bootstrap
   * (Development only)". Called from authenticateSession() right after a Catalyst
   * session resolves, before the normal app_users lookup. No-op unless
   * shouldBootstrapOwner() says yes; on success it creates/promotes the app_users row
   * to an ACTIVE admin with branches ['*'] and audits USER.OWNER_BOOTSTRAP, then lets
   * the caller's normal app_users lookup pick the row back up (now ACTIVE) so the
   * request proceeds as that admin — this function never sets req.user or calls next()
   * itself.
   */
  async function maybeBootstrapOwner(req, email, session) {
    const ownerEmail = process.env.OWNER_BOOTSTRAP_EMAIL;
    // Cheapest possible guard first: skip the store round-trip entirely unless we are
    // in Development with the env var set. This also means an operator who forgets to
    // unset OWNER_BOOTSTRAP_EMAIL after bootstrapping pays no extra cost once the latch
    // (checked next) is closed — see findActiveHumanAdmin() below.
    if (environment !== 'Development' || !ownerEmail) return;

    const activeAdmin = await findActiveHumanAdmin(store);
    const decision = shouldBootstrapOwner({
      environment,
      ownerEmail,
      sessionEmail: email,
      activeHumanAdminExists: Boolean(activeAdmin),
    });
    if (!decision) return;

    const now = clock().toISOString();
    const existing = await store.findOne('app_users', { email });
    let row;
    let before = null;

    if (existing) {
      // A bot principal can never be promoted: bots are capped at operator (CONTRACTS §G)
      // and a bootstrap email colliding with a bot row is a configuration error, not a grant.
      if (existing.principal_type === 'bot') return;
      before = stripEmail(existing);
      row = await store.update('app_users', existing.id, {
        role: 'admin',
        principal_type: 'human',
        status: 'ACTIVE',
        branches_json: JSON.stringify(['*']),
        version: existing.version + 1,
        updated_at: now,
      });
    } else {
      const id = `owner-${createHash('sha256').update(normalizeEmailForCompare(email), 'utf8').digest('hex').slice(0, 12)}`;
      const displayName = [session?.firstName, session?.lastName].filter(Boolean).join(' ').trim() || 'Owner';
      row = await store.insert('app_users', {
        id,
        email,
        display_name: displayName,
        role: 'admin',
        principal_type: 'human',
        status: 'ACTIVE',
        branches_json: JSON.stringify(['*']),
        token_sha256: null,
        created_by: 'owner-bootstrap',
        created_at: now,
        updated_at: now,
        version: 1,
        last_login_at: now,
      });
    }

    try {
      await audit.emit({
        actor: row.id,
        actorRole: row.role,
        action: 'USER.OWNER_BOOTSTRAP',
        entityType: 'app_users',
        entityId: row.id,
        before, // already email-stripped above (or null for a brand-new row)
        after: stripEmail(row),
        reason: 'OWNER_BOOTSTRAP_EMAIL matched; no active human admin existed',
        authorizationDecision: 'ALLOWED',
        correlationId: correlationIdOf(req),
      });
    } catch {
      // Best-effort audit; never block the sign-in over it — the write already
      // happened, and losing the audit row is strictly worse than blocking here.
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

      // Owner bootstrap (Development only; see docs/CATALYST_AUTH.md). No-op unless
      // OWNER_BOOTSTRAP_EMAIL matches this session and no ACTIVE human admin exists
      // yet. Runs BEFORE the app_users lookup below so a successful bootstrap is
      // picked straight back up by that same lookup (now ACTIVE) — never a separate
      // grant path.
      await maybeBootstrapOwner(req, email, session);

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
      // A Catalyst (human) session may never act as a bot principal: bots authenticate only
      // with their hashed bearer token (CONTRACTS §G). Treat a bot-typed row as unprovisioned.
      if (directoryUser && directoryUser.principal_type === 'bot') {
        return deny(req, res, { status: 403, error: 'FORBIDDEN', reason: 'USER_NOT_PROVISIONED', actor: emailActorHash(email) });
      }
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
