// In-memory, Catalyst-shaped fake of the two SDK surfaces the store adapter uses:
// `app.datastore().table(name)` (insertRow/insertRows/getRow/getPagedRows/updateRow/
// updateRows) and `app.zcql().executeZCQLQuery(sql)`. Used only in tests (offline, no
// network) — see test/store_catalyst.test.js. Mirrors src/adapters/store/catalyst.js's
// documented assumptions about Catalyst's real behaviour so the two evolve together.
//
// Faithfulness notes (see catalyst_types.js's header for the full assumption list):
//   - ROWID is a 16-digit numeric string, kept within Number.MAX_SAFE_INTEGER so the
//     "NUMBER on insert / STRING elsewhere" split (coordinator's observed live shape)
//     round-trips exactly.
//   - CREATORID/CREATEDTIME/MODIFIEDTIME are synthesised on every write.
//   - Unique-column and mandatory-column enforcement use schema.catalyst.js's
//     `is_unique`/`is_mandatory` flags, raising the ASSUMED Catalyst error shapes
//     documented in catalyst_types.js (`looksLikeUniqueViolation`/`looksLikeNotFound`).
//     `is_mandatory` is enforced as NOT NULL only (undefined/null rejected; an empty
//     string is a legitimate mandatory value) — corrected here after running the full
//     dashboard pipeline against this fake surfaced that src/core/recon_a.js's
//     `missingControl()` legitimately inserts `difference: ''` on recon_results
//     (a MANDATORY, already-LIVE column) for MISSING_EXPECTED/MISSING_ACTUAL controls;
//     rejecting empty string would make Layer A's "missing" control path
//     unrunnable against Catalyst. Not independently verified against live Catalyst
//     either way (no OAuth credential in this pilot) — NOT NULL is the more
//     conventional reading of "mandatory" and the one sqlite.js already allows.
//   - ZCQL SELECT enforces the real 300-row cap and understands the minimal subset
//     `SELECT <cols|*> FROM t [WHERE a = 'x' AND b IS NULL ...]
//     [ORDER BY c1 [ASC|DESC], c2 [ASC|DESC], ...] [LIMIT n OFFSET m]` (multi-term ORDER
//     BY exists only so catalyst.js's chunked queries can append `, ROWID` as a
//     determinism tie-break — see catalyst.js's buildSelectSql) plus the exact
//     `SELECT COUNT(ROWID) AS <alias> FROM t [WHERE ...]` shape the adapter's `count()`
//     emits.
//   - ZCQL SELECT also enforces the real 30-selected-column cap (ZCQL_MAX_SELECT_COLUMNS,
//     catalyst_types.js), including when `SELECT *` expands past it — this is the guard
//     that would have caught the live "More than 30 select columns are not allowed" bug
//     (docs/CATALYST_REFERENCES.md) before it ever reached the real Data Store.
import { TABLES } from '../../../catalyst/iac/schema.catalyst.js';
import { TEXT_MAX_LENGTH, ZCQL_MAX_SELECT_COLUMNS } from './catalyst_types.js';

const ROWID_BASE = 4_200_000_000_000_000n; // 16 digits, well under Number.MAX_SAFE_INTEGER

function fakeError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

function tableDefByPhysicalName(name) {
  const def = TABLES.find((t) => t.name === name);
  if (!def) throw fakeError('TABLE_NOT_FOUND', `Table not found: ${name}`);
  return def;
}

