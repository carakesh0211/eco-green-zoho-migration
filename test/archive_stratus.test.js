import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openArchive as openStratusArchive, KeyTooLongError, ArchiveIntegrityError } from '../src/adapters/archive/stratus.js';
import { openArchive as openDispatchArchive } from '../src/adapters/archive/index.js';
import { createStratusFake } from '../src/adapters/archive/stratus_fake.js';
import { ImmutableConflictError, ArchiveShaMismatchError } from '../src/adapters/archive/local.js';
import { sha256Bytes } from '../src/core/hash.js';

const BUCKET = 'eco-green-archive-test';

function openFakeArchive() {
  const fake = createStratusFake();
  return { archive: openStratusArchive({ app: fake.app, bucketName: BUCKET }), fake };
}

// Only synthetic content, per the task brief.
const SAMPLE = Buffer.from('branch_code,voucher_id\nPILOT01,V-TEST-1\n');

test('archive/stratus: put() writes bytes and get()/exists() round-trip', async () => {
  const { archive } = openFakeArchive();
  const a = await archive;
  const sha256 = sha256Bytes(SAMPLE);

  const uri = await a.put({ runId: 'run-001', branchCode: 'PILOT01', fileName: 'transactions.csv', bytes: SAMPLE, sha256 });
  assert.equal(uri, `stratus://${BUCKET}/PILOT01/run-001/${sha256}/transactions.csv`);

  assert.equal(await a.exists(uri), true);
  const readBack = await a.get(uri);
  assert.ok(readBack.equals(SAMPLE));
});

test('archive/stratus: put() with the same sha256 is idempotent — same uri, no second object', async () => {
  const { archive, fake } = openFakeArchive();
  const a = await archive;
  const sha256 = sha256Bytes(SAMPLE);

  const uri1 = await a.put({ runId: 'run-001', branchCode: 'PILOT01', fileName: 'f.csv', bytes: SAMPLE, sha256 });
  const uri2 = await a.put({ runId: 'run-001', branchCode: 'PILOT01', fileName: 'f.csv', bytes: SAMPLE, sha256 });
  assert.equal(uri1, uri2);

  const bucket = fake.app.stratus().bucket(BUCKET);
  const key = `PILOT01/run-001/${sha256}/f.csv`;
  assert.equal(bucket._versionCount(key), 1, 'a second identical put() must not create a second object version');
});

test('archive/stratus: put() with different bytes at the same logical path throws IMMUTABLE_CONFLICT', async () => {
  const { archive } = openFakeArchive();
  const a = await archive;
  const bytesA = Buffer.from('version A,1\n');
  const bytesB = Buffer.from('version B,2,totally different\n');

  await a.put({ runId: 'run-001', branchCode: 'PILOT01', fileName: 'f.csv', bytes: bytesA, sha256: sha256Bytes(bytesA) });

  await assert.rejects(
    () => a.put({ runId: 'run-001', branchCode: 'PILOT01', fileName: 'f.csv', bytes: bytesB, sha256: sha256Bytes(bytesB) }),
    ImmutableConflictError
  );

  const uriA = `stratus://${BUCKET}/PILOT01/run-001/${sha256Bytes(bytesA)}/f.csv`;
  const content = await a.get(uriA);
  assert.ok(content.equals(bytesA), 'original content must be untouched');
});

test('archive/stratus: put() rejects a supplied sha256 that does not match the bytes', async () => {
  const { archive } = openFakeArchive();
  const a = await archive;
  await assert.rejects(
    () => a.put({ runId: 'run-002', branchCode: 'PILOT01', fileName: 'g.csv', bytes: SAMPLE, sha256: 'deadbeef'.repeat(8) }),
    ArchiveShaMismatchError
  );
});

test('archive/stratus: get() verifies integrity — corrupted stored bytes throw ARCHIVE_INTEGRITY', async () => {
  const { archive, fake } = openFakeArchive();
  const a = await archive;
  const sha256 = sha256Bytes(SAMPLE);
  const uri = await a.put({ runId: 'run-003', branchCode: 'PILOT01', fileName: 'h.csv', bytes: SAMPLE, sha256 });

  const bucket = fake.app.stratus().bucket(BUCKET);
  bucket._corrupt(`PILOT01/run-003/${sha256}/h.csv`, Buffer.from('tampered bytes, does not match sha256'));

  await assert.rejects(() => a.get(uri), ArchiveIntegrityError);
});

test('archive/stratus: exists() is false for a uri that was never written', async () => {
  const { archive } = openFakeArchive();
  const a = await archive;
  assert.equal(await a.exists(`stratus://${BUCKET}/PILOT01/run-999/${'0'.repeat(64)}/nope.csv`), false);
});

test('archive/stratus: an object key over 255 characters throws KEY_TOO_LONG', async () => {
  const { archive } = openFakeArchive();
  const a = await archive;
  const longFileName = `${'x'.repeat(220)}.csv`;
  await assert.rejects(
    () => a.put({ runId: 'run-001', branchCode: 'PILOT01', fileName: longFileName, bytes: SAMPLE, sha256: sha256Bytes(SAMPLE) }),
    KeyTooLongError
  );
});

test('archive/stratus: different fileName or run under the same branch never conflicts', async () => {
  const { archive } = openFakeArchive();
  const a = await archive;
  const bytes1 = Buffer.from('one,1\n');
  const bytes2 = Buffer.from('two,2\n');
  await a.put({ runId: 'run-001', branchCode: 'PILOT01', fileName: 'a.csv', bytes: bytes1, sha256: sha256Bytes(bytes1) });
  await a.put({ runId: 'run-001', branchCode: 'PILOT01', fileName: 'b.csv', bytes: bytes2, sha256: sha256Bytes(bytes2) });
  await a.put({ runId: 'run-002', branchCode: 'PILOT01', fileName: 'a.csv', bytes: bytes2, sha256: sha256Bytes(bytes2) });
  assert.ok(true, 'no throw means success');
});

test('archive/index: dispatches to the stratus adapter (backward-compat stub with no app/transport)', async () => {
  const archive = await openDispatchArchive({ adapter: 'stratus' });
  await assert.rejects(() => archive.put({}), { code: 'NOT_IMPLEMENTED' });
  await assert.rejects(() => archive.exists('x'), { code: 'NOT_IMPLEMENTED' });
  await assert.rejects(() => archive.get('x'), { code: 'NOT_IMPLEMENTED' });
});

test('archive/index: dispatches to the stratus adapter with an injected fake transport', async () => {
  const fake = createStratusFake();
  const archive = await openDispatchArchive({ adapter: 'stratus', transport: fake.app, bucketName: BUCKET });
  const sha256 = sha256Bytes(SAMPLE);
  const uri = await archive.put({ runId: 'run-001', branchCode: 'PILOT01', fileName: 'dispatch.csv', bytes: SAMPLE, sha256 });
  assert.equal(await archive.exists(uri), true);
});
