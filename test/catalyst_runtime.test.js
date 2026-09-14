import test from 'node:test';
import assert from 'node:assert/strict';
import { createCatalystRuntime, currentApp, makeRequestScopedStore } from '../src/server/catalyst_runtime.js';
import { createCatalystFake } from '../src/adapters/store/catalyst_fake.js';

function fakeSdkLoader(apps) {
  let n = 0;
  return async () => ({
    initialize(req) {
      const idx = req ? n++ : n; // request-less initialize() reuses the last app (background fallback)
      return apps[idx % apps.length];
    },
  });
}

test('catalyst_runtime: middleware sets a per-request app, currentApp() reads it back', async () => {
  const { app: appA } = createCatalystFake();
  const runtime = createCatalystRuntime({ sdkLoader: async () => ({ initialize: () => appA }) });
  const prevAdapter = process.env.STORE_ADAPTER;
  process.env.STORE_ADAPTER = 'catalyst';
  try {
    const mw = runtime.middleware();
    let seen = null;
    await mw({}, {}, async () => {
      seen = await runtime.currentApp();
    });
    assert.equal(seen, appA);
  } finally {
    process.env.STORE_ADAPTER = prevAdapter;
  }
});

test('catalyst_runtime: middleware is a no-op when no Catalyst-backed adapter is configured', async () => {
  const runtime = createCatalystRuntime({ sdkLoader: async () => { throw new Error('should never load the SDK'); } });
  const prevStore = process.env.STORE_ADAPTER;
  const prevArchive = process.env.ARCHIVE_ADAPTER;
  process.env.STORE_ADAPTER = 'sqlite';
  process.env.ARCHIVE_ADAPTER = 'local';
  try {
    let called = false;
    await runtime.middleware()({}, {}, () => {
      called = true;
    });
    assert.equal(called, true);
  } finally {
    process.env.STORE_ADAPTER = prevStore;
    process.env.ARCHIVE_ADAPTER = prevArchive;
  }
});

test('catalyst_runtime: two concurrent fake requests get different apps', async () => {
  const fakeA = createCatalystFake();
  const fakeB = createCatalystFake();
  let call = 0;
  const runtime = createCatalystRuntime({
    sdkLoader: async () => ({
      initialize(req) {
        call += 1;
        return req?.id === 'a' ? fakeA.app : fakeB.app;
      },
    }),
  });
  const prevAdapter = process.env.STORE_ADAPTER;
  process.env.STORE_ADAPTER = 'catalyst';
  try {
    const mw = runtime.middleware();
    const results = {};

    async function handle(req) {
      await mw(req, {}, async () => {
        // Force a real async gap (macrotask) so the two requests genuinely interleave —
        // AsyncLocalStorage must still keep each continuation's own app.
        await new Promise((resolve) => setImmediate(resolve));
        results[req.id] = await runtime.currentApp();
      });
    }

    await Promise.all([handle({ id: 'a' }), handle({ id: 'b' })]);

    assert.equal(results.a, fakeA.app);
    assert.equal(results.b, fakeB.app);
    assert.notEqual(results.a, results.b);
    assert.equal(call, 2);
  } finally {
    process.env.STORE_ADAPTER = prevAdapter;
  }
});

test('catalyst_runtime: currentApp() falls back to a request-less initialize() outside any request context', async () => {
  const { app } = createCatalystFake();
  createCatalystRuntime({ sdkLoader: async () => ({ initialize: () => app }) });
  const resolved = await currentApp();
  assert.equal(resolved, app);
});

test('catalyst_runtime: currentApp() throws when the SDK exposes no initialize() and no context is active', async () => {
  createCatalystRuntime({ sdkLoader: async () => ({}) });
  await assert.rejects(() => currentApp(), /CATALYST_RUNTIME_ERROR|initialize/);
});

test('catalyst_runtime: runWithApp() re-enters a captured app for detached background work', async () => {
  const { app } = createCatalystFake();
  const runtime = createCatalystRuntime({ sdkLoader: async () => ({ initialize: () => { throw new Error('must not be called'); } }) });
  let seen = null;
  await runtime.runWithApp(app, async () => {
    await new Promise((resolve) => setImmediate(resolve));
    seen = await currentApp();
  });
  assert.equal(seen, app);
});

