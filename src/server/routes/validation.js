// Data validation routes (branch page -> Data validation, #/branches/:code/validation).
//
//   GET  /api/branches/:code/validation/runs                       any role in scope: past runs
//   POST /api/branches/:code/validation/runs                       operator|approver|admin: upload 3 files, reconcile
//   GET  /api/branches/:code/validation/runs/:id                   any role in scope: report (no ledger lines)
//   GET  /api/branches/:code/validation/runs/:id/lines?account=K   any role in scope: one account's ledger lines
//   GET  /api/branches/:code/validation/runs/:id/report.csv?view=  any role in scope: CSV of a report view
//   POST /api/branches/:code/validation/runs/:id/rerun             operator|approver|admin: same files, current mappings
//   GET  /api/validation/mappings                                  any role: confirmed account mappings
//   POST /api/validation/mappings                                  operator|approver|admin: confirm one mapping
//   POST /api/validation/mappings/remove                           operator|approver|admin: remove one mapping
//
// A run never changes migration data. Uploaded files and results are kept in the archive
// (immutable) and found through their audit events (VALIDATION.RUN / VALIDATION.MAPPINGS),
// so no new table is needed. Bot tokens may read but not run or change mappings.
import express from 'express';
import { randomBytes } from 'node:crypto';
import { nowIso } from '../../core/ids.js';
import { sha256Bytes } from '../../core/hash.js';
import { runValidation, reportCsv, ValidationError, ROLES, OPENING_BASIS, REPORT_VIEWS } from '../../core/validation.js';
import { isBotUser } from './agent.js';

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const RUN_ACTION = 'VALIDATION.RUN';
const MAP_ACTION = 'VALIDATION.MAPPINGS';
const ARCHIVE_RUN = 'validation';
const MAP_BRANCH = '_validation';
const MAX_LINES = 5000;

