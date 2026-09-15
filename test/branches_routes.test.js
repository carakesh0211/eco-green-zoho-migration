// Route tests for src/server/routes/branches.js. createApp() (src/server/app.js) does
// not mount this router yet (the app owner will do that), and its error handler is
// registered LAST inside createApp — mounting createBranchesRouter() after createApp()
// returns would put it AFTER that error handler, so thrown errors would never reach it.
// Build a minimal standalone app instead: express() + express.json() + createAuth() +
// createBranchesRouter(), same auth machinery the real app uses, plus a small inline
// error handler mirroring app.js's mapping for the couple of error codes this router
// can actually throw (BRANCH_NOT_FOUND is caught inline, so this is mostly a safety net).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createHash } from 'node:crypto';
import { openStore } from '../src/adapters/store/memory.js';
import { createAudit } from '../src/core/audit.js';
import { createAuth } from '../src/server/auth.js';
import { createBranchesRouter } from '../src/server/routes/branches.js';
import { nowIso } from '../src/core/ids.js';

function sha(token) {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

const TOKENS = {
  admin: 'tok-branches-admin',
  operatorPilot: 'tok-branches-operator-pilot',
  viewerAll: 'tok-branches-viewer-all',
  bot: 'tok-branches-bot',
};

function users() {
  return [
    { id: 'u_admin', role: 'admin', branches: ['*'], token_sha256: sha(TOKENS.admin) },
    { id: 'u_operator_pilot', role: 'operator', branches: ['PILOT01'], token_sha256: sha(TOKENS.operatorPilot) },
    { id: 'u_viewer_all', role: 'viewer', branches: ['*'], token_sha256: sha(TOKENS.viewerAll) },
    { id: 'bot_agent', principal_type: 'bot', role: 'operator', branches: ['*'], token_sha256: sha(TOKENS.bot) },
  ];
}

function authHeader(token) {
  return { Authorization: `Bearer ${token}` };
}

async function seedBranchSummaries(store) {
  const now = nowIso();
  const rows = [
    {
      branch_code: 'PILOT01', branch_name: 'Pilot One', zoho_location_id: 'LOC-1', zoho_location_name: 'Loc One',
      assigned_operator: 'op-1', assigned_approver: 'ap-1', live_start_date: '2026-06-01',
      migration_from_date: '2026-04-01', migration_to_date: '2026-05-31', receipt_status: 'RECEIVED',
      layer_a_status: 'PASS', mapping_status: 'APPROVED', overlap_status: 'CLEAR', open_exception_count: 1,
      open_exception_impact: '50.00', batch_approval_status: 'APPROVED', migrated_count: 5, total_count: 10,
      migration_progress_pct: 50, layer_c_status: 'NOT_RUN', balance_bridge_status: 'NOT_RUN',
      last_activity_at: '2026-09-10T00:00:00.000Z', readiness_status: 'IN_PROGRESS', is_synthetic: 0,
      summary_version: 1, created_at: now, updated_at: now,
    },
    {
      branch_code: 'EG-0002', branch_name: '[SYNTHETIC] Eco Green Branch 0002', zoho_location_id: null,
      zoho_location_name: null, assigned_operator: null, assigned_approver: null, live_start_date: null,
      migration_from_date: '2026-04-01', migration_to_date: null, receipt_status: 'NOT_RECEIVED',
      layer_a_status: 'NOT_RUN', mapping_status: 'NOT_STARTED', overlap_status: 'NOT_ASSESSED', open_exception_count: 0,
      open_exception_impact: '0.00', batch_approval_status: 'NONE', migrated_count: 0, total_count: 0,
      migration_progress_pct: 0, layer_c_status: 'NOT_RUN', balance_bridge_status: 'NOT_RUN',
      last_activity_at: null, readiness_status: 'NOT_STARTED', is_synthetic: 1,
      summary_version: 1, created_at: now, updated_at: now,
    },
    {
      branch_code: 'EG-0003', branch_name: '[SYNTHETIC] Eco Green Branch 0003, comma test', zoho_location_id: null,
      zoho_location_name: null, assigned_operator: null, assigned_approver: null, live_start_date: '2026-08-01',
      migration_from_date: '2026-04-01', migration_to_date: '2026-07-31', receipt_status: 'RECEIVED',
      layer_a_status: 'FAIL', mapping_status: 'DRAFT', overlap_status: 'OVERLAP_FOUND', open_exception_count: 3,
      open_exception_impact: '999.99', batch_approval_status: 'DRAFT', migrated_count: 0, total_count: 30,
      migration_progress_pct: 0, layer_c_status: 'NOT_RUN', balance_bridge_status: 'NOT_RUN',
      last_activity_at: '2026-09-05T00:00:00.000Z', readiness_status: 'BLOCKED', is_synthetic: 1,
      summary_version: 1, created_at: now, updated_at: now,
    },
  ];
  await store.insertMany('branch_summaries', rows);
  // Real branches row for PILOT01 so POST /refresh (which recomputes from scratch) succeeds.
  await store.insert('branches', {
    branch_code: 'PILOT01', branch_name: 'Pilot One', zoho_location_id: 'LOC-1', status: 'ACTIVE',
    created_at: now, updated_at: now,
  });
  return rows;
}

async function startApp() {
  const store = await openStore();
  const audit = createAudit(store);
  await seedBranchSummaries(store);
  const auth = createAuth({ users: users(), audit });

  const app = express();
  app.use(express.json());
  app.use('/api', createBranchesRouter({ store, audit, auth }));
  // Minimal safety-net error handler mirroring app.js's shape (not exercised by any
  // current test, since every thrown error this router can produce is caught inline).
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    res.status(500).json({ error: 'INTERNAL_ERROR', message: String(err?.message ?? err) });
  });

  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;
  return {
    store,
    base: `http://127.0.0.1:${port}`,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      await store.close();
    },
  };
}