function formatCatalystTime(d) {
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}:${pad(d.getMilliseconds(), 3)}`
  );
}

function assertKnownColumn(def, tableName, column) {
  const isSystemColumn = column === 'ROWID' || column === 'CREATORID' || column === 'CREATEDTIME' || column === 'MODIFIEDTIME';
  if (isSystemColumn) return;
  if (!def.columns.some((c) => c.column_name === column)) {
    throw fakeError('INVALID_COLUMN', `Unknown column '${column}' on table '${tableName}'`);
  }
}

function checkMandatory(def, tableName, row) {
  for (const c of def.columns) {
    if (!c.is_mandatory) continue;
    const v = row[c.column_name];
    if (v === undefined || v === null) {
      throw fakeError('INVALID_INPUT', `Value cannot be empty for the mandatory column: ${c.column_name}`);
    }
  }
}

function checkTextLength(def, tableName, row) {
  for (const c of def.columns) {
    if (c.data_type !== 'text') continue;
    const v = row[c.column_name];
    if (typeof v === 'string' && v.length > TEXT_MAX_LENGTH) {
      throw fakeError('INVALID_INPUT', `Value too long for text column '${c.column_name}' (max ${TEXT_MAX_LENGTH})`);
    }
  }
}

// Real Catalyst rejects a varchar value longer than its declared max_length. The
// adapter/fake previously only enforced this for `text` columns (see checkTextLength);
// this closes that gap so an oversized varchar is caught here, offline, rather than only
// discovered against the live Data Store.
function checkVarcharLength(def, tableName, row) {
  for (const c of def.columns) {
    if (c.data_type !== 'varchar') continue;
    const v = row[c.column_name];
    if (typeof v === 'string' && v.length > c.max_length) {
      throw fakeError(
        'INVALID_INPUT',
        `Value too long for the column '${c.column_name}' from a maximum of ${c.max_length} characters.`
      );
    }
  }
}

function checkUnique(def, tableName, rowsMap, candidate, excludeKey) {
  const uniqueCols = def.columns.filter((c) => c.is_unique);
  for (const c of uniqueCols) {
    const val = candidate[c.column_name];
    if (val === undefined || val === null) continue;
    for (const [key, existing] of rowsMap) {
      if (key === excludeKey) continue;
      if (existing[c.column_name] !== undefined && existing[c.column_name] !== null && String(existing[c.column_name]) === String(val)) {
        throw fakeError(
          'INVALID_INPUT',
          `The given column value '${val}' for the column '${c.column_name}' is already present.`
        );
      }
    }
  }
}

function makeTableApi(def, physicalName, rowsMap, nextRowId) {
  function insertOne(row) {
    for (const key of Object.keys(row)) assertKnownColumn(def, physicalName, key);
    checkMandatory(def, physicalName, row);
    checkTextLength(def, physicalName, row);
    checkVarcharLength(def, physicalName, row);
    checkUnique(def, physicalName, rowsMap, row, null);
    const rowId = nextRowId();
    const now = formatCatalystTime(new Date());
    const stored = { ...row, ROWID: rowId, CREATORID: 'fake-creator', CREATEDTIME: now, MODIFIEDTIME: now };
    rowsMap.set(rowId, stored);
    return { ...stored, ROWID: Number(rowId) };
  }

  return {
    async insertRow(row) {
      return insertOne(row);
    },
    async insertRows(rowArr) {
      const out = [];
      for (const row of rowArr) out.push(insertOne(row));
      return out;
    },
    async getRow(id) {
      const key = String(id);
      const raw = rowsMap.get(key);
      if (!raw) throw fakeError('ROW_NOT_FOUND', `Row not found: ${physicalName}#${id}`);
      return { ...raw, ROWID: key };
    },
    async getPagedRows({ nextToken, maxRows = 200 } = {}) {
      const all = [...rowsMap.values()];
      const start = nextToken ? Number(nextToken) : 0;
      const max = Number(maxRows) || 200;
      const page = all.slice(start, start + max);
      const more = start + max < all.length;
      const data = page.map((r) => ({ ...r, ROWID: String(r.ROWID) }));
      return more ? { status: 'success', data, more_records: true, next_token: String(start + max) } : { status: 'success', data, more_records: false };
    },
    async updateRow(row) {
      const { ROWID, ...patch } = row;
      const key = String(ROWID);
      const existing = rowsMap.get(key);
      if (!existing) throw fakeError('ROW_NOT_FOUND', `Row not found: ${physicalName}#${ROWID}`);
      for (const k of Object.keys(patch)) assertKnownColumn(def, physicalName, k);
      const merged = { ...existing, ...patch };
      checkMandatory(def, physicalName, merged);
      checkTextLength(def, physicalName, merged);
      checkVarcharLength(def, physicalName, merged);
      checkUnique(def, physicalName, rowsMap, merged, key);
      merged.MODIFIEDTIME = formatCatalystTime(new Date());
      rowsMap.set(key, merged);
      return { ...merged, ROWID: key };
    },
    async updateRows(rowArr) {
      const out = [];
      for (const row of rowArr) out.push(await this.updateRow(row));
      return out;
    },
    async deleteRow() {
      throw fakeError('NOT_SUPPORTED', 'catalyst_fake.js does not implement deleteRow (not used by this adapter)');
    },
  };
}

// ---------------------------------------------------------------- minimal ZCQL subset

const COUNT_RE = /^SELECT\s+COUNT\(\s*ROWID\s*\)\s+AS\s+(\w+)\s+FROM\s+(\w+)(?:\s+WHERE\s+(.+))?$/i;
// ORDER BY clause is captured whole (group 4) and parsed by parseOrderBy below, since it
// may carry more than one term (catalyst.js's chunked queries append `, ROWID`).
const SELECT_RE =
  /^SELECT\s+(.+?)\s+FROM\s+(\w+)(?:\s+WHERE\s+(.+?))?(?:\s+ORDER\s+BY\s+(.+?))?(?:\s+LIMIT\s+(\d+))?(?:\s+OFFSET\s+(\d+))?$/i;

