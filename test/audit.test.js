import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/adapters/store/memory.js';
import { createAudit, MissingCorrelationIdError } from '../src/core/audit.js';

test('audit: emit() requires a correlationId', async () => {
  const store = await openStore();
  try {
    const audit = createAudit(store);
    await assert.rejects(
      () =>
        audit.emit({
          actor: 'tester',
          action: 'TEST.ACTION',
          entityType: 'branches',
          entityId: 'PILOT01',
        }),
      MissingCorrelationIdError
    );
    assert.equal(await store.count('audit_events', {}), 0);
  } finally {
    await store.close();
  }
});

test('audit: emit() inserts an append-only row with before/after JSON', async () => {
  const store = await openStore();
  try {
    const audit = createAudit(store);
    const row = await audit.emit({
      actor: 'tester',
      actorRole: 'operator',
      action: 'TEST.ACTION',
      entityType: 'branches',
      entityId: 'PILOT01',
      before: { status: 'ACTIVE' },
      after: { status: 'SUSPENDED' },
      reason: 'manual test',
      correlationId: 'corr-1',
      branchCode: 'PILOT01',
    });
    assert.ok(row.id);
    assert.equal(row.action, 'TEST.ACTION');
    assert.equal(row.correlation_id, 'corr-1');
    assert.equal(row.authorization_decision, 'ALLOWED');
    assert.deepEqual(JSON.parse(row.before_json), { status: 'ACTIVE' });
    assert.deepEqual(JSON.parse(row.after_json), { status: 'SUSPENDED' });

    const stored = await store.get('audit_events', row.id);
    assert.equal(stored.entity_id, 'PILOT01');
  } finally {
    await store.close();
  }
});

test('audit: before/after are redacted before storage', async () => {
  const store = await openStore();
  try {
    const audit = createAudit(store);
    const row = await audit.emit({
      actor: 'tester',
      action: 'TEST.SECRET',
      entityType: 'branches',
      entityId: 'PILOT01',
      before: { refresh_token: 'super-secret-value', note: 'ok' },
      after: null,
      correlationId: 'corr-2',
    });
    const before = JSON.parse(row.before_json);
    assert.equal(before.refresh_token, '[REDACTED]');
    assert.equal(before.note, 'ok');
  } finally {
    await store.close();
  }
});

test('audit: never updates or deletes — insert() is the only store call made', async () => {
  const store = await openStore();
  const originalUpdate = store.update;
  const originalRaw = store.raw;
  let updateCalled = false;
  store.update = (...args) => {
    updateCalled = true;
    return originalUpdate.apply(store, args);
  };
  try {
    const audit = createAudit(store);
    await audit.emit({ actor: 'tester', action: 'A', entityType: 'branches', entityId: 'x', correlationId: 'corr-3' });
    await audit.emit({ actor: 'tester', action: 'B', entityType: 'branches', entityId: 'x', correlationId: 'corr-3' });
    assert.equal(updateCalled, false);
    assert.equal(await store.count('audit_events', {}), 2);
  } finally {
    store.update = originalUpdate;
    store.raw = originalRaw;
    await store.close();
  }
});
