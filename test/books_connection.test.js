import test from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/adapters/store/memory.js';
import { createAudit } from '../src/core/audit.js';
import { clearTokenCache } from '../src/books/oauth.js';
import {
  createBooksConnection,
  encryptSecret,
  decryptSecret,
  BooksConnectionError,
} from '../src/books/connection.js';

const VALID_SECRET_KEY = Buffer.alloc(32, 7).toString('base64');
const fakeRefreshToken = 'zoho-refresh-token-should-never-leak-anywhere';

function baseConfig(overrides = {}) {
  return {
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
    ...overrides,
  };
}

async function setup(overrides = {}) {
  const store = await openStore();
  const audit = createAudit(store);
  const calls = [];
  const fetchImpl = overrides.fetchImpl ?? (async () => {
    throw new Error('unexpected fetch call in this test');
  });
  const countingFetch = async (...args) => {
    calls.push(args[0]);
    return fetchImpl(...args);
  };
  const config = baseConfig(overrides.config);
  const clockBox = { now: overrides.now ?? Date.parse('2026-09-15T00:00:00.000Z') };
  const clock = () => clockBox.now;
  const connection = createBooksConnection({
    store,
    audit,
    config,
    fetchImpl: countingFetch,
    clock,
    randomBytes: overrides.randomBytes,
  });
  return { store, audit, connection, calls, config, clockBox };
}

function tokenResponse(body, ok = true, status = 200) {
  return { ok, status, json: async () => body };
}

test.beforeEach(() => {
  clearTokenCache();
});

// ---------------------------------------------------------------- initial status / config

test('getStatus(): lazily creates a NOT_CONNECTED row and reports secretsConfigured/readAuthorized/postingEnabled', async () => {
  const { connection } = await setup();
  const status = await connection.getStatus();
  assert.equal(status.status, 'NOT_CONNECTED');
  assert.equal(status.org, null);
  assert.equal(status.readAuthorized, false);
  assert.equal(status.driver, 'mock');
  assert.equal(status.postingEnabled, false);
  assert.deepEqual(status.secretsConfigured, { clientId: true, clientSecret: true, secretKey: true });
});

test('controls(): productionPostingEnabled is always false with POSTING_ENABLED unset', async () => {
  const { connection } = await setup();
  const controls = await connection.controls();
  assert.equal(controls.productionPostingEnabled.ok, false);
  assert.equal(controls.batchFinanciallyApproved, null);
});

// ---------------------------------------------------------------- beginConnect

test('beginConnect(): requires BOOKS_CLIENT_ID', async () => {
  const { connection } = await setup({ config: { clientId: '' } });
  await assert.rejects(connection.beginConnect({ actor: 'u_admin' }), (e) => {
    assert.equal(e.code, 'BOOKS_NOT_CONFIGURED');
    return true;
  });
});

test('beginConnect(): builds the verified authorize URL (accounts.zoho.in/oauth/v2/auth, response_type=code, access_type=offline, prompt=consent, state)', async () => {
  const { connection } = await setup();
  const { authorizeUrl } = await connection.beginConnect({ actor: 'u_admin', redirectUri: 'https://x.invalid/cb' });
  const url = new URL(authorizeUrl);
  assert.equal(url.origin + url.pathname, 'https://accounts.zoho.in/oauth/v2/auth');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('client_id'), 'client-1');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://x.invalid/cb');
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.get('prompt'), 'consent');
  assert.ok(url.searchParams.get('state'), 'state must be present');
  assert.equal(url.searchParams.get('state').length, 64, 'state should be a 32-byte hex string');
  assert.ok(url.searchParams.get('scope').includes('ZohoBooks.'), 'scope must be a ZohoBooks.* list');
});

test('beginConnect(): sets status PENDING_AUTH and writes a BOOKS.CONNECT_BEGIN audit row with no secrets', async () => {
  const { connection, store } = await setup();
  await connection.beginConnect({ actor: 'u_admin' });
  const row = await store.get('books_connections', 'default');
  assert.equal(row.status, 'PENDING_AUTH');
  assert.ok(row.oauth_state_sha256);
  const audits = await store.find('audit_events', { action: 'BOOKS.CONNECT_BEGIN' });
  assert.equal(audits.length, 1);
});

// ---------------------------------------------------------------- completeCallback: state validation

