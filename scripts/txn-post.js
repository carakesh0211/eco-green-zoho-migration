#!/usr/bin/env node
// Post a branch's planned transactions (scripts/txn-plan.js) to Zoho Books.
//
//   node scripts/txn-post.js preflight --out var/txn/460 --account-map var/txn/460/accounts_zoho.csv \
//     --opening var/opening/460 --clearing-account-id <cash clearing account id> [--contacts contacts.json]
//     [--contact-controls skip]   (test organisation only: do not require contacts to carry their group's account)
//     [--doc-numbers docs.csv]    ("doc,party,books_number" for documents not numbered by convention)
//     [--allow-missing-docs]      (leave amounts for opening documents not in Books as advances)
//     [--location <id>]           (the branch's Books location; required when the opening was made in another organisation)
//     [--tax-exemption-id <id>]   (bill lines; otherwise the organisation's one exemption named OPENING)
//   node scripts/txn-post.js post  --out var/txn/460 --confirm-org <organisation id> [--only bill,journal,receipt,payment,credit] [--per-kind 1]
//   node scripts/txn-post.js apply --out var/txn/460 --confirm-org <organisation id> [--limit 1]
//
// Documents payments are applied to are found by number: Smart Pharma's convention
// <branch>/<yy>/<prefix>/<000000>, the opening's own number, or --doc-numbers. post applies every
// receipt / payment to those already in Books; what is left waits as unused credit, and apply adds
// it once the documents are in Books (e.g. Smart Pharma's pushed later), then makes the pending
// credit / debit note set-offs.
// Each voucher carries the reference <branch>/<yy>/<prefix>/<000000>; anything already in Books
// under it is not posted again, so a stopped run is simply run again.
// Posting needs the application's guard (live driver, POSTING_ENABLED, authorization reference),
// BOOKS_ORG_ALLOWLIST naming only the target organisation, and --confirm-org with its id.
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, openSync, closeSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseCsv } from '../src/core/csv.js';
import { formatMoney } from '../src/core/money.js';
import { loadBooksConfig, assertPostingAllowed } from '../src/books/guard.js';
import {
  UnknownOutcome, DailyLimit, RateBlocked, RATE_PER_MINUTE, progress, booksClient, liveConfig,
} from '../src/books/rest.js';
import { pickAccount } from '../src/opening/books_docs.js';
import { refKey, toPaise, INTER_BRANCH_CONTACT } from '../src/txn/plan.js';
import {
  voucherRequests, creditRequests, splitApplications, booksNumber, TxnPostError, assertBranchPosting,
} from '../src/txn/books.js';

