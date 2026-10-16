// One WorkDrive sync: list the branch folders, pull files new or changed since the last pull into
// `blobs`, plan the branches that changed (scripts/branch-ready.js in a working folder), and put
// the tracker (and each planned branch's report) back into WorkDrive. Used by the CLI
// (scripts/workdrive-sync.js, working folder = the repo) and the AppSail service
// (src/server/routes/workdrive.js, working folder = a temporary one fed from Stratus).
// Nothing here posts to Books.
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { BRANCH_FOLDER, pickFiles, toPull, trackerRow, localName } from './sync.js';
import { unzip } from '../sources/ecogreen/xlsx.js';

const STATE = 'var/workdrive/state.json';
const BRANCH_READY = fileURLToPath(new URL('../../scripts/branch-ready.js', import.meta.url));
// Shared mapping inputs, read from the WorkDrive config folder when one is named.
const CONFIG_FILES = [
  { re: /^chart_of_accounts.*\.csv$/i, path: 'var/books-ref/coa.csv' },
  { re: /^accounts_master\.csv$/i, path: 'var/txn/accounts_master.csv' },
];

const csvCell = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export const trackerCsv = (rows) => (rows.length ? [Object.keys(rows[0]), ...rows.map((r) => Object.values(r))].map((r) => r.map(csvCell).join(',')).join('\n') + '\n' : '');
const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 16);

/** Branch folders at any depth (up to 4) under the root: [{ branch, region, folderId, files }] */
export async function findBranches(wd, folderId, region = '', depth = 0) {
  const out = [];
  for (const it of (await wd.list(folderId)).filter((x) => x.isFolder)) {
    if (BRANCH_FOLDER.test(it.name)) out.push({ branch: it.name, region, folderId: it.id, files: await wd.list(it.id) });
    else if (depth < 3) out.push(...await findBranches(wd, it.id, region ? `${region}/${it.name}` : it.name, depth + 1));
  }
  return out;
}

/**
 * @param {object} o
 * @param o.wd             WorkDrive client (src/workdrive/client.js)
 * @param o.blobs          src/workdrive/blobs.js store
 * @param o.rootFolderId   folder watched
 * @param o.configFolderId optional folder holding the chart of accounts export + accounts_master.csv
 * @param o.workDir        folder plans run in (null: a temporary one, removed afterwards)
 * @param o.dryRun         list only
 * @param o.upload         write the tracker / reports back to WorkDrive (default true)
 * @param o.log            (message) => void
 */
export async function runSync({ wd, blobs, rootFolderId, configFolderId = null, workDir = null, dryRun = false, upload = true, log = () => {} }) {
  const state = JSON.parse((await blobs.get(STATE))?.toString() ?? '{"files":{},"branches":{},"readiness":{}}');
  state.files ??= {}; state.branches ??= {}; state.readiness ??= {};
  log('listing WorkDrive branch folders…');
  const branches = (await findBranches(wd, rootFolderId)).map((b) => ({ ...b, picked: pickFiles(b.files) }));
  const pulls = toPull(branches, state);
  log(`${branches.length} branch folders; ${pulls.length} files new or changed`);
  for (const p of pulls) log(`  ${dryRun ? 'would pull' : 'pull'} ${p.branch} ${p.kind}: ${p.file.name} (${(p.file.size / 1e6).toFixed(2)} MB)`);
  const summary = { branches: branches.length, pulled: [], planned: [], tracker: [] };
  if (dryRun) return summary;

  const changed = new Set();
  for (const p of pulls) {
    let bytes = await wd.download(p.file);
    if (/\.zip$/i.test(p.file.name)) {
      const csv = [...unzip(bytes)].filter(([n]) => /\.csv$/i.test(n)).sort((a, b) => b[1].length - a[1].length)[0];
      if (!csv) { log(`  ${p.branch}: ${p.file.name} holds no .csv; skipped`); continue; }
      bytes = csv[1];
    }
    await blobs.put(p.path, bytes);
    state.files[p.file.id] = { branch: p.branch, kind: p.kind, name: p.file.name, modified: p.file.modified, size: p.file.size, path: p.path };
    state.branches[p.branch] = { pulledAt: stamp() };
    await blobs.put(STATE, Buffer.from(JSON.stringify(state, null, 2))); // a stopped run resumes where it was
    changed.add(p.branch);
    summary.pulled.push(`${p.branch} ${p.kind}`);
  }

  const plannable = branches.filter((b) => changed.has(b.branch) && b.picked.ledger);
  if (plannable.length) {
    const dir = workDir ?? mkdtempSync(join(tmpdir(), 'wd-plan-'));
    try {
      if (configFolderId) {
        const cfg = await wd.list(configFolderId);
        for (const c of CONFIG_FILES) {
          const f = cfg.filter((x) => !x.isFolder && c.re.test(x.name)).sort((a, b) => b.modified - a.modified)[0];
          if (f) { mkdirSync(dirname(join(dir, c.path)), { recursive: true }); writeFileSync(join(dir, c.path), await wd.download(f)); }
        }
      }
      for (const b of plannable) {
        if (!workDir) {
          // materialise the branch's pulled files
          for (const kind of Object.keys(b.picked)) {
            const bytes = await blobs.get(localName(b.branch, kind));
            if (bytes) { mkdirSync(dirname(join(dir, localName(b.branch, kind))), { recursive: true }); writeFileSync(join(dir, localName(b.branch, kind)), bytes); }
          }
        }
        log(`preparing ${b.branch}…`);
        const run = spawnSync(process.execPath, [BRANCH_READY, '--branches', b.branch], { cwd: dir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
        const ready = existsSync(join(dir, 'var/txn/readiness.json')) ? JSON.parse(readFileSync(join(dir, 'var/txn/readiness.json'), 'utf8')) : {};
        state.readiness[b.branch] = ready[b.branch] ?? { status: 'PLAN ERROR', problems: (run.stderr || '').trim().split('\n').pop() ?? '' };
        const report = join(dir, 'var/txn', b.branch, 'report.md');
        if (existsSync(report)) {
          await blobs.put(`var/txn/${b.branch}/report.md`, readFileSync(report));
          if (upload) await wd.upload(b.folderId, `Migration Report ${b.branch}.md`, readFileSync(report));
        }
        if (!workDir) rmSync(join(dir, `var/raw${b.branch}`), { recursive: true, force: true });
        summary.planned.push(b.branch);
      }
    } finally {
      if (!workDir) rmSync(dir, { recursive: true, force: true });
    }
    await blobs.put(STATE, Buffer.from(JSON.stringify(state, null, 2)));
  }

  const now = stamp();
  summary.tracker = branches.sort((a, b) => a.branch.localeCompare(b.branch)).map((b) => trackerRow(b, state.readiness[b.branch], state, now));
  const csv = trackerCsv(summary.tracker);
  await blobs.put('var/workdrive/tracker.csv', Buffer.from(csv));
  if (upload) {
    await wd.upload(rootFolderId, 'Migration Tracker.csv', csv);
    log('Migration Tracker.csv updated in WorkDrive');
  }
  return summary;
}
