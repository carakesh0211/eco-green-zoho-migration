// Express app factory. See CONTRACTS.md §H. The UI is not a security boundary —
// every check here is server-side and re-checked per request; the console just
// happens to be a convenient way to exercise the same API a human or the bot uses.
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { createAuth } from './auth.js';
import { createReadRouter } from './routes/read.js';
import { createMutateRouter } from './routes/mutate.js';
import { createDevRouter } from './routes/dev.js';
import { createAgentRouter, minimalResponseMiddleware } from './routes/agent.js';
import { createBranchesRouter } from './routes/branches.js';
import { createAdminRouter } from './routes/admin.js';
import { createAdminBooksRouter } from './routes/admin_books.js';
import { createAuthRouter } from './routes/auth.js';
import { resolveDirectoryUser } from './auth.js';
import { createCatalystSessionAuth, composeAuthenticate } from './auth_catalyst.js';
import { currentApp as runtimeCurrentApp } from './catalyst_runtime.js';
import { refreshBranchSummary } from '../core/branch_summary.js';
import { createBooksConnection } from '../books/connection.js';
import { createArchiveHealth } from './archive_health.js';
import { isPostingEnabled, postingBlockedReasons, loadBooksConfig } from '../books/guard.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, 'public');

let cachedVersion = '0.0.0';
try {
  // Best-effort; never fail startup over a version string.
  const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8'));
  cachedVersion = pkg.version ?? cachedVersion;
} catch {
  /* package.json read is best-effort only */
}

/**
 * @param {object} opts
 * @param {import('../adapters/store/sqlite.js').Store} opts.store
 * @param {ReturnType<typeof import('../core/audit.js').createAudit>} opts.audit
 * @param {Array<{id:string, role:string, branches:string[], token_sha256:string}>} [opts.users]
 * @param {object} [opts.deps] - { recon_a, cutover, mapping, batch, worker, recon_c, books }
 *   Concurrently-developed core modules, injected so tests can stub them and so a
 *   partial build (some modules not yet landed) degrades to 501 instead of crashing.
 * @param {object} [opts.devDeps] - { inbox, archive, client } for POST /api/dev/seed
 *   (Development-only synthetic seed job, src/server/routes/dev.js).
 * @param {object} [opts.runtime] - src/server/catalyst_runtime.js's createCatalystRuntime()
 *   result; when given, its middleware() is mounted so every request runs inside the
 *   request's Catalyst app context (a no-op unless a Catalyst-backed adapter is configured).
 * @param {string} [opts.environment] - 'Development'|'Production'|'local'|... (defaults to
 *   env X_ZOHO_CATALYST_ENVIRONMENT / CATALYST_ENVIRONMENT / 'local').
 * @param {string} [opts.storeAdapter] - defaults to env STORE_ADAPTER / 'sqlite'.
 * @param {string} [opts.archiveAdapter] - defaults to env ARCHIVE_ADAPTER / 'local'.
 * @param {string} [opts.inboxAdapter] - defaults to env INBOX_ADAPTER / 'local'.
 * @param {boolean} [opts.devSeedEnabled] - defaults to env DEV_SEED_ENABLED === 'true'.
 * @param {string} [opts.authMode] - 'token' | 'catalyst' | 'token,catalyst' (env AUTH_MODE, default
 *   'token'). With 'catalyst', requests without a Bearer header are authenticated through the
 *   Catalyst session (src/server/auth_catalyst.js) and mapped to an ACTIVE app_users row.
 * @param {object} [opts.booksConnection] - src/books/connection.js instance; built here when absent.
 * @param {object} [opts.sessionAuth] - createCatalystSessionAuth() result; built here when absent
 *   and authMode includes 'catalyst'.
 */