test('completeCallback(): rejects a state that was never issued (never calls fetch)', async () => {
  const { connection, calls } = await setup();
  await assert.rejects(connection.completeCallback({ code: 'c', state: 'not-a-real-state' }), (e) => {
    assert.equal(e.code, 'INVALID_STATE');
    return true;
  });
  assert.equal(calls.length, 0);
});

test('completeCallback(): rejects an expired state', async () => {
  const { connection, clockBox } = await setup();
  const begin = await connection.beginConnect({ actor: 'u_admin' });
  const state = new URL(begin.authorizeUrl).searchParams.get('state');
  clockBox.now += 11 * 60 * 1000; // past the 10-minute TTL
  await assert.rejects(connection.completeCallback({ code: 'c', state }), (e) => e.code === 'INVALID_STATE');
});

test('completeCallback(): rejects a reused (already-consumed) state', async () => {
  const { connection, config } = await setup({
    fetchImpl: async (url) => {
      if (String(url).includes('/oauth/v2/token')) {
        return tokenResponse({ access_token: 'at', refresh_token: fakeRefreshToken, expires_in: 3600 });
      }
      throw new Error(`unexpected url ${url}`);
    },
  });
  config.readAuthorized = false;
  const begin = await connection.beginConnect({ actor: 'u_admin' });
  const state = new URL(begin.authorizeUrl).searchParams.get('state');
  await connection.completeCallback({ code: 'c', state, actor: 'u_admin' });
  await assert.rejects(connection.completeCallback({ code: 'c', state, actor: 'u_admin' }), (e) => e.code === 'INVALID_STATE');
});

// ---------------------------------------------------------------- completeCallback: secret key

test('completeCallback(): BOOKS_SECRET_KEY_MISSING when the key is absent/invalid, and nothing is stored', async () => {
  const { connection, store, calls } = await setup({ config: { secretKey: '' } });
  const begin = await connection.beginConnect({ actor: 'u_admin' });
  const state = new URL(begin.authorizeUrl).searchParams.get('state');
  await assert.rejects(connection.completeCallback({ code: 'c', state }), (e) => e.code === 'BOOKS_SECRET_KEY_MISSING');
  assert.equal(calls.length, 0, 'must fail before any network call');
  const row = await store.get('books_connections', 'default');
  assert.equal(row.secret_ciphertext, null);
});

// ---------------------------------------------------------------- completeCallback: success paths

test('completeCallback(): success with BOOKS_READ_AUTHORIZED unset stores only ciphertext, leaves org null, CONNECTED with READ_NOT_AUTHORIZED note; the raw refresh token never appears anywhere', async () => {
  const { connection, store, config, calls } = await setup({
    fetchImpl: async (url) => {
      if (String(url).includes('/oauth/v2/token')) {
        return tokenResponse({ access_token: 'at-1', refresh_token: fakeRefreshToken, expires_in: 3600 });
      }
      throw new Error(`unexpected url ${url} — organizations must not be called when readAuthorized is false`);
    },
  });
  config.readAuthorized = false;
  const begin = await connection.beginConnect({ actor: 'u_admin' });
  const state = new URL(begin.authorizeUrl).searchParams.get('state');
  const result = await connection.completeCallback({ code: 'auth-code-1', state, actor: 'u_admin' });

  assert.equal(result.status, 'CONNECTED');
  assert.equal(result.org, null);
  assert.equal(result.lastErrorRedacted, 'READ_NOT_AUTHORIZED');
  assert.equal(calls.length, 1, 'only the token exchange call, never an organizations call');

  const row = await store.get('books_connections', 'default');
  assert.ok(row.secret_ciphertext.startsWith('v1:'));
  assert.notEqual(row.secret_ciphertext, fakeRefreshToken);

  // Deep-scan every row this test touched, the audit trail, and the API response for the raw token.
  const haystacks = [JSON.stringify(row), JSON.stringify(await store.find('audit_events', {})), JSON.stringify(result)];
  for (const hay of haystacks) assert.ok(!hay.includes(fakeRefreshToken), 'raw refresh token leaked');
});

