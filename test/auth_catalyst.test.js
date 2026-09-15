// Catalyst Authentication session path (src/server/auth_catalyst.js) composed with the
// existing bearer-token path (src/server/auth.js), plus the auth-surface routes
// (src/server/routes/auth.js). See docs/CATALYST_AUTH.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import express from 'express';
import { openStore } from '../src/adapters/store/memory.js';
import { createAudit } from '../src/core/audit.js';
import { createAuth, resolveDirectoryUser as resolveDirectoryUserFromAuth } from '../src/server/auth.js';
import { createCatalystSessionAuth, composeAuthenticate } from '../src/server/auth_catalyst.js';
import { createAuthRouter } from '../src/server/routes/auth.js';

function sha(s) {
  return createHash('sha256').update(String(s), 'utf8').digest('hex');
}

// Fallback per the task brief: "if [resolveDirectoryUser] is not present yet when you
// test, define a local fallback in your test only". It landed in auth.js already
// (verified 2026-09-15), but keep this fallback so the suite degrades gracefully rather
// than crashing at import time if that ever changes.
async function fallbackResolveDirectoryUser(store, { email }) {
  const row = await store.findOne('app_users', { email, status: 'ACTIVE' });
  if (!row) return null;
  let branches = [];
  try {
    const parsed = JSON.parse(row.branches_json ?? '[]');
    if (Array.isArray(parsed)) branches = parsed.map(String);
  } catch {
    branches = [];
  }
  return { id: row.id, role: row.role, principal_type: row.principal_type, branches, email: row.email ?? null };
}
const resolveDirectoryUser = typeof resolveDirectoryUserFromAuth === 'function' ? resolveDirectoryUserFromAuth : fallbackResolveDirectoryUser;

const TOKENS = { admin: 'tok-admin-star' };

async function insertDirectoryUser(store, { id, email, role = 'operator', principal_type = 'human', status = 'ACTIVE', branches = ['PILOT01'] }) {
  const now = new Date().toISOString();
  return store.insert('app_users', {
    id,
    email,
    display_name: id,
    role,
    principal_type,
    status,
    branches_json: JSON.stringify(branches),
    token_sha256: null,
    created_by: 'test',
    created_at: now,
    updated_at: now,
  });
}

/**
 * buildHarness({ authMode, sessionImpl, envOverrides })
 * Assembles a minimal Express app around auth.js + auth_catalyst.js + routes/auth.js —
 * deliberately NOT createApp() from src/server/app.js, since integrating this router into
 * app.js is the caller's job ("I wire routers" — see task brief), not this file's.
 */
async function buildHarness({ authMode = 'catalyst', sessionImpl, envOverrides = {} } = {}) {
  const prevEnv = {
    AUTH_MODE: process.env.AUTH_MODE,
    AUTH_LOGIN_URL: process.env.AUTH_LOGIN_URL,
    AUTH_LOGOUT_URL: process.env.AUTH_LOGOUT_URL,
  };
  process.env.AUTH_MODE = authMode;
  process.env.AUTH_LOGIN_URL = envOverrides.AUTH_LOGIN_URL ?? '';
  process.env.AUTH_LOGOUT_URL = envOverrides.AUTH_LOGOUT_URL ?? '';

  const store = await openStore();
  const audit = createAudit(store);
  const auth = createAuth({
    users: [{ id: 'u_admin', role: 'admin', branches: ['*'], token_sha256: sha(TOKENS.admin) }],
    audit,
    store,
  });

  const currentApp = async () => ({
    userManagement: () => ({
      getCurrentUser: sessionImpl ?? (async () => { throw new Error('NO_SESSION'); }),
    }),
  });
  const sessionAuth = createCatalystSessionAuth({ store, audit, currentApp, resolveDirectoryUser });
  const composed = composeAuthenticate(auth.authenticate, sessionAuth.authenticateSession);
  const composedAuth = { ...auth, authenticate: () => composed };

  const app = express();
  app.use(createAuthRouter({ auth: composedAuth, sessionAuth, environment: 'Development' }));

  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;

  return {
    store,
    audit,
    base: `http://127.0.0.1:${port}`,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      await store.close();
      process.env.AUTH_MODE = prevEnv.AUTH_MODE;
      process.env.AUTH_LOGIN_URL = prevEnv.AUTH_LOGIN_URL;
      process.env.AUTH_LOGOUT_URL = prevEnv.AUTH_LOGOUT_URL;
    },
  };
}

test('catalyst session: resolves to an ACTIVE directory user and shapes /api/auth/me', async () => {
  const { store, base, close } = await buildHarness({
    sessionImpl: async () => ({ email_id: 'alice@example.invalid', user_id: 'zuid_alice', first_name: 'Alice', last_name: 'Ops' }),
  });
  try {
    await insertDirectoryUser(store, { id: 'u_alice', email: 'alice@example.invalid', role: 'operator', branches: ['PILOT01'] });

    const res = await fetch(`${base}/api/auth/me`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.id, 'u_alice');
    assert.equal(body.role, 'operator');
    assert.equal(body.principal_type, 'human');
    assert.deepEqual(body.branches, ['PILOT01']);
    assert.equal(body.authMode, 'catalyst');
    assert.equal(body.email, 'alice@example.invalid');
    assert.equal(body.token_sha256, undefined); // never leaked
  } finally {
    await close();
  }
});

