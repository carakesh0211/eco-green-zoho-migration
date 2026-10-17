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
  operator: 'tok-map-operator',
  approver: 'tok-map-approver',
  admin: 'tok-map-admin',
  viewer: 'tok-map-viewer',
};

function users() {
  return [
    { id: 'u_operator', role: 'operator', branches: ['PILOT01'], token_sha256: sha(TOKENS.operator) },
    { id: 'u_approver', role: 'approver', branches: ['PILOT01'], token_sha256: sha(TOKENS.approver) },
    { id: 'u_admin', role: 'admin', branches: ['*'], token_sha256: sha(TOKENS.admin) },
    { id: 'u_viewer', role: 'viewer', branches: ['PILOT01'], token_sha256: sha(TOKENS.viewer) },
  ];
}

function hdr(role) {
  return { Authorization: `Bearer ${TOKENS[role]}`, 'Content-Type': 'application/json' };
}

async function seedRun(store, id, branch) {
  const now = nowIso();
  return store.insert('extraction_runs', {
    id,
    branch_code: branch,
    query_id: 'Q',
    query_version: 'v1',
    from_date: '2026-04-01',
    to_date: '2026-04-30',
    manifest_json: '{}',
    manifest_sha256: `sha-${id}`,
    status: 'STAGED',
    created_at: now,
    updated_at: now,
  });
}

const okTransform = {
  retransformRun: async (ctx, { runId }) => ({ runId, status: 'TRANSFORMED', reset: 1, stillBlocked: 0 }),
};

function throwingTransform(code) {
  const fail = async () => {
    const err = new Error(`fake ${code}`);
    err.code = code;
    throw err;
  };
  return { checkRetransformable: fail, retransformRun: fail };
}

async function startApp({ transform = okTransform, withTransform = true } = {}) {
  const store = await openStore();
  const audit = createAudit(store);
  await seedRun(store, 'run-in', 'PILOT01');
  await seedRun(store, 'run-out', 'PILOT02');
  const deps = { mapping: await import('../src/core/mapping.js') };
  if (withTransform) deps.transform = transform;
  const app = createApp({ store, audit, users: users(), deps });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    app,
    store,
    base,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      await store.close();
    },
  };
}

function rule(over = {}) {
  return {
    rule_type: 'LEDGER_ACCOUNT',
    source_key: 'SALES',
    target_value: '1001',
    mapping_version: 'map_v1',
    effective_from: '2026-04-01',
    ...over,
  };
}

async function post(base, path, role, body) {
  const res = await fetch(`${base}/api${path}`, { method: 'POST', headers: hdr(role), body: JSON.stringify(body ?? {}) });
  return { res, body: await res.json().catch(() => null) };
}

async function get(base, path, role = 'viewer') {
  const res = await fetch(`${base}/api${path}`, { headers: hdr(role) });
  return { res, body: await res.json().catch(() => null) };
}

test('POST /mappings: operator upserts DRAFT rows, forcing status even if APPROVED is sent', async () => {
  const t = await startApp();
  try {
    const { res, body } = await post(t.base, '/mappings', 'operator', {
      rows: [
        rule({ status: 'APPROVED', approved_by: 'someone', approved_at: '2026-04-02T00:00:00Z' }),
        rule({ source_key: 'PURCH', target_meta: { account_id: 'A1' } }),
      ],
    });
    assert.equal(res.status, 200);
    assert.equal(body.upserted, 2);
    assert.equal(body.unchanged, 0);
    assert.equal(body.mappings.length, 2);
    for (const m of body.mappings) {
      assert.equal(m.status, 'DRAFT');
      assert.equal(m.approved_by, null);
      assert.equal(m.approved_at, null);
    }
    const stored = await t.store.find('mapping_rules', {});
    assert.ok(stored.every((r) => r.status === 'DRAFT'));
    const audits = await t.store.find('audit_events', { action: 'MAPPING.UPSERT' });
    assert.equal(audits.length, 1);
    assert.match(String(audits[0].after_json ?? JSON.stringify(audits[0])), /unchanged/);
  } finally {
    await t.close();
  }
});

