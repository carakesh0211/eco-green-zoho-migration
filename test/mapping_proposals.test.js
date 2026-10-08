import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  normaliseName, similarity, proposeAccountMappings, proposeContactMappings, buildRuleRows, reviewCsv,
} from '../src/core/mapping_proposals.js';
import { parseCsv } from '../src/core/csv.js';

// Synthetic Books reference data only.
const acct = (id, name, extra = {}) => ({
  account_id: id, account_name: name, account_code: `C${id}`, account_type: 'expense',
  parent_account_id: '', parent_account_name: '', depth: 0, is_active: true, is_system_account: false, ...extra,
});

describe('normaliseName', () => {
  test('expands tax and financial-year abbreviations', () => {
    assert.equal(normaliseName('Cgsttds Receivable Fy-25-26'), 'CGST TDS RECEIVABLE FY 25 26');
    assert.equal(normaliseName('CGST TDS Receivable FY 25-26'), 'CGST TDS RECEIVABLE FY 25 26');
    assert.equal(normaliseName('Tds Receivable Fy-2025-2026'), 'TDS RECEIVABLE FY 25 26');
    assert.equal(normaliseName('Tds Receivable FY 2025-2026'), normaliseName('Tds Receivable Fy 25-26'));
    assert.equal(normaliseName('sgsttds x'), 'SGST TDS X');
    assert.equal(normaliseName('IGSTTDS x'), 'IGST TDS X');
  });

  test('expands words and ampersand abbreviations', () => {
    assert.equal(normaliseName('Chq Recd Agst Bill'), 'CHEQUE RECEIVED AGAINST BILL');
    assert.equal(normaliseName('Agt Bill'), 'AGAINST BILL');
    assert.equal(normaliseName('R&m-cleaning'), 'REPAIRS MAINTENANCE CLEANING');
    assert.equal(normaliseName('Repairs & Maintenance'), 'REPAIRS MAINTENANCE');
    assert.equal(normaliseName('P&s-office Stationery'), 'PRINTING STATIONERY OFFICE STATIONERY');
    assert.equal(normaliseName('S&d-others'), 'SALES DISTRIBUTION OTHERS');
    assert.equal(normaliseName('R&t-licenses'), 'RATES TAXES LICENSES');
    assert.equal(normaliseName('Cash A/C'), 'CASH ACCOUNT');
  });

  test('standalone HO becomes HEAD OFFICE; digit runs and plain words are kept', () => {
    assert.equal(normaliseName('Examplebank-ho-650001857587'), 'EXAMPLEBANK HEAD OFFICE 650001857587');
    assert.equal(normaliseName('Photo Shop'), 'PHOTO SHOP');
    assert.equal(normaliseName('  Hot  '), 'HOT');
    assert.equal(normaliseName(null), '');
  });
});

describe('similarity', () => {
  test('identical normalised names score 1; unrelated names score low; order is sensible', () => {
    assert.equal(similarity('Cheque Received', 'Chq Recd'), 1);
    const close = similarity('Office Rent', 'Office Rental');
    const far = similarity('Office Rent', 'Freight Inward');
    assert.ok(close > far, `${close} should beat ${far}`);
    assert.ok(close > 0.5 && close < 1);
    assert.ok(far < 0.3);
    assert.equal(similarity('', 'abc'), 0);
    assert.ok(similarity('a b', 'a b c') > similarity('a b', 'c d'));
  });
});

