import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createArchiveHealth } from '../src/server/archive_health.js';
import { openArchive as openStratusArchive } from '../src/adapters/archive/stratus.js';
import { createStratusFake } from '../src/adapters/archive/stratus_fake.js';
import { openArchive as openLocalArchive } from '../src/adapters/archive/local.js';
import { openArchive as openDisabledArchive } from '../src/adapters/archive/disabled.js';

const BUCKET = 'eco-green-health-test';

async function makeVerifiedStratusArchive(meta) {
  const fake = createStratusFake();
  fake.createBucket(BUCKET, meta);
  const archive = await openStratusArchive({ app: fake.app, bucketName: BUCKET });
  return { archive, fake };
}

test('archive_health: stratus verified -> ENABLED_VERIFIED with bucket flag fields', async () => {
  const { archive } = await makeVerifiedStratusArchive();
  const health = createArchiveHealth({ archive, archiveAdapter: 'stratus' });
  const result = await health.status();

  assert.equal(result.archiveAdapter, 'stratus');
  assert.equal(result.archiveStatus, 'ENABLED_VERIFIED');
  assert.equal(result.error, undefined);
  assert.deepEqual(result.bucket, {
    name: BUCKET,
    protected: null, // not present on IStratusBucket/IStratusBucketMeta — see stratus.js verify()
    encryption: true,
    versioning: true,
    audit: true,
    caching: 'Disabled',
  });
  assert.ok(result.checkedAt);
});

test('archive_health: stratus verify() failure (getDetails throws) -> ENABLED_UNVERIFIED with error code', async () => {
  const fake = createStratusFake();
  // Bucket never registered via fake.createBucket(), so bucket.getDetails() throws.
  const archive = await openStratusArchive({ app: fake.app, bucketName: BUCKET });
  const health = createArchiveHealth({ archive, archiveAdapter: 'stratus' });
  const result = await health.status();

  assert.equal(result.archiveAdapter, 'stratus');
  assert.equal(result.archiveStatus, 'ENABLED_UNVERIFIED');
  assert.equal(result.error, 'BUCKET_NOT_FOUND');
  assert.equal(result.bucket, undefined);
  assert.ok(result.checkedAt);
});

test('archive_health: caches the verify result for ttlMs — one verify() per window, a fresh one after it expires', async () => {
  const { archive } = await makeVerifiedStratusArchive();
  let calls = 0;
  const countingArchive = {
    async verify(...args) {
      calls += 1;
      return archive.verify(...args);
    },
  };
  let now = 1_000_000;
  const health = createArchiveHealth({ archive: countingArchive, archiveAdapter: 'stratus', ttlMs: 1000, clock: () => now });

  await health.status();
  await health.status();
  await health.status();
  assert.equal(calls, 1, 'three status() calls inside the ttl window must share one cached verify()');

  now += 1001; // advance the clock past ttlMs
  await health.status();
  assert.equal(calls, 2, 'a status() call after ttlMs has elapsed must run a fresh verify()');
});

test('archive_health: single-flight — concurrent first calls share one in-flight verify()', async () => {
  const { archive } = await makeVerifiedStratusArchive();
  let calls = 0;
  let resolveGate;
  const gate = new Promise((resolve) => {
    resolveGate = resolve;
  });
  const countingArchive = {
    async verify(...args) {
      calls += 1;
      await gate;
      return archive.verify(...args);
    },
  };
  const health = createArchiveHealth({ archive: countingArchive, archiveAdapter: 'stratus' });

  // Kick off three concurrent first calls before letting any verify() complete.
  const p1 = health.status();
  const p2 = health.status();
  const p3 = health.status();
  resolveGate();
  const results = await Promise.all([p1, p2, p3]);

  assert.equal(calls, 1, 'three concurrent first calls must trigger exactly one verify()');
  for (const result of results) assert.equal(result.archiveStatus, 'ENABLED_VERIFIED');
});

test('archive_health: local adapter -> LOCAL', async () => {
  const archive = await openLocalArchive({ root: './var/archive-health-test' });
  const health = createArchiveHealth({ archive, archiveAdapter: 'local' });
  const result = await health.status();

  assert.equal(result.archiveAdapter, 'local');
  assert.equal(result.archiveStatus, 'LOCAL');
  assert.equal(result.error, undefined);
  assert.equal(result.bucket, undefined);
});

test('archive_health: disabled adapter -> DISABLED_DEVELOPMENT', async () => {
  const archive = await openDisabledArchive({ environment: 'Development' });
  const health = createArchiveHealth({ archive, archiveAdapter: 'disabled' });
  const result = await health.status();

  assert.equal(result.archiveAdapter, 'disabled');
  assert.equal(result.archiveStatus, 'DISABLED_DEVELOPMENT');
  assert.equal(result.error, undefined);
  assert.equal(result.bucket, undefined);
});

test('archive_health: never throws even when the archive has no verify() at all', async () => {
  const health = createArchiveHealth({ archive: {}, archiveAdapter: 'stratus' });
  const result = await health.status();

  assert.equal(result.archiveStatus, 'ENABLED_UNVERIFIED');
  assert.equal(result.error, 'VERIFY_NOT_SUPPORTED');
});
