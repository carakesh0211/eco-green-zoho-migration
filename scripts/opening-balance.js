#!/usr/bin/env node
// Branch opening balances into Zoho Books, in three steps (each reads what the previous wrote):
//
//   plan       offline. Reads the branch workbook, ties every control ledger to its documents and
//              writes plan.json, documents.csv, gl.csv and report.md to --out.
//   preflight  read-only Books calls. Resolves accounts (by account code), contacts (overrides
//              file, then exact name), the location, the offset account and the opening item;
//              writes resolution.json and preflight.md. Stops on anything missing or ambiguous.
//   post       writes to the TEST organisation only (60091274394), behind the shared posting
//              guard: Opening Balances first, then invoices, credit notes, bills, vendor credits
//              and vendor advances. Resumable: every outcome goes to post-log.jsonl and existing
//              Books documents (same number, same contact) are never created twice.
//
// Credentials come from the environment (BOOKS_CLIENT_ID / BOOKS_CLIENT_SECRET /
// BOOKS_REFRESH_TOKEN ...) and are never printed.
//
//   node scripts/opening-balance.js plan --file bills_invoices_460.xlsx --branch 460 \
//        --as-of 2026-03-31 --closing-stock 3137148.13 --location 4222956000000042021 --out var/opening/460
//   node scripts/opening-balance.js preflight --out var/opening/460 --contacts contacts_460.json
//   node scripts/opening-balance.js post --out var/opening/460 --confirm-org 60091274394 --only gl,invoice --per-kind 1
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { buildOpeningPlan, summarisePlan, toPaise } from '../src/opening/plan.js';
import {
  POST_ORDER, MODULES, docKey, partyKey, openingBalanceBody, documentBody, sameDocument, postingQueue, pickAccount, sameOpeningBalance, referenceInvoiceType,
  assertTestOrgPosting, OpeningPostError,
} from '../src/opening/books_docs.js';
import { formatMoney } from '../src/core/money.js';
import { loadBooksConfig, assertPostingAllowed, assertOrgAllowed } from '../src/books/guard.js';
import { getAccessToken } from '../src/books/oauth.js';
import { createLimiter } from '../src/books/limiter.js';

// ---- arguments / files ---------------------------------------------------------------------

function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const opts = {};
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    if (!a.startsWith('--')) throw new Error(`unexpected argument ${a}`);
    const k = a.slice(2);
    const v = rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[++i] : 'true';
    opts[k] = v;
  }
  return { cmd, opts };
}
const need = (o, k) => {
  if (!o[k]) throw new Error(`--${k} is required`);
  return o[k];
};

const PAISE_FIELDS = new Set(['net', 'amount', 'glNet', 'docNet', 'plNet', 'closingStock', 'reserveNet']);
const toJson = (v) => JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? x.toString() : x), 2);
const fromJson = (s) => JSON.parse(s, (k, x) => (PAISE_FIELDS.has(k) && typeof x === 'string' && /^-?\d+$/.test(x) ? BigInt(x) : x));
const readJson = (p) => fromJson(readFileSync(p, 'utf8'));
const csvCell = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const toCsv = (header, rows) => [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\n') + '\n';
const fmt = (p) => formatMoney(p);

/** Chart of accounts export (Account ID, Account Name, Account Code, Account Type ...) -> code -> rows. */
function readCoaCsv(path) {
  const byCode = new Map();
  const lines = readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean);
  for (const line of lines.slice(1)) {
    const [id, name, code, type] = line.split(',');
    if (!code) continue;
    byCode.set(code, [...(byCode.get(code) ?? []), { account_id: id, name, type }]);
  }
  return byCode;
}

// ---- plan ----------------------------------------------------------------------------------

