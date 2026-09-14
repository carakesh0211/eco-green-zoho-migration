import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openArchive as openLocalArchive, ImmutableConflictError } from '../src/adapters/archive/local.js';
import { openArchive as openDispatchArchive } from '../src/adapters/archive/index.js';
import { openArchive as openStratusArchive } from '../src/adapters/archive/stratus.js';
import { sha256Bytes } from '../src/core/hash.js';

async function withTempArchive(fn) {
  const root = await mkdtemp(path.join(tmpdir(), 'archive-test-'));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('archive/local: put() writes bytes and get()/exists() round-trip', async () => {
  await withTempArchive(async (root) => {
    const archive = await openLocalArchive({ root });
    const bytes = Buffer.from('hello,world\n1,2\n');
    const sha256 = sha256Bytes(bytes);

    const uri = await archive.put({ runId: 'run-001', branchCode: 'PILOT01', fileName: 'transactions.csv', bytes, sha256 });
    assert.equal(uri, `local://PILOT01/run-001/${sha256}/transactions.csv`);

    assert.equal(await archive.exists(uri), true);
    const readBack = await archive.get(uri);
    assert.ok(readBack.equals(bytes));
  });
});

test('archive/local: put() computes sha256 when not provided and rejects a mismatched one', async () => {
  await withTempArchive(async (root) => {
    const archive = await openLocalArchive({ root });
    const bytes = Buffer.from('some content');
    const realSha = sha256Bytes(bytes);

    const uri = await archive.put({ runId: 'run-001', branchCode: 'PILOT01', fileName: 'f.csv', bytes });
    assert.equal(uri, `local://PILOT01/run-001/${realSha}/f.csv`);

    await assert.rejects(
      () => archive.put({ runId: 'run-002', branchCode: 'PILOT01', fileName: 'g.csv', bytes, sha256: 'deadbeef'.repeat(8) }),
      { code: 'ARCHIVE_SHA_MISMATCH' }
    );
  });
});

test('archive/local: put() with the same sha256 is idempotent (no-op, same uri)', async () => {
  await withTempArchive(async (root) => {
    const archive = await openLocalArchive({ root });
    const bytes = Buffer.from('identical bytes');
    const sha256 = sha256Bytes(bytes);

    const uri1 = await archive.put({ runId: 'run-001', branchCode: 'PILOT01', fileName: 'f.csv', bytes, sha256 });
    const uri2 = await archive.put({ runId: 'run-001', branchCode: 'PILOT01', fileName: 'f.csv', bytes, sha256 });
    assert.equal(uri1, uri2);

    const content = await archive.get(uri1);
    assert.ok(content.equals(bytes));
  });
});

test('archive/local: put() with different bytes at the same logical path throws IMMUTABLE_CONFLICT', async () => {
  await withTempArchive(async (root) => {
    const archive = await openLocalArchive({ root });
    const bytesA = Buffer.from('version A');
    const bytesB = Buffer.from('version B, totally different');

    await archive.put({ runId: 'run-001', branchCode: 'PILOT01', fileName: 'f.csv', bytes: bytesA, sha256: sha256Bytes(bytesA) });

    await assert.rejects(
      () => archive.put({ runId: 'run-001', branchCode: 'PILOT01', fileName: 'f.csv', bytes: bytesB, sha256: sha256Bytes(bytesB) }),
      ImmutableConflictError
    );

    // Original content must be untouched.
    const uriA = `local://PILOT01/run-001/${sha256Bytes(bytesA)}/f.csv`;
    const content = await archive.get(uriA);
    assert.ok(content.equals(bytesA));
  });
});

test('archive/local: exists() is false for a uri that was never written', async () => {
  await withTempArchive(async (root) => {
    const archive = await openLocalArchive({ root });
    assert.equal(await archive.exists('local://PILOT01/run-999/deadbeef/nope.csv'), false);
  });
});

test('archive/local: different fileName or run under the same branch never conflicts', async () => {
  await withTempArchive(async (root) => {
    const archive = await openLocalArchive({ root });
    const bytes1 = Buffer.from('one');
    const bytes2 = Buffer.from('two');
    await archive.put({ runId: 'run-001', branchCode: 'PILOT01', fileName: 'a.csv', bytes: bytes1, sha256: sha256Bytes(bytes1) });
    await archive.put({ runId: 'run-001', branchCode: 'PILOT01', fileName: 'b.csv', bytes: bytes2, sha256: sha256Bytes(bytes2) });
    await archive.put({ runId: 'run-002', branchCode: 'PILOT01', fileName: 'a.csv', bytes: bytes2, sha256: sha256Bytes(bytes2) });
    // No throw means success.
    assert.ok(true);
  });
});

test('archive/index: dispatches to the local adapter by default', async () => {
  await withTempArchive(async (root) => {
    const archive = await openDispatchArchive({ adapter: 'local', root });
    const bytes = Buffer.from('dispatch test');
    const uri = await archive.put({ runId: 'run-001', branchCode: 'PILOT01', fileName: 'd.csv', bytes, sha256: sha256Bytes(bytes) });
    assert.equal(await archive.exists(uri), true);
  });
});

test('archive/stratus: stub throws NOT_IMPLEMENTED for every method', async () => {
  const archive = await openStratusArchive();
  await assert.rejects(() => archive.put({}), { code: 'NOT_IMPLEMENTED' });
  await assert.rejects(() => archive.exists('x'), { code: 'NOT_IMPLEMENTED' });
  await assert.rejects(() => archive.get('x'), { code: 'NOT_IMPLEMENTED' });
});
