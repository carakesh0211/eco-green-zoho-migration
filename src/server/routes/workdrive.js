// WorkDrive branch inbox (src/server/workdrive_service.js).
//
//   GET  /api/workdrive/sync   any signed-in role: configured?, running / last job, tracker
//   POST /api/workdrive/sync   operator | admin, or a bot token (Hermes / scheduler): start a
//                              sync now -> 202 + job (joins one already running)
// Nothing here posts to Zoho Books.
import express from 'express';
import { isBotUser, botMayPerform } from './agent.js';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export function createWorkdriveRouter({ auth, service }) {
  const router = express.Router();
  router.get('/workdrive/sync', auth.authenticate(), wrap(async (req, res) => {
    await service.capture?.();
    res.json(await service.status());
  }));
  router.post(
    '/workdrive/sync',
    auth.authenticate(),
    auth.requireRole('operator', 'admin'),
    (req, res, next) => (isBotUser(req.user) && !botMayPerform('workdrive_sync')
      ? auth.deny(req, res, { status: 403, error: 'FORBIDDEN', reason: 'BOT_CEILING:workdrive_sync' })
      : next()),
    wrap(async (req, res) => {
      await service.capture?.();
      const r = service.start(isBotUser(req.user) ? 'agent' : 'manual', req.user.id);
      if (r.error) return res.status(503).json(r);
      const { done, ...job } = r.job;
      res.status(202).json({ job, joined: r.joined });
    }),
  );
  return router;
}
