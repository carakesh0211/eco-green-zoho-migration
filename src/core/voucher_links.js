// Linked-voucher check for the three Eco Green clearing patterns (client decision, query
// reply 2026-10-11, items 6-8). Read-only: it proves the pairs exist and balance; it does not
// change how vouchers are posted.
//
//   UR_PAY (cheque paid, not yet reconciled) and UR_REC (cheque / card / UPI received, not yet
//   reconciled): the positive voucher (26/Q/875) books the vendor payment / customer receipt
//   against the control ledger; the negative-numbered voucher with the same number
//   (26/Q/-875) moves the control ledger to the bank. Each negative voucher must have its
//   positive partner and the control-ledger amounts must cancel; the bank leg is never a
//   second payment or receipt.
//   Petty cash: the branch expense is booked once through the petty-cash vendor (the party
//   whose name says "Petty Cash"); the Head Office reimbursement journal (against the Head
//   Office party) is settlement only and must carry no expense lines. An expense line is a
//   debit with no party. Expense and reimbursement journals are paired by amount, in date
//   order.
import { parseMoney, formatMoney } from './money.js';

export const LINK_RULES = Object.freeze({
  controls: { UR_PAY: 'Cheque paid, not reconciled', UR_REC: 'Cheque/card/UPI received, not reconciled' },
  pettyVendorName: /petty\s*cash/i,
});

const abs = (v) => (v < 0n ? -v : v);

function groupVouchers(lines) {
  const vouchers = new Map();
  for (const l of lines) {
    const id = l.voucher_no || l.voucher_id;
    const v = vouchers.get(id) ?? { id, type: l.voucher_type, date: l.voucher_date, lines: [] };
    v.lines.push({ ledger: l.ledger_code, party: l.party_code || '', partyName: l.party_name || '', net: parseMoney(l.debit || '0') - parseMoney(l.credit || '0') });
    vouchers.set(id, v);
  }
  return vouchers;
}

const isNegativeNo = (id) => /\/-\d+$/.test(id);
const positiveOf = (id) => id.replace(/\/-(\d+)$/, '/$1');

/** -> { summary, controls: { UR_PAY: {...}, UR_REC: {...} }, petty: {...} } */
export function checkVoucherLinks(lines, rules = LINK_RULES) {
  const vouchers = groupVouchers(lines);
  const controls = {};
  for (const [code, label] of Object.entries(rules.controls)) {
    const touching = [...vouchers.values()].filter((v) => v.lines.some((l) => l.ledger === code));
    const net = (v) => v.lines.filter((l) => l.ledger === code).reduce((a, l) => a + l.net, 0n);
    const negatives = touching.filter((v) => isNegativeNo(v.id));
    const positives = new Map(touching.filter((v) => !isNegativeNo(v.id)).map((v) => [v.id, v]));
    const pairs = []; const problems = [];
    const used = new Set();
    for (const neg of negatives) {
      const pos = positives.get(positiveOf(neg.id));
      if (!pos) {
        problems.push({ voucher: neg.id, issue: 'NO_PARTNER', detail: `no voucher ${positiveOf(neg.id)} in this run for the ${code} clearing leg` });
        continue;
      }
      used.add(pos.id);
      const a = net(pos); const b = net(neg);
      const bank = neg.lines.filter((l) => l.ledger !== code).map((l) => l.ledger);
      const pair = { positive: pos.id, negative: neg.id, date_positive: pos.date, date_negative: neg.date, control_positive: formatMoney(a), control_negative: formatMoney(b), clearing_ledgers: [...new Set(bank)], ok: a + b === 0n };
      if (!pair.ok) problems.push({ voucher: neg.id, issue: 'AMOUNT_MISMATCH', detail: `${code} ${formatMoney(a)} on ${pos.id} vs ${formatMoney(b)} on ${neg.id}` });
      if (neg.lines.some((l) => l.party)) problems.push({ voucher: neg.id, issue: 'PARTY_ON_CLEARING_LEG', detail: 'the clearing leg names a party; it must only move the control ledger to the bank' });
      pairs.push(pair);
    }
    for (const pos of positives.values()) {
      if (!used.has(pos.id)) problems.push({ voucher: pos.id, issue: 'NOT_CLEARED', detail: `no clearing voucher ${pos.id.replace(/\/(\d+)$/, '/-$1')} in this run; ${code} stays open by ${formatMoney(net(pos))}` });
    }
    const open = [...touching].reduce((a, v) => a + net(v), 0n);
    controls[code] = { label, vouchers: touching.length, pairs: pairs.length, ok_pairs: pairs.filter((p) => p.ok).length, open_balance: formatMoney(open), problems, pairList: pairs };
  }

  // Petty cash.
  const pettyCodes = new Set(lines.filter((l) => l.party_code && rules.pettyVendorName.test(l.party_name || '')).map((l) => l.party_code));
  const isPetty = (l) => pettyCodes.has(l.party);
  const petty = [...vouchers.values()].filter((v) => v.lines.some(isPetty));
  const isExpenseLine = (l) => !l.party && l.net > 0n;
  const pettyAmount = (v) => v.lines.filter(isPetty).reduce((a, l) => a + (l.net > 0n ? l.net : 0n), 0n);
  const expenseJvs = petty.filter((v) => v.lines.some(isExpenseLine));
  const reimbursements = petty.filter((v) => !v.lines.some(isExpenseLine));
  const pettyProblems = [];
  const pettyPairs = [];
  const byDate = (a, b) => String(a.date).localeCompare(String(b.date)) || a.id.localeCompare(b.id);
  const pool = [...reimbursements].sort(byDate);
  for (const e of [...expenseJvs].sort(byDate)) {
    const amount = pettyAmount(e);
    const expense = e.lines.filter(isExpenseLine).reduce((a, l) => a + l.net, 0n);
    const i = pool.findIndex((r) => pettyAmount(r) === amount && String(r.date) >= String(e.date));
    if (i === -1) {
      pettyProblems.push({ voucher: e.id, issue: 'NOT_REIMBURSED', detail: `no Head Office reimbursement journal of ${formatMoney(amount)} found after ${e.date}` });
      pettyPairs.push({ expense: e.id, reimbursement: null, amount: formatMoney(amount), expense_booked: formatMoney(expense), ok: false });
      continue;
    }
    const r = pool.splice(i, 1)[0];
    const hoOk = r.lines.some((l) => l.party && !isPetty(l));
    if (!hoOk) pettyProblems.push({ voucher: r.id, issue: 'NO_HEAD_OFFICE', detail: 'reimbursement journal has no Head Office (inter-branch) party line' });
    pettyPairs.push({ expense: e.id, reimbursement: r.id, amount: formatMoney(amount), expense_booked: formatMoney(expense), ok: hoOk });
  }
  for (const r of pool) pettyProblems.push({ voucher: r.id, issue: 'UNMATCHED_REIMBURSEMENT', detail: `reimbursement of ${formatMoney(pettyAmount(r))} has no matching expense journal` });

  const allProblems = [...Object.values(controls).flatMap((c) => c.problems), ...pettyProblems];
  return {
    summary: {
      ok: allProblems.length === 0,
      problems: allProblems.length,
      ur_pay_pairs: controls.UR_PAY?.pairs ?? 0,
      ur_rec_pairs: controls.UR_REC?.pairs ?? 0,
      petty_pairs: pettyPairs.filter((p) => p.ok).length,
    },
    controls,
    petty: { vendor: [...pettyCodes].join(', ') || 'none', expense_journals: expenseJvs.length, reimbursement_journals: reimbursements.length, pairs: pettyPairs, problems: pettyProblems },
  };
}
