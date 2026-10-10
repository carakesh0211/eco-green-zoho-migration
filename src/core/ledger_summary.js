// Ledger push summary: for one run, per source ledger, the debit and credit that will be
// sent to Zoho Books and the amounts still held back — the totals an operator confirms
// before a batch is approved and posted.
//
// "Will be pushed" = lines of vouchers with disposition MIGRATE that are not yet POSTED.
// "Already posted" = MIGRATE vouchers whose migration_status is POSTED.
// "Held back"      = every other voucher (BLOCKED, SKIP, overlap, ...), with the reasons.
//
// Amounts come from the run's own source lines (source_txn_lines), the same lines the
// transform turns into journal line items one for one, so the pushed totals equal the
// totals of the Books payloads. The Books account shown is the one the approved rules
// resolve to today: the PARTY rule's account when the party is posted to an account,
// otherwise the ledger's LEDGER_ACCOUNT rule.
import { parseMoney, formatMoney } from './money.js';

function metaOf(rule) {
  if (!rule?.target_meta) return {};
  if (typeof rule.target_meta === 'object') return rule.target_meta;
  try { return JSON.parse(rule.target_meta) ?? {}; } catch { return {}; }
}

function accountLabel(rule) {
  const m = metaOf(rule);
  return m.account_name || m.name || m.contact_name || String(rule.target_value);
}

export class RunNotFoundError extends Error {
  constructor(runId) {
    super(`Run not found: ${runId}`);
    this.code = 'NOT_FOUND';
  }
}

/**
 * -> { run, totals, ledgers: [...] } with money as 2-decimal strings.
 * ledgers are sorted by ledger_code; each row:
 *   ledger_code, ledger_name, books_accounts[], ledger_rule (bool),
 *   push_debit, push_credit, push_lines, posted_debit, posted_credit,
 *   held_debit, held_credit, held_lines, held_reasons { reason: lines }
 */
export async function computeLedgerPushSummary(store, runId) {
  const run = await store.get('extraction_runs', runId);
  if (!run) throw new RunNotFoundError(runId);

  const [vouchers, lines, rules] = await Promise.all([
    store.find('vouchers', { extraction_run_id: runId }),
    store.find('source_txn_lines', { run_id: runId }),
    store.find('mapping_rules', { status: 'APPROVED' }),
  ]);
  const ledgerRules = new Map();
  const partyRules = new Map();
  for (const r of rules) {
    if (r.rule_type === 'LEDGER_ACCOUNT') ledgerRules.set(r.source_key, r);
    else if (r.rule_type === 'PARTY') partyRules.set(r.source_key, r);
  }
  const voucherByRecord = new Map(vouchers.map((v) => [v.source_record_id, v]));

  const zero = () => ({ d: 0n, c: 0n, n: 0 });
  const byLedger = new Map();
  const totals = { push: zero(), posted: zero(), held: zero() };
  const vouchersIn = { push: new Set(), posted: new Set(), held: new Set() };

  for (const l of lines) {
    const v = voucherByRecord.get(l.voucher_id);
    let bucket = 'held';
    if (v?.disposition === 'MIGRATE') bucket = v.migration_status === 'POSTED' ? 'posted' : 'push';
    const reason = bucket === 'held' ? (v ? (v.disposition_reason || v.disposition || 'UNKNOWN') : 'NO_VOUCHER') : null;

    const code = String(l.ledger_code ?? '').trim();
    let row = byLedger.get(code);
    if (!row) {
      row = { ledger_code: code, ledger_name: l.ledger_name ?? '', accounts: new Set(), push: zero(), posted: zero(), held: zero(), held_reasons: {} };
      byLedger.set(code, row);
    }
    if (!row.ledger_name && l.ledger_name) row.ledger_name = l.ledger_name;

    const partyCode = String(l.party_code ?? '').trim();
    const partyRule = partyCode ? partyRules.get(partyCode) : null;
    const target = partyRule && metaOf(partyRule).kind === 'account' ? partyRule : ledgerRules.get(code);
    if (target) row.accounts.add(accountLabel(target));

    const d = parseMoney(l.debit ?? '0');
    const c = parseMoney(l.credit ?? '0');
    for (const acc of [row[bucket], totals[bucket]]) { acc.d += d; acc.c += c; acc.n += 1; }
    if (v) vouchersIn[bucket].add(v.id);
    if (reason) row.held_reasons[reason] = (row.held_reasons[reason] ?? 0) + 1;
  }

  const ledgers = [...byLedger.values()]
    .sort((a, b) => (a.ledger_code < b.ledger_code ? -1 : a.ledger_code > b.ledger_code ? 1 : 0))
    .map((r) => ({
      ledger_code: r.ledger_code,
      ledger_name: r.ledger_name,
      books_accounts: [...r.accounts].sort(),
      ledger_rule: ledgerRules.has(r.ledger_code),
      push_debit: formatMoney(r.push.d),
      push_credit: formatMoney(r.push.c),
      push_lines: r.push.n,
      posted_debit: formatMoney(r.posted.d),
      posted_credit: formatMoney(r.posted.c),
      held_debit: formatMoney(r.held.d),
      held_credit: formatMoney(r.held.c),
      held_lines: r.held.n,
      held_reasons: r.held_reasons,
    }));

  return {
    run: { id: run.id, branch_code: run.branch_code, status: run.status, from_date: run.from_date, to_date: run.to_date },
    totals: {
      push_debit: formatMoney(totals.push.d),
      push_credit: formatMoney(totals.push.c),
      push_balanced: totals.push.d === totals.push.c,
      push_vouchers: vouchersIn.push.size,
      posted_debit: formatMoney(totals.posted.d),
      posted_credit: formatMoney(totals.posted.c),
      posted_vouchers: vouchersIn.posted.size,
      held_debit: formatMoney(totals.held.d),
      held_credit: formatMoney(totals.held.c),
      held_vouchers: vouchersIn.held.size,
      vouchers: vouchers.length,
      ledgers: ledgers.length,
      ledgers_pushing: ledgers.filter((r) => r.push_lines > 0).length,
    },
    ledgers,
  };
}
