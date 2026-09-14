// Balance bridge (CONTRACTS.md §Y): per account, baseline + migration_movement +
// sp_movement + authorised manual_movement must equal post_run. Any residual that cannot
// be attributed to a pre-authorised manual movement is "unexplained" and fails the
// control — silently accepting an unexplained balance change is exactly the failure
// mode this pilot exists to prevent.
//
// Movement derivation (CONTRACTS.md §Y / §Z, src/books/gl_effects.js):
//   - migration movement: for every POSTED queue_item in this batch, re-derive the real
//     double-entry effect of the preview payload we posted (src/books/gl_effects.js#glEffects)
//     and sum it per account. This replaced an earlier ad-hoc `PAYMENT_MODE:<mode>`
//     heuristic that did not correspond to how a general ledger actually moves.
//   - sp / manual movement: swept from `client.listRecordsInWindow()` for every module this
//     batch touched, classified by the record's tags (`sp_batch_ref` -> sp; neither
//     sp_batch_ref nor a migration tag -> manual) and summed via the record's own stored
//     `effects`. Migration-tagged window records are NOT folded into "migration" (that
//     would double-count our own postings); instead they are cross-checked against our
//     independently-derived migration movement (`bb:migration_tag_consistency:<account>`)
//     so a target-side discrepancy (e.g. Books normalising an amount) cannot go unnoticed.
//   - `authorizedManual` remains a caller-supplied `{[account_id]: amount}` allowlist of
//     pre-approved manual movement. Observed manual movement not covered by it is reported
//     ("never guess" posture, see overlap.js) but does NOT explain the residual — it is
//     unexplained and fails the control.
import { parseMoney, formatMoney, add, sub, abs as moneyAbs, withinTolerance, ZERO } from './money.js';
import { newId, nowIso, uk } from './ids.js';
import { hashCanonical } from './hash.js';
import { raise } from './exceptions.js';
import { glEffects } from '../books/gl_effects.js';

function netOf(entry) {
  return parseMoney(entry.debit ?? '0.00') - parseMoney(entry.credit ?? '0.00');
}

function balancesToNetMap(balancesJson) {
  const rows = typeof balancesJson === 'string' ? JSON.parse(balancesJson) : (balancesJson ?? []);
  const map = new Map();
  for (const row of rows) map.set(row.account_id, netOf(row));
  return map;
}

function addToMap(map, accountId, netPaise) {
  map.set(accountId, add(map.get(accountId) ?? ZERO, netPaise));
}

function mapToMoneyObject(map) {
  return Object.fromEntries([...map.entries()].map(([k, v]) => [k, formatMoney(v)]));
}

function lastDayOfPeriod(period) {
  if (!period) return null;
  const [y, m] = period.split('-').map(Number);
  const d = new Date(Date.UTC(y, m, 0)); // day 0 of next month == last day of this month
  return d.toISOString().slice(0, 10);
}

/** Pure. Every input map is account_id -> money string (or BigInt paise). `manualObserved`
 * is informational only (reported on each account as `manual_observed`); it does NOT
 * participate in the pass/fail identity, which is driven solely by whether the residual
 * matches `authorizedManual`. Returns { status: 'PASS'|'FAIL', accounts: [{account_id,
 * baseline, migration, sp, manual, manual_observed, post_run, unexplained, status}] }. */
export function computeBalanceBridge({
  baseline = {}, migration = {}, sp = {}, postRun = {}, authorizedManual = {}, manualObserved = {}, tolerance = '0.00',
}) {
  const tolerancePaise = parseMoney(tolerance);
  const toPaise = (v) => (typeof v === 'bigint' ? v : parseMoney(v ?? '0.00'));
  const accountIds = new Set([
    ...Object.keys(baseline), ...Object.keys(migration), ...Object.keys(sp),
    ...Object.keys(postRun), ...Object.keys(authorizedManual), ...Object.keys(manualObserved),
  ]);

  const accounts = [];
  let overallStatus = 'PASS';

  for (const accountId of [...accountIds].sort()) {
    const baselinePaise = toPaise(baseline[accountId]);
    const migrationPaise = toPaise(migration[accountId]);
    const spPaise = toPaise(sp[accountId]);
    const postRunPaise = toPaise(postRun[accountId]);
    const authorizedPaise = toPaise(authorizedManual[accountId]);
    const observedPaise = toPaise(manualObserved[accountId]);

    const residual = sub(postRunPaise, add(add(baselinePaise, migrationPaise), spPaise));
    const explainedByManual = withinTolerance(residual, authorizedPaise, tolerancePaise);
    const manualPaise = explainedByManual ? residual : ZERO;
    const unexplainedPaise = explainedByManual ? ZERO : residual;

    const status = moneyAbs(unexplainedPaise) <= tolerancePaise ? 'MATCH' : 'FAIL';
    if (status !== 'MATCH') overallStatus = 'FAIL';

    accounts.push({
      account_id: accountId,
      baseline: formatMoney(baselinePaise),
      migration: formatMoney(migrationPaise),
      sp: formatMoney(spPaise),
      manual: formatMoney(manualPaise),
      manual_observed: formatMoney(observedPaise),
      post_run: formatMoney(postRunPaise),
      unexplained: formatMoney(unexplainedPaise),
      status,
    });
  }

  return { status: overallStatus, accounts };
}

