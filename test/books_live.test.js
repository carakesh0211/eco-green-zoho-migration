import test from 'node:test';
import assert from 'node:assert/strict';
import { createLiveClient } from '../src/books/live.js';
import { clearTokenCache } from '../src/books/oauth.js';

// No test in this file may hit the network: global fetch is always stubbed before use and
// restored afterwards.

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
  return baseConfig({
    postingEnabled: true,
    postingAuthorizationRef: 'sign-off-ref-1',
    ...overrides,
  });
}

function fakeTokenResponse() {
  return { ok: true, status: 200, json: async () => ({ access_token: 'test-token', expires_in: 3600 }) };
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

test('create(): throws POSTING_DISABLED before any fetch is made when the guard fails', async () => {
  let fetchCalled = false;
  await withFetch(
    async () => {
      fetchCalled = true;
      throw new Error('fetch must not be called');
    },
    async () => {
      const client = createLiveClient(baseConfig()); // postingEnabled: false
      await assert.rejects(client.create('bill', { line_items: [] }), (e) => {
        assert.equal(e.code, 'POSTING_DISABLED');
        return true;
      });
    },
  );
  assert.equal(fetchCalled, false, 'guard must short-circuit before any network access, including OAuth');
});

test('reads against a non-allowlisted organisation throw before any fetch is made', async () => {
  let fetchCalled = false;
  await withFetch(
    async () => {
      fetchCalled = true;
      throw new Error('fetch must not be called');
    },
    async () => {
      const client = createLiveClient(baseConfig({ organizationId: 'org_wrong', orgAllowlist: ['org_allowed'] }));
      await assert.rejects(client.getLocations(), (e) => e.code === 'POSTING_DISABLED');
      await assert.rejects(client.getOrganization(), (e) => e.code === 'POSTING_DISABLED');
      await assert.rejects(
        client.getTrialBalance({ locationId: 'loc1', fromDate: '2026-01-01', toDate: '2026-01-31' }),
        (e) => e.code === 'POSTING_DISABLED',
      );
    },
  );
  assert.equal(fetchCalled, false, 'a disallowed org must block reads before any network access, including OAuth');
});

test('an abort/timeout that fires after the request was dispatched classifies as UNKNOWN for a write', async () => {
  await withFetch(
    async (url) => {
      if (String(url).includes('/oauth/v2/token')) return fakeTokenResponse();
      // Simulate a request that hangs and is then aborted after dispatch.
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      throw err;
    },
    async () => {
      const client = createLiveClient(allowedPostingConfig());
      await assert.rejects(
        client.create('bill', { line_items: [] }),
        (e) => {
          assert.equal(e.classification.class, 'UNKNOWN');
          return true;
        },
      );
    },
  );
});

test('an abort/timeout after dispatch classifies as RETRYABLE (not UNKNOWN) for a read', async () => {
  await withFetch(
    async (url) => {
      if (String(url).includes('/oauth/v2/token')) return fakeTokenResponse();
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      throw err;
    },
    async () => {
      const client = createLiveClient(baseConfig());
      await assert.rejects(client.getLocations(), (e) => {
        assert.equal(e.classification.class, 'RETRYABLE');
        return true;
      });
    },
  );
});

test('429 with a Retry-After header classifies as RATE_LIMIT with retry_after_ms', async () => {
  await withFetch(
    async (url) => {
      if (String(url).includes('/oauth/v2/token')) return fakeTokenResponse();
      return {
        status: 429,
        headers: { get: (name) => (name.toLowerCase() === 'retry-after' ? '4' : null) },
        text: async () => JSON.stringify({ message: 'Too many requests' }),
      };
    },
    async () => {
      const client = createLiveClient(baseConfig());
      await assert.rejects(client.getLocations(), (e) => {
        assert.equal(e.classification.class, 'RATE_LIMIT');
        assert.equal(e.classification.retry_after_ms, 4000);
        return true;
      });
    },
  );
});

test('a plain network error (not an abort/timeout) is always RETRYABLE, never UNKNOWN', async () => {
  await withFetch(
    async (url) => {
      if (String(url).includes('/oauth/v2/token')) return fakeTokenResponse();
      throw new Error('getaddrinfo ENOTFOUND'); // non-abort network failure
    },
    async () => {
      const client = createLiveClient(baseConfig());
      await assert.rejects(client.getLocations(), (e) => {
        assert.equal(e.classification.class, 'RETRYABLE');
        return true;
      });
    },
  );
});

test('a successful create() call sends Authorization, organization_id and X-Idempotency-Key', async () => {
  let seenRequest = null;
  await withFetch(
    async (url, opts) => {
      if (String(url).includes('/oauth/v2/token')) return fakeTokenResponse();
      seenRequest = { url: String(url), opts };
      return {
        status: 200,
        headers: { get: () => null },
        text: async () => JSON.stringify({ bill: { bill_id: 'zb_1' } }),
      };
    },
    async () => {
      const client = createLiveClient(allowedPostingConfig());
      const result = await client.create('bill', { line_items: [] }, { idempotencyKey: 'idem-123' });
      assert.deepEqual(result, { bill: { bill_id: 'zb_1' } });
    },
  );

  assert.ok(seenRequest, 'the API request must have been made');
  assert.match(seenRequest.url, /organization_id=org_allowed/);
  assert.equal(seenRequest.opts.headers.Authorization, 'Zoho-oauthtoken test-token');
  assert.equal(seenRequest.opts.headers['X-Idempotency-Key'], 'idem-123');
});

test('getOrganization()/getLocations() succeed for an allowlisted org', async () => {
  await withFetch(
    async (url) => {
      const u = String(url);
      if (u.includes('/oauth/v2/token')) return fakeTokenResponse();
      if (u.includes('/organizations/')) {
        return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ organization: { organization_id: 'org_allowed' } }) };
      }
      if (u.includes('/locations')) {
        return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ locations: [{ location_id: 'loc1' }] }) };
      }
      throw new Error(`unexpected url ${u}`);
    },
    async () => {
      const client = createLiveClient(baseConfig());
      const org = await client.getOrganization();
      assert.equal(org.organization_id, 'org_allowed');
      const locations = await client.getLocations();
      assert.deepEqual(locations, [{ location_id: 'loc1' }]);
    },
  );
});
