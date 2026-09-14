// Layer A reconciliation: extracted files / ledgers vs the manifest and trial balance.
import { parseMoney, formatMoney, withinTolerance, abs as moneyAbs } from './money.js';
import { newId, nowIso, uk } from './ids.js';
import { assertTransition, RUN_TRANSITIONS, RUN_STATES } from './states.js';
import { hashCanonical } from './hash.js';

// exceptions.js (§X) is owned by a concurrently-developed module; imported lazily so
// that this file — and its pure compareLayerA export — stays loadable/testable even
// before that module lands.
async function raiseException(ctx, args) {
  const { raise } = await import('./exceptions.js');
  return raise(ctx, args);
}

function moneyControl(control_key, expectedStr, actualStr, tolerancePaise, detail) {
  const expected = parseMoney(expectedStr);
  const actual = parseMoney(actualStr);
  const difference = actual - expected;
  const status = withinTolerance(actual, expected, tolerancePaise) ? 'MATCH' : 'DIFF';
  return {
    control_key,
    expected: formatMoney(expected),
    actual: formatMoney(actual),
    difference: formatMoney(difference),
    status,
    detail: detail ?? {},
  };
}

function intControl(control_key, expectedNum, actualNum, detail) {
  const e = Number(expectedNum) || 0;
  const a = Number(actualNum) || 0;
  const difference = a - e;
  return {
    control_key,
    expected: String(e),
    actual: String(a),
    difference: String(difference),
    status: difference === 0 ? 'MATCH' : 'DIFF',
    detail: detail ?? {},
  };
}

function missingControl(control_key, status, expected, actual, detail) {
  // '0.00' (not '') so `recon_results.difference` — a mandatory column on the Catalyst
  // Data Store schema (catalyst/iac/schema.catalyst.js; Catalyst rejects an empty string
  // for a mandatory column) — is always a valid, non-empty money string. A "missing"
  // control has no numeric diff to report anyway, so '0.00' preserves every downstream
  // reader's behaviour: `parseMoney('0.00')` is 0n, the same value `''`'s old falsy
  // short-circuit (`control.difference ? ... : 0n`) produced.
  return { control_key, expected, actual, difference: '0.00', status, detail: detail ?? {} };
}

/**
 * Pure. Compares manifest-declared file totals, per-ledger summary totals, and the
 * trial balance report, implementing every control in CONTRACTS.md §M.
 *
 * `manifest`   — validated manifest object ({ files: [{file_role, file_name, row_count,
 *                debit_total, credit_total}, ...] }).
 * `files`      — actually-observed per-file stats: [{file_role, file_name, row_count,
 *                debit_total, credit_total}, ...].
 * `summaries`  — summariseLines()-shaped rows ({ledger_code, voucher_type, debit, credit,
 *                txn_count, line_count}); only voucher_type === '*' rows are used here.
 *                A '*' row may optionally carry `voucher_ids: string[]` for drilldown.
 * `tbLines`    — trial_balance_lines-shaped rows ({ledger_code, opening_debit,
 *                opening_credit, period_debit, period_credit, closing_debit,
 *                closing_credit, txn_count}).
 * `tolerance`  — money tolerance string, default "0.00" (inclusive: diff == tolerance passes).
 *
 * -> { status: 'PASS'|'FAIL', controls: [{control_key, expected, actual, difference, status, detail}] }
 */
