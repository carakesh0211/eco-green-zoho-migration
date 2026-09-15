// Owner bootstrap (Development only) — src/server/auth_catalyst.js. See
// docs/CATALYST_AUTH.md, "Owner bootstrap (Development only)", for the mechanism.
//
// Deliberately a standalone harness (not shared with test/auth_catalyst.test.js) so
// that file's 9 existing tests are never touched by this workstream. All synthetic
// emails use @example.test per DATA_CONTRACT.md's synthetic-data convention.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { openStore } from '../src/adapters/store/memory.js';
import { createAudit } from '../src/core/audit.js';
import { createAuth, resolveDirectoryUser } from '../src/server/auth.js';
import { createCatalystSessionAuth, composeAuthenticate, shouldBootstrapOwner, findActiveHumanAdmin } from '../src/server/auth_catalyst.js';
import { createAuthRouter } from '../src/server/routes/auth.js';

async function insertDirectoryUser(
  store,
  { id, email, role = 'operator', principal_type = 'human', status = 'ACTIVE', branches = ['PILOT01'], version = 1 }
) {
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
    version,
    last_login_at: null,
  });
}

/**
 * buildHarness({ environment, sessionImpl, ownerBootstrapEmail })
 * Mirrors test/auth_catalyst.test.js's buildHarness but exposes `environment` (passed
 * straight into createCatalystSessionAuth, per this workstream's new option) and
 * `ownerBootstrapEmail` (sets/unsets OWNER_BOOTSTRAP_EMAIL for the duration of the
 * harness). Kept separate on purpose — see file header.
 */
async function buildHarness({ environment = 'Development', sessionImpl, ownerBootstrapEmail } = {}) {
  const prevEnv = {
    AUTH_MODE: process.env.AUTH_MODE,
    OWNER_BOOTSTRAP_EMAIL: process.env.OWNER_BOOTSTRAP_EMAIL,
  };
  process.env.AUTH_MODE = 'catalyst';
  if (ownerBootstrapEmail === undefined) {
    delete process.env.OWNER_BOOTSTRAP_EMAIL;
  } else {
    process.env.OWNER_BOOTSTRAP_EMAIL = ownerBootstrapEmail;
  }

  const store = await openStore();
  const audit = createAudit(store);
  const auth = createAuth({ users: [], audit, store });

  const currentApp = async () => ({
    userManagement: () => ({
      getCurrentUser: sessionImpl ?? (async () => { throw new Error('NO_SESSION'); }),
    }),
  });
  const sessionAuth = createCatalystSessionAuth({ store, audit, currentApp, resolveDirectoryUser, environment });
  const composed = composeAuthenticate(auth.authenticate, sessionAuth.authenticateSession);
  const composedAuth = { ...auth, authenticate: () => composed };

  const app = express();
  app.use(createAuthRouter({ auth: composedAuth, sessionAuth, environment }));

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
      if (prevEnv.OWNER_BOOTSTRAP_EMAIL === undefined) delete process.env.OWNER_BOOTSTRAP_EMAIL;
      else process.env.OWNER_BOOTSTRAP_EMAIL = prevEnv.OWNER_BOOTSTRAP_EMAIL;
    },
  };
}

// ---------------------------------------------------------------- pure helpers

test('shouldBootstrapOwner: pure decision table', () => {
  assert.equal(
    shouldBootstrapOwner({ environment: 'Development', ownerEmail: 'a@example.test', sessionEmail: 'A@EXAMPLE.TEST', activeHumanAdminExists: false }),
    true
  );
  assert.equal(
    shouldBootstrapOwner({ environment: 'Production', ownerEmail: 'a@example.test', sessionEmail: 'a@example.test', activeHumanAdminExists: false }),
    false
  );
  assert.equal(shouldBootstrapOwner({ environment: undefined, ownerEmail: 'a@example.test', sessionEmail: 'a@example.test', activeHumanAdminExists: false }), false);
  assert.equal(
    shouldBootstrapOwner({ environment: 'Development', ownerEmail: 'a@example.test', sessionEmail: 'a@example.test', activeHumanAdminExists: true }),
    false
  );
  assert.equal(shouldBootstrapOwner({ environment: 'Development', ownerEmail: '', sessionEmail: 'a@example.test', activeHumanAdminExists: false }), false);
  assert.equal(shouldBootstrapOwner({ environment: 'Development', ownerEmail: 'a@example.test', sessionEmail: '', activeHumanAdminExists: false }), false);
  assert.equal(
    shouldBootstrapOwner({ environment: 'Development', ownerEmail: 'a@example.test', sessionEmail: 'b@example.test', activeHumanAdminExists: false }),
    false
  );
  assert.equal(
    shouldBootstrapOwner({ environment: 'Development', ownerEmail: '  a@example.test  ', sessionEmail: 'a@example.test', activeHumanAdminExists: false }),
    true
  );
});

