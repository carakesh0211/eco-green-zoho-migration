// Asserts the exact URL/path/query params/headers src/books/live.js sends for each call, and its
// envelope handling, against the shapes recorded in docs/ZOHO_BOOKS_API_REFERENCES.md. This is a
// SHAPE contract test, not a network test: global fetch is always stubbed; nothing here ever hits
// the real Zoho API. Where docs/ZOHO_BOOKS_API_REFERENCES.md marks a shape UNVERIFIED, this file
// still pins the shape live.js actually implements today, so an unnoticed drift shows up as a
// failing test even before the shape is confirmed against a live sandbox org.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createLiveClient } from '../src/books/live.js';
import { clearTokenCache } from '../src/books/oauth.js';

function baseConfig(overrides = {}) {
  return {
    driver: 'live',
    apiBase: 'https://books.example.invalid/v3',
    accountsBase: 'https://accounts.example.invalid',
    clientId: 'client-1',
    clientSecret: 'secret-1',
    refreshToken: 'refresh-1',
    organizationId: 'org_allowed',
    orgAllowlist: ['org_allowed'],
    postingEnabled: false,
    postingAuthorizationRef: '',
    rateLimitPerMinute: 1000,
    maxConcurrency: 5,
    requestTimeoutMs: 5000,
    maxAttempts: 1,
    ...overrides,
  };
}

function allowedPostingConfig(overrides = {}) {
  return baseConfig({ postingEnabled: true, postingAuthorizationRef: 'sign-off-ref-1', ...overrides });
}

function fakeTokenResponse() {
  return { ok: true, status: 200, json: async () => ({ access_token: 'test-token', expires_in: 3600 }) };
}

function jsonOk(body) {
  return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify(body) };
}

function withFetch(impl, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return fn().finally(() => {
    globalThis.fetch = original;
  });
}

test.beforeEach(() => {
  clearTokenCache();
});

test('getOrganization(): GET {apiBase}/organizations/{organizationId} with organization_id query and Zoho-oauthtoken header', async () => {
  let seen = null;
  await withFetch(
    async (url, opts) => {
      const u = String(url);
      if (u.includes('/oauth/v2/token')) return fakeTokenResponse();
      seen = { url: u, opts };
      return jsonOk({ organization: { organization_id: 'org_allowed', name: 'Mock Org' } });
    },
    async () => {
      const client = createLiveClient(baseConfig());
      const org = await client.getOrganization();
      assert.equal(org.organization_id, 'org_allowed');
    },
  );
  assert.ok(seen, 'request must have been made');
  const parsed = new URL(seen.url);
  assert.equal(parsed.origin + parsed.pathname, 'https://books.example.invalid/v3/organizations/org_allowed');
  assert.equal(parsed.searchParams.get('organization_id'), 'org_allowed');
  assert.equal(seen.opts.method, 'GET');
  assert.equal(seen.opts.headers.Authorization, 'Zoho-oauthtoken test-token');
});

test('getLocations(): GET {apiBase}/locations, unwraps the "locations" envelope key', async () => {
  let seen = null;
  await withFetch(
    async (url, opts) => {
      const u = String(url);
      if (u.includes('/oauth/v2/token')) return fakeTokenResponse();
      seen = { url: u, opts };
      return jsonOk({ code: 0, message: 'success', locations: [{ location_id: 'loc1', location_name: 'HQ', status: 'active' }] });
    },
    async () => {
      const client = createLiveClient(baseConfig());
      const locations = await client.getLocations();
      assert.deepEqual(locations, [{ location_id: 'loc1', location_name: 'HQ', status: 'active' }]);
    },
  );
  const parsed = new URL(seen.url);
  assert.equal(parsed.origin + parsed.pathname, 'https://books.example.invalid/v3/locations');
  assert.equal(parsed.searchParams.get('organization_id'), 'org_allowed');
});

test('getTrialBalance(): GET {apiBase}/reports/trialbalance with location_id/from_date/to_date query params (UNVERIFIED shape, pinned)', async () => {
  let seen = null;
  await withFetch(
    async (url, opts) => {
      const u = String(url);
      if (u.includes('/oauth/v2/token')) return fakeTokenResponse();
      seen = { url: u, opts };
      return jsonOk({ code: 0, message: 'success' });
    },
    async () => {
      const client = createLiveClient(baseConfig());
      await client.getTrialBalance({ locationId: 'loc1', fromDate: '2026-04-01', toDate: '2026-04-30' });
    },
  );
  const parsed = new URL(seen.url);
  assert.equal(parsed.origin + parsed.pathname, 'https://books.example.invalid/v3/reports/trialbalance');
  assert.equal(parsed.searchParams.get('location_id'), 'loc1');
  assert.equal(parsed.searchParams.get('from_date'), '2026-04-01');
  assert.equal(parsed.searchParams.get('to_date'), '2026-04-30');
});