export function compareLayerA({ manifest, files = [], summaries = [], tbLines = [], tolerance = '0.00' }) {
  const tolerancePaise = parseMoney(tolerance);
  const controls = [];

  // --- file:<role>:row_count / debit_total / credit_total (manifest vs actual) ---
  const manifestFiles = manifest?.files ?? [];
  for (const mf of manifestFiles) {
    const role = mf.file_role;
    const actualFile = files.find((f) => f.file_role === role);
    const detail = { file_name: mf.file_name };
    if (!actualFile) {
      controls.push(missingControl(`file:${role}:row_count`, 'MISSING_ACTUAL', String(mf.row_count), '', detail));
      controls.push(missingControl(`file:${role}:debit_total`, 'MISSING_ACTUAL', mf.debit_total, '', detail));
      controls.push(missingControl(`file:${role}:credit_total`, 'MISSING_ACTUAL', mf.credit_total, '', detail));
      continue;
    }
    controls.push(intControl(`file:${role}:row_count`, mf.row_count, actualFile.row_count, detail));
    controls.push(moneyControl(`file:${role}:debit_total`, mf.debit_total, actualFile.debit_total, tolerancePaise, detail));
    controls.push(moneyControl(`file:${role}:credit_total`, mf.credit_total, actualFile.credit_total, tolerancePaise, detail));
  }

  // --- ledger:<code>:period_debit / period_credit / txn_count / balance_identity ---
  //     plus ledger:<code>:missing_in_tb / missing_in_csv
  const starSummaries = summaries.filter((s) => s.voucher_type === '*');
  const summaryByLedger = new Map(starSummaries.map((s) => [s.ledger_code, s]));
  const tbByLedger = new Map(tbLines.map((t) => [t.ledger_code, t]));
  const allLedgerCodes = [...new Set([...summaryByLedger.keys(), ...tbByLedger.keys()])].sort();

  for (const ledgerCode of allLedgerCodes) {
    let summary = summaryByLedger.get(ledgerCode);
    const tb = tbByLedger.get(ledgerCode);
    const voucherIds = summary?.voucher_ids ?? [];

    if (summary && !tb) {
      controls.push(missingControl(`ledger:${ledgerCode}:missing_in_tb`, 'MISSING_EXPECTED', 'PRESENT_IN_TB', 'ABSENT', { voucher_ids: voucherIds }));
      continue;
    }
    if (tb && !summary) {
      // A ledger that carries only an opening balance (no period movement, txn_count 0)
      // legitimately has no transactional lines; it is not "missing". Compare it as
      // zero-vs-zero so the balance_identity control still runs. Only a ledger the TB
      // says HAD activity is genuinely missing from the CSV.
      const tbHasActivity = parseMoney(tb.period_debit) !== 0n || parseMoney(tb.period_credit) !== 0n || Number(tb.txn_count ?? 0) !== 0;
      if (tbHasActivity) {
        controls.push(missingControl(`ledger:${ledgerCode}:missing_in_csv`, 'MISSING_ACTUAL', 'PRESENT_IN_CSV', 'ABSENT', {}));
        continue;
      }
      summary = { ledger_code: ledgerCode, voucher_type: '*', debit: '0.00', credit: '0.00', txn_count: 0, voucher_ids: [] };
    }

    const detail = { voucher_ids: voucherIds };
    controls.push(moneyControl(`ledger:${ledgerCode}:period_debit`, tb.period_debit, summary.debit, tolerancePaise, detail));
    controls.push(moneyControl(`ledger:${ledgerCode}:period_credit`, tb.period_credit, summary.credit, tolerancePaise, detail));
    controls.push(intControl(`ledger:${ledgerCode}:txn_count`, tb.txn_count, summary.txn_count, detail));

    const openingNet = parseMoney(tb.opening_debit) - parseMoney(tb.opening_credit);
    const periodNet = parseMoney(tb.period_debit) - parseMoney(tb.period_credit);
    const closingNet = parseMoney(tb.closing_debit) - parseMoney(tb.closing_credit);
    const computedClosing = openingNet + periodNet;
    const identityDiff = computedClosing - closingNet;
    controls.push({
      control_key: `ledger:${ledgerCode}:balance_identity`,
      expected: formatMoney(closingNet),
      actual: formatMoney(computedClosing),
      difference: formatMoney(identityDiff),
      status: withinTolerance(computedClosing, closingNet, tolerancePaise) ? 'MATCH' : 'DIFF',
      detail: {},
    });
  }

  // --- tb:total_debit_equals_credit (TB internal identity, closing balances) ---
  const totalDebit = tbLines.reduce((acc, t) => acc + parseMoney(t.closing_debit), 0n);
  const totalCredit = tbLines.reduce((acc, t) => acc + parseMoney(t.closing_credit), 0n);
  controls.push({
    control_key: 'tb:total_debit_equals_credit',
    expected: formatMoney(totalCredit),
    actual: formatMoney(totalDebit),
    difference: formatMoney(totalDebit - totalCredit),
    status: withinTolerance(totalDebit, totalCredit, tolerancePaise) ? 'MATCH' : 'DIFF',
    detail: {},
  });

  const status = controls.every((c) => c.status === 'MATCH') ? 'PASS' : 'FAIL';
  return { status, controls };
}

/**
 * Orchestrates Layer A for a run: loads manifest/files/summaries/trial-balance from
 * ctx.store, runs compareLayerA, persists recon_runs + recon_results, raises
 * RECONCILIATION_DIFFERENCE exceptions for every failing control, supports
 * PASS_WITH_APPROVED_EXCEPTIONS when every failing control's dedupe key already has
 * an APPROVED_EXCEPTION exception row, transitions the run, and emits audit 'RECON.A'.
 */
