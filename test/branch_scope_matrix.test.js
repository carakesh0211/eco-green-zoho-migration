// Whole-surface authentication + branch-scope audit. Two independent checks:
//
//   1. Every /api/* route registered on a full createApp(...) (discovered by walking
//      app._router.stack recursively, not by reading route files) requires
//      authentication, except /api/health (explicitly public, see app.js) and any
//      path under /api/auth/ (reserved for a future login route; none exist yet).
//   2. A PILOT01-scoped operator (or admin, where the route requires that role)
//      touching a PILOT02 resource is refused: 403 on every read route that takes an
//      explicit ?branch=, filtered-out on /audit (which has no branch query param),
//      and 403 on mutate routes against PILOT02 rows seeded directly in the store.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { openStore } from '../src/adapters/store/memory.js';
import { createAudit } from '../src/core/audit.js';
import { createApp } from '../src/server/app.js';
import { nowIso } from '../src/core/ids.js';

function sha(token) {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

const TOKENS = {
  operator: 'tok-matrix-operator-pilot01',
  admin: 'tok-matrix-admin-pilot01',
};

function users() {
  return [
    { id: 'u_matrix_operator', role: 'operator', branches: ['PILOT01'], token_sha256: sha(TOKENS.operator) },
    { id: 'u_matrix_admin', role: 'admin', branches: ['PILOT01'], token_sha256: sha(TOKENS.admin) },
  ];
}

// ---------------------------------------------------------------- route discovery

/** Express 4 compiles `app.use('/prefix', router)` into a layer whose `regexp.source`
 *  looks like `^\/prefix\/?(?=\/|$)`; a root-mounted layer's source is `^\/?(?=\/|$)`
 *  (no literal segment). Pulling the literal segment back out lets us reconstruct each
 *  route's full mounted path without hard-coding '/api' anywhere in this test. */
function extractMountPrefix(regexpSource) {
  const m = /^\^\\\/((?:[^\\]|\\.)*?)\\\/\?\(\?=\\\/\|\$\)$/.exec(regexpSource);
  if (!m) return '';
  return `/${m[1].replace(/\\\//g, '/')}`;
}

/** Recursively walk app._router.stack and return every concrete {method, path}. */
function discoverRoutes(app) {
  const routes = [];
  function walk(stack, prefix) {
    for (const layer of stack) {
      if (layer.route) {
        const methods = Object.keys(layer.route.methods).filter((m) => layer.route.methods[m]);
        for (const method of methods) routes.push({ method: method.toUpperCase(), path: prefix + layer.route.path });
      } else if (layer.name === 'router' && layer.handle?.stack) {
        walk(layer.handle.stack, prefix + extractMountPrefix(layer.regexp.source));
      }
    }
  }
  walk(app._router.stack, '');
  return routes;
}

function fillParams(path) {
  return path.replace(/:([A-Za-z0-9_]+)/g, '1');
}

// ---------------------------------------------------------------- fixtures

async function seedBranch(store, branchCode) {
  const now = nowIso();
  await store.insert('branches', {
    branch_code: branchCode, branch_name: branchCode, zoho_location_id: `LOC-${branchCode}`,
    created_at: now, updated_at: now,
  });
  const run = await store.insert('extraction_runs', {
    id: `run-${branchCode}`, branch_code: branchCode, query_id: 'Q', query_version: 'v1',
    from_date: '2026-04-01', to_date: '2026-04-30', manifest_json: '{}', manifest_sha256: `msha-${branchCode}`,
    status: 'TRANSFORMED', created_at: now, updated_at: now,
  });
  const file = await store.insert('source_files', {
    run_id: run.id, file_name: 'transactions.csv', file_role: 'TRANSACTIONS', sha256: `fsha-${branchCode}`,
    size_bytes: 10, encoding: 'utf-8', delimiter: ',', status: 'ARCHIVED', created_at: now, updated_at: now,
  });
  const voucher = await store.insert('vouchers', {
    source_query_id: 'Q', source_query_version: 'v1', extraction_run_id: run.id, source_file_id: file.id,
    source_file_hash: 'fsha', source_record_id: `V-${branchCode}`, branch_code: branchCode,
    financial_year: '2026-27', period: '2026-04', transaction_date: '2026-04-05',
    source_transaction_type: 'PAYMENT', source_transaction_hash: `hash-${branchCode}`,
    debit_total: '100.00', credit_total: '100.00', line_count: 1, is_balanced: 1, disposition: 'MIGRATE',
    created_at: now, updated_at: now,
  });
  const batch = await store.insert('migration_batches', {
    id: `batch-${branchCode}`, branch_code: branchCode, period: '2026-04', run_id: run.id, scope_hash: `scope-${branchCode}`,
    mapping_version: 'map_v1', transformation_version: 'tx_v1', cutover_rule_version: 'cut_v1',
    voucher_count: 1, debit_total: '100.00', credit_total: '100.00', totals_json: '{}',
    status: 'QUEUED', created_by: 'seed', created_at: now, updated_at: now,
  });
  const exception = await store.insert('exceptions', {
    category: 'UNMAPPED_MODULE', severity: 'P2', branch_code: branchCode, period: '2026-04', run_id: run.id,
    financial_impact: '0.00', status: 'OPEN', message: 'seed exception', dedupe_key: `dedupe-${branchCode}`,
    created_at: now, updated_at: now,
  });
  const cutover = await store.insert('cutover_matrix', {
    branch_code: branchCode, zoho_location_id: `LOC-${branchCode}`, migration_from_date: '2026-04-01',
    live_system_start_date: '2026-06-01', historical_migration_end_date: '2026-05-31',
    transaction_class: '*', payment_method: '*', smart_pharma_coverage_status: 'NOT_COVERED',
    cutover_rule_version: 'cut_v1', approval_status: 'DRAFT', uk: `${branchCode}|*|*|cut_v1`,
    created_at: now, updated_at: now,
  });
  return { run, file, voucher, batch, exception, cutover };
}

async function startApp() {
  const store = await openStore();
  const audit = createAudit(store);
  const seeded = {
    PILOT01: await seedBranch(store, 'PILOT01'),
    PILOT02: await seedBranch(store, 'PILOT02'),
  };
  // A branch-scoped audit_events row, distinguishable via its correlation id, so the
  // /audit filtering assertion has something PILOT02-only to look for.
  await audit.emit({
    actor: 'seed', actorRole: 'admin', action: 'TEST.SEED', entityType: 'test_fixture', entityId: 'pilot02-marker',
    correlationId: 'corr-matrix-pilot02-seed', branchCode: 'PILOT02',
  });
  const app = createApp({ store, audit, users: users(), deps: {} });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    app, store, seeded, base,
    close: async () => { await new Promise((r) => server.close(r)); await store.close(); },
  };
}

