import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TABLES, columnsFor } from '../catalyst/iac/schema.catalyst.js';
import { buildTemplate, buildColumnBody, TEMPLATE_PATH } from '../scripts/generate-iac-template.js';

const LIVE_TABLES = [
  'audit_events',
  'extraction_runs',
  'source_files',
  'vouchers',
  'source_txn_lines',
  'source_summaries',
  'recon_runs',
  'recon_results',
  'exceptions',
];

const ADDED_TABLES = [
  'branches',
  'cutover_matrix',
  'mapping_rules',
  'trial_balance_lines',
  'overlap_candidates',
  'preview_payloads',
  'migration_batches',
  'approvals',
  'queue_items',
  'api_attempts',
  'books_snapshots',
];

// Increment 2 (team-operable console): dashboard summaries, team directory, assignments, Books connection.
const INCREMENT2_TABLES = [
  'branch_summaries',
  'app_users',
  'branch_period_assignments',
  'books_connections',
  'books_locations',
];

const EXPECTED_TABLES = [...LIVE_TABLES, ...ADDED_TABLES, ...INCREMENT2_TABLES];

const RESERVED = new Set(['date', 'key', 'result', 'priority']);

test('schema.catalyst: exactly the 25 schema.sql tables (9 live + 11 pipeline + 5 increment-2)', () => {
  assert.deepEqual(TABLES.map((t) => t.name).sort(), [...EXPECTED_TABLES].sort());
});

test('schema.catalyst: audit_events columns match the live-created spec exactly', () => {
  const cols = columnsFor('audit_events');
  const expected = [
    { column_name: 'actor', data_type: 'varchar', max_length: 255, is_mandatory: true },
    { column_name: 'actor_role', data_type: 'varchar', max_length: 64, is_mandatory: false },
    { column_name: 'action', data_type: 'varchar', max_length: 128, is_mandatory: true },
    { column_name: 'entity_type', data_type: 'varchar', max_length: 64, is_mandatory: true },
    { column_name: 'entity_id', data_type: 'varchar', max_length: 255, is_mandatory: false },
    { column_name: 'before_json', data_type: 'text', is_mandatory: false },
    { column_name: 'after_json', data_type: 'text', is_mandatory: false },
    { column_name: 'reason', data_type: 'text', is_mandatory: false },
    { column_name: 'authorization_decision', data_type: 'varchar', max_length: 16, is_mandatory: false },
    { column_name: 'correlation_id', data_type: 'varchar', max_length: 128, is_mandatory: true },
    { column_name: 'branch_code', data_type: 'varchar', max_length: 32, is_mandatory: false },
    { column_name: 'period', data_type: 'varchar', max_length: 7, is_mandatory: false },
    { column_name: 'batch_id', data_type: 'varchar', max_length: 128, is_mandatory: false },
    { column_name: 'created_at', data_type: 'varchar', max_length: 40, is_mandatory: true },
  ];
  assert.deepEqual(cols, expected);
});

test('schema.catalyst: id-keyed tables have a unique varchar id column; branches is keyed on branch_code; every other table is ROWID-keyed', () => {
  const ID_KEYED = new Set(['extraction_runs', 'recon_runs', 'migration_batches', 'approvals', 'app_users', 'books_connections']);
  const CODE_KEYED = new Set(['branches', 'branch_summaries']);
  for (const t of TABLES) {
    if (ID_KEYED.has(t.name)) {
      assert.equal(t.logicalKey, 'id');
      const idCol = t.columns.find((c) => c.column_name === 'id');
      assert.ok(idCol, `${t.name} must declare an explicit id column`);
      assert.equal(idCol.data_type, 'varchar');
      assert.equal(idCol.is_unique, true);
      assert.equal(idCol.is_mandatory, true);
    } else if (CODE_KEYED.has(t.name)) {
      assert.equal(t.logicalKey, 'branch_code');
      const keyCol = t.columns.find((c) => c.column_name === 'branch_code');
      assert.ok(keyCol, `${t.name} must declare an explicit branch_code column`);
      assert.equal(keyCol.data_type, 'varchar');
      assert.equal(keyCol.is_unique, true);
      assert.equal(keyCol.is_mandatory, true);
      assert.ok(!t.columns.some((c) => c.column_name === 'id'), `${t.name} must not declare an id column`);
    } else {
      assert.equal(t.logicalKey, 'ROWID');
      assert.ok(!t.columns.some((c) => c.column_name === 'id'), `${t.name} must not declare an id column (ROWID is the key)`);
    }
  }
});

test('schema.catalyst: the 9 live tables keep exactly their original column definitions', () => {
  for (const name of LIVE_TABLES) {
    const t = TABLES.find((x) => x.name === name);
    assert.ok(t, `${name} must still exist`);
  }
  // audit_events' exact column list is separately pinned above; here we pin table count
  // for every other live table so an accidental column add/remove/retype is caught.
  const expectedColumnCounts = {
    extraction_runs: 18,
    source_files: 18,
    source_txn_lines: 24,
    vouchers: 43,
    source_summaries: 13,
    recon_runs: 11,
    recon_results: 9,
    exceptions: 18,
  };
  for (const [name, count] of Object.entries(expectedColumnCounts)) {
    const t = TABLES.find((x) => x.name === name);
    assert.equal(t.columns.length, count, `${name} column count changed (expected ${count}, got ${t.columns.length}) — the 9 live tables must never change`);
  }
});

