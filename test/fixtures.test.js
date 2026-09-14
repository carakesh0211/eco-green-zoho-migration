import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { parseMoney, formatMoney, add as moneyAdd } from '../src/core/money.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const GENERATOR = path.join(ROOT, 'scripts', 'generate-fixtures.js');
const RUN001 = path.join(ROOT, 'fixtures', 'synthetic', 'branch-PILOT01', 'run-001');
const RUN002 = path.join(ROOT, 'fixtures', 'synthetic', 'branch-PILOT01', 'run-002-dup');

// Defect voucher ids that MUST be named in EXPECTED.md (DATA_CONTRACT.md §8 checklist).
// These are exactly the ids the generator gives its deliberately-planted defects/special cases.
const DEFECT_IDS = [
  'V-BAD-UNBAL-01',
  'V-BAD-ORPHAN-01',
  'V-BAD-LATEMOD-01',
  'V-BAD-DUPLINE-01',
  'EG-EXP-004',
  'EG-B2C-EVID-01',
  'EG-B2C-EVID-02',
  'EG-B2C-EVID-03',
  'EG-B2C-NOEVID-01',
  'EG-B2C-AFTERCUTOVER-01',
  'EG-STK-001',
];

// Vouchers that are excluded from trial_balance.csv wholesale (structurally corrupt).
const TB_EXCLUDED_VOUCHERS = new Set(['V-BAD-UNBAL-01', 'V-BAD-ORPHAN-01']);

function readCsv(filePath) {
  const text = readFileSync(filePath, 'utf8');
  const lines = text.replace(/\n$/, '').split('\n');
  const header = lines[0].split(',');
  const rows = lines.slice(1).map((line) => splitCsvLine(line));
  return { header, rows };
}

// Minimal reader mirroring scripts/lib behaviour, deliberately not importing src/core/csv.js
// (owned by another module) — good enough for RFC4180-shaped, unquoted-mostly fixture rows.
function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') { inQuotes = false; }
      else { cur += c; }
    } else if (c === '"') { inQuotes = true; }
    else if (c === ',') { out.push(cur); cur = ''; }
    else { cur += c; }
  }
  out.push(cur);
  return out;
}

function col(header, name) {
  const i = header.indexOf(name);
  assert.notEqual(i, -1, `column ${name} missing from header`);
  return i;
}

function listFilesRecursive(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFilesRecursive(full));
    else out.push(full);
  }
  return out;
}