test('findActiveHumanAdmin: null store -> null; matches only role=admin AND principal_type=human AND status=ACTIVE', async () => {
  assert.equal(await findActiveHumanAdmin(null), null);

  const store = await openStore();
  try {
    assert.equal(await findActiveHumanAdmin(store), null);

    await insertDirectoryUser(store, { id: 'bot1', email: null, role: 'admin', principal_type: 'bot', status: 'ACTIVE' });
    assert.equal(await findActiveHumanAdmin(store), null);

    await insertDirectoryUser(store, { id: 'human_invited', email: 'invited-admin@example.test', role: 'admin', principal_type: 'human', status: 'INVITED' });
    assert.equal(await findActiveHumanAdmin(store), null);

    await insertDirectoryUser(store, { id: 'human_active', email: 'active-admin@example.test', role: 'admin', principal_type: 'human', status: 'ACTIVE' });
    const found = await findActiveHumanAdmin(store);
    assert.equal(found?.id, 'human_active');
  } finally {
    await store.close();
  }
});

// ---------------------------------------------------------------- end-to-end (Catalyst session)

test('owner bootstrap: matching sign-in with no active admin creates an ACTIVE admin row + USER.OWNER_BOOTSTRAP audit', async () => {
  const { store, base, close } = await buildHarness({
    ownerBootstrapEmail: 'owner1@example.test',
    sessionImpl: async () => ({ email_id: 'owner1@example.test', user_id: 'zuid_owner1', first_name: 'Own', last_name: 'Er' }),
  });
  try {
    const res = await fetch(`${base}/api/auth/me`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.role, 'admin');
    assert.deepEqual(body.branches, ['*']);
    assert.equal(body.authMode, 'catalyst');

    const rows = await store.find('app_users', { email: 'owner1@example.test' });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].role, 'admin');
    assert.equal(rows[0].status, 'ACTIVE');
    assert.equal(rows[0].principal_type, 'human');
    assert.equal(rows[0].version, 1);
    assert.equal(rows[0].display_name, 'Own Er');
    assert.equal(rows[0].created_by, 'owner-bootstrap');
    assert.match(rows[0].id, /^owner-[0-9a-f]{12}$/);

    const events = await store.find('audit_events', { action: 'USER.OWNER_BOOTSTRAP' });
    assert.equal(events.length, 1);
    assert.equal(events[0].actor, rows[0].id);
    assert.equal(events[0].entity_id, rows[0].id);
    assert.equal(events[0].entity_type, 'app_users');
    assert.equal(events[0].before_json, null);
    assert.match(events[0].reason, /no active human admin existed/);
    assert.doesNotMatch(JSON.stringify(events[0]), /owner1@example\.test/);
  } finally {
    await close();
  }
});

test('owner bootstrap: second sign-in is a no-op (version unchanged, single audit event)', async () => {
  const { store, base, close } = await buildHarness({
    ownerBootstrapEmail: 'owner2@example.test',
    sessionImpl: async () => ({ email_id: 'owner2@example.test', user_id: 'zuid_owner2', first_name: 'Own', last_name: 'Er' }),
  });
  try {
    const first = await fetch(`${base}/api/auth/me`);
    assert.equal(first.status, 200);
    const second = await fetch(`${base}/api/auth/me`);
    assert.equal(second.status, 200);

    const rows = await store.find('app_users', { email: 'owner2@example.test' });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].version, 1);

    const events = await store.find('audit_events', { action: 'USER.OWNER_BOOTSTRAP' });
    assert.equal(events.length, 1);
  } finally {
    await close();
  }
});

test('owner bootstrap: latch closed when another ACTIVE human admin already exists (no-op, no row, no audit)', async () => {
  const { store, base, close } = await buildHarness({
    ownerBootstrapEmail: 'owner3@example.test',
    sessionImpl: async () => ({ email_id: 'owner3@example.test', user_id: 'zuid_owner3', first_name: 'Own', last_name: 'Er' }),
  });
  try {
    await insertDirectoryUser(store, { id: 'u_existing_admin', email: 'existing-admin@example.test', role: 'admin', status: 'ACTIVE', branches: ['*'] });

    const res = await fetch(`${base}/api/auth/me`);
    assert.equal(res.status, 403); // owner3 has no app_users row and the latch is closed -> not provisioned

    const rows = await store.find('app_users', { email: 'owner3@example.test' });
    assert.equal(rows.length, 0);

    const events = await store.find('audit_events', { action: 'USER.OWNER_BOOTSTRAP' });
    assert.equal(events.length, 0);
  } finally {
    await close();
  }
});

test('owner bootstrap: Production environment never bootstraps even with a matching email', async () => {
  const { store, base, close } = await buildHarness({
    environment: 'Production',
    ownerBootstrapEmail: 'owner4@example.test',
    sessionImpl: async () => ({ email_id: 'owner4@example.test', user_id: 'zuid_owner4' }),
  });
  try {
    const res = await fetch(`${base}/api/auth/me`);
    assert.equal(res.status, 403);
    const rows = await store.find('app_users', { email: 'owner4@example.test' });
    assert.equal(rows.length, 0);
    const events = await store.find('audit_events', { action: 'USER.OWNER_BOOTSTRAP' });
    assert.equal(events.length, 0);
  } finally {
    await close();
  }
});

