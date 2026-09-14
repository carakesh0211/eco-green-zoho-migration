import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateManifest, validateHeader, TRANSACTIONS_COLUMNS, TRIAL_BALANCE_COLUMNS,
} from '../src/core/manifest.js';

function baseManifest(overrides = {}) {
  return {
    contract_version: '1.0',
    extraction_run_id: 'PILOT01-2026-04-run-001',
    source_system: 'ECO_GREEN',
    query_id: 'EG_ACCT_VOUCHERS',
    query_name: 'Accounting vouchers with lines',
    query_version: 'v3',
    sql_hash: 'sha256:deadbeef',
    branch_code: 'PILOT01',
    from_date: '2026-04-01',
    to_date: '2026-05-31',
    currency: 'INR',
    extracted_at: '2026-09-13T18:05:00+05:30',
    source_operator_or_job: 'eg-extract-cron',
    files: [
      {
        file_name: 'transactions.csv', file_role: 'TRANSACTIONS', sha256: 'a'.repeat(64),
        row_count: 10, debit_total: '100.00', credit_total: '100.00', encoding: 'utf-8', delimiter: ',',
      },
      {
        file_name: 'trial_balance.csv', file_role: 'TRIAL_BALANCE', sha256: 'b'.repeat(64),
        row_count: 5, debit_total: '500.00', credit_total: '500.00', encoding: 'utf-8', delimiter: ',',
      },
    ],
    ...overrides,
  };
}

test('accepts a well-formed manifest', () => {
  const result = validateManifest(baseManifest());
  assert.equal(result.ok, true);
  assert.equal(result.manifest.extraction_run_id, 'PILOT01-2026-04-run-001');
});

test('never throws on non-object input', () => {
  assert.doesNotThrow(() => validateManifest(null));
  assert.doesNotThrow(() => validateManifest(undefined));
  assert.doesNotThrow(() => validateManifest('nope'));
  assert.doesNotThrow(() => validateManifest([1, 2, 3]));
  const result = validateManifest(42);
  assert.equal(result.ok, false);
});

test('rejects an unknown contract_version', () => {
  const result = validateManifest(baseManifest({ contract_version: '2.0' }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === 'UNSUPPORTED_CONTRACT_VERSION'));
});

for (const field of [
  'contract_version', 'extraction_run_id', 'source_system', 'query_id', 'query_name',
  'query_version', 'sql_hash', 'branch_code', 'from_date', 'to_date', 'currency',
  'extracted_at', 'source_operator_or_job',
]) {
  test(`rejects a manifest missing required field: ${field}`, () => {
    const m = baseManifest();
    delete m[field];
    const result = validateManifest(m);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.code === 'MISSING_FIELD' && e.path === field));
  });
}

test('rejects a bad from_date', () => {
  const result = validateManifest(baseManifest({ from_date: '2026-13-40' }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === 'INVALID_DATE' && e.path === 'from_date'));
});

test('rejects a bad to_date', () => {
  const result = validateManifest(baseManifest({ to_date: 'not-a-date' }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === 'INVALID_DATE' && e.path === 'to_date'));
});

test('rejects from_date > to_date', () => {
  const result = validateManifest(baseManifest({ from_date: '2026-06-01', to_date: '2026-05-01' }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === 'DATE_RANGE_INVALID'));
});

test('accepts from_date === to_date', () => {
  const result = validateManifest(baseManifest({ from_date: '2026-05-01', to_date: '2026-05-01' }));
  assert.equal(result.ok, true);
});

test('rejects an empty files array', () => {
  const result = validateManifest(baseManifest({ files: [] }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === 'EMPTY_FILES'));
});

test('rejects a missing TRANSACTIONS file role', () => {
  const m = baseManifest();
  m.files = m.files.filter((f) => f.file_role !== 'TRANSACTIONS');
  const result = validateManifest(m);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === 'MISSING_FILE_ROLE' && e.message.includes('TRANSACTIONS')));
});

