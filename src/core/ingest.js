// Validation + ingestion (CONTRACTS.md §V, DATA_CONTRACT.md §1-4).
// Steps 1-8, each audited as INGEST.<STEP>. Outcomes:
//   DUPLICATE_MANIFEST | CLAIM_LOST | VALIDATION_FAILED | STAGED | EXCEPTION
import { parseCsv, detectEncoding, decode } from './csv.js';
import { validateManifest, validateHeader, TRANSACTIONS_COLUMNS, TRIAL_BALANCE_COLUMNS } from './manifest.js';
import { sha256Bytes, rowHash, sourceTransactionHash } from './hash.js';
import { parseMoney, formatMoney } from './money.js';
import { nowIso, financialYearOf, periodOf, isIsoDate, uk } from './ids.js';
import { assertTransition, RUN_TRANSITIONS, RUN_STATES } from './states.js';

const VOUCHER_TYPES = new Set([
  'PURCHASE', 'PAYMENT', 'RECEIPT', 'EXPENSE', 'CREDIT_NOTE', 'DEBIT_NOTE',
  'CONTRA', 'JOURNAL', 'SALES_B2C', 'STOCK_ADJ',
]);

const DEFAULT_CLAIM_TTL_MS = Number(process.env.WORKER_CLAIM_TTL_MS) || 600_000;

function nowFn(ctx) {
  return ctx.now ? ctx.now() : nowIso();
}

async function raiseException(ctx, args) {
  const { raise } = await import('./exceptions.js');
  return raise(ctx, args);
}

async function auditStep(ctx, step, { entityId, before, after, reason, branchCode, period }) {
  const { audit, correlationId, actor } = ctx;
  await audit.emit({
    actor: actor ?? 'worker',
    actorRole: ctx.actorRole,
    action: `INGEST.${step}`,
    entityType: 'extraction_runs',
    entityId,
    before,
    after,
    reason,
    correlationId,
    branchCode,
    period,
  });
}

/** Compute a per-row validation issue list (does not throw). */
function checkRowIssues(fields, manifest) {
  const issues = [];
  if (!fields.branch_code) issues.push({ code: 'MISSING_KEY', message: 'branch_code missing' });
  else if (fields.branch_code !== manifest.branch_code) {
    issues.push({ code: 'SCHEMA_FAILURE', message: `branch_code ${fields.branch_code} != manifest branch ${manifest.branch_code}` });
  }
  if (!fields.voucher_id) issues.push({ code: 'MISSING_KEY', message: 'voucher_id missing' });
  if (!fields.voucher_type) issues.push({ code: 'MISSING_KEY', message: 'voucher_type missing' });
  else if (!VOUCHER_TYPES.has(fields.voucher_type)) {
    issues.push({ code: 'SCHEMA_FAILURE', message: `unknown voucher_type: ${fields.voucher_type}` });
  }
  if (!fields.voucher_date || !isIsoDate(fields.voucher_date)) {
    issues.push({ code: 'SCHEMA_FAILURE', message: `invalid voucher_date: ${fields.voucher_date}` });
  } else if (fields.voucher_date < manifest.from_date || fields.voucher_date > manifest.to_date) {
    issues.push({ code: 'SCHEMA_FAILURE', message: `voucher_date ${fields.voucher_date} outside manifest range` });
  }
  if (!fields.ledger_code) issues.push({ code: 'MISSING_KEY', message: 'ledger_code missing' });
  const lineNo = Number(fields.line_no);
  const unparseableLineNo = !Number.isInteger(lineNo) || lineNo < 1;
  if (unparseableLineNo) issues.push({ code: 'MISSING_KEY', message: `invalid line_no: ${fields.line_no}` });

  let debitPaise = null;
  let creditPaise = null;
  let moneyUnparseable = false;
  try { debitPaise = parseMoney(fields.debit); } catch { moneyUnparseable = true; }
  try { creditPaise = parseMoney(fields.credit); } catch { moneyUnparseable = true; }
  if (moneyUnparseable) {
    issues.push({ code: 'SCHEMA_FAILURE', message: `unparseable money: debit=${fields.debit} credit=${fields.credit}` });
  } else {
    const nonZero = (debitPaise !== 0n ? 1 : 0) + (creditPaise !== 0n ? 1 : 0);
    if (nonZero !== 1) issues.push({ code: 'SCHEMA_FAILURE', message: 'exactly one of debit/credit must be non-zero' });
  }

  // A row is "unparseable" (cannot be safely loaded) only when a structural key is
  // missing/unusable or money cannot be parsed at all. Business-invariant violations
  // (wrong branch, out-of-range date, bad voucher_type, both/neither side non-zero)
  // are still loaded per CONTRACTS.md §V.6 so the bridge stays complete.
  const unparseable = !fields.voucher_id || !fields.ledger_code || unparseableLineNo || moneyUnparseable;

  return { issues, unparseable, debitPaise, creditPaise, lineNo };
}

