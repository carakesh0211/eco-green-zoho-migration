// Store adapter on node:sqlite (DatabaseSync). See CONTRACTS.md §S.
//
// Applies schema.sql on open. node:sqlite's DatabaseSync#exec() accepts a full
// multi-statement script (comments and PRAGMAs included) in one call — verified
// against the exact schema.sql shipped in this repo — so no manual statement
// splitting is required; we still strip `--` line comments before parsing the
// schema for the table/column whitelist below (a separate, static pass used
// only for injection-safety validation, not for execution).
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nowIso } from '../../core/ids.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = `${__dirname}/schema.sql`;

export class UniqueViolationError extends Error {
  constructor({ table, constraint }) {
    super(`UNIQUE violation on ${table}.${constraint}`);
    this.code = 'UNIQUE_VIOLATION';
    this.table = table;
    this.constraint = constraint;
  }
}

export class TableNotAllowedError extends Error {
  constructor(table) {
    super(`Table not allowed: ${table}`);
    this.code = 'TABLE_NOT_ALLOWED';
    this.table = table;
  }
}

export class ColumnNotAllowedError extends Error {
  constructor(table, column) {
    super(`Column not allowed on ${table}: ${column}`);
    this.code = 'COLUMN_NOT_ALLOWED';
    this.table = table;
    this.column = column;
  }
}

export class RawSqlNotReadOnlyError extends Error {
  constructor(sql) {
    super('store.raw() only accepts read-only SELECT/WITH statements');
    this.code = 'RAW_SQL_NOT_READONLY';
    this.sql = sql;
  }
}

export class RowNotFoundError extends Error {
  constructor(table, id) {
    super(`Row not found: ${table}#${id}`);
    this.code = 'ROW_NOT_FOUND';
    this.table = table;
    this.id = id;
  }
}

// ---------------------------------------------------------------- schema introspection

