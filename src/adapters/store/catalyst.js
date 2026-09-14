// Catalyst Data Store adapter. See CONTRACTS.md §S, docs/CATALYST_REFERENCES.md, and the
// SDK typings under datastore/table.d.ts + zcql/zcql.d.ts (zcatalyst-sdk-node 3.4.0).
//
// This module never imports `zcatalyst-sdk-node` — it is only present at runtime inside
// Catalyst. Instead it takes an injected `app` (a real Catalyst app: `.datastore()` +
// `.zcql()`) or `transport` (any object with the same two methods — this is exactly the
// shape catalyst_fake.js's `{ app }` exposes, so tests inject the fake as either option).
// With neither, opening the store throws NOT_IMPLEMENTED (there is no live Catalyst
// connection available outside a Catalyst runtime in this pilot).
//
// Structural differences from sqlite.js this adapter has to work around:
//   - No composite UNIQUE index -> every table with one relies on schema.sql's synthetic
//     `uk` column (see schema.catalyst.js's TYPE MAPPING header) enforced as a normal
//     single-column is_unique.
//   - No `UPDATE ... RETURNING`, so `claim()`/`releaseClaim()` are read-then-conditional-
//     write, NOT atomic. `store.claimSemantics === 'BEST_EFFORT'` documents this; the
//     worker MUST NOT run multiple instances against this adapter (a true CAS primitive
//     would need a Catalyst Function acting as a stored procedure, out of scope here).
//   - No bound-parameter ZCQL API (`executeZCQLQuery` takes one SQL string) -> `raw()`
//     substitutes `?` placeholders with escaped literals itself instead of using a driver
//     parameter binding.
//   - ZCQL caps SELECT at 300 rows -> `find()` loops LIMIT/OFFSET in pages of 300 when the
//     caller didn't ask for a smaller limit.
//   - ZCQL caps SELECT at 30 selected columns (see ZCQL_MAX_SELECT_COLUMNS below) ->
//     a page's column list is split into <=30-column chunks (ROWID added to every
//     chunk), one ZCQL query per chunk with the IDENTICAL WHERE/ORDER BY/LIMIT/OFFSET,
//     then merged back into whole rows by ROWID. Composes with the 300-row pagination
//     above: chunking happens PER PAGE, not across pages.
//   - Unique-violation and not-found detection are best-effort message/code sniffing
//     (see catalyst_types.js's `looksLikeUniqueViolation`/`looksLikeNotFound`) since this
//     pilot has no live OAuth credential to observe the real Catalyst error payloads
//     against (see docs/CATALYST_REFERENCES.md "Not verified / open").
//   - `audit_events` is append-only: `update()`/`claim()` throw AppendOnlyViolationError
//     for it (the Store interface has no delete, so those are the only mutating paths).
import { nowIso } from '../../core/ids.js';
import {
  toPhysicalTable,
  tableDef,
  assertTableAllowed,
  assertColumnsAllowed,
  logicalKeyOf,
  zcqlLiteral,
  escapeZcqlString,
  normaliseRow,
  looksLikeUniqueViolation,
  looksLikeNotFound,
  extractUniqueColumn,
  UniqueViolationError,
  AppendOnlyViolationError,
  RawSqlNotReadOnlyError,
  TableNotAllowedError,
  ColumnNotAllowedError,
  ZCQL_MAX_SELECT_COLUMNS,
  ZcqlChunkMismatchError,
} from './catalyst_types.js';

export class NotImplementedError extends Error {
  constructor(message) {
    super(message);
    this.code = 'NOT_IMPLEMENTED';
  }
}

const ZCQL_PAGE_SIZE = 300;

function assertNotAppendOnly(table) {
  if (table === 'audit_events') throw new AppendOnlyViolationError(table);
}

