// In-memory Zoho Books mock driver (offline, deterministic — no network).
//
// Written fresh for this adapter. The Tally tool's mock driver (zoho.js#mockPush/#mockFetch) was
// a two-method stub backed by a DB table (`zoho_mock_records`) with no fault injection, no
// locations/accounts, and no trial-balance computation; nothing from it was reused beyond the
// general idea "a mock driver exists so tests never touch the network".
//
// Even though this is the offline driver, `create()` still goes through a write guard
// (`config.mockWritesEnabled === true`, defaulting to true unless a caller explicitly opts out)
// so tests can prove the guard mechanism works end-to-end without needing a live organisation.
//
// Trial balance / double-entry note: every record stored here (via `create()` or `seedRecords()`)
// carries a `effects` array — the real double-entry GL effect of that posting, derived by
// src/books/gl_effects.js#glEffects from the same Books-shaped payload that would be sent to a
// live organisation. `getTrialBalance()` aggregates over these effects (not over raw
// `line_items`), so the mock world is a real, provable general ledger: nothing can appear in the
// trial balance that isn't the double-entry effect of an actual stored record, and the balance
// bridge (src/core/balance_bridge.js) can derive migration/SP/manual movement the same way
// instead of guessing from an ad-hoc heuristic.

import { parseMoney, formatMoney, add, sub, ZERO } from '../core/money.js';
import { PostingDisabledError } from './guard.js';
import { classifyResponse } from './classify.js';
import { glEffects, GlEffectsError } from './gl_effects.js';

const DEFAULT_LOCATION = Object.freeze({ location_id: 'loc_head_office', name: 'Head Office', is_default_location: true });

const DEFAULT_ACCOUNTS = Object.freeze([
  { account_id: 'acct_cash', account_name: 'Cash', account_type: 'cash' },
  { account_id: 'acct_bank', account_name: 'Bank', account_type: 'bank' },
  { account_id: 'acct_sales', account_name: 'Sales', account_type: 'income' },
  { account_id: 'acct_ap', account_name: 'Accounts Payable', account_type: 'accounts_payable' },
  { account_id: 'acct_ar', account_name: 'Accounts Receivable', account_type: 'accounts_receivable' },
]);

/** Best-effort GL effects for a record's payload: malformed/synthetic test payloads
 * (missing accounts, empty line_items, etc.) must never crash `create()`/`seedRecords()`
 * — they simply contribute no measurable trial-balance movement. A genuine
 * GL_EFFECTS_UNBALANCED from a real, fully-formed payload is a real data-integrity bug
 * and is allowed to propagate. */
function safeGlEffects(module, payload) {
  try {
    return glEffects(module, payload ?? {});
  } catch (err) {
    if (err instanceof GlEffectsError && err.code === 'GL_EFFECTS_UNKNOWN_MODULE') return [];
    throw err;
  }
}

/**
 * @param {object} [config]
 * @param {boolean} [config.mockWritesEnabled] - defaults to true; set explicitly to `false` to
 *   prove `create()` honours the guard even for the offline driver.
 */