test('POST /mappings: viewer is forbidden', async () => {
  const t = await startApp();
  try {
    const { res } = await post(t.base, '/mappings', 'viewer', [rule()]);
    assert.equal(res.status, 403);
    assert.equal((await t.store.find('mapping_rules', {})).length, 0);
  } finally {
    await t.close();
  }
});

test('POST /mappings: validation names the first bad row index', async () => {
  const t = await startApp();
  try {
    const cases = [
      [rule(), rule({ rule_type: 'BOGUS' })],
      [rule(), rule(), rule({ source_key: '  ' })],
      [rule({ target_value: '' })],
      [rule({ mapping_version: undefined })],
      [rule(), rule({ effective_from: '2026-13-45' })],
      [rule({ effective_from: '01/04/2026' })],
    ];
    const expectedIdx = [1, 2, 0, 0, 1, 0];
    for (let i = 0; i < cases.length; i += 1) {
      const { res, body } = await post(t.base, '/mappings', 'operator', cases[i]);
      assert.equal(res.status, 400, `case ${i}`);
      assert.equal(body.error, 'BAD_REQUEST');
      assert.match(body.message, new RegExp(`row ${expectedIdx[i]}\\b`), `case ${i}: ${body.message}`);
    }
    assert.equal((await t.store.find('mapping_rules', {})).length, 0);
    const empty = await post(t.base, '/mappings', 'operator', []);
    assert.equal(empty.res.status, 400);
  } finally {
    await t.close();
  }
});

test('POST /mappings: more than 5000 rows is rejected with 413', async () => {
  const t = await startApp();
  try {
    const rows = Array.from({ length: 5001 }, (_, i) => rule({ source_key: `K${i}` }));
    const { res, body } = await post(t.base, '/mappings', 'operator', rows);
    assert.equal(res.status, 413);
    assert.equal(body.error, 'PAYLOAD_TOO_LARGE');
    assert.equal((await t.store.find('mapping_rules', {})).length, 0);
  } finally {
    await t.close();
  }
});

test('POST /mappings: unchanged APPROVED rows are skipped; a changed target demotes to DRAFT', async () => {
  const t = await startApp();
  try {
    const first = await post(t.base, '/mappings', 'operator', [rule(), rule({ source_key: 'PURCH', target_value: '2001' })]);
    assert.equal(first.body.upserted, 2);
    const ids = first.body.mappings.map((m) => m.id);
    const approved = await post(t.base, '/mappings/approve', 'approver', { ids });
    assert.equal(approved.body.approved, 2);

    // Re-upload: SALES identical (skipped), PURCH target changed (demoted), NEW added.
    const again = await post(t.base, '/mappings', 'operator', [
      rule(),
      rule({ source_key: 'PURCH', target_value: '2002' }),
      rule({ source_key: 'NEW', target_value: '3001' }),
    ]);
    assert.equal(again.res.status, 200);
    assert.equal(again.body.unchanged, 1);
    assert.equal(again.body.upserted, 2);

    const sales = await t.store.findOne('mapping_rules', { uk: 'LEDGER_ACCOUNT|SALES|map_v1' });
    assert.equal(sales.status, 'APPROVED');
    assert.equal(sales.approved_by, 'u_approver');
    const purch = await t.store.findOne('mapping_rules', { uk: 'LEDGER_ACCOUNT|PURCH|map_v1' });
    assert.equal(purch.status, 'DRAFT');
    assert.equal(purch.target_value, '2002');
    assert.equal(purch.approved_by, null);

    // Identical re-upload of an all-approved set changes nothing at all.
    const onlySales = await post(t.base, '/mappings', 'operator', [rule()]);
    assert.equal(onlySales.body.unchanged, 1);
    assert.equal(onlySales.body.upserted, 0);
    assert.deepEqual(onlySales.body.mappings, []);
  } finally {
    await t.close();
  }
});