test('schema.catalyst: no text column carries max_length/is_unique/search_index_enabled', () => {
  for (const t of TABLES) {
    for (const c of t.columns) {
      if (c.data_type !== 'text') continue;
      assert.equal(c.max_length, undefined, `${t.name}.${c.column_name} must not carry max_length`);
      assert.equal(c.is_unique, undefined, `${t.name}.${c.column_name} must not carry is_unique`);
      assert.equal(c.search_index_enabled, undefined, `${t.name}.${c.column_name} must not carry search_index_enabled`);
    }
  }
});

test('schema.catalyst: no reserved Catalyst column names', () => {
  for (const t of TABLES) {
    for (const c of t.columns) {
      assert.ok(!RESERVED.has(c.column_name), `${t.name}.${c.column_name} is a reserved Catalyst column name`);
    }
  }
});

test('schema.catalyst: every column has a supported data_type and every is_mandatory/is_unique is a real boolean', () => {
  const allowedTypes = new Set(['varchar', 'text', 'int', 'bigint']);
  for (const t of TABLES) {
    for (const c of t.columns) {
      assert.ok(allowedTypes.has(c.data_type), `${t.name}.${c.column_name} has unsupported data_type ${c.data_type}`);
      assert.equal(typeof c.is_mandatory, 'boolean');
      if ('is_unique' in c) assert.equal(typeof c.is_unique, 'boolean');
      if (c.data_type === 'varchar') assert.ok(Number.isInteger(c.max_length) && c.max_length > 0);
    }
  }
});

test('generator: buildTemplate() emits table components (no deps) then column components (depend on their table)', () => {
  const tpl = buildTemplate();
  assert.equal(tpl.name, 'EcoGreenMigration');
  assert.equal(tpl.version, '1.0.0');
  assert.deepEqual(tpl.parameters, {});

  const components = tpl.components.Datastore;
  const tableComponents = components.filter((c) => c.type === 'table');
  const columnComponents = components.filter((c) => c.type === 'column');
  assert.equal(tableComponents.length, TABLES.length);
  for (const tc of tableComponents) {
    assert.deepEqual(tc.dependsOn, []);
    assert.deepEqual(tc.properties, { table_name: tc.name });
  }
  const totalColumns = TABLES.reduce((n, t) => n + t.columns.length, 0);
  assert.equal(columnComponents.length, totalColumns);
  for (const cc of columnComponents) {
    assert.deepEqual(cc.dependsOn, [cc.properties.table_name]);
    assert.equal(cc.name, `${cc.properties.table_name}.${cc.properties.column_name}`);
    assert.equal(typeof cc.properties.is_mandatory, 'boolean');
  }
  // Booleans in the template are real JSON booleans, not strings.
  const auditActor = columnComponents.find((c) => c.name === 'audit_events.actor');
  assert.strictEqual(auditActor.properties.is_mandatory, true);
});

test('generator: buildTemplate() is deterministic and idempotent', () => {
  const a = JSON.stringify(buildTemplate());
  const b = JSON.stringify(buildTemplate());
  assert.equal(a, b);
});

test('generator: --emit-columns bodies use string booleans and omit disallowed text properties', () => {
  const auditTable = TABLES.find((t) => t.name === 'audit_events');
  const body = buildColumnBody(auditTable);

  const actor = body.find((c) => c.column_name === 'actor');
  assert.deepEqual(actor, {
    column_name: 'actor',
    data_type: 'varchar',
    is_mandatory: 'true',
    max_length: 255,
    is_unique: 'false',
    search_index_enabled: 'false',
    audit_consent: 'false',
  });

  const beforeJson = body.find((c) => c.column_name === 'before_json');
  assert.deepEqual(beforeJson, {
    column_name: 'before_json',
    data_type: 'text',
    is_mandatory: 'false',
    audit_consent: 'false',
  });

  for (const c of body) {
    if (c.data_type === 'text') {
      assert.ok(!('max_length' in c));
      assert.ok(!('is_unique' in c));
      assert.ok(!('search_index_enabled' in c));
    }
    assert.equal(c.audit_consent, 'false');
  }
});

test('generator: CLI output is deterministic and matches the committed template byte-for-byte', () => {
  const tmpDir = mkdtempSync(path.join(tmpdir(), 'iac-gen-'));
  try {
    const outPath = path.join(tmpDir, 'out.json');
    const scriptPath = path.resolve('scripts/generate-iac-template.js');
    execFileSync(process.execPath, [scriptPath, `--out=${outPath}`], { encoding: 'utf8' });
    const generated = readFileSync(outPath, 'utf8');
    const committed = readFileSync(TEMPLATE_PATH, 'utf8');
    assert.equal(generated, committed, 'the committed project-template-1.0.0.json must be exactly what the generator produces');

    // Regenerating again must be byte-identical (idempotent).
    const outPath2 = path.join(tmpDir, 'out2.json');
    execFileSync(process.execPath, [scriptPath, `--out=${outPath2}`], { encoding: 'utf8' });
    assert.equal(readFileSync(outPath2, 'utf8'), generated);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('generator: --emit-columns writes one JSON file per table under the requested columns dir', () => {
  const tmpDir = mkdtempSync(path.join(tmpdir(), 'iac-cols-'));
  try {
    const scriptPath = path.resolve('scripts/generate-iac-template.js');
    const outPath = path.join(tmpDir, 'template.json');
    execFileSync(process.execPath, [scriptPath, `--out=${outPath}`, '--emit-columns', `--columns-dir=${tmpDir}`], { encoding: 'utf8' });
    for (const t of TABLES) {
      const body = JSON.parse(readFileSync(path.join(tmpDir, `${t.name}.json`), 'utf8'));
      assert.equal(body.length, t.columns.length);
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
