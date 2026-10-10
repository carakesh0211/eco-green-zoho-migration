// Zoho Books reference lists (chart of accounts, vendors, customers) uploaded as the files
// Books exports, so the console can propose and resolve mapping targets by NAME: a reviewer
// never has to type a Books id.
//
// parseBooksExport(): one exported file (CSV or XLSX) -> { kind, accounts | contacts }.
//   The header row is matched loosely (case, spaces, underscores ignored) so the Books
//   export, a hand-made sheet or the build-mapping accounts.json columns all work. Ids are
//   kept as exact strings (19-digit Books ids do not survive a JS Number).
// buildReference(): merge several parsed files into one reference document.
// saveReference()/loadReference(): the document is stored as a JSON object in the archive
//   (Stratus) and the newest one is found through its audit event, so no new table is needed.
import { parseCsv } from './csv.js';
import { readXlsx } from '../sources/ecogreen/xlsx.js';
import { sha256Bytes } from './hash.js';

export class BooksExportError extends Error {
  constructor(message) {
    super(message);
    this.code = 'BAD_BOOKS_EXPORT';
  }
}

const key = (h) => String(h ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Accepted header names per field (compared after key()).
const ACCOUNT_COLS = {
  id: ['accountid', 'id'],
  name: ['accountname', 'name'],
  code: ['accountcode', 'code'],
  type: ['accounttype', 'type'],
  parentId: ['parentaccountid', 'parentid'],
  parentName: ['parentaccount', 'parentaccountname', 'parentname'],
  status: ['accountstatus', 'status', 'isactive', 'active'],
};
const CONTACT_COLS = {
  id: ['contactid', 'customerid', 'vendorid', 'id'],
  name: ['displayname', 'contactname', 'customername', 'vendorname', 'name'],
  company: ['companyname'],
  type: ['contacttype', 'type'],
  status: ['status', 'contactstatus'],
};

function pick(header, aliases) {
  const keys = header.map(key);
  for (const a of aliases) {
    const i = keys.indexOf(a);
    if (i !== -1) return i;
  }
  return -1;
}

function cell(row, i) {
  if (i < 0) return '';
  const v = row[i];
  return v === null || v === undefined ? '' : String(v).trim();
}

function isActive(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (s === '') return true;
  return ['active', 'true', 'yes', '1'].includes(s);
}

/** Rows (arrays) of the first non-empty sheet / the CSV, with the header row first. */
function readTable(bytes) {
  const isZip = bytes.length > 2 && bytes[0] === 0x50 && bytes[1] === 0x4b;
  if (isZip) {
    let wb;
    try { wb = readXlsx(bytes, { rawNumbers: true }); } catch (e) { throw new BooksExportError(`Excel file could not be read: ${e.message}`); }
    const sheet = wb.sheets.find((s) => s.rows.some((r) => r.some((c) => c !== null && c !== '')));
    if (!sheet) throw new BooksExportError('the Excel file has no data');
    return sheet.rows.filter((r) => r.some((c) => c !== null && c !== ''));
  }
  let text = bytes.toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const { header, rows } = parseCsv(text);
  return [header, ...rows];
}

/**
 * kindHint: 'accounts' | 'vendors' | 'customers' | undefined (detected from the headers /
 * file name). -> { kind: 'accounts', accounts } or { kind: 'contacts', contactType, contacts }.
 */
export function parseBooksExport(bytes, { fileName = '', kindHint } = {}) {
  const table = readTable(bytes);
  const header = (table[0] ?? []).map((h) => String(h ?? '').trim());
  const rows = table.slice(1);
  const keys = header.map(key);
  const lowerName = String(fileName).toLowerCase();

  const looksAccounts = keys.includes('accountname') && !keys.includes('displayname') && !keys.includes('contactname');
  const kind = kindHint === 'accounts' || (!kindHint && looksAccounts) ? 'accounts' : 'contacts';

  if (kind === 'accounts') {
    const col = Object.fromEntries(Object.entries(ACCOUNT_COLS).map(([f, a]) => [f, pick(header, a)]));
    if (col.id < 0 || col.name < 0) {
      throw new BooksExportError(`${fileName || 'chart of accounts'}: needs an "Account ID" and an "Account Name" column (found: ${header.join(', ')})`);
    }
    const accounts = rows
      .map((r) => ({
        account_id: cell(r, col.id), account_name: cell(r, col.name), account_code: cell(r, col.code),
        account_type: cell(r, col.type), parent_account_id: cell(r, col.parentId), parent_account_name: cell(r, col.parentName),
        is_active: isActive(cell(r, col.status)),
      }))
      .filter((a) => a.account_id && a.account_name);
    // Parent ids from parent names when the export only names the parent.
    const idByName = new Map(accounts.map((a) => [a.account_name.toLowerCase(), a.account_id]));
    for (const a of accounts) {
      if (!a.parent_account_id && a.parent_account_name) a.parent_account_id = idByName.get(a.parent_account_name.toLowerCase()) ?? '';
    }
    return { kind, accounts };
  }

  const col = Object.fromEntries(Object.entries(CONTACT_COLS).map(([f, a]) => [f, pick(header, a)]));
  if (col.id < 0 || (col.name < 0 && col.company < 0)) {
    throw new BooksExportError(`${fileName || 'contacts'}: needs a "Contact ID" and a "Display Name" (or "Contact Name") column (found: ${header.join(', ')})`);
  }
  let contactType = kindHint === 'vendors' ? 'vendor' : kindHint === 'customers' ? 'customer' : null;
  if (!contactType && /vendor|supplier/.test(lowerName)) contactType = 'vendor';
  if (!contactType && /customer/.test(lowerName)) contactType = 'customer';
  const contacts = rows
    .map((r) => {
      const name = cell(r, col.name) || cell(r, col.company);
      const rowType = cell(r, col.type).toLowerCase();
      return {
        contact_id: cell(r, col.id), contact_name: name, company_name: cell(r, col.company),
        contact_type: rowType.includes('vendor') ? 'vendor' : rowType.includes('customer') ? 'customer' : (contactType ?? ''),
        status: isActive(cell(r, col.status)) ? 'active' : 'inactive',
      };
    })
    .filter((c) => c.contact_id && c.contact_name);
  return { kind, contactType, contacts };
}

/** Merge parsed files. Later files win on a repeated id. */
export function buildReference(parsed, { uploadedBy, uploadedAt, booksOrgId = null, sources = [] }) {
  const accounts = new Map();
  const contacts = new Map();
  for (const p of parsed) {
    for (const a of p.accounts ?? []) accounts.set(a.account_id, a);
    for (const c of p.contacts ?? []) contacts.set(c.contact_id, c);
  }
  return {
    version: 1, uploaded_at: uploadedAt, uploaded_by: uploadedBy, books_org_id: booksOrgId, sources,
    accounts: [...accounts.values()], contacts: [...contacts.values()],
  };
}

export function referenceSummary(ref) {
  if (!ref) return null;
  return {
    uploaded_at: ref.uploaded_at, uploaded_by: ref.uploaded_by, books_org_id: ref.books_org_id, sources: ref.sources,
    accounts: ref.accounts.length,
    active_accounts: ref.accounts.filter((a) => a.is_active).length,
    vendors: ref.contacts.filter((c) => c.contact_type === 'vendor').length,
    customers: ref.contacts.filter((c) => c.contact_type === 'customer').length,
    contacts: ref.contacts.length,
  };
}

const REF_RUN = 'books-reference';
const REF_BRANCH = '_books';
const AUDIT_ACTION = 'BOOKS_REFERENCE.UPLOAD';

/** Store the document in the archive and record it (audit) as the current reference. */
export async function saveReference(ctx, { archive, reference }) {
  const bytes = Buffer.from(JSON.stringify(reference), 'utf8');
  const stamp = reference.uploaded_at.replace(/[^0-9]/g, '');
  const uri = await archive.put({ runId: REF_RUN, branchCode: REF_BRANCH, fileName: `reference-${stamp}.json`, bytes, sha256: sha256Bytes(bytes) });
  await ctx.audit.emit({
    actor: ctx.actor, actorRole: ctx.actorRole, action: AUDIT_ACTION, entityType: 'books_reference', entityId: null,
    before: null, after: { uri, ...referenceSummary(reference) }, correlationId: ctx.correlationId,
  });
  return uri;
}

const cache = new Map();

/** The newest stored reference, or null. Cached per archive URI. */
export async function loadReference(ctx, { archive }) {
  const events = await ctx.store.find('audit_events', { action: AUDIT_ACTION }, { orderBy: 'created_at DESC', limit: 1 });
  const ev = events[0];
  if (!ev) return null;
  let after = {};
  try { after = JSON.parse(ev.after_json ?? '{}'); } catch { return null; }
  if (!after.uri) return null;
  if (cache.has(after.uri)) return cache.get(after.uri);
  const bytes = await archive.get(after.uri);
  const ref = JSON.parse(bytes.toString('utf8'));
  cache.set(after.uri, ref);
  return ref;
}
