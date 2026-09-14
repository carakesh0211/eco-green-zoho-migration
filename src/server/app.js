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
import { createAgentRouter, minimalResponseMiddleware } from './routes/agent.js';
import { isPostingEnabled } from '../books/guard.js';

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
 */
export function createApp({ store, audit, users = [], deps = {} }) {
  const app = express();
  const auth = createAuth({ users, audit });

  app.disable('x-powered-by');

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'"],
          imgSrc: ["'self'", 'data:'],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
          frameAncestors: ["'none'"],
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

  // Public, unauthenticated: drives the console's permanent red banner and lets an
  // operator confirm production posting is disabled before doing anything else.
  app.get('/api/health', (req, res) => {
    let driver = 'mock';
    let postingEnabled = false;
    try {
      if (deps.books) {
        driver = deps.books.driver ?? driver;
        postingEnabled = isPostingEnabled(deps.books.config);
      }
    } catch {
      postingEnabled = false;
    }
    res.json({
      ok: true,
      driver,
      postingEnabled,
      storeAdapter: process.env.STORE_ADAPTER ?? 'sqlite',
      version: cachedVersion,
    });
  });

  // Patches res.json ahead of every route so agent/bot responses (and any request
  // sending ?minimal=1) get narration/party-name stripped and free text wrapped as
  // { value, untrusted: true } — CONTRACTS.md §G.
  app.use('/api', minimalResponseMiddleware());

  app.use('/api', createAgentRouter({ auth }));
  app.use('/api', createReadRouter({ store, deps, auth }));
  app.use('/api', createMutateRouter({ store, audit, deps, auth }));

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