/** FNV-1a over `rowid:offset` — a different permutation per OFFSET, deterministic per run. */
function unstableOrderKey(rowid, offset) {
  let h = 0x811c9dc5;
  const s = `${rowid}:${offset}`;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

function parseOrderBy(orderByRaw) {
  if (!orderByRaw) return [];
  return orderByRaw.split(',').map((termRaw) => {
    const term = termRaw.trim();
    const m = term.match(/^(\w+)(?:\s+(ASC|DESC))?$/i);
    if (!m) throw fakeError('ZCQL_SYNTAX', `Unsupported ZCQL ORDER BY term: ${term}`);
    return { col: m[1], dir: /^desc$/i.test(m[2] || '') ? -1 : 1 };
  });
}

function parseWhere(whereStr) {
  if (!whereStr) return [];
  return whereStr.split(/\s+AND\s+/i).map((clauseRaw) => {
    const clause = clauseRaw.trim();
    const isNull = clause.match(/^(\w+)\s+IS\s+NULL$/i);
    if (isNull) return { col: isNull[1], op: 'IS NULL' };
    const eq = clause.match(/^(\w+)\s*=\s*(.+)$/);
    if (!eq) throw fakeError('ZCQL_SYNTAX', `Unsupported ZCQL WHERE clause: ${clause}`);
    let value = eq[2].trim();
    if (value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1).replace(/''/g, "'");
    } else {
      value = Number(value);
    }
    return { col: eq[1], op: '=', value };
  });
}

function matchesRow(row, conditions) {
  return conditions.every((c) => {
    if (c.op === 'IS NULL') return row[c.col] === undefined || row[c.col] === null;
    return String(row[c.col] ?? '') === String(c.value);
  });
}