test('GET /api/branches: admin sees all branches, paginated', async () => {
  const { base, close } = await startApp();
  try {
    const res = await fetch(`${base}/api/branches`, { headers: authHeader(TOKENS.admin) });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.total, 3);
    assert.equal(body.items.length, 3);
    assert.equal(body.page, 1);
    assert.equal(body.pageSize, 50);
    assert.equal(body.totalPages, 1);
    assert.ok(typeof body.expectedBranchCount === 'number');
    assert.ok(typeof body.meta.queryMs === 'number');
    assert.deepEqual(body.items.map((r) => r.branch_code).sort(), ['EG-0002', 'EG-0003', 'PILOT01']);
  } finally {
    await close();
  }
});

test('GET /api/branches: bots may read (any authenticated role including bots)', async () => {
  const { base, close } = await startApp();
  try {
    const res = await fetch(`${base}/api/branches`, { headers: authHeader(TOKENS.bot) });
    assert.equal(res.status, 200);
  } finally {
    await close();
  }
});

test('GET /api/branches: branch scope is applied BEFORE counting totals', async () => {
  const { base, close } = await startApp();
  try {
    const res = await fetch(`${base}/api/branches`, { headers: authHeader(TOKENS.operatorPilot) });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.total, 1, 'operator scoped to PILOT01 only sees PILOT01');
    assert.equal(body.items.length, 1);
    assert.equal(body.items[0].branch_code, 'PILOT01');
    assert.equal(body.counts.byReadiness.IN_PROGRESS, 1);
    assert.equal(Object.keys(body.counts.byReadiness).length, 1, 'counts reflect only the scoped rows');
  } finally {
    await close();
  }
});

test('GET /api/branches: equality filter pushdown (readiness) combined with search', async () => {
  const { base, close } = await startApp();
  try {
    const res = await fetch(`${base}/api/branches?readiness=BLOCKED`, { headers: authHeader(TOKENS.admin) });
    const body = await res.json();
    assert.deepEqual(body.items.map((r) => r.branch_code), ['EG-0003']);
  } finally {
    await close();
  }
});

test('GET /api/branches: pagination boundaries never exceed pageSize', async () => {
  const { base, close } = await startApp();
  try {
    const res = await fetch(`${base}/api/branches?pageSize=2&page=1`, { headers: authHeader(TOKENS.admin) });
    const body = await res.json();
    assert.equal(body.items.length, 2);
    assert.equal(body.totalPages, 2);

    const res2 = await fetch(`${base}/api/branches?pageSize=2&page=2`, { headers: authHeader(TOKENS.admin) });
    const body2 = await res2.json();
    assert.equal(body2.items.length, 1);
  } finally {
    await close();
  }
});

test('GET /api/branches: sort by open_exception_impact descending (money-string numeric sort)', async () => {
  const { base, close } = await startApp();
  try {
    const res = await fetch(`${base}/api/branches?sort=open_exception_impact&dir=desc`, { headers: authHeader(TOKENS.admin) });
    const body = await res.json();
    assert.deepEqual(body.items.map((r) => r.branch_code), ['EG-0003', 'PILOT01', 'EG-0002']);
  } finally {
    await close();
  }
});

test('GET /api/branches/:code: 200 in scope, 404 unknown, 403 out of scope', async () => {
  const { base, close } = await startApp();
  try {
    const ok = await fetch(`${base}/api/branches/PILOT01`, { headers: authHeader(TOKENS.operatorPilot) });
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.equal(body.branch_code, 'PILOT01');

    const notFound = await fetch(`${base}/api/branches/NOPE`, { headers: authHeader(TOKENS.admin) });
    assert.equal(notFound.status, 404);

    const forbidden = await fetch(`${base}/api/branches/EG-0002`, { headers: authHeader(TOKENS.operatorPilot) });
    assert.equal(forbidden.status, 403);
    const forbiddenBody = await forbidden.json();
    assert.match(forbiddenBody.message ?? '', /BRANCH_SCOPE:EG-0002/);
  } finally {
    await close();
  }
});