test('GET /mappings: parsed target_meta, sorted, and filters honoured; viewer may read', async () => {
  const t = await startApp();
  try {
    await post(t.base, '/mappings', 'operator', [
      rule({ rule_type: 'PARTY', source_key: 'ZED', target_value: 'P9', target_meta: { contact_id: 'C9' } }),
      rule({ source_key: 'SALES' }),
      rule({ source_key: 'ADMIN', target_value: '1002', mapping_version: 'map_v2' }),
    ]);
    const all = await get(t.base, '/mappings', 'viewer');
    assert.equal(all.res.status, 200);
    assert.deepEqual(
      all.body.mappings.map((m) => `${m.rule_type}/${m.source_key}`),
      ['LEDGER_ACCOUNT/ADMIN', 'LEDGER_ACCOUNT/SALES', 'PARTY/ZED']
    );
    const party = all.body.mappings.find((m) => m.rule_type === 'PARTY');
    assert.deepEqual(party.target_meta, { contact_id: 'C9' });
    assert.equal(all.body.mappings.find((m) => m.source_key === 'SALES').target_meta, null);

    // Unparsable stored meta degrades to null.
    const row = await t.store.findOne('mapping_rules', { uk: 'LEDGER_ACCOUNT|SALES|map_v1' });
    await t.store.update('mapping_rules', row.id, { target_meta: '{not json' });
    const again = await get(t.base, '/mappings?source_key=SALES');
    assert.equal(again.body.mappings.length, 1);
    assert.equal(again.body.mappings[0].target_meta, null);

    assert.equal((await get(t.base, '/mappings?rule_type=PARTY')).body.mappings.length, 1);
    assert.equal((await get(t.base, '/mappings?mapping_version=map_v2')).body.mappings.length, 1);
    assert.equal((await get(t.base, '/mappings?status=APPROVED')).body.mappings.length, 0);
    assert.equal((await get(t.base, '/mappings?status=DRAFT&rule_type=LEDGER_ACCOUNT')).body.mappings.length, 2);

    const unauth = await fetch(`${t.base}/api/mappings`);
    assert.equal(unauth.status, 401);
  } finally {
    await t.close();
  }
});

test('GET /mappings/summary: counts per rule_type and status', async () => {
  const t = await startApp();
  try {
    const up = await post(t.base, '/mappings', 'operator', [
      rule({ source_key: 'A' }),
      rule({ source_key: 'B' }),
      rule({ rule_type: 'TAX', source_key: 'GST18', target_value: 'T1' }),
    ]);
    await post(t.base, '/mappings/approve', 'admin', { ids: [up.body.mappings[0].id] });
    const { res, body } = await get(t.base, '/mappings/summary');
    assert.equal(res.status, 200);
    assert.deepEqual(body.summary, [
      { rule_type: 'LEDGER_ACCOUNT', status: 'APPROVED', count: 1 },
      { rule_type: 'LEDGER_ACCOUNT', status: 'DRAFT', count: 1 },
      { rule_type: 'TAX', status: 'DRAFT', count: 1 },
    ]);
  } finally {
    await t.close();
  }
});

test('POST /mappings/approve: by ids as approver; operator forbidden; already-APPROVED not re-approved', async () => {
  const t = await startApp();
  try {
    const up = await post(t.base, '/mappings', 'operator', [rule({ source_key: 'A' }), rule({ source_key: 'B' })]);
    const [a, b] = up.body.mappings.map((m) => m.id);

    const denied = await post(t.base, '/mappings/approve', 'operator', { ids: [a] });
    assert.equal(denied.res.status, 403);

    const first = await post(t.base, '/mappings/approve', 'approver', { ids: [a, 99999] });
    assert.equal(first.res.status, 200);
    assert.deepEqual(first.body, { approved: 1, ids: [a], reapplyScheduled: true });
    const rowA = await t.store.get('mapping_rules', a);
    assert.equal(rowA.status, 'APPROVED');
    assert.equal(rowA.approved_by, 'u_approver');
    assert.ok(rowA.approved_at);
    const approvedAt = rowA.approved_at;

    // a is already APPROVED, so only b is approved now and a is untouched.
    const second = await post(t.base, '/mappings/approve', 'admin', { ids: [a, b] });
    assert.deepEqual(second.body, { approved: 1, ids: [b], reapplyScheduled: true });
    const rowA2 = await t.store.get('mapping_rules', a);
    assert.equal(rowA2.approved_by, 'u_approver');
    assert.equal(rowA2.approved_at, approvedAt);

    const audits = await t.store.find('audit_events', { action: 'MAPPING.APPROVE_BULK' });
    assert.equal(audits.length, 2);
  } finally {
    await t.close();
  }
});