test('catalyst session: INVITED user is activated on first sign-in (USER.ACTIVATED audit)', async () => {
  const { store, base, close } = await buildHarness({
    sessionImpl: async () => ({ email_id: 'bob@example.invalid', user_id: 'zuid_bob', first_name: 'Bob', last_name: 'Invited' }),
  });
  try {
    await insertDirectoryUser(store, { id: 'u_bob', email: 'bob@example.invalid', role: 'viewer', status: 'INVITED', branches: ['PILOT01'] });

    const res = await fetch(`${base}/api/auth/me`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.id, 'u_bob');
    assert.equal(body.authMode, 'catalyst');

    const row = await store.get('app_users', 'u_bob');
    assert.equal(row.status, 'ACTIVE');

    const activated = await store.find('audit_events', { action: 'USER.ACTIVATED' });
    assert.equal(activated.length, 1);
    assert.equal(activated[0].entity_id, 'u_bob');
    assert.equal(activated[0].authorization_decision, 'ALLOWED');
  } finally {
    await close();
  }
});

test('catalyst session: unknown email -> 403 USER_NOT_PROVISIONED with DENIED audit and hashed (never raw) actor', async () => {
  const { store, base, close } = await buildHarness({
    sessionImpl: async () => ({ email_id: 'unknown@example.invalid', user_id: 'zuid_unknown', first_name: 'No', last_name: 'Body' }),
  });
  try {
    const res = await fetch(`${base}/api/auth/me`);
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.error, 'USER_NOT_PROVISIONED');

    const denied = await store.find('audit_events', { authorization_decision: 'DENIED' });
    const last = denied.at(-1);
    assert.match(last.reason, /USER_NOT_PROVISIONED/);
    assert.match(last.actor, /^catalyst:[0-9a-f]{12}$/);
    assert.doesNotMatch(JSON.stringify(last), /unknown@example\.com/);
  } finally {
    await close();
  }
});

test('catalyst session: no session and no bearer -> 401', async () => {
  const { base, close } = await buildHarness({
    sessionImpl: async () => {
      throw new Error('no active Catalyst session');
    },
  });
  try {
    const res = await fetch(`${base}/api/auth/me`);
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error, 'UNAUTHORIZED');
  } finally {
    await close();
  }
});

test('catalyst session: bearer header present -> bearer path used, session never consulted', async () => {
  let sessionCalls = 0;
  const { base, close } = await buildHarness({
    sessionImpl: async () => {
      sessionCalls += 1;
      throw new Error('session path must not be consulted when a bearer header is present');
    },
  });
  try {
    const res = await fetch(`${base}/api/auth/me`, { headers: { Authorization: `Bearer ${TOKENS.admin}` } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.id, 'u_admin');
    assert.equal(body.role, 'admin');
    assert.equal(body.authMode, 'token'); // bearer path never sets authMode; default applied
    assert.equal(body.email, undefined); // config/bearer principals carry no email
    assert.equal(sessionCalls, 0);
  } finally {
    await close();
  }
});

test("catalyst session: AUTH_MODE='token' -> session never consulted even without a bearer header", async () => {
  let sessionCalls = 0;
  const { base, close } = await buildHarness({
    authMode: 'token',
    sessionImpl: async () => {
      sessionCalls += 1;
      throw new Error('session path must not be consulted when AUTH_MODE excludes catalyst');
    },
  });
  try {
    const res = await fetch(`${base}/api/auth/me`);
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error, 'UNAUTHORIZED');
    assert.equal(sessionCalls, 0);
  } finally {
    await close();
  }
});

test('GET /api/auth/config is public and reflects AUTH_MODE / configured URLs', async () => {
  const { base, close } = await buildHarness({
    authMode: 'token,catalyst',
    envOverrides: { AUTH_LOGIN_URL: 'https://accounts.example.zoho.com/login', AUTH_LOGOUT_URL: 'https://accounts.example.zoho.com/logout' },
  });
  try {
    const res = await fetch(`${base}/api/auth/config`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.modes, ['token', 'catalyst']);
    assert.equal(body.catalystLoginUrl, 'https://accounts.example.zoho.com/login');
    assert.equal(body.catalystLogoutUrl, 'https://accounts.example.zoho.com/logout');
  } finally {
    await close();
  }
});

test('GET /auth/login -> 404 AUTH_MODE_NOT_ENABLED when unconfigured, 302 with redirect_uri when configured', async () => {
  {
    const { base, close } = await buildHarness({});
    try {
      const res = await fetch(`${base}/auth/login`, { redirect: 'manual' });
      assert.equal(res.status, 404);
      const body = await res.json();
      assert.equal(body.error, 'AUTH_MODE_NOT_ENABLED');
    } finally {
      await close();
    }
  }
  {
    const { base, close } = await buildHarness({ envOverrides: { AUTH_LOGIN_URL: 'https://accounts.example.zoho.com/login' } });
    try {
      const res = await fetch(`${base}/auth/login`, { redirect: 'manual' });
      assert.equal(res.status, 302);
      const location = res.headers.get('location');
      assert.match(location, /^https:\/\/accounts\.example\.zoho\.com\/login\?redirect_uri=/);
      assert.match(location, new RegExp(`redirect_uri=${encodeURIComponent(base)}%2F`));
    } finally {
      await close();
    }
  }
});

test('GET /auth/logout -> 404 AUTH_MODE_NOT_ENABLED when unconfigured, 302 when configured', async () => {
  {
    const { base, close } = await buildHarness({});
    try {
      const res = await fetch(`${base}/auth/logout`, { redirect: 'manual' });
      assert.equal(res.status, 404);
    } finally {
      await close();
    }
  }
  {
    const { base, close } = await buildHarness({ envOverrides: { AUTH_LOGOUT_URL: 'https://accounts.example.zoho.com/logout' } });
    try {
      const res = await fetch(`${base}/auth/logout`, { redirect: 'manual' });
      assert.equal(res.status, 302);
      assert.match(res.headers.get('location'), /^https:\/\/accounts\.example\.zoho\.com\/logout\?redirect_uri=/);
    } finally {
      await close();
    }
  }
});