/** Read-only: takes a point-in-time snapshot of Books balances for a branch and
 * stores it (BASELINE before a batch runs, POST_RUN after). */
export async function takeSnapshot(ctx, { client, branchCode, kind, batchId }) {
  const { store, audit, correlationId } = ctx;
  const now = ctx.now ? ctx.now() : nowIso();

  const branch = await store.findOne('branches', { branch_code: branchCode });
  const locationId = branch?.zoho_location_id ?? undefined;

  const [org, trialBalance] = await Promise.all([
    client.getOrganization(),
    client.getTrialBalance({ locationId }),
  ]);

  // Mock driver (src/books/mock.js) returns a plain array; a live driver returns whatever
  // shape the real Zoho Books reports API responds with (TODO(verify-against-zoho-docs) in
  // src/books/live.js) — normalise both to a plain array of {account_id, debit, credit, ...}.
  const balances = Array.isArray(trialBalance) ? trialBalance : (trialBalance?.account_transactions ?? []);
  const snapshot = await store.insert('books_snapshots', {
    branch_code: branchCode,
    zoho_location_id: locationId ?? null,
    organization_id: org.organization_id,
    kind,
    batch_id: batchId ?? null,
    driver: client.driver ?? 'mock',
    taken_at: now,
    balances_json: JSON.stringify(balances),
    records_json: null,
    snapshot_hash: hashCanonical(balances),
    created_at: now,
  });

  await audit.emit({
    actor: ctx.actor ?? 'worker', action: 'SNAPSHOT.TAKE', entityType: 'books_snapshots', entityId: snapshot.id,
    after: { kind, branchCode, accountCount: balances.length }, correlationId, branchCode, batchId,
  });

  return snapshot;
}

/** Re-derives the double-entry migration movement per account from this batch's POSTED
 * queue_items: for each, loads the exact preview_payloads row that was built for that
 * voucher (keyed by voucher id + the transformation/mapping versions actually stamped on
 * the voucher, CONTRACTS.md §T's `uk`) and runs it through `glEffects()`. Returns a Map
 * of account_id -> BigInt net paise (debit - credit). */
async function migrationMovementByAccount(store, batchId) {
  const items = await store.find('queue_items', { batch_id: batchId, status: 'POSTED' });
  const byAccount = new Map();
  for (const item of items) {
    const voucher = await store.get('vouchers', item.voucher_id);
    if (!voucher?.target_module || !voucher.transformation_version || !voucher.mapping_version) continue;
    const payloadRow = await store.findOne('preview_payloads', {
      uk: uk(voucher.id, voucher.transformation_version, voucher.mapping_version),
    });
    if (!payloadRow) continue;
    const payload = JSON.parse(payloadRow.payload_json);
    for (const e of glEffects(voucher.target_module, payload)) {
      addToMap(byAccount, e.account_id, sub(parseMoney(e.debit), parseMoney(e.credit)));
    }
  }
  return byAccount;
}

/** Every distinct target_module among this batch's queue_items (regardless of status) —
 * the set of Books modules whose window we need to sweep for SP/manual/migration-tagged
 * records, mirroring src/core/recon_c.js's per-module sweep. */
async function batchModules(store, batchId) {
  const items = await store.find('queue_items', { batch_id: batchId });
  const modules = new Set();
  for (const item of items) {
    const voucher = await store.get('vouchers', item.voucher_id);
    if (voucher?.target_module) modules.add(voucher.target_module);
  }
  return modules;
}

