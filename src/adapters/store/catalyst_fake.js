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
//   - ZCQL SELECT enforces the real 300-row cap and understands the minimal subset
//     `SELECT <cols|*> FROM t [WHERE a = 'x' AND b IS NULL ...] [ORDER BY c ASC|DESC]
//     [LIMIT n OFFSET m]` plus the exact `SELECT COUNT(ROWID) AS <alias> FROM t [WHERE ...]`
//     shape the adapter's `count()` emits.
import { TABLES } from '../../../catalyst/iac/schema.catalyst.js';
import { TEXT_MAX_LENGTH } from './catalyst_types.js';

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
    if (v === undefined || v === null || v === '') {
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
const SELECT_RE =
  /^SELECT\s+(.+?)\s+FROM\s+(\w+)(?:\s+WHERE\s+(.+?))?(?:\s+ORDER\s+BY\s+(\w+)(?:\s+(ASC|DESC))?)?(?:\s+LIMIT\s+(\d+))?(?:\s+OFFSET\s+(\d+))?$/i;

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
    const [, colsRaw, tableName, whereRaw, orderCol, orderDir, limitRaw, offsetRaw] = m;
    const def = tableDefByPhysicalName(tableName);
    const rowsMap = stateFor(tableName);
    const conditions = parseWhere(whereRaw);
    for (const c of conditions) assertKnownColumn(def, tableName, c.col);

    let list = [...rowsMap.values()].filter((r) => matchesRow(r, conditions));

    if (orderCol) {
      assertKnownColumn(def, tableName, orderCol);
      const dir = /desc/i.test(orderDir || '') ? -1 : 1;
      list = [...list].sort((a, b) => {
        const av = a[orderCol];
        const bv = b[orderCol];
        if (av === bv) return 0;
        return (av > bv ? 1 : -1) * dir;
      });
    }

    const offset = offsetRaw ? Number(offsetRaw) : 0;
    const limit = limitRaw ? Number(limitRaw) : undefined;
    let page = limit !== undefined ? list.slice(offset, offset + limit) : list.slice(offset);
    if (page.length > 300) page = page.slice(0, 300); // real Catalyst ZCQL row cap

    const cols = colsRaw.trim() === '*' ? [...def.columns.map((c) => c.column_name), 'ROWID'] : colsRaw.split(',').map((s) => s.trim());
    for (const c of cols) assertKnownColumn(def, tableName, c);

    return page.map((row) => {
      const projected = {};
      for (const c of cols) {
        const v = c === 'ROWID' ? String(row.ROWID) : row[c];
        projected[c] = v === undefined ? null : v;
      }
      return { [tableName]: projected };
    });
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

  return { app };
}
