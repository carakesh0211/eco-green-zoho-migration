// Catalyst Stratus archive adapter. See CONTRACTS.md §R, docs/CATALYST_REFERENCES.md, and
// the SDK typings under stratus/bucket.d.ts + stratus/index.d.ts (zcatalyst-sdk-node 3.4.0).
//
// This module never imports `zcatalyst-sdk-node` — it is only present at runtime inside
// Catalyst. Instead it takes an injected `app` (a real Catalyst app: `.stratus()`) or
// `transport` (anything exposing the same surface — exactly the shape stratus_fake.js's
// `{ app }` exposes, so tests inject the fake as either option) plus `bucketName` (or
// STRATUS_BUCKET env var). With neither `app` nor `transport`, every method throws
// NOT_IMPLEMENTED lazily (there is no live Catalyst connection available outside a
// Catalyst runtime in this pilot) — mirroring this file's previous documented-stub shape.
//
// Object key = `<branchCode>/<runId>/<sha256>/<fileName>` — content-addressed, exactly
// like local.js's on-disk layout, just against Stratus instead of disk (per this file's
// original porting note). Object key is capped at 255 chars by the Catalyst API (see
// docs/CATALYST_REFERENCES.md) -> KEY_TOO_LONG if exceeded.
//
// ASSUMPTIONS (docs/CATALYST_REFERENCES.md has no confirmed field names for
// `IStratusObjects`/`listPagedObjects`'s resolved value — the typings only name the
// return type, not its shape): a paged listing resolves to
// `{ objects: [{ object_key }], more_records, next_token }`, mirroring the
// Table.getPagedRows() pagination shape (`more_records`/`next_token`) used elsewhere in
// this SDK. If real Stratus differs (e.g. `data` instead of `objects`, or `key` instead of
// `object_key`), the immutability-conflict scan below also tries those field names.
import { sha256Bytes } from '../../core/hash.js';
import { ImmutableConflictError, ArchiveShaMismatchError, InvalidArchiveUriError } from './local.js';

export class NotImplementedError extends Error {
  constructor(message) {
    super(message);
    this.code = 'NOT_IMPLEMENTED';
  }
}

export class KeyTooLongError extends Error {
  constructor(key) {
    super(`Stratus object key exceeds 255 characters (${key.length}): ${key}`);
    this.code = 'KEY_TOO_LONG';
    this.key = key;
  }
}

export class ArchiveIntegrityError extends Error {
  constructor(uri) {
    super(`Downloaded bytes do not match the sha256 embedded in the archive key: ${uri}`);
    this.code = 'ARCHIVE_INTEGRITY';
    this.uri = uri;
  }
}

export class MissingBucketNameError extends Error {
  constructor() {
    super('Stratus archive adapter requires a bucketName (or STRATUS_BUCKET env var)');
    this.code = 'MISSING_BUCKET_NAME';
  }
}

function buildUri(bucketName, branchCode, runId, sha256, fileName) {
  return `stratus://${bucketName}/${branchCode}/${runId}/${sha256}/${fileName}`;
}

function parseUri(uri) {
  const m = typeof uri === 'string' && uri.match(/^stratus:\/\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/);
  if (!m) throw new InvalidArchiveUriError(uri);
  const [, bucketName, branchCode, runId, sha256, fileName] = m;
  return { bucketName, branchCode, runId, sha256, fileName };
}

async function streamToBuffer(readable) {
  if (Buffer.isBuffer(readable)) return readable;
  const chunks = [];
  for await (const chunk of readable) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function stubArchive() {
  const stub = () => {
    throw new NotImplementedError(
      'Catalyst Stratus archive adapter needs an injected `app` (a Catalyst app) or ' +
        '`transport` (e.g. stratus_fake.js\'s { app }). Neither was provided, and there is ' +
        'no live Catalyst connection available outside a Catalyst runtime in this pilot. ' +
        'See src/adapters/archive/stratus.js.'
    );
  };
  return {
    async put() {
      return stub();
    },
    async exists() {
      return stub();
    },
    async get() {
      return stub();
    },
  };
}

export async function openArchive({ app, transport, bucketName } = {}) {
  const source = app ?? transport;
  if (!source) return stubArchive();

  const resolvedBucketName = bucketName ?? process.env.STRATUS_BUCKET;
  if (!resolvedBucketName) throw new MissingBucketNameError();
  const bucket = source.stratus().bucket(resolvedBucketName);

  return {
    /** put({ runId, branchCode, fileName, bytes, sha256 }) -> archiveUri. See CONTRACTS.md §R. */
    async put({ runId, branchCode, fileName, bytes, sha256 }) {
      const actualSha = sha256Bytes(bytes);
      if (sha256 && sha256 !== actualSha) throw new ArchiveShaMismatchError();
      const sha = sha256 ?? actualSha;
      const key = `${branchCode}/${runId}/${sha}/${fileName}`;
      const uri = buildUri(resolvedBucketName, branchCode, runId, sha, fileName);
      if (key.length > 255) throw new KeyTooLongError(key);

      // Logical immutability: a DIFFERENT sha already archived under the same
      // (branch, run, fileName) -> conflict. Same sha -> idempotent no-op below, since the
      // key is content-addressed (identical key implies identical bytes by construction).
      const runPrefix = `${branchCode}/${runId}/`;
      let nextToken;
      do {
        const page = await bucket.listPagedObjects({ prefix: runPrefix, nextToken });
        const entries = page?.objects ?? page?.data ?? [];
        for (const entry of entries) {
          const objectKey = entry.object_key ?? entry.key ?? entry.Key;
          if (!objectKey) continue;
          const rel = objectKey.slice(runPrefix.length);
          const slashIdx = rel.indexOf('/');
          if (slashIdx === -1) continue;
          const existingSha = rel.slice(0, slashIdx);
          const existingFileName = rel.slice(slashIdx + 1);
          if (existingFileName !== fileName) continue;
          if (existingSha !== sha) throw new ImmutableConflictError(uri);
        }
        nextToken = page?.more_records ? page.next_token : undefined;
      } while (nextToken);

      const alreadyThere = await bucket.headObject(key);
      if (alreadyThere) return uri; // idempotent no-op: identical bytes already archived

      await bucket.putObject(key, bytes, { overwrite: false, contentType: 'application/octet-stream' });
      return uri;
    },

    async exists(archiveUri) {
      const { bucketName: uriBucket, branchCode, runId, sha256, fileName } = parseUri(archiveUri);
      if (uriBucket !== resolvedBucketName) throw new InvalidArchiveUriError(archiveUri);
      return bucket.headObject(`${branchCode}/${runId}/${sha256}/${fileName}`);
    },

    async get(archiveUri) {
      const { bucketName: uriBucket, branchCode, runId, sha256, fileName } = parseUri(archiveUri);
      if (uriBucket !== resolvedBucketName) throw new InvalidArchiveUriError(archiveUri);
      const key = `${branchCode}/${runId}/${sha256}/${fileName}`;
      const stream = await bucket.getObject(key);
      const bytes = await streamToBuffer(stream);
      if (sha256Bytes(bytes) !== sha256) throw new ArchiveIntegrityError(archiveUri);
      return bytes;
    },
  };
}
