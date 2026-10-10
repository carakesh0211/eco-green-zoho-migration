// Bulk mapping routes (branch workspace step 3 -> #/branches/:code/bulk-mapping).
//
//   GET  /api/books-reference                       any role: what Books lists are loaded
//   POST /api/books-reference                       operator|approver|admin: upload Books exports
//   GET  /api/branches/:code/mapping-proposals      any role in scope: unmapped sources + suggestions
//   GET  /api/branches/:code/mapping-sheet.csv      any role in scope: the sheet to fill in
//   POST /api/branches/:code/mapping-auto           operator|admin: DRAFT rules for confident matches
//   POST /api/branches/:code/mapping-sheet          operator|admin: filled sheet -> DRAFT rules
//
// Rules are only ever created as DRAFT here; approving them is POST /api/mappings/approve
// (approver|admin), which then re-applies the mapping in the background. Bot tokens may read
// but never write through these routes.
import express from 'express';
import { nowIso } from '../../core/ids.js';
import { currentRun } from '../../core/runs.js';
import { loadMappingRules } from '../../core/mapping.js';
import { parseBooksExport, buildReference, referenceSummary, saveReference, loadReference, BooksExportError } from '../../core/books_reference.js';
import { collectRunEntities, proposeForRun, sheetCsv, parseSheet, resolveSheet, autoRules, ruleDefaults, SheetError, CONFIDENT } from '../../core/bulk_mapping.js';
import { isBotUser } from './agent.js';

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const KINDS = new Set(['accounts', 'vendors', 'customers']);

