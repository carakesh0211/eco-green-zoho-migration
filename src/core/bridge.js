// Layer B — CSV population vs approved migration population bridge (CONTRACTS.md §K,
// PROJECT_CONTEXT "Layer B"). Proves: CSV population == MIGRATE + SMART_PHARMA_EXCLUDED
// + OTHER_EXCLUDED + BLOCKED (+ REJECTED_ROWS that never became vouchers), with zero
// PENDING left over. Debit==credit is NOT a bridge condition: an unbalanced source
// voucher is legitimately part of the population and must sit in BLOCKED (enforced by
// the UNBALANCED_VOUCHER exception at staging). The bridge instead asserts that no
// unbalanced voucher leaked into any other disposition.

import { parseMoney, formatMoney, sum } from './money.js';
import { nowIso } from './ids.js';

/**
 * Pure bridge computation over a run's vouchers.
 * vouchers: [{ id, disposition, debit_total, credit_total }]
 * -> { total: {count, debit, credit}, byDisposition: {[d]: {count, debit, credit, voucher_ids}},
 *      ties: boolean, pendingCount: number }
 */
export function computeBridge(vouchers) {
  const list = vouchers ?? [];
  const byDisposition = {};

  for (const v of list) {
    const d = v.disposition ?? 'PENDING';
    if (!byDisposition[d]) byDisposition[d] = { count: 0, debit: 0n, credit: 0n, voucher_ids: [] };
    byDisposition[d].count += 1;
    byDisposition[d].debit += parseMoney(v.debit_total);
    byDisposition[d].credit += parseMoney(v.credit_total);
    byDisposition[d].voucher_ids.push(v.id);
  }

  const totalDebit = sum(list.map(v => parseMoney(v.debit_total)));
  const totalCredit = sum(list.map(v => parseMoney(v.credit_total)));

  // Defensive identity check: the per-disposition partition must re-sum to the total.
  const subtotalCount = Object.values(byDisposition).reduce((n, g) => n + g.count, 0);
  const subtotalDebit = sum(Object.values(byDisposition).map(g => g.debit));
  const subtotalCredit = sum(Object.values(byDisposition).map(g => g.credit));
  const bridgeComplete = subtotalCount === list.length && subtotalDebit === totalDebit && subtotalCredit === totalCredit;

  const ties = bridgeComplete;
  const balanced = totalDebit === totalCredit;
  const unbalancedOutsideBlocked = list
    .filter(v => parseMoney(v.debit_total) !== parseMoney(v.credit_total) && (v.disposition ?? 'PENDING') !== 'BLOCKED')
    .map(v => v.id);

  const byDispositionFormatted = {};
  for (const [d, g] of Object.entries(byDisposition)) {
    byDispositionFormatted[d] = {
      count: g.count,
      debit: formatMoney(g.debit),
      credit: formatMoney(g.credit),
      voucher_ids: g.voucher_ids,
    };
  }

  return {
    total: { count: list.length, debit: formatMoney(totalDebit), credit: formatMoney(totalCredit) },
    byDisposition: byDispositionFormatted,
    ties,
    balanced,
    unbalancedOutsideBlocked,
    pendingCount: byDisposition.PENDING ? byDisposition.PENDING.count : 0,
  };
}

/**
 * Pure. Bridges the delivered TRANSACTIONS file to the voucher population plus rows that
 * were rejected at load (e.g. duplicate (voucher_id,line_no)). Every figure must tie:
 *   file.row_count    == sum(vouchers.line_count) + rejectedRows.length
 *   file.debit_total  == sum(vouchers.debit_total) + sum(rejectedRows.debit)
 *   file.credit_total == sum(vouchers.credit_total) + sum(rejectedRows.credit)
 * file: { row_count, debit_total, credit_total } (observed file stats, not the manifest)
 * rejectedRows: [{ debit, credit }]
 * -> { controls: [{control_key, expected, actual, difference, status}], rejected: {count, debit, credit} }
 */
export function compareBridgeToFile({ file, vouchers, rejectedRows = [] }) {
  const list = vouchers ?? [];
  const rejDebit = sum(rejectedRows.map(r => parseMoney(r.debit)));
  const rejCredit = sum(rejectedRows.map(r => parseMoney(r.credit)));
  const vDebit = sum(list.map(v => parseMoney(v.debit_total)));
  const vCredit = sum(list.map(v => parseMoney(v.credit_total)));
  const vRows = list.reduce((n, v) => n + Number(v.line_count ?? 0), 0);

  const money = (key, expectedPaise, actualPaise) => ({
    control_key: key, expected: formatMoney(expectedPaise), actual: formatMoney(actualPaise),
    difference: formatMoney(actualPaise - expectedPaise), status: expectedPaise === actualPaise ? 'MATCH' : 'DIFF',
  });
  const rows = Number(file?.row_count ?? 0);
  const actualRows = vRows + rejectedRows.length;
  const controls = [
    { control_key: 'bridge:file:rows', expected: String(rows), actual: String(actualRows),
      difference: String(actualRows - rows), status: rows === actualRows ? 'MATCH' : 'DIFF' },
    money('bridge:file:debit', parseMoney(file?.debit_total ?? '0.00'), vDebit + rejDebit),
    money('bridge:file:credit', parseMoney(file?.credit_total ?? '0.00'), vCredit + rejCredit),
  ];
  return { controls, rejected: { count: rejectedRows.length, debit: formatMoney(rejDebit), credit: formatMoney(rejCredit) } };
}

