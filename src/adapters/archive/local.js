// Local-folder immutable archive adapter. See CONTRACTS.md §R.
// uri shape: local://<branch>/<run>/<sha256>/<fileName>
// On-disk layout mirrors the uri exactly: <root>/<branch>/<run>/<sha256>/<fileName>.
import { readdir, readFile, writeFile, rename, chmod, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { sha256Bytes } from '../../core/hash.js';

export class ImmutableConflictError extends Error {
  constructor(uri) {
    super(`Archive immutability conflict: ${uri} already holds different bytes`);
    this.code = 'IMMUTABLE_CONFLICT';
    this.uri = uri;
  }
}

export class ArchiveShaMismatchError extends Error {
  constructor() {
    super('Provided sha256 does not match the bytes being archived');
    this.code = 'ARCHIVE_SHA_MISMATCH';
  }
}

export class InvalidArchiveUriError extends Error {
  constructor(uri) {
    super(`Not a local:// archive uri: ${uri}`);
    this.code = 'INVALID_ARCHIVE_URI';
  }
}

function buildUri(branchCode, runId, sha256, fileName) {
  return `local://${branchCode}/${runId}/${sha256}/${fileName}`;
}

function parseUri(uri) {
  const m = typeof uri === 'string' && uri.match(/^local:\/\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/);
  if (!m) throw new InvalidArchiveUriError(uri);
  const [, branchCode, runId, sha256, fileName] = m;
  return { branchCode, runId, sha256, fileName };
}

async function pathExists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

export async function openArchive(opts = {}) {
  const root = opts.root ?? process.env.ARCHIVE_LOCAL_PATH ?? './var/archive';

  return {
    /**
     * put({ runId, branchCode, fileName, bytes, sha256 }) -> archiveUri
     * Immutability: same (branch, run, fileName) with a different sha256 already
     * present -> IMMUTABLE_CONFLICT. Same sha256 -> idempotent no-op, same uri.
     */
    async put({ runId, branchCode, fileName, bytes, sha256 }) {
      const actualSha = sha256Bytes(bytes);
      if (sha256 && sha256 !== actualSha) throw new ArchiveShaMismatchError();
      const sha = sha256 ?? actualSha;
      const uri = buildUri(branchCode, runId, sha, fileName);

      const runDir = path.join(root, branchCode, runId);
      let siblingShaDirs = [];
      try {
        siblingShaDirs = await readdir(runDir);
      } catch {
        siblingShaDirs = [];
      }
      for (const dirName of siblingShaDirs) {
        if (dirName === sha) continue;
        if (await pathExists(path.join(runDir, dirName, fileName))) {
          throw new ImmutableConflictError(uri);
        }
      }

      const targetDir = path.join(runDir, sha);
      const targetPath = path.join(targetDir, fileName);
      if (await pathExists(targetPath)) {
        return uri; // idempotent no-op: identical bytes already archived
      }

      await mkdir(targetDir, { recursive: true });
      const tmpPath = path.join(targetDir, `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      await writeFile(tmpPath, bytes);
      await rename(tmpPath, targetPath);
      try {
        await chmod(targetPath, 0o444);
      } catch {
        /* best-effort: some filesystems (or CI runners) may not honour chmod */
      }
      return uri;
    },

    async exists(archiveUri) {
      const { branchCode, runId, sha256, fileName } = parseUri(archiveUri);
      return pathExists(path.join(root, branchCode, runId, sha256, fileName));
    },

    async get(archiveUri) {
      const { branchCode, runId, sha256, fileName } = parseUri(archiveUri);
      return readFile(path.join(root, branchCode, runId, sha256, fileName));
    },
  };
}