function cmdPlan(o) {
  const out = need(o, 'out');
  mkdirSync(out, { recursive: true });
  const plan = buildOpeningPlan(readFileSync(need(o, 'file')), {
    branch: need(o, 'branch'),
    asOf: need(o, 'as-of'),
    closingStock: toPaise(need(o, 'closing-stock')),
    locationId: need(o, 'location'),
  });
  const coa = o.coa ? readCoaCsv(o.coa) : new Map();
  const acct = (code) => (coa.get(code) ?? []).map((a) => `${a.name} (${a.type})`).join(' / ') || '';

  writeFileSync(join(out, 'plan.json'), toJson(plan));
  writeFileSync(join(out, 'documents.csv'), toCsv(
    ['Module', 'Side', 'Party code', 'Party name', 'Number', 'Vendor invoice no', 'Date', 'Due date', 'Amount', 'Dr/Cr', 'TB control', 'Zoho control', 'Source type', 'Source ref'],
    plan.documents.map((d) => [d.kind, d.side, d.partyCode, d.partyName, d.number, d.vendorInvoiceNo ?? '', d.date, d.dueDate, fmt(d.amount), d.net > 0n ? 'Dr' : 'Cr', d.controlCode, d.controlZoho, d.sourceType, d.sourceRef]),
  ));
  writeFileSync(join(out, 'gl.csv'), toCsv(
    ['Zoho code', 'Zoho account', 'Debit', 'Credit', 'Eco Green ledgers'],
    plan.gl.map((g) => [g.zohoCode, acct(g.zohoCode), g.net > 0n ? fmt(g.net) : '', g.net < 0n ? fmt(-g.net) : '', g.sources.join('; ')]),
  ));
  writeFileSync(join(out, 'report.md'), planReport(plan, acct));
  const failed = plan.checks.filter((c) => !c.ok);
  console.log(`plan written to ${out}: ${plan.documents.length} documents, ${plan.gl.length} GL lines, ${plan.checks.length - failed.length}/${plan.checks.length} checks OK`);
  for (const c of failed) console.log(`  FAILED ${c.check}: expected ${c.expected}, got ${c.actual}`);
  return failed.length ? 1 : 0;
}

function planReport(plan, acct) {
  const sum = summarisePlan(plan);
  const glDr = plan.gl.filter((g) => g.net > 0n).reduce((a, g) => a + g.net, 0n);
  const glCr = plan.gl.filter((g) => g.net < 0n).reduce((a, g) => a - g.net, 0n);
  const parties = new Map();
  for (const d of plan.documents) {
    const p = parties.get(partyKey(d)) ?? { side: d.side, code: d.partyCode, name: d.partyName, count: 0, net: 0n };
    p.count += 1;
    p.net += d.net;
    parties.set(partyKey(d), p);
  }
  const L = [];
  L.push(`# Branch ${plan.branch} — Opening Balance Plan as on ${plan.asOf}`, '');
  L.push(`Books location: \`${plan.locationId}\` · Closing stock: ₹${fmt(plan.totals.closingStock)} · Year result moved to reserves: ₹${fmt(plan.totals.plNet)}`, '');
  L.push('## 1. Postings by Books module', '', '| Module | Documents | Amount (₹) |', '|---|---:|---:|');
  L.push(`| Opening Balances (GL) | ${plan.gl.length} lines | Dr ${fmt(glDr)} / Cr ${fmt(glCr)} |`);
  for (const [k, v] of Object.entries(sum)) L.push(`| ${k} | ${v.count} | ${v.amount} |`);
  L.push('', '## 2. Tie-out checks', '', '| Check | Expected | Actual | Result |', '|---|---:|---:|---|');
  for (const c of plan.checks) L.push(`| ${c.check} | ${c.expected} | ${c.actual} | ${c.ok ? 'OK' : '**FAILED**'} |`);
  L.push('', '## 3. Opening Balances module (GL lines)', '', '| Zoho code | Account | Debit (₹) | Credit (₹) |', '|---|---|---:|---:|');
  for (const g of plan.gl) L.push(`| ${g.zohoCode} | ${acct(g.zohoCode) || g.sources.join('; ')} | ${g.net > 0n ? fmt(g.net) : ''} | ${g.net < 0n ? fmt(-g.net) : ''} |`);
  L.push('', '## 4. Parties', '', '| Side | Code | Name | Documents | Net (Dr + / Cr −) |', '|---|---|---|---:|---:|');
  for (const p of [...parties.values()].sort((a, b) => a.side.localeCompare(b.side) || a.code.localeCompare(b.code))) {
    L.push(`| ${p.side} | ${p.code} | ${p.name} | ${p.count} | ${fmt(p.net)} |`);
  }
  if (plan.warnings.length) L.push('', '## 5. Warnings', '', ...plan.warnings.map((w) => `- ${w}`));
  L.push('', 'Every document is posted against the offset account (Opening Balance Adjustments); the Opening Balances entry clears it. After a full post, Opening Balance Adjustments for this location must read nil.', '');
  return L.join('\n');
}

