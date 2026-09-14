// Smart Pharma overlap gate (CONTRACTS.md §K, DATA_CONTRACT.md §7).
//
// Smart Pharma has ALREADY posted some populations to the live Zoho Books org.
// Duplicating them is a critical failure, so this gate is deliberately conservative:
// amount-only or date-only evidence NEVER counts as a match, any COVERED/PARTIAL
// rule with less than full-field + stable-reference evidence blocks (never silently
// excludes), and more than one candidate match is treated as ambiguous rather than
// guessed at.

import { parseMoney } from './money.js';
import { uk, nowIso } from './ids.js';
import { resolveCutover, evaluateEligibility } from './cutover.js';
import { assertTransition, RUN_TRANSITIONS } from './states.js';

export const CLASSIFICATIONS = Object.freeze({
  MIGRATE: 'MIGRATE',
  SMART_PHARMA_ALREADY_POSTED: 'SMART_PHARMA_ALREADY_POSTED',
  PARTIAL_OR_AMBIGUOUS_OVERLAP: 'PARTIAL_OR_AMBIGUOUS_OVERLAP',
  NOT_APPLICABLE: 'NOT_APPLICABLE',
});

// Matches the `match_strength` comment on overlap_candidates in schema.sql.
export const MATCH_STRENGTHS = Object.freeze({
  NONE: 'NONE',
  DATE_ONLY: 'DATE_ONLY',
  COVERAGE_RULE: 'COVERAGE_RULE',
  REFERENCE_MATCH: 'REFERENCE_MATCH',
  FULL_EVIDENCE: 'FULL_EVIDENCE',
});

const CORE_FIELDS = ['branch_code', 'business_date', 'transaction_class', 'payment_method', 'tax_bucket', 'amount'];

function amountsEqual(a, b) {
  try {
    return parseMoney(a) === parseMoney(b);
  } catch {
    return false;
  }
}

/** Per-field comparison of one Smart Pharma evidence row against a voucher's overlap view. */
function fieldMatch(ev, voucher) {
  return {
    branch_code: ev.branch_code === voucher.branch_code,
    business_date: ev.business_date === voucher.transaction_date,
    transaction_class: ev.transaction_class === voucher.voucher_type,
    payment_method: ev.payment_method === voucher.payment_method,
    tax_bucket: ev.tax_bucket === voucher.tax_bucket,
    amount: amountsEqual(ev.amount, voucher.amount),
    hasReference: Boolean(ev.sp_batch_ref) || Boolean(ev.books_record_id),
  };
}

function coreMatchCount(fields) {
  return CORE_FIELDS.reduce((n, f) => n + (fields[f] ? 1 : 0), 0);
}

function isFullCoreMatch(fields) {
  return CORE_FIELDS.every(f => fields[f]);
}

function referenceOf(ev) {
  return ev.sp_batch_ref || ev.books_record_id || null;
}

/** Does the voucher's own reference_no already carry this Smart Pharma reference? */
function voucherCarriesReference(voucher, ref) {
  if (!ref) return false;
  const voucherRef = voucher.reference_no ?? voucher.reference_number ?? '';
  return String(voucherRef).includes(String(ref));
}

/**
 * Classify one voucher against the cutover rule's Smart Pharma coverage status and
 * the available Smart Pharma evidence rows.
 *
 * rule.smart_pharma_coverage_status: NOT_COVERED | COVERED | PARTIAL | UNKNOWN
 * voucher: { branch_code, transaction_date, voucher_type, payment_method, tax_bucket,
 *            amount, reference_no }  (amount = money string or BigInt paise)
 * spEvidence: array of { branch_code, business_date, transaction_class, payment_method,
 *            tax_bucket, amount, sp_batch_ref, books_record_id, books_module }
 *
 * Returns { classification, matchStrength, evidence }.
 */