function wrap(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

const parseAfter = (ev) => { try { return JSON.parse(ev.after_json ?? '{}'); } catch { return {}; } };

export function createValidationRouter({ store, audit, auth, archive }) {
  const router = express.Router();
  const cache = new Map(); // archive uri -> parsed JSON (small LRU)
  const remember = (uri, value) => {
    cache.delete(uri);
    cache.set(uri, value);
    while (cache.size > 6) cache.delete(cache.keys().next().value);
    return value;
  };
  async function getJson(uri) {
    if (cache.has(uri)) return remember(uri, cache.get(uri));
    return remember(uri, JSON.parse((await archive.get(uri)).toString('utf8')));
  }
  async function putBytes(branchCode, fileName, bytes) {
    return archive.put({ runId: ARCHIVE_RUN, branchCode, fileName, bytes, sha256: sha256Bytes(bytes) });
  }
  const safeName = (s) => String(s ?? 'file').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80);

  const noBots = (req, res, next) => {
    if (isBotUser(req.user)) return auth.deny(req, res, { status: 403, error: 'FORBIDDEN', reason: 'BOT_CEILING:validation', message: 'Bot/agent tokens may not run validations or change mappings' });
    next();
  };
  const needArchive = (req, res, next) => {
    if (!archive) return res.status(501).json({ error: 'NOT_IMPLEMENTED', message: 'No archive is configured, so validation runs cannot be stored.' });
    next();
  };
  const inScope = (req, res, next) => {
    if (!auth.branchAllowed(req.user, req.params.code)) return auth.deny(req, res, { status: 403, error: 'FORBIDDEN', reason: `BRANCH_SCOPE:${req.params.code}` });
    next();
  };
  const canRun = [auth.requireCorrelationId(), noBots, auth.requireRole('operator', 'approver', 'admin')];

  // ---- mappings (global: account names are shared by every branch) ----
  async function loadMappings() {
    const [ev] = await store.find('audit_events', { action: MAP_ACTION }, { orderBy: 'created_at DESC', limit: 1 });
    const uri = ev ? parseAfter(ev).uri : null;
    return uri ? (await getJson(uri)).mappings ?? [] : [];
  }
  async function saveMappings(req, mappings, change) {
    const bytes = Buffer.from(JSON.stringify({ version: 1, mappings }), 'utf8');
    const stamp = `${nowIso().replace(/[^0-9]/g, '')}-${randomBytes(3).toString('hex')}`;
    const uri = await putBytes(MAP_BRANCH, `mappings-${stamp}.json`, bytes);
    remember(uri, { version: 1, mappings });
    await audit.emit({
      actor: req.user.id, actorRole: req.user.role, action: MAP_ACTION, entityType: 'validation_mappings', entityId: null,
      before: null, after: { uri, count: mappings.length, change }, correlationId: req.correlationId,
    });
  }

  // ---- runs ----
  async function findRun(branch, id) {
    const [ev] = await store.find('audit_events', { action: RUN_ACTION, entity_id: id }, { limit: 1 });
    if (!ev || ev.branch_code !== branch) return null;
    return { event: ev, meta: parseAfter(ev) };
  }

  async function execute(req, branch, files, { tolerance, openingBasis, reserveCode = null, rerunOf = null, inputUris = null }) {
    const mappings = await loadMappings();
    const result = runValidation(files, { mappings, tolerance, openingBasis, reserveCode });
    const id = `val-${branch}-${nowIso().replace(/[^0-9]/g, '').slice(0, 14)}-${randomBytes(3).toString('hex')}`;
    const inputs = {};
    for (const role of ROLES) {
      const f = files[role];
      if (!f) continue;
      inputs[role] = {
        name: f.name, sha256: sha256Bytes(f.bytes),
        uri: inputUris?.[role] ?? await putBytes(branch, `${id}-input-${role}-${safeName(f.name)}`, f.bytes),
      };
    }
    const doc = {
      version: 1, id, branch_code: branch, created_at: nowIso(), created_by: req.user.id, rerun_of: rerunOf,
      tolerance: result.summary.tolerance, opening_basis: result.opening_basis, mappings_used: mappings.length, ...result,
    };
    const uri = await putBytes(branch, `${id}-result.json`, Buffer.from(JSON.stringify(doc), 'utf8'));
    remember(uri, doc);
    const s = result.summary;
    await audit.emit({
      actor: req.user.id, actorRole: req.user.role, action: RUN_ACTION, entityType: 'validation_run', entityId: id,
      before: null,
      after: {
        uri, rerun_of: rerunOf, opening_basis: result.opening_basis,
        inputs: Object.fromEntries(Object.entries(inputs).map(([r, v]) => [r, v])),
        summary: { accounts: s.accounts, reconciled: s.reconciled, differences: s.differences, total_difference: s.total_difference, equation_holds: s.equation_holds },
      },
      correlationId: req.correlationId, branchCode: branch,
    });
    return doc;
  }

  const withoutLines = (doc) => {
    const { lines, ...rest } = doc;
    return rest;
  };

  function decodeFile(f, role) {
    if (!f) return undefined;
    if (typeof f.content !== 'string' || f.content === '') throw new ValidationError('BAD_REQUEST', `${role}: empty file`);
    const bytes = Buffer.from(f.content, 'base64');
    if (bytes.length === 0) throw new ValidationError('BAD_REQUEST', `${role}: empty file`);
    if (bytes.length > MAX_FILE_BYTES) throw new ValidationError('FILE_TOO_LARGE', `${f.name ?? role}: larger than ${MAX_FILE_BYTES / 1024 / 1024} MB`);
    return { name: String(f.name ?? `${role}.xlsx`), bytes };
  }

  const sendError = (res, err) => {
    if (err instanceof ValidationError) return res.status(err.code === 'FILE_TOO_LARGE' ? 413 : 400).json({ error: err.code, message: err.message });
    throw err;
  };

  function options(body) {
    const tolerance = body?.tolerance === undefined || body.tolerance === '' ? '0.00' : String(body.tolerance);
    if (!/^\d+(\.\d{1,2})?$/.test(tolerance)) throw new ValidationError('BAD_REQUEST', 'tolerance must be an amount like 0.00 or 1.00');
    const openingBasis = body?.opening_basis ?? 'auto';
    if (!OPENING_BASIS.includes(openingBasis)) throw new ValidationError('BAD_REQUEST', `opening_basis must be one of ${OPENING_BASIS.join(', ')}`);
    const reserveCode = body?.reserve_code ? String(body.reserve_code).trim().slice(0, 40) || null : null;
    return { tolerance, openingBasis, reserveCode };
  }

  router.get('/branches/:code/validation/runs', auth.authenticate(), inScope, wrap(async (req, res) => {
    const events = await store.find('audit_events', { action: RUN_ACTION, branch_code: req.params.code }, { orderBy: 'created_at DESC', limit: 25 });
    res.json({
      archive: Boolean(archive),
      runs: events.map((ev) => {
        const a = parseAfter(ev);
        return { id: ev.entity_id, created_at: ev.created_at, created_by: ev.actor, opening_basis: a.opening_basis, rerun_of: a.rerun_of ?? null, inputs: Object.fromEntries(Object.entries(a.inputs ?? {}).map(([r, v]) => [r, { name: v.name }])), summary: a.summary };
      }),
    });
  }));

  router.post('/branches/:code/validation/runs', auth.authenticate(), inScope, ...canRun, needArchive, wrap(async (req, res) => {
    const branch = req.params.code;
    let files; let opts;
    try {
      const f = req.body?.files ?? {};
      files = { opening: decodeFile(f.opening, 'opening'), closing: decodeFile(f.closing, 'closing'), ledger: decodeFile(f.ledger, 'ledger') };
      opts = options(req.body);
      const doc = await execute(req, branch, files, opts);
      res.status(201).json(withoutLines(doc));
    } catch (err) {
      sendError(res, err);
    }
  }));

  router.get('/branches/:code/validation/runs/:id', auth.authenticate(), inScope, needArchive, wrap(async (req, res) => {
    const run = await findRun(req.params.code, req.params.id);
    if (!run) return res.status(404).json({ error: 'NOT_FOUND', message: 'No such validation run for this branch' });
    res.json(withoutLines(await getJson(run.meta.uri)));
  }));

  router.get('/branches/:code/validation/runs/:id/lines', auth.authenticate(), inScope, needArchive, wrap(async (req, res) => {
    const run = await findRun(req.params.code, req.params.id);
    if (!run) return res.status(404).json({ error: 'NOT_FOUND', message: 'No such validation run for this branch' });
    const doc = await getJson(run.meta.uri);
    const account = String(req.query.account ?? '');
    const row = doc.accounts.find((a) => a.key === account);
    if (!row) return res.status(404).json({ error: 'NOT_FOUND', message: 'No such account in this run' });
    const lines = doc.lines[account] ?? [];
    res.json({ account: row, total_lines: lines.length, truncated: lines.length > MAX_LINES, lines: lines.slice(0, MAX_LINES) });
  }));

  router.get('/branches/:code/validation/runs/:id/report.csv', auth.authenticate(), inScope, needArchive, wrap(async (req, res) => {
    const run = await findRun(req.params.code, req.params.id);
    if (!run) return res.status(404).json({ error: 'NOT_FOUND', message: 'No such validation run for this branch' });
    const view = String(req.query.view ?? 'all');
    if (!Object.hasOwn(REPORT_VIEWS, view)) return res.status(400).json({ error: 'BAD_REQUEST', message: `view must be one of ${Object.keys(REPORT_VIEWS).join(', ')}` });
    const doc = await getJson(run.meta.uri);
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="validation-${req.params.code}-${view}-${req.params.id}.csv"`);
    res.send(reportCsv(doc, view));
  }));

  router.post('/branches/:code/validation/runs/:id/rerun', auth.authenticate(), inScope, ...canRun, needArchive, wrap(async (req, res) => {
    const branch = req.params.code;
    const run = await findRun(branch, req.params.id);
    if (!run) return res.status(404).json({ error: 'NOT_FOUND', message: 'No such validation run for this branch' });
    const previous = await getJson(run.meta.uri);
    const files = {}; const inputUris = {};
    for (const [role, input] of Object.entries(run.meta.inputs ?? {})) {
      files[role] = { name: input.name, bytes: await archive.get(input.uri) };
      inputUris[role] = input.uri;
    }
    try {
      const opts = options({ tolerance: req.body?.tolerance ?? previous.tolerance, opening_basis: req.body?.opening_basis ?? ({ closing_tb_opening_columns: 'closing_tb_opening', closing_columns: 'closing_columns' }[previous.opening_basis] ?? 'auto'), reserve_code: req.body?.reserve_code ?? previous.year_end_close?.reserve?.code ?? null });
      const doc = await execute(req, branch, files, { ...opts, rerunOf: req.params.id, inputUris });
      res.status(201).json(withoutLines(doc));
    } catch (err) {
      sendError(res, err);
    }
  }));

  router.get('/validation/mappings', auth.authenticate(), wrap(async (req, res) => {
    res.json({ mappings: archive ? await loadMappings() : [] });
  }));

  router.post('/validation/mappings', auth.authenticate(), ...canRun, needArchive, wrap(async (req, res) => {
    const { role, from_key: fromKey, from_name: fromName = '', to_key: toKey, to_name: toName = '' } = req.body ?? {};
    if (!ROLES.includes(role)) return res.status(400).json({ error: 'BAD_REQUEST', message: `role must be one of ${ROLES.join(', ')}` });
    for (const [k, v] of [['from_key', fromKey], ['to_key', toKey]]) {
      if (typeof v !== 'string' || !/^[CN]:.{1,200}$/.test(v)) return res.status(400).json({ error: 'BAD_REQUEST', message: `${k} must be an account key from a validation run` });
    }
    if (fromKey === toKey) return res.status(400).json({ error: 'BAD_REQUEST', message: 'An account cannot be mapped to itself' });
    const mappings = (await loadMappings()).filter((m) => !(m.role === role && m.from_key === fromKey));
    const entry = { role, from_key: fromKey, from_name: String(fromName).slice(0, 200), to_key: toKey, to_name: String(toName).slice(0, 200), by: req.user.id, at: nowIso() };
    mappings.push(entry);
    await saveMappings(req, mappings, { op: 'set', role, from_key: fromKey, to_key: toKey });
    res.json({ mapping: entry, count: mappings.length });
  }));

  router.post('/validation/mappings/remove', auth.authenticate(), ...canRun, needArchive, wrap(async (req, res) => {
    const { role, from_key: fromKey } = req.body ?? {};
    const before = await loadMappings();
    const mappings = before.filter((m) => !(m.role === role && m.from_key === fromKey));
    if (mappings.length === before.length) return res.status(404).json({ error: 'NOT_FOUND', message: 'No such mapping' });
    await saveMappings(req, mappings, { op: 'remove', role, from_key: fromKey });
    res.json({ removed: 1, count: mappings.length });
  }));

  return router;
}
