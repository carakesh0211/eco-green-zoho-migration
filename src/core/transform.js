// Transformation preview (CONTRACTS.md §T). Builds Books-shaped payloads for MIGRATE
// vouchers. Never posts anything — this is a dry-run preview only (§Z guards live posting
// separately). Money in every payload is a "x.yy" string, never a Number.

import { parseMoney, formatMoney } from './money.js';
import { hashCanonical } from './hash.js';
import { uk, nowIso } from './ids.js';
import { assertTransition, RUN_TRANSITIONS, BATCH_STATES } from './states.js';
import { resolveRule } from './mapping.js';

export class UnmappedEntityError extends Error {
  constructor({ ruleType, sourceKey }) {
    super(`No APPROVED mapping rule for ${ruleType}/${sourceKey}`);
    this.code = 'UNMAPPED_ENTITY';
    this.ruleType = ruleType;
    this.sourceKey = sourceKey;
  }
}

export class InvalidRouteError extends Error {
  /**
   * Accepts either `{ voucherType, module, reason }` or a bare reason string.
   * The string form exists because the ledger-shape guards below know the module and
   * the reason but not the voucher type; passing a string to an object-destructuring
   * constructor silently produced "Invalid route undefined -> undefined: undefined"
   * and threw away the only useful part of the diagnostic.
   */
  constructor(arg) {
    const { voucherType, module, reason } = typeof arg === 'string' ? { reason: arg } : (arg ?? {});
    const route = voucherType || module ? `${voucherType ?? 'unknown type'} -> ${module ?? 'unknown module'}: ` : '';
    super(`Invalid route ${route}${reason ?? 'no reason given'}`);
    this.code = 'INVALID_TARGET_TYPE';
    this.voucherType = voucherType;
    this.module = module;
    this.reason = reason;
  }
}

