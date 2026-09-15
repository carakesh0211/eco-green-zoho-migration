// HTTP auth for the migration control console + governed bot surface. See CONTRACTS.md §H.
//
// Tokens are opaque bearer strings; only their sha256 ever touches config or memory
// comparisons (constant-time). Every 401/403 writes an audit event with
// authorization_decision DENIED so the trail shows what was tried, not just what
// succeeded. The actor for a DENIED event before we know who the caller is (missing or
// invalid token) is a short hash of the token itself — never the raw token, never
// "unknown" for an invalid-but-present token (so repeated bad attempts from the same
// caller are traceable without ever storing/logging the secret).
import { createHash, timingSafeEqual } from 'node:crypto';
import { newCorrelationId } from '../core/ids.js';

export function hashToken(token) {
  return createHash('sha256').update(String(token), 'utf8').digest('hex');
}

function safeEqualHex(aHex, bHex) {
  const a = Buffer.from(aHex, 'hex');
  const b = Buffer.from(bHex, 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export const PRINCIPAL_TYPES = Object.freeze(['human', 'bot']);
export const HUMAN_ROLES = Object.freeze(['viewer', 'operator', 'approver', 'admin']);
/** The maximum role a bot principal may ever hold (CONTRACTS.md §G, BOT_AND_MCP_SECURITY.md §2). */
export const BOT_MAX_ROLE = 'operator';
const BOT_ALLOWED_ROLES = Object.freeze(['viewer', 'operator']);

export class PrincipalConfigError extends Error {
  constructor(message, userId) {
    super(`users config: ${message}${userId ? ` (user ${JSON.stringify(userId)})` : ''}`);
    this.code = 'PRINCIPAL_CONFIG_INVALID';
    this.userId = userId;
  }
}

/**
 * Normalise and VALIDATE the users list at configuration-load time. Every principal
 * ends up with an explicit `principal_type` ('human' | 'bot'):
 *   - `principal_type: 'bot'` is authoritative.
 *   - Legacy markers (id prefixed `bot:` or role 'bot') also classify as bot, and are
 *     rejected if they contradict an explicit `principal_type: 'human'` — a Hermes token
 *     must never be silently downgraded to a full human operator (Codex P1 finding).
 *   - A bot's role is capped: only 'viewer' or 'operator' are accepted (role 'bot' is
 *     normalised to 'operator', the ceiling). approver/admin bots are a config error.
 *   - Human roles must be one of HUMAN_ROLES; ids must be unique and non-empty.
 * Throws PrincipalConfigError; callers must fail closed (refuse to start).
 */
export function normalizeUsers(users = []) {
  const seen = new Set();
  return users.map((u) => {
    const id = String(u?.id ?? '').trim();
    if (!id) throw new PrincipalConfigError('every user needs a non-empty id');
    if (seen.has(id)) throw new PrincipalConfigError('duplicate user id', id);
    seen.add(id);

    const legacyBot = id.startsWith('bot:') || u.role === 'bot';
    const declared = u.principal_type;
    if (declared !== undefined && !PRINCIPAL_TYPES.includes(declared)) {
      throw new PrincipalConfigError(`principal_type must be one of ${PRINCIPAL_TYPES.join('|')}`, id);
    }
    if (declared === 'human' && legacyBot) {
      throw new PrincipalConfigError("principal_type 'human' contradicts bot marker (id 'bot:*' or role 'bot')", id);
    }
    const principal_type = declared === 'bot' || legacyBot ? 'bot' : 'human';

    let role = u.role === 'bot' ? BOT_MAX_ROLE : String(u.role ?? '');
    if (principal_type === 'bot') {
      if (!BOT_ALLOWED_ROLES.includes(role)) {
        throw new PrincipalConfigError(`bot principals may only hold role ${BOT_ALLOWED_ROLES.join('|')}, got ${JSON.stringify(u.role)}`, id);
      }
    } else if (!HUMAN_ROLES.includes(role)) {
      throw new PrincipalConfigError(`role must be one of ${HUMAN_ROLES.join('|')}, got ${JSON.stringify(u.role)}`, id);
    }

    const branches = Array.isArray(u.branches) ? u.branches.map(String) : [];
    return { id, role, principal_type, branches, token_sha256: String(u.token_sha256 ?? '').toLowerCase() };
  });
}

/** A bot/agent principal (CONTRACTS.md §G). Classification comes from normalizeUsers(). */
export function isBotUser(user) {
  if (!user) return false;
  if (user.principal_type !== undefined) return user.principal_type === 'bot';
  // Defensive fallback for un-normalised objects (tests constructing req.user by hand).
  return String(user.id ?? '').startsWith('bot:') || user.role === 'bot';
}

/**
 * Role used for READ-route role checks. A bot user is always treated as (at least,
 * and at most) 'operator' for reads regardless of its configured role — this is the
 * read-side half of the §G role ceiling; the write-side half is enforced by the
 * per-route bot gate in routes/mutate.js.
 */
export function effectiveRoleForReads(user) {
  if (!user) return null;
  return isBotUser(user) ? 'operator' : user.role;
}

const DIRECTORY_CACHE_TTL_MS = 15_000;

/** Normalise an app_users row (from the store) into the same principal shape used
 *  for config users, plus `email`/`source` so callers can tell the two apart. Never
 *  includes token_sha256 — that field must never leave this module in a response. */
function normalizeDirectoryRow(row) {
  let branches = [];
  try {
    const parsed = JSON.parse(row.branches_json ?? '[]');
    if (Array.isArray(parsed)) branches = parsed.map(String);
  } catch {
    branches = [];
  }
  return {
    id: row.id,
    role: row.role,
    principal_type: row.principal_type,
    branches,
    email: row.email ?? null,
    source: 'directory',
  };
}

/**
 * Pure helper: resolve an ACTIVE directory (app_users) principal by email. Used by
 * another agent's Catalyst-session auth — keep this signature exactly as-is.
 * Returns the normalised user (see normalizeDirectoryRow) or null.
 */
export async function resolveDirectoryUser(store, { email }) {
  if (!store || !email) return null;
  const row = await store.findOne('app_users', { email, status: 'ACTIVE' });
  if (!row) return null;
  return normalizeDirectoryRow(row);
}

export function createAuth({ users = [], audit, store }) {
  // Fail closed: an invalid principal list is a startup error, never a silent downgrade.
  const table = normalizeUsers(users);

  // ---- store-backed directory (app_users) token resolution, cached 15s ----------
  // Bot tokens can be rotated at runtime (POST /api/admin/users/:id/rotate-token), so
  // every request re-checking the store would be correct but wasteful; a short cache
  // trades a few seconds of staleness (an old token keeps working briefly after
  // rotation) for avoiding a query per request. invalidateUserCache() lets a write
  // (or a test) force an immediate re-read.
  let directoryCache = null; // { at: number, rows: Array<app_users row> }

  function invalidateUserCache() {
    directoryCache = null;
  }

  async function loadActiveDirectoryRows() {
    if (!store) return [];
    const now = Date.now();
    if (directoryCache && now - directoryCache.at < DIRECTORY_CACHE_TTL_MS) {
      return directoryCache.rows;
    }
    const rows = await store.find('app_users', { status: 'ACTIVE' });
    directoryCache = { at: now, rows };
    return rows;
  }

  function findUserByToken(token) {
    const h = hashToken(token);
    for (const u of table) {
      if (u.token_sha256 && safeEqualHex(h, u.token_sha256)) {
        return { id: u.id, role: u.role, principal_type: u.principal_type, branches: u.branches };
      }
    }
    return null;
  }

  /** Store-backed counterpart to findUserByToken(); only ever consulted when the token
   *  didn't match a config user. Constant-time compare, same as the config path. */
  async function findDirectoryUserByToken(token) {
    if (!store) return null;
    const h = hashToken(token);
    const rows = await loadActiveDirectoryRows();
    for (const row of rows) {
      const rowHash = String(row.token_sha256 ?? '').toLowerCase();
      if (rowHash && safeEqualHex(h, rowHash)) {
        return normalizeDirectoryRow(row);
      }
    }
    return null;
  }

  function tokenActorHash(token) {
    return `token:${hashToken(token).slice(0, 12)}`;
  }

  function correlationIdOf(req) {
    return req.correlationId || req.headers['x-correlation-id'] || newCorrelationId();
  }

  /** Emit a DENIED audit event, then send the HTTP response. Never throws. */
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

  function authenticate() {
    return async (req, res, next) => {
      const header = req.headers.authorization || '';
      const m = /^Bearer\s+(.+)$/.exec(header);
      if (!m) {
        return deny(req, res, { status: 401, error: 'UNAUTHORIZED', reason: 'MISSING_BEARER_TOKEN', actor: 'anonymous' });
      }
      const token = m[1].trim();
      let user = findUserByToken(token);
      if (!user) user = await findDirectoryUserByToken(token);
      if (!user) {
        return deny(req, res, { status: 401, error: 'UNAUTHORIZED', reason: 'INVALID_TOKEN', actor: tokenActorHash(token) });
      }
      req.user = user;
      next();
    };
  }

  function requireRole(...roles) {
    return async (req, res, next) => {
      if (!req.user) return deny(req, res, { status: 401, error: 'UNAUTHORIZED', reason: 'NO_USER' });
      const effective = effectiveRoleForReads(req.user);
      if (!roles.includes(effective)) {
        return deny(req, res, {
          status: 403,
          error: 'FORBIDDEN',
          reason: `ROLE_REQUIRES:${roles.join('|')}`,
          message: `Requires role: ${roles.join(' or ')}`,
        });
      }
      next();
    };
  }

  /** Pure check, reusable inside handlers that must branch-scope a resource fetched by id. */
  function branchAllowed(user, branchCode) {
    if (!branchCode) return true;
    const branches = user?.branches ?? [];
    return branches.includes('*') || branches.includes(branchCode);
  }

  /** Middleware form for list/query routes where the branch is a route/query param. */
  function scopeBranch(paramOrQueryName = 'branch') {
    return async (req, res, next) => {
      const branch = req.params?.[paramOrQueryName] ?? req.query?.[paramOrQueryName];
      if (!branch) return next();
      if (branchAllowed(req.user, branch)) return next();
      return deny(req, res, {
        status: 403,
        error: 'FORBIDDEN',
        reason: `BRANCH_SCOPE:${branch}`,
        message: 'Branch not in your scope',
      });
    };
  }

  function requireCorrelationId() {
    return (req, res, next) => {
      const cid = req.headers['x-correlation-id'] || newCorrelationId();
      req.correlationId = cid;
      res.setHeader('X-Correlation-Id', cid);
      next();
    };
  }

  /** 403 for bot/agent principals. Team management (users, branch-period assignments)
   *  is a human-only surface — no route on it is in the §G bot allowlist. */
  function requireHuman() {
    return async (req, res, next) => {
      if (!req.user) return deny(req, res, { status: 401, error: 'UNAUTHORIZED', reason: 'NO_USER' });
      if (isBotUser(req.user)) {
        return deny(req, res, {
          status: 403,
          error: 'FORBIDDEN',
          reason: 'HUMAN_ONLY',
          message: 'Bot/agent tokens may not use this route',
        });
      }
      next();
    };
  }

  /** Middleware form of branchAllowed() for routes whose branch code is not a simple
   *  route/query param (e.g. it must be looked up from a row first). `getBranchCode`
   *  may be sync or async and receives `req`; a falsy result skips the check (same
   *  "no branch, no scoping" convention as scopeBranch()). */
  function requireScope(getBranchCode) {
    return async (req, res, next) => {
      let branchCode;
      try {
        branchCode = await getBranchCode(req);
      } catch (err) {
        return next(err);
      }
      if (!branchCode) return next();
      if (branchAllowed(req.user, branchCode)) return next();
      return deny(req, res, {
        status: 403,
        error: 'FORBIDDEN',
        reason: `BRANCH_SCOPE:${branchCode}`,
        message: 'Branch not in your scope',
      });
    };
  }

  return {
    authenticate,
    requireRole,
    scopeBranch,
    requireCorrelationId,
    requireHuman,
    requireScope,
    branchAllowed,
    deny,
    findUserByToken,
    invalidateUserCache,
  };
}