test('POST /mappings/approve: by filter as admin, DRAFT rows only', async () => {
  const t = await startApp();
  try {
    await post(t.base, '/mappings', 'operator', [
      rule({ source_key: 'A' }),
      rule({ source_key: 'B', mapping_version: 'map_v2' }),
      rule({ rule_type: 'TAX', source_key: 'GST', target_value: 'T1' }),
    ]);
    const byType = await post(t.base, '/mappings/approve', 'admin', { filter: { rule_type: 'LEDGER_ACCOUNT', mapping_version: 'map_v1' } });
    assert.equal(byType.res.status, 200);
    assert.equal(byType.body.approved, 1);

    const retiredRow = await t.store.findOne('mapping_rules', { uk: 'TAX|GST|map_v1' });
    await t.store.update('mapping_rules', retiredRow.id, { status: 'RETIRED' });

    const rest = await post(t.base, '/mappings/approve', 'admin', { filter: {} });
    assert.equal(rest.body.approved, 1); // only B; A is APPROVED, TAX is RETIRED
    const statuses = Object.fromEntries((await t.store.find('mapping_rules', {})).map((r) => [r.source_key, r.status]));
    assert.deepEqual(statuses, { A: 'APPROVED', B: 'APPROVED', GST: 'RETIRED' });

    const none = await post(t.base, '/mappings/approve', 'admin', { filter: { source_key: 'NOPE' } });
    assert.deepEqual(none.body, { approved: 0, ids: [], reapplyScheduled: false });
  } finally {
    await t.close();
  }
});

test('POST /mappings/approve: exactly one of ids/filter is required', async () => {
  const t = await startApp();
  try {
    assert.equal((await post(t.base, '/mappings/approve', 'admin', {})).res.status, 400);
    assert.equal((await post(t.base, '/mappings/approve', 'admin', { ids: [1], filter: {} })).res.status, 400);
    assert.equal((await post(t.base, '/mappings/approve', 'admin', { ids: [] })).res.status, 400);
    assert.equal((await post(t.base, '/mappings/approve', 'admin', { ids: ['x'] })).res.status, 400);
  } finally {
    await t.close();
  }
});

test('POST /mappings/:id/retire: DRAFT and APPROVED retire once; second retire is 409; 404 unknown; operator 403', async () => {
  const t = await startApp();
  try {
    const up = await post(t.base, '/mappings', 'operator', [rule({ source_key: 'A' }), rule({ source_key: 'B' })]);
    const [a, b] = up.body.mappings.map((m) => m.id);
    await post(t.base, '/mappings/approve', 'approver', { ids: [b] });

    assert.equal((await post(t.base, `/mappings/${a}/retire`, 'operator', {})).res.status, 403);

    const r1 = await post(t.base, `/mappings/${a}/retire`, 'approver', { reason: 'obsolete' });
    assert.equal(r1.res.status, 200);
    assert.equal(r1.body.status, 'RETIRED');
    const r2 = await post(t.base, `/mappings/${b}/retire`, 'admin', {});
    assert.equal(r2.res.status, 200);
    assert.equal(r2.body.status, 'RETIRED');

    const again = await post(t.base, `/mappings/${a}/retire`, 'approver', {});
    assert.equal(again.res.status, 409);

    assert.equal((await post(t.base, '/mappings/424242/retire', 'approver', {})).res.status, 404);

    const audits = await t.store.find('audit_events', { action: 'MAPPING.RETIRE' });
    assert.equal(audits.length, 2);
    assert.ok(audits.some((e) => e.reason === 'obsolete'));
  } finally {
    await t.close();
  }
});