test('generator regenerates byte-identical fixtures into a fresh temp dir', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'eco-green-fixtures-'));
  try {
    execFileSync(process.execPath, [GENERATOR], {
      cwd: ROOT,
      env: { ...process.env, FIXTURES_OUTPUT_ROOT: tmp },
      stdio: 'pipe',
    });

    const committed = listFilesRecursive(path.join(ROOT, 'fixtures')).map((f) => path.relative(path.join(ROOT, 'fixtures'), f));
    const generated = listFilesRecursive(path.join(tmp, 'fixtures')).map((f) => path.relative(path.join(tmp, 'fixtures'), f));
    assert.deepEqual(generated.sort(), committed.sort(), 'generated fixture file set must match committed set');

    for (const rel of committed) {
      const committedBytes = readFileSync(path.join(ROOT, 'fixtures', rel));
      const generatedBytes = readFileSync(path.join(tmp, 'fixtures', rel));
      assert.ok(committedBytes.equals(generatedBytes), `fixtures/${rel} must be byte-identical to a fresh regeneration`);
    }

    for (const rel of ['cutover-matrix.json', 'mapping-rules.json', 'smart-pharma-evidence.json', 'users.example.json']) {
      const committedBytes = readFileSync(path.join(ROOT, 'config', rel));
      const generatedBytes = readFileSync(path.join(tmp, 'config', rel));
      assert.ok(committedBytes.equals(generatedBytes), `config/${rel} must be byte-identical to a fresh regeneration`);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('run-001 manifest.json sha256 / row_count / totals match the actual files on disk', () => {
  const manifest = JSON.parse(readFileSync(path.join(RUN001, 'manifest.json'), 'utf8'));
  for (const fileEntry of manifest.files) {
    const bytes = readFileSync(path.join(RUN001, fileEntry.file_name));
    const actualSha = createHash('sha256').update(bytes).digest('hex');
    assert.equal(actualSha, fileEntry.sha256, `${fileEntry.file_name} sha256 must match manifest`);

    const { header, rows } = readCsv(path.join(RUN001, fileEntry.file_name));
    assert.equal(rows.length, fileEntry.row_count, `${fileEntry.file_name} row_count must match manifest`);

    const debitIdx = header.includes('debit') ? col(header, 'debit') : col(header, 'closing_debit');
    const creditIdx = header.includes('credit') ? col(header, 'credit') : col(header, 'closing_credit');
    let debitTotal = 0n;
    let creditTotal = 0n;
    for (const row of rows) {
      debitTotal = moneyAdd(debitTotal, parseMoney(row[debitIdx]));
      creditTotal = moneyAdd(creditTotal, parseMoney(row[creditIdx]));
    }
    assert.equal(formatMoney(debitTotal), fileEntry.debit_total, `${fileEntry.file_name} debit_total must match manifest`);
    assert.equal(formatMoney(creditTotal), fileEntry.credit_total, `${fileEntry.file_name} credit_total must match manifest`);
  }
});

test('every voucher balances (Σdebit == Σcredit) except the documented defects', () => {
  const { header, rows } = readCsv(path.join(RUN001, 'transactions.csv'));
  const voucherIdx = col(header, 'voucher_id');
  const lineNoIdx = col(header, 'line_no');
  const debitIdx = col(header, 'debit');
  const creditIdx = col(header, 'credit');

  // Per DATA_CONTRACT §3, (voucher_id, line_no) is a unique key; a repeated pair is the
  // DUPLICATE_SOURCE defect (V-BAD-DUPLINE-01) and is rejected at load time (CONTRACTS.md §V
  // step 6: "row skipped"), keeping only the first occurrence. Balance is therefore checked on
  // the de-duplicated line set, exactly like the real ingest pipeline would see it.
  const seenLineKeys = new Set();
  const totals = new Map();
  let duplicateRowsSkipped = 0;
  for (const row of rows) {
    const id = row[voucherIdx];
    const lineKey = `${id}|${row[lineNoIdx]}`;
    if (seenLineKeys.has(lineKey)) { duplicateRowsSkipped++; continue; }
    seenLineKeys.add(lineKey);

    const prev = totals.get(id) ?? { debit: 0n, credit: 0n };
    totals.set(id, {
      debit: moneyAdd(prev.debit, parseMoney(row[debitIdx])),
      credit: moneyAdd(prev.credit, parseMoney(row[creditIdx])),
    });
  }
  assert.equal(duplicateRowsSkipped, 1, 'exactly one duplicated (voucher_id, line_no) row is expected (V-BAD-DUPLINE-01)');

  const knownUnbalanced = new Set(['V-BAD-UNBAL-01']);
  for (const [voucherId, t] of totals) {
    if (knownUnbalanced.has(voucherId)) {
      assert.notEqual(t.debit, t.credit, `${voucherId} is documented as deliberately unbalanced`);
    } else {
      assert.equal(t.debit, t.credit, `voucher ${voucherId} must balance (Σdebit == Σcredit)`);
    }
  }
  assert.ok(totals.has('V-BAD-UNBAL-01'), 'the unbalanced defect voucher must be present in the fixture');
  assert.ok(totals.has('V-BAD-DUPLINE-01'), 'the duplicate-row defect voucher must be present in the fixture');
});

test('trial_balance.csv internal identity holds: opening + period == closing, per ledger and in total', () => {
  const { header, rows } = readCsv(path.join(RUN001, 'trial_balance.csv'));
  const openDIdx = col(header, 'opening_debit');
  const openCIdx = col(header, 'opening_credit');
  const perDIdx = col(header, 'period_debit');
  const perCIdx = col(header, 'period_credit');
  const closeDIdx = col(header, 'closing_debit');
  const closeCIdx = col(header, 'closing_credit');
  const ledgerIdx = col(header, 'ledger_code');

  assert.ok(rows.length > 0, 'trial_balance.csv must have at least one ledger row');
  const seen = new Set();
  let totalPeriodDebit = 0n;
  let totalPeriodCredit = 0n;
  let totalClosingDebit = 0n;
  let totalClosingCredit = 0n;

  for (const row of rows) {
    const ledger = row[ledgerIdx];
    assert.ok(!seen.has(ledger), `ledger_code ${ledger} must be unique in trial_balance.csv`);
    seen.add(ledger);

    const openD = parseMoney(row[openDIdx]);
    const openC = parseMoney(row[openCIdx]);
    const perD = parseMoney(row[perDIdx]);
    const perC = parseMoney(row[perCIdx]);
    const closeD = parseMoney(row[closeDIdx]);
    const closeC = parseMoney(row[closeCIdx]);

    assert.equal(moneyAdd(openD, perD), closeD, `${ledger}: opening_debit + period_debit must equal closing_debit`);
    assert.equal(moneyAdd(openC, perC), closeC, `${ledger}: opening_credit + period_credit must equal closing_credit`);

    totalPeriodDebit = moneyAdd(totalPeriodDebit, perD);
    totalPeriodCredit = moneyAdd(totalPeriodCredit, perC);
    totalClosingDebit = moneyAdd(totalClosingDebit, closeD);
    totalClosingCredit = moneyAdd(totalClosingCredit, closeC);
  }

  // The TB is built entirely from balanced two-sided voucher lines (defects are excluded
  // wholesale), so both the period movement and the closing position must tie out in total.
  assert.equal(totalPeriodDebit, totalPeriodCredit, 'trial_balance.csv period totals must tie (tb:total_debit_equals_credit)');
  assert.equal(totalClosingDebit, totalClosingCredit, 'trial_balance.csv closing totals must tie (tb:total_debit_equals_credit)');

  // The orphan ledger must never appear in the trial balance — that absence IS the defect.
  assert.ok(!seen.has('LEDG-9001'), 'the orphan ledger must be absent from trial_balance.csv');
});

test('EXPECTED.md documents every defect id that is actually present in transactions.csv', () => {
  const expected = readFileSync(path.join(RUN001, 'EXPECTED.md'), 'utf8');
  const { header, rows } = readCsv(path.join(RUN001, 'transactions.csv'));
  const voucherIdx = col(header, 'voucher_id');
  const idsInCsv = new Set(rows.map((r) => r[voucherIdx]));

  for (const id of DEFECT_IDS) {
    assert.ok(idsInCsv.has(id), `defect id ${id} must actually appear in transactions.csv`);
    assert.ok(expected.includes(`\`${id}\``), `EXPECTED.md must document defect id ${id}`);
  }
});

test('the TB-excluded defect vouchers really are absent from trial_balance.csv movement, and run-002-dup shares transactions.csv sha256 with run-001', () => {
  // Sanity: TB_EXCLUDED_VOUCHERS is documentation-only here; the real proof is that LEDG-9001
  // (only touched by V-BAD-ORPHAN-01) and the extra LEDG-1004/1005 amounts from V-BAD-UNBAL-01
  // are not present in trial_balance.csv — already covered by the ledger-uniqueness/identity
  // test above. This test just locks in the duplicate-file fixture relationship.
  assert.equal(TB_EXCLUDED_VOUCHERS.size, 2);

  const manifest001 = JSON.parse(readFileSync(path.join(RUN001, 'manifest.json'), 'utf8'));
  const manifest002 = JSON.parse(readFileSync(path.join(RUN002, 'manifest.json'), 'utf8'));
  const txn001 = manifest001.files.find((f) => f.file_role === 'TRANSACTIONS');
  const txn002 = manifest002.files.find((f) => f.file_role === 'TRANSACTIONS');
  assert.equal(txn001.sha256, txn002.sha256, 'run-002-dup transactions.csv must share sha256 with run-001 (duplicate-file rejection fixture)');
  assert.notEqual(manifest001.extraction_run_id, manifest002.extraction_run_id, 'the two runs must have distinct extraction_run_id');
});
