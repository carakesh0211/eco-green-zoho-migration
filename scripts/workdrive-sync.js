#!/usr/bin/env node
// Watch the WorkDrive branch folders and pull new or changed branch extracts into the migration
// app, then prepare them (scripts/branch-ready.js) and put a tracker back in WorkDrive.
//
//   node scripts/workdrive-sync.js [--dry-run] [--no-upload] [--every <minutes>] [--env .env.workdrive]
//
// Environment (never printed):
//   WORKDRIVE_FOLDER_ID      the root watched (e.g. branch-extract_data); branch folders are named
//                            by branch code at any depth under it (tripura/461, banglore/...)
//   WORKDRIVE_REFRESH_TOKEN  refresh token with scopes WorkDrive.files.READ,WorkDrive.files.CREATE
//   WORKDRIVE_CLIENT_ID / _SECRET   (default: BOOKS_CLIENT_ID / BOOKS_CLIENT_SECRET)
//   WORKDRIVE_API_BASE (https://www.zohoapis.in/workdrive/api/v1), WORKDRIVE_ACCOUNTS_BASE
//
// Each run: list every branch folder; download files that are new or changed since the last pull
// (var/workdrive/state.json, keyed by WorkDrive file id + modified time + size) into
// var/raw<br>/...; plan the branches that changed; write "Migration Tracker.csv" into the root
// folder (one row per branch: files received, missing, status, our / Smart Pharma vouchers,
// problems) and var/workdrive/tracker.csv. Nothing is posted to Books.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { workdriveConfig, workdriveClient } from '../src/workdrive/client.js';
import { BRANCH_FOLDER, pickFiles, toPull, trackerRow } from '../src/workdrive/sync.js';
import { unzip } from '../src/sources/ecogreen/xlsx.js';

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error(`unexpected argument ${a}`);
    opts[a.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
  }
  return opts;
}
const log = (m) => process.stderr.write(`[${new Date().toISOString().slice(0, 19).replace('T', ' ')}] ${m}\n`);
const csvCell = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const toCsv = (rows) => (rows.length ? [Object.keys(rows[0]), ...rows.map((r) => Object.values(r))].map((r) => r.map(csvCell).join(',')).join('\n') + '\n' : '');
const STATE = 'var/workdrive/state.json';

function loadEnv(path) {
  if (!path || !existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

/** Branch folders under the root: [{ branch, region, folderId, files }] */
async function findBranches(wd, folderId, region = '', depth = 0) {
  const items = await wd.list(folderId);
  const out = [];
  for (const it of items.filter((x) => x.isFolder)) {
    if (BRANCH_FOLDER.test(it.name)) out.push({ branch: it.name, region, folderId: it.id, files: await wd.list(it.id) });
    else if (depth < 3) out.push(...await findBranches(wd, it.id, region ? `${region}/${it.name}` : it.name, depth + 1));
  }
  return out;
}

async function once(o) {
  const wd = workdriveClient(workdriveConfig());
  const root = workdriveConfig().rootFolderId;
  const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : { files: {}, branches: {} };
  log('listing WorkDrive branch folders…');
  const branches = (await findBranches(wd, root)).map((b) => ({ ...b, picked: pickFiles(b.files) }));
  const pulls = toPull(branches, state);
  log(`${branches.length} branch folders; ${pulls.length} files new or changed`);
  for (const p of pulls) log(`  ${o['dry-run'] ? 'would pull' : 'pull'} ${p.branch} ${p.kind}: ${p.file.name} (${(p.file.size / 1e6).toFixed(2)} MB)`);
  if (o['dry-run']) return;

  const changed = new Set();
  for (const p of pulls) {
    let bytes = await wd.download(p.file);
    if (/\.zip$/i.test(p.file.name)) {
      const csv = [...unzip(bytes)].filter(([n]) => /\.csv$/i.test(n)).sort((a, b) => b[1].length - a[1].length)[0];
      if (!csv) { log(`  ${p.branch}: ${p.file.name} holds no .csv; skipped`); continue; }
      bytes = csv[1];
    }
    mkdirSync(dirname(p.path), { recursive: true });
    writeFileSync(p.path, bytes);
    state.files[p.file.id] = { branch: p.branch, kind: p.kind, name: p.file.name, modified: p.file.modified, size: p.file.size, path: p.path };
    state.branches[p.branch] = { pulledAt: new Date().toISOString().replace('T', ' ').slice(0, 16) };
    changed.add(p.branch);
  }
  mkdirSync(dirname(STATE), { recursive: true });
  writeFileSync(STATE, JSON.stringify(state, null, 2));

  const plannable = [...changed].filter((b) => existsSync(`var/raw${b}/txn/ledger_v2.xlsx`));
  if (plannable.length) {
    log(`preparing ${plannable.join(', ')}…`);
    const run = spawnSync(process.execPath, [fileURLToPath(new URL('./branch-ready.js', import.meta.url)), '--branches', plannable.join(',')], { encoding: 'utf8', stdio: ['ignore', 'ignore', 'inherit'] });
    if (![0, 2].includes(run.status)) log(`branch-ready exited ${run.status}`);
  }

  const readiness = existsSync('var/txn/readiness.json') ? JSON.parse(readFileSync('var/txn/readiness.json', 'utf8')) : {};
  const now = new Date().toISOString().replace('T', ' ').slice(0, 16);
  const rows = branches.sort((a, b) => a.branch.localeCompare(b.branch)).map((b) => trackerRow(b, readiness[b.branch], state, now));
  const csv = toCsv(rows);
  writeFileSync('var/workdrive/tracker.csv', csv);
  if (o['no-upload'] !== 'true') {
    await wd.upload(root, 'Migration Tracker.csv', csv);
    log('Migration Tracker.csv updated in WorkDrive');
  }
  const by = (s) => rows.filter((r) => r.status === s).length;
  log(`tracker: ${rows.length} branches – READY ${by('READY')}, WAITING FOR OPENING ${by('WAITING FOR OPENING')}, FIX ${by('FIX')}, WAITING FOR FILES ${by('WAITING FOR FILES')}`);
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  loadEnv(o.env ?? '.env.workdrive');
  const every = Number(o.every ?? 0);
  for (;;) {
    try { await once(o); } catch (err) { log(`sync failed: ${err.message}`); if (!every) process.exitCode = 1; }
    if (!every) return;
    log(`next check in ${every} min`);
    await new Promise((r) => setTimeout(r, every * 60_000));
  }
}

main();
