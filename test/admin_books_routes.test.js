import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import http from 'node:http';
import express from 'express';
import { openStore } from '../src/adapters/store/memory.js';
import { createAudit } from '../src/core/audit.js';
import { createAuth } from '../src/server/auth.js';
import { createBooksConnection } from '../src/books/connection.js';
import { createAdminBooksRouter } from '../src/server/routes/admin_books.js';
import { clearTokenCache } from '../src/books/oauth.js';

const VALID_SECRET_KEY = Buffer.alloc(32, 3).toString('base64');
const fakeRefreshToken = 'route-test-refresh-token-must-never-leak';

function sha(token) {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

const TOKENS = { admin: 'tok-admin', operator: 'tok-operator', bot: 'tok-bot' };

function users() {
  return [
    { id: 'u_admin', role: 'admin', branches: ['*'], token_sha256: sha(TOKENS.admin) },
    { id: 'u_operator', role: 'operator', branches: ['*'], token_sha256: sha(TOKENS.operator) },
    { id: 'bot:agent1', principal_type: 'bot', role: 'operator', branches: ['*'], token_sha256: sha(TOKENS.bot) },
  ];
}

async function buildApp(overrides = {}) {
  const store = await openStore();
  const audit = createAudit(store);
  const auth = createAuth({ users: users(), audit });
  const calls = [];
  const fetchImpl = overrides.fetchImpl ?? (async () => {
    throw new Error('unexpected fetch call in this test');
  });
  const countingFetch = async (...args) => {
    calls.push(args[0]);
    return fetchImpl(...args);
  };
  const config = {
    driver: 'mock',
    apiBase: 'https://www.zohoapis.in/books/v3',
    accountsBase: 'https://accounts.zoho.in',
    clientId: 'client-1',
    clientSecret: 'client-secret-1',
    organizationId: 'org_pilot_01',
    orgAllowlist: [],
    postingEnabled: false,
    postingAuthorizationRef: '',
    region: 'in',
    redirectUri: 'https://console.example.invalid/api/admin/books/callback',
    secretKey: VALID_SECRET_KEY,
    readAuthorized: false,
    requestTimeoutMs: 5000,
    ...overrides.config,
  };
  const connection = createBooksConnection({ store, audit, config, fetchImpl: countingFetch });

  const app = express();
  app.use(express.json());
  app.use('/api', createAdminBooksRouter({ connection, auth }));
  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    res.status(500).json({ error: 'INTERNAL', message: err.message });
  });

  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = server.address().port;
  return { store, audit, connection, config, calls, server, port, close: () => new Promise((r) => server.close(r)) };
}

function request(port, method, path, { token, body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : null;
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
          ...headers,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let json = null;
          try {
            json = data ? JSON.parse(data) : null;
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode, headers: res.headers, body: json, raw: data });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

test.beforeEach(() => {
  clearTokenCache();
});

test('GET /api/admin/books/connection: 401 without a token', async () => {
  const ctx = await buildApp();
  try {
    const res = await request(ctx.port, 'GET', '/api/admin/books/connection');
    assert.equal(res.status, 401);
  } finally {
    await ctx.close();
  }
});

test('GET /api/admin/books/connection: 403 for a non-admin human (operator)', async () => {
  const ctx = await buildApp();
  try {
    const res = await request(ctx.port, 'GET', '/api/admin/books/connection', { token: TOKENS.operator });
    assert.equal(res.status, 403);
  } finally {
    await ctx.close();
  }
});

test('every admin-books route rejects a bot principal with 403, even one holding an operator role', async () => {
  const ctx = await buildApp();
  try {
    const getRes = await request(ctx.port, 'GET', '/api/admin/books/connection', { token: TOKENS.bot });
    assert.equal(getRes.status, 403);
    assert.equal(getRes.body.error, 'FORBIDDEN');

    const connectRes = await request(ctx.port, 'POST', '/api/admin/books/connect', { token: TOKENS.bot, body: {} });
    assert.equal(connectRes.status, 403);

    const testRes = await request(ctx.port, 'POST', '/api/admin/books/test', { token: TOKENS.bot, body: {} });
    assert.equal(testRes.status, 403);

    const syncRes = await request(ctx.port, 'POST', '/api/admin/books/sync-locations', { token: TOKENS.bot, body: {} });
    assert.equal(syncRes.status, 403);

    const mapRes = await request(ctx.port, 'PUT', '/api/admin/books/location-mapping', { token: TOKENS.bot, body: { mappings: [] } });
    assert.equal(mapRes.status, 403);

    const discRes = await request(ctx.port, 'POST', '/api/admin/books/disconnect', { token: TOKENS.bot, body: {} });
    assert.equal(discRes.status, 403);
  } finally {
    await ctx.close();
  }
});

test('GET /api/admin/books/connection: 200 for admin, includes status + controls, and productionPostingEnabled is false', async () => {
  const ctx = await buildApp();
  try {
    const res = await request(ctx.port, 'GET', '/api/admin/books/connection', { token: TOKENS.admin });
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'NOT_CONNECTED');
    assert.equal(res.body.postingEnabled, false);
    assert.equal(res.body.controls.productionPostingEnabled.ok, false);
    assert.equal(res.body.controls.batchFinanciallyApproved, null);
  } finally {
    await ctx.close();
  }
});

