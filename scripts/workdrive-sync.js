#!/usr/bin/env node
// Pull new or changed branch extracts from WorkDrive, prepare them and update the tracker
// (src/workdrive/job.js) — the same job the AppSail service runs on its schedule, here against
// this checkout's var/ folder.
//
//   node scripts/workdrive-sync.js [--dry-run] [--no-upload] [--every <minutes>] [--env .env.workdrive]
//
// Environment (never printed):
//   WORKDRIVE_FOLDER_ID         the root watched (e.g. branch-extract_data); branch folders are
//                               named by branch code at any depth under it (tripura/461, …)
//   WORKDRIVE_CONFIG_FOLDER_ID  optional: folder with the chart of accounts export
//                               (Chart_of_Accounts*.csv) and accounts_master.csv
//   WORKDRIVE_REFRESH_TOKEN     scopes WorkDrive.files.READ,WorkDrive.files.CREATE
//   WORKDRIVE_CLIENT_ID / _SECRET   (default: BOOKS_CLIENT_ID / BOOKS_CLIENT_SECRET)
//   WORKDRIVE_API_BASE (https://www.zohoapis.in/workdrive/api/v1), WORKDRIVE_ACCOUNTS_BASE
// Pulled files land in var/raw<br>/…, state in var/workdrive/state.json, plans in var/txn/<br>;
// "Migration Tracker.csv" goes to the root folder and "Migration Report <br>.md" to each
// planned branch's folder. Nothing is posted to Books.
import { readFileSync, existsSync } from 'node:fs';
import { workdriveConfig, workdriveClient } from '../src/workdrive/client.js';
import { localBlobs } from '../src/workdrive/blobs.js';
import { runSync } from '../src/workdrive/job.js';

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

function loadEnv(path) {
  if (!path || !existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

async function once(o) {
  const config = workdriveConfig();
  const summary = await runSync({
    wd: workdriveClient(config), blobs: localBlobs('.'), rootFolderId: config.rootFolderId,
    configFolderId: process.env.WORKDRIVE_CONFIG_FOLDER_ID || null, workDir: '.',
    dryRun: o['dry-run'] === 'true', upload: o['no-upload'] !== 'true', log,
  });
  const by = (s) => summary.tracker.filter((r) => r.status === s).length;
  if (summary.tracker.length) log(`tracker: ${summary.tracker.length} branches – READY ${by('READY')}, WAITING FOR OPENING ${by('WAITING FOR OPENING')}, FIX ${by('FIX')}, WAITING FOR FILES ${by('WAITING FOR FILES')}`);
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