export async function reconcileLayerA(ctx, { runId, tolerance = '0.00' }) {
  const { store, audit, correlationId, actor, actorRole } = ctx;

  const run = await store.get('extraction_runs', runId);
  if (!run) {
    const err = new Error(`extraction_run not found: ${runId}`);
    err.code = 'RUN_NOT_FOUND';
    throw err;
  }

  const manifest = typeof run.manifest_json === 'string' ? JSON.parse(run.manifest_json) : run.manifest_json;
  const sourceFiles = await store.find('source_files', { run_id: runId });
  const files = sourceFiles.map((f) => ({
    file_role: f.file_role,
    file_name: f.file_name,
    row_count: f.actual_row_count,
    debit_total: f.actual_debit_total,
    credit_total: f.actual_credit_total,
  }));

  const persistedSummaries = await store.find('summaries', { run_id: runId });
  const summaryVersion = persistedSummaries[0]?.summary_version ?? 'sum_v1';

  const rawLines = await store.find('source_txn_lines', { run_id: runId });
  const voucherIdsByLedger = new Map();
  for (const line of rawLines) {
    if (!voucherIdsByLedger.has(line.ledger_code)) voucherIdsByLedger.set(line.ledger_code, new Set());
    voucherIdsByLedger.get(line.ledger_code).add(line.voucher_id);
  }
  const summaries = persistedSummaries.map((s) => (
    s.voucher_type === '*'
      ? { ...s, voucher_ids: [...(voucherIdsByLedger.get(s.ledger_code) ?? [])].sort() }
      : s
  ));

  const tbLines = await store.find('trial_balance_lines', { run_id: runId });

  const compared = compareLayerA({ manifest, files, summaries, tbLines, tolerance });

  const reconRunId = newId('recA');
  const fileSha256s = sourceFiles.map((f) => f.sha256).sort();
  const inputsVersion = hashCanonical({ runId, summaryVersion, fileSha256s });

  const failingControls = compared.controls.filter((c) => c.status !== 'MATCH');

  let finalStatus = compared.status; // PASS | FAIL
  if (failingControls.length > 0) {
    let allApproved = true;
    for (const control of failingControls) {
      const dedupeKey = `recon:${runId}:${control.control_key}`;
      // Check BEFORE raising: exceptions.raise() reopens an already-APPROVED_EXCEPTION
      // row to OPEN, so an unconditional raise here would clobber a prior approval
      // right before we check it. Only (re-)raise when it is not already approved.
      const existingRows = await store.find('exceptions', { dedupe_key: dedupeKey });
      const alreadyApproved = existingRows.some((r) => r.status === 'APPROVED_EXCEPTION');
      if (alreadyApproved) continue;

      allApproved = false;
      const impactPaise = control.difference ? moneyAbs(parseMoney(control.difference)) : 0n;
      await raiseException(ctx, {
        category: 'RECONCILIATION_DIFFERENCE',
        severity: 'P1',
        message: `Layer A control ${control.control_key} ${control.status}: expected ${control.expected}, actual ${control.actual}`,
        dedupeKey,
        branchCode: run.branch_code,
        period: run.from_date ? run.from_date.slice(0, 7) : undefined,
        runId,
        financialImpact: formatMoney(impactPaise),
        evidence: control.detail,
      });
    }
    finalStatus = allApproved ? 'PASS_WITH_APPROVED_EXCEPTIONS' : 'FAIL';
  }

  await store.insert('recon_runs', {
    id: reconRunId,
    run_id: runId,
    batch_id: null,
    layer: 'A',
    branch_code: run.branch_code,
    tolerance,
    status: finalStatus,
    summary_json: JSON.stringify({ controls: compared.controls.length, diffs: failingControls.length }),
    inputs_version: inputsVersion,
    created_by: actor,
    created_at: nowIso(),
  });

  for (const control of compared.controls) {
    await store.insert('recon_results', {
      recon_run_id: reconRunId,
      control_key: control.control_key,
      expected: control.expected,
      actual: control.actual,
      difference: control.difference,
      status: control.status,
      detail_json: JSON.stringify(control.detail ?? {}),
      uk: uk(reconRunId, control.control_key),
      created_at: nowIso(),
    });
  }

  const nextRunStatus = finalStatus === 'FAIL' ? RUN_STATES.SOURCE_RECON_FAILED : RUN_STATES.SOURCE_RECONCILED;
  assertTransition(RUN_TRANSITIONS, 'run', run.status, nextRunStatus);
  await store.update('extraction_runs', runId, { status: nextRunStatus, updated_at: nowIso() });

  await audit.emit({
    actor,
    actorRole,
    action: 'RECON.A',
    entityType: 'recon_runs',
    entityId: reconRunId,
    before: { run_status: run.status },
    after: { run_status: nextRunStatus, recon_status: finalStatus },
    correlationId,
    branchCode: run.branch_code,
    period: run.from_date ? run.from_date.slice(0, 7) : undefined,
  });

  return { reconRunId, status: finalStatus, controls: compared.controls.length, diffs: failingControls.length };
}