test('rejects a missing TRIAL_BALANCE file role', () => {
  const m = baseManifest();
  m.files = m.files.filter((f) => f.file_role !== 'TRIAL_BALANCE');
  const result = validateManifest(m);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === 'MISSING_FILE_ROLE' && e.message.includes('TRIAL_BALANCE')));
});

test('rejects duplicate file roles (two TRANSACTIONS files)', () => {
  const m = baseManifest();
  m.files.push({ ...m.files[0], file_name: 'transactions2.csv', sha256: 'c'.repeat(64) });
  const result = validateManifest(m);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === 'DUPLICATE_FILE_ROLE'));
});

test('rejects an unknown file_role', () => {
  const m = baseManifest();
  m.files[0].file_role = 'MYSTERY';
  const result = validateManifest(m);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === 'INVALID_FILE_ROLE'));
});

test('rejects a non-money debit_total/credit_total', () => {
  const m = baseManifest();
  m.files[0].debit_total = 'not-money';
  const result = validateManifest(m);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === 'INVALID_MONEY' && e.path.includes('debit_total')));
});

test('rejects money with more than 2 decimal places', () => {
  const m = baseManifest();
  m.files[0].credit_total = '100.123';
  const result = validateManifest(m);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === 'INVALID_MONEY' && e.path.includes('credit_total')));
});

test('rejects a negative or non-integer row_count', () => {
  const m = baseManifest();
  m.files[0].row_count = -1;
  const result = validateManifest(m);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === 'INVALID_ROW_COUNT'));
});

test('rejects a file entry missing required fields', () => {
  const m = baseManifest();
  delete m.files[0].sha256;
  const result = validateManifest(m);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === 'MISSING_FIELD' && e.path.endsWith('.sha256')));
});

test('accumulates multiple independent errors in one pass', () => {
  const m = baseManifest({ contract_version: '9.9', from_date: 'bad', files: [] });
  const result = validateManifest(m);
  assert.equal(result.ok, false);
  const codes = result.errors.map((e) => e.code);
  assert.ok(codes.includes('UNSUPPORTED_CONTRACT_VERSION'));
  assert.ok(codes.includes('INVALID_DATE'));
  assert.ok(codes.includes('EMPTY_FILES'));
});

// --- validateHeader ---

test('validateHeader matches TRANSACTIONS_COLUMNS regardless of order', () => {
  const shuffled = [...TRANSACTIONS_COLUMNS].reverse();
  const result = validateHeader(shuffled, TRANSACTIONS_COLUMNS);
  assert.deepEqual(result, { ok: true, missing: [], extra: [] });
});

test('validateHeader matches TRIAL_BALANCE_COLUMNS regardless of order', () => {
  const shuffled = [...TRIAL_BALANCE_COLUMNS].reverse();
  const result = validateHeader(shuffled, TRIAL_BALANCE_COLUMNS);
  assert.deepEqual(result, { ok: true, missing: [], extra: [] });
});

test('validateHeader reports missing columns', () => {
  const header = TRANSACTIONS_COLUMNS.filter((c) => c !== 'ledger_code');
  const result = validateHeader(header, TRANSACTIONS_COLUMNS);
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, ['ledger_code']);
  assert.deepEqual(result.extra, []);
});

test('validateHeader reports extra/unexpected columns', () => {
  const header = [...TRANSACTIONS_COLUMNS, 'some_unexpected_column'];
  const result = validateHeader(header, TRANSACTIONS_COLUMNS);
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.extra, ['some_unexpected_column']);
});

test('validateHeader is exact-name (case-sensitive) matching', () => {
  const header = TRANSACTIONS_COLUMNS.map((c) => (c === 'ledger_code' ? 'Ledger_Code' : c));
  const result = validateHeader(header, TRANSACTIONS_COLUMNS);
  assert.equal(result.ok, false);
  assert.ok(result.missing.includes('ledger_code'));
  assert.ok(result.extra.includes('Ledger_Code'));
});
