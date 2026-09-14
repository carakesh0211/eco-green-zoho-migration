import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { openStore } from '../src/adapters/store/memory.js';
import { createAudit } from '../src/core/audit.js';
import { createApp } from '../src/server/app.js';

function sha(token) {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

const TOKENS = {
  viewer1: 'tok-viewer-pilot01',
  operator1: 'tok-operator-pilot01',
  admin: 'tok-admin-star',
};

function baseUsers() {
  return [
    { id: 'u_viewer1', role: 'viewer', branches: ['PILOT01'], token_sha256: sha(TOKENS.viewer1) },
    { id: 'u_operator1', role: 'operator', branches: ['PILOT01'], token_sha256: sha(TOKENS.operator1) },
    { id: 'u_admin', role: 'admin', branches: ['*'], token_sha256: sha(TOKENS.admin) },
  ];
}

async function startApp(users = baseUsers()) {
  const store = await openStore();
  const audit = createAudit(store);
  const app = createApp({ store, audit, users, deps: {} });
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

test('server auth: /api/health needs no token', async () => {
  const { base, close } = await startApp();
  try {
    const res = await fetch(`${base}/api/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.postingEnabled, false);
  } finally {
    await close();
  }
});

test('server auth: missing bearer token -> 401 + DENIED audit event', async () => {
  const { base, store, close } = await startApp();
  try {
    const res = await fetch(`${base}/api/runs`);
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error, 'UNAUTHORIZED');

    const denied = await store.find('audit_events', { authorization_decision: 'DENIED' });
    assert.ok(denied.length >= 1);
    assert.match(denied[0].reason, /MISSING_BEARER_TOKEN/);
  } finally {
    await close();
  }
});

test('server auth: invalid bearer token -> 401 + DENIED audit with hashed (never raw) actor', async () => {
  const { base, store, close } = await startApp();
  try {
    const res = await fetch(`${base}/api/runs`, { headers: { Authorization: 'Bearer not-a-real-token' } });
    assert.equal(res.status, 401);

    const denied = await store.find('audit_events', { authorization_decision: 'DENIED' });
    const last = denied.at(-1);
    assert.match(last.reason, /INVALID_TOKEN/);
    assert.match(last.actor, /^token:[0-9a-f]{12}$/);
    assert.doesNotMatch(JSON.stringify(last), /not-a-real-token/);
  } finally {
    await close();
  }
});

test('server auth: wrong role -> 403 (viewer cannot pause a batch)', async () => {
  const { base, close } = await startApp();
  try {
    const res = await fetch(`${base}/api/batches/does-not-matter/pause`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKENS.viewer1}`, 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.error, 'FORBIDDEN');
  } finally {
    await close();
  }
});

test('server auth: branch scope 403 for a PILOT02 request by a PILOT01-scoped user', async () => {
  const { base, store, close } = await startApp();
  try {
    const res = await fetch(`${base}/api/runs?branch=PILOT02`, {
      headers: { Authorization: `Bearer ${TOKENS.operator1}` },
    });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.error, 'FORBIDDEN');

    const denied = await store.find('audit_events', { authorization_decision: 'DENIED' });
    assert.ok(denied.some((r) => /BRANCH_SCOPE:PILOT02/.test(r.reason ?? '')));
  } finally {
    await close();
  }
});

test("server auth: '*' branches passes scope checks", async () => {
  const { base, close } = await startApp();
  try {
    const res = await fetch(`${base}/api/runs?branch=PILOT02`, {
      headers: { Authorization: `Bearer ${TOKENS.admin}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.runs, []);
  } finally {
    await close();
  }
});

test('server auth: same PILOT01 branch passes for a PILOT01-scoped user', async () => {
  const { base, close } = await startApp();
  try {
    const res = await fetch(`${base}/api/runs?branch=PILOT01`, {
      headers: { Authorization: `Bearer ${TOKENS.operator1}` },
    });
    assert.equal(res.status, 200);
  } finally {
    await close();
  }
});