async function processFile(ctx, { inbox, inboxRef, fileMeta, runId, branchCode }) {
  const bytes = await inbox.readFile(inboxRef, fileMeta.file_name);
  const actualSha = sha256Bytes(bytes);
  const encoding = detectEncoding(bytes);
  const delimiter = fileMeta.delimiter || ',';
  const issues = [];

  if (fileMeta.sha256 && fileMeta.sha256 !== actualSha) {
    issues.push({ code: 'SHA_MISMATCH', message: `declared sha256 ${fileMeta.sha256} != actual ${actualSha}` });
  }
  if (fileMeta.encoding && fileMeta.encoding !== encoding) {
    issues.push({ code: 'ENCODING_MISMATCH', message: `declared encoding ${fileMeta.encoding} != detected ${encoding}` });
  }

  let header = [];
  let rows = [];
  let text = null;
  if (encoding === 'unknown') {
    issues.push({ code: 'UNKNOWN_ENCODING', message: 'unable to detect a supported encoding' });
  } else {
    try {
      text = decode(bytes, encoding);
    } catch (e) {
      issues.push({ code: 'DECODE_ERROR', message: e.message });
    }
  }

  if (text !== null) {
    try {
      ({ header, rows } = parseCsv(text, { delimiter }));
    } catch (e) {
      issues.push({ code: 'CSV_PARSE', message: e.message, line: e.line });
    }
  }

  const expectedColumns = fileMeta.file_role === 'TRANSACTIONS' ? TRANSACTIONS_COLUMNS : TRIAL_BALANCE_COLUMNS;
  let headerOk = false;
  if (header.length > 0) {
    const h = validateHeader(header, expectedColumns);
    headerOk = h.ok;
    if (!h.ok) {
      issues.push({ code: 'HEADER_MISMATCH', message: `missing=${h.missing.join(',')} extra=${h.extra.join(',')}` });
    }
  } else if (issues.length === 0) {
    issues.push({ code: 'EMPTY_FILE', message: 'no header row found' });
  }

  let actualRowCount = 0;
  let actualDebitTotal = 0n;
  let actualCreditTotal = 0n;
  const objRows = [];
  if (headerOk) {
    actualRowCount = rows.length;
    // TRANSACTIONS totals are Sigma(debit)/Sigma(credit); TRIAL_BALANCE has no plain
    // debit/credit pair, so its manifest-declared totals are cross-checked against
    // Sigma(closing_debit)/Sigma(closing_credit) (verified against DATA_CONTRACT.md's own
    // fixture: 744560.00/744560.00 == the closing-balance sums, not opening or period).
    const [debitCol, creditCol] = fileMeta.file_role === 'TRIAL_BALANCE'
      ? ['closing_debit', 'closing_credit']
      : ['debit', 'credit'];
    const debitIdx = header.indexOf(debitCol);
    const creditIdx = header.indexOf(creditCol);
    for (const cells of rows) {
      const obj = {};
      header.forEach((col, i) => { obj[col] = cells[i]; });
      objRows.push(obj);
      if (debitIdx >= 0) {
        try { actualDebitTotal += parseMoney(cells[debitIdx]); } catch { /* counted as a validation issue below */ }
      }
      if (creditIdx >= 0) {
        try { actualCreditTotal += parseMoney(cells[creditIdx]); } catch { /* ditto */ }
      }
    }

    if (Number.isInteger(fileMeta.row_count) && fileMeta.row_count !== actualRowCount) {
      issues.push({ code: 'ROW_COUNT_MISMATCH', message: `declared ${fileMeta.row_count} != actual ${actualRowCount}` });
    }
    const declaredDebit = fileMeta.debit_total !== undefined ? parseMoney(fileMeta.debit_total) : null;
    const declaredCredit = fileMeta.credit_total !== undefined ? parseMoney(fileMeta.credit_total) : null;
    if (declaredDebit !== null && declaredDebit !== actualDebitTotal) {
      issues.push({ code: 'DEBIT_TOTAL_MISMATCH', message: `declared ${fileMeta.debit_total} != actual ${formatMoney(actualDebitTotal)}` });
    }
    if (declaredCredit !== null && declaredCredit !== actualCreditTotal) {
      issues.push({ code: 'CREDIT_TOTAL_MISMATCH', message: `declared ${fileMeta.credit_total} != actual ${formatMoney(actualCreditTotal)}` });
    }
  }

  const baseStatus = issues.length === 0 ? 'VALIDATED' : 'VALIDATION_FAILED';
  const row = {
    run_id: runId,
    file_name: fileMeta.file_name,
    file_role: fileMeta.file_role,
    sha256: actualSha,
    size_bytes: bytes.length,
    encoding,
    delimiter,
    declared_row_count: Number.isInteger(fileMeta.row_count) ? fileMeta.row_count : null,
    actual_row_count: actualRowCount,
    declared_debit_total: fileMeta.debit_total ?? null,
    declared_credit_total: fileMeta.credit_total ?? null,
    actual_debit_total: formatMoney(actualDebitTotal),
    actual_credit_total: formatMoney(actualCreditTotal),
    archive_uri: null,
    status: baseStatus,
    validation_json: JSON.stringify(issues),
    created_at: nowFn(ctx),
    updated_at: nowFn(ctx),
  };

  let inserted = null;
  let duplicate = false;
  try {
    inserted = await ctx.store.insert('source_files', row);
  } catch (e) {
    if (e && e.code === 'UNIQUE_VIOLATION') {
      duplicate = true;
      issues.push({ code: 'DUPLICATE_FILE', message: `sha256 ${actualSha} already registered for another file` });
      await raiseException(ctx, {
        category: 'DUPLICATE_FILE',
        severity: 'P2',
        message: `Duplicate file content (sha256 ${actualSha}) for ${fileMeta.file_name}`,
        dedupeKey: `dupfile:${runId}:${fileMeta.file_name}:${actualSha}`,
        branchCode,
        runId,
        evidence: { file_name: fileMeta.file_name, sha256: actualSha },
      });
    } else {
      throw e;
    }
  }

  return {
    fileMeta,
    sourceFile: inserted,
    status: duplicate ? 'QUARANTINED' : baseStatus,
    ok: !duplicate && baseStatus === 'VALIDATED',
    issues,
    bytes,
    actualSha,
    objRows,
    header,
  };
}