/** Sweeps `client.listRecordsInWindow()` for every module in `modules` and buckets each
 * record's own stored `effects` (src/books/mock.js / a live driver's equivalent) per
 * account into `sp`, `manual`, or `migrationTag` maps by tag — sp_batch_ref -> sp; a
 * migration tag -> migrationTag (used only for the cross-check, never folded into "sp" or
 * "manual"); neither -> manual. */
async function sweepWindowMovements(client, { locationId, modules, fromDate, toDate }) {
  const sp = new Map();
  const manual = new Map();
  const migrationTag = new Map();

  for (const module of modules) {
    let records = [];
    try {
      records = await client.listRecordsInWindow({ locationId, module, fromDate, toDate });
    } catch {
      records = [];
    }
    for (const rec of records) {
      const target = rec.tags?.sp_batch_ref ? sp : rec.tags?.migration_source_hash ? migrationTag : manual;
      for (const e of rec.effects ?? []) {
        addToMap(target, e.account_id, sub(parseMoney(e.debit), parseMoney(e.credit)));
      }
    }
  }

  return { sp, manual, migrationTag };
}

/** Orchestrator: loads the batch's BASELINE/POST_RUN snapshots, derives migration/sp/manual
 * movement (see module header), and runs computeBalanceBridge. Persists recon_runs (layer
 * BALANCE_BRIDGE) + one `bb:<account_id>` recon_results row per account plus one
 * `bb:migration_tag_consistency:<account_id>` cross-check row per account touched by our
 * own migration-tagged postings; any unexplained residual or cross-check DIFF raises
 * TARGET_MISMATCH (P1) and fails the control. `client` (optional) enables the sp/manual/
 * migration-tag sweep via `client.listRecordsInWindow()`; omit it (as
 * scripts/run-pipeline.js does) to derive migration movement only. `sp` is an optional
 * caller-supplied addition to the sp movement derived from Books tags. */
