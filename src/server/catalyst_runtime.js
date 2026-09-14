// Catalyst AppSail request-scoping runtime (docs/CATALYST_REFERENCES.md "Initialisation").
//
// `zcatalyst-sdk-node` is available ONLY inside the Catalyst runtime (AppSail/Functions).
// It is NEVER imported eagerly here (or added to package.json) — every reference to it
// goes through `sdkLoader` (default: a lazy `import('zcatalyst-sdk-node')`), so this file,
// `node --test`, and any non-Catalyst environment never touch it unless a Catalyst-backed
// adapter is actually configured.
//
// Per-request app: inside AppSail, `sdk.initialize(req, { scope: 'admin' })` returns the
// app for THIS request (scope affects Data Store/ZCQL only). That app is then threaded
// through the rest of the request via `AsyncLocalStorage` — `currentApp()` reads it back
// from anywhere downstream (route handlers, request-scoped store/archive adapters) without
// every function signature needing an extra `app` parameter.
//
// Background work (the worker loop in src/worker/index.js, or a seed job in
// src/server/routes/dev.js that must keep running after its HTTP response is already
// sent): AppSail's process environment carries `CATALYST_CONFIG`/`CATALYST_AUTH`
// (provisioned by the AppSail runtime itself, not by this app), so a request-less
// `sdk.initialize()` still resolves to a working app there. `currentApp()` falls back to
// that automatically when no request context is active. A long-running job that must keep
// using the SAME app instance it was handed during its originating request (rather than a
// fresh request-less one) should capture that app up front and re-enter its context via
// `runWithApp()`.
import { AsyncLocalStorage } from 'node:async_hooks';
import { openStore as openCatalystStore } from '../adapters/store/catalyst.js';
import { openArchive as openStratusArchive } from '../adapters/archive/stratus.js';

export class CatalystRuntimeError extends Error {
  constructor(message) {
    super(message);
    this.code = 'CATALYST_RUNTIME_ERROR';
  }
}

const als = new AsyncLocalStorage();

let sdkLoaderRef = () => import('zcatalyst-sdk-node');
let sdkPromise = null;

/**
 * `zcatalyst-sdk-node` is CommonJS and published with `export = catalyst`, so a dynamic
 * `import()` yields a namespace object whose callable namespace sits on `.default` —
 * `mod.initialize` is undefined there. Test fakes, by contrast, are plain ESM objects that
 * expose `initialize` directly. Normalise both shapes to the object that actually has
 * `initialize()`, or fail loudly naming what was loaded.
 */
function resolveSdkNamespace(mod) {
  if (mod && typeof mod.initialize === 'function') return mod;
  if (mod && mod.default && typeof mod.default.initialize === 'function') return mod.default;
  throw new CatalystRuntimeError(
    `the loaded Catalyst SDK exposes no initialize(): keys=[${mod ? Object.keys(mod).join(',') : String(mod)}]`,
  );
}

function loadSdk() {
  if (!sdkPromise) sdkPromise = Promise.resolve().then(sdkLoaderRef).then(resolveSdkNamespace);
  return sdkPromise;
}

/** Resets the cached SDK module + loader — tests call `createCatalystRuntime({ sdkLoader })`
 * repeatedly with different fakes and must never see a stale cached module. */
function setSdkLoader(sdkLoader) {
  sdkLoaderRef = sdkLoader;
  sdkPromise = null;
}

/**
 * createCatalystRuntime({ sdkLoader })
 *  - sdkLoader: async () => sdkModule, defaults to `() => import('zcatalyst-sdk-node')`.
 *    Tests inject a fake module whose `initialize()` returns the catalyst_fake app.
 * Returns `{ middleware, currentApp, runWithApp }`.
 */