export function classifyOverlap({ rule, voucher, spEvidence = [] }) {
  const coverage = rule?.smart_pharma_coverage_status;

  if (coverage === 'NOT_COVERED') {
    return {
      classification: CLASSIFICATIONS.NOT_APPLICABLE,
      matchStrength: MATCH_STRENGTHS.NONE,
      evidence: { coverage: 'NOT_COVERED' },
    };
  }

  if (coverage !== 'COVERED' && coverage !== 'PARTIAL') {
    // UNKNOWN, missing, or any unrecognised status is treated as UNKNOWN: block, never guess.
    return {
      classification: CLASSIFICATIONS.PARTIAL_OR_AMBIGUOUS_OVERLAP,
      matchStrength: MATCH_STRENGTHS.COVERAGE_RULE,
      evidence: { coverage: coverage ?? 'UNKNOWN', reason: 'COVERAGE_UNKNOWN' },
    };
  }

  // COVERED or PARTIAL: evaluate evidence. Amount-only or date-only matches never
  // count — a candidate must match ALL core fields plus carry a stable reference.
  const candidates = (spEvidence ?? []).map(ev => ({ ev, fields: fieldMatch(ev, voucher) }));
  const fullMatches = candidates.filter(c => isFullCoreMatch(c.fields) && c.fields.hasReference);

  if (fullMatches.length === 1) {
    const { ev } = fullMatches[0];
    const ref = referenceOf(ev);
    const strength = voucherCarriesReference(voucher, ref)
      ? MATCH_STRENGTHS.FULL_EVIDENCE
      : MATCH_STRENGTHS.REFERENCE_MATCH;
    return {
      classification: CLASSIFICATIONS.SMART_PHARMA_ALREADY_POSTED,
      matchStrength: strength,
      evidence: {
        matchedFields: CORE_FIELDS,
        sp_batch_ref: ev.sp_batch_ref ?? null,
        books_record_id: ev.books_record_id ?? null,
        books_module: ev.books_module ?? null,
      },
    };
  }

  if (fullMatches.length > 1) {
    return {
      classification: CLASSIFICATIONS.PARTIAL_OR_AMBIGUOUS_OVERLAP,
      matchStrength: MATCH_STRENGTHS.REFERENCE_MATCH,
      evidence: {
        ambiguous: true,
        reason: 'MULTIPLE_EVIDENCE_ROWS_MATCH',
        candidates: fullMatches.map(c => ({
          sp_batch_ref: c.ev.sp_batch_ref ?? null,
          books_record_id: c.ev.books_record_id ?? null,
        })),
      },
    };
  }

  // No full match. Report the strongest partial candidate's field-by-field result so
  // reviewers can see exactly what did and did not line up; never infer a match from it.
  let best = null;
  for (const c of candidates) {
    const n = coreMatchCount(c.fields);
    if (!best || n > coreMatchCount(best.fields)) best = c;
  }

  if (!best) {
    return {
      classification: CLASSIFICATIONS.PARTIAL_OR_AMBIGUOUS_OVERLAP,
      matchStrength: MATCH_STRENGTHS.NONE,
      evidence: { reason: 'NO_EVIDENCE', coverage },
    };
  }

  const matchedFields = CORE_FIELDS.filter(f => best.fields[f]);
  const unmatchedFields = CORE_FIELDS.filter(f => !best.fields[f]);
  // "Weak" evidence per PROJECT_CONTEXT: amount-only or date-only matches never count.
  const isWeak = matchedFields.every(f => f === 'business_date' || f === 'amount');
  return {
    classification: CLASSIFICATIONS.PARTIAL_OR_AMBIGUOUS_OVERLAP,
    matchStrength: isWeak ? MATCH_STRENGTHS.DATE_ONLY : MATCH_STRENGTHS.REFERENCE_MATCH,
    evidence: {
      reason: 'PARTIAL_FIELD_MATCH',
      matchedFields,
      unmatchedFields,
      hasReference: best.fields.hasReference,
      sp_batch_ref: best.ev.sp_batch_ref ?? null,
      books_record_id: best.ev.books_record_id ?? null,
    },
  };
}

/**
 * Orchestrator: classify every PENDING (not already-BLOCKED-from-staging) voucher of a
 * run against the approved cutover matrix + Smart Pharma evidence, writing
 * overlap_candidates, updating voucher disposition, and raising exceptions per §K.
 * Not covered by pure-function tests (requires a store); documented for the
 * store/audit/exceptions modules built alongside this one.
 */
