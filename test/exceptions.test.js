import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/adapters/store/memory.js';
import { createAudit } from '../src/core/audit.js';
import {
  raise,
  resolve,
  CATEGORIES,
  InvalidCategoryError,
  InvalidResolveStatusError,
  RoleForbiddenError,
  ExceptionNotFoundError,
} from '../src/core/exceptions.js';

async function makeCtx(overrides = {}) {
  const store = await openStore();
  const audit = createAudit(store);
  return { store, audit, ctx: { store, audit, correlationId: 'corr-1', actor: 'tester', actorRole: 'operator', ...overrides } };
}

test('exceptions: CATEGORIES matches the contract list exactly', () => {
  assert.deepEqual(CATEGORIES, [
    'SCHEMA_FAILURE',
    'MISSING_KEY',
    'ORPHAN_RELATIONSHIP',
    'DUPLICATE_SOURCE',
    'DUPLICATE_FILE',
    'UNMAPPED_ENTITY',
    'UNMAPPED_MODULE',
    'AMBIGUOUS_MAPPING',
    'UNBALANCED_VOUCHER',
    'INVALID_TARGET_TYPE',
    'SMART_PHARMA_OVERLAP',
    'CUTOVER_RULE_MISSING',
    'LATE_OR_BACK_POSTED',
    'API_VALIDATION_ERROR',
    'AUTHENTICATION_ERROR',
    'RATE_LIMIT',
    'TRANSIENT_FAILURE',
    'UNKNOWN_API_OUTCOME',
    'TARGET_MISMATCH',
    'RECONCILIATION_DIFFERENCE',
    'POSTING_DISABLED',
  ]);
});

test('exceptions: raise() rejects an unknown category', async () => {
  const { store, ctx } = await makeCtx();
  try {
    await assert.rejects(
      () => raise(ctx, { category: 'NOT_A_CATEGORY', severity: 'P1', message: 'x', dedupeKey: 'dk-1' }),
      InvalidCategoryError
    );
  } finally {
    await store.close();
  }
});

test('exceptions: raise() creates a new OPEN row on first call', async () => {
  const { store, ctx } = await makeCtx();
  try {
    const row = await raise(ctx, {
      category: 'UNBALANCED_VOUCHER',
      severity: 'P1',
      message: 'voucher V-1 does not balance',
      dedupeKey: 'dk-voucher-1',
      branchCode: 'PILOT01',
      evidence: { voucherId: 'V-1' },
    });
    assert.equal(row.status, 'OPEN');
    assert.equal(row.category, 'UNBALANCED_VOUCHER');
    assert.deepEqual(JSON.parse(row.evidence_json), { voucherId: 'V-1' });

    const auditRows = await store.find('audit_events', { action: 'EXCEPTION.RAISED' });
    assert.equal(auditRows.length, 1);
  } finally {
    await store.close();
  }
});

test('exceptions: raise() on an OPEN row dedupes — touches instead of duplicating, merges evidence', async () => {
  const { store, ctx } = await makeCtx();
  try {
    const first = await raise(ctx, {
      category: 'ORPHAN_RELATIONSHIP',
      severity: 'P1',
      message: 'ledger missing',
      dedupeKey: 'dk-orphan-1',
      evidence: { ledgerCode: 'LEDG-1001' },
    });

    const second = await raise(ctx, {
      category: 'ORPHAN_RELATIONSHIP',
      severity: 'P1',
      message: 'ledger missing (rerun)',
      dedupeKey: 'dk-orphan-1',
      evidence: { extra: 'info' },
    });

    assert.equal(second.id, first.id, 'must not create a second row for the same dedupeKey');
    assert.equal(second.status, 'OPEN');
    assert.deepEqual(JSON.parse(second.evidence_json), { ledgerCode: 'LEDG-1001', extra: 'info' });

    const total = await store.count('exceptions', {});
    assert.equal(total, 1);

    const touched = await store.find('audit_events', { action: 'EXCEPTION.TOUCHED' });
    assert.equal(touched.length, 1);
  } finally {
    await store.close();
  }
});

