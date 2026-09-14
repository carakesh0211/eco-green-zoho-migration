import test from 'node:test';
import assert from 'node:assert/strict';
import { assertDeployableConfig, StartupConfigError } from '../src/server/index.js';
import { assertPostingAllowed, postingBlockedReasons, PostingDisabledError } from '../src/books/guard.js';
import { assertWorkerCanStart, findConflictingSingletonLease, WorkerStartupRefusedError } from '../src/worker/index.js';
import { openArchive as openDisabledArchive, ArchiveDisabledInProductionError, ArchiveDisabledError } from '../src/adapters/archive/disabled.js';
import { openStore as openCatalystStore } from '../src/adapters/store/catalyst.js';
import { createCatalystFake } from '../src/adapters/store/catalyst_fake.js';
import { openStore as openMemoryStore } from '../src/adapters/store/memory.js';
import { createAudit } from '../src/core/audit.js';
import { newCorrelationId, nowIso } from '../src/core/ids.js';

// ---------------------------------------------------------------- startup: catalyst + local archive

test('startup fail-closed: STORE_ADAPTER=catalyst + ARCHIVE_ADAPTER=local refuses to start', () => {
  assert.throws(
    () => assertDeployableConfig({ storeAdapter: 'catalyst', archiveAdapter: 'local' }),
    (err) => err instanceof StartupConfigError && /ARCHIVE_ADAPTER=disabled/.test(err.message)
  );
});

test('startup fail-closed: catalyst + stratus is fine', () => {
  assert.doesNotThrow(() => assertDeployableConfig({ storeAdapter: 'catalyst', archiveAdapter: 'stratus' }));
});

test('startup fail-closed: catalyst + disabled (Development, Stratus not yet activated) is fine', () => {
  assert.doesNotThrow(() => assertDeployableConfig({ storeAdapter: 'catalyst', archiveAdapter: 'disabled' }));
});

test('startup fail-closed: sqlite + local is fine (the default, non-deployed shape)', () => {
  assert.doesNotThrow(() => assertDeployableConfig({ storeAdapter: 'sqlite', archiveAdapter: 'local' }));
});

// ---------------------------------------------------------------- posting guard: BEST_EFFORT_CLAIMS

function validBooksConfig(overrides = {}) {
  return {
    driver: 'live',
    postingEnabled: true,
    postingAuthorizationRef: 'ref-2026',
    orgAllowlist: ['org_1'],
    organizationId: 'org_1',
    ...overrides,
  };
}

test('assertPostingAllowed: refuses with BEST_EFFORT_CLAIMS when the store reports best-effort claim semantics', () => {
  const store = { claimSemantics: 'BEST_EFFORT' };
  assert.throws(
    () => assertPostingAllowed(validBooksConfig(), { store }),
    (err) => err instanceof PostingDisabledError && err.code === 'POSTING_DISABLED' && /BEST_EFFORT_CLAIMS/.test(err.reason)
  );
});

test('assertPostingAllowed: an ATOMIC (or unspecified) store does not add a BEST_EFFORT_CLAIMS block', () => {
  assert.doesNotThrow(() => assertPostingAllowed(validBooksConfig(), { store: { claimSemantics: 'ATOMIC' } }));
  assert.doesNotThrow(() => assertPostingAllowed(validBooksConfig()));
});

test('postingBlockedReasons: includes BEST_EFFORT_CLAIMS alongside other blockers, never throws', () => {
  const reasonsMock = postingBlockedReasons({ driver: 'mock' }, { store: { claimSemantics: 'BEST_EFFORT' } });
  assert.ok(reasonsMock.includes('DRIVER_NOT_LIVE'));
  assert.ok(reasonsMock.includes('BEST_EFFORT_CLAIMS'));

  const reasonsFullyValid = postingBlockedReasons(validBooksConfig(), { store: { claimSemantics: 'BEST_EFFORT' } });
  assert.deepEqual(reasonsFullyValid, ['BEST_EFFORT_CLAIMS']);

  const reasonsClean = postingBlockedReasons(validBooksConfig(), { store: { claimSemantics: 'ATOMIC' } });
  assert.deepEqual(reasonsClean, []);
});

// ---------------------------------------------------------------- worker: fail-closed singleton mode

test('worker: refuses to start on a catalyst (best-effort claim) store unless WORKER_MODE=singleton', async () => {
  const { app } = createCatalystFake();
  const store = await openCatalystStore({ app });
  const audit = createAudit(store);
  assert.equal(store.claimSemantics, 'BEST_EFFORT');

  await assert.rejects(
    () => assertWorkerCanStart({ store, audit, workerId: 'w1', workerMode: 'disabled' }),
    (err) => err instanceof WorkerStartupRefusedError && /singleton/.test(err.message)
  );
});

test('worker: an ATOMIC (sqlite/memory) store may start in any mode, no lease bookkeeping needed', async () => {
  const store = await openMemoryStore({});
  const audit = createAudit(store);
  try {
    const result = await assertWorkerCanStart({ store, audit, workerId: 'w1', workerMode: 'disabled' });
    assert.equal(result.ok, true);
  } finally {
    await store.close();
  }
});

