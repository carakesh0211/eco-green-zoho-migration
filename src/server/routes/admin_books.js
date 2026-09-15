// Administration -> Connections -> Zoho Books routes. See CONTRACTS.md §H (route/auth style),
// §Z (Books adapter), SECURITY.md, and src/books/connection.js (owns all the actual OAuth/state/
// gating logic — every handler here is a thin authenticate -> authorize -> delegate -> respond
// wrapper, same shape as routes/mutate.js).
//
// Every route is admin-only for human principals, and a bot principal is refused with 403
// (BOT_NOT_ALLOWED) before any handler runs — EXCEPT `GET /api/admin/books/callback`, which is
// the browser redirect Zoho itself sends back after the user approves consent: it carries no
// bearer token at all (Zoho cannot attach one), so it is authenticated implicitly by requiring a
// valid, unexpired, single-use `state` value instead (see connection.js's `completeCallback`).
//
// This router never touches POSTING_ENABLED/isPostingEnabled and never imports guard.js's
// `assertPostingAllowed` — connecting Books here can only ever reach `controls()`,
// which reports `isPostingEnabled(config)` (always false in this MVP) back verbatim.
import express from 'express';
import { isBotUser } from './agent.js';

function wrap(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

const ERROR_STATUS = Object.freeze({
  BOOKS_NOT_CONFIGURED: 409,
  BOOKS_SECRET_KEY_MISSING: 409,
  NOT_CONNECTED: 409,
  READ_NOT_AUTHORIZED: 409,
  LOCATION_ALREADY_MAPPED: 409,
  INVALID_STATE: 400,
  BAD_REQUEST: 400,
  BRANCH_NOT_FOUND: 404,
  LOCATION_NOT_FOUND: 404,
});

function statusForCode(code) {
  return ERROR_STATUS[code] ?? 502; // default: treat an unmapped code as an upstream Zoho failure
}

export function createAdminBooksRouter({ connection, auth }) {
  if (!connection) throw new TypeError('createAdminBooksRouter requires a connection');
  if (!auth) throw new TypeError('createAdminBooksRouter requires auth');

  const router = express.Router();

  function rejectBots(actionName) {
    return (req, res, next) => {
      if (isBotUser(req.user)) {
        return auth.deny(req, res, {
          status: 403,
          error: 'FORBIDDEN',
          reason: `BOT_NOT_ALLOWED:${actionName}`,
          message: 'Bot/agent tokens may not access Zoho Books connection administration',
        });
      }
      next();
    };
  }

  /** authenticate -> reject bots -> require admin. Every route below except the OAuth callback. */
  function humanAdminOnly(actionName) {
    return [auth.authenticate(), rejectBots(actionName), auth.requireRole('admin')];
  }

  function handleConnectionError(err, res) {
    if (err && typeof err.code === 'string') {
      return res.status(statusForCode(err.code)).json({ error: err.code, message: err.message });
    }
    throw err;
  }

  // ---- GET status + controls -------------------------------------------------------
  router.get(
    '/admin/books/connection',
    ...humanAdminOnly('view_connection'),
    wrap(async (req, res) => {
      const [status, controls, readiness] = await Promise.all([
        connection.getStatus(),
        connection.controls(),
        connection.readiness(),
      ]);
      res.json({ ...status, controls, readiness });
    })
  );

  // ---- begin connect ----------------------------------------------------------------
  router.post(
    '/admin/books/connect',
    ...humanAdminOnly('connect'),
    auth.requireCorrelationId(),
    wrap(async (req, res) => {
      try {
        const result = await connection.beginConnect({
          actor: req.user.id,
          region: req.body?.region,
          correlationId: req.correlationId,
        });
        res.json(result);
      } catch (err) {
        handleConnectionError(err, res);
      }
    })
  );

  // ---- OAuth callback: no bearer token, browser redirect from Zoho ------------------
  router.get(
    '/admin/books/callback',
    wrap(async (req, res) => {
      const { code, state, location } = req.query;
      const accountsServer = req.query['accounts-server'];
      try {
        await connection.completeCallback({
          code,
          state,
          location,
          accountsServer,
          actor: 'system:oauth-callback',
        });
        return res.redirect(302, '/#/admin/connections/books?connected=1');
      } catch (err) {
        // Never echo the raw code/state back to the browser — only a short redacted code.
        const errorCode = typeof err?.code === 'string' ? err.code : 'BOOKS_CALLBACK_FAILED';
        return res.redirect(302, `/#/admin/connections/books?error=${encodeURIComponent(errorCode)}`);
      }
    })
  );

  // ---- test connection ---------------------------------------------------------------
  router.post(
    '/admin/books/test',
    ...humanAdminOnly('test'),
    auth.requireCorrelationId(),
    wrap(async (req, res) => {
      try {
        const result = await connection.testConnection({ actor: req.user.id, correlationId: req.correlationId });
        res.json(result);
      } catch (err) {
        handleConnectionError(err, res);
      }
    })
  );

  // ---- sync locations -----------------------------------------------------------------
  router.post(
    '/admin/books/sync-locations',
    ...humanAdminOnly('sync_locations'),
    auth.requireCorrelationId(),
    wrap(async (req, res) => {
      try {
        const result = await connection.syncLocations({
          actor: req.user.id,
          driver: req.body?.driver,
          correlationId: req.correlationId,
        });
        res.json(result);
      } catch (err) {
        handleConnectionError(err, res);
      }
    })
  );

  // ---- list locations (with current mapping) -------------------------------------------
  router.get(
    '/admin/books/locations',
    ...humanAdminOnly('list_locations'),
    wrap(async (req, res) => {
      const locations = await connection.listLocations();
      res.json({ locations });
    })
  );

  // ---- location mapping -----------------------------------------------------------------
  router.put(
    '/admin/books/location-mapping',
    ...humanAdminOnly('location_mapping'),
    auth.requireCorrelationId(),
    wrap(async (req, res) => {
      const mappings = req.body?.mappings;
      if (!Array.isArray(mappings) || mappings.length === 0) {
        return res.status(400).json({ error: 'BAD_REQUEST', message: 'Body must be { mappings: [{ branch_code, location_id }, ...] }' });
      }
      try {
        const result = await connection.setLocationMapping({ actor: req.user.id, mappings, correlationId: req.correlationId });
        res.json({ mappings: result });
      } catch (err) {
        handleConnectionError(err, res);
      }
    })
  );

  // ---- disconnect -----------------------------------------------------------------------
  router.post(
    '/admin/books/disconnect',
    ...humanAdminOnly('disconnect'),
    auth.requireCorrelationId(),
    wrap(async (req, res) => {
      try {
        const result = await connection.disconnect({
          actor: req.user.id,
          reason: req.body?.reason,
          correlationId: req.correlationId,
        });
        res.json(result);
      } catch (err) {
        handleConnectionError(err, res);
      }
    })
  );

  return router;
}
