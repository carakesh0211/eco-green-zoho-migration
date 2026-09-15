// Live-archive smoke endpoint (POST /api/dev/archive-smoke). Proves the configured
// archive adapter end-to-end with a synthetic CSV: put, exists, get (sha-verified),
// idempotent same-bytes put, IMMUTABLE_CONFLICT on different bytes, ghost uri absent.
// Run here against the Stratus-shaped fake; in the deployment it runs against real
// Stratus inside AppSail via the Catalyst SDK.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { openStore } from '../src/adapters/store/memory.js';
import { createAudit } from '../src/core/audit.js';
import { createApp } from '../src/server/app.js';
import { runArchiveSmoke } from '../src/server/routes/dev.js';
import { openArchive as openStratusArchive } from '../src/adapters/archive/stratus.js';
import { createStratusFake } from '../src/adapters/archive/stratus_fake.js';

const sha = (t) => createHash('sha256').update(t, 'utf8').digest('hex');

async function makeArchive() {
  const fake = createStratusFake();
  return openStratusArchive({ app: fake.app, bucketName: 'smoke-bucket' });
}

describe('runArchiveSmoke', () => {
  test('all seven steps pass against the Stratus-shaped fake and an audit event is written', async () => {
    const store = await openStore();
    const audit = createAudit(store);
    try {
      const archive = await makeArchive();
      const report = await runArchiveSmoke({ archive, audit, correlationId: 'corr-smoke', actor: 'tester' });
      assert.equal(report.ok, true, JSON.stringify(report.steps));
      assert.deepEqual(report.steps.map((s) => s.name), [
        'put', 'exists', 'get_bytes_match_and_sha_verified', 'put_same_bytes_is_idempotent',
        'put_different_bytes_rejected', 'exists_after_conflict_still_original', 'unwritten_uri_does_not_exist',
      ]);
      assert.ok(report.steps.every((s) => s.ok));
      assert.equal(report.branchCode, 'SMOKE01');
      assert.match(report.uri, /^stratus:\/\/smoke-bucket\/SMOKE01\/smoke-/);
      const events = await store.find('audit_events', { action: 'DEV.ARCHIVE_SMOKE' });
      assert.equal(events.length, 1);
      assert.match(events[0].reason, /^\[SYNTHETIC DEMO\]/);
    } finally { await store.close(); }
  });

  test('a broken adapter yields ok=false with the failing step named, never a throw', async () => {
    const store = await openStore();
    const audit = createAudit(store);
    try {
      const broken = { put: async () => { const e = new Error('boom'); e.code = 'NOT_IMPLEMENTED'; throw e; }, exists: async () => false, get: async () => Buffer.alloc(0) };
      const report = await runArchiveSmoke({ archive: broken, audit, correlationId: 'corr-smoke-2', actor: 'tester' });
      assert.equal(report.ok, false);
      assert.equal(report.steps[0].name, 'put');
      assert.equal(report.steps[0].ok, false);
      assert.equal(report.steps[0].error, 'NOT_IMPLEMENTED');
    } finally { await store.close(); }
  });
});

describe('POST /api/dev/archive-smoke gating', () => {
  async function startApp({ environment, devSeedEnabled, withArchive = true }) {
    const store = await openStore();
    const audit = createAudit(store);
    const archive = withArchive ? await makeArchive() : undefined;
    const app = createApp({
      store, audit,
      users: [
        { id: 'u_admin', role: 'admin', principal_type: 'human', branches: ['*'], token_sha256: sha('tok-admin') },
        { id: 'u_operator', role: 'operator', principal_type: 'human', branches: ['PILOT01'], token_sha256: sha('tok-operator') },
      ],
      deps: {}, devDeps: { archive }, environment, devSeedEnabled,
    });
    const server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    return { base, store, close: async () => { await new Promise((r) => server.close(r)); await store.close(); } };
  }
  const post = (base, token) => fetch(`${base}/api/dev/archive-smoke`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'X-Correlation-Id': 'c1' } });

  test('admin in Development with the flag -> 200 and a passing report', async () => {
    const t = await startApp({ environment: 'Development', devSeedEnabled: true });
    try {
      const res = await post(t.base, 'tok-admin');
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.ok, true);
      assert.equal(body.steps.length, 7);
    } finally { await t.close(); }
  });

  test('operator -> 403; Production -> 403; flag off -> 403; no archive -> 501', async () => {
    const dev = await startApp({ environment: 'Development', devSeedEnabled: true });
    try { assert.equal((await post(dev.base, 'tok-operator')).status, 403); } finally { await dev.close(); }
    const prod = await startApp({ environment: 'Production', devSeedEnabled: true });
    try { assert.equal((await post(prod.base, 'tok-admin')).status, 403); } finally { await prod.close(); }
    const off = await startApp({ environment: 'Development', devSeedEnabled: false });
    try { assert.equal((await post(off.base, 'tok-admin')).status, 403); } finally { await off.close(); }
    const none = await startApp({ environment: 'Development', devSeedEnabled: true, withArchive: false });
    try { assert.equal((await post(none.base, 'tok-admin')).status, 501); } finally { await none.close(); }
  });
});