export async function classifyRun(ctx, { runId, spEvidence = [], ruleVersion }) {
  const { store, audit } = ctx;
  const now = ctx.now ? ctx.now() : nowIso();

  // exceptions.js is owned/built concurrently; import lazily so this module (and its
  // pure-function exports resolveCutover/evaluateEligibility/classifyOverlap) can be
  // loaded and unit-tested even before exceptions.js exists.
  const { raise } = await import('./exceptions.js');

  const matrixRows = await store.find('cutover_matrix', { approval_status: 'APPROVED' });
  const moduleRouteRules = await store.find('mapping_rules', { rule_type: 'MODULE_ROUTE', status: 'APPROVED' });
  const vouchers = await store.find('vouchers', { extraction_run_id: runId });

  const run = await store.get('extraction_runs', runId);

  for (const voucher of vouchers) {
    if (voucher.disposition !== 'PENDING') continue; // leave staging BLOCKED untouched

    if (voucher.source_transaction_type === 'STOCK_ADJ') {
      await store.update('vouchers', voucher.id, {
        disposition: 'OTHER_EXCLUDED',
        disposition_reason: 'INV_CONTROL_ONLY_v1',
        disposition_rule_version: ruleVersion,
        disposition_by: ctx.actor ?? 'worker',
        disposition_at: now,
      });
      await audit.emit({
        actor: ctx.actor ?? 'worker', action: 'CLASSIFY.INVENTORY_ONLY', entityType: 'voucher',
        entityId: String(voucher.id), after: { disposition: 'OTHER_EXCLUDED', reason: 'INV_CONTROL_ONLY_v1' },
        correlationId: ctx.correlationId, branchCode: voucher.branch_code, period: voucher.period,
      });
      continue;
    }

    const rule = resolveCutover(matrixRows, {
      branchCode: voucher.branch_code,
      voucherType: voucher.source_transaction_type,
      paymentMethod: voucher.payment_method,
    });
    const { eligible, reason } = evaluateEligibility(rule, {
      transaction_date: voucher.transaction_date,
      source_modified_at: voucher.source_modified_at,
    });

    const stampDisposition = async (disposition, dispositionReason, extra = {}) => {
      await store.update('vouchers', voucher.id, {
        disposition, disposition_reason: dispositionReason, disposition_rule_version: ruleVersion,
        disposition_by: ctx.actor ?? 'worker', disposition_at: now, ...extra,
      });
    };

    if (!eligible) {
      if (reason === 'AFTER_CUTOVER' || reason === 'BEFORE_MIGRATION_FROM') {
        await stampDisposition('OTHER_EXCLUDED', reason);
        continue;
      }
      // RULE_MISSING, LIVE_START_UNVERIFIED, LATE_OR_BACK_POSTED -> BLOCKED + exception.
      const category = reason === 'LATE_OR_BACK_POSTED' ? 'LATE_OR_BACK_POSTED' : 'CUTOVER_RULE_MISSING';
      await stampDisposition('BLOCKED', reason);
      await raise(ctx, {
        category, severity: 'P1', message: `Voucher ${voucher.id} blocked: ${reason}`,
        dedupeKey: `cls:${voucher.id}:${category}`, branchCode: voucher.branch_code, period: voucher.period,
        runId, voucherId: voucher.id,
      });
      continue;
    }

    const overlapView = {
      branch_code: voucher.branch_code,
      transaction_date: voucher.transaction_date,
      voucher_type: voucher.source_transaction_type,
      payment_method: voucher.payment_method,
      tax_bucket: voucher.tax_bucket,
      amount: voucher.debit_total !== '0.00' ? voucher.debit_total : voucher.credit_total,
      reference_no: voucher.source_document_no,
    };
    const relevantEvidence = spEvidence.filter(ev => ev.branch_code === voucher.branch_code);
    const { classification, matchStrength, evidence } = classifyOverlap({
      rule, voucher: overlapView, spEvidence: relevantEvidence,
    });

    const candidateUk = uk(voucher.id, ruleVersion);
    const existingCandidate = await store.findOne('overlap_candidates', { uk: candidateUk });
    if (!existingCandidate) {
      await store.insert('overlap_candidates', {
        voucher_id: voucher.id,
        population_key: uk(voucher.branch_code, voucher.transaction_date, voucher.source_transaction_type, voucher.payment_method, voucher.tax_bucket),
        classification, match_strength: matchStrength, evidence_json: JSON.stringify(evidence),
        rule_version: ruleVersion, uk: candidateUk, created_at: now,
      });
    }

    if (classification === 'SMART_PHARMA_ALREADY_POSTED') {
      const ref = evidence.sp_batch_ref || evidence.books_record_id;
      await stampDisposition('SMART_PHARMA_EXCLUDED', `SMART_PHARMA_ALREADY_POSTED:${ref}`, {
        disposition_evidence_json: JSON.stringify(evidence),
      });
      continue;
    }

    if (classification === 'PARTIAL_OR_AMBIGUOUS_OVERLAP') {
      await stampDisposition('BLOCKED', 'PARTIAL_OR_AMBIGUOUS_OVERLAP', {
        disposition_evidence_json: JSON.stringify(evidence),
      });
      await raise(ctx, {
        category: 'SMART_PHARMA_OVERLAP', severity: 'P1', message: `Voucher ${voucher.id} ambiguous Smart Pharma overlap`,
        dedupeKey: `cls:${voucher.id}:SMART_PHARMA_OVERLAP`, branchCode: voucher.branch_code, period: voucher.period,
        runId, voucherId: voucher.id, evidence,
      });
      continue;
    }

    // NOT_APPLICABLE / MIGRATE classification from the overlap gate: check module mapping.
    const routeRule = moduleRouteRules.find(r => r.source_key === voucher.source_transaction_type);
    if (!routeRule) {
      await stampDisposition('BLOCKED', 'UNMAPPED_MODULE');
      await raise(ctx, {
        category: 'UNMAPPED_MODULE', severity: 'P1', message: `No approved MODULE_ROUTE for ${voucher.source_transaction_type}`,
        dedupeKey: `cls:${voucher.id}:UNMAPPED_MODULE`, branchCode: voucher.branch_code, period: voucher.period,
        runId, voucherId: voucher.id,
      });
      continue;
    }

    await stampDisposition('MIGRATE', 'IN_WINDOW');
  }

  if (run) assertTransition(RUN_TRANSITIONS, 'run', run.status, 'CLASSIFIED');
  await store.update('extraction_runs', runId, { status: 'CLASSIFIED', updated_at: now });
  await audit.emit({
    actor: ctx.actor ?? 'worker', action: 'CLASSIFY.RUN', entityType: 'extraction_run', entityId: runId,
    after: { status: 'CLASSIFIED' }, correlationId: ctx.correlationId, branchCode: run?.branch_code,
  });

  return { runId, status: 'CLASSIFIED' };
}
