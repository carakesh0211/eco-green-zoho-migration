// Layer C reconciliation (CONTRACTS.md §Y): proves the approved population (this
// batch's queue_items) actually landed in Books exactly once each, and flags any
// Books record carrying a migration tag that does not correspond to any of them.
import { parseMoney, formatMoney, add, ZERO } from './money.js';
import { newId, nowIso, uk } from './ids.js';
import { raise } from './exceptions.js';

function lastDayOfPeriod(period) {
  if (!period) return null;
  const [y, m] = period.split('-').map(Number);
  const d = new Date(Date.UTC(y, m, 0)); // day 0 of next month == last day of this month
  return d.toISOString().slice(0, 10);
}

/** Reconciles one batch's approved population against Books via searchByMigrationTag
 * (per item: present exactly once / missing / duplicate) plus a per-module sweep for
 * unexpected migration-tagged records that don't correspond to any queue_item here. */
export async function reconcileLayerC(ctx, { client, batchId }) {
  const { store, audit, correlationId } = ctx;
  const now = ctx.now ? ctx.now() : nowIso();

  const batch = await store.get('migration_batches', batchId);
  if (!batch) {
    const err = new Error(`migration_batch not found: ${batchId}`);
    err.code = 'BATCH_NOT_FOUND';
    throw err;
  }

  const items = await store.find('queue_items', { batch_id: batchId });
  const byModule = new Map(); // module -> { count, amountPaise, actualCount, actualAmountPaise }
  const itemControls = [];
  let anyDiff = false;

  for (const item of items) {
    const voucher = await store.get('vouchers', item.voucher_id);
    const module = voucher.target_module ?? 'unknown';
    const amountPaise = parseMoney(voucher.debit_total !== '0.00' ? voucher.debit_total : voucher.credit_total);

    if (!byModule.has(module)) byModule.set(module, { count: 0, amountPaise: ZERO, actualCount: 0, actualAmountPaise: ZERO });
    const g = byModule.get(module);
    g.count += 1;
    g.amountPaise = add(g.amountPaise, amountPaise);

    const matches = await client.searchByMigrationTag({ module, sourceHash: item.idempotency_key });
    let status;
    if (matches.length === 1) {
      status = 'MATCH';
      g.actualCount += 1;
      g.actualAmountPaise = add(g.actualAmountPaise, amountPaise);
    } else if (matches.length === 0) {
      status = 'MISSING_ACTUAL';
    } else {
      status = 'DUPLICATE';
    }

    if (status !== 'MATCH') {
      anyDiff = true;
      await raise(ctx, {
        category: 'TARGET_MISMATCH', severity: 'P1',
        message: `Layer C ${status} for queue item ${item.id} (module ${module}, ${matches.length} Books match(es))`,
        dedupeKey: `reconC:${batchId}:item:${item.id}`,
        branchCode: batch.branch_code, batchId, voucherId: voucher.id,
        evidence: { matches: matches.map((m) => m.id) },
      });
    }

    itemControls.push({
      control_key: `c:item:${item.id}`, expected: 'PRESENT', actual: status, status,
      detail: { voucher_id: voucher.id, module, matches: matches.map((m) => m.id) },
    });
  }

  const moduleControls = [];
  const unexpectedByModule = new Map();
  const fromDate = `${batch.period}-01`;
  const toDate = lastDayOfPeriod(batch.period);
  const idempotencyKeys = new Set(items.map((i) => i.idempotency_key));

  for (const [module, g] of byModule.entries()) {
    const countMatch = g.count === g.actualCount;
    const amountMatch = g.amountPaise === g.actualAmountPaise;
    if (!countMatch || !amountMatch) anyDiff = true;
    moduleControls.push({
      control_key: `c:${module}:count`, expected: String(g.count), actual: String(g.actualCount),
      status: countMatch ? 'MATCH' : 'DIFF', detail: {},
    });
    moduleControls.push({
      control_key: `c:${module}:amount`, expected: formatMoney(g.amountPaise), actual: formatMoney(g.actualAmountPaise),
      status: amountMatch ? 'MATCH' : 'DIFF', detail: {},
    });

    let windowRecords = [];
    try {
      windowRecords = await client.listRecordsInWindow({ module, fromDate, toDate });
    } catch {
      windowRecords = [];
    }
    const unexpected = windowRecords.filter((r) => r.tags?.migration_source_hash && !idempotencyKeys.has(r.tags.migration_source_hash));
    unexpectedByModule.set(module, unexpected);
    if (unexpected.length > 0) anyDiff = true;
    moduleControls.push({
      control_key: `c:${module}:unexpected`, expected: '0', actual: String(unexpected.length),
      status: unexpected.length === 0 ? 'MATCH' : 'UNEXPECTED',
      detail: { record_ids: unexpected.map((r) => r.id) },
    });

    for (const rec of unexpected) {
      await raise(ctx, {
        category: 'TARGET_MISMATCH', severity: 'P1',
        message: `Layer C UNEXPECTED: Books record ${rec.id} (module ${module}) carries a migration tag with no matching queue item`,
        dedupeKey: `reconC:${batchId}:unexpected:${module}:${rec.id}`,
        branchCode: batch.branch_code, batchId,
        evidence: { recordId: rec.id, tag: rec.tags?.migration_source_hash },
      });
    }
  }

  // A Layer C run that exercised zero queue items cannot be evidence for a batch that
  // has an approved population (Codex P2: vacuous PASS). It is only acceptable for an
  // empty batch.
  const populationExercised = items.length > 0 || Number(batch.voucher_count ?? 0) === 0;
  if (!populationExercised) anyDiff = true;
  moduleControls.push({
    control_key: 'c:population:exercised', expected: String(batch.voucher_count ?? 0), actual: String(items.length),
    status: populationExercised ? 'MATCH' : 'MISSING_ACTUAL',
    detail: { note: 'queue items compared vs approved batch population; zero items over a non-empty batch is not evidence' },
  });

  const status = anyDiff ? 'FAIL' : 'PASS';
  const reconRunId = newId('reconC');
  await store.insert('recon_runs', {
    id: reconRunId, run_id: batch.run_id, batch_id: batchId, layer: 'C', branch_code: batch.branch_code,
    tolerance: '0.00', status,
    summary_json: JSON.stringify({ itemCount: items.length, modules: [...byModule.keys()] }),
    inputs_version: 'reconC_v1', created_by: ctx.actor ?? 'worker', created_at: now,
  });

  for (const c of [...moduleControls, ...itemControls]) {
    await store.insert('recon_results', {
      recon_run_id: reconRunId, control_key: c.control_key, expected: c.expected, actual: c.actual,
      difference: '', status: c.status, detail_json: JSON.stringify(c.detail ?? {}),
      uk: uk(reconRunId, c.control_key), created_at: now,
    });
  }

  await audit.emit({
    actor: ctx.actor ?? 'worker', action: 'RECON.C', entityType: 'recon_runs', entityId: reconRunId,
    after: { status, itemCount: items.length }, correlationId, branchCode: batch.branch_code, batchId,
  });

  return { reconRunId, status, itemCount: items.length };
}