test('exceptions: raise() after RESOLVED re-opens the row and audits the reopen', async () => {
  const { store, ctx } = await makeCtx();
  try {
    const raised = await raise(ctx, {
      category: 'DUPLICATE_SOURCE',
      severity: 'P1',
      message: 'dup row',
      dedupeKey: 'dk-dup-1',
    });

    await resolve(ctx, { id: raised.id, status: 'RESOLVED', rootCause: 'fixed upstream', actor: 'tester' });

    const reopened = await raise(ctx, {
      category: 'DUPLICATE_SOURCE',
      severity: 'P1',
      message: 'dup row again',
      dedupeKey: 'dk-dup-1',
    });

    assert.equal(reopened.id, raised.id);
    assert.equal(reopened.status, 'OPEN');

    const total = await store.count('exceptions', {});
    assert.equal(total, 1, 'reopen must reuse the row, never insert a second one');

    const reopenAudits = await store.find('audit_events', { action: 'EXCEPTION.REOPENED' });
    assert.equal(reopenAudits.length, 1);
  } finally {
    await store.close();
  }
});

test('exceptions: resolve() rejects an invalid status', async () => {
  const { store, ctx } = await makeCtx();
  try {
    const raised = await raise(ctx, { category: 'RATE_LIMIT', severity: 'P2', message: 'x', dedupeKey: 'dk-rl-1' });
    await assert.rejects(() => resolve(ctx, { id: raised.id, status: 'OPEN', actor: 'tester' }), InvalidResolveStatusError);
  } finally {
    await store.close();
  }
});

test('exceptions: resolve() throws for an unknown id', async () => {
  const { store, ctx } = await makeCtx();
  try {
    await assert.rejects(() => resolve(ctx, { id: 999999, status: 'RESOLVED', actor: 'tester' }), ExceptionNotFoundError);
  } finally {
    await store.close();
  }
});

test('exceptions: resolve(APPROVED_EXCEPTION) requires approver|admin role', async () => {
  const { store, ctx } = await makeCtx({ actorRole: 'operator' });
  try {
    const raised = await raise(ctx, { category: 'RECONCILIATION_DIFFERENCE', severity: 'P1', message: 'x', dedupeKey: 'dk-recon-1' });

    await assert.rejects(
      () => resolve(ctx, { id: raised.id, status: 'APPROVED_EXCEPTION', rootCause: 'accepted risk', actor: 'op1' }),
      RoleForbiddenError
    );

    // Row must be untouched (never deleted, status unchanged) after the forbidden attempt.
    const stillOpen = await store.get('exceptions', raised.id);
    assert.equal(stillOpen.status, 'OPEN');

    const approverCtx = { ...ctx, actorRole: 'approver' };
    const approved = await resolve(approverCtx, { id: raised.id, status: 'APPROVED_EXCEPTION', rootCause: 'accepted risk', actor: 'appr1' });
    assert.equal(approved.status, 'APPROVED_EXCEPTION');
  } finally {
    await store.close();
  }
});

test('exceptions: resolve() never deletes — row persists across every transition', async () => {
  const { store, ctx } = await makeCtx({ actorRole: 'admin' });
  try {
    const raised = await raise(ctx, { category: 'TARGET_MISMATCH', severity: 'P1', message: 'x', dedupeKey: 'dk-tm-1' });
    await resolve(ctx, { id: raised.id, status: 'REJECTED', rootCause: 'not applicable', actor: 'admin1' });
    const stillThere = await store.get('exceptions', raised.id);
    assert.ok(stillThere);
    assert.equal(stillThere.status, 'REJECTED');
    assert.equal(await store.count('exceptions', {}), 1);
  } finally {
    await store.close();
  }
});
