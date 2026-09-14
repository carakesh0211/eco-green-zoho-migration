#!/usr/bin/env node
// scripts/seed-fixtures.js (CONTRACTS.md §P). Idempotent dev/CI bootstrap:
//   1. copies fixtures/synthetic/branch-PILOT01/* into INBOX_LOCAL_PATH/<branch>/<run>
//   2. upserts config/cutover-matrix.json via cutover.loadCutoverMatrix
//   3. upserts config/mapping-rules.json via mapping.loadMappingRules
//   4. inserts/updates the `branches` row for PILOT01 (zoho_location_id LOC-PILOT01)
//   5. loads config/smart-pharma-evidence.json, transforms it into the mock Books
//      client's seedRecords() shape, and returns both forms for scripts/run-pipeline.js
import { readdir, mkdir, cp, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCutoverMatrix } from '../src/core/cutover.js';
import { loadMappingRules } from '../src/core/mapping.js';
import { nowIso } from '../src/core/ids.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

const DEFAULT_FIXTURES_ROOT = path.join(PROJECT_ROOT, 'fixtures', 'synthetic');
const DEFAULT_CONFIG_ROOT = path.join(PROJECT_ROOT, 'config');
const PILOT_BRANCH = 'PILOT01';
const PILOT_LOCATION_ID = 'LOC-PILOT01';

async function pathExists(p) {
  try { await stat(p); return true; } catch { return false; }
}

/** Copies every run folder under fixtures/synthetic/branch-<branch>/* into
 * <inboxRoot>/<branch>/<run>/*, overwriting so re-running is safe. */
async function copyFixtureRuns({ fixturesRoot, inboxRoot, branch = PILOT_BRANCH }) {
  const branchFixtureDir = path.join(fixturesRoot, `branch-${branch}`);
  if (!(await pathExists(branchFixtureDir))) {
    return { branch, copiedRuns: [] };
  }
  const entries = await readdir(branchFixtureDir, { withFileTypes: true });
  const copiedRuns = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const src = path.join(branchFixtureDir, entry.name);
    const dest = path.join(inboxRoot, branch, entry.name);
    await mkdir(dest, { recursive: true });
    await cp(src, dest, { recursive: true, force: true });
    copiedRuns.push(entry.name);
  }
  return { branch, copiedRuns };
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

/** config/mapping-rules.json uses the column name `approval_status`; mapping.js's
 * loadMappingRules() reads `row.status`. Documented field-name mismatch — mapped here
 * rather than changing either owned-elsewhere file. */
function normalizeMappingRow(row) {
  const { approval_status, ...rest } = row;
  return { ...rest, status: approval_status ?? row.status };
}

async function upsertBranch(store, { branchCode = PILOT_BRANCH, zohoLocationId = PILOT_LOCATION_ID } = {}) {
  const now = nowIso();
  const existing = await store.findOne('branches', { branch_code: branchCode });
  if (existing) {
    if (existing.zoho_location_id === zohoLocationId) return existing;
    return store.update('branches', branchCode, { zoho_location_id: zohoLocationId, updated_at: now });
  }
  return store.insert('branches', {
    branch_code: branchCode,
    branch_name: `Pilot branch ${branchCode}`,
    zoho_location_id: zohoLocationId,
    status: 'ACTIVE',
    created_at: now,
    updated_at: now,
  });
}

/** Transforms DATA_CONTRACT.md §7 Smart Pharma evidence rows into the shape
 * src/books/mock.js#seedRecords expects. Kept separate from the evidence rows
 * themselves (spEvidence) which overlap.js#classifyRun consumes directly. */
function toMockSeedRecords(spEvidence) {
  return spEvidence.map((row) => ({
    id: row.books_record_id ?? undefined,
    module: row.books_module,
    date: row.business_date,
    sp_batch_ref: row.sp_batch_ref,
    custom_fields: {},
  }));
}

/**
 * @param {object} ctx - { store, audit, correlationId, actor }
 * @param {object} [opts]
 * @param {string} [opts.inboxRoot] - defaults to INBOX_LOCAL_PATH env or ./var/inbox
 * @param {string} [opts.fixturesRoot] - defaults to fixtures/synthetic
 * @param {string} [opts.configRoot] - defaults to ./config
 * @param {object} [opts.client] - a Books client (mock); if given, seedRecords() is
 *   called on it directly with the transformed Smart Pharma evidence.
 */
export async function seedFixtures(ctx, opts = {}) {
  const { store } = ctx;
  const inboxRoot = opts.inboxRoot ?? process.env.INBOX_LOCAL_PATH ?? path.join(PROJECT_ROOT, 'var', 'inbox');
  const fixturesRoot = opts.fixturesRoot ?? DEFAULT_FIXTURES_ROOT;
  const configRoot = opts.configRoot ?? DEFAULT_CONFIG_ROOT;

  await mkdir(inboxRoot, { recursive: true });
  const { copiedRuns } = await copyFixtureRuns({ fixturesRoot, inboxRoot, branch: PILOT_BRANCH });

  const cutoverPath = path.join(configRoot, 'cutover-matrix.json');
  const mappingPath = path.join(configRoot, 'mapping-rules.json');
  const evidencePath = path.join(configRoot, 'smart-pharma-evidence.json');

  const cutoverRaw = (await pathExists(cutoverPath)) ? await readJson(cutoverPath) : [];
  const mappingRaw = (await pathExists(mappingPath)) ? await readJson(mappingPath) : [];
  const spEvidence = (await pathExists(evidencePath)) ? await readJson(evidencePath) : [];

  // branches must exist before cutover_matrix rows can reference it (FK).
  const branch = await upsertBranch(store);

  const cutoverRows = cutoverRaw.length ? await loadCutoverMatrix(ctx, cutoverRaw) : [];
  const mappingRows = mappingRaw.length ? await loadMappingRules(ctx, mappingRaw.map(normalizeMappingRow)) : [];

  const mockSeedRecords = toMockSeedRecords(spEvidence);
  if (opts.client && typeof opts.client.seedRecords === 'function' && mockSeedRecords.length) {
    opts.client.seedRecords(mockSeedRecords);
  }

  return {
    inboxRoot, copiedRuns, branch, cutoverRows, mappingRows, spEvidence, mockSeedRecords,
  };
}

async function runCli() {
  const { openStore } = await import('../src/adapters/store/index.js');
  const { createAudit } = await import('../src/core/audit.js');
  const { newCorrelationId } = await import('../src/core/ids.js');

  const store = await openStore({});
  const audit = createAudit(store);
  const ctx = { store, audit, correlationId: newCorrelationId(), actor: 'seed-fixtures', actorRole: 'admin' };

  const result = await seedFixtures(ctx);
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({
    inboxRoot: result.inboxRoot,
    copiedRuns: result.copiedRuns,
    branch: result.branch.branch_code,
    cutoverRows: result.cutoverRows.length,
    mappingRows: result.mappingRows.length,
    spEvidenceRows: result.spEvidence.length,
  }, null, 2));

  await store.close();
}

const isMainModule = (() => {
  try {
    return process.argv[1] && (process.argv[1].endsWith('seed-fixtures.js'));
  } catch {
    return false;
  }
})();

if (isMainModule) {
  runCli().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('seed-fixtures failed:', err);
    process.exitCode = 1;
  });
}