/** mapping_rules.target_meta is a JSON string in store rows, but callers/tests may pass an object. */
function parseMeta(rule) {
  const raw = rule?.target_meta;
  if (raw === null || raw === undefined || raw === '') return {};
  if (typeof raw === 'object') return Array.isArray(raw) ? {} : raw;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

const CONTROL_ACCOUNT_TYPES = new Set(['accounts_receivable', 'accounts_payable']);

function lineAmount(line) {
  const d = parseMoney(line.debit);
  const c = parseMoney(line.credit);
  return formatMoney(d !== 0n ? d : c);
}

function nonZeroTotal(voucher) {
  const d = parseMoney(voucher.debit_total);
  return formatMoney(d !== 0n ? d : parseMoney(voucher.credit_total));
}

/**
 * Build the {location_id, reference_number, custom_fields} fields common to every
 * target module payload.
 */
function baseFields(voucher, lines, warnings) {
  if (!voucher.zoho_location_id) {
    throw new UnmappedEntityError({ ruleType: 'LOCATION_ID', sourceKey: 'zoho_location_id' });
  }
  const referenceNumber = voucher.source_document_no || lines?.[0]?.reference_no || '';
  const fields = {
    location_id: voucher.zoho_location_id,
    reference_number: referenceNumber,
    custom_fields: {
      cf_migration_source_hash: voucher.source_transaction_hash,
      cf_migration_batch: null,
    },
  };
  if (warnings && warnings.length) fields.warnings = [...warnings];
  return fields;
}

function debitLines(lines) {
  return lines.filter(l => parseMoney(l.debit) !== 0n);
}
function creditLines(lines) {
  return lines.filter(l => parseMoney(l.credit) !== 0n);
}

/**
 * For contact-based modules (bill, credit_note, vendor_credit) only ONE side of the
 * voucher is content; the other side is the party/control leg that Books derives from
 * the contact. Returns the content side and asserts the two sides tie, so the payload
 * total equals the voucher total (never double-counted, never posts the payable ledger
 * as a line item).
 */
function selectContentLines(lines, contentSide, module) {
  const content = contentSide === 'debit' ? debitLines(lines) : creditLines(lines);
  const party = contentSide === 'debit' ? creditLines(lines) : debitLines(lines);
  if (content.length === 0 || party.length === 0) {
    throw new InvalidRouteError({ module, reason: 'voucher must have both a content side and a party side' });
  }
  const contentTotal = content.reduce((t, l) => t + parseMoney(contentSide === 'debit' ? l.debit : l.credit), 0n);
  const partyTotal = party.reduce((t, l) => t + parseMoney(contentSide === 'debit' ? l.credit : l.debit), 0n);
  if (contentTotal !== partyTotal) {
    throw new InvalidRouteError({ module, reason: `content legs (${formatMoney(contentTotal)}) do not tie to party legs (${formatMoney(partyTotal)})` });
  }
  return content;
}

/**
 * Build a Books-shaped preview payload for one voucher.
 *
 * @param {object} params
 * @param {string} params.module         resolved target module (bill|vendor_payment|
 *                                        customer_payment|expense|credit_note|
 *                                        vendor_credit|bank_transfer|journal)
 * @param {object} params.voucher        vouchers row (source_transaction_type, transaction_date,
 *                                        zoho_location_id, party_code, payment_method,
 *                                        debit_total, credit_total, source_transaction_hash, ...)
 * @param {object[]} params.lines        source_txn_lines rows for this voucher
 * @param {object[]} [params.rules]      all mapping_rules rows (used when `resolve` is omitted)
 * @param {function} [params.resolve]    (ruleType, sourceKey, onDate) => rule|null; defaults to
 *                                        resolveRule(rules, ...). Throws AmbiguousMappingError.
 * @returns {{ payload: object, warnings: string[] }}
 */
export function buildPayload({ module, voucher, lines = [], rules = [], resolve }) {
  const resolveFn = resolve ?? ((ruleType, sourceKey, onDate) => resolveRule(rules, ruleType, sourceKey, onDate));
  const onDate = voucher.transaction_date;
  const warnings = [];

  const requireRule = (ruleType, sourceKey) => {
    const rule = resolveFn(ruleType, sourceKey, onDate);
    if (!rule) throw new UnmappedEntityError({ ruleType, sourceKey });
    return rule;
  };
  const maybeTaxValue = (taxBucket) => {
    if (!taxBucket) return undefined;
    return requireRule('TAX', taxBucket).target_value;
  };

  let payload;

  switch (module) {
    case 'bill': {
      const vendor = requireRule('PARTY', voucher.party_code).target_value;
      // A purchase voucher is Dr expense/asset legs, Cr vendor (payable). Books derives
      // the payable side from `vendor`; only the debit legs become line_items, and their
      // total must equal the excluded credit legs or the voucher is not a valid bill.
      const contentLines = selectContentLines(lines, 'debit', 'bill');
      const lineItems = contentLines.map(l => {
        const account = requireRule('LEDGER_ACCOUNT', l.ledger_code).target_value;
        const tax = maybeTaxValue(l.tax_bucket ?? voucher.tax_bucket);
        return { account, amount: lineAmount(l), ...(tax !== undefined ? { tax } : {}) };
      });
      payload = { vendor, date: onDate, line_items: lineItems, ...baseFields(voucher, lines, warnings) };
      break;
    }
    case 'vendor_payment':
    case 'customer_payment': {
      const contact = requireRule('PARTY', voucher.party_code).target_value;
      const paymentMode = requireRule('PAYMENT_MODE', voucher.payment_method).target_value;
      const base = baseFields(voucher, lines, warnings);
      payload = {
        contact, amount: nonZeroTotal(voucher), date: onDate, payment_mode: paymentMode,
        reference: base.reference_number, ...base,
      };
      break;
    }
    case 'expense': {
      const expenseLines = debitLines(lines);
      const paidThroughLines = creditLines(lines);
      const account = requireRule('LEDGER_ACCOUNT', (expenseLines[0] ?? lines[0]).ledger_code).target_value;
      const paidThrough = requireRule('LEDGER_ACCOUNT', (paidThroughLines[0] ?? lines[1] ?? lines[0]).ledger_code).target_value;
      const base = baseFields(voucher, lines, warnings);
      payload = { account, paid_through: paidThrough, amount: nonZeroTotal(voucher), date: onDate, ...base };
      if (voucher.party_code) payload.vendor = requireRule('PARTY', voucher.party_code).target_value;
      break;
    }
    case 'credit_note':
    case 'vendor_credit': {
      const contact = requireRule('PARTY', voucher.party_code).target_value;
      // credit_note (customer): Dr revenue-reversal legs, Cr customer -> content = debit legs.
      // vendor_credit:          Dr vendor, Cr expense-reversal legs -> content = credit legs.
      const contentLines = selectContentLines(lines, module === 'credit_note' ? 'debit' : 'credit', module);
      const lineItems = contentLines.map(l => {
        const account = requireRule('LEDGER_ACCOUNT', l.ledger_code).target_value;
        const tax = maybeTaxValue(l.tax_bucket ?? voucher.tax_bucket);
        return { account, amount: lineAmount(l), ...(tax !== undefined ? { tax } : {}) };
      });
      payload = { contact, date: onDate, line_items: lineItems, ...baseFields(voucher, lines, warnings) };
      break;
    }
    case 'bank_transfer': {
      const toLines = debitLines(lines);
      const fromLines = creditLines(lines);
      const toAccount = requireRule('LEDGER_ACCOUNT', (toLines[0] ?? lines[0]).ledger_code).target_value;
      const fromAccount = requireRule('LEDGER_ACCOUNT', (fromLines[0] ?? lines[1] ?? lines[0]).ledger_code).target_value;
      const base = baseFields(voucher, lines, warnings);
      payload = {
        from_account: fromAccount, to_account: toAccount, amount: nonZeroTotal(voucher), date: onDate,
        reference: base.reference_number, ...base,
      };
      break;
    }
    case 'journal': {
      if (voucher.source_transaction_type !== 'JOURNAL') {
        // Fallback routing: some other voucher_type has an explicit approved MODULE_ROUTE
        // rule pointing at 'journal'. Only acceptable when that rule documents the
        // reporting effect via a non-empty `notes` field.
        const routeRule = resolveFn('MODULE_ROUTE', voucher.source_transaction_type, onDate);
        if (!routeRule || !String(routeRule.notes ?? '').trim()) {
          throw new InvalidRouteError({
            voucherType: voucher.source_transaction_type, module: 'journal',
            reason: 'journal fallback requires an approved MODULE_ROUTE rule with non-empty notes',
          });
        }
        warnings.push('JOURNAL_FALLBACK_RULE');
      }
      // Every voucher of this source posts as a journal. A line that touches a receivable /
      // payable sub-account must carry the party as the Books contact on that line; parties
      // that live in Books as GL accounts (PARTY target_meta.kind === 'account') instead
      // replace the ledger account on the line.
      const addWarning = (w) => { if (!warnings.includes(w)) warnings.push(w); };
      const lineItems = lines.map(l => {
        const d = parseMoney(l.debit);
        const c = parseMoney(l.credit);
        const side = d !== 0n ? { debit: formatMoney(d) } : { credit: formatMoney(c) };
        const partyCode = l.party_code === null || l.party_code === undefined ? '' : String(l.party_code).trim();
        if (partyCode) {
          const partyRule = requireRule('PARTY', partyCode);
          const meta = parseMeta(partyRule);
          if (meta.kind === 'account') {
            addWarning('PARTY_POSTED_TO_ACCOUNT');
            return { account: partyRule.target_value, ...side };
          }
          const account = requireRule('LEDGER_ACCOUNT', l.ledger_code).target_value;
          return { account, contact: partyRule.target_value, contact_type: meta.contact_type ?? null, ...side };
        }
        const ledgerRule = requireRule('LEDGER_ACCOUNT', l.ledger_code);
        if (CONTROL_ACCOUNT_TYPES.has(parseMeta(ledgerRule).account_type)) addWarning('CONTROL_LINE_WITHOUT_PARTY');
        return { account: ledgerRule.target_value, ...side };
      });
      const notes = voucher.narration || lines?.[0]?.narration || '';
      const base = baseFields(voucher, lines, warnings);
      payload = { date: onDate, line_items: lineItems, notes, ...base };
      break;
    }
    default:
      throw new InvalidRouteError({ voucherType: voucher.source_transaction_type, module, reason: 'unknown target module' });
  }

  return payload;
}

/** One-line human-readable summary of a built payload, e.g.
 *  "bill V-PARTY-007 2026-04-03 ₹12,340.00 (2 lines)". */
export function humanSummary(module, payload) {
  const lineItems = payload.line_items;
  let amountPaise;
  let lineCount;
  if (Array.isArray(lineItems)) {
    amountPaise = lineItems.reduce((t, li) => {
      const v = li.amount ?? li.debit ?? li.credit ?? '0.00';
      return t + parseMoney(v);
    }, 0n);
    lineCount = lineItems.length;
  } else {
    amountPaise = parseMoney(payload.amount ?? '0.00');
    lineCount = 1;
  }
  const amount = formatMoney(amountPaise).replace(/\B(?=(\d{3})+(?!\d)(?=\.))/g, ',');
  const ref = payload.reference_number || '';
  return `${module} ${ref} ${payload.date} ₹${amount} (${lineCount} line${lineCount === 1 ? '' : 's'})`;
}

/**
 * Orchestrator: transform every MIGRATE voucher of a run into a preview payload,
 * writing preview_payloads and stamping the voucher's target_module/payload_hash/
 * mapping_version/transformation_version, or blocking it with an UNMAPPED_ENTITY
 * exception. Not covered by pure-function tests (requires a store).
 *
 * mapping_version choice (documented per CONTRACTS.md §T): the lexicographically
 * greatest `mapping_version` among APPROVED MODULE_ROUTE rules actually used to route
 * this run's vouchers ("highest ... in use"). Pilot mapping_version strings are of the
 * form `map_v<N>`, which sort correctly under plain string comparison.
 */
export async function transformRun(ctx, { runId, transformationVersion = 'tx_v1' }) {
  const { store, audit } = ctx;
  const now = ctx.now ? ctx.now() : nowIso();
  const { raise } = await import('./exceptions.js');

  const run = await store.get('extraction_runs', runId);
  const allRules = await store.find('mapping_rules', { status: 'APPROVED' });
  const vouchers = await store.find('vouchers', { extraction_run_id: runId, disposition: 'MIGRATE' });

  const usedModuleRouteVersions = new Set();

  for (const voucher of vouchers) {
    const routeRule = resolveRule(allRules, 'MODULE_ROUTE', voucher.source_transaction_type, voucher.transaction_date);
    if (!routeRule) {
      await raise(ctx, {
        category: 'UNMAPPED_ENTITY', severity: 'P1', message: `No MODULE_ROUTE for ${voucher.source_transaction_type}`,
        dedupeKey: `tx:${voucher.id}:MODULE_ROUTE:${voucher.source_transaction_type}`,
        branchCode: voucher.branch_code, period: voucher.period, runId, voucherId: voucher.id,
      });
      await store.update('vouchers', voucher.id, { disposition: 'BLOCKED', disposition_reason: 'UNMAPPED_ENTITY' });
      continue;
    }
    usedModuleRouteVersions.add(routeRule.mapping_version);

    const lines = await store.find('source_txn_lines', { run_id: runId, voucher_id: voucher.source_record_id });

    let payload;
    try {
      payload = buildPayload({
        module: routeRule.target_value, voucher, lines, rules: allRules,
        resolve: (rt, sk, d) => resolveRule(allRules, rt, sk, d),
      });
    } catch (err) {
      if (err.code === 'UNMAPPED_ENTITY') {
        await raise(ctx, {
          category: 'UNMAPPED_ENTITY', severity: 'P1', message: err.message,
          dedupeKey: `tx:${voucher.id}:${err.ruleType}:${err.sourceKey}`,
          branchCode: voucher.branch_code, period: voucher.period, runId, voucherId: voucher.id,
        });
        await store.update('vouchers', voucher.id, { disposition: 'BLOCKED', disposition_reason: 'UNMAPPED_ENTITY' });
        continue;
      }
      throw err;
    }

    const payloadHash = hashCanonical(payload);
    const payloadUk = uk(voucher.id, transformationVersion, routeRule.mapping_version);
    const existing = await store.findOne('preview_payloads', { uk: payloadUk });
    if (!existing) {
      await store.insert('preview_payloads', {
        voucher_id: voucher.id, target_module: routeRule.target_value, payload_json: JSON.stringify(payload),
        payload_hash: payloadHash, human_summary: humanSummary(routeRule.target_value, payload),
        mapping_version: routeRule.mapping_version, transformation_version: transformationVersion,
        warnings_json: JSON.stringify(payload.warnings ?? []), uk: payloadUk, created_at: now,
      });
    } else if (existing.payload_hash !== payloadHash) {
      // Same voucher/version key but the mapping rules changed underneath it (e.g. a rule
      // was corrected in place): refresh the stored preview so it matches the stamped hash.
      await store.update('preview_payloads', existing.id, {
        target_module: routeRule.target_value, payload_json: JSON.stringify(payload), payload_hash: payloadHash,
        human_summary: humanSummary(routeRule.target_value, payload),
        warnings_json: JSON.stringify(payload.warnings ?? []),
      });
    }
    await store.update('vouchers', voucher.id, {
      target_module: routeRule.target_value, target_payload_hash: payloadHash,
      mapping_version: routeRule.mapping_version, transformation_version: transformationVersion,
    });
  }

  const mappingVersion = [...usedModuleRouteVersions].sort().at(-1) ?? null;

  if (run) assertTransition(RUN_TRANSITIONS, 'run', run.status, 'TRANSFORMED');
  await store.update('extraction_runs', runId, { status: 'TRANSFORMED', updated_at: now });
  await audit.emit({
    actor: ctx.actor ?? 'worker', action: 'TRANSFORM.RUN', entityType: 'extraction_run', entityId: runId,
    after: { status: 'TRANSFORMED', mappingVersion, transformationVersion },
    correlationId: ctx.correlationId, branchCode: run?.branch_code,
  });

  return { runId, status: 'TRANSFORMED', mappingVersion, transformationVersion };
}

const RETRANSFORM_RUN_STATES = new Set(['CLASSIFIED', 'TRANSFORMED', 'READY_FOR_APPROVAL']);
const RETRANSFORM_BATCH_STATES = new Set([BATCH_STATES.DRAFT, BATCH_STATES.REJECTED, BATCH_STATES.APPROVAL_INVALIDATED]);

function codedError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/**
 * Re-run the transform after mapping rules changed. Vouchers BLOCKED for UNMAPPED_ENTITY
 * are put back to MIGRATE (their open UNMAPPED_ENTITY exceptions resolved first; a
 * still-unmapped voucher is re-blocked by transformRun, and exceptions.raise() reopens the
 * RESOLVED exception on the same dedupeKey), the run is stepped back to CLASSIFIED and
 * transformRun is executed again. Refused while any batch of the run is past DRAFT.
 */
export async function retransformRun(ctx, { runId, transformationVersion = 'tx_v1' }) {
  const { store, audit } = ctx;
  const now = ctx.now ? ctx.now() : nowIso();
  const { resolve: resolveException } = await import('./exceptions.js');

  const run = await store.get('extraction_runs', runId);
  if (!run) throw codedError('NOT_FOUND', `Run not found: ${runId}`);
  if (!RETRANSFORM_RUN_STATES.has(run.status)) {
    throw codedError('INVALID_RUN_STATE', `Cannot re-transform a run in status ${run.status}`);
  }
  const batches = await store.find('migration_batches', { run_id: runId });
  const busy = batches.find(b => !RETRANSFORM_BATCH_STATES.has(b.status));
  if (busy) {
    throw codedError('BATCH_IN_PROGRESS', `Batch ${busy.id} is ${busy.status}; re-transform needs every batch DRAFT, REJECTED or APPROVAL_INVALIDATED`);
  }

  const blocked = await store.find('vouchers', {
    extraction_run_id: runId, disposition: 'BLOCKED', disposition_reason: 'UNMAPPED_ENTITY',
  });
  for (const voucher of blocked) {
    await store.update('vouchers', voucher.id, {
      disposition: 'MIGRATE', disposition_reason: null, disposition_by: ctx.actor ?? 'worker',
      disposition_at: now, target_module: null, target_payload_hash: null,
    });
    const excs = await store.find('exceptions', { voucher_id: voucher.id, category: 'UNMAPPED_ENTITY' });
    for (const exc of excs) {
      if (exc.status !== 'OPEN' && exc.status !== 'ASSIGNED') continue;
      await resolveException(ctx, {
        id: exc.id, status: 'RESOLVED', rootCause: 'Re-transformed after mapping change', actor: ctx.actor ?? 'worker',
      });
    }
  }

  if (run.status !== 'CLASSIFIED') {
    assertTransition(RUN_TRANSITIONS, 'run', run.status, 'CLASSIFIED');
    await store.update('extraction_runs', runId, { status: 'CLASSIFIED', updated_at: now });
  }
  await audit.emit({
    actor: ctx.actor ?? 'worker', action: 'TRANSFORM.RERUN', entityType: 'extraction_run', entityId: runId,
    after: { reset: blocked.length }, correlationId: ctx.correlationId, branchCode: run.branch_code,
  });

  const result = await transformRun(ctx, { runId, transformationVersion });
  const stillBlocked = (await store.find('vouchers', {
    extraction_run_id: runId, disposition: 'BLOCKED', disposition_reason: 'UNMAPPED_ENTITY',
  })).length;
  return { ...result, reset: blocked.length, stillBlocked };
}
