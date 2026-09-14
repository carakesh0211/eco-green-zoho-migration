// Per-(ledger_code, voucher_type) and per-ledger '*' rollup summarisation.
import { parseMoney, formatMoney } from './money.js';
import { nowIso, uk } from './ids.js';
import { assertTransition, RUN_TRANSITIONS, RUN_STATES } from './states.js';

/**
 * Pure. `lines` are objects shaped like `source_txn_lines` rows (money as "x.yy" strings).
 * Returns one row per (ledger_code, voucher_type) plus a '*' rollup per ledger_code:
 *   { ledger_code, voucher_type, debit, credit, txn_count, line_count }
 * `txn_count` counts distinct voucher_id. Sorted by ledger_code, then voucher_type
 * with '*' sorted last within a ledger. Money is exact (BigInt paise internally).
 */
export function summariseLines(lines) {
  const groups = new Map(); // "ledger\u0000type" -> accumulator (\u0000 cannot occur in a CSV ledger_code/voucher_type)
  const stars = new Map(); // ledger -> accumulator

  const touch = (map, key, ledger_code, voucher_type) => {
    let g = map.get(key);
    if (!g) {
      g = { ledger_code, voucher_type, debit: 0n, credit: 0n, vouchers: new Set(), lineCount: 0 };
      map.set(key, g);
    }
    return g;
  };

  for (const line of lines ?? []) {
    const ledger_code = line.ledger_code;
    const voucher_type = line.voucher_type;
    const voucher_id = line.voucher_id;
    const debitPaise = parseMoney(line.debit);
    const creditPaise = parseMoney(line.credit);

    const g = touch(groups, `${ledger_code}\u0000${voucher_type}`, ledger_code, voucher_type);
    g.debit += debitPaise;
    g.credit += creditPaise;
    g.vouchers.add(voucher_id);
    g.lineCount += 1;

    const s = touch(stars, ledger_code, ledger_code, '*');
    s.debit += debitPaise;
    s.credit += creditPaise;
    s.vouchers.add(voucher_id);
    s.lineCount += 1;
  }

  const all = [...groups.values(), ...stars.values()];
  all.sort((a, b) => {
    if (a.ledger_code !== b.ledger_code) return a.ledger_code < b.ledger_code ? -1 : 1;
    if (a.voucher_type === b.voucher_type) return 0;
    if (a.voucher_type === '*') return 1;
    if (b.voucher_type === '*') return -1;
    return a.voucher_type < b.voucher_type ? -1 : 1;
  });

  return all.map((g) => ({
    ledger_code: g.ledger_code,
    voucher_type: g.voucher_type,
    debit: formatMoney(g.debit),
    credit: formatMoney(g.credit),
    txn_count: g.vouchers.size,
    line_count: g.lineCount,
  }));
}

/**
 * Reads the run and its staged lines from ctx.store, summarises them, writes
 * `summaries` rows (idempotent on uk = run_id|ledger_code|voucher_type|summary_version),
 * transitions the run STAGED -> SUMMARISED and emits audit 'SUMMARISE.RUN'.
 */
export async function summariseRun(ctx, { runId, summaryVersion = 'sum_v1' }) {
  const { store, audit, correlationId, actor, actorRole } = ctx;

  const run = await store.get('extraction_runs', runId);
  if (!run) {
    const err = new Error(`extraction_run not found: ${runId}`);
    err.code = 'RUN_NOT_FOUND';
    throw err;
  }

  const lines = await store.find('source_txn_lines', { run_id: runId });
  const rows = summariseLines(lines);

  const written = [];
  for (const row of rows) {
    const key = uk(runId, row.ledger_code, row.voucher_type, summaryVersion);
    const existing = await store.findOne('summaries', { uk: key });
    if (existing) { written.push(existing); continue; }
    const inserted = await store.insert('summaries', {
      run_id: runId,
      branch_code: run.branch_code,
      from_date: run.from_date,
      to_date: run.to_date,
      ledger_code: row.ledger_code,
      voucher_type: row.voucher_type,
      debit: row.debit,
      credit: row.credit,
      txn_count: row.txn_count,
      line_count: row.line_count,
      summary_version: summaryVersion,
      uk: key,
      created_at: nowIso(),
    });
    written.push(inserted);
  }

  assertTransition(RUN_TRANSITIONS, 'run', run.status, RUN_STATES.SUMMARISED);
  await store.update('extraction_runs', runId, { status: RUN_STATES.SUMMARISED, updated_at: nowIso() });

  await audit.emit({
    actor,
    actorRole,
    action: 'SUMMARISE.RUN',
    entityType: 'extraction_runs',
    entityId: runId,
    before: { status: run.status },
    after: { status: RUN_STATES.SUMMARISED, summary_version: summaryVersion, rows: written.length },
    correlationId,
    branchCode: run.branch_code,
    period: run.from_date ? run.from_date.slice(0, 7) : undefined,
  });

  return { runId, summaryVersion, count: written.length, summaries: written };
}