export async function balanceBridge(ctx, { batchId, client, sp: spOverride = {}, authorizedManual = {}, tolerance = '0.00' }) {
  const { store, audit, correlationId } = ctx;
  const now = ctx.now ? ctx.now() : nowIso();

  const batch = await store.get('migration_batches', batchId);
  if (!batch) {
    const err = new Error(`migration_batch not found: ${batchId}`);
    err.code = 'BATCH_NOT_FOUND';
    throw err;
  }

  const snapshots = await store.find('books_snapshots', { batch_id: batchId });
  const baselineSnap = snapshots.filter((s) => s.kind === 'BASELINE').sort((a, b) => (a.taken_at < b.taken_at ? 1 : -1))[0];
  const postRunSnap = snapshots.filter((s) => s.kind === 'POST_RUN').sort((a, b) => (a.taken_at < b.taken_at ? 1 : -1))[0];
  if (!baselineSnap || !postRunSnap) {
    const err = new Error(`balanceBridge requires both a BASELINE and a POST_RUN books_snapshots row for batch ${batchId}`);
    err.code = 'SNAPSHOTS_MISSING';
    throw err;
  }

  const baselineNet = balancesToNetMap(baselineSnap.balances_json);
  const postRunNet = balancesToNetMap(postRunSnap.balances_json);
  const baseline = mapToMoneyObject(baselineNet);
  const postRun = mapToMoneyObject(postRunNet);

  const migrationMap = await migrationMovementByAccount(store, batchId);

  // The sp/manual/migration-tag sweep needs a live Books read (`listRecordsInWindow`), so
  // it only runs when the caller supplies `client` (as the new tests do). Callers that
  // don't (e.g. scripts/run-pipeline.js, which never introduces a manual/SP movement
  // between its own BASELINE and POST_RUN snapshots) still get a correct bridge — sp and
  // manual movement are simply absent rather than guessed.
  let spMap = new Map();
  let manualMap = new Map();
  let migrationTagMap = new Map();
  if (client) {
    const branch = await store.findOne('branches', { branch_code: batch.branch_code });
    const locationId = branch?.zoho_location_id ?? undefined;
    const modules = await batchModules(store, batchId);
    const fromDate = `${batch.period}-01`;
    const toDate = lastDayOfPeriod(batch.period);
    ({ sp: spMap, manual: manualMap, migrationTag: migrationTagMap } = await sweepWindowMovements(client, { locationId, modules, fromDate, toDate }));
  }

  for (const [accountId, amount] of Object.entries(spOverride)) {
    addToMap(spMap, accountId, typeof amount === 'bigint' ? amount : parseMoney(amount));
  }

  const migration = mapToMoneyObject(migrationMap);
  const sp = mapToMoneyObject(spMap);
  const manualObserved = mapToMoneyObject(manualMap);

  const result = computeBalanceBridge({ baseline, migration, sp, postRun, authorizedManual, manualObserved, tolerance });

  // Cross-check: our own migration-tagged postings, independently re-summed from what
  // Books reports it holds for them, must equal the migration movement we derived above.
  // Only meaningful when `client` was supplied (that's what populates migrationTagMap) —
  // without it there is nothing to cross-check against, so skip it rather than comparing
  // a real derived amount against an empty sweep and reporting a spurious DIFF.
  const tolerancePaise = parseMoney(tolerance);
  const crossCheckResults = [];
  let anyCrossCheckDiff = false;
  if (client) {
    const crossCheckAccounts = new Set([...migrationMap.keys(), ...migrationTagMap.keys()]);
    for (const accountId of [...crossCheckAccounts].sort()) {
      const derived = migrationMap.get(accountId) ?? ZERO;
      const observed = migrationTagMap.get(accountId) ?? ZERO;
      const diff = sub(observed, derived);
      const status = moneyAbs(diff) <= tolerancePaise ? 'MATCH' : 'DIFF';
      if (status === 'DIFF') anyCrossCheckDiff = true;
      crossCheckResults.push({ accountId, expected: formatMoney(derived), actual: formatMoney(observed), difference: formatMoney(diff), status });
    }
  }

  const overallStatus = anyCrossCheckDiff ? 'FAIL' : result.status;

  const reconRunId = newId('reconBB');
  await store.insert('recon_runs', {
    id: reconRunId, run_id: batch.run_id, batch_id: batchId, layer: 'BALANCE_BRIDGE', branch_code: batch.branch_code,
    tolerance, status: overallStatus,
    summary_json: JSON.stringify({ accounts: result.accounts.length }),
    inputs_version: 'bb_v2', created_by: ctx.actor ?? 'worker', created_at: now,
  });

  for (const a of result.accounts) {
    await store.insert('recon_results', {
      recon_run_id: reconRunId, control_key: `bb:${a.account_id}`, expected: a.post_run,
      actual: formatMoney(add(add(parseMoney(a.baseline), parseMoney(a.migration)), add(parseMoney(a.sp), parseMoney(a.manual)))),
      difference: a.unexplained, status: a.status, detail_json: JSON.stringify(a), uk: uk(reconRunId, `bb:${a.account_id}`), created_at: now,
    });
    if (a.status !== 'MATCH') {
      await raise(ctx, {
        category: 'TARGET_MISMATCH', severity: 'P1',
        message: `Unexplained balance movement on account ${a.account_id}: ${a.unexplained}`,
        dedupeKey: `bb:${batchId}:${a.account_id}`,
        branchCode: batch.branch_code, batchId, financialImpact: a.unexplained.startsWith('-') ? a.unexplained.slice(1) : a.unexplained,
        evidence: a,
      });
    }
  }

  for (const c of crossCheckResults) {
    const controlKey = `bb:migration_tag_consistency:${c.accountId}`;
    await store.insert('recon_results', {
      recon_run_id: reconRunId, control_key: controlKey, expected: c.expected, actual: c.actual,
      difference: c.difference, status: c.status, detail_json: JSON.stringify(c), uk: uk(reconRunId, controlKey), created_at: now,
    });
    if (c.status === 'DIFF') {
      await raise(ctx, {
        category: 'TARGET_MISMATCH', severity: 'P1',
        message: `Migration-tagged Books records for account ${c.accountId} do not match our derived migration movement: expected ${c.expected}, Books shows ${c.actual}`,
        dedupeKey: `bb:migtag:${batchId}:${c.accountId}`,
        branchCode: batch.branch_code, batchId, financialImpact: c.difference.startsWith('-') ? c.difference.slice(1) : c.difference,
        evidence: c,
      });
    }
  }

  await audit.emit({
    actor: ctx.actor ?? 'worker', action: 'RECON.BALANCE_BRIDGE', entityType: 'recon_runs', entityId: reconRunId,
    after: { status: overallStatus, accounts: result.accounts.length }, correlationId, branchCode: batch.branch_code, batchId,
  });

  return { reconRunId, status: overallStatus, accounts: result.accounts };
}
