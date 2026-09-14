import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { openStore } from '../src/adapters/store/catalyst.js';
import { createCatalystFake } from '../src/adapters/store/catalyst_fake.js';
import { createAudit } from '../src/core/audit.js';
import { createApp } from '../src/server/app.js';
import { newCorrelationId } from '../src/core/ids.js';
import { openInbox as openBundledInbox } from '../src/adapters/inbox/bundled.js';
import { openArchive as openLocalArchive } from '../src/adapters/archive/local.js';
import { createBooksClient } from '../src/books/index.js';
import { runSeedJob, buildDevSummary, DEMO_TAG, DEMO_OPERATOR, DEMO_APPROVER } from '../src/server/routes/dev.js';

function sha(token) {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

async function makeCatalystCtxAndDeps(t) {
  const { app } = createCatalystFake();
  const store = await openStore({ app });
  const audit = createAudit(store);
  const inbox = await openBundledInbox({});
  const tmpArchiveRoot = `./var/test-archive-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const archive = await openLocalArchive({ root: tmpArchiveRoot });
  const client = createBooksClient({ driver: 'mock', config: { mockWritesEnabled: true, organizationId: 'mock_org' } });
  t.after(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(tmpArchiveRoot, { recursive: true, force: true }).catch(() => {});
  });
  return { store, audit, inbox, archive, client };
}

// ---------------------------------------------------------------- runSeedJob (inline, no HTTP)

test('runSeedJob: seeds run-001 through mock Books end-to-end, tags every demo actor/reason', async (t) => {
  const { store, audit, inbox, archive, client } = await makeCatalystCtxAndDeps(t);
  const correlationId = newCorrelationId();
  const progress = {};

  const result = await runSeedJob({ store, audit, correlationId }, { inbox, archive, client, jobId: 'job-1', progress });

  assert.equal(result.outcome, 'SEEDED');
  assert.ok(result.counts.posted > 0, `expected some posted vouchers, got ${result.counts.posted}`);
  assert.equal(progress.outcome, 'SEEDED');
  assert.equal(progress.jobId, 'job-1');
  assert.ok(progress.startedAt);
  assert.ok(progress.finishedAt);

  // Every approval/exception-resolution text carries the synthetic-demo tag.
  const approvals = await store.find('approvals', {});
  assert.ok(approvals.length > 0);
  for (const a of approvals) {
    assert.equal(a.approver, DEMO_APPROVER);
    assert.ok(a.reason && a.reason.startsWith(DEMO_TAG), `approval reason must start with ${DEMO_TAG}: ${a.reason}`);
  }

  const approvedExceptions = (await store.find('exceptions', { status: 'APPROVED_EXCEPTION' }));
  for (const e of approvedExceptions) {
    assert.ok(e.disposition && e.disposition.startsWith(DEMO_TAG), `exception disposition must start with ${DEMO_TAG}: ${e.disposition}`);
    assert.ok(e.root_cause && e.root_cause.startsWith(DEMO_TAG));
  }

  const batches = await store.find('migration_batches', {});
  for (const b of batches) assert.equal(b.created_by, DEMO_OPERATOR);

  // Progress stages were persisted as DEV.SEED.<STAGE> audit events.
  const seedAudits = await store.find('audit_events', { entity_type: 'dev_seed_job' });
  assert.ok(seedAudits.some((e) => e.action === 'DEV.SEED.DONE'));
  assert.ok(seedAudits.every((e) => e.reason.startsWith(DEMO_TAG)));
});

test('runSeedJob: is idempotent — a rerun hits DUPLICATE_MANIFEST and reports ALREADY_SEEDED with unchanged counts', async (t) => {
  const { store, audit, inbox, archive, client } = await makeCatalystCtxAndDeps(t);
  const correlationId = newCorrelationId();

  const first = await runSeedJob({ store, audit, correlationId }, { inbox, archive, client, jobId: 'job-1', progress: {} });
  assert.equal(first.outcome, 'SEEDED');

  const second = await runSeedJob({ store, audit, correlationId }, { inbox, archive, client, jobId: 'job-2', progress: {} });
  assert.equal(second.outcome, 'ALREADY_SEEDED');
  assert.deepEqual(second.counts, first.counts);

  // No duplicate batches/approvals were created on the rerun.
  const batches = await store.find('migration_batches', {});
  const secondRunBatches = await store.find('migration_batches', {});
  assert.equal(batches.length, secondRunBatches.length);
});

test('buildDevSummary: reflects runs/dispositions/queue/exceptions after a seed', async (t) => {
  const { store, audit, inbox, archive, client } = await makeCatalystCtxAndDeps(t);
  await runSeedJob({ store, audit, correlationId: newCorrelationId() }, { inbox, archive, client, jobId: 'job-1', progress: {} });

  const summary = await buildDevSummary(store, { branchCode: 'PILOT01' });
  assert.ok(summary.runs.length >= 1);
  assert.ok(summary.dispositionBridge);
  assert.ok(typeof summary.queueCounts === 'object');
  assert.ok(typeof summary.exceptionsByCategory === 'object');
  assert.equal(summary.posting.enabled, false);
});

// ---------------------------------------------------------------- HTTP route: environment/role gating

function tokenUsers() {
  return [
    { id: 'u_admin', role: 'admin', principal_type: 'human', branches: ['*'], token_sha256: sha('tok-admin') },
    { id: 'u_operator', role: 'operator', principal_type: 'human', branches: ['PILOT01'], token_sha256: sha('tok-operator') },
  ];
}

async function startAppFor(environment, devSeedEnabled, t) {
  const { store, audit, inbox, archive, client } = await makeCatalystCtxAndDeps(t);
  const app = createApp({
    store,
    audit,
    users: tokenUsers(),
    deps: { books: client },
    devDeps: { inbox, archive, client },
    environment,
    storeAdapter: 'catalyst',
    archiveAdapter: 'local',
    devSeedEnabled,
  });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;
  return {
    base: `http://127.0.0.1:${port}`,
    store,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('POST /api/dev/seed: refused outside Development even for an admin with DEV_SEED_ENABLED=true', async (t) => {
  const { base, close } = await startAppFor('local', true, t);
  try {
    const res = await fetch(`${base}/api/dev/seed`, { method: 'POST', headers: { Authorization: 'Bearer tok-admin' } });
    assert.equal(res.status, 403);
  } finally {
    await close();
  }
});

test('POST /api/dev/seed: refused in Development when DEV_SEED_ENABLED is not true', async (t) => {
  const { base, close } = await startAppFor('Development', false, t);
  try {
    const res = await fetch(`${base}/api/dev/seed`, { method: 'POST', headers: { Authorization: 'Bearer tok-admin' } });
    assert.equal(res.status, 403);
  } finally {
    await close();
  }
});

test('POST /api/dev/seed: never allowed in Production, even with DEV_SEED_ENABLED=true', async (t) => {
  const { base, close } = await startAppFor('Production', true, t);
  try {
    const res = await fetch(`${base}/api/dev/seed`, { method: 'POST', headers: { Authorization: 'Bearer tok-admin' } });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.error, 'DEV_SEED_DISABLED');
  } finally {
    await close();
  }
});

test('POST /api/dev/seed: refused for a non-admin role even in Development with the flag on', async (t) => {
  const { base, close } = await startAppFor('Development', true, t);
  try {
    const res = await fetch(`${base}/api/dev/seed`, { method: 'POST', headers: { Authorization: 'Bearer tok-operator' } });
    assert.equal(res.status, 403);
  } finally {
    await close();
  }
});

test('POST /api/dev/seed: admin in Development with the flag on gets 202 + jobId, and status becomes SEEDED', async (t) => {
  const { base, close } = await startAppFor('Development', true, t);
  try {
    const res = await fetch(`${base}/api/dev/seed`, { method: 'POST', headers: { Authorization: 'Bearer tok-admin' } });
    assert.equal(res.status, 202);
    const { jobId } = await res.json();
    assert.ok(jobId);

    let status;
    for (let i = 0; i < 100; i += 1) {
      const statusRes = await fetch(`${base}/api/dev/seed/status?jobId=${jobId}`, { headers: { Authorization: 'Bearer tok-admin' } });
      status = await statusRes.json();
      if (status.outcome) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(status.outcome, 'SEEDED');
    assert.ok(status.counts.posted > 0);
  } finally {
    await close();
  }
});

test('GET /api/dev/summary: any authenticated role can read it, branch-scoped', async (t) => {
  const { base, close } = await startAppFor('Development', false, t);
  try {
    const res = await fetch(`${base}/api/dev/summary?branch=PILOT01`, { headers: { Authorization: 'Bearer tok-operator' } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.runs));
  } finally {
    await close();
  }
});

test('GET /api/dev/summary: refuses a branch outside the caller scope', async (t) => {
  const { base, close } = await startAppFor('Development', false, t);
  try {
    const res = await fetch(`${base}/api/dev/summary?branch=OTHER01`, { headers: { Authorization: 'Bearer tok-operator' } });
    assert.equal(res.status, 403);
  } finally {
    await close();
  }
});
