// Read-only "bundled fixtures" inbox adapter (CONTRACTS.md §I). Used ONLY by the
// Development-only synthetic seed endpoint (src/server/routes/dev.js) so a deployed
// AppSail instance can demo the full pipeline without any external inbox integration and
// without writing to its (write-restricted) working directory.
//
// Reads directly from `fixtures/synthetic/branch-<code>/<run>/*` — the same fixtures
// scripts/seed-fixtures.js copies into a local inbox for dev/CI — instead of copying them
// anywhere first. `markPicked()` is a deliberate no-op: this adapter must never write a
// marker file (or anything else) next to the bundled fixtures, so the same seed data is
// re-readable on every request, every instance, and every redeploy.
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');
const DEFAULT_FIXTURES_ROOT = path.join(PROJECT_ROOT, 'fixtures', 'synthetic');

function branchDirName(branchCode) {
  return `branch-${branchCode}`;
}

export async function openInbox(opts = {}) {
  const root = opts.root ?? DEFAULT_FIXTURES_ROOT;

  return {
    /** -> [{ inboxRef, branchCode, runId, files: [{name, size}] }], same shape as
     * local.js's listRuns() (COMPLETE folders only: manifest.json present AND every file
     * it lists exists) — `inboxRef` stays `<branchCode>/<runId>` even though the on-disk
     * layout is `branch-<branchCode>/<runId>` (readFile() below translates it back). */
    async listRuns() {
      const runs = [];
      let branchEntries;
      try {
        branchEntries = await readdir(root, { withFileTypes: true });
      } catch {
        return runs;
      }

      for (const branchEntry of branchEntries) {
        if (!branchEntry.isDirectory() || !branchEntry.name.startsWith('branch-')) continue;
        const branchCode = branchEntry.name.slice('branch-'.length);
        const branchPath = path.join(root, branchEntry.name);

        let runEntries;
        try {
          runEntries = await readdir(branchPath, { withFileTypes: true });
        } catch {
          continue;
        }

        for (const runEntry of runEntries) {
          if (!runEntry.isDirectory()) continue;
          const runId = runEntry.name;
          const runPath = path.join(branchPath, runId);

          let manifest;
          try {
            manifest = JSON.parse(await readFile(path.join(runPath, 'manifest.json'), 'utf8'));
          } catch {
            continue; // unparsable/missing manifest -> not a complete run
          }

          const declaredFiles = Array.isArray(manifest.files) ? manifest.files : [];
          if (declaredFiles.length === 0) continue;

          const files = [];
          let complete = true;
          for (const f of declaredFiles) {
            const fileName = f.file_name;
            if (!fileName) {
              complete = false;
              break;
            }
            try {
              const st = await stat(path.join(runPath, fileName));
              files.push({ name: fileName, size: st.size });
            } catch {
              complete = false;
              break;
            }
          }
          if (!complete) continue;

          runs.push({ inboxRef: `${branchCode}/${runId}`, branchCode, runId, files });
        }
      }

      return runs;
    },

    async readFile(inboxRef, fileName) {
      const slash = inboxRef.indexOf('/');
      const branchCode = inboxRef.slice(0, slash);
      const runId = inboxRef.slice(slash + 1);
      return readFile(path.join(root, branchDirName(branchCode), runId, fileName));
    },

    // Deliberate no-op: see module header. Never writes anything under `root`.
    async markPicked() {
      return null;
    },
  };
}
