// Governed bot/MCP surface. See CONTRACTS.md §G and BOT_AND_MCP_SECURITY.md.
//
// This file does not duplicate the read/mutate routes — it defines the *policy* that
// routes/mutate.js enforces per-route (the bot action ceiling) and that app.js applies
// globally to every /api response (the minimal/untrusted response transform), plus the
// one route unique to the agent surface: GET /api/agent/capabilities.
import express from 'express';
import { isBotUser } from '../auth.js';

export { isBotUser };

/**
 * The exhaustive allowlist of mutating actions a bot/agent token may ever reach,
 * regardless of its provisioned role. Every other mutating route in routes/mutate.js
 * calls botGate(actionName) with an actionName NOT in this set, so a bot is refused
 * with 403 even when its role would otherwise satisfy the route's requireRole check.
 */
export const BOT_ALLOWED_ACTIONS = new Set(['pause_batch', 'resume_batch', 'retry_queue_item', 'assign_exception']);

export function botMayPerform(actionName) {
  return BOT_ALLOWED_ACTIONS.has(actionName);
}

// Keys stripped entirely from JSON responses in minimal mode: free narration and
// counterparty names that are not needed for governed bot workflows.
const STRIP_KEYS = new Set(['narration', 'party_name', 'ledger_name']);

// Free-text keys that survive minimal mode but are wrapped as { value, untrusted: true }
// so any downstream agent consuming them is told, structurally, never to treat the
// content as an instruction (CONTRACTS.md §G, BOT_AND_MCP_SECURITY.md §5).
const UNTRUSTED_TEXT_KEYS = new Set([
  'message',
  'human_summary',
  'root_cause',
  'reason',
  'note',
  'notes',
  'disposition_reason',
  'error_message',
]);

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Recursively strip narration/party/ledger names and wrap known free-text fields. */
export function transformMinimal(value) {
  if (Array.isArray(value)) return value.map(transformMinimal);
  if (isPlainObject(value)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (STRIP_KEYS.has(k)) continue;
      if (UNTRUSTED_TEXT_KEYS.has(k) && typeof v === 'string') {
        out[k] = { value: v, untrusted: true };
        continue;
      }
      out[k] = transformMinimal(v);
    }
    return out;
  }
  return value;
}

/**
 * Bot principals ALWAYS receive minimal/redacted output — no query parameter, header,
 * or role can opt a bot out (Codex P1: privacy filtering must not be bypassable by
 * the model-facing caller). Humans may opt in with `?minimal=1`; their default is full.
 */
export function isMinimalRequested(req) {
  if (isBotUser(req.user)) return true;
  const q = req.query?.minimal;
  return q === '1' || q === 'true';
}

/**
 * Mounted globally (app.js) ahead of route registration so it can patch res.json
 * before any handler runs. The patched res.json reads req.user/req.query lazily (at
 * call time, not at middleware-registration time), so it still sees whatever
 * authenticate() sets later in the same request's middleware chain.
 */
export function minimalResponseMiddleware() {
  return (req, res, next) => {
    const originalJson = res.json.bind(res);
    res.json = (body) => {
      if (isMinimalRequested(req)) {
        try {
          body = transformMinimal(body);
        } catch {
          // Never let a transform bug hide the response; fall through with the original body.
        }
      }
      return originalJson(body);
    };
    next();
  };
}

export function createAgentRouter({ auth }) {
  const router = express.Router();

  router.get('/agent/capabilities', auth.authenticate(), (req, res) => {
    res.json({
      allowed: [
        { action: 'read', description: 'Every GET /api/* read route, branch-scoped exactly like a console operator; minimal=1 by default.' },
        { action: 'pause_batch', method: 'POST', path: '/api/batches/:id/pause' },
        { action: 'resume_batch', method: 'POST', path: '/api/batches/:id/resume' },
        {
          action: 'retry_queue_item',
          method: 'POST',
          path: '/api/queue/:id/retry',
          note: 'Eligible-only: FAILED_RETRYABLE or DEAD_LETTER items. Never UNKNOWN_OUTCOME.',
        },
        { action: 'assign_exception', method: 'POST', path: '/api/exceptions/:id/assign' },
      ],
      never: [
        'Approve a financial batch, or self-approve anything.',
        'Enable production posting or change POSTING_ENABLED / the Books organisation allowlist.',
        'Change mappings, tolerances, or cutover rules.',
        'Retry an UNKNOWN_OUTCOME queue item.',
        'Run direct SQL or reach the store/inbox/archive adapters outside the governed API.',
        "Access another branch's data.",
      ],
    });
  });

  return router;
}