function wrap(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function decode(b64, name) {
  if (typeof b64 !== 'string' || b64 === '') throw new BooksExportError(`${name}: empty file`);
  const buf = Buffer.from(b64, 'base64');
  if (buf.length === 0) throw new BooksExportError(`${name}: empty file`);
  if (buf.length > MAX_FILE_BYTES) throw new BooksExportError(`${name}: larger than ${MAX_FILE_BYTES / 1024 / 1024} MB`);
  return buf;
}

export function createBulkMappingRouter({ store, audit, auth, archive }) {
  const router = express.Router();

  const ctxFor = (req) => ({ store, audit, correlationId: req.correlationId, actor: req.user.id, actorRole: req.user.role });
  const noBots = (req, res, next) => {
    if (isBotUser(req.user)) return auth.deny(req, res, { status: 403, error: 'FORBIDDEN', reason: 'BOT_CEILING:bulk_mapping', message: 'Bot/agent tokens may not change mapping rules' });
    next();
  };
  const needArchive = (res) => {
    if (!archive) {
      res.status(501).json({ error: 'NOT_IMPLEMENTED', message: 'No archive is configured, so Books lists cannot be stored.' });
      return false;
    }
    return true;
  };

  /** The branch's current run, or a 4xx already sent (scope / no run). */
  async function branchRun(req, res) {
    const branch = req.params.code;
    if (!auth.branchAllowed(req.user, branch)) {
      auth.deny(req, res, { status: 403, error: 'FORBIDDEN', reason: `BRANCH_SCOPE:${branch}` });
      return null;
    }
    const runs = await store.find('extraction_runs', { branch_code: branch }, { orderBy: 'created_at DESC' });
    const run = await currentRun(store, runs);
    if (!run) {
      res.status(404).json({ error: 'NO_RUN', message: `No run has been imported for branch ${branch}` });
      return null;
    }
    return run;
  }

  async function proposalsFor(req, run) {
    const [entities, rules, reference] = await Promise.all([
      collectRunEntities(store, run.id),
      store.find('mapping_rules', {}),
      archive ? loadReference(ctxFor(req), { archive }) : null,
    ]);
    return { entities, rules, reference, rows: proposeForRun({ entities, reference, rules }) };
  }

  async function upsertDrafts(req, branch, ruleRows, how) {
    const result = ruleRows.length ? await loadMappingRules({ store }, ruleRows) : [];
    await audit.emit({
      actor: req.user.id, actorRole: req.user.role, action: 'MAPPING.BULK_UPSERT', entityType: 'mapping_rules', entityId: null,
      before: null, after: { branch, how, count: result.length, ids: result.map((r) => r.id) }, correlationId: req.correlationId, branchCode: branch,
    });
    return result;
  }

  // ---- Books reference lists ----
  router.get('/books-reference', auth.authenticate(), wrap(async (req, res) => {
    if (!archive) return res.json({ reference: null, archive: false });
    res.json({ reference: referenceSummary(await loadReference(ctxFor(req), { archive })), archive: true });
  }));

  router.post('/books-reference', auth.authenticate(), auth.requireCorrelationId(), noBots, auth.requireRole('operator', 'approver', 'admin'), wrap(async (req, res) => {
    if (!needArchive(res)) return;
    const files = Array.isArray(req.body?.files) ? req.body.files : [];
    if (files.length === 0) return res.status(400).json({ error: 'BAD_REQUEST', message: 'files must be a non-empty array of { name, kind, content }' });
    const parsed = [];
    const sources = [];
    try {
      for (const f of files) {
        const name = String(f?.name ?? 'file');
        const kind = KINDS.has(f?.kind) ? f.kind : undefined;
        const p = parseBooksExport(decode(f?.content, name), { fileName: name, kindHint: kind });
        parsed.push(p);
        sources.push({ name, kind: p.kind === 'accounts' ? 'accounts' : (p.contactType ? `${p.contactType}s` : 'contacts'), rows: (p.accounts ?? p.contacts).length });
      }
    } catch (err) {
      if (err instanceof BooksExportError) return res.status(400).json({ error: err.code, message: err.message });
      throw err;
    }
    const previous = await loadReference(ctxFor(req), { archive }).catch(() => null);
    // A partial upload (say, only the vendor list) keeps the other lists from the last upload.
    const keep = [];
    if (previous) {
      if (!parsed.some((p) => p.kind === 'accounts')) keep.push({ accounts: previous.accounts });
      const newTypes = new Set(parsed.filter((p) => p.kind === 'contacts').map((p) => p.contactType ?? '*'));
      if (!newTypes.has('*')) keep.push({ contacts: previous.contacts.filter((c) => !newTypes.has(c.contact_type)) });
    }
    const reference = buildReference([...keep, ...parsed], {
      uploadedBy: req.user.id, uploadedAt: nowIso(), booksOrgId: req.body?.books_org_id ?? previous?.books_org_id ?? null,
      sources: [...sources, ...(previous ? previous.sources.filter((s) => !sources.some((n) => n.kind === s.kind)) : [])],
    });
    if (reference.accounts.length === 0) return res.status(400).json({ error: 'BAD_BOOKS_EXPORT', message: 'No chart of accounts loaded yet: include the Chart of Accounts export.' });
    await saveReference(ctxFor(req), { archive, reference });
    res.json({ reference: referenceSummary(reference) });
  }));

  // ---- per-branch proposals and sheet ----
  router.get('/branches/:code/mapping-proposals', auth.authenticate(), wrap(async (req, res) => {
    const run = await branchRun(req, res);
    if (!run) return;
    const { rows, reference } = await proposalsFor(req, run);
    const counts = {};
    for (const r of rows) counts[r.match] = (counts[r.match] ?? 0) + 1;
    res.json({ run: { id: run.id, branch_code: run.branch_code }, reference: referenceSummary(reference), counts, confident: rows.filter((r) => CONFIDENT.has(r.match)).length, rows });
  }));

  router.get('/branches/:code/mapping-sheet.csv', auth.authenticate(), wrap(async (req, res) => {
    const run = await branchRun(req, res);
    if (!run) return;
    const { rows } = await proposalsFor(req, run);
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="mapping-sheet-${run.branch_code}.csv"`);
    res.send(sheetCsv(rows));
  }));

  router.post('/branches/:code/mapping-auto', auth.authenticate(), auth.requireCorrelationId(), noBots, auth.requireRole('operator', 'admin'), wrap(async (req, res) => {
    const run = await branchRun(req, res);
    if (!run) return;
    const { rows, rules, reference } = await proposalsFor(req, run);
    if (!reference) return res.status(409).json({ error: 'NO_BOOKS_REFERENCE', message: 'Upload the Zoho Books lists first.' });
    const created = await upsertDrafts(req, run.branch_code, autoRules(rows, ruleDefaults(rules, run)), 'auto');
    res.json({ created: created.length, ids: created.map((r) => r.id), rules: created });
  }));

  router.post('/branches/:code/mapping-sheet', auth.authenticate(), auth.requireCorrelationId(), noBots, auth.requireRole('operator', 'admin'), wrap(async (req, res) => {
    const run = await branchRun(req, res);
    if (!run) return;
    let sheetRows;
    try {
      sheetRows = parseSheet(decode(req.body?.content, String(req.body?.name ?? 'sheet')));
    } catch (err) {
      if (err instanceof SheetError || err instanceof BooksExportError) return res.status(400).json({ error: 'BAD_SHEET', message: err.message });
      throw err;
    }
    const [entities, rules, reference] = await Promise.all([
      collectRunEntities(store, run.id), store.find('mapping_rules', {}), archive ? loadReference(ctxFor(req), { archive }) : null,
    ]);
    if (!reference) return res.status(409).json({ error: 'NO_BOOKS_REFERENCE', message: 'Upload the Zoho Books lists first.' });
    const { rules: ruleRows, results } = resolveSheet(sheetRows, { entities, reference, rules, ...ruleDefaults(rules, run) });
    const created = await upsertDrafts(req, run.branch_code, ruleRows, 'sheet');
    const outcomes = {};
    for (const r of results) outcomes[r.outcome] = (outcomes[r.outcome] ?? 0) + 1;
    res.json({ created: created.length, ids: created.map((r) => r.id), outcomes, results });
  }));

  return router;
}