describe('proposeAccountMappings', () => {
  const accounts = [
    acct('1', 'Cgsttds Receivable Fy-25-26'),
    acct('2', 'Printing & Stationery'),
    acct('3', 'Freight Inward'),
    acct('4', 'Freight Inwards'),
    acct('5', 'Rent Paid Office'),
    acct('6', 'Rent Paid Offices'),
    acct('7', 'Telephone Charges'),
    acct('8', 'Telephone Charges', { account_type: 'other_expense' }),
  ];
  const ledgers = (...names) => names.map((n, i) => ({ ledger_code: `L${i}`, ledger_name: n, usage_count: i + 1 }));

  test('EXACT: one normalised-name match, score 1, target fields filled', () => {
    const [r] = proposeAccountMappings({ ledgers: ledgers('CGST TDS Receivable FY 25-26'), accounts });
    assert.equal(r.status, 'EXACT');
    assert.equal(r.score, 1);
    assert.equal(r.target_id, '1');
    assert.equal(r.target_type, 'expense');
    assert.equal(r.source_key, 'L0');
    assert.equal(r.usage_count, 1);
  });

  test('matches by name only, never by account_code', () => {
    const accs = [acct('9', 'Something Else', { account_code: 'L0' })];
    const [r] = proposeAccountMappings({ ledgers: ledgers('Unrelated Name'), accounts: accs });
    assert.notEqual(r.target_id, '9');
    assert.equal(r.status, 'NONE');
  });

  test('AMBIGUOUS: several exact matches, no target, all listed', () => {
    const [r] = proposeAccountMappings({ ledgers: ledgers('Telephone Charges'), accounts });
    assert.equal(r.status, 'AMBIGUOUS');
    assert.equal(r.target_id, null);
    assert.deepEqual(r.candidates.map((c) => c.id).sort(), ['7', '8']);
  });

  test('FUZZY: high score with a clear lead over the runner-up', () => {
    const accs = [acct('1', 'Telephone and Mobile Charges Paid'), acct('2', 'Postage')];
    const [r] = proposeAccountMappings({ ledgers: ledgers('Telephone Mobile Charges Paid'), accounts: accs, threshold: 0.8 });
    assert.equal(r.status, 'FUZZY');
    assert.equal(r.target_id, '1');
    assert.ok(r.score >= 0.8 && r.score < 1);
    assert.ok(r.candidates.length <= 3);
  });

  test('REVIEW: two near-identical candidates (no clear lead) are not auto-proposed', () => {
    const [r] = proposeAccountMappings({ ledgers: ledgers('Rent Paid Office Main'), accounts: [acct('5', 'Rent Paid Office North'), acct('6', 'Rent Paid Office South')], threshold: 0.6 });
    assert.equal(r.status, 'REVIEW');
    assert.equal(r.target_id, null);
    assert.equal(r.candidates.length, 2);
  });

  test('REVIEW: a middling score between reviewFloor and threshold', () => {
    const [r] = proposeAccountMappings({ ledgers: ledgers('Freight Outward'), accounts: [acct('3', 'Freight Inward')] });
    assert.equal(r.status, 'REVIEW');
    assert.equal(r.target_id, null);
    assert.equal(r.candidates[0].id, '3');
  });

  test('NONE: nothing resembles the name', () => {
    const [r] = proposeAccountMappings({ ledgers: ledgers('Zzzz Qqqq'), accounts });
    assert.equal(r.status, 'NONE');
    assert.equal(r.target_id, null);
  });

  test('group header (has children) is downgraded to REVIEW with a note, EXACT or FUZZY', () => {
    const accs = [
      acct('10', 'SUNDRY DEBTORS', { account_type: 'accounts_receivable' }),
      acct('11', 'Sundry Debtors-Corporate', { account_type: 'accounts_receivable', parent_account_id: '10', parent_account_name: 'SUNDRY DEBTORS', depth: 1 }),
    ];
    const [exact] = proposeAccountMappings({ ledgers: ledgers('Sundry Debtors'), accounts: accs });
    assert.equal(exact.status, 'REVIEW');
    assert.equal(exact.target_id, null);
    assert.equal(exact.note, 'Books account is a group header; choose a sub-account');
    assert.equal(exact.candidates[0].id, '10');
    const leaf = proposeAccountMappings({ ledgers: ledgers('Sundry Debtors Corporate'), accounts: accs });
    assert.equal(leaf[0].status, 'EXACT');
    assert.equal(leaf[0].target_id, '11');
    assert.equal(leaf[0].target_parent, 'SUNDRY DEBTORS');
  });

  test('DO NOT USE placeholders and inactive accounts are never proposed', () => {
    const accs = [
      acct('20', 'Office Expenses DO NOT USE'),
      acct('21', 'Office Expenses (DO_NOT_USE)'),
      acct('22', 'Office Expenses', { is_active: false }),
    ];
    const [r] = proposeAccountMappings({ ledgers: ledgers('Office Expenses'), accounts: accs });
    assert.equal(r.status, 'NONE');
    assert.equal(r.target_id, null);
    assert.deepEqual(r.candidates, []);
  });
});

