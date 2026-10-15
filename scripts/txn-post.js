#!/usr/bin/env node
// Post a branch's planned transactions (scripts/txn-plan.js) to the Zoho Books TEST organisation.
//
//   node scripts/txn-post.js preflight --out var/txn/460 --account-map var/txn/460/accounts_zoho.csv \
//     --opening var/opening/460 --clearing-account-id <Opening Advances Clearing id> [--contacts contacts.json]
//   node scripts/txn-post.js post --out var/txn/460 --confirm-org 60091274394 [--only bill,journal,receipt,payment,credit] [--per-kind 1]
//
// Pass 1: every voucher is posted; receipts / payments are applied to the documents already in
// Books (opening documents, our bills). What Eco Green settled against Smart Pharma's documents
// waits as unused credit (waiting.csv) for pass 2, once their documents are in Books.
// Each voucher carries the reference <branch>/<yy>/<prefix>/<000000>; anything already in Books
// under it is not posted again, so a stopped run is simply run again.
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, openSync, closeSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseCsv } from '../src/core/csv.js';
import { formatMoney } from '../src/core/money.js';
import { loadBooksConfig, assertPostingAllowed } from '../src/books/guard.js';
import {
  UnknownOutcome, DailyLimit, RateBlocked, RATE_PER_MINUTE, progress, booksClient, liveConfig,
} from '../src/books/rest.js';
import { pickAccount, assertTestOrgPosting } from '../src/opening/books_docs.js';
import { refKey, toPaise, INTER_BRANCH_CONTACT } from '../src/txn/plan.js';
import { voucherRequests, creditRequests, splitApplications, booksNumber, TxnPostError } from '../src/txn/books.js';

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
  const add = (side, code, name) => { if (!out.has(`${side}:${code}`)) out.set(`${side}:${code}`, { side, code, name }); };
  for (const p of plan.postings) {
    if (p.party) add(p.party.side, p.party.code, p.party.name);
    for (const l of p.lines ?? []) if (l.party) add(l.party, l.code, l.name);
    if ([...(p.lines ?? []), ...(p.offset ?? [])].some((l) => l.contact === INTER_BRANCH_CONTACT)) {
      const ho = openingDocs.find((d) => d.partyCode === INTER_BRANCH_CONTACT);
      add('customer', INTER_BRANCH_CONTACT, ho?.partyName ?? 'Frankross Admin - Kolkata');
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
  const res = {
    organizationId: config.organizationId, branch: plan.branch, locationId: opening.locationId,
    clearingAccountId: o['clearing-account-id'] ?? null, taxExemptionId: o['tax-exemption-id'] ?? openingRes.taxExemptionId ?? null,
    accountMap: readAccountMap(need(o, 'account-map')), accounts: {}, contacts: { ...(openingRes.contacts ?? {}) },
    gstTreatment: { ...(openingRes.gstTreatment ?? {}) }, controls: {}, docs: {},
  };
  progress(`preflight: organisation ${config.organizationId}, ${plan.postings.length} vouchers (about ${RATE_PER_MINUTE} calls a minute)`);

  // Accounts: every mapped ledger, the party controls, the clearing account.
  const accountsWhere = async (query) => (await books.call('GET', '/chartofaccounts', { query: { filter_by: 'AccountType.All', ...query } })).chartofaccounts ?? [];
  const controlCode = new Map();
  for (const d of opening.documents) if (!controlCode.has(`${d.side}:${d.partyCode}`)) controlCode.set(`${d.side}:${d.partyCode}`, d.controlZoho);
  const defaults = { customer: o['customer-control'] ?? 'FRP0013G', vendor: o['vendor-control'] ?? 'FRP0040G' };
  const parties = partiesOf(plan, opening.documents);
  const codes = new Set([...plan.accounts.map((a) => res.accountMap[a.account]).filter(Boolean)]);
  for (const a of plan.accounts) if (!res.accountMap[a.account]) problems.push(`ledger ${a.account} ${a.name} has no Zoho code in the account map`);
  const partyControl = new Map();
  for (const [key, p] of parties) {
    const c = controlCode.get(key) ?? defaults[p.side];
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
    res.controls[key] = a.account_id;
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
  const billVendors = new Set(plan.postings.filter((p) => p.kind === 'bill').map((p) => `vendor:${p.party.code}`));
  progress(`contacts: ${parties.size}…`);
  for (const [key, p] of parties) {
    if (!res.contacts[key]) {
      const hits = (await books.listAll('/contacts', 'contacts', { contact_type: p.side, contact_name_contains: p.name.slice(0, 40) }))
        .filter((c) => normName(c.contact_name) === normName(p.name) || normName(c.company_name) === normName(p.name));
      if (hits.length === 1) { res.contacts[key] = String(hits[0].contact_id); res.gstTreatment[key] = hits[0].gst_treatment ?? null; } else unresolved.push([key, p.name, hits.length, hits.map((c) => `${c.contact_id}:${c.contact_name}`).join(' | ')]);
    }
    if (billVendors.has(key) && res.contacts[key] && !(key in res.gstTreatment)) {
      res.gstTreatment[key] = (await books.call('GET', `/contacts/${res.contacts[key]}`)).contact?.gst_treatment ?? null;
    }
  }
  if (unresolved.length) {
    problems.push(`${unresolved.length} parties have no single Books contact — fill contacts-to-map.csv into a --contacts JSON file ({"customer:H1": "<contact id>"})`);
    writeFileSync(join(out, 'contacts-to-map.csv'), toCsv(['Key', 'Eco Green name', 'Matches', 'Candidates'], unresolved));
  }
  if (billVendors.size && !res.taxExemptionId) problems.push('bills need a tax exemption id (--tax-exemption-id or the opening resolution)');

  // Opening documents the payments are applied to (pass 1), found by their Books number.
  const idx = openingIndex(opening.documents);
  const wanted = new Map();
  for (const p of plan.postings) for (const a of p.applications ?? []) if (a.source === 'opening') wanted.set(`${a.doc}|${a.party}`, idx.get(`${a.doc}|${a.party}`));
  for (const c of plan.creditApplications ?? []) for (const k of [`${c.credit}|${c.party}`, `${c.doc}|${c.party}`]) if (idx.has(k)) wanted.set(k, idx.get(k));
  const kinds = new Set([...wanted.values()].filter(Boolean).map((d) => d.kind));
  for (const m of DOC_MODULES.filter((x) => kinds.has(x.kind))) {
    progress(`opening ${m.path}…`);
    const prefix = `${plan.branch}/`;
    const rows = await books.listAll(`/${m.path}`, m.list, { [`${m.number}_startswith`]: prefix, sort_column: m.number, sort_order: 'A' }, m.id);
    const byNumber = new Map(rows.map((r) => [String(r[m.number]), r]));
    for (const [k, d] of wanted) {
      if (!d || d.kind !== m.kind) continue;
      const r = byNumber.get(d.number);
      if (r) res.docs[k] = { module: m.path, id: String(r[m.id]), number: d.number };
    }
  }
  const missing = [...wanted].filter(([k, d]) => !d || !res.docs[k]);
  if (missing.length) problems.push(`${missing.length} opening documents to apply to are not in Books, e.g. ${missing.slice(0, 5).map(([k, d]) => `${k} (${d?.number ?? 'not in the opening plan'})`).join(', ')}`);
  const waiting = plan.postings.flatMap((p) => (p.applications ?? []).filter((a) => a.source === 'smartpharma'));
  notes.push(`Applications waiting for Smart Pharma documents (pass 2): ${waiting.length}, ${formatMoney(waiting.reduce((t, a) => t + toPaise(a.amount), 0n))}`);

  progress(`preflight done: ${books.usage.calls} Books calls${books.usage.remaining !== null ? `, ${books.usage.remaining} left today` : ''}`);
  if (books.usage.remaining !== null) notes.push(`Books API calls left today: ${books.usage.remaining} of ${books.usage.limit ?? '?'}`);
  res.problems = problems;
  writeFileSync(join(out, 'resolution.json'), JSON.stringify(res, null, 2));
  const md = [`# Branch ${plan.branch} — transaction preflight (${new Date().toISOString().slice(0, 10)})`, '', `Organisation ${config.organizationId}, location ${res.locationId}`, '',
    '## Resolved', '', ...notes.map((n) => `- ${n}`), `- Accounts: ${Object.keys(res.accounts).length}/${codes.size}`, `- Contacts: ${[...parties.keys()].filter((k) => res.contacts[k]).length}/${parties.size}`,
    `- Opening documents to apply to: ${Object.keys(res.docs).length}/${wanted.size}`, '', '## Problems', '', ...(problems.length ? problems.map((p) => `- ${p}`) : ['- none — ready for the smoke test']), ''].join('\n');
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
  assertTestOrgPosting(config, o['confirm-org'], assertPostingAllowed);
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

const { cmd, opts } = parseArgs(process.argv.slice(2));
const run = { preflight: cmdPreflight, post: cmdPost }[cmd];
if (!run) {
  console.error('usage: txn-post.js preflight|post [options] (see the header of this file)');
  process.exit(64);
}
Promise.resolve()
  .then(() => run(opts))
  .then((code) => process.exit(code ?? 0))
  .catch((err) => {
    console.error(`${cmd}: ${err.message}`);
    process.exit(1);
  });