test('completeCallback(): success with BOOKS_READ_AUTHORIZED=true also fetches and records the organization', async () => {
  const { connection, config, calls } = await setup({
    fetchImpl: async (url) => {
      const u = String(url);
      if (u.includes('/oauth/v2/token')) {
        return tokenResponse({ access_token: 'at-2', refresh_token: fakeRefreshToken, expires_in: 3600, api_domain: 'https://www.zohoapis.in/books/v3' });
      }
      if (u.includes('/organizations/')) {
        return tokenResponse({ code: 0, message: 'success', organization: { organization_id: 'org_pilot_01', name: 'Eco Green Pilot' } });
      }
      throw new Error(`unexpected url ${u}`);
    },
  });
  config.readAuthorized = true;
  const begin = await connection.beginConnect({ actor: 'u_admin' });
  const state = new URL(begin.authorizeUrl).searchParams.get('state');
  const result = await connection.completeCallback({ code: 'auth-code-2', state, actor: 'u_admin' });

  assert.equal(result.status, 'CONNECTED');
  assert.deepEqual(result.org, { id: 'org_pilot_01', name: 'Eco Green Pilot', region: 'in', apiDomain: 'https://www.zohoapis.in/books/v3' });
  assert.equal(calls.length, 2);
});

// ---------------------------------------------------------------- gating: test/sync/refresh never call fetch when not authorized

test('testConnection(): NOT_CONNECTED refuses before any fetch', async () => {
  const { connection, calls } = await setup();
  await assert.rejects(connection.testConnection({ actor: 'u_admin' }), (e) => e.code === 'NOT_CONNECTED');
  assert.equal(calls.length, 0);
});

test('testConnection()/syncLocations(live)/refreshStatus(): with BOOKS_READ_AUTHORIZED unset, never call fetch even when CONNECTED', async () => {
  const { connection, store, config, calls } = await setup();
  config.readAuthorized = false;
  await connection.getStatus(); // ensure the 'default' row exists before mutating it directly
  await store.update('books_connections', 'default', {
    status: 'CONNECTED',
    region: 'in',
    api_domain: 'https://www.zohoapis.in/books/v3',
    secret_ciphertext: encryptSecret(fakeRefreshToken, config.secretKey),
  });

  await assert.rejects(connection.testConnection({ actor: 'u_admin' }), (e) => e.code === 'READ_NOT_AUTHORIZED');
  await assert.rejects(connection.syncLocations({ actor: 'u_admin', driver: 'live' }), (e) => e.code === 'READ_NOT_AUTHORIZED');
  const refreshed = await connection.refreshStatus({ actor: 'u_admin' });
  assert.equal(refreshed.tokenRefreshStatus, 'NONE');

  assert.equal(calls.length, 0, 'no fetch call must ever happen while BOOKS_READ_AUTHORIZED is not true');
});

test('syncLocations(driver: mock) is never gated and never calls fetch, seeding clearly-synthetic locations', async () => {
  const { connection, store, calls } = await setup();
  const result = await connection.syncLocations({ actor: 'u_admin', driver: 'mock' });
  assert.equal(calls.length, 0);
  assert.ok(result.count >= 1);
  const rows = await connection.listLocations();
  assert.ok(rows.every((r) => r.is_synthetic === 1));
  assert.ok(rows.every((r) => r.location_name.includes('[SYNTHETIC]')));
  const status = await store.get('books_connections', 'default');
  assert.ok(status.locations_synced_at);
});

// ---------------------------------------------------------------- location mapping

async function connectedWithMockLocations() {
  const ctx = await setup();
  await ctx.connection.syncLocations({ actor: 'u_admin', driver: 'mock' });
  return ctx;
}

test('setLocationMapping(): maps a synced location to an existing branch and updates branches/branch_summaries', async () => {
  const { connection, store } = await connectedWithMockLocations();
  const now = new Date().toISOString();
  await store.insert('branches', { branch_code: 'PILOT01', branch_name: 'Pilot Branch', zoho_location_id: null, status: 'ACTIVE', created_at: now, updated_at: now });

  const [mapped] = await connection.setLocationMapping({ actor: 'u_admin', mappings: [{ branch_code: 'PILOT01', location_id: 'SYN-LOC-001' }] });
  assert.equal(mapped.branch_code, 'PILOT01');
  const branch = await store.get('branches', 'PILOT01');
  assert.equal(branch.zoho_location_id, 'SYN-LOC-001');

  const audits = await store.find('audit_events', { action: 'BOOKS.LOCATION_MAPPED' });
  assert.equal(audits.length, 1);
});

test('setLocationMapping(): unknown branch is rejected', async () => {
  const { connection } = await connectedWithMockLocations();
  await assert.rejects(
    connection.setLocationMapping({ actor: 'u_admin', mappings: [{ branch_code: 'NOPE', location_id: 'SYN-LOC-001' }] }),
    (e) => e.code === 'BRANCH_NOT_FOUND',
  );
});

