#!/usr/bin/env node
// scripts/import-run.js — upload ONE normalised run folder (output of
// scripts/normalise-ecogreen.js) to a console's POST /api/import/runs and wait for the job.
//
//   node scripts/import-run.js --dir var/inbox-real/461/<run-id> --url https://<console> \
//        (--token-file <path to a file holding the bearer token> | --proxy-auth) \
//        [--branch-name "Branch 461"] [--location LOC-461-UNMAPPED] [--cutover cutover.json]
//
// The token is read from a file (or env CONSOLE_TOKEN) and never printed; with --proxy-auth
// (or CONSOLE_AUTH=proxy) no token is read at all and the environment's egress proxy, which
// holds it as a network secret, adds the Authorization header. The run folder's
// manifest.json, transactions.csv, trial_balance.csv (and, when present,
// trial_balance_components.csv, allocations.csv, normalisation_report.json) are sent base64.
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    args[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  return args;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.dir || !args.url) {
    console.error('usage: import-run.js --dir <run folder> --url <console origin> (--token-file <file> | CONSOLE_TOKEN env | --proxy-auth) [--branch-name N] [--location L] [--cutover file.json]');
    process.exit(2);
  }
  // Token sources, in order: --token-json <file> + --token-id <id> (a JSON list/map of
  // {id, token} entries, e.g. an operator's local credential store), --token-file <file>
  // (plain text), or env CONSOLE_TOKEN. The token is never echoed.
  //
  // --proxy-auth (or CONSOLE_AUTH=proxy): no token in hand. The environment's egress
  // proxy holds the bearer token as a network secret and adds the Authorization header
  // itself on requests to the console host, so this process never sees the token and must
  // not send an Authorization header of its own (it would replace the injected one).
  const proxyAuth = args['proxy-auth'] === true || (process.env.CONSOLE_AUTH ?? '').trim() === 'proxy';
  let token = '';
  if (proxyAuth) {
    // nothing to read
  } else if (args['token-json']) {
    const j = JSON.parse(await readFile(args['token-json'], 'utf8'));
    const entries = Array.isArray(j) ? j : Object.entries(j).map(([k, v]) => (typeof v === 'object' ? { id: k, ...v } : { id: k, token: v }));
    const hit = entries.find((e) => (e.id ?? e.user_id) === args['token-id']);
    token = String(hit?.token ?? hit?.plaintext ?? '').trim();
  } else if (args['token-file']) {
    token = (await readFile(args['token-file'], 'utf8')).trim();
  } else {
    token = (process.env.CONSOLE_TOKEN ?? '').trim();
  }
  if (!proxyAuth && !token) { console.error('no token: pass --token-json + --token-id, --token-file, set CONSOLE_TOKEN, or use --proxy-auth when the egress proxy injects the bearer'); process.exit(2); }

  const files = {};
  for (const name of await readdir(args.dir)) {
    if (/\.(json|csv)$/i.test(name)) files[name] = (await readFile(path.join(args.dir, name))).toString('base64');
  }
  const manifest = JSON.parse(Buffer.from(files['manifest.json'], 'base64').toString('utf8'));
  const body = {
    branch: { branch_code: manifest.branch_code, branch_name: args['branch-name'], zoho_location_id: args.location },
    cutover: args.cutover ? JSON.parse(await readFile(args.cutover, 'utf8')) : undefined,
    files,
  };
  const authHeaders = proxyAuth ? {} : { authorization: `Bearer ${token}` };
  const headers = { 'content-type': 'application/json', ...authHeaders, 'x-correlation-id': `import-${Date.now()}` };
  const base = args.url.replace(/\/$/, '');
  const res = await fetch(`${base}/api/import/runs`, { method: 'POST', headers, body: JSON.stringify(body) });
  const started = await res.json().catch(() => ({}));
  if (res.status !== 202) { console.error(`import refused: HTTP ${res.status} ${JSON.stringify(started)}`); process.exit(1); }
  console.log(`job ${started.jobId} accepted for branch ${started.branchCode}, run ${started.runId}`);

  let last = '';
  for (let i = 0; i < 360; i += 1) {
    await sleep(5000);
    const r = await fetch(`${base}/api/import/runs/${started.jobId}`, { headers: authHeaders });
    const job = await r.json().catch(() => ({}));
    const line = `${job.stage} ${job.outcome ?? ''}`.trim();
    if (line !== last) { console.log(`  ${line}`); last = line; }
    if (job.stage === 'DONE') {
      const { bytes, requestedBy, ...rest } = job;
      console.log(JSON.stringify(rest, null, 2));
      process.exit(job.outcome === 'IMPORTED' ? 0 : 1);
    }
  }
  console.error('timed out waiting for the import job'); process.exit(1);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
