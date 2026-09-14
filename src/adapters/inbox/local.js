// Local-folder inbox adapter. See CONTRACTS.md §I, DATA_CONTRACT.md §1.
// Layout: <root>/<branch_code>/<extraction_run_id>/manifest.json + files.
import { readdir, readFile, stat, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';

export async function openInbox(opts = {}) {
  const root = opts.root ?? process.env.INBOX_LOCAL_PATH ?? './var/inbox';

  return {
    /**
     * -> [{ inboxRef, branchCode, runId, files: [{name, size}] }]
     * Only COMPLETE folders: manifest.json present AND every file it lists exists.
     * Folders already carrying a `.picked-by-*` marker are skipped.
     */
    async listRuns() {
      const runs = [];
      let branchEntries;
      try {
        branchEntries = await readdir(root, { withFileTypes: true });
      } catch {
        return runs;
      }

      for (const branchEntry of branchEntries) {
        if (!branchEntry.isDirectory()) continue;
        const branchCode = branchEntry.name;
        const branchPath = path.join(root, branchCode);

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

          let contents;
          try {
            contents = await readdir(runPath);
          } catch {
            continue;
          }

          if (contents.some((name) => name.startsWith('.picked-by-'))) continue;
          if (!contents.includes('manifest.json')) continue;

          let manifest;
          try {
            manifest = JSON.parse(await readFile(path.join(runPath, 'manifest.json'), 'utf8'));
          } catch {
            continue; // unparsable manifest -> not a complete/valid run yet
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
      return readFile(path.join(root, inboxRef, fileName));
    },

    /** Writes `.picked-by-<workerId>` atomically (temp write + rename). */
    async markPicked(inboxRef, { workerId }) {
      const dir = path.join(root, inboxRef);
      const finalPath = path.join(dir, `.picked-by-${workerId}`);
      const tmpPath = path.join(dir, `.picked-by-${workerId}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      await writeFile(tmpPath, JSON.stringify({ workerId, pickedAt: new Date().toISOString() }));
      await rename(tmpPath, finalPath);
      return finalPath;
    },
  };
}