export function createCatalystRuntime({ sdkLoader } = {}) {
  if (sdkLoader) setSdkLoader(sdkLoader);

  /** Express middleware. When a Catalyst-backed adapter is configured (STORE_ADAPTER
   * 'catalyst' or ARCHIVE_ADAPTER 'stratus'), initializes this request's Catalyst app and
   * runs the rest of the request inside its AsyncLocalStorage context. Otherwise a no-op
   * (sqlite/local deployments never touch the SDK). */
  function middleware() {
    return async (req, res, next) => {
      const needsCatalyst = process.env.STORE_ADAPTER === 'catalyst' || process.env.ARCHIVE_ADAPTER === 'stratus';
      if (!needsCatalyst) return next();
      try {
        const sdk = await loadSdk();
        const app = await sdk.initialize(req, { scope: 'admin' });
        return als.run({ app }, () => next());
      } catch (err) {
        return next(err);
      }
    };
  }

  /** Re-enters an AsyncLocalStorage context carrying a PRE-CAPTURED `app` (e.g. one taken
   * from `currentApp()` while a request was still active) so background work started from
   * that request keeps resolving the SAME per-request app after the HTTP response is
   * already sent. */
  function runWithApp(app, fn) {
    return als.run({ app }, fn);
  }

  return { middleware, currentApp, runWithApp };
}

/**
 * Returns the Catalyst app for the current AsyncLocalStorage context (set by
 * `middleware()` or `runWithApp()`), or falls back to a request-less `sdk.initialize()`
 * for background jobs with no active context (see module header). Throws
 * CatalystRuntimeError if the loaded SDK exposes no `initialize()` at all.
 */
export async function currentApp() {
  const ctx = als.getStore();
  if (ctx?.app) return ctx.app;
  const sdk = await loadSdk();
  if (typeof sdk.initialize !== 'function') {
    throw new CatalystRuntimeError('Catalyst SDK has no initialize() and no request context is active');
  }
  return sdk.initialize();
}

/**
 * makeRequestScopedStore(opts) -> Store
 * Every method resolves `currentApp()` AT CALL TIME and opens (or reuses, cached per app
 * instance via WeakMap so one request/job reuses one underlying adapter) a Catalyst Data
 * Store adapter for it. This lets `createApp({ store })` be built ONCE at server startup
 * with a single object, while transparently operating against a different Catalyst app
 * per request (each AppSail instance/request gets its own app from `sdk.initialize()`).
 */
export function makeRequestScopedStore(opts = {}) {
  const cache = new WeakMap(); // app -> Promise<Store>

  async function resolveStore() {
    const app = await currentApp();
    if (!cache.has(app)) cache.set(app, openCatalystStore({ app, ...opts }));
    return cache.get(app);
  }

  const methods = ['insert', 'insertMany', 'update', 'get', 'findOne', 'find', 'count', 'raw', 'transaction', 'claim', 'releaseClaim', 'close'];
  const scoped = {};
  for (const name of methods) {
    scoped[name] = async (...args) => {
      const store = await resolveStore();
      return store[name](...args);
    };
  }
  // claimSemantics must be readable synchronously (callers check it without awaiting) —
  // it is a fixed property of the Catalyst adapter regardless of which app instance
  // backs any given call, so it never needs to resolve currentApp() itself.
  Object.defineProperty(scoped, 'claimSemantics', { value: 'BEST_EFFORT', enumerable: true });
  return scoped;
}

/**
 * makeRequestScopedArchive(opts) -> Archive
 * Same idea as makeRequestScopedStore, for the Catalyst Stratus archive adapter.
 */
export function makeRequestScopedArchive(opts = {}) {
  const cache = new WeakMap();

  async function resolveArchive() {
    const app = await currentApp();
    if (!cache.has(app)) cache.set(app, openStratusArchive({ app, ...opts }));
    return cache.get(app);
  }

  const methods = ['put', 'exists', 'get'];
  const scoped = {};
  for (const name of methods) {
    scoped[name] = async (...args) => {
      const archive = await resolveArchive();
      return archive[name](...args);
    };
  }
  return scoped;
}