export function createCatalystFake() {
  const tablesState = new Map(); // physical table name -> Map<rowIdString, rawRow>
  let counter = 0n;
  // TEST-ONLY HOOK: set via __setSelectInterceptor (returned below). Called with
  // ({ tableName, sql }, projectedRows) after every SELECT's normal filter/sort/page/
  // column-cap logic runs; a returned array replaces the rows sent back to the caller.
  // Used only to test catalyst.js's ZCQL_CHUNK_MISMATCH handling by making two chunk
  // queries for the same page disagree on which ROWIDs they returned (see
  // test/store_catalyst.test.js) — application code never touches this.
  let selectInterceptor = null;
  function nextRowId() {
    counter += 1n;
    return String(ROWID_BASE + counter);
  }
  function stateFor(physicalName) {
    tableDefByPhysicalName(physicalName); // validates the name
    if (!tablesState.has(physicalName)) tablesState.set(physicalName, new Map());
    return tablesState.get(physicalName);
  }

  async function executeZCQLQuery(sql) {
    const trimmed = sql.trim().replace(/;\s*$/, '');

    const countMatch = trimmed.match(COUNT_RE);
    if (countMatch) {
      const [, alias, tableName, whereRaw] = countMatch;
      const def = tableDefByPhysicalName(tableName);
      const rowsMap = stateFor(tableName);
      const conditions = parseWhere(whereRaw);
      for (const c of conditions) assertKnownColumn(def, tableName, c.col);
      const count = [...rowsMap.values()].filter((r) => matchesRow(r, conditions)).length;
      return [{ [tableName]: { [alias]: count } }];
    }

    const m = trimmed.match(SELECT_RE);
    if (!m) throw fakeError('ZCQL_SYNTAX', `Unsupported ZCQL query shape: ${sql}`);
    const [, colsRaw, tableName, whereRaw, orderByRaw, limitRaw, offsetRaw] = m;
    const def = tableDefByPhysicalName(tableName);
    const rowsMap = stateFor(tableName);
    const conditions = parseWhere(whereRaw);
    for (const c of conditions) assertKnownColumn(def, tableName, c.col);

    let list = [...rowsMap.values()].filter((r) => matchesRow(r, conditions));

    const orderTerms = parseOrderBy(orderByRaw);
    for (const t of orderTerms) assertKnownColumn(def, tableName, t.col);
    if (orderTerms.length) {
      list = [...list].sort((a, b) => {
        for (const t of orderTerms) {
          const av = t.col === 'ROWID' ? a.ROWID : a[t.col];
          const bv = t.col === 'ROWID' ? b.ROWID : b[t.col];
          if (av === bv) continue;
          return (av > bv ? 1 : -1) * t.dir;
        }
        return 0;
      });
    }

    // Real ZCQL OFFSET is 1-based (live, 2026-09-15): OFFSET n starts AT row n, so it skips
    // n-1 rows; OFFSET 0 behaves like OFFSET 1. Modelled exactly so a 0-based caller pays
    // for the mistake here instead of on live (see catalyst.js buildSelectSql).
    const offsetZcql = offsetRaw ? Number(offsetRaw) : 0;
    const offset = Math.max(0, offsetZcql - 1);
    const limit = limitRaw ? Number(limitRaw) : undefined;
    // Live Catalyst does NOT guarantee a stable order across LIMIT/OFFSET pages when the
    // ORDER BY is absent or not total (observed 2026-09-15: duplicate + missing rows in a
    // 351-row paged read). Model it: with no ORDER BY, each page sees a different
    // deterministic permutation, so a caller that paginates without a ROWID tiebreak gets
    // duplicates/gaps here too instead of only in production.
    if (!orderTerms.length && (offsetRaw || limitRaw)) {
      const key = (row) => unstableOrderKey(String(row.ROWID), offset);
      list = [...list].sort((a, b) => key(a) - key(b));
    }
    let page = limit !== undefined ? list.slice(offset, offset + limit) : list.slice(offset);
    if (page.length > 300) page = page.slice(0, 300); // real Catalyst ZCQL row cap

    const cols = colsRaw.trim() === '*' ? [...def.columns.map((c) => c.column_name), 'ROWID'] : colsRaw.split(',').map((s) => s.trim());
    // Live Catalyst Data Store rejects a SELECT naming more than 30 columns — this is the
    // guard that would have caught the real bug (see docs/CATALYST_REFERENCES.md,
    // observed 2026-09-15). `code` is ASSUMED (same caveat as every other fakeError in
    // this file); `message` is the exact live wording.
    if (cols.length > ZCQL_MAX_SELECT_COLUMNS) {
      throw fakeError('INVALID_QUERY', 'More than 30 select columns are not allowed');
    }
    for (const c of cols) assertKnownColumn(def, tableName, c);

    let mapped = page.map((row) => {
      const projected = {};
      for (const c of cols) {
        const v = c === 'ROWID' ? String(row.ROWID) : row[c];
        projected[c] = v === undefined ? null : v;
      }
      return { [tableName]: projected };
    });

    // TEST-ONLY HOOK (see __setSelectInterceptor below): lets a test simulate a live-
    // Catalyst race between two chunked SELECTs of the same logical page. Never set
    // outside tests.
    if (selectInterceptor) {
      const intercepted = selectInterceptor({ tableName, sql: trimmed }, mapped.map((r) => r[tableName]));
      if (intercepted) mapped = intercepted.map((projected) => ({ [tableName]: projected }));
    }

    return mapped;
  }

  const app = {
    datastore() {
      return {
        table(name) {
          const def = tableDefByPhysicalName(name);
          const rowsMap = stateFor(name);
          return makeTableApi(def, name, rowsMap, nextRowId);
        },
      };
    },
    zcql() {
      return { executeZCQLQuery };
    },
  };

  // Pre-deploy proof helper (test/pipeline_catalyst_fake.test.js): re-checks every row
  // currently held by the fake against schema.catalyst.js's declared varchar
  // max_length/text cap, independent of (and in addition to) the insert/update-time
  // enforcement above. Throws one Error listing every violation found (table, column,
  // actual length, limit) rather than the first — so a real deployment gets the full
  // picture of what the live Data Store would reject, not just one row at a time.
  function assertWithinLimits() {
    const violations = [];
    for (const [physicalName, rowsMap] of tablesState) {
      const def = tableDefByPhysicalName(physicalName);
      for (const row of rowsMap.values()) {
        for (const c of def.columns) {
          const v = row[c.column_name];
          if (typeof v !== 'string') continue;
          if (c.data_type === 'varchar' && v.length > c.max_length) {
            violations.push(`${physicalName}.${c.column_name}: length ${v.length} > max_length ${c.max_length} (ROWID ${row.ROWID})`);
          } else if (c.data_type === 'text' && v.length > TEXT_MAX_LENGTH) {
            violations.push(`${physicalName}.${c.column_name}: length ${v.length} > text cap ${TEXT_MAX_LENGTH} (ROWID ${row.ROWID})`);
          }
        }
      }
    }
    if (violations.length) {
      throw new Error(`catalyst_fake.assertWithinLimits: ${violations.length} column(s) exceed live Data Store limits:\n${violations.join('\n')}`);
    }
    return true;
  }

  function __setSelectInterceptor(fn) {
    selectInterceptor = fn;
  }

  return { app, assertWithinLimits, __setSelectInterceptor };
}
