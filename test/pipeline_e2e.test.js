// End-to-end evidence tests for Codex P2 (vacuous verification). Each test spawns the
// real scripts/run-pipeline.js against an ISOLATED state directory under ./var so the
// result is a clean proof, then reruns it to prove idempotency and that a zero-item
// rerun is reported as NOT evidence.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, rmSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts', 'run-pipeline.js');

function isolatedEnv() {
  const dir = path.join('var', `e2e-${randomUUID().slice(0, 8)}`);
  mkdirSync(path.join(ROOT, dir), { recursive: true });
  return {
    dir,
    env: {
      ...process.env,
      SQLITE_PATH: path.join(dir, 'migration.db'),
      INBOX_LOCAL_PATH: path.join(dir, 'inbox'),
      ARCHIVE_LOCAL_PATH: path.join(dir, 'archive'),
      BOOKS_DRIVER: 'mock',
      POSTING_ENABLED: 'false',
    },
  };
}

function runPipeline(env, args) {
  const r = spawnSync(process.execPath, [SCRIPT, '--branch', 'PILOT01', '--run', 'run-001', '--dry-run', ...args], {
    cwd: ROOT, env, encoding: 'utf8', timeout: 180_000,
  });
  const out = (r.stdout ?? '') + (r.stderr ?? '');
  return { status: r.status, out };
}

function counts(env) {
  const db = new DatabaseSync(path.join(ROOT, env.SQLITE_PATH), { readOnly: true });
  const one = (sql) => db.prepare(sql).get().n;
  const c = {
    vouchers: one('SELECT COUNT(*) n FROM vouchers'),
    queue: one('SELECT COUNT(*) n FROM queue_items'),
    posted: one("SELECT COUNT(*) n FROM queue_items WHERE status='POSTED'"),
    attempts: one('SELECT COUNT(*) n FROM api_attempts'),
    batches: one('SELECT COUNT(*) n FROM migration_batches'),
    runs: one('SELECT COUNT(*) n FROM extraction_runs'),
    zohoIds: one('SELECT COUNT(DISTINCT zoho_record_id) n FROM vouchers WHERE zoho_record_id IS NOT NULL'),
  };
  db.close();
  return c;
}

describe('run-pipeline end-to-end evidence (isolated state)', () => {
  test('fresh run posts every approved voucher (31/31) to the mock driver; rerun is idempotent and is NOT presented as evidence', { timeout: 400_000 }, () => {
    const { dir, env } = isolatedEnv();
    try {
      // 1. Clean end-to-end verification.
      const first = runPipeline(env, ['--fresh', '--approve-known-diffs', '--through-mock-books']);
      assert.equal(first.status, 0, first.out);
      assert.match(first.out, /MODE: FRESH ISOLATED VERIFICATION/);
      assert.match(first.out, /Ingest outcome: STAGED/);
      assert.match(first.out, /Layer A \(re-run after approving 7 known differences as finance\.lead\): PASS_WITH_APPROVED_EXCEPTIONS/);
      assert.match(first.out, /Layer B \(CSV -> approved population bridge\): PASS/);
      assert.match(first.out, /VERIFICATION: PASSED — 31\/31 approved vouchers posted/);
      assert.equal((first.out.match(/Layer C .*: PASS/g) ?? []).length, 2, 'both period batches must reach Layer C PASS');
      assert.equal((first.out.match(/Balance bridge: PASS/g) ?? []).length, 2);
      const c1 = counts(env);
      assert.equal(c1.vouchers, 40);
      assert.equal(c1.queue, 31);
      assert.equal(c1.posted, 31);
      assert.equal(c1.attempts, 31, 'exactly one API attempt per approved voucher');
      assert.equal(c1.zohoIds, 31, 'every posted voucher has a distinct target id');
      assert.equal(c1.batches, 2);

      // 2. Incremental rerun over the same state: no new work, no duplicates.
      const second = runPipeline(env, ['--approve-known-diffs']);
      assert.equal(second.status, 0, second.out);
      assert.match(second.out, /MODE: INCREMENTAL/);
      assert.match(second.out, /Ingest outcome: DUPLICATE_MANIFEST/);
      assert.match(second.out, /IDEMPOTENT RERUN: .*NOT end-to-end verification evidence/);
      const c2 = counts(env);
      assert.deepEqual(c2, c1, 'rerun must not create vouchers, queue items, attempts, batches or target ids');

      // 3. A rerun that asks for mock delivery over already-migrated state exercises zero
      //    items and MUST be reported as a failed verification, never as proof.
      const third = runPipeline(env, ['--approve-known-diffs', '--through-mock-books']);
      assert.equal(third.status, 3, third.out);
      assert.match(third.out, /VERIFICATION: FAILED/);
      assert.match(third.out, /0 queue items were exercised/);
      assert.doesNotMatch(third.out, /VERIFICATION: PASSED/);
      assert.deepEqual(counts(env), c1, 'a failed verification rerun still must not duplicate anything');
    } finally {
      rmSync(path.join(ROOT, dir), { recursive: true, force: true });
    }
  });

  test('--fresh refuses to wipe paths outside ./var', () => {
    const { dir, env } = isolatedEnv();
    try {
      const outside = path.join(ROOT, '..', 'definitely-not-var.db');
      const r = runPipeline({ ...env, SQLITE_PATH: outside }, ['--fresh']);
      assert.equal(r.status, 2, r.out);
      assert.match(r.out, /--fresh refuses to delete/);
      assert.equal(existsSync(outside), false);
    } finally {
      rmSync(path.join(ROOT, dir), { recursive: true, force: true });
    }
  });
});