export function createApp({
  store,
  audit,
  users = [],
  deps = {},
  devDeps = {},
  runtime,
  environment = process.env.X_ZOHO_CATALYST_ENVIRONMENT || process.env.APP_ENVIRONMENT || process.env.CATALYST_ENVIRONMENT || 'local',
  storeAdapter = process.env.STORE_ADAPTER ?? 'sqlite',
  archiveAdapter = process.env.ARCHIVE_ADAPTER ?? 'local',
  inboxAdapter = process.env.INBOX_ADAPTER ?? 'local',
  devSeedEnabled = process.env.DEV_SEED_ENABLED === 'true',
  authMode = process.env.AUTH_MODE ?? 'token',
  booksConnection,
  sessionAuth,
  archiveHealth,
}) {
  const app = express();
  // Bearer tokens resolve against the config users first, then the app_users directory
  // (bots / break-glass). Humans normally arrive via the Catalyst session instead.
  const auth = createAuth({ users, audit, store });
  const modes = String(authMode).split(',').map((s) => s.trim()).filter(Boolean);
  if (modes.includes('catalyst')) {
    sessionAuth = sessionAuth ?? createCatalystSessionAuth({
      store, audit, currentApp: runtime?.currentApp ?? runtimeCurrentApp, resolveDirectoryUser, environment,
    });
    // Compose BEFORE any router captures auth.authenticate(): Bearer header -> bearer path
    // (byte-for-byte the previous behaviour), otherwise -> Catalyst session path.
    const bearerAuthenticate = auth.authenticate;
    auth.authenticate = () => composeAuthenticate(bearerAuthenticate, sessionAuth.authenticateSession);
  }
  booksConnection = booksConnection ?? createBooksConnection({ store, audit, config: deps.books?.config ?? loadBooksConfig() });
  const branchSummaryHook = { refreshBranchSummary: (ctx, { branchCode }) => refreshBranchSummary(ctx.store ?? store, branchCode) };

  app.disable('x-powered-by');

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          defaultSrc: ["'self'"],
          // static.zohocdn.com serves the Catalyst Web SDK bundle (catalystWebSDK.js);
          // `/__catalyst/sdk/init.js` is same-origin and already covered by 'self'.
          // See docs/CATALYST_AUTH.md §6 — no 'unsafe-inline' added; both are external
          // <script src> includes.
          scriptSrc: ["'self'", 'https://static.zohocdn.com'],
          styleSrc: ["'self'"],
          imgSrc: ["'self'", 'data:'],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
          frameAncestors: ["'none'"],
          // accounts.zohoportal.in is the auth_domain reported by this AppSail origin's own
          // /__catalyst/sdk/init.js (verified live 2026-09-15, docs/CATALYST_AUTH.md §0).
          frameSrc: ["'self'", 'https://accounts.zohoportal.in'],
        },
      },
    })
  );

  const allowedOrigins = String(process.env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (allowedOrigins.length > 0) {
    app.use(cors({ origin: allowedOrigins }));
  }

  app.use(express.json({ limit: '1mb' }));

  // No-op unless a Catalyst-backed adapter is configured (see catalyst_runtime.js):
  // initializes this request's Catalyst app and makes it available to every downstream
  // handler (including the request-scoped store/archive) via AsyncLocalStorage.
  if (runtime) app.use(runtime.middleware());

  // Archive readiness is an ACTUAL bucket check (cached, single-flight — src/server/archive_health.js),
  // never a value derived from configuration alone.
  archiveHealth = archiveHealth ?? createArchiveHealth({ archive: devDeps.archive, archiveAdapter });
  const claimSemantics = store?.claimSemantics === 'BEST_EFFORT' ? 'BEST_EFFORT' : 'ATOMIC';
  const workerMode = process.env.WORKER_MODE === 'singleton' ? 'singleton' : 'disabled';

  // Public, unauthenticated: drives the console's permanent red banner and lets an
  // operator confirm production posting is disabled before doing anything else. Never
  // includes any id (project/org/branch) — see task note "Unauthenticated, no IDs".
  app.get('/api/health', async (req, res) => {
    const archiveHealthResult = await archiveHealth.status();
    let driver = 'mock';
    let postingEnabled = false;
    try {
      driver = deps.books?.driver ?? driver;
      postingEnabled = isPostingEnabled(deps.books?.config);
    } catch {
      postingEnabled = false;
    }
    const postingBlockedBy = postingBlockedReasons(deps.books?.config, { store });
    res.json({
      ok: true,
      environment,
      storeAdapter,
      claimSemantics,
      archiveAdapter,
      archiveStatus: archiveHealthResult.archiveStatus,
      archiveBucket: archiveHealthResult.bucket ?? null,
      archiveCheckedAt: archiveHealthResult.checkedAt ?? null,
      archiveError: archiveHealthResult.error ?? null,
      driver,
      postingEnabled,
      postingBlockedBy,
      workerMode,
      inboxAdapter,
      version: cachedVersion,
      buildSha: process.env.BUILD_SHA ?? null,
    });
  });

  // Patches res.json ahead of every route so agent/bot responses (and any request
  // sending ?minimal=1) get narration/party-name stripped and free text wrapped as
  // { value, untrusted: true } — CONTRACTS.md §G.
  app.use('/api', minimalResponseMiddleware());

  app.use('/api', createAgentRouter({ auth }));
  app.use('/api', createReadRouter({ store, deps, auth }));
  app.use('/api', createMutateRouter({ store, audit, deps, auth }));
  app.use('/api', createDevRouter({ store, audit, auth, deps: devDeps, environment, devSeedEnabled, runtime }));
  // Increment 2 (team-operable console): dashboard, team & assignments, Books connection.
  app.use('/api', createBranchesRouter({ store, audit, auth }));
  app.use('/api', createAdminRouter({ store, audit, auth, users, deps: { branchSummary: branchSummaryHook } }));
  app.use('/api', createAdminBooksRouter({ connection: booksConnection, auth }));
  // Serves both /api/auth/* and the non-API /auth/login|logout redirects.
  app.use(createAuthRouter({ auth, sessionAuth, environment }));

  app.use(express.static(PUBLIC_DIR));

  // Central error handler: maps thrown domain errors to HTTP status codes so route
  // handlers can just `throw`/reject instead of hand-rolling try/catch everywhere.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof SyntaxError && 'body' in err) {
      return res.status(400).json({ error: 'BAD_JSON', message: err.message });
    }
    const code = err?.code;
    if (code === 'ILLEGAL_TRANSITION') return res.status(409).json({ error: code, message: err.message });
    if (code === 'UNIQUE_VIOLATION') return res.status(409).json({ error: code, message: err.message });
    if (code === 'ROW_NOT_FOUND' || code === 'RUN_NOT_FOUND' || code === 'EXCEPTION_NOT_FOUND') {
      return res.status(404).json({ error: code, message: err.message });
    }
    if (code === 'FORBIDDEN_ROLE') return res.status(403).json({ error: code, message: err.message });
    if (code === 'INVALID_RESOLVE_STATUS' || code === 'INVALID_CATEGORY' || code === 'AMBIGUOUS_MAPPING') {
      return res.status(400).json({ error: code, message: err.message });
    }
    if (code === 'POSTING_DISABLED') return res.status(409).json({ error: code, message: err.message });
    // eslint-disable-next-line no-console
    console.error(JSON.stringify({ ts: new Date().toISOString(), level: 'error', msg: 'unhandled_route_error', error: String(err?.stack || err) }));
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  });

  return app;
}
