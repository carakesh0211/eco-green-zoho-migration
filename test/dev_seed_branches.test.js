// Tests for runSeedBranches / POST /api/dev/seed-branches (src/server/routes/dev.js),
// the Branch Control Dashboard seed job. Deliberately uses a small expectedCount (7)
// rather than the real ~351 default so the suite stays fast.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { openStore } from '../src/adapters/store/memory.js';
import { createAudit } from '../src/core/audit.js';
import { createApp } from '../src/server/app.js';
import { runSeedBranches, buildSyntheticBranchSummary } from '../src/server/routes/dev.js';

function sha(token) {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

const TOKENS = { admin: 'tok-seedbranches-admin', viewer: 'tok-seedbranches-viewer' };

function users() {
  return [
    { id: 'u_admin', role: 'admin', branches: ['*'], token_sha256: sha(TOKENS.admin) },
    { id: 'u_viewer', role: 'viewer', branches: ['*'], token_sha256: sha(TOKENS.viewer) },
  ];
}

test('buildSyntheticBranchSummary is deterministic per code (same code -> byte-identical row)', () => {
  const a = buildSyntheticBranchSummary('EG-0002', '2026-09-15T00:00:00.000Z');
  const b = buildSyntheticBranchSummary('EG-0002', '2026-09-16T12:00:00.000Z'); // different `now`
  // created_at/updated_at/last_activity_at are stamped from `now` at GENERATION time
  // (frozen forever once the row is inserted, since the seed route never regenerates
  // an existing code) — every other field is derived purely from the code via the
  // seeded PRNG and must be identical regardless of `now`.
  const { created_at: ac, updated_at: au, last_activity_at: aa, ...aRest } = a;
  const { created_at: bc, updated_at: bu, last_activity_at: ba, ...bRest } = b;
  assert.deepEqual(aRest, bRest, 'every field but the timestamps is derived purely from the code');
  assert.equal(a.branch_code, 'EG-0002');
  assert.equal(a.branch_name, '[SYNTHETIC] Eco Green Branch 0002');
  assert.equal(a.is_synthetic, 1);
  assert.equal(a.migration_from_date, '2026-04-01');
  assert.ok(['2026-06-01', '2026-08-01', '2026-10-01', null].includes(a.live_start_date));
  if (a.live_start_date) {
    assert.notEqual(a.migration_to_date, null);
    assert.ok(a.migration_to_date < a.live_start_date);
  } else {
    assert.equal(a.migration_to_date, null);
  }
});

test('buildSyntheticBranchSummary: readiness sub-statuses are internally consistent', () => {
  for (let n = 2; n <= 200; n += 1) {
    const code = `EG-${String(n).padStart(4, '0')}`;
    const row = buildSyntheticBranchSummary(code, '2026-09-15T00:00:00.000Z');
    if (row.readiness_status === 'MIGRATED') {
      assert.equal(row.migration_progress_pct, 100, code);
      assert.equal(row.layer_c_status, 'PASS', code);
    }
    if (row.readiness_status === 'BLOCKED') {
      assert.equal(row.layer_a_status, 'FAIL', code);
      assert.ok(row.open_exception_count >= 1, code);
    }
    if (row.readiness_status === 'READY') {
      assert.equal(row.layer_a_status, 'PASS', code);
      assert.equal(row.mapping_status, 'APPROVED', code);
      assert.equal(row.overlap_status, 'CLEAR', code);
      assert.equal(row.batch_approval_status, 'APPROVED', code);
    }
    if (row.readiness_status === 'NOT_STARTED') {
      assert.equal(row.receipt_status, 'NOT_RECEIVED', code);
      assert.equal(row.total_count, 0, code);
    }
    assert.ok(row.total_count === 0 ? row.migration_progress_pct === 0 : true, code);
    assert.ok(row.migrated_count <= row.total_count, code);
  }
});

test('runSeedBranches: first call SEEDS PILOT01 (real) + synthetic EG-0002..EG-0007', async () => {
  const store = await openStore();
  const audit = createAudit(store);
  const result = await runSeedBranches({ store, audit, correlationId: 'corr-1' }, { expectedCount: 7, now: '2026-09-15T00:00:00.000Z' });

  assert.equal(result.outcome, 'SEEDED');
  assert.equal(result.created, 7);
  assert.equal(result.existing, 0);
  assert.equal(result.expectedCount, 7);

  const rows = await store.find('branch_summaries', {});
  assert.equal(rows.length, 7);
  const pilot = rows.find((r) => r.branch_code === 'PILOT01');
  assert.ok(pilot);
  assert.equal(pilot.is_synthetic, 0);
  const synthetic = rows.filter((r) => r.branch_code !== 'PILOT01');
  assert.equal(synthetic.length, 6);
  assert.ok(synthetic.every((r) => r.is_synthetic === 1));
  assert.deepEqual(
    synthetic.map((r) => r.branch_code).sort(),
    ['EG-0002', 'EG-0003', 'EG-0004', 'EG-0005', 'EG-0006', 'EG-0007']
  );

  const branchRow = await store.findOne('branches', { branch_code: 'PILOT01' });
  assert.ok(branchRow, 'PILOT01 is bootstrapped into `branches` if missing');

  const auditRows = await store.find('audit_events', { action: 'DEV.SEED_BRANCHES' });
  assert.equal(auditRows.length, 1);
  await store.close();
});

test('runSeedBranches: idempotent rerun with the SAME expectedCount reports ALREADY_SEEDED and touches nothing new', async () => {
  const store = await openStore();
  const audit = createAudit(store);
  await runSeedBranches({ store, audit, correlationId: 'corr-1' }, { expectedCount: 7, now: '2026-09-15T00:00:00.000Z' });
  const beforeRows = await store.find('branch_summaries', {});
  const syntheticBefore = beforeRows.filter((r) => r.branch_code !== 'PILOT01');

  const second = await runSeedBranches({ store, audit, correlationId: 'corr-2' }, { expectedCount: 7, now: '2026-09-16T00:00:00.000Z' });
  assert.equal(second.outcome, 'ALREADY_SEEDED');
  assert.equal(second.created, 0);
  assert.equal(second.existing, 7);

  const afterRows = await store.find('branch_summaries', {});
  assert.equal(afterRows.length, 7, 'no duplicate rows created');
  const syntheticAfter = afterRows.filter((r) => r.branch_code !== 'PILOT01');
  // Synthetic rows are untouched byte-for-byte (never re-derived once they exist).
  const byCode = (rows) => Object.fromEntries(rows.map((r) => [r.branch_code, r]));
  const beforeByCode = byCode(syntheticBefore);
  const afterByCode = byCode(syntheticAfter);
  for (const code of Object.keys(beforeByCode)) {
    assert.deepEqual(afterByCode[code], beforeByCode[code], `${code} row must be byte-identical across reruns`);
  }
  await store.close();
});

test('runSeedBranches: growing expectedCount RESUMES — fills in only the new codes', async () => {
  const store = await openStore();
  const audit = createAudit(store);
  await runSeedBranches({ store, audit, correlationId: 'corr-1' }, { expectedCount: 5, now: '2026-09-15T00:00:00.000Z' });

  const grown = await runSeedBranches({ store, audit, correlationId: 'corr-2' }, { expectedCount: 8, now: '2026-09-16T00:00:00.000Z' });
  assert.equal(grown.outcome, 'RESUMED');
  assert.equal(grown.created, 3, 'EG-0006, EG-0007, EG-0008');
  assert.equal(grown.existing, 5, 'PILOT01 + EG-0002..EG-0005');

  const rows = await store.find('branch_summaries', {});
  assert.equal(rows.length, 8);
  await store.close();
});

test('runSeedBranches: PILOT01 is recomputed (real data) on every call, bumping its summary_version', async () => {
  const store = await openStore();
  const audit = createAudit(store);
  await runSeedBranches({ store, audit, correlationId: 'corr-1' }, { expectedCount: 3, now: '2026-09-15T00:00:00.000Z' });
  const first = await store.get('branch_summaries', 'PILOT01');
  assert.equal(first.summary_version, 1);

  await runSeedBranches({ store, audit, correlationId: 'corr-2' }, { expectedCount: 3, now: '2026-09-16T00:00:00.000Z' });
  const second = await store.get('branch_summaries', 'PILOT01');
  assert.equal(second.summary_version, 2);
  await store.close();
});

test('runSeedBranches: rejects a non-integer/zero expectedCount', async () => {
  const store = await openStore();
  const audit = createAudit(store);
  await assert.rejects(() => runSeedBranches({ store, audit, correlationId: 'c' }, { expectedCount: 0 }));
  await assert.rejects(() => runSeedBranches({ store, audit, correlationId: 'c' }, { expectedCount: 'many' }));
  await store.close();
});

test('POST /api/dev/seed-branches: 403 outside Development/DEV_SEED_ENABLED, 200 + audit when enabled', async () => {
  const store = await openStore();
  const audit = createAudit(store);
  const appDisabled = createApp({ store, audit, users: users(), environment: 'Production', devSeedEnabled: false });
  const server1 = appDisabled.listen(0);
  await new Promise((resolve) => server1.once('listening', resolve));
  const port1 = server1.address().port;
  const disabledRes = await fetch(`http://127.0.0.1:${port1}/api/dev/seed-branches`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKENS.admin}` },
  });
  assert.equal(disabledRes.status, 403);
  await new Promise((resolve) => server1.close(resolve));

  const store2 = await openStore();
  const audit2 = createAudit(store2);
  const appEnabled = createApp({ store: store2, audit: audit2, users: users(), environment: 'Development', devSeedEnabled: true });
  const server2 = appEnabled.listen(0);
  await new Promise((resolve) => server2.once('listening', resolve));
  const port2 = server2.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port2}/api/dev/seed-branches`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKENS.admin}`, 'X-Correlation-Id': 'corr-http-1' },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(['SEEDED', 'RESUMED', 'ALREADY_SEEDED'].includes(body.outcome));
    assert.equal(typeof body.expectedCount, 'number');

    const statusRes = await fetch(`http://127.0.0.1:${port2}/api/dev/seed-branches/status`, {
      headers: { Authorization: `Bearer ${TOKENS.admin}` },
    });
    assert.equal(statusRes.status, 200);
    const statusBody = await statusRes.json();
    assert.equal(statusBody.outcome, body.outcome);

    const forbiddenRole = await fetch(`http://127.0.0.1:${port2}/api/dev/seed-branches`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKENS.viewer}` },
    });
    assert.equal(forbiddenRole.status, 403);
  } finally {
    await new Promise((resolve) => server2.close(resolve));
    await store2.close();
  }
  await store.close();
});

test('GET /api/dev/seed-branches/status: 404 before any seed run has happened', async () => {
  const store = await openStore();
  const audit = createAudit(store);
  const app = createApp({ store, audit, users: users(), environment: 'Development', devSeedEnabled: true });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/dev/seed-branches/status`, {
      headers: { Authorization: `Bearer ${TOKENS.admin}` },
    });
    assert.equal(res.status, 404);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await store.close();
  }
});