test('owner bootstrap: OWNER_BOOTSTRAP_EMAIL unset never bootstraps', async () => {
  const { store, base, close } = await buildHarness({
    sessionImpl: async () => ({ email_id: 'owner5@example.test', user_id: 'zuid_owner5' }),
  });
  try {
    const res = await fetch(`${base}/api/auth/me`);
    assert.equal(res.status, 403);
    const rows = await store.find('app_users', { email: 'owner5@example.test' });
    assert.equal(rows.length, 0);
  } finally {
    await close();
  }
});

test('owner bootstrap: email match is case-insensitive and trimmed', async () => {
  const { store, base, close } = await buildHarness({
    ownerBootstrapEmail: '  Owner6@Example.TEST  ',
    sessionImpl: async () => ({ email_id: 'owner6@example.test', user_id: 'zuid_owner6', first_name: 'Own', last_name: 'Er' }),
  });
  try {
    const res = await fetch(`${base}/api/auth/me`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.role, 'admin');

    const rows = await store.find('app_users', { email: 'owner6@example.test' });
    assert.equal(rows.length, 1);
  } finally {
    await close();
  }
});

test('owner bootstrap: promotes an existing non-admin row to ACTIVE admin, keeping the same id (version+1, before/after without email)', async () => {
  const { store, base, close } = await buildHarness({
    ownerBootstrapEmail: 'owner7@example.test',
    sessionImpl: async () => ({ email_id: 'owner7@example.test', user_id: 'zuid_owner7' }),
  });
  try {
    await insertDirectoryUser(store, { id: 'u_owner7', email: 'owner7@example.test', role: 'viewer', status: 'INVITED', branches: ['PILOT01'] });

    const res = await fetch(`${base}/api/auth/me`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.id, 'u_owner7');
    assert.equal(body.role, 'admin');
    assert.deepEqual(body.branches, ['*']);

    const row = await store.get('app_users', 'u_owner7');
    assert.equal(row.status, 'ACTIVE');
    assert.equal(row.version, 2);

    const events = await store.find('audit_events', { action: 'USER.OWNER_BOOTSTRAP' });
    assert.equal(events.length, 1);
    assert.equal(events[0].actor, 'u_owner7');
    assert.doesNotMatch(JSON.stringify(events[0]), /owner7@example\.test/);
    // No separate USER.ACTIVATED audit — bootstrap sets status ACTIVE directly, so the
    // INVITED-activation branch never fires for this sign-in.
    const activated = await store.find('audit_events', { action: 'USER.ACTIVATED' });
    assert.equal(activated.length, 0);
  } finally {
    await close();
  }
});

// ---------------------------------------------------------------- INACTIVE (existing behaviour, new explicit test)

test('catalyst session: INACTIVE row is denied 403 USER_NOT_PROVISIONED with DENIED audit and no req.user', async () => {
  const { store, base, close } = await buildHarness({
    sessionImpl: async () => ({ email_id: 'inactive@example.test', user_id: 'zuid_inactive' }),
  });
  try {
    await insertDirectoryUser(store, { id: 'u_inactive', email: 'inactive@example.test', role: 'operator', status: 'INACTIVE', branches: ['PILOT01'] });

    const res = await fetch(`${base}/api/auth/me`);
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.error, 'USER_NOT_PROVISIONED');
    // /api/auth/me's 200 shape (id/role/branches) is absent from a 403 body — confirms
    // req.user was never set for this request.
    assert.equal(body.id, undefined);
    assert.equal(body.role, undefined);

    const denied = await store.find('audit_events', { authorization_decision: 'DENIED' });
    const last = denied.at(-1);
    assert.match(last.reason, /USER_NOT_PROVISIONED/);
    assert.match(last.actor, /^catalyst:[0-9a-f]{12}$/);
    assert.doesNotMatch(JSON.stringify(last), /inactive@example\.test/);
  } finally {
    await close();
  }
});

test('owner bootstrap: a bot row with the owner email is never promoted (bots are capped at operator); the sign-in is denied', async () => {
  const { store, base, close } = await buildHarness({
    ownerBootstrapEmail: 'owner8@example.test',
    sessionImpl: async () => ({ email_id: 'owner8@example.test', user_id: 'zuid_owner8' }),
  });
  try {
    await insertDirectoryUser(store, { id: 'bot:owner8', email: 'owner8@example.test', role: 'operator', status: 'ACTIVE', branches: ['PILOT01'], principal_type: 'bot' });
    const res = await fetch(`${base}/api/auth/me`);
    // The directory lookup resolves the bot row (ACTIVE), but no promotion happened...
    const row = await store.get('app_users', 'bot:owner8');
    assert.equal(row.role, 'operator');
    assert.equal(row.principal_type, 'bot');
    assert.equal(row.version, 1);
    assert.equal((await store.find('audit_events', { action: 'USER.OWNER_BOOTSTRAP' })).length, 0);
    // ...and a Catalyst (human) session may never act as a bot principal.
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error, 'FORBIDDEN');
  } finally {
    await close();
  }
});