test('GET /api/branches/export.csv: bots are forbidden (403)', async () => {
  const { base, close } = await startApp();
  try {
    const res = await fetch(`${base}/api/branches/export.csv`, { headers: authHeader(TOKENS.bot) });
    assert.equal(res.status, 403);
  } finally {
    await close();
  }
});

test('GET /api/branches/export.csv: humans get all matching rows as CSV, with injection guard', async () => {
  const { base, close } = await startApp();
  try {
    const res = await fetch(`${base}/api/branches/export.csv`, { headers: authHeader(TOKENS.admin) });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/csv/);
    assert.equal(res.headers.get('content-disposition'), 'attachment; filename="branches.csv"');
    const text = await res.text();
    const lines = text.split('\r\n').filter(Boolean);
    assert.equal(lines.length, 4, 'header + 3 rows');
    assert.ok(lines[0].startsWith('branch_code,branch_name,'));
    // branch_name for EG-0003 contains a comma, so it must be quoted in the CSV body.
    assert.ok(text.includes('"[SYNTHETIC] Eco Green Branch 0003, comma test"'));
  } finally {
    await close();
  }
});

test('GET /api/branches/export.csv: respects branch scope (never leaks out-of-scope rows)', async () => {
  const { base, close } = await startApp();
  try {
    const res = await fetch(`${base}/api/branches/export.csv`, { headers: authHeader(TOKENS.operatorPilot) });
    const text = await res.text();
    const lines = text.split('\r\n').filter(Boolean);
    assert.equal(lines.length, 2, 'header + PILOT01 only');
    assert.ok(!text.includes('EG-0002'));
    assert.ok(!text.includes('EG-0003'));
  } finally {
    await close();
  }
});

test('POST /api/branches/:code/refresh: operator recomputes and audits BRANCH_SUMMARY.REFRESH', async () => {
  const { base, store, close } = await startApp();
  try {
    const before = await store.get('branch_summaries', 'PILOT01');
    const res = await fetch(`${base}/api/branches/PILOT01/refresh`, {
      method: 'POST',
      headers: { ...authHeader(TOKENS.operatorPilot), 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'test refresh' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.branch_code, 'PILOT01');
    assert.equal(body.summary_version, before.summary_version + 1);

    const auditRows = await store.find('audit_events', { entity_type: 'branch_summaries', entity_id: 'PILOT01' });
    assert.equal(auditRows.length, 1);
    assert.equal(auditRows[0].action, 'BRANCH_SUMMARY.REFRESH');
    assert.equal(auditRows[0].authorization_decision, 'ALLOWED');
  } finally {
    await close();
  }
});

test('POST /api/branches/:code/refresh: bots are forbidden even though bots read as "operator"', async () => {
  const { base, close } = await startApp();
  try {
    const res = await fetch(`${base}/api/branches/PILOT01/refresh`, {
      method: 'POST',
      headers: { ...authHeader(TOKENS.bot), 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(res.status, 403);
  } finally {
    await close();
  }
});

test('POST /api/branches/:code/refresh: viewer role is forbidden', async () => {
  const { base, close } = await startApp();
  try {
    const res = await fetch(`${base}/api/branches/PILOT01/refresh`, {
      method: 'POST',
      headers: { ...authHeader(TOKENS.viewerAll), 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(res.status, 403);
  } finally {
    await close();
  }
});

test('POST /api/branches/:code/refresh: 403 out of branch scope', async () => {
  const { base, close } = await startApp();
  try {
    // operatorPilot is scoped to PILOT01 only; EG-0002 has no `branches` row so this
    // would 404 on BranchNotFoundError for an in-scope admin, but for an out-of-scope
    // operator the branch-scope check must fire FIRST.
    const res = await fetch(`${base}/api/branches/EG-0002/refresh`, {
      method: 'POST',
      headers: { ...authHeader(TOKENS.operatorPilot), 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(res.status, 403);
  } finally {
    await close();
  }
});

test('POST /api/branches/:code/refresh: 404 when the branch has no `branches` row to compute from', async () => {
  const { base, close } = await startApp();
  try {
    const res = await fetch(`${base}/api/branches/EG-0002/refresh`, {
      method: 'POST',
      headers: { ...authHeader(TOKENS.admin), 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.error, 'BRANCH_NOT_FOUND');
  } finally {
    await close();
  }
});