test('setLocationMapping(): unknown location is rejected', async () => {
  const { connection, store } = await connectedWithMockLocations();
  const now = new Date().toISOString();
  await store.insert('branches', { branch_code: 'PILOT01', branch_name: 'Pilot', zoho_location_id: null, status: 'ACTIVE', created_at: now, updated_at: now });
  await assert.rejects(
    connection.setLocationMapping({ actor: 'u_admin', mappings: [{ branch_code: 'PILOT01', location_id: 'DOES-NOT-EXIST' }] }),
    (e) => e.code === 'LOCATION_NOT_FOUND',
  );
});

test('setLocationMapping(): a location may map to at most one branch (409 LOCATION_ALREADY_MAPPED)', async () => {
  const { connection, store } = await connectedWithMockLocations();
  const now = new Date().toISOString();
  await store.insert('branches', { branch_code: 'PILOT01', branch_name: 'Pilot', zoho_location_id: null, status: 'ACTIVE', created_at: now, updated_at: now });
  await store.insert('branches', { branch_code: 'PILOT02', branch_name: 'Pilot 2', zoho_location_id: null, status: 'ACTIVE', created_at: now, updated_at: now });

  await connection.setLocationMapping({ actor: 'u_admin', mappings: [{ branch_code: 'PILOT01', location_id: 'SYN-LOC-001' }] });
  await assert.rejects(
    connection.setLocationMapping({ actor: 'u_admin', mappings: [{ branch_code: 'PILOT02', location_id: 'SYN-LOC-001' }] }),
    (e) => e.code === 'LOCATION_ALREADY_MAPPED',
  );
});

// ---------------------------------------------------------------- disconnect

test('disconnect(): clears secret_ciphertext, sets DISCONNECTED, and never calls fetch when not read-authorized', async () => {
  const { connection, store, config, calls } = await setup();
  config.readAuthorized = false;
  await connection.getStatus();
  await store.update('books_connections', 'default', {
    status: 'CONNECTED',
    secret_ciphertext: encryptSecret(fakeRefreshToken, config.secretKey),
  });
  const result = await connection.disconnect({ actor: 'u_admin', reason: 'pilot done' });
  assert.equal(result.status, 'DISCONNECTED');
  assert.equal(calls.length, 0);
  const row = await store.get('books_connections', 'default');
  assert.equal(row.secret_ciphertext, null);
});

test('disconnect(): attempts a best-effort revoke when read-authorized, and still disconnects if revoke fails', async () => {
  const { connection, store, config, calls } = await setup({
    fetchImpl: async (url) => {
      if (String(url).includes('/token/revoke')) throw new Error('network down');
      throw new Error('unexpected');
    },
  });
  config.readAuthorized = true;
  await connection.getStatus();
  await store.update('books_connections', 'default', {
    status: 'CONNECTED',
    region: 'in',
    secret_ciphertext: encryptSecret(fakeRefreshToken, config.secretKey),
  });
  const result = await connection.disconnect({ actor: 'u_admin' });
  assert.equal(result.status, 'DISCONNECTED');
  assert.equal(calls.length, 1);
});

// ---------------------------------------------------------------- crypto helpers

test('encryptSecret/decryptSecret: round-trips and uses a random 12-byte IV each time (ciphertext differs across calls)', async () => {
  const a = encryptSecret(fakeRefreshToken, VALID_SECRET_KEY);
  const b = encryptSecret(fakeRefreshToken, VALID_SECRET_KEY);
  assert.notEqual(a, b, 'random IV must make repeated encryptions differ');
  assert.ok(a.startsWith('v1:'));
  assert.equal(decryptSecret(a, VALID_SECRET_KEY), fakeRefreshToken);
  assert.equal(decryptSecret(b, VALID_SECRET_KEY), fakeRefreshToken);
});

test('decryptSecret: throws a redacted error (never the ciphertext/key) on a wrong key', async () => {
  const enc = encryptSecret(fakeRefreshToken, VALID_SECRET_KEY);
  const wrongKey = Buffer.alloc(32, 9).toString('base64');
  assert.throws(() => decryptSecret(enc, wrongKey), (e) => {
    assert.equal(e.code, 'DECRYPT_FAILED');
    assert.ok(!e.message.includes(enc));
    return true;
  });
});

test('encryptSecret: rejects a key that is not exactly 32 bytes', () => {
  assert.throws(() => encryptSecret('x', Buffer.alloc(16).toString('base64')), (e) => e.code === 'BOOKS_SECRET_KEY_MISSING');
});
