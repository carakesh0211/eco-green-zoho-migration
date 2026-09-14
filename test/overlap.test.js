import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { classifyOverlap, CLASSIFICATIONS, MATCH_STRENGTHS } from '../src/core/overlap.js';

function voucher(overrides = {}) {
  return {
    branch_code: 'PILOT01',
    transaction_date: '2026-05-10',
    voucher_type: 'SALES_B2C',
    payment_method: 'CASH',
    tax_bucket: 'GST5',
    amount: '1000.00',
    reference_no: '',
    ...overrides,
  };
}

function evidence(overrides = {}) {
  return {
    branch_code: 'PILOT01',
    business_date: '2026-05-10',
    transaction_class: 'SALES_B2C',
    payment_method: 'CASH',
    tax_bucket: 'GST5',
    amount: '1000.00',
    sp_batch_ref: 'SPB-001',
    books_record_id: null,
    books_module: 'sales_receipt',
    ...overrides,
  };
}

function coveredRule(overrides = {}) {
  return { smart_pharma_coverage_status: 'COVERED', ...overrides };
}

describe('classifyOverlap', () => {
  test('NOT_COVERED rule -> NOT_APPLICABLE regardless of evidence', () => {
    const r = classifyOverlap({ rule: { smart_pharma_coverage_status: 'NOT_COVERED' }, voucher: voucher(), spEvidence: [evidence()] });
    assert.equal(r.classification, CLASSIFICATIONS.NOT_APPLICABLE);
  });

  test('UNKNOWN coverage -> PARTIAL_OR_AMBIGUOUS_OVERLAP even with a perfect evidence row', () => {
    const r = classifyOverlap({ rule: { smart_pharma_coverage_status: 'UNKNOWN' }, voucher: voucher(), spEvidence: [evidence()] });
    assert.equal(r.classification, CLASSIFICATIONS.PARTIAL_OR_AMBIGUOUS_OVERLAP);
    assert.equal(r.matchStrength, MATCH_STRENGTHS.COVERAGE_RULE);
  });

  test('missing coverage_status is treated as UNKNOWN -> ambiguous', () => {
    const r = classifyOverlap({ rule: {}, voucher: voucher(), spEvidence: [evidence()] });
    assert.equal(r.classification, CLASSIFICATIONS.PARTIAL_OR_AMBIGUOUS_OVERLAP);
  });

  test('full field match + reference present + reference echoed on voucher -> SMART_PHARMA_ALREADY_POSTED FULL_EVIDENCE', () => {
    const v = voucher({ reference_no: 'BANK-REF SPB-001 UTR123' });
    const r = classifyOverlap({ rule: coveredRule(), voucher: v, spEvidence: [evidence()] });
    assert.equal(r.classification, CLASSIFICATIONS.SMART_PHARMA_ALREADY_POSTED);
    assert.equal(r.matchStrength, MATCH_STRENGTHS.FULL_EVIDENCE);
  });

  test('full field match + reference present but NOT echoed on voucher -> REFERENCE_MATCH (still SMART_PHARMA_ALREADY_POSTED)', () => {
    const r = classifyOverlap({ rule: coveredRule(), voucher: voucher(), spEvidence: [evidence()] });
    assert.equal(r.classification, CLASSIFICATIONS.SMART_PHARMA_ALREADY_POSTED);
    assert.equal(r.matchStrength, MATCH_STRENGTHS.REFERENCE_MATCH);
  });

  test('books_record_id alone counts as the stable reference', () => {
    const ev = evidence({ sp_batch_ref: null, books_record_id: 'BOOKS-99' });
    const r = classifyOverlap({ rule: coveredRule(), voucher: voucher(), spEvidence: [ev] });
    assert.equal(r.classification, CLASSIFICATIONS.SMART_PHARMA_ALREADY_POSTED);
    assert.equal(r.evidence.books_record_id, 'BOOKS-99');
  });

  test('amount+date-only evidence (everything else missing) -> PARTIAL_OR_AMBIGUOUS_OVERLAP, never a match', () => {
    const ev = evidence({ branch_code: 'OTHER_BRANCH', transaction_class: 'OTHER', payment_method: 'CARD', tax_bucket: 'GST18', sp_batch_ref: null, books_record_id: null });
    const r = classifyOverlap({ rule: coveredRule(), voucher: voucher(), spEvidence: [ev] });
    assert.equal(r.classification, CLASSIFICATIONS.PARTIAL_OR_AMBIGUOUS_OVERLAP);
    assert.equal(r.matchStrength, MATCH_STRENGTHS.DATE_ONLY);
    assert.deepEqual(r.evidence.matchedFields.sort(), ['amount', 'business_date']);
  });

  test('date-only evidence -> PARTIAL_OR_AMBIGUOUS_OVERLAP, DATE_ONLY', () => {
    const ev = evidence({ amount: '9999.00', branch_code: 'OTHER', transaction_class: 'OTHER', payment_method: 'CARD', tax_bucket: 'GST18', sp_batch_ref: null, books_record_id: null });
    const r = classifyOverlap({ rule: coveredRule(), voucher: voucher(), spEvidence: [ev] });
    assert.equal(r.classification, CLASSIFICATIONS.PARTIAL_OR_AMBIGUOUS_OVERLAP);
    assert.equal(r.matchStrength, MATCH_STRENGTHS.DATE_ONLY);
    assert.deepEqual(r.evidence.matchedFields, ['business_date']);
  });

  test('missing payment_method match (everything else + reference present) -> PARTIAL_OR_AMBIGUOUS_OVERLAP, not a posted match', () => {
    const ev = evidence({ payment_method: 'CARD' });
    const r = classifyOverlap({ rule: coveredRule(), voucher: voucher(), spEvidence: [ev] });
    assert.equal(r.classification, CLASSIFICATIONS.PARTIAL_OR_AMBIGUOUS_OVERLAP);
    assert.ok(r.evidence.unmatchedFields.includes('payment_method'));
    assert.ok(r.evidence.matchedFields.includes('amount'));
  });

  test('full field match but NO stable reference -> PARTIAL_OR_AMBIGUOUS_OVERLAP', () => {
    const ev = evidence({ sp_batch_ref: null, books_record_id: null });
    const r = classifyOverlap({ rule: coveredRule(), voucher: voucher(), spEvidence: [ev] });
    assert.equal(r.classification, CLASSIFICATIONS.PARTIAL_OR_AMBIGUOUS_OVERLAP);
    assert.equal(r.evidence.hasReference, false);
  });

  test('two full-match evidence rows for the same voucher -> ambiguous, both refs listed', () => {
    const ev1 = evidence({ sp_batch_ref: 'SPB-001' });
    const ev2 = evidence({ sp_batch_ref: 'SPB-002' });
    const r = classifyOverlap({ rule: coveredRule(), voucher: voucher(), spEvidence: [ev1, ev2] });
    assert.equal(r.classification, CLASSIFICATIONS.PARTIAL_OR_AMBIGUOUS_OVERLAP);
    assert.equal(r.evidence.ambiguous, true);
    assert.deepEqual(r.evidence.candidates.map(c => c.sp_batch_ref).sort(), ['SPB-001', 'SPB-002']);
  });

  test('PARTIAL coverage status behaves like COVERED for evidence matching', () => {
    const r = classifyOverlap({ rule: coveredRule({ smart_pharma_coverage_status: 'PARTIAL' }), voucher: voucher(), spEvidence: [evidence()] });
    assert.equal(r.classification, CLASSIFICATIONS.SMART_PHARMA_ALREADY_POSTED);
  });

  test('COVERED rule with zero evidence -> PARTIAL_OR_AMBIGUOUS_OVERLAP (blocked, never assumed clean)', () => {
    const r = classifyOverlap({ rule: coveredRule(), voucher: voucher(), spEvidence: [] });
    assert.equal(r.classification, CLASSIFICATIONS.PARTIAL_OR_AMBIGUOUS_OVERLAP);
    assert.equal(r.matchStrength, MATCH_STRENGTHS.NONE);
  });

  test('money compare exactness: "1000.00" vs "1000.0" vs "1,000.00" all equal; "1000.01" does not match', () => {
    const evEqual = evidence({ amount: '1,000.00' });
    const rEqual = classifyOverlap({ rule: coveredRule(), voucher: voucher({ amount: '1000.0' }), spEvidence: [evEqual] });
    assert.equal(rEqual.classification, CLASSIFICATIONS.SMART_PHARMA_ALREADY_POSTED);

    const evOff = evidence({ amount: '1000.01' });
    const rOff = classifyOverlap({ rule: coveredRule(), voucher: voucher(), spEvidence: [evOff] });
    assert.equal(rOff.classification, CLASSIFICATIONS.PARTIAL_OR_AMBIGUOUS_OVERLAP);
    assert.ok(rOff.evidence.unmatchedFields.includes('amount'));
  });
});