test('catalyst_runtime: makeRequestScopedStore() resolves the current app at call time and caches per app', async () => {
  const fakeA = createCatalystFake();
  const runtime = createCatalystRuntime({ sdkLoader: async () => ({ initialize: () => fakeA.app }) });
  const store = makeRequestScopedStore();
  assert.equal(store.claimSemantics, 'BEST_EFFORT');

  await runtime.runWithApp(fakeA.app, async () => {
    const branch = await store.insert('branches', {
      branch_code: 'RS01', branch_name: 'Request-scoped', zoho_location_id: 'LOC-RS01',
      status: 'ACTIVE', created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    });
    assert.equal(branch.branch_code, 'RS01');
    const found = await store.get('branches', 'RS01');
    assert.equal(found.branch_code, 'RS01');
  });
});

test('catalyst_runtime: two concurrent requests get independently-scoped stores backed by different apps', async () => {
  const fakeA = createCatalystFake();
  const fakeB = createCatalystFake();
  const runtime = createCatalystRuntime({
    sdkLoader: async () => ({ initialize: (req) => (req?.id === 'a' ? fakeA.app : fakeB.app) }),
  });
  const prevAdapter = process.env.STORE_ADAPTER;
  process.env.STORE_ADAPTER = 'catalyst';
  const store = makeRequestScopedStore();
  try {
    const mw = runtime.middleware();
    const now = new Date().toISOString();

    async function handle(id) {
      await mw({ id }, {}, async () => {
        await store.insert('branches', {
          branch_code: `B_${id}`, branch_name: id, zoho_location_id: `LOC-${id}`, status: 'ACTIVE', created_at: now, updated_at: now,
        });
      });
    }

    await Promise.all([handle('a'), handle('b')]);

    // Each app is its own isolated fake datastore — a row inserted under fakeA's app must
    // never be visible from fakeB's app, proving the two requests never shared a store.
    assert.ok(await fakeA.app.datastore().table('branches').getRow('does-not-crash').catch(() => true));
    const aRows = await fakeA.app.zcql().executeZCQLQuery("SELECT branch_code FROM branches WHERE branch_code = 'B_a'");
    const bInA = await fakeA.app.zcql().executeZCQLQuery("SELECT branch_code FROM branches WHERE branch_code = 'B_b'");
    const bRows = await fakeB.app.zcql().executeZCQLQuery("SELECT branch_code FROM branches WHERE branch_code = 'B_b'");
    assert.equal(aRows.length, 1);
    assert.equal(bInA.length, 0);
    assert.equal(bRows.length, 1);
  } finally {
    process.env.STORE_ADAPTER = prevAdapter;
  }
});

test('resolves a CommonJS SDK exposed as the namespace default (zcatalyst-sdk-node ships export =)', async () => {
  // Regression: the real SDK is CJS, so `await import()` gives { default: catalyst } and a
  // loader returning the raw namespace made every request fail with
  // "sdk.initialize is not a function" AFTER a successful deploy.
  const calls = [];
  const cjsShapedModule = { default: { initialize: (req, opts) => { calls.push(opts); return { marker: 'cjs-app' }; } } };
  const runtime = createCatalystRuntime({ sdkLoader: async () => cjsShapedModule });
  const prev = process.env.STORE_ADAPTER;
  process.env.STORE_ADAPTER = 'catalyst';
  try {
    let seen = null;
    await new Promise((resolve, reject) => {
      runtime.middleware()({ headers: {} }, {}, (err) => {
        if (err) return reject(err);
        // currentApp() is async: resolve it INSIDE the AsyncLocalStorage context.
        runtime.currentApp().then((app) => { seen = app; resolve(); }, reject);
      });
    });
    assert.deepEqual(seen, { marker: 'cjs-app' });
    assert.deepEqual(calls, [{ scope: 'admin' }]);
  } finally {
    process.env.STORE_ADAPTER = prev;
  }
});

test('a module exposing neither initialize() nor default.initialize() fails loudly', async () => {
  const runtime = createCatalystRuntime({ sdkLoader: async () => ({ nothing: true }) });
  const prev = process.env.STORE_ADAPTER;
  process.env.STORE_ADAPTER = 'catalyst';
  try {
    const err = await new Promise((resolve) => runtime.middleware()({ headers: {} }, {}, resolve));
    assert.match(String(err?.message ?? err), /exposes no initialize/);
  } finally {
    process.env.STORE_ADAPTER = prev;
  }
});