function call(base, token, method, url, body) {
  const headers = { Authorization: `Bearer ${token}` };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return fetch(base + url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
}

// ---------------------------------------------------------------- 1. auth coverage

test('branch_scope_matrix: every /api/* route requires authentication, except /api/health and /api/auth/*', async () => {
  const { app, base, close } = await startApp();
  try {
    const routes = discoverRoutes(app);
    const apiRoutes = routes.filter((r) => r.path.startsWith('/api/'));
    // Sanity: this must actually be exercising the real route table, not an empty stack.
    assert.ok(apiRoutes.length >= 20, `expected a substantial /api route table, found ${apiRoutes.length}`);

    // /api/admin/books/callback is the Zoho OAuth redirect target: the browser arrives with no
    // bearer header; the request is bound by a single-use, 10-minute, sha256-stored state
    // (src/books/connection.js) and never echoes code/state. Everything else must 401.
    const exempt = (path) => path === '/api/health' || path.startsWith('/api/auth/') || path === '/api/admin/books/callback';
    const checked = [];
    for (const route of apiRoutes) {
      if (exempt(route.path)) continue;
      const url = fillParams(route.path);
      const res = await fetch(base + url, { method: route.method });
      assert.equal(res.status, 401, `${route.method} ${route.path} must require authentication (unauthenticated request), got ${res.status}`);
      checked.push(`${route.method} ${route.path}`);
    }
    assert.ok(checked.length >= 20, `expected to have checked a substantial number of routes, checked ${checked.length}`);

    // The exemption itself must be real, not just untested.
    const health = await fetch(base + '/api/health');
    assert.equal(health.status, 200);
  } finally {
    await close();
  }
});

// ---------------------------------------------------------------- 2. branch-scope matrix

test('branch_scope_matrix: PILOT01-scoped user reading PILOT02 branch-filtered routes -> 403', async () => {
  const { base, close } = await startApp();
  try {
    const readRoutesWithBranchParam = [
      '/api/runs?branch=PILOT02',
      '/api/exceptions?branch=PILOT02',
      '/api/cutover?branch=PILOT02',
      '/api/batches?branch=PILOT02',
      '/api/vouchers?branch=PILOT02',
    ];
    for (const url of readRoutesWithBranchParam) {
      const res = await call(base, TOKENS.operator, 'GET', url);
      assert.equal(res.status, 403, `GET ${url} should be 403 for a PILOT01-scoped user, got ${res.status}`);
      const body = await res.json();
      assert.equal(body.error, 'FORBIDDEN');
    }
  } finally {
    await close();
  }
});

test('branch_scope_matrix: /api/runs, /api/exceptions, /api/cutover, /api/batches without an explicit branch= still filter out PILOT02 rows', async () => {
  const { base, seeded, close } = await startApp();
  try {
    const runsBody = await (await call(base, TOKENS.operator, 'GET', '/api/runs')).json();
    assert.ok(!runsBody.runs.some((r) => r.id === seeded.PILOT02.run.id), 'PILOT02 run leaked into an unscoped list');
    assert.ok(runsBody.runs.some((r) => r.id === seeded.PILOT01.run.id), 'PILOT01 run missing from its own list');

    const excBody = await (await call(base, TOKENS.operator, 'GET', '/api/exceptions')).json();
    assert.ok(!excBody.exceptions.some((e) => e.id === seeded.PILOT02.exception.id));

    const cutBody = await (await call(base, TOKENS.operator, 'GET', '/api/cutover')).json();
    assert.ok(!cutBody.cutover.some((c) => c.id === seeded.PILOT02.cutover.id));

    const batchBody = await (await call(base, TOKENS.operator, 'GET', '/api/batches')).json();
    assert.ok(!batchBody.batches.some((b) => b.id === seeded.PILOT02.batch.id));

    const voucherBody = await (await call(base, TOKENS.operator, 'GET', '/api/vouchers')).json();
    assert.ok(!voucherBody.vouchers.some((v) => v.id === seeded.PILOT02.voucher.id));
  } finally {
    await close();
  }
});

test('branch_scope_matrix: /api/audit has no branch query param, but still filters out a PILOT02-scoped event', async () => {
  const { base, close } = await startApp();
  try {
    const res = await call(base, TOKENS.operator, 'GET', '/api/audit');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(!body.audit_events.some((e) => e.correlation_id === 'corr-matrix-pilot02-seed'), 'PILOT02-scoped audit event leaked to a PILOT01-scoped operator');
  } finally {
    await close();
  }
});

test('branch_scope_matrix: mutate routes 403 for a PILOT02 batch/exception/cutover row seeded in the store', async () => {
  const { base, seeded, close } = await startApp();
  try {
    // Operator-eligible mutate routes against a PILOT02 batch/exception.
    const pause = await call(base, TOKENS.operator, 'POST', `/api/batches/${seeded.PILOT02.batch.id}/pause`, { reason: 'matrix test' });
    assert.equal(pause.status, 403, `pausing a PILOT02 batch as a PILOT01 operator should be 403, got ${pause.status}`);

    const assign = await call(base, TOKENS.operator, 'POST', `/api/exceptions/${seeded.PILOT02.exception.id}/assign`, { owner: 'someone' });
    assert.equal(assign.status, 403, `assigning a PILOT02 exception as a PILOT01 operator should be 403, got ${assign.status}`);

    // Cutover upsert/approve require admin/approver, not operator — use the PILOT01-scoped
    // admin so the 403 proves branch scoping specifically, not just a role failure.
    const upsert = await call(base, TOKENS.admin, 'POST', '/api/cutover', {
      rows: [{ branch_code: 'PILOT02', transaction_class: '*', migration_from_date: '2026-04-01', smart_pharma_coverage_status: 'NOT_COVERED', cutover_rule_version: 'cut_v2' }],
    });
    assert.equal(upsert.status, 403, `upserting a PILOT02 cutover row as a PILOT01 admin should be 403, got ${upsert.status}`);

    const approve = await call(base, TOKENS.admin, 'POST', `/api/cutover/${seeded.PILOT02.cutover.id}/approve`, {});
    assert.equal(approve.status, 403, `approving a PILOT02 cutover row as a PILOT01 admin should be 403, got ${approve.status}`);
  } finally {
    await close();
  }
});