test('searchByMigrationTag(): GET {apiBase}/{modulePath} with cf_migration_source_hash query param, unwraps module-keyed envelope', async () => {
  let seen = null;
  await withFetch(
    async (url, opts) => {
      const u = String(url);
      if (u.includes('/oauth/v2/token')) return fakeTokenResponse();
      seen = { url: u, opts };
      return jsonOk({ bills: [{ id: 'b1' }] });
    },
    async () => {
      const client = createLiveClient(baseConfig());
      const found = await client.searchByMigrationTag({ module: 'bill', sourceHash: 'hash-1' });
      assert.deepEqual(found, [{ id: 'b1' }]);
    },
  );
  const parsed = new URL(seen.url);
  assert.equal(parsed.origin + parsed.pathname, 'https://books.example.invalid/v3/bills');
  assert.equal(parsed.searchParams.get('cf_migration_source_hash'), 'hash-1');
});

test('listRecordsInWindow(): GET {apiBase}/{modulePath} with location_id/date_start/date_end query params', async () => {
  let seen = null;
  await withFetch(
    async (url, opts) => {
      const u = String(url);
      if (u.includes('/oauth/v2/token')) return fakeTokenResponse();
      seen = { url: u, opts };
      return jsonOk({ journals: [] });
    },
    async () => {
      const client = createLiveClient(baseConfig());
      await client.listRecordsInWindow({ locationId: 'loc1', module: 'journal', fromDate: '2026-04-01', toDate: '2026-04-30' });
    },
  );
  const parsed = new URL(seen.url);
  assert.equal(parsed.origin + parsed.pathname, 'https://books.example.invalid/v3/journals');
  assert.equal(parsed.searchParams.get('location_id'), 'loc1');
  assert.equal(parsed.searchParams.get('date_start'), '2026-04-01');
  assert.equal(parsed.searchParams.get('date_end'), '2026-04-30');
});

test('MODULE_PATH: bank_transfer maps to the real "banktransactions" endpoint, not the previous nonexistent "banktransfers"', async () => {
  let seen = null;
  await withFetch(
    async (url, opts) => {
      const u = String(url);
      if (u.includes('/oauth/v2/token')) return fakeTokenResponse();
      seen = { url: u, opts };
      return jsonOk({ banktransactions: [] });
    },
    async () => {
      const client = createLiveClient(baseConfig());
      await client.listRecordsInWindow({ module: 'bank_transfer', fromDate: '2026-04-01', toDate: '2026-04-30' });
    },
  );
  const parsed = new URL(seen.url);
  assert.equal(parsed.origin + parsed.pathname, 'https://books.example.invalid/v3/banktransactions');
});

test('every module in MODULE_PATH resolves to the doc-verified un-hyphenated plural path segment', async () => {
  const expected = {
    bill: 'bills',
    vendor_payment: 'vendorpayments',
    customer_payment: 'customerpayments',
    expense: 'expenses',
    credit_note: 'creditnotes',
    vendor_credit: 'vendorcredits',
    bank_transfer: 'banktransactions',
    journal: 'journals',
  };
  for (const [module, path] of Object.entries(expected)) {
    let seen = null;
    await withFetch(
      async (url) => {
        const u = String(url);
        if (u.includes('/oauth/v2/token')) return fakeTokenResponse();
        seen = u;
        return jsonOk({ [path]: [] });
      },
      async () => {
        const client = createLiveClient(baseConfig());
        await client.searchByMigrationTag({ module, sourceHash: 'h' });
      },
    );
    const parsed = new URL(seen);
    assert.equal(parsed.pathname, `/v3/${path}`, `module ${module} must resolve to /${path}`);
  }
});

test('create(): POST {apiBase}/{modulePath} with Content-Type, Authorization, organization_id, X-Idempotency-Key and JSON body', async () => {
  let seen = null;
  await withFetch(
    async (url, opts) => {
      const u = String(url);
      if (u.includes('/oauth/v2/token')) return fakeTokenResponse();
      seen = { url: u, opts };
      return jsonOk({ bill: { bill_id: 'zb_1' } });
    },
    async () => {
      const client = createLiveClient(allowedPostingConfig());
      const result = await client.create('bill', { line_items: [{ amount: '1.00' }] }, { idempotencyKey: 'idem-1' });
      assert.deepEqual(result, { bill: { bill_id: 'zb_1' } });
    },
  );
  const parsed = new URL(seen.url);
  assert.equal(parsed.origin + parsed.pathname, 'https://books.example.invalid/v3/bills');
  assert.equal(parsed.searchParams.get('organization_id'), 'org_allowed');
  assert.equal(seen.opts.method, 'POST');
  assert.equal(seen.opts.headers['Content-Type'], 'application/json');
  assert.equal(seen.opts.headers.Authorization, 'Zoho-oauthtoken test-token');
  assert.equal(seen.opts.headers['X-Idempotency-Key'], 'idem-1');
  assert.deepEqual(JSON.parse(seen.opts.body), { line_items: [{ amount: '1.00' }] });
});

test('envelope handling: a 2xx response with an unparseable body classifies UNKNOWN, never SUCCESS', async () => {
  await withFetch(
    async (url) => {
      const u = String(url);
      if (u.includes('/oauth/v2/token')) return fakeTokenResponse();
      return { status: 200, headers: { get: () => null }, text: async () => 'not json{' };
    },
    async () => {
      const client = createLiveClient(baseConfig());
      await assert.rejects(client.getLocations(), (e) => {
        assert.equal(e.classification.class, 'UNKNOWN');
        return true;
      });
    },
  );
});