test('worker: singleton mode on a catalyst store acquires the lease and writes WORKER.START', async () => {
  const { app } = createCatalystFake();
  const store = await openCatalystStore({ app });
  const audit = createAudit(store);

  const result = await assertWorkerCanStart({ store, audit, workerId: 'w1', workerMode: 'singleton' });
  assert.equal(result.ok, true);

  const starts = await store.find('audit_events', { action: 'WORKER.START' });
  assert.equal(starts.length, 1);
  assert.equal(starts[0].actor, 'w1');
});

test('worker: refuses a second singleton worker id within the lease window (no matching WORKER.STOP)', async () => {
  const { app } = createCatalystFake();
  const store = await openCatalystStore({ app });
  const audit = createAudit(store);

  await assertWorkerCanStart({ store, audit, workerId: 'w1', workerMode: 'singleton' });

  await assert.rejects(
    () => assertWorkerCanStart({ store, audit, workerId: 'w2', workerMode: 'singleton' }),
    (err) => err instanceof WorkerStartupRefusedError && err.conflict?.workerId === 'w1'
  );
});

test('worker: a second singleton worker id CAN start once the first cleanly WORKER.STOPs', async () => {
  const { app } = createCatalystFake();
  const store = await openCatalystStore({ app });
  const audit = createAudit(store);

  await assertWorkerCanStart({ store, audit, workerId: 'w1', workerMode: 'singleton' });
  await audit.emit({ actor: 'w1', action: 'WORKER.STOP', entityType: 'worker', entityId: 'w1', correlationId: newCorrelationId() });

  const result = await assertWorkerCanStart({ store, audit, workerId: 'w2', workerMode: 'singleton' });
  assert.equal(result.ok, true);
});

test('worker: the same workerId restarting in singleton mode is never treated as a conflict with itself', async () => {
  const { app } = createCatalystFake();
  const store = await openCatalystStore({ app });
  const audit = createAudit(store);

  await assertWorkerCanStart({ store, audit, workerId: 'w1', workerMode: 'singleton' });
  const result = await assertWorkerCanStart({ store, audit, workerId: 'w1', workerMode: 'singleton' });
  assert.equal(result.ok, true);
});

test('findConflictingSingletonLease: an expired lease (older than WORKER_LEASE_MS) is not a conflict', async () => {
  const { app } = createCatalystFake();
  const store = await openCatalystStore({ app });
  const audit = createAudit(store);
  const longAgo = new Date(Date.now() - 3_600_000).toISOString();

  await store.insert('audit_events', {
    actor: 'w-stale', actor_role: null, action: 'WORKER.START', entity_type: 'worker', entity_id: 'w-stale',
    before_json: null, after_json: null, reason: null, authorization_decision: 'ALLOWED',
    correlation_id: newCorrelationId(), branch_code: null, period: null, batch_id: null, created_at: longAgo,
  });

  const conflict = await findConflictingSingletonLease(store, { workerId: 'w-new' });
  assert.equal(conflict, null);
  void audit; // audit unused directly here; store.insert above bypasses audit.emit on purpose to control created_at
});

// ---------------------------------------------------------------- archive: disabled adapter

test('disabled archive adapter: put() returns a disabled:// uri without storing anything, and audits ARCHIVE.DISABLED', async () => {
  const store = await openMemoryStore({});
  const audit = createAudit(store);
  try {
    const archive = await openDisabledArchive({ environment: 'Development', audit });
    const bytes = Buffer.from('hello');
    const uri = await archive.put({ runId: 'run-1', branchCode: 'PILOT01', fileName: 'manifest.json', bytes });
    assert.match(uri, /^disabled:\/\/development\/PILOT01\/run-1\/[0-9a-f]{64}\/manifest\.json$/);

    const events = await store.find('audit_events', { action: 'ARCHIVE.DISABLED' });
    assert.equal(events.length, 1);
    assert.equal(events[0].branch_code, 'PILOT01');
  } finally {
    await store.close();
  }
});

test('disabled archive adapter: exists() is always false, get() always throws ARCHIVE_DISABLED', async () => {
  const archive = await openDisabledArchive({ environment: 'Development' });
  const uri = await archive.put({ runId: 'run-1', branchCode: 'PILOT01', fileName: 'f.csv', bytes: Buffer.from('x') });
  assert.equal(await archive.exists(uri), false);
  await assert.rejects(() => archive.get(uri), (err) => err instanceof ArchiveDisabledError && err.code === 'ARCHIVE_DISABLED');
});

test('disabled archive adapter: refuses to open at all in Production', async () => {
  await assert.rejects(() => openDisabledArchive({ environment: 'Production' }), ArchiveDisabledInProductionError);
});

test('disabled archive adapter: selectable for any non-Production environment (Development, local, UAT, ...)', async () => {
  for (const environment of ['Development', 'local', 'uat']) {
    await assert.doesNotReject(() => openDisabledArchive({ environment }));
  }
});

void nowIso;