/** Poll GET /runs/retransform-jobs/:jobId until the job leaves QUEUED/RUNNING. */
async function waitJob(base, jobId, role = 'operator') {
  for (let i = 0; i < 100; i += 1) {
    const { res, body } = await get(base, `/runs/retransform-jobs/${jobId}`, role);
    assert.equal(res.status, 200);
    if (body.stage === 'DONE' || body.stage === 'FAILED') return body;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('job did not finish');
}

test('POST /runs/:id/retransform: 202 + job; the job carries the transform result', async () => {
  const t = await startApp();
  try {
    const { res, body } = await post(t.base, '/runs/run-in/retransform', 'operator', {});
    assert.equal(res.status, 202);
    assert.equal(body.runId, 'run-in');
    assert.ok(body.jobId);
    const job = await waitJob(t.base, body.jobId);
    assert.equal(job.stage, 'DONE');
    assert.equal(job.trigger, 'manual');
    assert.equal(job.requestedBy, 'u_operator');
    assert.deepEqual(job.result, { runId: 'run-in', status: 'TRANSFORMED', reset: 1, stillBlocked: 0 });
    // the run's latest job is readable for a page that reloads while it runs
    const latest = await get(t.base, '/runs/run-in/retransform-job', 'viewer');
    assert.equal(latest.body.job.jobId, body.jobId);
    assert.equal((await post(t.base, '/runs/run-in/retransform', 'admin', {})).res.status, 202);
  } finally {
    await t.close();
  }
});

test('POST /runs/:id/retransform: a second request while a job runs joins it', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const t = await startApp({
    transform: { retransformRun: async (ctx, { runId }) => { await gate; return { runId, reset: 0, stillBlocked: 0 }; } },
  });
  try {
    const first = await post(t.base, '/runs/run-in/retransform', 'operator', {});
    const second = await post(t.base, '/runs/run-in/retransform', 'operator', {});
    assert.equal(second.res.status, 202);
    assert.equal(second.body.jobId, first.body.jobId);
    assert.equal(second.body.joined, true);
    release();
    assert.equal((await waitJob(t.base, first.body.jobId)).stage, 'DONE');
  } finally {
    release();
    await t.close();
  }
});

test('POST /runs/:id/retransform: role, scope, missing run', async () => {
  const t = await startApp();
  try {
    assert.equal((await post(t.base, '/runs/run-in/retransform', 'viewer', {})).res.status, 403);
    assert.equal((await post(t.base, '/runs/run-in/retransform', 'approver', {})).res.status, 403);
    // operator is scoped to PILOT01 only
    const out = await post(t.base, '/runs/run-out/retransform', 'operator', {});
    assert.equal(out.res.status, 403);
    // admin ('*') may cross branches; the operator may not read that branch's job
    const cross = await post(t.base, '/runs/run-out/retransform', 'admin', {});
    assert.equal(cross.res.status, 202);
    assert.equal((await get(t.base, `/runs/retransform-jobs/${cross.body.jobId}`, 'operator')).res.status, 403);
    assert.equal((await post(t.base, '/runs/nope/retransform', 'operator', {})).res.status, 404);
    assert.equal((await get(t.base, '/runs/retransform-jobs/nope', 'operator')).res.status, 404);
  } finally {
    await t.close();
  }
});

test('POST /runs/:id/retransform: precondition errors are refused before any job starts', async () => {
  for (const [code, status] of [
    ['BATCH_IN_PROGRESS', 409],
    ['INVALID_RUN_STATE', 409],
    ['NOT_FOUND', 404],
  ]) {
    const t = await startApp({ transform: throwingTransform(code) });
    try {
      const { res, body } = await post(t.base, '/runs/run-in/retransform', 'operator', {});
      assert.equal(res.status, status, code);
      assert.equal(body.error, code);
      assert.match(body.message, new RegExp(code));
      assert.equal((await get(t.base, '/runs/run-in/retransform-job', 'operator')).body.job, null);
    } finally {
      await t.close();
    }
  }
});

test('POST /runs/:id/retransform: an unexpected precondition error is a 500; a failing job is FAILED', async () => {
  const boom = async () => { throw new Error('boom'); };
  let t = await startApp({ transform: { checkRetransformable: boom, retransformRun: boom } });
  try {
    assert.equal((await post(t.base, '/runs/run-in/retransform', 'operator', {})).res.status, 500);
  } finally {
    await t.close();
  }
  t = await startApp({ transform: { retransformRun: boom } });
  try {
    const { res, body } = await post(t.base, '/runs/run-in/retransform', 'operator', {});
    assert.equal(res.status, 202);
    const job = await waitJob(t.base, body.jobId);
    assert.equal(job.stage, 'FAILED');
    assert.equal(job.error.message, 'boom');
  } finally {
    await t.close();
  }
});

