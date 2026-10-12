#!/usr/bin/env node
// scripts/upload-books-reference.js — load the Zoho Books master lists (chart of accounts,
// vendors, customers) into a console's shared Books reference (POST /api/books-reference).
// The reference is stored once and used by bulk mapping for every branch.
//
//   node scripts/upload-books-reference.js --url https://<console> \
//        (--token-file <file> | CONSOLE_TOKEN env | --proxy-auth) [--org <books org id>] \
//        [--accounts coa.csv] [--contacts all-contacts.csv] [--vendors v.csv] [--customers c.csv]
//
// Pass at least one list. A partial upload keeps the lists it does not replace (see the route);
// --contacts (vendors and customers in one file, typed by its "Contact Type" column) replaces
// all contacts. Files are CSV or XLSX exports with exact 19-digit IDs; the console refuses
// IDs that Excel rounded. The token is never printed; with --proxy-auth none is read and the
// egress proxy adds the Authorization header.
import { readFile } from 'node:fs/promises';
import path from 'node:path';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    args[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  return args;
}

const LISTS = [['accounts', 'accounts'], ['contacts', undefined], ['vendors', 'vendors'], ['customers', 'customers']];

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const chosen = LISTS.filter(([flag]) => typeof args[flag] === 'string');
  if (!args.url || chosen.length === 0) {
    console.error('usage: upload-books-reference.js --url <console origin> (--token-file <file> | CONSOLE_TOKEN env | --proxy-auth) [--org <id>] [--accounts f] [--contacts f] [--vendors f] [--customers f]');
    process.exit(2);
  }
  const proxyAuth = args['proxy-auth'] === true || (process.env.CONSOLE_AUTH ?? '').trim() === 'proxy';
  let token = '';
  if (!proxyAuth) token = args['token-file'] ? (await readFile(args['token-file'], 'utf8')).trim() : (process.env.CONSOLE_TOKEN ?? '').trim();
  if (!proxyAuth && !token) { console.error('no token: pass --token-file, set CONSOLE_TOKEN, or use --proxy-auth when the egress proxy injects the bearer'); process.exit(2); }

  const files = [];
  for (const [flag, kind] of chosen) {
    files.push({ name: path.basename(args[flag]), kind, content: (await readFile(args[flag])).toString('base64') });
  }
  const headers = { 'content-type': 'application/json', ...(proxyAuth ? {} : { authorization: `Bearer ${token}` }), 'x-correlation-id': `books-ref-${Date.now()}` };
  const body = { files, ...(typeof args.org === 'string' ? { books_org_id: args.org } : {}) };
  const res = await fetch(`${args.url.replace(/\/$/, '')}/api/books-reference`, { method: 'POST', headers, body: JSON.stringify(body) });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) { console.error(`upload refused: HTTP ${res.status} ${JSON.stringify(out)}`); process.exit(1); }
  console.log(JSON.stringify(out.reference, null, 2));
}

main().catch((e) => { console.error(e.message); process.exit(1); });