export async function ingestRun(ctx, { inbox, archive, inboxRef, workerId }) {
  const { store } = ctx;
  const actorId = ctx.actor ?? workerId ?? 'worker';
  const effCtx = { ...ctx, actor: actorId };

  // ---- Step 1: read + validate manifest, insert extraction_runs (RECEIVED) ----
  const manifestBytes = await inbox.readFile(inboxRef, 'manifest.json');
  let manifestObj;
  try {
    manifestObj = JSON.parse(manifestBytes.toString('utf8'));
  } catch (e) {
    await auditStep(effCtx, 1, {
      entityId: null,
      after: { error: 'INVALID_JSON' },
      reason: e.message,
    });
    return { outcome: 'VALIDATION_FAILED', errors: [{ code: 'INVALID_JSON', message: e.message }] };
  }

  const validated = validateManifest(manifestObj);
  if (!validated.ok) {
    await auditStep(effCtx, 1, {
      entityId: manifestObj?.extraction_run_id ?? null,
      after: { errors: validated.errors },
      branchCode: manifestObj?.branch_code,
    });
    return { outcome: 'VALIDATION_FAILED', errors: validated.errors };
  }
  const manifest = validated.manifest;
  const manifestSha256 = sha256Bytes(manifestBytes);
  const runId = manifest.extraction_run_id;
  const now = nowFn(effCtx);

  let run;
  try {
    run = await store.insert('extraction_runs', {
      id: runId,
      branch_code: manifest.branch_code,
      query_id: manifest.query_id,
      query_version: manifest.query_version,
      from_date: manifest.from_date,
      to_date: manifest.to_date,
      manifest_json: JSON.stringify(manifest),
      manifest_sha256: manifestSha256,
      inbox_ref: inboxRef,
      archive_uri: null,
      status: RUN_STATES.RECEIVED,
      claimed_by: null,
      claimed_at: null,
      claim_expires_at: null,
      error_code: null,
      error_message: null,
      created_at: now,
      updated_at: now,
    });
  } catch (e) {
    if (e && e.code === 'UNIQUE_VIOLATION') {
      await auditStep(effCtx, 1, {
        entityId: runId,
        after: { outcome: 'DUPLICATE_MANIFEST' },
        reason: `duplicate on ${e.constraint}`,
        branchCode: manifest.branch_code,
      });
      return { outcome: 'DUPLICATE_MANIFEST' };
    }
    throw e;
  }

  await auditStep(effCtx, 1, {
    entityId: run.id,
    after: { status: run.status },
    branchCode: run.branch_code,
    period: periodOf(run.from_date),
  });

  // ---- Step 2: claim ----
  const claimTtlMs = ctx.ingestClaimTtlMs ?? DEFAULT_CLAIM_TTL_MS;
  const claimed = await store.claim('extraction_runs', run.id, {
    workerId,
    expectedStatus: RUN_STATES.RECEIVED,
    newStatus: RUN_STATES.CLAIMED,
    ttlMs: claimTtlMs,
  });
  if (!claimed) {
    await auditStep(effCtx, 2, { entityId: run.id, after: { outcome: 'CLAIM_LOST' }, branchCode: run.branch_code });
    return { outcome: 'CLAIM_LOST' };
  }
  await auditStep(effCtx, 2, { entityId: run.id, after: { status: claimed.status }, branchCode: run.branch_code });

  // ---- Step 3: validate + load each file ----
  const fileResults = [];
  for (const fileMeta of manifest.files) {
    const result = await processFile(effCtx, { inbox, inboxRef, fileMeta, runId: run.id, branchCode: run.branch_code });
    fileResults.push(result);
  }
  await auditStep(effCtx, 3, {
    entityId: run.id,
    after: { files: fileResults.map((f) => ({ file_name: f.fileMeta.file_name, status: f.status })) },
    branchCode: run.branch_code,
  });

  // ---- Step 4: any file failed -> VALIDATION_FAILED ----
  const allOk = fileResults.every((f) => f.ok);
  if (!allOk) {
    await assertTransition(RUN_TRANSITIONS, 'run', RUN_STATES.CLAIMED, RUN_STATES.VALIDATION_FAILED);
    await store.releaseClaim('extraction_runs', run.id, { workerId, newStatus: RUN_STATES.VALIDATION_FAILED });
    const errors = fileResults.flatMap((f) => f.issues.map((i) => ({ ...i, file_name: f.fileMeta.file_name })));
    await auditStep(effCtx, 4, { entityId: run.id, after: { outcome: 'VALIDATION_FAILED', errors }, branchCode: run.branch_code });
    return { outcome: 'VALIDATION_FAILED', runId: run.id, errors };
  }

  // ---- Step 5: archive manifest + files ----
  const manifestArchiveUri = await archive.put({
    runId: run.id, branchCode: run.branch_code, fileName: 'manifest.json', bytes: manifestBytes, sha256: manifestSha256,
  });
  await store.update('extraction_runs', run.id, { archive_uri: manifestArchiveUri });

  const txFileResult = fileResults.find((f) => f.fileMeta.file_role === 'TRANSACTIONS');
  const tbFileResult = fileResults.find((f) => f.fileMeta.file_role === 'TRIAL_BALANCE');

  for (const f of fileResults) {
    const fileArchiveUri = await archive.put({
      runId: run.id, branchCode: run.branch_code, fileName: f.fileMeta.file_name, bytes: f.bytes, sha256: f.actualSha,
    });
    f.archiveUri = fileArchiveUri;
    await store.update('source_files', f.sourceFile.id, { archive_uri: fileArchiveUri, status: 'ARCHIVED', updated_at: nowFn(effCtx) });
  }

  await assertTransition(RUN_TRANSITIONS, 'run', RUN_STATES.CLAIMED, RUN_STATES.ARCHIVED);
  await store.update('extraction_runs', run.id, { status: RUN_STATES.ARCHIVED, updated_at: nowFn(effCtx) });
  await auditStep(effCtx, 5, { entityId: run.id, after: { status: RUN_STATES.ARCHIVED }, branchCode: run.branch_code });

  // ---- Step 6: load rows ----
  let txnRowsLoaded = 0;
  let txnRowsSkipped = 0;
  let txnRowsUnparseable = 0;
  const tbLedgerCodes = new Set();

  for (const row of tbFileResult.objRows) {
    tbLedgerCodes.add(row.ledger_code);
    const tbUk = uk(tbFileResult.sourceFile.id, row.ledger_code);
    const tbRow = {
      run_id: run.id,
      file_id: tbFileResult.sourceFile.id,
      branch_code: row.branch_code,
      ledger_code: row.ledger_code,
      ledger_name: row.ledger_name || null,
      opening_debit: row.opening_debit,
      opening_credit: row.opening_credit,
      period_debit: row.period_debit,
      period_credit: row.period_credit,
      closing_debit: row.closing_debit,
      closing_credit: row.closing_credit,
      txn_count: Number(row.txn_count) || 0,
      uk: tbUk,
      created_at: nowFn(effCtx),
    };
    try {
      await store.insert('trial_balance_lines', tbRow);
    } catch (e) {
      if (e && e.code === 'UNIQUE_VIOLATION') {
        await raiseException(effCtx, {
          category: 'SCHEMA_FAILURE', severity: 'P1',
          message: `Duplicate ledger_code ${row.ledger_code} in trial_balance.csv`,
          dedupeKey: `tb_dup:${run.id}:${row.ledger_code}`,
          branchCode: run.branch_code, runId: run.id,
        });
      } else {
        throw e;
      }
    }
  }

  const voucherLines = new Map(); // voucher_id -> [line]
  for (const fields of txFileResult.objRows) {
    const { issues, unparseable, debitPaise, creditPaise, lineNo } = checkRowIssues(fields, manifest);

    if (unparseable) {
      txnRowsUnparseable += 1;
      await raiseException(effCtx, {
        category: issues.some((i) => i.code === 'MISSING_KEY') ? 'MISSING_KEY' : 'SCHEMA_FAILURE',
        severity: 'P1',
        message: `Unparseable transaction row: voucher_id=${fields.voucher_id ?? ''} line_no=${fields.line_no ?? ''} (${issues.map((i) => i.message).join('; ')})`,
        dedupeKey: `row_unparseable:${run.id}:${fields.voucher_id ?? 'unknown'}:${fields.line_no ?? 'unknown'}`,
        branchCode: run.branch_code, runId: run.id,
        evidence: { fields },
      });
      continue;
    }

    for (const issue of issues) {
      await raiseException(effCtx, {
        category: issue.code === 'MISSING_KEY' ? 'MISSING_KEY' : 'SCHEMA_FAILURE',
        severity: 'P1',
        message: `${issue.message} (voucher_id=${fields.voucher_id}, line_no=${fields.line_no})`,
        dedupeKey: `row_issue:${run.id}:${fields.voucher_id}:${fields.line_no}:${issue.code}`,
        branchCode: run.branch_code, runId: run.id,
      });
    }

    const lineUk = uk(txFileResult.sourceFile.id, fields.voucher_id, lineNo);
    const lineRow = {
      run_id: run.id,
      file_id: txFileResult.sourceFile.id,
      row_number: txnRowsLoaded + txnRowsSkipped + 1,
      branch_code: fields.branch_code,
      voucher_id: fields.voucher_id,
      voucher_no: fields.voucher_no || null,
      voucher_type: fields.voucher_type,
      voucher_date: fields.voucher_date,
      line_no: lineNo,
      ledger_code: fields.ledger_code,
      ledger_name: fields.ledger_name || null,
      debit: formatMoney(debitPaise),
      credit: formatMoney(creditPaise),
      party_code: fields.party_code || null,
      party_name: fields.party_name || null,
      payment_method: fields.payment_method || null,
      tax_bucket: fields.tax_bucket || null,
      narration: fields.narration || null,
      reference_no: fields.reference_no || null,
      source_created_at: fields.created_at || null,
      source_modified_at: fields.modified_at || null,
      row_hash: rowHash(fields),
      uk: lineUk,
      created_at: nowFn(effCtx),
    };

    try {
      await store.insert('source_txn_lines', lineRow);
      txnRowsLoaded += 1;
      if (!voucherLines.has(fields.voucher_id)) voucherLines.set(fields.voucher_id, []);
      voucherLines.get(fields.voucher_id).push({ ...fields, debit: lineRow.debit, credit: lineRow.credit, line_no: lineNo });
    } catch (e) {
      if (e && e.code === 'UNIQUE_VIOLATION') {
        txnRowsSkipped += 1;
        await raiseException(effCtx, {
          category: 'DUPLICATE_SOURCE', severity: 'P1',
          message: `Duplicate source row (voucher_id=${fields.voucher_id}, line_no=${lineNo})`,
          dedupeKey: `dup_source:${run.id}:${fields.voucher_id}:${lineNo}`,
          branchCode: run.branch_code, runId: run.id,
          // The rejected row is still part of the delivered CSV population; Layer B
          // bridges file totals to vouchers + these rejected rows so nothing vanishes.
          evidence: { rejected_row: true, row_number: lineRow.row_number, debit: lineRow.debit, credit: lineRow.credit },
        });
      } else {
        throw e;
      }
    }
  }

  await auditStep(effCtx, 6, {
    entityId: run.id,
    after: { txnRowsLoaded, txnRowsSkipped, txnRowsUnparseable, tbRowsLoaded: tbFileResult.objRows.length },
    branchCode: run.branch_code,
  });

  // ---- Step 7: build vouchers ----
  const branchRow = await store.findOne('branches', { branch_code: manifest.branch_code });
  const zohoLocationId = branchRow?.zoho_location_id ?? null;

  let vouchersBuilt = 0;
  let vouchersBlocked = 0;
  let vouchersSkippedDuplicate = 0;

  for (const [voucherId, lines] of voucherLines.entries()) {
    const first = lines[0];
    let sumDebit = 0n;
    let sumCredit = 0n;
    for (const l of lines) {
      sumDebit += parseMoney(l.debit);
      sumCredit += parseMoney(l.credit);
    }
    const isBalanced = sumDebit === sumCredit;
    const missingLedger = lines.find((l) => !tbLedgerCodes.has(l.ledger_code));

    let disposition = 'PENDING';
    let dispositionReason = null;

    if (!isBalanced) {
      disposition = 'BLOCKED';
      dispositionReason = 'UNBALANCED_VOUCHER';
    } else if (missingLedger) {
      disposition = 'BLOCKED';
      dispositionReason = 'ORPHAN_RELATIONSHIP';
    }

    const voucherRow = {
      source_system: 'ECO_GREEN',
      source_query_id: manifest.query_id,
      source_query_version: manifest.query_version,
      extraction_run_id: run.id,
      source_file_id: txFileResult.sourceFile.id,
      source_file_hash: txFileResult.actualSha,
      source_table_or_entity: 'vouchers',
      source_record_id: voucherId,
      source_document_no: first.voucher_no || null,
      branch_code: first.branch_code,
      zoho_location_id: zohoLocationId,
      financial_year: isIsoDate(first.voucher_date) ? financialYearOf(first.voucher_date) : null,
      period: isIsoDate(first.voucher_date) ? periodOf(first.voucher_date) : null,
      transaction_date: first.voucher_date,
      source_transaction_type: first.voucher_type,
      source_transaction_hash: sourceTransactionHash({
        branch_code: first.branch_code,
        voucher_type: first.voucher_type,
        voucher_id: voucherId,
        voucher_no: first.voucher_no,
        voucher_date: first.voucher_date,
        lines: lines.map((l) => ({ line_no: l.line_no, ledger_code: l.ledger_code, debit: l.debit, credit: l.credit })),
      }),
      debit_total: formatMoney(sumDebit),
      credit_total: formatMoney(sumCredit),
      line_count: lines.length,
      payment_method: first.payment_method || null,
      tax_bucket: first.tax_bucket || null,
      party_code: first.party_code || null,
      is_balanced: isBalanced ? 1 : 0,
      disposition,
      disposition_rule_version: null,
      disposition_reason: dispositionReason,
      disposition_evidence_json: null,
      disposition_by: dispositionReason ? actorId : null,
      disposition_at: dispositionReason ? nowFn(effCtx) : null,
      mapping_version: null,
      transformation_version: null,
      target_module: null,
      target_payload_hash: null,
      migration_batch_id: null,
      approval_id: null,
      zoho_record_id: null,
      last_error_code: null,
      last_error_message: null,
      created_at: nowFn(effCtx),
      updated_at: nowFn(effCtx),
    };

    let inserted;
    try {
      inserted = await store.insert('vouchers', voucherRow);
    } catch (e) {
      if (e && e.code === 'UNIQUE_VIOLATION') {
        vouchersSkippedDuplicate += 1;
        await raiseException(effCtx, {
          category: 'DUPLICATE_SOURCE', severity: 'P1',
          message: `Voucher ${voucherId} already ingested (same source_transaction_hash)`,
          dedupeKey: `dup_voucher:${voucherRow.source_transaction_hash}`,
          branchCode: first.branch_code, runId: run.id,
        });
        continue;
      }
      throw e;
    }

    vouchersBuilt += 1;
    if (disposition === 'BLOCKED') {
      vouchersBlocked += 1;
      await raiseException(effCtx, {
        category: dispositionReason,
        severity: 'P1',
        message: `Voucher ${voucherId} blocked at ingest: ${dispositionReason}`,
        dedupeKey: `ingest_block:${inserted.id}:${dispositionReason}`,
        branchCode: first.branch_code, period: voucherRow.period, runId: run.id, voucherId: inserted.id,
      });
    }
  }

  await auditStep(effCtx, 7, {
    entityId: run.id,
    after: { vouchersBuilt, vouchersBlocked, vouchersSkippedDuplicate },
    branchCode: run.branch_code,
  });

  // ---- Step 8: stage or exception ----
  const counts = {
    files: fileResults.map((f) => ({ file_name: f.fileMeta.file_name, file_role: f.fileMeta.file_role, status: f.status })),
    txnRowsLoaded, txnRowsSkipped, txnRowsUnparseable,
    tbRowsLoaded: tbFileResult.objRows.length,
    vouchersBuilt, vouchersBlocked, vouchersSkippedDuplicate,
  };

  if (txnRowsUnparseable > 0) {
    await assertTransition(RUN_TRANSITIONS, 'run', RUN_STATES.ARCHIVED, RUN_STATES.EXCEPTION);
    await store.releaseClaim('extraction_runs', run.id, { workerId, newStatus: RUN_STATES.EXCEPTION });
    await auditStep(effCtx, 8, { entityId: run.id, after: { outcome: 'EXCEPTION', counts }, branchCode: run.branch_code });
    return { outcome: 'EXCEPTION', runId: run.id, counts };
  }

  await assertTransition(RUN_TRANSITIONS, 'run', RUN_STATES.ARCHIVED, RUN_STATES.STAGED);
  await store.releaseClaim('extraction_runs', run.id, { workerId, newStatus: RUN_STATES.STAGED });
  await auditStep(effCtx, 8, { entityId: run.id, after: { outcome: 'STAGED', counts }, branchCode: run.branch_code });

  return { outcome: 'STAGED', runId: run.id, counts };
}