describe('proposeContactMappings', () => {
  const accounts = [
    acct('30', 'Pay Clearing One', { account_code: 'PC001', account_type: 'other_current_asset' }),
    acct('31', 'Some Other Account', { account_code: 'ZZ' }),
  ];
  const contacts = [
    { contact_id: 'c1', contact_name: 'Acme Traders', contact_type: 'customer', status: 'active' },
    { contact_id: 'c2', contact_name: 'Acme Traders Pvt', contact_type: 'vendor', status: 'active' },
    { contact_id: 'c3', contact_name: 'Old Shop', contact_type: 'customer', status: 'inactive' },
    { contact_id: 'c4', contact_name: 'Twin Name', contact_type: 'customer', status: 'active' },
    { contact_id: 'c5', contact_name: 'Twin Name', contact_type: 'vendor', status: 'active' },
  ];
  const party = (code, name) => ({ party_code: code, party_name: name, usage_count: 4, ledger_codes: ['L1'] });

  test('party whose code equals a Books account_code maps to that ACCOUNT', () => {
    const [r] = proposeContactMappings({ parties: [party('pc001', 'Differently Named')], contacts, accounts });
    assert.equal(r.status, 'ACCOUNT');
    assert.equal(r.kind, 'account');
    assert.equal(r.target_id, '30');
    assert.equal(r.target_type, 'other_current_asset');
  });

  test('party whose name equals a Books account name maps to that ACCOUNT', () => {
    const [r] = proposeContactMappings({ parties: [party('X9', 'PAY CLEARING-ONE')], contacts, accounts });
    assert.equal(r.status, 'ACCOUNT');
    assert.equal(r.target_id, '30');
  });

  test('otherwise contacts: EXACT carries kind contact and contact_type', () => {
    const [r] = proposeContactMappings({ parties: [party('P1', 'ACME TRADERS')], contacts, accounts });
    assert.equal(r.status, 'EXACT');
    assert.equal(r.kind, 'contact');
    assert.equal(r.contact_type, 'customer');
    assert.equal(r.target_id, 'c1');
    assert.deepEqual(r.ledger_codes, ['L1']);
  });

  test('inactive contacts are ignored, duplicates are AMBIGUOUS, unknown is NONE', () => {
    const rows = proposeContactMappings({ parties: [party('P2', 'Old Shop'), party('P3', 'Twin Name'), party('P4', 'Qwertyuiop')], contacts, accounts });
    assert.equal(rows[0].status, 'NONE');
    assert.equal(rows[1].status, 'AMBIGUOUS');
    assert.equal(rows[1].target_id, null);
    assert.equal(rows[1].candidates.length, 2);
    assert.equal(rows[2].status, 'NONE');
  });
});

describe('buildRuleRows', () => {
  const accountProposals = [
    { source_key: 'L1', source_name: 'Rent', usage_count: 3, status: 'EXACT', target_id: 'a1', target_name: 'Rent', target_type: 'expense', target_parent: null, score: 1 },
    { source_key: 'L2', source_name: 'Fuel', usage_count: 2, status: 'FUZZY', target_id: 'a2', target_name: 'Fuel Cost', target_type: 'expense', target_parent: 'Costs', score: 0.91 },
    { source_key: 'L3', source_name: 'Misc', usage_count: 1, status: 'REVIEW', target_id: null, score: 0.6 },
    { source_key: 'L4', source_name: 'Misc2', usage_count: 1, status: 'NONE', target_id: null, score: 0 },
  ];
  const contactProposals = [
    { source_key: 'P1', source_name: 'Acme', usage_count: 5, status: 'EXACT', kind: 'contact', contact_type: 'customer', target_id: 'c1', target_name: 'Acme', target_type: 'customer', score: 1 },
    { source_key: 'P2', source_name: 'Clearing', usage_count: 1, status: 'ACCOUNT', kind: 'account', contact_type: null, target_id: 'a9', target_name: 'Clearing', target_type: 'other_current_asset', target_parent: null, score: 1 },
    { source_key: 'P3', source_name: 'Nobody', usage_count: 1, status: 'AMBIGUOUS', kind: 'contact', target_id: null, score: 1 },
  ];
  const rules = buildRuleRows({
    accountProposals, contactProposals, voucherTypes: ['RECEIPT', 'JOURNAL', 'PAYMENT', 'RECEIPT'],
    mappingVersion: 'map_test_v1', effectiveFrom: '2026-04-01', booksOrgId: 'ORG1', decidedOn: '2026-10-08',
  });
  const of = (type) => rules.filter((r) => r.rule_type === type);

  test('every rule is a DRAFT with no approval and an open window', () => {
    for (const r of rules) {
      assert.equal(r.status, 'DRAFT');
      assert.equal(r.effective_to, null);
      assert.equal(r.approved_by, null);
      assert.equal(r.mapping_version, 'map_test_v1');
      assert.equal(r.effective_from, '2026-04-01');
    }
  });

  test('MODULE_ROUTE: one per distinct type, journal target; notes non-empty except JOURNAL', () => {
    assert.deepEqual(of('MODULE_ROUTE').map((r) => r.source_key), ['JOURNAL', 'PAYMENT', 'RECEIPT']);
    for (const r of of('MODULE_ROUTE')) {
      assert.equal(r.target_value, 'journal');
      assert.deepEqual(r.target_meta, {});
      if (r.source_key === 'JOURNAL') assert.equal(r.notes, '');
      else assert.match(r.notes, /^Owner decision 2026-10-08: Eco Green (PAYMENT|RECEIPT) vouchers .* posted to Books as journals/);
    }
  });

  test('LEDGER_ACCOUNT only for EXACT and FUZZY, with the documented meta', () => {
    const l = of('LEDGER_ACCOUNT');
    assert.deepEqual(l.map((r) => r.source_key), ['L1', 'L2']);
    assert.equal(l[1].target_value, 'a2');
    assert.deepEqual(l[1].target_meta, {
      account_name: 'Fuel Cost', account_type: 'expense', parent_account_name: 'Costs', books_org_id: 'ORG1',
      match: { status: 'FUZZY', score: 0.91, source_name: 'Fuel', usage_count: 2 },
    });
  });

  test('PARTY: contact and account kinds; AMBIGUOUS skipped', () => {
    const p = of('PARTY');
    assert.deepEqual(p.map((r) => r.source_key), ['P1', 'P2']);
    assert.deepEqual(p[0].target_meta, {
      kind: 'contact', contact_name: 'Acme', contact_type: 'customer', books_org_id: 'ORG1',
      match: { status: 'EXACT', score: 1, source_name: 'Acme', usage_count: 5 },
    });
    assert.equal(p[1].target_meta.kind, 'account');
    assert.equal(p[1].target_meta.account_name, 'Clearing');
    assert.equal(p[1].target_meta.account_type, 'other_current_asset');
    assert.equal(p[1].target_value, 'a9');
  });

  test('non-JOURNAL routes need decidedOn; version and date are required', () => {
    assert.throws(() => buildRuleRows({ voucherTypes: ['RECEIPT'], mappingVersion: 'v', effectiveFrom: '2026-04-01' }), /decidedOn/);
    assert.throws(() => buildRuleRows({ voucherTypes: [], effectiveFrom: '2026-04-01' }), /mappingVersion/);
  });
});