// ---- Books (read and write) ----------------------------------------------------------------

class UnknownOutcome extends Error {}
class DailyLimit extends Error {}
class RateBlocked extends Error {}

// Books allows about 100 calls a minute per organisation, shared with every other client of the
// org; staying well under it avoids the hour-long block (code 43) that follows a breach.
const RATE_PER_MINUTE = 40;
// Calls kept in hand from the org's daily allowance; the run stops cleanly below this.
const DAILY_RESERVE = 25;
// For optional reads: fall back on an ordinary error, but never on a rate block or the daily limit.
const orStop = (fallback) => (err) => {
  if (err instanceof RateBlocked || err instanceof DailyLimit) throw err;
  return fallback(err);
};
const progress = (msg) => process.stderr.write(`[${new Date().toISOString().slice(11, 19)}] ${msg}\n`);

function booksClient(config) {
  const limiter = createLimiter({ ratePerMinute: Math.min(config.rateLimitPerMinute, RATE_PER_MINUTE), maxConcurrency: 1 });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const usage = { calls: 0, remaining: null, limit: null };
  async function call(method, path, { query = {}, body } = {}) {
    const url = new URL(`${config.apiBase}${path}`);
    for (const [k, v] of Object.entries({ organization_id: config.organizationId, ...query })) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
    const write = method !== 'GET';
    if (usage.remaining !== null && usage.remaining < DAILY_RESERVE) {
      throw new DailyLimit(`only ${usage.remaining} of today's ${usage.limit ?? '?'} Books API calls left`);
    }
    for (let attempt = 1; ; attempt += 1) {
      const token = await getAccessToken(config);
      let res;
      let json = null;
      try {
        res = await limiter.schedule(() => fetch(url, {
          method,
          headers: { Authorization: `Zoho-oauthtoken ${token}`, 'Content-Type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(config.requestTimeoutMs ?? 30_000),
        }));
        const t = await res.text();
        json = t ? JSON.parse(t) : {};
      } catch (err) {
        // A write that may have reached Books is never blindly re-sent: the next run looks it up.
        if (write) throw new UnknownOutcome(`${method} ${path}: ${err.name === 'TimeoutError' ? 'timeout' : err.code || err.message}`);
        if (attempt >= 5) throw err;
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      usage.calls += 1;
      const remaining = Number(res.headers.get('x-rate-limit-remaining'));
      if (Number.isFinite(remaining) && res.headers.get('x-rate-limit-remaining') !== null) {
        usage.remaining = remaining;
        usage.limit = Number(res.headers.get('x-rate-limit-limit')) || usage.limit;
      }
      if (res.status === 429) {
        const retryAfter = Number(res.headers.get('retry-after') ?? 0);
        if (/per day|daily/i.test(json?.message ?? '')) throw new DailyLimit(json.message);
        // A long Retry-After (or Books code 43) is a block, not a pause: stop and say so.
        if (json?.code === 43 || retryAfter > 60) {
          throw new RateBlocked(`Books has blocked this organisation for ${retryAfter ? `${Math.round(retryAfter / 60)} min` : 'a while'} (code ${json?.code ?? '?'}: ${json?.message ?? 'too many requests'})`);
        }
        if (attempt >= 4) throw new RateBlocked(`${method} ${path}: still rate-limited after ${attempt} tries`);
        progress(`rate-limited; waiting ${Math.max(10, retryAfter)} s`);
        await sleep(Math.max(10, retryAfter) * 1000);
        continue;
      }
      if (res.status >= 500) {
        if (write) throw new UnknownOutcome(`${method} ${path}: http ${res.status}`);
        if (attempt >= 5) throw new Error(`${method} ${path}: http ${res.status}`);
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      if (res.status >= 400 || (json && json.code !== undefined && json.code !== 0)) {
        const e = new Error(`${method} ${path}: http ${res.status} code ${json?.code}: ${json?.message ?? ''}`);
        e.books = json;
        throw e;
      }
      return json;
    }
  }
  // Pages are only stable when the list is sorted on a unique column; records are de-duplicated
  // by `idKey` either way.
  async function listAll(path, listKey, query = {}, idKey = null) {
    const out = new Map();
    for (let page = 1; ; page += 1) {
      const j = await call('GET', path, { query: { ...query, page, per_page: 200 } });
      for (const r of j[listKey] ?? []) out.set(idKey ? String(r[idKey]) : `${out.size}`, r);
      if (!j.page_context?.has_more_page) return [...out.values()];
    }
  }
  return { call, listAll, usage };
}

function liveConfig() {
  const config = loadBooksConfig(process.env);
  if (config.driver !== 'live') throw new Error('BOOKS_DRIVER must be "live" to reach Zoho Books');
  assertOrgAllowed(config);
  return config;
}

// ---- preflight -----------------------------------------------------------------------------

/** --extra-invoice / --extra-credit-note / --extra-bill / --extra-vendor-credit / --extra-vendor-advance: JSON objects of body fields. */
function parseExtras(o) {
  const out = {};
  for (const kind of ['invoice', 'credit_note', 'bill', 'vendor_credit', 'vendor_advance']) {
    const raw = o[`extra-${kind.replace('_', '-')}`];
    if (!raw) continue;
    let v;
    try { v = JSON.parse(raw); } catch { throw new Error(`--extra-${kind.replace('_', '-')} must be a JSON object`); }
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(`--extra-${kind.replace('_', '-')} must be a JSON object`);
    out[kind] = v;
  }
  return out;
}

const normName = (s) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

async function cmdPreflight(o) {
  const out = need(o, 'out');
  const plan = readJson(join(out, 'plan.json'));
  const config = liveConfig();
  const books = booksClient(config);
  const problems = [];
  const notes = [];
  const res = {
    organizationId: config.organizationId, locationId: plan.locationId, docDate: o['doc-date'] ?? 'original',
    accounts: {}, contacts: {}, gstTreatment: {}, offsetAccountId: null, advancePaidThroughId: o['advance-paid-through-id'] ?? null,
    itemId: o['item-id'] ?? null, taxExemptionId: o['tax-exemption-id'] ?? null, advancePaidThroughCurrencyId: null,
    extras: parseExtras(o),
  };

  progress(`preflight: organisation ${config.organizationId}, ${plan.gl.length} GL codes, ${new Set(plan.documents.map(partyKey)).size} parties (about ${RATE_PER_MINUTE} calls a minute)`);
  // Location.
  const locs = await books.listAll('/locations', 'locations').catch(orStop((e) => (problems.push(`locations: ${e.message}`), [])));
  const loc = locs.find((l) => String(l.location_id) === plan.locationId);
  if (!loc) problems.push(`location ${plan.locationId} not found in organisation ${config.organizationId}`);
  else notes.push(`Location: ${loc.location_name} (${plan.locationId})`);

  progress('accounts…');
  // Accounts: one exact-code lookup each (the full list pages unreliably, being sorted by type).
  const accountsWhere = async (query) => (await books.call('GET', '/chartofaccounts', { query: { filter_by: 'AccountType.All', ...query } })).chartofaccounts ?? [];
  for (const g of plan.gl) {
    const { account: a, problem } = pickAccount(g.zohoCode, await accountsWhere({ account_code: g.zohoCode }));
    if (problem) { problems.push(problem); continue; }
    if (/^accounts_(receivable|payable)$/.test(a.account_type)) problems.push(`GL ${g.zohoCode} ${a.account_name} is ${a.account_type}; receivables/payables come from documents, not Opening Balances`);
    if (!a.currency_id) problems.push(`GL ${g.zohoCode} ${a.account_name}: Books returned no currency for this account`);
    res.accounts[g.zohoCode] = { account_id: String(a.account_id), currency_id: a.currency_id ? String(a.currency_id) : null, name: a.account_name, type: a.account_type };
  }
  const offset = o['offset-account-id']
    ? (await accountsWhere({ account_id: o['offset-account-id'] })).find((a) => String(a.account_id) === o['offset-account-id'])
    : (await accountsWhere({ account_name: 'Opening Balance Adjustments' })).find((a) => normName(a.account_name) === 'OPENINGBALANCEADJUSTMENTS');
  if (!offset) problems.push('offset account (Opening Balance Adjustments) not found; pass --offset-account-id');
  else { res.offsetAccountId = String(offset.account_id); notes.push(`Offset account: ${offset.account_name} (${offset.account_id}, ${offset.account_type})`); }
  if (plan.documents.some((d) => d.kind === 'vendor_advance')) {
    // Books pays only out of cash or bank (code 11016); the clearing account gets the advances back
    // as an Opening Balances debit, so it ends the opening at nil.
    const ptId = res.advancePaidThroughId;
    const pt = ptId ? (await accountsWhere({ account_id: ptId })).find((a) => String(a.account_id) === ptId) : null;
    if (!pt) problems.push('vendor advances: pass --advance-paid-through-id <a cash or bank clearing account, e.g. "Opening Advances Clearing">');
    else if (!/^(cash|bank)$/.test(pt.account_type)) problems.push(`vendor advances: ${pt.account_name} is ${pt.account_type}; Books pays only out of a cash or bank account`);
    else {
      res.advancePaidThroughCurrencyId = pt.currency_id ? String(pt.currency_id) : null;
      notes.push(`Vendor advances paid through: ${pt.account_name} (${pt.account_type}); Opening Balances debits it by the same total`);
    }
  }

  progress(`accounts done: ${Object.keys(res.accounts).length}/${plan.gl.length}`);
  // Opening item for invoice lines (Books invoices take items, not accounts).
  if (plan.documents.some((d) => d.kind === 'invoice')) {
    let item = null;
    if (res.itemId) item = (await books.call('GET', `/items/${res.itemId}`).catch(orStop(() => null)))?.item ?? null;
    else {
      const items = await books.listAll('/items', 'items', { name: 'Opening Balance' });
      const hits = items.filter((i) => normName(i.name) === 'OPENINGBALANCE');
      if (hits.length === 1) item = hits[0];
    }
    if (!item) problems.push('no invoice item: create a non-inventory service item "Opening Balance" (non-taxable, sales account Opening Balance Adjustments) or pass --item-id');
    else {
      res.itemId = String(item.item_id);
      notes.push(`Invoice item: ${item.name} (${item.item_id}), sales account ${item.account_name ?? item.account_id ?? '?'}, tax ${item.tax_name || item.tax_id || 'none'}`);
      if (item.account_id && res.offsetAccountId && String(item.account_id) !== res.offsetAccountId) {
        notes.push('NOTE: the item\'s sales account is not the offset account — invoices would credit income, and Opening Balance Adjustments would not clear');
        problems.push(`item ${item.name}: sales account must be the offset account (${res.offsetAccountId})`);
      }
    }
  }
  if (plan.documents.some((d) => d.kind === 'debit_note')) problems.push('customer debit notes need an original Books invoice; resolve before posting');

  // Tax exemptions (listed for the operator; not required unless Books asks for one).
  // Tax exemption: Books (GST) wants a tax or an exemption on every invoice and bill line (code 110802).
  const ex = await books.call('GET', '/settings/taxexemptions').catch(orStop(() => null));
  const exemptions = ex?.tax_exemptions ?? [];
  for (const t of exemptions) notes.push(`Tax exemption available: ${t.tax_exemption_code} — ${t.description ?? ''} (${t.tax_exemption_id}, ${t.type})`);
  if (!res.taxExemptionId) {
    const hits = exemptions.filter((t) => /OPENING/i.test(`${t.tax_exemption_code} ${t.description ?? ''}`));
    if (hits.length === 1) res.taxExemptionId = String(hits[0].tax_exemption_id);
  }
  if (res.taxExemptionId) notes.push(`Tax exemption used on every line: ${res.taxExemptionId}`);
  else problems.push('no tax exemption: create one in Books (Settings → Taxes → Tax Exemptions, code OPENING BALANCE, type Item) or pass --tax-exemption-id');

  // What Books' own forms expect for notes without an original document (GST invoice / bill
  // type): the edit pages are saved for review and any field mentioning a type is listed.
  mkdirSync(join(out, 'books-meta'), { recursive: true });
  for (const [label, path] of [['creditnote', '/creditnotes/editpage'], ['vendorcredit', '/vendorcredits/editpage']]) {
    const page = await books.call('GET', path).catch(orStop(() => null));
    if (!page) continue;
    writeFileSync(join(out, 'books-meta', `${label}-editpage.json`), JSON.stringify(page, null, 2));
    const keys = new Set();
    const walk = (v, prefix) => {
      if (Array.isArray(v)) return v.slice(0, 3).forEach((x) => walk(x, prefix));
      if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { if (/type/i.test(k)) keys.add(`${prefix}${k}`); walk(x, `${prefix}${k}.`); }
    };
    walk(page, '');
    notes.push(`${label} edit page: type fields ${[...keys].slice(0, 25).join(', ') || '(none)'}`);
  }
  for (const [kind, fields] of Object.entries(res.extras)) notes.push(`Extra ${kind} fields: ${JSON.stringify(fields)}`);

  // Contacts: overrides first, then an exact name match of the right type.
  const overrides = o.contacts ? JSON.parse(readFileSync(o.contacts, 'utf8')) : {};
  const parties = new Map();
  for (const d of plan.documents) parties.set(partyKey(d), d);
  const unresolved = [];
  progress(`contacts: ${parties.size}…`);
  // Parties with a credit note or vendor credit need their GST treatment (it sets the note's
  // reference invoice type); name searches return it, overridden contacts are read once.
  const needsGst = new Set(plan.documents.filter((d) => d.kind === 'credit_note' || d.kind === 'vendor_credit').map(partyKey));
  let seen = 0;
  for (const [key, d] of parties) {
    if (++seen % 20 === 0) progress(`contacts ${seen}/${parties.size}`);
    if (overrides[key]) {
      res.contacts[key] = String(overrides[key]);
      if (needsGst.has(key)) res.gstTreatment[key] = (await books.call('GET', `/contacts/${overrides[key]}`)).contact?.gst_treatment ?? null;
      continue;
    }
    const type = d.side === 'vendor' ? 'vendor' : 'customer';
    const hits = (await books.listAll('/contacts', 'contacts', { contact_type: type, contact_name_contains: d.partyName.slice(0, 40) }))
      .filter((c) => normName(c.contact_name) === normName(d.partyName) || normName(c.company_name) === normName(d.partyName));
    if (hits.length === 1) {
      res.contacts[key] = String(hits[0].contact_id);
      res.gstTreatment[key] = hits[0].gst_treatment ?? null;
    } else unresolved.push([key, d.partyName, hits.length, hits.map((c) => `${c.contact_id}:${c.contact_name}`).join(' | ')]);
  }
  const noType = [...needsGst].filter((k) => res.contacts[k] && !referenceInvoiceType(res.gstTreatment[k]));
  if (noType.length) problems.push(`${noType.length} parties with credit notes / vendor credits have no usable GST treatment in Books: ${noType.slice(0, 10).map((k) => `${k} (${res.gstTreatment[k] ?? 'none'})`).join(', ')}`);
  const byType = {};
  for (const k of needsGst) { const t = referenceInvoiceType(res.gstTreatment[k]) ?? 'unknown'; byType[t] = (byType[t] ?? 0) + 1; }
  notes.push(`Credit note / vendor credit reference invoice type by party: ${JSON.stringify(byType)}`);
  if (unresolved.length) {
    problems.push(`${unresolved.length} parties have no single Books contact — fill contacts-to-map.csv into the --contacts file`);
    writeFileSync(join(out, 'contacts-to-map.csv'), toCsv(['Key', 'Eco Green name', 'Matches', 'Candidates'], unresolved));
  }

  // Existing opening balance for this location (saved for review).
  const ob = await books.call('GET', '/settings/openingbalances', { query: { location_id: plan.locationId } }).catch(orStop(() => null));
  if (ob) writeFileSync(join(out, 'books-meta', 'opening-balance-existing.json'), JSON.stringify(ob, null, 2));
  if (ob?.opening_balance?.accounts?.length) {
    const same = res.offsetAccountId && Object.keys(res.accounts).length === plan.gl.length && (!plan.documents.some((d) => d.kind === 'vendor_advance') || res.advancePaidThroughCurrencyId)
      ? sameOpeningBalance(ob.opening_balance.accounts, openingBalanceBody(plan, res), res.offsetAccountId) : false;
    notes.push(`Books holds an opening balance dated ${ob.opening_balance.date} with ${ob.opening_balance.accounts.length} lines for this location: ${same ? 'it matches this plan' : 'it differs from this plan (post needs --replace-opening-balance; see books-meta/opening-balance-existing.json)'}`);
  }

  progress(`preflight done: ${books.usage.calls} Books calls${books.usage.remaining !== null ? `, ${books.usage.remaining} left today` : ''}`);
  if (books.usage.remaining !== null) notes.push(`Books API calls left today: ${books.usage.remaining} of ${books.usage.limit ?? '?'}`);
  res.problems = problems;
  writeFileSync(join(out, 'resolution.json'), toJson(res));
  const md = [`# Branch ${plan.branch} — Preflight (${new Date().toISOString().slice(0, 10)})`, '', `Organisation ${config.organizationId}`, '', '## Resolved', '', ...notes.map((n) => `- ${n}`),
    `- Accounts resolved: ${Object.keys(res.accounts).length}/${plan.gl.length}`, `- Contacts resolved: ${Object.keys(res.contacts).length}/${parties.size}`, '',
    '## Problems', '', ...(problems.length ? problems.map((p) => `- ${p}`) : ['- none — ready for the smoke test']), ''].join('\n');
  writeFileSync(join(out, 'preflight.md'), md);
  console.log(md);
  return problems.length ? 1 : 0;
}

// ---- post ----------------------------------------------------------------------------------

async function cmdPost(o) {
  const out = need(o, 'out');
  const plan = readJson(join(out, 'plan.json'));
  const res = readJson(join(out, 'resolution.json'));
  const config = loadBooksConfig(process.env);
  assertTestOrgPosting(config, o['confirm-org'], assertPostingAllowed);
  if (res.organizationId !== config.organizationId) throw new OpeningPostError('resolution.json was made for another organisation; rerun preflight');
  if (res.problems?.length) throw new OpeningPostError(`preflight has ${res.problems.length} open problems; rerun preflight once they are fixed`);
  if (plan.checks.some((c) => !c.ok)) throw new OpeningPostError('the plan has failed checks');

  const only = (o.only ?? ['gl', ...POST_ORDER].join(',')).split(',');
  const perKind = o['per-kind'] ? Number(o['per-kind']) : Infinity;
  const maxFailures = Number(o['max-failures'] ?? 5);
  const books = booksClient(config);
  const logPath = join(out, 'post-log.jsonl');
  const log = (e) => appendFileSync(logPath, JSON.stringify({ at: new Date().toISOString(), ...e }) + '\n');

  // One poster at a time per plan folder.
  const lockPath = join(out, 'post.lock');
  let lock;
  try { lock = openSync(lockPath, 'wx'); } catch { throw new OpeningPostError(`${lockPath} exists: another post is running (delete it only if none is)`); }
  const counts = { posted: 0, found: 0, failed: 0, skipped: 0 };
  try {
    if (only.includes('gl')) await postGl(plan, res, books, log, o, counts);
    const queue = postingQueue(plan, { kinds: only, perKind });
    for (const kind of POST_ORDER) {
      const docs = queue.filter((d) => d.kind === kind);
      if (!docs.length) continue;
      const m = MODULES[kind];
      if (!m) throw new OpeningPostError(`no Books module for ${kind}`);
      // Existing documents with our numbers (authoritative over the local log).
      const prefix = `${plan.branch}/`;
      const existing = (await books.listAll(`/${m.path}`, m.list, { [`${m.search}_startswith`]: prefix, sort_column: m.sort, sort_order: 'A' }, m.id))
        .filter((r) => String(r[m.number] ?? '').startsWith(prefix));
      console.log(`${kind}: ${docs.length} to check, ${existing.length} already in Books`);
      let failures = 0;
      for (const d of docs) {
        const contactId = res.contacts[partyKey(d)];
        let hit = existing.find((r) => sameDocument(d, r, contactId));
        if (!hit && m.exactLookup) {
          hit = ((await books.call('GET', `/${m.path}`, { query: { [m.search]: d.number } }))[m.list] ?? []).find((r) => sameDocument(d, r, contactId));
        }
        if (hit) {
          counts.found += 1;
          if (hit.status === 'draft' && m.open) {
            await books.call('POST', `/${m.path}/${hit[m.id]}/${m.open}`);
            log({ key: docKey(d), status: 'OPENED', id: String(hit[m.id]) });
          }
          continue;
        }
        let rec;
        try {
          const q = kind === 'vendor_advance' ? {} : { ignore_auto_number_generation: 'true' };
          const j = await books.call('POST', `/${m.path}`, { query: q, body: documentBody(d, plan, res) });
          rec = j[m.key];
          if (!rec?.[m.id]) throw new UnknownOutcome(`${d.number}: Books answered without a ${m.id}`);
          log({ key: docKey(d), status: 'POSTED', id: String(rec[m.id]), amount: fmt(d.amount) });
          counts.posted += 1;
        } catch (err) {
          if (err instanceof UnknownOutcome || err instanceof DailyLimit || err instanceof RateBlocked) {
            log({ key: docKey(d), status: err instanceof UnknownOutcome ? 'UNKNOWN' : 'NOT_SENT', error: err.message });
            throw err;
          }
          log({ key: docKey(d), status: 'FAILED', error: err.message });
          console.log(`  FAILED ${d.number}: ${err.message}`);
          counts.failed += 1;
          failures += 1;
          if (failures >= maxFailures) throw new OpeningPostError(`${failures} ${kind} failures; stopping — see ${logPath}`);
          continue;
        }
        if (rec.status === 'draft' && m.open) {
          await books.call('POST', `/${m.path}/${rec[m.id]}/${m.open}`);
          log({ key: docKey(d), status: 'OPENED', id: String(rec[m.id]) });
        }
        if ((counts.posted % 100) === 0) progress(`${counts.posted} posted${books.usage.remaining !== null ? `, ${books.usage.remaining} Books calls left today` : ''}`);
      }
    }
  } catch (err) {
    if (err instanceof RateBlocked) console.log(`${err.message}. Wait it out, then rerun the same command; it resumes where it stopped.`);
    else if (err instanceof DailyLimit) console.log(`Books daily API limit reached — rerun the same command tomorrow; it resumes where it stopped. (${err.message})`);
    else if (err instanceof UnknownOutcome) console.log(`Stopped on an unconfirmed write (${err.message}). Rerun: the document is looked up in Books before anything is re-sent.`);
    else throw err;
    return 2;
  } finally {
    closeSync(lock);
    unlinkSync(lockPath);
    console.log(`posted ${counts.posted}, already in Books ${counts.found}, failed ${counts.failed}; log: ${logPath}`);
  }
  return counts.failed ? 1 : 0;
}

async function postGl(plan, res, books, log, o, counts) {
  const body = openingBalanceBody(plan, res);
  const current = await books.call('GET', '/settings/openingbalances', { query: { location_id: plan.locationId } }).catch(orStop(() => null));
  const lines = current?.opening_balance?.accounts ?? [];
  if (lines.length) {
    if (sameOpeningBalance(lines, body, res.offsetAccountId)) {
      console.log(`Opening Balances: already in Books as planned (${body.accounts.length} lines); nothing to do`);
      log({ key: 'gl', status: 'FOUND', lines: body.accounts.length });
      counts.found += 1;
      return;
    }
    if (o['replace-opening-balance'] !== 'true') {
      console.log(`Opening Balances: Books holds a different entry dated ${current.opening_balance.date} (${lines.length} lines); not changed. Rerun with --replace-opening-balance to replace it with this plan's ${body.accounts.length} lines.`);
      log({ key: 'gl', status: 'DIFFERS', lines: lines.length });
      counts.skipped += 1;
      return;
    }
    await books.call('PUT', '/settings/openingbalances', { body });
    log({ key: 'gl', status: 'REPLACED', lines: body.accounts.length });
    counts.posted += 1;
    console.log(`Opening Balances replaced: ${body.accounts.length} lines`);
    return;
  }
  const j = await books.call('POST', '/settings/openingbalances', { body });
  log({ key: 'gl', status: 'POSTED', lines: body.accounts.length, id: String(j?.opening_balance?.opening_balance_id ?? '') });
  counts.posted += 1;
  console.log(`Opening Balances posted: ${body.accounts.length} lines`);
}

// ---- main ----------------------------------------------------------------------------------

const { cmd, opts } = parseArgs(process.argv.slice(2));
const run = { plan: cmdPlan, preflight: cmdPreflight, post: cmdPost }[cmd];
if (!run) {
  console.error('usage: opening-balance.js plan|preflight|post [options] (see the header of this file)');
  process.exit(64);
}
Promise.resolve()
  .then(() => run(opts))
  .then((code) => process.exit(code ?? 0))
  .catch((err) => {
    console.error(`${cmd}: ${err.message}`);
    process.exit(1);
  });