test('approving mapping rules re-applies the mapping to runs with vouchers blocked for a missing rule', async () => {
  const calls = [];
  const t = await startApp({
    transform: { retransformRun: async (ctx, { runId }) => { calls.push({ runId, actor: ctx.actor }); return { runId, reset: 1, stillBlocked: 0 }; } },
  });
  try {
    const now = nowIso();
    // run-in: TRANSFORMED with a voucher blocked at classification -> re-applied
    await t.store.update('extraction_runs', 'run-in', { status: 'TRANSFORMED' });
    // run-ok: TRANSFORMED, nothing blocked -> left alone
    await seedRun(t.store, 'run-ok', 'PILOT01');
    await t.store.update('extraction_runs', 'run-ok', { status: 'TRANSFORMED' });
    // run-staged: blocked voucher but not in a re-transformable state -> left alone
    await seedRun(t.store, 'run-staged', 'PILOT01');
    // run-out: other branch, outside the approver's scope -> left alone
    await t.store.update('extraction_runs', 'run-out', { status: 'TRANSFORMED' });
    let n = 0;
    for (const [runId, branch, reason] of [['run-in', 'PILOT01', 'UNMAPPED_MODULE'], ['run-staged', 'PILOT01', 'UNMAPPED_ENTITY'], ['run-out', 'PILOT02', 'UNMAPPED_ENTITY']]) {
      n += 1;
      const file = await t.store.insert('source_files', {
        run_id: runId, file_name: 'transactions.csv', file_role: 'TRANSACTIONS', sha256: `fsha-${n}`, size_bytes: 1,
        encoding: 'utf-8', delimiter: ',', status: 'VALIDATED', created_at: now, updated_at: now,
      });
      await t.store.insert('vouchers', {
        source_query_id: 'Q', source_query_version: 'v1', extraction_run_id: runId, source_file_id: file.id, source_file_hash: 'h',
        source_record_id: `V${n}`, branch_code: branch, financial_year: '2026-27', period: '2026-04', transaction_date: '2026-04-05',
        source_transaction_type: 'JOURNAL', source_transaction_hash: `hash-${n}`, debit_total: '1.00', credit_total: '1.00',
        line_count: 2, is_balanced: 1, disposition: 'BLOCKED', disposition_reason: reason, created_at: now, updated_at: now,
      });
    }
    const up = await post(t.base, '/mappings', 'operator', { rows: [rule()] });
    const approved = await post(t.base, '/mappings/approve', 'approver', { ids: [up.body.mappings[0].id] });
    assert.equal(approved.res.status, 200);
    assert.equal(approved.body.reapplyScheduled, true);
    await t.app.locals.retransformJobs.settled();
    const job = t.app.locals.retransformJobs.latestForRun('run-in');
    assert.ok(job, 'run-in was re-applied');
    assert.equal(job.trigger, 'mapping_approval');
    await waitJob(t.base, job.jobId, 'approver');
    assert.deepEqual(calls, [{ runId: 'run-in', actor: 'u_approver' }]);
    for (const other of ['run-ok', 'run-staged', 'run-out']) assert.equal(t.app.locals.retransformJobs.latestForRun(other), null, other);
    const audits = await t.store.find('audit_events', { action: 'TRANSFORM.AUTO_REAPPLY' });
    assert.equal(audits.length, 1);
  } finally {
    await t.close();
  }
});

test('POST /runs/:id/retransform: 501 when the transform dep is not wired', async () => {
  const t = await startApp({ withTransform: false });
  try {
    const { res, body } = await post(t.base, '/runs/run-in/retransform', 'operator', {});
    assert.equal(res.status, 501);
    assert.equal(body.error, 'NOT_IMPLEMENTED');
  } finally {
    await t.close();
  }
});