function splitTopLevel(str, sep) {
  const parts = [];
  let depth = 0;
  let cur = '';
  for (const ch of str) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === sep && depth === 0) {
      parts.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

/** Parse CREATE TABLE blocks -> Map<table, {columns:Set<string>, pk:string}>. Used only to
 *  build the injection-safety whitelist; the schema is still applied verbatim via db.exec(). */
export function parseSchemaTables(schemaSqlRaw) {
  const sql = schemaSqlRaw.replace(/--[^\n]*/g, '');
  const tables = new Map();
  const re = /CREATE TABLE(?:\s+IF NOT EXISTS)?\s+(\w+)\s*\(/gi;
  let m;
  while ((m = re.exec(sql))) {
    const name = m[1];
    const start = m.index + m[0].length;
    let depth = 1;
    let i = start;
    while (i < sql.length && depth > 0) {
      if (sql[i] === '(') depth++;
      else if (sql[i] === ')') depth--;
      i++;
    }
    const body = sql.slice(start, i - 1);
    const columns = new Set();
    let pk = null;
    for (const rawPart of splitTopLevel(body, ',')) {
      const part = rawPart.trim();
      if (!part) continue;
      const upper = part.toUpperCase();
      if (/^(PRIMARY KEY|UNIQUE|FOREIGN KEY|CHECK|CONSTRAINT)\b/.test(upper)) {
        const pkMatch = part.match(/PRIMARY KEY\s*\(\s*(\w+)/i);
        if (pkMatch) pk = pkMatch[1];
        continue;
      }
      const colMatch = part.match(/^"?(\w+)"?\s+/);
      if (!colMatch) continue;
      const col = colMatch[1];
      columns.add(col);
      if (/PRIMARY KEY/i.test(part)) pk = col;
    }
    tables.set(name, { columns, pk: pk || 'id' });
  }
  return tables;
}

function parseUniqueViolation(message) {
  // "UNIQUE constraint failed: t.a, t.b" -> { table: 't', constraint: 'a,b' }
  const m = message.match(/UNIQUE constraint failed:\s*(.+)$/);
  if (!m) return null;
  const parts = m[1].split(',').map((p) => p.trim());
  const cols = [];
  let table = null;
  for (const p of parts) {
    const [t, c] = p.split('.');
    if (!table) table = t;
    cols.push(c ?? p);
  }
  return { table: table ?? 'unknown', constraint: cols.join(',') };
}

function toPlain(row) {
  return row ? { ...row } : null;
}

// ---------------------------------------------------------------- store factory

export async function openStore(opts = {}) {
  const path = opts.path ?? process.env.SQLITE_PATH ?? './var/migration.db';
  if (path !== ':memory:') {
    const dir = dirname(path);
    if (dir && dir !== '.' && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  const db = new DatabaseSync(path);
  const schemaSql = readFileSync(SCHEMA_PATH, 'utf8');
  db.exec(schemaSql);
  const tables = parseSchemaTables(schemaSql);

  function assertTable(table) {
    if (!tables.has(table)) throw new TableNotAllowedError(table);
  }
  function assertColumns(table, cols) {
    const def = tables.get(table);
    for (const c of cols) {
      if (!def.columns.has(c)) throw new ColumnNotAllowedError(table, c);
    }
  }
  function pkOf(table) {
    return tables.get(table).pk;
  }

  function runInsert(table, row) {
    assertTable(table);
    const cols = Object.keys(row);
    assertColumns(table, cols);
    const placeholders = cols.map(() => '?').join(', ');
    const colList = cols.map((c) => `"${c}"`).join(', ');
    const sql = `INSERT INTO ${table} (${colList}) VALUES (${placeholders}) RETURNING *`;
    try {
      const stmt = db.prepare(sql);
      const result = stmt.get(...cols.map((c) => row[c]));
      return toPlain(result);
    } catch (e) {
      if (e && e.code === 'ERR_SQLITE_ERROR' && /UNIQUE constraint failed/.test(e.message)) {
        const parsed = parseUniqueViolation(e.message);
        throw new UniqueViolationError({ table: parsed?.table ?? table, constraint: parsed?.constraint ?? 'unknown' });
      }
      throw e;
    }
  }

  function buildWhere(table, where) {
    const keys = Object.keys(where ?? {});
    assertColumns(table, keys);
    if (keys.length === 0) return { clause: '1=1', params: [] };
    const params = [];
    const parts = keys.map((k) => {
      const v = where[k];
      if (v === null) return `"${k}" IS NULL`;
      params.push(v);
      return `"${k}" = ?`;
    });
    return { clause: parts.join(' AND '), params };
  }

  let inTransaction = false;

  const store = {
    async insert(table, row) {
      return runInsert(table, row);
    },

    async insertMany(table, rows) {
      return store.transaction(async () => {
        const out = [];
        for (const row of rows) out.push(runInsert(table, row));
        return out;
      });
    },

    async update(table, id, patch) {
      assertTable(table);
      const cols = Object.keys(patch);
      assertColumns(table, cols);
      const pk = pkOf(table);
      const setClause = cols.map((c) => `"${c}" = ?`).join(', ');
      const sql = `UPDATE ${table} SET ${setClause} WHERE "${pk}" = ? RETURNING *`;
      const stmt = db.prepare(sql);
      const result = stmt.get(...cols.map((c) => patch[c]), id);
      return toPlain(result) ?? null;
    },

    async get(table, id) {
      assertTable(table);
      const pk = pkOf(table);
      return store.findOne(table, { [pk]: id });
    },

    async findOne(table, where = {}) {
      assertTable(table);
      const { clause, params } = buildWhere(table, where);
      const stmt = db.prepare(`SELECT * FROM ${table} WHERE ${clause} LIMIT 1`);
      const row = stmt.get(...params);
      return toPlain(row) ?? null;
    },

    async find(table, where = {}, { orderBy, limit, offset } = {}) {
      assertTable(table);
      const { clause, params } = buildWhere(table, where);
      let sql = `SELECT * FROM ${table} WHERE ${clause}`;
      if (orderBy) {
        const [col, dirRaw] = String(orderBy).trim().split(/\s+/);
        assertColumns(table, [col]);
        const dir = /^desc$/i.test(dirRaw ?? '') ? 'DESC' : 'ASC';
        sql += ` ORDER BY "${col}" ${dir}`;
      }
      if (Number.isInteger(limit)) {
        sql += ' LIMIT ?';
        params.push(limit);
      }
      if (Number.isInteger(offset)) {
        sql += ' OFFSET ?';
        params.push(offset);
      }
      const stmt = db.prepare(sql);
      return stmt.all(...params).map(toPlain);
    },

    async count(table, where = {}) {
      assertTable(table);
      const { clause, params } = buildWhere(table, where);
      const stmt = db.prepare(`SELECT COUNT(*) AS cnt FROM ${table} WHERE ${clause}`);
      const row = stmt.get(...params);
      return Number(row.cnt);
    },

    async raw(sql, params = []) {
      const stripped = sql.replace(/--[^\n]*/g, '').trim();
      if (!/^(select|with)\b/i.test(stripped)) throw new RawSqlNotReadOnlyError(sql);
      // Reject stacked statements (defence in depth against injection via string-built sql).
      const withoutTrailingSemicolon = stripped.replace(/;\s*$/, '');
      if (withoutTrailingSemicolon.includes(';')) throw new RawSqlNotReadOnlyError(sql);
      const stmt = db.prepare(sql);
      return stmt.all(...params).map(toPlain);
    },

    async transaction(fn) {
      if (inTransaction) {
        // Already inside a transaction on this single connection: just run inline,
        // the outer transaction owns the commit/rollback.
        return fn(store);
      }
      inTransaction = true;
      db.exec('BEGIN');
      try {
        const result = await fn(store);
        db.exec('COMMIT');
        return result;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      } finally {
        inTransaction = false;
      }
    },

    async claim(table, id, { workerId, expectedStatus, newStatus, ttlMs }) {
      assertTable(table);
      const pk = pkOf(table);
      const now = nowIso();
      const claimExpiresAt = new Date(Date.now() + ttlMs).toISOString();
      const sql = `UPDATE ${table}
                   SET status = ?, claimed_by = ?, claimed_at = ?, claim_expires_at = ?
                   WHERE "${pk}" = ? AND status = ? AND (claimed_by IS NULL OR claim_expires_at < ?)
                   RETURNING *`;
      const stmt = db.prepare(sql);
      const row = stmt.get(newStatus, workerId, now, claimExpiresAt, id, expectedStatus, now);
      return toPlain(row) ?? null;
    },

    async releaseClaim(table, id, { workerId, newStatus }) {
      assertTable(table);
      const pk = pkOf(table);
      const sql = `UPDATE ${table}
                   SET status = ?, claimed_by = NULL, claimed_at = NULL, claim_expires_at = NULL
                   WHERE "${pk}" = ? AND claimed_by = ?
                   RETURNING *`;
      const stmt = db.prepare(sql);
      const row = stmt.get(newStatus, id, workerId);
      return toPlain(row) ?? null;
    },

    async close() {
      db.close();
    },

    // Exposed for tests / diagnostics only — not part of the §S contract surface.
    _tables: tables,
  };

  return store;
}