test('POST /api/admin/books/connect: 409 BOOKS_NOT_CONFIGURED when BOOKS_CLIENT_ID is empty', async () => {
  const ctx = await buildApp({ config: { clientId: '' } });
  try {
    const res = await request(ctx.port, 'POST', '/api/admin/books/connect', { token: TOKENS.admin, body: {} });
    assert.equal(res.status, 409);
    assert.equal(res.body.error, 'BOOKS_NOT_CONFIGURED');
  } finally {
    await ctx.close();
  }
});

test('POST /api/admin/books/connect: 200 with an authorizeUrl and an X-Correlation-Id response header', async () => {
  const ctx = await buildApp();
  try {
    const res = await request(ctx.port, 'POST', '/api/admin/books/connect', { token: TOKENS.admin, body: { region: 'in' } });
    assert.equal(res.status, 200);
    assert.ok(res.body.authorizeUrl.startsWith('https://accounts.zoho.in/oauth/v2/auth'));
    assert.ok(res.headers['x-correlation-id']);
  } finally {
    await ctx.close();
  }
});

test('GET /api/admin/books/callback: success redirects to #/admin/connections/books?connected=1 and never echoes code/state', async () => {
  const ctx = await buildApp({
    fetchImpl: async (url) => {
      const u = String(url);
      if (u.includes('/oauth/v2/token')) {
        return { ok: true, status: 200, json: async () => ({ access_token: 'at', refresh_token: fakeRefreshToken, expires_in: 3600 }) };
      }
      throw new Error(`unexpected url ${u}`);
    },
  });
  try {
    const connectRes = await request(ctx.port, 'POST', '/api/admin/books/connect', { token: TOKENS.admin, body: {} });
    const state = new URL(connectRes.body.authorizeUrl).searchParams.get('state');

    const cbRes = await request(ctx.port, 'GET', `/api/admin/books/callback?code=super-secret-code&state=${state}`);
    assert.equal(cbRes.status, 302);
    assert.equal(cbRes.headers.location, '/#/admin/connections/books?connected=1');
    assert.ok(!cbRes.headers.location.includes('super-secret-code'));
    assert.ok(!cbRes.headers.location.includes(state));
  } finally {
    await ctx.close();
  }
});

test('GET /api/admin/books/callback: invalid state redirects with a redacted error code, never the raw state/code', async () => {
  const ctx = await buildApp();
  try {
    const res = await request(ctx.port, 'GET', '/api/admin/books/callback?code=super-secret-code&state=bogus-state-value');
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, '/#/admin/connections/books?error=INVALID_STATE');
    assert.ok(!res.headers.location.includes('super-secret-code'));
    assert.ok(!res.headers.location.includes('bogus-state-value'));
  } finally {
    await ctx.close();
  }
});

test('POST /api/admin/books/test: 409 NOT_CONNECTED before any fetch when not connected yet', async () => {
  const ctx = await buildApp();
  try {
    const res = await request(ctx.port, 'POST', '/api/admin/books/test', { token: TOKENS.admin, body: {} });
    assert.equal(res.status, 409);
    assert.equal(res.body.error, 'NOT_CONNECTED');
    assert.equal(ctx.calls.length, 0);
  } finally {
    await ctx.close();
  }
});