describe('reviewCsv', () => {
  const rows = [
    { source_key: 'L1', source_name: 'Rent, "Main" Office', usage_count: 3, status: 'EXACT', target_id: 'a1', target_name: 'Rent', target_type: 'expense', target_parent: null, score: 1, candidates: [{ id: 'a1', name: 'Rent', score: 1 }, { id: 'a2', name: 'Rent Paid', score: 0.7 }], note: '' },
    { source_key: 'L2', source_name: 'Line\nbreak', usage_count: 1, status: 'REVIEW', target_id: null, target_name: null, target_type: null, target_parent: null, score: 0.6, candidates: [{ id: 'a5', name: 'Best', type: 'expense', parent: null, score: 0.6 }, { id: 'a6', name: 'Next', score: 0.55 }], note: 'check' },
  ];

  test('header, RFC 4180 quoting, and a blank reviewer area', () => {
    const csv = reviewCsv(rows, 'accounts');
    const { header, rows: parsed } = parseCsv(csv);
    assert.deepEqual(header, ['source_key', 'source_name', 'usage_count', 'status', 'proposed_target_id', 'proposed_target_name', 'target_type', 'target_parent', 'score', 'candidate_2', 'candidate_3', 'note', 'reviewer_decision', 'reviewer_target_id']);
    assert.equal(parsed.length, 2);
    assert.equal(parsed[0][1], 'Rent, "Main" Office');
    assert.equal(parsed[1][1], 'Line\nbreak');
    assert.equal(parsed[0][4], 'a1');
    assert.equal(parsed[0][9], 'Rent Paid [a2] 0.70');
    // no target: the best candidate is shown in the proposed columns, the next one in candidate_2
    assert.equal(parsed[1][4], 'a5');
    assert.equal(parsed[1][9], 'Next [a6] 0.55');
    assert.equal(parsed[0][12], '');
    assert.equal(parsed[0][13], '');
    assert.ok(csv.includes('"Rent, ""Main"" Office"'));
  });

  test('contacts sheet adds kind and contact_type after status', () => {
    const { header, rows: parsed } = parseCsv(reviewCsv([{ ...rows[0], kind: 'contact', contact_type: 'vendor' }], 'contacts'));
    assert.deepEqual(header.slice(3, 7), ['status', 'kind', 'contact_type', 'proposed_target_id']);
    assert.deepEqual(parsed[0].slice(3, 7), ['EXACT', 'contact', 'vendor', 'a1']);
  });
});