/**
 * Orchestrator: recompute the Layer B bridge for a run, persist recon_runs/recon_results,
 * and audit. Layer B does not move the run's own state (unlike Layer A/classify/transform).
 * Not covered by pure-function tests (requires a store); the pure computeBridge above is.
 */
export async function reconcileLayerB(ctx, { runId }) {
  const { store, audit } = ctx;
  const now = ctx.now ? ctx.now() : nowIso();

  const vouchers = await store.find('vouchers', { extraction_run_id: runId });
  const bridge = computeBridge(vouchers);

  // Rows rejected at load (duplicate (voucher_id,line_no)) carry their amounts in the
  // DUPLICATE_SOURCE exception evidence; they are part of the delivered population.
  const dupExceptions = await store.find('exceptions', { run_id: runId, category: 'DUPLICATE_SOURCE' });
  const rejectedRows = dupExceptions
    .map(e => { try { return JSON.parse(e.evidence_json ?? 'null'); } catch { return null; } })
    .filter(ev => ev && ev.rejected_row)
    .map(ev => ({ debit: ev.debit ?? '0.00', credit: ev.credit ?? '0.00' }));
  const txnFiles = await store.find('source_files', { run_id: runId, file_role: 'TRANSACTIONS' });
  const txnFile = txnFiles[0] ?? null;
  const fileBridge = txnFile
    ? compareBridgeToFile({ file: { row_count: txnFile.actual_row_count, debit_total: txnFile.actual_debit_total, credit_total: txnFile.actual_credit_total }, vouchers, rejectedRows })
    : { controls: [{ control_key: 'bridge:file:rows', expected: '', actual: '', difference: '', status: 'MISSING_EXPECTED' }], rejected: { count: 0, debit: '0.00', credit: '0.00' } };

  const fileTies = fileBridge.controls.every(c => c.status === 'MATCH');
  const status = (bridge.pendingCount > 0 || !bridge.ties || !fileTies || bridge.unbalancedOutsideBlocked.length > 0) ? 'FAIL' : 'PASS';
  bridge.rejectedRows = fileBridge.rejected;
  bridge.fileTies = fileTies;

  const reconRun = await store.insert('recon_runs', {
    id: `reconB_${runId}_${Date.now()}`,
    run_id: runId,
    batch_id: null,
    layer: 'B',
    branch_code: vouchers[0]?.branch_code ?? null,
    tolerance: '0.00',
    status,
    summary_json: JSON.stringify(bridge),
    inputs_version: 'bridge_v1',
    created_by: ctx.actor ?? 'worker',
    created_at: now,
  });

  const results = [
    { control_key: 'bridge:count', expected: String(bridge.total.count), actual: String(bridge.total.count) },
    { control_key: 'bridge:debit', expected: bridge.total.debit, actual: bridge.total.debit },
    { control_key: 'bridge:credit', expected: bridge.total.credit, actual: bridge.total.credit },
  ];
  for (const [d, g] of Object.entries(bridge.byDisposition)) {
    results.push({ control_key: `bridge:${d}:count`, expected: String(g.count), actual: String(g.count), voucher_ids: g.voucher_ids });
    results.push({ control_key: `bridge:${d}:debit`, expected: g.debit, actual: g.debit, voucher_ids: g.voucher_ids });
    results.push({ control_key: `bridge:${d}:credit`, expected: g.credit, actual: g.credit, voucher_ids: g.voucher_ids });
  }

  results.push({ control_key: 'bridge:REJECTED_ROWS:count', expected: String(fileBridge.rejected.count), actual: String(fileBridge.rejected.count) });
  results.push({ control_key: 'bridge:REJECTED_ROWS:debit', expected: fileBridge.rejected.debit, actual: fileBridge.rejected.debit });
  results.push({ control_key: 'bridge:REJECTED_ROWS:credit', expected: fileBridge.rejected.credit, actual: fileBridge.rejected.credit });
  for (const c of fileBridge.controls) results.push(c);
  results.push({
    control_key: 'bridge:integrity:unbalanced_outside_blocked', expected: '0', actual: String(bridge.unbalancedOutsideBlocked.length),
    difference: String(bridge.unbalancedOutsideBlocked.length), status: bridge.unbalancedOutsideBlocked.length === 0 ? 'MATCH' : 'DIFF',
    voucher_ids: bridge.unbalancedOutsideBlocked,
  });
  results.push({ control_key: 'bridge:pending', expected: '0', actual: String(bridge.pendingCount), difference: String(bridge.pendingCount), status: bridge.pendingCount === 0 ? 'MATCH' : 'DIFF' });

  for (const r of results) {
    await store.insert('recon_results', {
      recon_run_id: reconRun.id,
      control_key: r.control_key,
      expected: r.expected,
      actual: r.actual,
      difference: r.difference ?? '0.00',
      status: r.status ?? 'MATCH',
      detail_json: JSON.stringify({ voucher_ids: r.voucher_ids ?? [] }),
      uk: `${reconRun.id}|${r.control_key}`,
      created_at: now,
    });
  }

  await audit.emit({
    actor: ctx.actor ?? 'worker', action: 'RECON.B', entityType: 'recon_run', entityId: reconRun.id,
    after: { status, pendingCount: bridge.pendingCount, ties: bridge.ties, fileTies, unbalancedOutsideBlocked: bridge.unbalancedOutsideBlocked },
    correlationId: ctx.correlationId, branchCode: vouchers[0]?.branch_code ?? null,
  });

  return { reconRunId: reconRun.id, status };
}