function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const opts = {};
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    if (!a.startsWith('--')) throw new Error(`unexpected argument ${a}`);
    opts[a.slice(2)] = rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[++i] : 'true';
  }
  return { cmd, opts };
}
const need = (o, k) => {
  if (!o[k]) throw new Error(`--${k} is required`);
  return o[k];
};
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const csvCell = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const toCsv = (header, rows) => [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\n') + '\n';
const normName = (s) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

const DOC_MODULES = [
  { kind: 'invoice', path: 'invoices', list: 'invoices', id: 'invoice_id', number: 'invoice_number' },
  { kind: 'credit_note', path: 'creditnotes', list: 'creditnotes', id: 'creditnote_id', number: 'creditnote_number' },
  { kind: 'bill', path: 'bills', list: 'bills', id: 'bill_id', number: 'bill_number' },
  { kind: 'vendor_credit', path: 'vendorcredits', list: 'vendor_credits', id: 'vendor_credit_id', number: 'vendor_credit_number' },
];
// Our vouchers in Books, found by reference (bills by number).
const VOUCHER_MODULES = {
  bills: { list: 'bills', id: 'bill_id', ref: 'bill_number', sort: 'bill_number' },
  journals: { list: 'journals', id: 'journal_id', ref: 'reference_number', sort: 'journal_date' },
  customerpayments: { list: 'customerpayments', id: 'payment_id', ref: 'reference_number', sort: 'date' },
  vendorpayments: { list: 'vendorpayments', id: 'payment_id', ref: 'reference_number', sort: 'date' },
};

function readAccountMap(path) {
  const { header, rows } = parseCsv(readFileSync(path, 'utf8'));
  const h = header.map((x) => x.trim().toLowerCase());
  const a = h.indexOf('account');
  const z = h.indexOf('zoho_code');
  if (a < 0 || z < 0) throw new Error(`${path}: needs "account" and "zoho_code" columns`);
  return Object.fromEntries(rows.filter((r) => r[z]?.trim()).map((r) => [r[a].trim(), r[z].trim()]));
}

/** Parties our postings touch: key -> { side, code, name }. */
function partiesOf(plan, openingDocs) {
  const out = new Map();
  const add = (side, code, name, control, journal) => {
    const p = out.get(`${side}:${code}`) ?? { side, code, name, control, journal: false };
    p.journal ||= journal;
    out.set(`${side}:${code}`, p);
  };
  for (const p of plan.postings) {
    if (p.party) add(p.party.side, p.party.code, p.party.name, p.party.control, false);
    for (const l of p.lines ?? []) if (l.party) add(l.party, l.code, l.name, l.control, true);
    if ([...(p.lines ?? []), ...(p.offset ?? [])].some((l) => l.contact === INTER_BRANCH_CONTACT)) {
      const ho = openingDocs.find((d) => d.partyCode === INTER_BRANCH_CONTACT);
      add('customer', INTER_BRANCH_CONTACT, ho?.partyName ?? 'Frankross Admin - Kolkata', '002000', false);
    }
  }
  return out;
}

/** Plan document key ("25/T/5960" or "OPENING/H9") + party -> opening document (number, kind). */
function openingIndex(openingDocs) {
  const idx = new Map();
  for (const d of openingDocs) {
    const key = /^OPENING BALANCE/i.test(String(d.sourceRef).trim()) ? `OPENING/${d.partyCode}` : refKey(d.sourceRef);
    if (key) idx.set(`${key}|${d.partyCode}`, d);
  }
  return idx;
}

// ---- preflight ---------------------------------------------------------------------------------

async function cmdPreflight(o) {
  const out = need(o, 'out');
  const plan = readJson(join(out, 'plan.json'));
  if (plan.checks.some((c) => !c.ok)) throw new TxnPostError('the plan has failed checks; fix and re-plan first');
  const openingDir = need(o, 'opening');
  const opening = readJson(join(openingDir, 'plan.json'));
  const openingRes = existsSync(join(openingDir, 'resolution.json')) ? readJson(join(openingDir, 'resolution.json')) : {};
  const config = liveConfig();
  const books = booksClient(config);
  const problems = [];
  const notes = [];
  // the opening's contacts / tax exemption are reused only when made for this organisation
  const sameOrg = String(openingRes.organizationId ?? '') === String(config.organizationId);
  if (Object.keys(openingRes).length && !sameOrg) notes.push(`Opening resolution was made for organisation ${openingRes.organizationId ?? '?'}; its contacts are not reused here`);
  const reuse = sameOrg ? openingRes : {};
  const res = {
    organizationId: config.organizationId, branch: plan.branch,
    // the opening plan's location belongs to the organisation its resolution was made for
    locationId: o.location ?? (Object.keys(openingRes).length && !sameOrg ? null : opening.locationId),
    clearingAccountId: o['clearing-account-id'] ?? null, taxExemptionId: o['tax-exemption-id'] ?? reuse.taxExemptionId ?? null,
    accountMap: readAccountMap(need(o, 'account-map')), accounts: {}, contacts: { ...(reuse.contacts ?? {}) },
    gstTreatment: { ...(reuse.gstTreatment ?? {}) }, controls: {}, docs: {},
  };
  progress(`preflight: organisation ${config.organizationId}, ${plan.postings.length} vouchers (about ${RATE_PER_MINUTE} calls a minute)`);
  if (!res.locationId) problems.push(`pass --location: the opening's location ${opening.locationId} belongs to organisation ${openingRes.organizationId}`);
  else {
    const loc = (await books.listAll('/locations', 'locations')).find((l) => String(l.location_id) === String(res.locationId));
    if (!loc) problems.push(`location ${res.locationId} not found in organisation ${config.organizationId} (--location)`);
    else notes.push(`Location: ${loc.location_name} (${res.locationId})`);
  }

  // Accounts: every mapped ledger, the party controls, the clearing account.
  const accountsWhere = async (query) => (await books.call('GET', '/chartofaccounts', { query: { filter_by: 'AccountType.All', ...query } })).chartofaccounts ?? [];
  // Journal party lines post to the party's own control: its Eco Green ledger group (e.g. 001005
  // Sundry Creditors-Expenses) -> the Zoho account the opening used for that group (--control-map
  // adds groups the opening did not have, {"002013": "<zoho code>"}).
  const groupZoho = new Map(opening.documents.map((d) => [d.controlCode, d.controlZoho]));
  for (const [g, z] of Object.entries(o['control-map'] ? readJson(o['control-map']) : {})) groupZoho.set(g, z);
  const parties = partiesOf(plan, opening.documents);
  const codes = new Set([...plan.accounts.map((a) => res.accountMap[a.account]).filter(Boolean)]);
  for (const a of plan.accounts) if (!res.accountMap[a.account]) problems.push(`ledger ${a.account} ${a.name} has no Zoho code in the account map`);
  // Production contacts carry their group's receivable / payable account, so documents and payments
  // land on it; preflight checks that (--contact-controls skip for the test organisation).
  const checkContacts = (o['contact-controls'] ?? 'check') !== 'skip';
  const partyControl = new Map();
  for (const [key, p] of parties) {
    if (!p.journal && !checkContacts) continue; // payments and bills take the contact's own account
    const c = groupZoho.get(p.control);
    if (!c) { problems.push(`${key} ${p.name}: ledger group ${p.control || '(none)'} has no Zoho control account (--control-map)`); continue; }
    partyControl.set(key, c);
    codes.add(c);
  }
  progress(`accounts: ${codes.size}…`);
  for (const code of codes) {
    const { account: a, problem } = pickAccount(code, await accountsWhere({ account_code: code }));
    if (problem) { problems.push(problem); continue; }
    res.accounts[code] = { account_id: String(a.account_id), type: a.account_type, name: a.account_name };
  }
  for (const [key, code] of partyControl) {
    const a = res.accounts[code];
    if (!a) continue;
    if (!/^accounts_(receivable|payable)$/.test(a.type)) problems.push(`control ${code} ${a.name} for ${key} is ${a.type}, not a receivable / payable account`);
    if (parties.get(key).journal) res.controls[key] = a.account_id;
  }
  if (!res.clearingAccountId) problems.push('pass --clearing-account-id (Opening Advances Clearing)');
  else {
    const c = (await accountsWhere({ account_id: res.clearingAccountId })).find((a) => String(a.account_id) === res.clearingAccountId);
    if (!c) problems.push(`clearing account ${res.clearingAccountId} not found`);
    else if (!/^(cash|bank)$/.test(c.account_type)) problems.push(`clearing account ${c.account_name} is ${c.account_type}; Books deposits to / pays from cash or bank only`);
    else notes.push(`Clearing account: ${c.account_name} (${c.account_type})`);
  }
  const direct = Object.values(res.accounts).filter((a) => /^(cash|bank)$/.test(a.type)).map((a) => a.name);
  notes.push(`Cash / bank accounts receipts and payments can use directly: ${direct.join(', ') || 'none'}`);

  // Contacts: opening resolution, overrides, then an exact name match of the right type.
  const overrides = o.contacts ? readJson(o.contacts) : {};
  Object.assign(res.contacts, overrides);
  const unresolved = [];
  const wrongControl = [];
  const billVendors = new Set(plan.postings.filter((p) => p.kind === 'bill').map((p) => `vendor:${p.party.code}`));
  progress(`contacts: ${parties.size}…`);
  for (const [key, p] of parties) {
    if (!res.contacts[key]) {
      const hits = (await books.listAll('/contacts', 'contacts', { contact_type: p.side, contact_name_contains: p.name.slice(0, 40) }))
        .filter((c) => normName(c.contact_name) === normName(p.name) || normName(c.company_name) === normName(p.name));
      if (hits.length === 1) { res.contacts[key] = String(hits[0].contact_id); res.gstTreatment[key] = hits[0].gst_treatment ?? null; } else unresolved.push([key, p.name, hits.length, hits.map((c) => `${c.contact_id}:${c.contact_name}`).join(' | ')]);
    }
    const want = res.accounts[partyControl.get(key)];
    if (res.contacts[key] && ((checkContacts && want) || (billVendors.has(key) && !(key in res.gstTreatment)))) {
      const c = (await books.call('GET', `/contacts/${res.contacts[key]}`)).contact ?? {};
      if (!(key in res.gstTreatment)) res.gstTreatment[key] = c.gst_treatment ?? null;
      if (checkContacts && want && String(c.account_id ?? '') !== want.account_id) {
        wrongControl.push([key, p.name, p.control, `${partyControl.get(key)} ${want.name}`, c.account_name || '(none)']);
      }
    }
  }
  if (wrongControl.length) {
    problems.push(`${wrongControl.length} contacts do not carry their Eco Green group's receivable / payable account — see contact-controls.csv (documents and payments would land on the wrong control)`);
    writeFileSync(join(out, 'contact-controls.csv'), toCsv(['Key', 'Party', 'Eco Green group', 'Expected account', 'Contact has'], wrongControl));
  } else if (checkContacts) notes.push('Every contact carries its Eco Green group\'s receivable / payable account');
  if (unresolved.length) {
    problems.push(`${unresolved.length} parties have no single Books contact — fill contacts-to-map.csv into a --contacts JSON file ({"customer:H1": "<contact id>"})`);
    writeFileSync(join(out, 'contacts-to-map.csv'), toCsv(['Key', 'Eco Green name', 'Matches', 'Candidates'], unresolved));
  }
  if (billVendors.size && !res.taxExemptionId) {
    // as the opening did: the organisation's one exemption named OPENING
    const exemptions = (await books.call('GET', '/settings/taxexemptions')).tax_exemptions ?? [];
    const hits = exemptions.filter((t) => /OPENING/i.test(`${t.tax_exemption_code} ${t.description ?? ''}`));
    if (hits.length === 1) {
      res.taxExemptionId = String(hits[0].tax_exemption_id);
      notes.push(`Tax exemption on bill lines: ${hits[0].tax_exemption_code} (${res.taxExemptionId})`);
    } else problems.push(`bills need a tax exemption id (--tax-exemption-id); available: ${exemptions.map((t) => `${t.tax_exemption_code} ${t.tax_exemption_id}`).join(', ') || 'none'}`);
  }

  // Documents the payments are applied to: opening items and Smart Pharma's documents, found by
  // number (Smart Pharma's convention <branch>/<yy>/<prefix>/<000000>, the opening's own number,
  // or --doc-numbers "key,party,books_number" overrides), on the party's own contact.
  const idx = openingIndex(opening.documents);
  const docNumbers = new Map();
  if (o['doc-numbers']) {
    const { rows } = parseCsv(readFileSync(o['doc-numbers'], 'utf8'));
    for (const [key, party, number] of rows) if (number?.trim()) docNumbers.set(`${key.trim()}|${party.trim()}`, number.trim());
  }
  const wanted = new Map(); // "doc|party" -> { kind, side, source, numbers: [] }
  const want = (doc, party, side, kind, source) => {
    const k = `${doc}|${party}`;
    if (wanted.has(k) || source === 'ours') return;
    const conv = /^\d{2}\/[^/]+\/-?\d+$/.test(doc);
    // live bills / vendor credits carry the plain Eco Green number (e.g. 40514)
    const plain = conv && (kind === 'bill' || kind === 'vendor_credit') ? String(Number(doc.split('/')[2])) : null;
    const numbers = [docNumbers.get(k), idx.get(k)?.number, conv ? booksNumber(plan.branch, doc) : null, plain].filter(Boolean);
    wanted.set(k, { kind, side, source, numbers: [...new Set(numbers)] });
  };
  for (const p of plan.postings) {
    for (const a of p.applications ?? []) want(a.doc, a.party, p.party.side, p.kind === 'receipt' ? 'invoice' : 'bill', a.source);
  }
  for (const c of plan.creditApplications ?? []) {
    const side = c.side ?? (idx.get(`${c.credit}|${c.party}`)?.side) ?? 'vendor';
    want(c.credit, c.party, side, side === 'vendor' ? 'vendor_credit' : 'credit_note', c.creditSource);
    want(c.doc, c.party, side, side === 'vendor' ? 'bill' : 'invoice', idx.has(`${c.doc}|${c.party}`) ? 'opening' : 'smartpharma');
  }
  const kinds = new Set([...wanted.values()].map((w) => w.kind));
  for (const m of DOC_MODULES.filter((x) => kinds.has(x.kind))) {
    progress(`${m.path}: looking up ${[...wanted.values()].filter((w) => w.kind === m.kind).length} documents…`);
    const rows = await books.listAll(`/${m.path}`, m.list, { [`${m.number}_startswith`]: `${plan.branch}/`, sort_column: m.number, sort_order: 'A' }, m.id);
    const byNumber = new Map();
    for (const r of rows) byNumber.set(String(r[m.number]), [...(byNumber.get(String(r[m.number])) ?? []), r]);
    for (const [k, w] of wanted) {
      if (w.kind !== m.kind) continue;
      const contact = res.contacts[`${w.side}:${k.split('|')[1]}`];
      for (const n of w.numbers) {
        const hits = (byNumber.get(n) ?? []).filter((r) => !contact || String(r.customer_id ?? r.vendor_id ?? contact) === contact);
        if (hits.length === 1) { res.docs[k] = { module: m.path, id: String(hits[0][m.id]), number: n }; break; }
      }
    }
  }
  // not in the branch-prefixed lists (e.g. plain-numbered bills, opening documents uploaded by hand):
  // the party's own documents, matched on number or reference#. One listing per contact; the open
  // ones of a party still unmatched go to document-candidates.csv to name them with --doc-numbers.
  const byKind = Object.fromEntries(DOC_MODULES.map((m) => [m.kind, m]));
  const outsidePrefix = (w) => w.numbers.filter((n) => !n.startsWith(`${plan.branch}/`));
  const pending = [...wanted].filter(([k, w]) => !res.docs[k] && (w.source === 'opening' || outsidePrefix(w).length));
  const contactDocs = new Map(); // "module|contact" -> rows
  if (pending.length) progress(`party lookups for ${pending.length} documents…`);
  const candidates = [];
  for (const [k, w] of pending) {
    const m = byKind[w.kind];
    const contact = res.contacts[`${w.side}:${k.split('|')[1]}`];
    if (!contact) continue;
    const contactField = w.side === 'vendor' ? 'vendor_id' : 'customer_id';
    const ck = `${m.path}|${contact}`;
    if (!contactDocs.has(ck)) contactDocs.set(ck, await books.listAll(`/${m.path}`, m.list, { [contactField]: contact }, m.id));
    const rows = contactDocs.get(ck).filter((r) => String(r[contactField] ?? contact) === contact);
    const same = (a, b) => String(a ?? '').trim().toUpperCase() === String(b).trim().toUpperCase();
    for (const n of w.numbers) {
      const hits = rows.filter((r) => same(r[m.number], n) || same(r.reference_number, n));
      if (hits.length === 1) { res.docs[k] = { module: m.path, id: String(hits[0][m.id]), number: String(hits[0][m.number]) }; break; }
    }
    if (!res.docs[k] && w.source === 'opening') {
      for (const r of rows.filter((x) => Number(x.balance ?? 0) > 0)) candidates.push([k.split('|')[0], k.split('|')[1], r[m.number], r.reference_number ?? '', r.date, r.total, r.balance]);
    }
  }
  if (candidates.length) writeFileSync(join(out, 'document-candidates.csv'), toCsv(['doc', 'party', 'books_number', 'reference', 'date', 'total', 'balance'], candidates));
  const missing = [...wanted].filter(([k]) => !res.docs[k]);
  writeFileSync(join(out, 'documents-not-found.csv'), toCsv(['doc', 'party', 'source', 'numbers_tried'], missing.map(([k, w]) => [...k.split('|'), w.source, w.numbers.join(' ')])));
  const missingOpening = missing.filter(([, w]) => w.source === 'opening');
  if (missingOpening.length && o['allow-missing-docs'] !== 'true') problems.push(`${missingOpening.length} opening documents to apply to are not in Books (documents-not-found.csv; --doc-numbers to name them, or --allow-missing-docs to leave those amounts as advances)`);
  const found = (src) => [...wanted].filter(([k, w]) => w.source === src && res.docs[k]).length;
  const total = (src) => [...wanted.values()].filter((w) => w.source === src).length;
  notes.push(`Documents to apply to: opening ${found('opening')}/${total('opening')}, Smart Pharma ${found('smartpharma')}/${total('smartpharma')} (not yet in Books: applied later with "apply")`);
  const waiting = plan.postings.flatMap((p) => (p.applications ?? []).filter((a) => a.source !== 'ours' && !res.docs[`${a.doc}|${a.party}`]));
  notes.push(`Applications waiting for documents not yet in Books: ${waiting.length}, ${formatMoney(waiting.reduce((t, a) => t + toPaise(a.amount), 0n))}`);

  progress(`preflight done: ${books.usage.calls} Books calls${books.usage.remaining !== null ? `, ${books.usage.remaining} left today` : ''}`);
  if (books.usage.remaining !== null) notes.push(`Books API calls left today: ${books.usage.remaining} of ${books.usage.limit ?? '?'}`);
  res.problems = problems;
  writeFileSync(join(out, 'resolution.json'), JSON.stringify(res, null, 2));
  const md = [`# Branch ${plan.branch} — transaction preflight (${new Date().toISOString().slice(0, 10)})`, '', `Organisation ${config.organizationId}, location ${res.locationId}`, '',
    '## Resolved', '', ...notes.map((n) => `- ${n}`), `- Accounts: ${Object.keys(res.accounts).length}/${codes.size}`, `- Contacts: ${[...parties.keys()].filter((k) => res.contacts[k]).length}/${parties.size}`,
    `- Documents to apply to found in Books: ${Object.keys(res.docs).length}/${wanted.size}`, '', '## Problems', '', ...(problems.length ? problems.map((p) => `- ${p}`) : ['- none — ready for the smoke test']), ''].join('\n');
  writeFileSync(join(out, 'preflight.md'), md);
  console.log(md);
  return problems.length ? 1 : 0;
}

// ---- post --------------------------------------------------------------------------------------

const KIND_ORDER = ['bill', 'journal', 'receipt', 'payment'];

async function cmdPost(o) {
  const out = need(o, 'out');
  const plan = readJson(join(out, 'plan.json'));
  const res = readJson(join(out, 'resolution.json'));
  const config = loadBooksConfig(process.env);
  assertBranchPosting(config, o['confirm-org'], assertPostingAllowed);
  if (res.organizationId !== config.organizationId) throw new TxnPostError('resolution.json was made for another organisation; rerun preflight');
  if (res.problems?.length) throw new TxnPostError(`preflight has ${res.problems.length} open problems; rerun preflight once they are fixed`);
  if (plan.checks.some((c) => !c.ok)) throw new TxnPostError('the plan has failed checks');

  const only = (o.only ?? [...KIND_ORDER, 'credit'].join(',')).split(',');
  const perKind = o['per-kind'] ? Number(o['per-kind']) : Infinity;
  const maxFailures = Number(o['max-failures'] ?? 5);
  const books = booksClient(config);
  const logPath = join(out, 'post-log.jsonl');
  const log = (e) => appendFileSync(logPath, JSON.stringify({ at: new Date().toISOString(), ...e }) + '\n');
  const lockPath = join(out, 'post.lock');
  let lock;
  try { lock = openSync(lockPath, 'wx'); } catch { throw new TxnPostError(`${lockPath} exists: another post is running (delete it only if none is)`); }
  const counts = { posted: 0, found: 0, failed: 0 };
  const prefix = `${plan.branch}/`;
  const existing = {};
  const loadExisting = async (module) => {
    if (existing[module]) return existing[module];
    const m = VOUCHER_MODULES[module];
    const rows = await books.listAll(`/${module}`, m.list, { [`${m.ref}_startswith`]: prefix, sort_column: m.sort, sort_order: 'A' }, m.id);
    existing[module] = new Map(rows.filter((r) => String(r[m.ref] ?? '').startsWith(prefix)).map((r) => [String(r[m.ref]), r]));
    return existing[module];
  };
  try {
    // our bills: once in Books they are documents payments are applied to
    for (const p of plan.postings.filter((x) => x.kind === 'bill')) {
      const hit = (await loadExisting('bills')).get(booksNumber(plan.branch, p.key));
      if (hit) res.docs[`${p.key}|${p.party.code}`] = { module: 'bills', id: String(hit.bill_id) };
    }
    for (const kind of KIND_ORDER) {
      if (!only.includes(kind)) continue;
      const todo = plan.postings.filter((p) => p.kind === kind).slice(0, perKind);
      if (!todo.length) continue;
      console.log(`${kind}: ${todo.length} vouchers`);
      let failures = 0;
      for (const p of todo) {
        let requests;
        try { requests = voucherRequests(p, res, plan.branch); } catch (err) {
          log({ key: p.key, status: 'FAILED', error: err.message });
          console.log(`  FAILED ${p.key}: ${err.message}`);
          counts.failed += 1;
          if (++failures >= maxFailures) throw new TxnPostError(`${failures} ${kind} failures; stopping — see ${logPath}`);
          continue;
        }
        for (const r of requests) {
          const m = VOUCHER_MODULES[r.module];
          const ref = r.body[m.ref];
          const have = (await loadExisting(r.module)).get(ref);
          let id = have ? String(have[m.id]) : null;
          if (have) counts.found += 1;
          else {
            try {
              const j = await books.call('POST', `/${r.module}`, { query: r.module === 'bills' ? { ignore_auto_number_generation: 'true' } : {}, body: r.body });
              const rec = Object.values(j).find((v) => v && typeof v === 'object' && v[m.id]);
              if (!rec) throw new UnknownOutcome(`${p.key} ${r.part}: Books answered without a ${m.id}`);
              id = String(rec[m.id]);
              existing[r.module].set(ref, rec);
              if (r.module === 'bills' && rec.status === 'draft') await books.call('POST', `/bills/${id}/status/open`);
              log({ key: p.key, part: r.part, status: 'POSTED', id, module: r.module });
              counts.posted += 1;
            } catch (err) {
              if (err instanceof UnknownOutcome || err instanceof DailyLimit || err instanceof RateBlocked) {
                log({ key: p.key, part: r.part, status: err instanceof UnknownOutcome ? 'UNKNOWN' : 'NOT_SENT', error: err.message });
                throw err;
              }
              log({ key: p.key, part: r.part, status: 'FAILED', error: err.message });
              console.log(`  FAILED ${p.key} ${r.part}: ${err.message}`);
              counts.failed += 1;
              if (++failures >= maxFailures) throw new TxnPostError(`${failures} ${kind} failures; stopping — see ${logPath}`);
              break; // the voucher's later parts wait for a rerun
            }
          }
          if (r.part === 'bill') res.docs[`${p.key}|${p.party.code}`] = { module: 'bills', id };
        }
        if (counts.posted && counts.posted % 50 === 0) progress(`${counts.posted} posted${books.usage.remaining !== null ? `, ${books.usage.remaining} Books calls left today` : ''}`);
      }
    }
    if (only.includes('credit')) {
      for (const c of creditRequests(plan, res).slice(0, perKind)) {
        const [path, field] = c.path.includes('vendorcredits') ? ['vendorcredits', 'bills_credited'] : ['creditnotes', 'invoices_credited'];
        const id = c.path.split('/')[2];
        const rec = Object.values((await books.call('GET', `/${path}/${id}`)) ?? {}).find((v) => v && typeof v === 'object' && v[field]);
        const target = c.body.bills?.[0]?.bill_id ?? c.body.invoices?.[0]?.invoice_id;
        if ((rec?.[field] ?? []).some((x) => String(x.bill_id ?? x.invoice_id) === target)) { counts.found += 1; continue; }
        await books.call('POST', c.path, { body: c.body });
        log({ key: c.key, part: 'credit', status: 'POSTED' });
        counts.posted += 1;
      }
    }
  } catch (err) {
    if (err instanceof RateBlocked) console.log(`${err.message}. Wait it out, then rerun the same command; it resumes where it stopped.`);
    else if (err instanceof DailyLimit) console.log(`Books daily API limit reached — rerun the same command tomorrow; it resumes where it stopped. (${err.message})`);
    else if (err instanceof UnknownOutcome) console.log(`Stopped on an unconfirmed write (${err.message}). Rerun: the voucher is looked up in Books before anything is re-sent.`);
    else throw err;
    return 2;
  } finally {
    closeSync(lock);
    unlinkSync(lockPath);
    const waiting = plan.postings.flatMap((p) => splitApplications(p, res).waiting.map((a) => [p.key, p.kind, a.party, a.doc, a.doc.startsWith('OPENING/') ? '' : booksNumber(plan.branch, a.doc), formatMoney(toPaise(a.amount))]));
    writeFileSync(join(out, 'waiting.csv'), toCsv(['voucher', 'kind', 'party', 'eco_green_doc', 'books_number', 'amount'], waiting));
    console.log(`posted ${counts.posted}, already in Books ${counts.found}, failed ${counts.failed}; waiting applications (pass 2): ${waiting.length}; log: ${logPath}`);
  }
  return counts.failed ? 1 : 0;
}


// ---- apply (pass 2) ------------------------------------------------------------------------------

/**
 * Applications whose documents reached Books after the payment was posted (e.g. Smart Pharma's
 * documents pushed later): adds them to the payments already in Books, never beyond a payment's
 * unused amount, then makes the pending credit / debit note set-offs. Rerun preflight first, so
 * the documents are resolved.
 */
async function cmdApply(o) {
  const out = need(o, 'out');
  const plan = readJson(join(out, 'plan.json'));
  const res = readJson(join(out, 'resolution.json'));
  const config = loadBooksConfig(process.env);
  assertBranchPosting(config, o['confirm-org'], assertPostingAllowed);
  if (res.organizationId !== config.organizationId) throw new TxnPostError('resolution.json was made for another organisation; rerun preflight');
  const books = booksClient(config);
  const logPath = join(out, 'post-log.jsonl');
  const log = (e) => appendFileSync(logPath, JSON.stringify({ at: new Date().toISOString(), ...e }) + '\n');
  const lockPath = join(out, 'post.lock');
  let lock;
  try { lock = openSync(lockPath, 'wx'); } catch { throw new TxnPostError(`${lockPath} exists: another post is running (delete it only if none is)`); }
  const counts = { applied: 0, unchanged: 0, credits: 0, failed: 0 };
  const limit = o.limit ? Number(o.limit) : Infinity;
  try {
    const prefix = `${plan.branch}/`;
    const bills = await books.listAll('/bills', 'bills', { bill_number_startswith: prefix, sort_column: 'bill_number', sort_order: 'A' }, 'bill_id');
    for (const p of plan.postings.filter((x) => x.kind === 'bill')) {
      const hit = bills.find((b) => String(b.bill_number) === booksNumber(plan.branch, p.key));
      if (hit) res.docs[`${p.key}|${p.party.code}`] = { module: 'bills', id: String(hit.bill_id) };
    }
    const MOD = {
      receipt: { path: 'customerpayments', key: 'payment', docs: 'invoices', docId: 'invoice_id', contact: 'customer_id', through: 'account_id' },
      payment: { path: 'vendorpayments', key: 'vendorpayment', docs: 'bills', docId: 'bill_id', contact: 'vendor_id', through: 'paid_through_account_id' },
    };
    let done = 0;
    for (const kind of ['receipt', 'payment']) {
      const m = MOD[kind];
      const todo = plan.postings.filter((p) => p.kind === kind && splitApplications(p, res).now.length);
      if (!todo.length) continue;
      const existing = new Map((await books.listAll(`/${m.path}`, m.path, { reference_number_startswith: prefix, sort_column: 'date', sort_order: 'A' }, 'payment_id'))
        .map((r) => [String(r.reference_number), r]));
      for (const p of todo) {
        if (done >= limit) break;
        const ref = booksNumber(plan.branch, p.key);
        const row = existing.get(ref);
        if (!row) continue; // not posted yet: post makes it with its applications
        const rec = (await books.call('GET', `/${m.path}/${row.payment_id}`))[m.key] ?? {};
        const have = new Set((rec[m.docs] ?? []).map((d) => String(d[m.docId])));
        let unused = toPaise(rec.unused_amount ?? 0);
        const add = [];
        for (const a of splitApplications(p, res).now) {
          if (have.has(a.id) || unused <= 0n) continue;
          const amt = toPaise(a.amount) < unused ? toPaise(a.amount) : unused;
          add.push({ [m.docId]: a.id, amount_applied: Number(formatMoney(amt)) });
          unused -= amt;
        }
        if (!add.length) { counts.unchanged += 1; continue; }
        const body = {
          [m.contact]: String(rec[m.contact]), amount: Number(rec.amount), date: rec.date, reference_number: rec.reference_number,
          description: rec.description ?? '', [m.through]: String(rec[m.through] ?? ''), payment_mode: rec.payment_mode,
          [m.docs]: [...(rec[m.docs] ?? []).map((d) => ({ [m.docId]: String(d[m.docId]), amount_applied: Number(d.amount_applied) })), ...add],
        };
        try {
          await books.call('PUT', `/${m.path}/${row.payment_id}`, { body });
          log({ key: p.key, part: 'apply', status: 'APPLIED', id: String(row.payment_id), added: add.length });
          counts.applied += 1;
          done += 1;
        } catch (err) {
          if (err instanceof UnknownOutcome || err instanceof DailyLimit || err instanceof RateBlocked) throw err;
          log({ key: p.key, part: 'apply', status: 'FAILED', error: err.message });
          console.log(`  FAILED ${p.key} apply: ${err.message}`);
          if (++counts.failed >= Number(o['max-failures'] ?? 5)) throw new TxnPostError(`${counts.failed} apply failures; stopping — see ${logPath}`);
        }
      }
    }
    for (const c of creditRequests(plan, res)) {
      const [path, field] = c.path.includes('vendorcredits') ? ['vendorcredits', 'bills_credited'] : ['creditnotes', 'invoices_credited'];
      const rec = Object.values((await books.call('GET', `/${path}/${c.path.split('/')[2]}`)) ?? {}).find((v) => v && typeof v === 'object' && v[field]);
      const target = c.body.bills?.[0]?.bill_id ?? c.body.invoices?.[0]?.invoice_id;
      if ((rec?.[field] ?? []).some((x) => String(x.bill_id ?? x.invoice_id) === target)) continue;
      await books.call('POST', c.path, { body: c.body });
      log({ key: c.key, part: 'credit', status: 'POSTED' });
      counts.credits += 1;
    }
  } catch (err) {
    if (err instanceof RateBlocked || err instanceof DailyLimit || err instanceof UnknownOutcome) {
      console.log(`Stopped: ${err.message}. Rerun the same command; payments already updated are left as they are.`);
      return 2;
    }
    throw err;
  } finally {
    closeSync(lock);
    unlinkSync(lockPath);
    console.log(`payments updated ${counts.applied}, unchanged ${counts.unchanged}, credit set-offs ${counts.credits}, failed ${counts.failed}; log: ${logPath}`);
  }
  return counts.failed ? 1 : 0;
}

const { cmd, opts } = parseArgs(process.argv.slice(2));
const run = { preflight: cmdPreflight, post: cmdPost, apply: cmdApply }[cmd];
if (!run) {
  console.error('usage: txn-post.js preflight|post|apply [options] (see the header of this file)');
  process.exit(64);
}
Promise.resolve()
  .then(() => run(opts))
  // exitCode, not process.exit(): exiting with fetch sockets still open crashes Node on Windows (0xC0000409)
  .then((code) => { process.exitCode = code ?? 0; })
  .catch((err) => {
    console.error(`${cmd}: ${err.message}`);
    process.exitCode = 1;
  });
