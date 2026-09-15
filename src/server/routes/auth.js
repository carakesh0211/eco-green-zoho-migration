// Auth-surface routes: who-am-i, public auth config, and the Catalyst login/logout
// redirects. See docs/CATALYST_AUTH.md for the decision behind the URLs/env vars here.
//
// Mount this router at the app ROOT (e.g. `app.use(createAuthRouter({...}))`) — unlike
// the other routers in this directory it deliberately mixes `/api/auth/*` (JSON) and
// bare `/auth/*` (redirects) paths, so it hardcodes both prefixes itself rather than
// being mounted under `/api`.
import express from 'express';

function wrap(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function originOf(req) {
  return `${req.protocol}://${req.get('host')}`;
}

/**
 * createAuthRouter({ auth, sessionAuth, environment })
 *  - auth: the composed auth surface (src/server/auth.js's createAuth() result, wired by
 *    the caller so `auth.authenticate()` is already `composeAuthenticate(bearer,
 *    session)` — this file never composes anything itself, it only consumes the result).
 *  - sessionAuth: src/server/auth_catalyst.js's createCatalystSessionAuth() result. Not
 *    used for authenticating routes here (that's `auth.authenticate()`'s job) — kept in
 *    the signature so a future route on this surface can call `sessionAuth.resolveSession()`
 *    directly (e.g. a diagnostics endpoint) without changing the factory shape.
 *  - environment: 'Development'|'Production'|'local'|... — accepted for parity with the
 *    other route factories in this directory (src/server/app.js passes it everywhere);
 *    no environment-specific behaviour is required by this pass (CATALYST_AUTH_LOGIN_URL
 *    being unset already hides the login/logout paths in every environment).
 */
export function createAuthRouter({ auth, sessionAuth, environment } = {}) {
  void sessionAuth;
  void environment;
  const router = express.Router();

  function authModes() {
    return String(process.env.AUTH_MODE ?? 'token')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  // Public: no `auth.authenticate()` — the UI needs this BEFORE it knows whether it has
  // any credential at all, to decide whether to show a "Sign in with Zoho" button.
  // Never returns a default URL that would leak a project/ZAID-bearing path (see
  // docs/CATALYST_AUTH.md §3.4) — `null` unless an operator explicitly configured one.
  router.get('/api/auth/config', (req, res) => {
    res.json({
      modes: authModes(),
      catalystLoginUrl: process.env.CATALYST_AUTH_LOGIN_URL || null,
      catalystLogoutUrl: process.env.CATALYST_AUTH_LOGOUT_URL || null,
    });
  });

  router.get(
    '/api/auth/me',
    auth.authenticate(),
    wrap(async (req, res) => {
      const body = {
        id: req.user.id,
        role: req.user.role,
        principal_type: req.user.principal_type,
        branches: req.user.branches,
        authMode: req.user.authMode ?? 'token',
      };
      // Only humans ever carry an email (the bearer/token principal shape has none —
      // see src/server/auth.js's normalizeUsers()); never expose it for a bot.
      if (req.user.principal_type === 'human' && req.user.email) {
        body.email = req.user.email;
      }
      res.json(body);
    })
  );

  router.get('/auth/login', (req, res) => {
    const target = process.env.CATALYST_AUTH_LOGIN_URL || null;
    if (!target) {
      return res.status(404).json({ error: 'AUTH_MODE_NOT_ENABLED', message: 'Catalyst login is not configured on this deployment.' });
    }
    const url = new URL(target);
    url.searchParams.set('redirect_uri', `${originOf(req)}/`);
    res.redirect(302, url.toString());
  });

  router.get('/auth/logout', (req, res) => {
    const target = process.env.CATALYST_AUTH_LOGOUT_URL || null;
    if (!target) {
      return res.status(404).json({ error: 'AUTH_MODE_NOT_ENABLED', message: 'Catalyst logout is not configured on this deployment.' });
    }
    const url = new URL(target);
    url.searchParams.set('redirect_uri', `${originOf(req)}/`);
    res.redirect(302, url.toString());
  });

  return router;
}