export function createMockClient(config = {}) {
  const cfg = { mockWritesEnabled: true, ...config };

  const locations = [{ ...DEFAULT_LOCATION }];
  const accounts = [...DEFAULT_ACCOUNTS];
  const contacts = [];
  /** @type {Array<{id:string, module:string, location_id:string, date:string, effects:Array,
   *  custom_fields:object, sp_batch_ref:?string, created_by:string, created_at:string}>} */
  const records = [];
  const faultQueue = [];
  let counter = 0;

  function nextFault() {
    if (!faultQueue.length) return null;
    const fault = faultQueue[0];
    fault.remaining -= 1;
    if (fault.remaining <= 0) faultQueue.shift();
    return fault;
  }

  function accountName(accountId) {
    return accounts.find((a) => a.account_id === accountId)?.account_name ?? accountId;
  }

  function tagsFor(rec) {
    const migrationSourceHash = rec.custom_fields?.cf_migration_source_hash ?? null;
    const spBatchRef = rec.sp_batch_ref ?? null;
    return {
      migration_source_hash: migrationSourceHash,
      sp_batch_ref: spBatchRef,
      manual: !migrationSourceHash && !spBatchRef,
      created_by: rec.created_by,
    };
  }

  return {
    /**
     * Injects a fault for the next `times` call(s) to `create()`.
     * `{ status }` synthesises the HTTP-status classification (e.g. 429, 500, 401, 400).
     * `{ timeoutAfterSend: true }` synthesises an UNKNOWN outcome (abort after dispatch).
     */
    failNext({ status, timeoutAfterSend = false, retryAfterHeader = null, times = 1 } = {}) {
      faultQueue.push({ status, timeoutAfterSend, retryAfterHeader, remaining: times });
    },

    /** Seeds pre-existing records: SP-tagged via `sp_batch_ref`, migration-tagged via
     * `custom_fields.cf_migration_source_hash`, manual/untagged otherwise. `effects`
     * (`[{account_id, debit, credit}]`, money strings) is the double-entry movement this
     * seeded record contributes to the trial balance; a seeded record with no `effects`
     * contributes nothing (it exists only for tag/window-listing purposes). */
    seedRecords(seedList = []) {
      for (const r of seedList) {
        const isSp = Boolean(r.sp_batch_ref);
        const isMigration = Boolean(r.custom_fields?.cf_migration_source_hash);
        records.push({
          id: r.id ?? `mock_${r.module}_${++counter}`,
          module: r.module,
          location_id: r.location_id ?? locations[0].location_id,
          date: r.date ?? null,
          effects: Array.isArray(r.effects) ? r.effects.map((e) => ({ account_id: e.account_id, debit: e.debit ?? '0.00', credit: e.credit ?? '0.00' })) : [],
          custom_fields: r.custom_fields ?? {},
          sp_batch_ref: r.sp_batch_ref ?? null,
          created_by: isSp ? 'smart_pharma' : isMigration ? 'migration' : 'manual',
          created_at: r.created_at ?? new Date().toISOString(),
        });
      }
    },

    async getOrganization() {
      return { organization_id: cfg.organizationId ?? 'mock_org', name: 'Mock Organisation' };
    },

    async getLocations() {
      return locations.map((l) => ({ ...l }));
    },

    /** Aggregates the double-entry `effects` of every stored record (posted via
     * `create()` or seeded via `seedRecords()` with an `effects` array) into an
     * account-level trial balance. Returns a plain array (not wrapped), one row per
     * account touched: `{account_id, account_name, debit, credit, balance}` where
     * `balance` = debit - credit (money strings, BigInt-paise arithmetic throughout). */
    async getTrialBalance({ locationId, fromDate, toDate } = {}) {
      const totals = new Map(); // account_id -> { debit: BigInt, credit: BigInt }
      for (const rec of records) {
        if (locationId && rec.location_id !== locationId) continue;
        if (fromDate && rec.date && rec.date < fromDate) continue;
        if (toDate && rec.date && rec.date > toDate) continue;
        for (const e of rec.effects ?? []) {
          const cur = totals.get(e.account_id) ?? { debit: ZERO, credit: ZERO };
          cur.debit = add(cur.debit, parseMoney(e.debit ?? '0.00'));
          cur.credit = add(cur.credit, parseMoney(e.credit ?? '0.00'));
          totals.set(e.account_id, cur);
        }
      }
      return [...totals.entries()].map(([accountId, v]) => ({
        account_id: accountId,
        account_name: accountName(accountId),
        debit: formatMoney(v.debit),
        credit: formatMoney(v.credit),
        balance: formatMoney(sub(v.debit, v.credit)),
      }));
    },

    async searchByMigrationTag({ module, sourceHash } = {}) {
      return records
        .filter((r) => r.module === module && r.custom_fields?.cf_migration_source_hash === sourceHash)
        .map((r) => ({ id: r.id, module: r.module, custom_fields: r.custom_fields }));
    },

    /** Returns records in the window with their `effects` and classification `tags`:
     * `{migration_source_hash, sp_batch_ref, manual, created_by}` — `manual` is true only
     * when neither a migration tag nor an SP batch ref is present. */
    async listRecordsInWindow({ locationId, module, fromDate, toDate } = {}) {
      return records
        .filter(
          (r) =>
            r.module === module &&
            (!locationId || r.location_id === locationId) &&
            (!fromDate || !r.date || r.date >= fromDate) &&
            (!toDate || !r.date || r.date <= toDate),
        )
        .map((r) => ({
          id: r.id,
          module: r.module,
          effects: (r.effects ?? []).map((e) => ({ ...e })),
          tags: tagsFor(r),
        }));
    },

    async create(module, payload, { idempotencyKey } = {}) {
      if (cfg.mockWritesEnabled !== true) {
        throw new PostingDisabledError('mock driver writes are disabled (config.mockWritesEnabled !== true)');
      }

      const fault = nextFault();
      if (fault) {
        if (fault.timeoutAfterSend) {
          const err = new Error('mock: simulated timeout after send');
          err.classification = { class: 'UNKNOWN', reason: 'mock_timeout_after_send' };
          throw err;
        }
        if (fault.status) {
          const classification = classifyResponse({ status: fault.status, retryAfterHeader: fault.retryAfterHeader });
          const err = new Error(`mock: simulated http ${fault.status}`);
          err.classification = classification;
          err.httpStatus = fault.status;
          throw err;
        }
      }

      const id = `mock_${module}_${++counter}`;
      const record = {
        id,
        module,
        location_id: payload.location_id ?? locations[0].location_id,
        date: payload.date ?? new Date().toISOString().slice(0, 10),
        effects: safeGlEffects(module, payload),
        custom_fields: payload.custom_fields ?? {},
        sp_batch_ref: null,
        created_by: 'migration',
        created_at: new Date().toISOString(),
        idempotency_key: idempotencyKey ?? null,
      };
      records.push(record);
      return { id, module, custom_fields: record.custom_fields };
    },

    // Test/ops seam only — not part of the §Z contract surface.
    _records: () => records.map((r) => ({ ...r })),
  };
}
