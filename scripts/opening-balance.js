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
  POST_ORDER, MODULES, docKey, partyKey, openingBalanceBody, documentBody, sameDocument, postingQueue,
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

function booksClient(config) {
  const limiter = createLimiter({ ratePerMinute: Math.min(config.rateLimitPerMinute, 90), maxConcurrency: 1 });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function call(method, path, { query = {}, body } = {}) {
    const url = new URL(`${config.apiBase}${path}`);
    for (const [k, v] of Object.entries({ organization_id: config.organizationId, ...query })) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
    const write = method !== 'GET';
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
      if (res.status === 429) {
        if (/per day|daily/i.test(json?.message ?? '')) throw new DailyLimit(json.message);
        if (attempt >= 6) throw new Error(`${method} ${path}: still rate-limited`);
        await sleep(Math.max(5000, Number(res.headers.get('retry-after') ?? 0) * 1000));
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
  async function listAll(path, listKey, query = {}) {
    const out = [];
    for (let page = 1; ; page += 1) {
      const j = await call('GET', path, { query: { ...query, page, per_page: 200 } });
      out.push(...(j[listKey] ?? []));
      if (!j.page_context?.has_more_page) return out;
    }
  }
  return { call, listAll };
}

function liveConfig() {
  const config = loadBooksConfig(process.env);
  if (config.driver !== 'live') throw new Error('BOOKS_DRIVER must be "live" to reach Zoho Books');
  assertOrgAllowed(config);
  return config;
}

// ---- preflight -----------------------------------------------------------------------------

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
    accounts: {}, contacts: {}, offsetAccountId: null, advancePaidThroughId: o['advance-paid-through-id'] ?? null,
    itemId: o['item-id'] ?? null, taxExemptionId: o['tax-exemption-id'] ?? null,
  };

  // Location.
  const locs = await books.listAll('/locations', 'locations').catch((e) => (problems.push(`locations: ${e.message}`), []));
  const loc = locs.find((l) => String(l.location_id) === plan.locationId);
  if (!loc) problems.push(`location ${plan.locationId} not found in organisation ${config.organizationId}`);
  else notes.push(`Location: ${loc.location_name} (${plan.locationId})`);

  // Accounts by code.
  const coa = await books.listAll('/chartofaccounts', 'chartofaccounts', { filter_by: 'AccountType.All' });
  const byCode = new Map();
  for (const a of coa) if (a.account_code) byCode.set(a.account_code, [...(byCode.get(a.account_code) ?? []), a]);
  for (const g of plan.gl) {
    const hits = byCode.get(g.zohoCode) ?? [];
    if (hits.length !== 1) { problems.push(`GL ${g.zohoCode}: ${hits.length} Books accounts carry this code`); continue; }
    const a = hits[0];
    if (/^accounts_(receivable|payable)$/.test(a.account_type)) problems.push(`GL ${g.zohoCode} ${a.account_name} is ${a.account_type}; receivables/payables come from documents, not Opening Balances`);
    res.accounts[g.zohoCode] = { account_id: String(a.account_id), name: a.account_name, type: a.account_type };
  }
  const offset = o['offset-account-id']
    ? coa.find((a) => String(a.account_id) === o['offset-account-id'])
    : coa.find((a) => normName(a.account_name) === 'OPENINGBALANCEADJUSTMENTS');
  if (!offset) problems.push('offset account (Opening Balance Adjustments) not found; pass --offset-account-id');
  else { res.offsetAccountId = String(offset.account_id); notes.push(`Offset account: ${offset.account_name} (${offset.account_id}, ${offset.account_type})`); }
  if (plan.documents.some((d) => d.kind === 'vendor_advance')) {
    const pt = coa.find((a) => String(a.account_id) === (res.advancePaidThroughId ?? res.offsetAccountId));
    notes.push(`Vendor advances paid through: ${pt ? `${pt.account_name} (${pt.account_type})` : '(unresolved)'} — Books may require a cash/bank account; confirm on the smoke test`);
  }

  // Opening item for invoice lines (Books invoices take items, not accounts).
  if (plan.documents.some((d) => d.kind === 'invoice')) {
    let item = null;
    if (res.itemId) item = (await books.call('GET', `/items/${res.itemId}`).catch(() => null))?.item ?? null;
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
  const ex = await books.call('GET', '/settings/taxexemptions').catch(() => null);
  for (const t of ex?.tax_exemptions ?? []) notes.push(`Tax exemption available: ${t.tax_exemption_code} — ${t.description ?? ''} (${t.tax_exemption_id}, ${t.type})`);

  // Contacts: overrides first, then an exact name match of the right type.
  const overrides = o.contacts ? JSON.parse(readFileSync(o.contacts, 'utf8')) : {};
  const parties = new Map();
  for (const d of plan.documents) parties.set(partyKey(d), d);
  const unresolved = [];
  for (const [key, d] of parties) {
    if (overrides[key]) { res.contacts[key] = String(overrides[key]); continue; }
    const type = d.side === 'vendor' ? 'vendor' : 'customer';
    const hits = (await books.listAll('/contacts', 'contacts', { contact_type: type, contact_name_contains: d.partyName.slice(0, 40) }))
      .filter((c) => normName(c.contact_name) === normName(d.partyName) || normName(c.company_name) === normName(d.partyName));
    if (hits.length === 1) res.contacts[key] = String(hits[0].contact_id);
    else unresolved.push([key, d.partyName, hits.length, hits.map((c) => `${c.contact_id}:${c.contact_name}`).join(' | ')]);
  }
  if (unresolved.length) {
    problems.push(`${unresolved.length} parties have no single Books contact — fill contacts-to-map.csv into the --contacts file`);
    writeFileSync(join(out, 'contacts-to-map.csv'), toCsv(['Key', 'Eco Green name', 'Matches', 'Candidates'], unresolved));
  }

  // Existing opening balance.
  const ob = await books.call('GET', '/settings/openingbalances').catch(() => null);
  if (ob?.opening_balance?.accounts?.length) notes.push(`Books already holds an opening balance dated ${ob.opening_balance.date} with ${ob.opening_balance.accounts.length} lines — post will stop at the GL step until that is reviewed`);

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
      const existing = (await books.listAll(`/${m.path}`, m.list, { [`${m.search}_startswith`]: prefix }))
        .filter((r) => String(r[m.number] ?? '').startsWith(prefix));
      console.log(`${kind}: ${docs.length} to check, ${existing.length} already in Books`);
      let failures = 0;
      for (const d of docs) {
        const contactId = res.contacts[partyKey(d)];
        const hit = existing.find((r) => sameDocument(d, r, contactId));
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
          if (err instanceof UnknownOutcome || err instanceof DailyLimit) {
            log({ key: docKey(d), status: err instanceof DailyLimit ? 'DAILY_LIMIT' : 'UNKNOWN', error: err.message });
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
        if ((counts.posted % 100) === 0) console.log(`  … ${counts.posted} posted`);
      }
    }
  } catch (err) {
    if (err instanceof DailyLimit) console.log(`Books daily API limit reached — rerun the same command tomorrow; it resumes where it stopped. (${err.message})`);
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
  const current = await books.call('GET', '/settings/openingbalances').catch(() => null);
  const lines = current?.opening_balance?.accounts ?? [];
  if (lines.length) {
    const ours = new Set(body.accounts.map((a) => `${a.account_id}|${a.debit_or_credit}|${a.amount}`));
    const theirs = lines.filter((a) => Number(a.debit ?? 0) || Number(a.credit ?? 0) || Number(a.amount ?? 0));
    console.log(`Opening Balances: Books already holds ${theirs.length} lines dated ${current.opening_balance.date}; not overwritten. Compare with gl.csv (${ours.size} lines) and clear it in Books if it is not this plan.`);
    log({ key: 'gl', status: 'EXISTS', lines: theirs.length });
    counts.skipped += 1;
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
