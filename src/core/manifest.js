// manifest.json validation and the exact CSV header shapes from DATA_CONTRACT.md §3/§4.
import { isIsoDate } from './ids.js';
import { parseMoney } from './money.js';

export const TRANSACTIONS_COLUMNS = [
  'branch_code', 'voucher_id', 'voucher_no', 'voucher_type', 'voucher_date', 'line_no',
  'ledger_code', 'ledger_name', 'debit', 'credit', 'party_code', 'party_name',
  'payment_method', 'tax_bucket', 'narration', 'reference_no', 'created_at', 'modified_at',
];

export const TRIAL_BALANCE_COLUMNS = [
  'branch_code', 'ledger_code', 'ledger_name', 'opening_debit', 'opening_credit',
  'period_debit', 'period_credit', 'closing_debit', 'closing_credit', 'txn_count',
];

/**
 * Compare a parsed CSV header against an expected column list, order-insensitive,
 * exact-name matching. -> { ok, missing, extra }
 */
export function validateHeader(header, expected) {
  const headerList = Array.isArray(header) ? header : [];
  const expectedList = Array.isArray(expected) ? expected : [];
  const headerSet = new Set(headerList);
  const expectedSet = new Set(expectedList);
  const missing = expectedList.filter((c) => !headerSet.has(c));
  const extra = headerList.filter((c) => !expectedSet.has(c));
  return { ok: missing.length === 0 && extra.length === 0, missing, extra };
}

const REQUIRED_TOP_FIELDS = [
  'contract_version', 'extraction_run_id', 'source_system', 'query_id', 'query_name',
  'query_version', 'sql_hash', 'branch_code', 'from_date', 'to_date', 'currency',
  'extracted_at', 'source_operator_or_job', 'files',
];

const REQUIRED_FILE_FIELDS = [
  'file_name', 'file_role', 'sha256', 'row_count', 'debit_total', 'credit_total', 'encoding', 'delimiter',
];

const VALID_FILE_ROLES = ['TRANSACTIONS', 'TRIAL_BALANCE'];

function isBlank(v) {
  return v === undefined || v === null || v === '';
}

/**
 * Validate a parsed manifest.json object against DATA_CONTRACT.md §2 / CONTRACTS.md §C.
 * Never throws — returns a structured result:
 *   { ok: true, manifest } | { ok: false, errors: [{code, path, message}] }
 */
export function validateManifest(obj) {
  const errors = [];

  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, errors: [{ code: 'INVALID_MANIFEST', path: '', message: 'manifest must be a JSON object' }] };
  }

  for (const field of REQUIRED_TOP_FIELDS) {
    if (isBlank(obj[field])) {
      errors.push({ code: 'MISSING_FIELD', path: field, message: `${field} is required` });
    }
  }

  if (!isBlank(obj.contract_version) && obj.contract_version !== '1.0') {
    errors.push({
      code: 'UNSUPPORTED_CONTRACT_VERSION',
      path: 'contract_version',
      message: `unsupported contract_version: ${obj.contract_version}`,
    });
  }

  const fromOk = typeof obj.from_date === 'string' && isIsoDate(obj.from_date);
  const toOk = typeof obj.to_date === 'string' && isIsoDate(obj.to_date);
  if (!isBlank(obj.from_date) && !fromOk) {
    errors.push({ code: 'INVALID_DATE', path: 'from_date', message: `from_date is not a valid ISO date: ${obj.from_date}` });
  }
  if (!isBlank(obj.to_date) && !toOk) {
    errors.push({ code: 'INVALID_DATE', path: 'to_date', message: `to_date is not a valid ISO date: ${obj.to_date}` });
  }
  if (fromOk && toOk && obj.from_date > obj.to_date) {
    errors.push({
      code: 'DATE_RANGE_INVALID',
      path: 'from_date',
      message: `from_date (${obj.from_date}) is after to_date (${obj.to_date})`,
    });
  }

  if (!isBlank(obj.extracted_at)) {
    const d = new Date(obj.extracted_at);
    if (typeof obj.extracted_at !== 'string' || Number.isNaN(d.getTime())) {
      errors.push({ code: 'INVALID_DATETIME', path: 'extracted_at', message: `extracted_at is not a valid datetime: ${obj.extracted_at}` });
    }
  }

  if (!isBlank(obj.files)) {
    if (!Array.isArray(obj.files) || obj.files.length === 0) {
      errors.push({ code: 'EMPTY_FILES', path: 'files', message: 'files must be a non-empty array' });
    } else {
      const roleCounts = {};
      obj.files.forEach((file, idx) => {
        const path = `files[${idx}]`;
        if (file === null || typeof file !== 'object' || Array.isArray(file)) {
          errors.push({ code: 'INVALID_FILE', path, message: 'file entry must be an object' });
          return;
        }
        for (const field of REQUIRED_FILE_FIELDS) {
          if (isBlank(file[field])) {
            errors.push({ code: 'MISSING_FIELD', path: `${path}.${field}`, message: `${field} is required` });
          }
        }
        if (!isBlank(file.file_role)) {
          if (!VALID_FILE_ROLES.includes(file.file_role)) {
            errors.push({ code: 'INVALID_FILE_ROLE', path: `${path}.file_role`, message: `unknown file_role: ${file.file_role}` });
          } else {
            roleCounts[file.file_role] = (roleCounts[file.file_role] ?? 0) + 1;
          }
        }
        if (!isBlank(file.row_count) && (!Number.isInteger(file.row_count) || file.row_count < 0)) {
          errors.push({ code: 'INVALID_ROW_COUNT', path: `${path}.row_count`, message: 'row_count must be a non-negative integer' });
        }
        for (const moneyField of ['debit_total', 'credit_total']) {
          if (isBlank(file[moneyField])) continue;
          try {
            parseMoney(file[moneyField]);
          } catch {
            errors.push({
              code: 'INVALID_MONEY',
              path: `${path}.${moneyField}`,
              message: `${moneyField} is not a valid money value: ${file[moneyField]}`,
            });
          }
        }
      });

      for (const role of VALID_FILE_ROLES) {
        const count = roleCounts[role] ?? 0;
        if (count === 0) {
          errors.push({ code: 'MISSING_FILE_ROLE', path: 'files', message: `no file with file_role ${role}` });
        } else if (count > 1) {
          errors.push({ code: 'DUPLICATE_FILE_ROLE', path: 'files', message: `expected exactly one file with file_role ${role}, found ${count}` });
        }
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, manifest: obj };
}