export async function openStore({ app, transport } = {}) {
  const source = app ?? transport;
  if (!source) {
    throw new NotImplementedError(
      'Catalyst Data Store adapter needs an injected `app` (a Catalyst app) or `transport` ' +
        '(anything exposing the same .datastore()/.zcql() surface — e.g. catalyst_fake.js\'s ' +
        '{ app }). Neither was provided, and there is no live Catalyst connection available ' +
        'outside a Catalyst runtime in this pilot. See src/adapters/store/catalyst.js.'
    );
  }

  // Observability for the column-chunking path (see fetchPageRows): incremented once per
  // extra ZCQL SELECT issued because a page's column list exceeded ZCQL_MAX_SELECT_COLUMNS.
  // Exposed via store.stats() so a caller/test can prove the chunking path actually ran
  // rather than being silently bypassed (see test/pipeline_catalyst_fake.test.js).
  const stats = { chunkedQueries: 0 };

  function getTable(logicalTable) {
    return source.datastore().table(toPhysicalTable(logicalTable));
  }
  function runZcql(sql) {
    return source.zcql().executeZCQLQuery(sql);
  }

  /** Run a ZCQL SELECT and return the raw per-table-name-unwrapped physical rows. */
  async function zcqlRows(logicalTable, sql) {
    const physical = toPhysicalTable(logicalTable);
    const result = await runZcql(sql);
    return (result ?? []).map((r) => r[physical]);
  }

  // `tieBreakRowid`: only set true for a chunked column-split query (see
  // chunkColumnsForSelect/fetchPageRows below). Appending ROWID as the FINAL ORDER BY
  // term guarantees every chunk of the same logical page comes back in the same order
  // for the same LIMIT/OFFSET window, which the merge step depends on: without a stable,
  // unique tie-break, two chunk queries issued moments apart could legitimately return
  // the same row set in different relative orders (ZCQL makes no ordering guarantee
  // beyond what ORDER BY specifies), and a naive positional zip would splice columns
  // from two DIFFERENT logical rows together. Single-chunk queries never set this, so
  // their SQL shape is byte-for-byte unchanged from before chunking existed.
  function buildSelectSql(logicalTable, where, { orderBy, limit, offset, columns, tieBreakRowid = false } = {}) {
    const physical = toPhysicalTable(logicalTable);
    const def = tableDef(logicalTable);
    const colNames = columns ?? [...def.columns.map((c) => c.column_name), 'ROWID'];
    let sql = `SELECT ${colNames.join(', ')} FROM ${physical}`;

    const whereKeys = Object.keys(where ?? {});
    if (whereKeys.length) {
      assertColumnsAllowed(logicalTable, whereKeys);
      const clauses = whereKeys.map((k) => {
        const v = where[k];
        return v === null ? `${k} IS NULL` : `${k} = ${zcqlLiteral(logicalTable, k, v)}`;
      });
      sql += ` WHERE ${clauses.join(' AND ')}`;
    }

    const orderTerms = [];
    if (orderBy) {
      const [col, dirRaw] = String(orderBy).trim().split(/\s+/);
      assertColumnsAllowed(logicalTable, [col]);
      const dir = /^desc$/i.test(dirRaw ?? '') ? 'DESC' : 'ASC';
      orderTerms.push(`${col} ${dir}`);
    }
    if (tieBreakRowid) orderTerms.push('ROWID');
    if (orderTerms.length) sql += ` ORDER BY ${orderTerms.join(', ')}`;

    if (Number.isInteger(limit)) sql += ` LIMIT ${limit}`;
    if (Number.isInteger(offset)) sql += ` OFFSET ${offset}`;
    return sql;
  }

  // Split a SELECT's column list into <=ZCQL_MAX_SELECT_COLUMNS chunks (see that
  // constant's doc comment in catalyst_types.js for the live-observed error this works
  // around). Below the cap this returns the ONE original list untouched — callers must
  // get byte-for-byte the same SQL as before chunking existed. At/above the cap, the
  // non-ROWID columns are split into groups of ZCQL_MAX_SELECT_COLUMNS - 1, with ROWID
  // appended to EVERY chunk (never itself split off) so the split rows can be re-joined.
  function chunkColumnsForSelect(colNames) {
    const dataCols = colNames.filter((c) => c !== 'ROWID');
    if (dataCols.length + 1 <= ZCQL_MAX_SELECT_COLUMNS) return [colNames];
    const perChunk = ZCQL_MAX_SELECT_COLUMNS - 1;
    const chunks = [];
    for (let i = 0; i < dataCols.length; i += perChunk) {
      chunks.push([...dataCols.slice(i, i + perChunk), 'ROWID']);
    }
    return chunks;
  }

  // Merge N chunks' worth of rows (same logical page, disjoint column sets, all carrying
  // ROWID) back into whole row objects. Every ROWID must appear in EVERY chunk exactly
  // once, or this throws ZcqlChunkMismatchError rather than returning a row assembled
  // from columns that don't actually belong to the same underlying record — see that
  // error class's doc comment for why a half-merged row is unacceptable here.
  function mergeChunkedRows(logicalTable, perChunkRows, chunkCount) {
    const merged = new Map(); // ROWID string -> { row, seenIn }
    const order = [];
    for (const row of perChunkRows[0]) {
      const id = String(row.ROWID);
      merged.set(id, { row: { ...row }, seenIn: 1 });
      order.push(id);
    }
    for (let i = 1; i < perChunkRows.length; i++) {
      for (const row of perChunkRows[i]) {
        const id = String(row.ROWID);
        const entry = merged.get(id);
        if (!entry) {
          throw new ZcqlChunkMismatchError(
            logicalTable,
            `chunk ${i} returned ROWID ${id}, which chunk 0 of the same page did not`
          );
        }
        Object.assign(entry.row, row);
        entry.seenIn += 1;
      }
    }
    for (const [id, entry] of merged) {
      if (entry.seenIn !== chunkCount) {
        throw new ZcqlChunkMismatchError(
          logicalTable,
          `ROWID ${id} was returned by only ${entry.seenIn}/${chunkCount} column chunks of the same page`
        );
      }
    }
    return order.map((id) => merged.get(id).row);
  }

  // Fetch exactly one LIMIT/OFFSET page (<=300 rows, enforced by the caller in
  // selectAll), chunking the column list first if needed. `chunks` is precomputed once
  // per selectAll() call (the column list never changes across pages of the SAME find()
  // call) and reused for every page, so chunking composes with pagination per-page
  // rather than across pages: each page independently issues its own chunk queries with
  // that page's LIMIT/OFFSET, never a chunk query spanning two pages.
  async function fetchPageRows(logicalTable, where, { orderBy, limit, offset, chunks }) {
    if (chunks.length === 1) {
      const sql = buildSelectSql(logicalTable, where, { orderBy, limit, offset, columns: chunks[0] });
      return zcqlRows(logicalTable, sql);
    }
    const perChunkRows = [];
    for (const chunkCols of chunks) {
      const sql = buildSelectSql(logicalTable, where, { orderBy, limit, offset, columns: chunkCols, tieBreakRowid: true });
      perChunkRows.push(await zcqlRows(logicalTable, sql));
      stats.chunkedQueries += 1;
    }
    return mergeChunkedRows(logicalTable, perChunkRows, chunks.length);
  }

  /** ZCQL SELECT with automatic LIMIT/OFFSET pagination past the 300-row cap, composed
   *  with column chunking past the 30-column cap (see fetchPageRows). */
  async function selectAll(logicalTable, where, { orderBy, limit, offset, columns } = {}) {
    const wantAll = limit === undefined;
    let currentOffset = offset ?? 0;
    const collected = [];
    const baseColumns = columns ?? [...tableDef(logicalTable).columns.map((c) => c.column_name), 'ROWID'];
    const chunks = chunkColumnsForSelect(baseColumns);
    for (;;) {
      const remaining = wantAll ? ZCQL_PAGE_SIZE : Math.min(ZCQL_PAGE_SIZE, limit - collected.length);
      if (!wantAll && remaining <= 0) break;
      const rows = await fetchPageRows(logicalTable, where, { orderBy, limit: remaining, offset: currentOffset, chunks });
      collected.push(...rows);
      currentOffset += rows.length;
      if (rows.length < remaining) break; // exhausted
      if (!wantAll && collected.length >= limit) break;
    }
    return wantAll ? collected : collected.slice(0, limit);
  }

  // Generalised over all three logicalKey styles (see catalyst_types.js's normaliseRow
  // doc comment): 'ROWID' -> `id` already IS the ROWID value; anything else (an explicit
  // key column, e.g. 'id' or 'branch_code') -> look its ROWID up by that column.
  async function resolveRowId(logicalTable, id) {
    const key = logicalKeyOf(logicalTable);
    if (key === 'ROWID') return String(id);
    const rows = await zcqlRows(logicalTable, buildSelectSql(logicalTable, { [key]: id }, { columns: ['ROWID'], limit: 1 }));
    return rows.length ? String(rows[0].ROWID) : null;
  }

  function mapWriteError(logicalTable, e) {
    if (looksLikeUniqueViolation(e)) {
      return new UniqueViolationError({ table: logicalTable, constraint: extractUniqueColumn(e) });
    }
    return e;
  }

  const store = {
    claimSemantics: 'BEST_EFFORT', // see module header: claim()/releaseClaim() are NOT atomic here

    async insert(table, row) {
      assertTableAllowed(table);
      assertColumnsAllowed(table, Object.keys(row));
      try {
        const raw = await getTable(table).insertRow(row);
        return normaliseRow(table, raw);
      } catch (e) {
        throw mapWriteError(table, e);
      }
    },

    // NOT atomic (documented): sequential insertRow calls, no rollback of rows already
    // inserted when a later row fails. On failure the thrown error carries
    // `insertedCount` = how many rows succeeded before the failure.
    async insertMany(table, rows) {
      const out = [];
      for (const row of rows) {
        try {
          out.push(await store.insert(table, row));
        } catch (e) {
          e.insertedCount = out.length;
          throw e;
        }
      }
      return out;
    },

    async update(table, id, patch) {
      assertTableAllowed(table);
      assertNotAppendOnly(table);
      assertColumnsAllowed(table, Object.keys(patch));
      const rowId = await resolveRowId(table, id);
      if (rowId === null) return null;
      try {
        const raw = await getTable(table).updateRow({ ROWID: rowId, ...patch });
        return normaliseRow(table, raw);
      } catch (e) {
        if (looksLikeNotFound(e)) return null;
        throw mapWriteError(table, e);
      }
    },

    async get(table, id) {
      assertTableAllowed(table);
      const key = logicalKeyOf(table);
      if (key !== 'ROWID') {
        return store.findOne(table, { [key]: id });
      }
      try {
        const raw = await getTable(table).getRow(id);
        return normaliseRow(table, raw);
      } catch (e) {
        if (looksLikeNotFound(e)) return null;
        throw e;
      }
    },

    async findOne(table, where = {}) {
      const rows = await store.find(table, where, { limit: 1 });
      return rows[0] ?? null;
    },

    async find(table, where = {}, { orderBy, limit, offset } = {}) {
      assertTableAllowed(table);
      const rawRows = await selectAll(table, where, { orderBy, limit, offset });
      return rawRows.map((r) => normaliseRow(table, r));
    },

    async count(table, where = {}) {
      assertTableAllowed(table);
      const physical = toPhysicalTable(table);
      const whereKeys = Object.keys(where ?? {});
      let sql = `SELECT COUNT(ROWID) AS cnt FROM ${physical}`;
      if (whereKeys.length) {
        assertColumnsAllowed(table, whereKeys);
        const clauses = whereKeys.map((k) => (where[k] === null ? `${k} IS NULL` : `${k} = ${zcqlLiteral(table, k, where[k])}`));
        sql += ` WHERE ${clauses.join(' AND ')}`;
      }
      const result = await runZcql(sql);
      const row = result?.[0]?.[physical];
      return Number(row?.cnt ?? 0);
    },

    // Read-only escape hatch, like sqlite.js's raw(). ZCQL has no bound-parameter API, so
    // `?` placeholders are substituted with escaped literals before the query is sent —
    // callers must still only pass fixed application SQL, never untrusted input, exactly
    // as with sqlite.js's raw().
    async raw(sql, params = []) {
      const stripped = sql.replace(/--[^\n]*/g, '').trim();
      if (!/^(select|with)\b/i.test(stripped)) throw new RawSqlNotReadOnlyError(sql);
      const withoutTrailingSemicolon = stripped.replace(/;\s*$/, '');
      if (withoutTrailingSemicolon.includes(';')) throw new RawSqlNotReadOnlyError(sql);

      let i = 0;
      const substituted = sql.replace(/\?/g, () => {
        const v = params[i++];
        if (v === null || v === undefined) return 'NULL';
        if (typeof v === 'number' || typeof v === 'bigint') return String(v);
        return `'${escapeZcqlString(v)}'`;
      });

      const result = await runZcql(substituted);
      return (result ?? []).map((r) => {
        const tableKey = Object.keys(r)[0];
        const inner = { ...r[tableKey] };
        if (inner.ROWID !== undefined) {
          // Don't clobber an id-keyed table's own `id` column (e.g. extraction_runs,
          // recon_runs) — only synthesise `id` from ROWID when there isn't one already.
          if (inner.id === undefined) inner.id = String(inner.ROWID);
          delete inner.ROWID;
        }
        return inner;
      });
    },

    // Best-effort only (documented in the module header): Catalyst Data Store has no
    // multi-statement transaction primitive reachable from here, so this simply runs `fn`
    // against this same store — a failure partway through does NOT roll back earlier writes.
    async transaction(fn) {
      return fn(store);
    },

    // NOT atomic (documented, claimSemantics === 'BEST_EFFORT' above): a plain read
    // followed by a conditional write, not a single `UPDATE ... WHERE ... RETURNING` the
    // way sqlite.js's claim() is. Two workers racing on the same row can both observe the
    // pre-claim state and both "win" — the worker MUST run single-instance against this
    // adapter until Catalyst exposes an atomic conditional-update primitive.
    async claim(table, id, { workerId, expectedStatus, newStatus, ttlMs }) {
      assertTableAllowed(table);
      assertNotAppendOnly(table);
      const current = await store.get(table, id);
      if (!current) return null;
      const now = Date.now();
      const claimExpiresAtMs = current.claim_expires_at ? Date.parse(current.claim_expires_at) : NaN;
      const claimIsFree = !current.claimed_by || (!Number.isNaN(claimExpiresAtMs) && claimExpiresAtMs < now);
      if (current.status !== expectedStatus || !claimIsFree) return null;
      return store.update(table, id, {
        status: newStatus,
        claimed_by: workerId,
        claimed_at: nowIso(),
        claim_expires_at: new Date(now + ttlMs).toISOString(),
      });
    },

    async releaseClaim(table, id, { workerId, newStatus }) {
      assertTableAllowed(table);
      assertNotAppendOnly(table);
      const current = await store.get(table, id);
      if (!current || current.claimed_by !== workerId) return null;
      return store.update(table, id, { status: newStatus, claimed_by: null, claimed_at: null, claim_expires_at: null });
    },

    async close() {
      // No persistent connection to close: every call goes through the injected app/transport.
    },

    // See the `stats` const above: currently just `chunkedQueries`. Returns a snapshot
    // (not the live object) so a caller can't mutate the adapter's internal counter.
    stats() {
      return { ...stats };
    },
  };

  return store;
}

export {
  UniqueViolationError,
  TableNotAllowedError,
  ColumnNotAllowedError,
  RawSqlNotReadOnlyError,
  AppendOnlyViolationError,
  ZcqlChunkMismatchError,
  ZCQL_MAX_SELECT_COLUMNS,
};