test('POST /api/admin/books/sync-locations (mock driver): 200, seeds synthetic locations visible via GET /locations', async () => {
  const ctx = await buildApp();
  try {
    const syncRes = await request(ctx.port, 'POST', '/api/admin/books/sync-locations', { token: TOKENS.admin, body: { driver: 'mock' } });
    assert.equal(syncRes.status, 200);
    assert.ok(syncRes.body.count >= 1);

    const listRes = await request(ctx.port, 'GET', '/api/admin/books/locations', { token: TOKENS.admin });
    assert.equal(listRes.status, 200);
    assert.ok(listRes.body.locations.length >= 1);
    assert.ok(listRes.body.locations.every((l) => l.is_synthetic === 1));
  } finally {
    await ctx.close();
  }
});

test('PUT /api/admin/books/location-mapping: maps a branch, then 409s a second branch mapping to the same location', async () => {
  const ctx = await buildApp();
  try {
    await request(ctx.port, 'POST', '/api/admin/books/sync-locations', { token: TOKENS.admin, body: { driver: 'mock' } });
    const now = new Date().toISOString();
    await ctx.store.insert('branches', { branch_code: 'PILOT01', branch_name: 'Pilot', zoho_location_id: null, status: 'ACTIVE', created_at: now, updated_at: now });
    await ctx.store.insert('branches', { branch_code: 'PILOT02', branch_name: 'Pilot 2', zoho_location_id: null, status: 'ACTIVE', created_at: now, updated_at: now });

    const mapRes = await request(ctx.port, 'PUT', '/api/admin/books/location-mapping', {
      token: TOKENS.admin,
      body: { mappings: [{ branch_code: 'PILOT01', location_id: 'SYN-LOC-001' }] },
    });
    assert.equal(mapRes.status, 200);
    assert.equal(mapRes.body.mappings[0].branch_code, 'PILOT01');

    const conflictRes = await request(ctx.port, 'PUT', '/api/admin/books/location-mapping', {
      token: TOKENS.admin,
      body: { mappings: [{ branch_code: 'PILOT02', location_id: 'SYN-LOC-001' }] },
    });
    assert.equal(conflictRes.status, 409);
    assert.equal(conflictRes.body.error, 'LOCATION_ALREADY_MAPPED');
  } finally {
    await ctx.close();
  }
});

test('POST /api/admin/books/disconnect: 200, clears the connection', async () => {
  const ctx = await buildApp();
  try {
    const res = await request(ctx.port, 'POST', '/api/admin/books/disconnect', { token: TOKENS.admin, body: { reason: 'pilot done' } });
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'DISCONNECTED');
  } finally {
    await ctx.close();
  }
});

test('secrets never appear in any HTTP response across the full connect -> callback -> status flow', async () => {
  const ctx = await buildApp({
    config: { readAuthorized: true },
    fetchImpl: async (url) => {
      const u = String(url);
      if (u.includes('/oauth/v2/token')) {
        return { ok: true, status: 200, json: async () => ({ access_token: 'at', refresh_token: fakeRefreshToken, expires_in: 3600 }) };
      }
      if (u.includes('/organizations/')) {
        return { ok: true, status: 200, json: async () => ({ code: 0, message: 'success', organization: { organization_id: 'org_pilot_01', name: 'Eco Green Pilot' } }) };
      }
      throw new Error(`unexpected url ${u}`);
    },
  });
  try {
    const connectRes = await request(ctx.port, 'POST', '/api/admin/books/connect', { token: TOKENS.admin, body: {} });
    const state = new URL(connectRes.body.authorizeUrl).searchParams.get('state');
    const cbRes = await request(ctx.port, 'GET', `/api/admin/books/callback?code=abc&state=${state}`);
    assert.equal(cbRes.status, 302);
    const statusRes = await request(ctx.port, 'GET', '/api/admin/books/connection', { token: TOKENS.admin });
    assert.equal(statusRes.status, 200);
    assert.equal(statusRes.body.status, 'CONNECTED');
    assert.equal(statusRes.body.org.id, 'org_pilot_01');

    const auditRows = await ctx.store.find('audit_events', {});
    const haystacks = [connectRes.raw, cbRes.raw, statusRes.raw, JSON.stringify(auditRows)];
    for (const hay of haystacks) {
      assert.ok(!hay.includes(fakeRefreshToken), 'raw refresh token leaked into an HTTP response or audit trail');
      assert.ok(!hay.includes('client-secret-1'), 'client secret leaked');
    }
  } finally {
    await ctx.close();
  }
});
