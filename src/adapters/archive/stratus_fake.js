// In-memory, Catalyst-shaped fake of the Stratus SDK surface the archive adapter uses:
// `app.stratus().bucket(name)` -> putObject/getObject/headObject/listPagedObjects. Used
// only in tests (offline, no network) — see test/archive_stratus.test.js. Mirrors
// the zcatalyst-sdk-node 3.4.0 typings (bucket.d.ts, utils/pojo/stratus.d.ts) plus
// versioning, since Stratus buckets keep object versions. The listPagedObjects shape was
// re-checked against live Development Stratus on 2026-09-15 (see stratus.js header).
import { Readable } from 'node:stream';

function fakeError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

async function toBuffer(body) {
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === 'string') return Buffer.from(body);
  const chunks = [];
  for await (const chunk of body) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function makeBucketApi(name, objects, bucketMetas) {
  let versionCounter = 0;
  return {
    getName() {
      return name;
    },
    // Mirrors Bucket.getDetails(): Promise<IStratusBucket> (lib/stratus/bucket.d.ts).
    // Only buckets created via `fake.createBucket(name, meta)` have metadata registered;
    // any other bucket name throws. The real SDK's error code for "getDetails() on a
    // bucket the caller can't/doesn't see" is not documented in the typings — BUCKET_NOT_FOUND
    // is an assumed code here (mirrors the shape stratus.js's headBucket fallback uses),
    // not a value confirmed against the live API.
    async getDetails() {
      const meta = bucketMetas.get(name);
      if (!meta) throw fakeError('BUCKET_NOT_FOUND', `Bucket not found or has no registered details: ${name}`);
      return {
        bucket_name: name,
        bucket_meta: {
          versioning: meta.versioning,
          caching: { status: meta.caching },
          encryption: meta.encryption,
          audit_consent: meta.audit,
        },
      };
    },
    async putObject(key, body, options = {}) {
      const bytes = await toBuffer(body);
      const versionId = String(++versionCounter);
      const entry = objects.get(key) ?? { versions: [] };
      entry.versions.push({ versionId, bytes, contentType: options.contentType, createdAt: new Date().toISOString() });
      objects.set(key, entry);
      return true;
    },
    async getObject(key, { versionId } = {}) {
      const entry = objects.get(key);
      if (!entry || !entry.versions.length) throw fakeError('OBJECT_NOT_FOUND', `Object not found: ${key}`);
      const version = versionId ? entry.versions.find((v) => v.versionId === versionId) : entry.versions[entry.versions.length - 1];
      if (!version) throw fakeError('OBJECT_NOT_FOUND', `Object version not found: ${key}@${versionId}`);
      return Readable.from([version.bytes]);
    },
    async headObject(key, { versionId, throwErr = false } = {}) {
      const entry = objects.get(key);
      const exists = !!entry && (versionId ? entry.versions.some((v) => v.versionId === versionId) : entry.versions.length > 0);
      if (!exists && throwErr) throw fakeError('OBJECT_NOT_FOUND', `Object not found: ${key}`);
      return exists;
    },
    // Mirrors IStratusPagedObjectOptions -> IStratusObjects exactly (lib/utils/pojo/stratus.d.ts).
    // Unknown option names throw so a caller drifting from the real contract (as
    // stratus.js once did with `nextToken`) fails here instead of silently on live Stratus.
    async listPagedObjects(options = {}) {
      const allowed = new Set(['prefix', 'continuationToken', 'maxKeys', 'folderListing', 'orderBy']);
      for (const name of Object.keys(options)) {
        if (!allowed.has(name)) throw fakeError('INVALID_OPTION', `listPagedObjects: unknown option '${name}' (real SDK accepts ${[...allowed].join(', ')})`);
      }
      const { prefix = '', continuationToken, maxKeys, orderBy = 'asc' } = options;
      if (!['asc', 'desc'].includes(orderBy)) throw fakeError('INVALID_OPTION', 'Invalid value for orderBy. Use "asc" or "desc".');
      const allKeys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
      if (orderBy === 'desc') allKeys.reverse();
      const start = continuationToken ? Number(continuationToken) : 0;
      const max = Number(maxKeys) || 1000;
      const page = allKeys.slice(start, start + max);
      const truncated = start + max < allKeys.length;
      const result = {
        key_count: page.length,
        max_keys: max,
        truncated: String(truncated),
        // bucket.js wraps each raw entry as a StratusObject: the details live under keyDetails.
        contents: page.map((k) => {
          const entry = objects.get(k);
          const latest = entry.versions[entry.versions.length - 1];
          return { keyDetails: { key: k, size: latest.bytes.length, version_id: latest.versionId, content_type: latest.contentType ?? 'application/octet-stream', last_modified: latest.createdAt } };
        }),
      };
      if (truncated) result.next_continuation_token = String(start + max);
      return result;
    },
    // --- test-only introspection, not part of the real SDK surface ---
    _versionCount(key) {
      return objects.get(key)?.versions.length ?? 0;
    },
    _corrupt(key, bytes) {
      const entry = objects.get(key);
      if (!entry || !entry.versions.length) throw fakeError('OBJECT_NOT_FOUND', `Object not found: ${key}`);
      entry.versions[entry.versions.length - 1].bytes = bytes;
    },
  };
}

export function createStratusFake() {
  const buckets = new Map(); // bucketName -> Map<key, { versions: [...] }>
  const bucketMetas = new Map(); // bucketName -> { protected, encryption, versioning, audit, caching }

  function objectsFor(bucketName) {
    if (!buckets.has(bucketName)) buckets.set(bucketName, new Map());
    return buckets.get(bucketName);
  }

  const app = {
    stratus() {
      return {
        async headBucket(bucketName) {
          return buckets.has(bucketName);
        },
        bucket(bucketName) {
          return makeBucketApi(bucketName, objectsFor(bucketName), bucketMetas);
        },
        async listBuckets() {
          return [...buckets.keys()].map((name) => makeBucketApi(name, objectsFor(name), bucketMetas));
        },
      };
    },
  };

  /**
   * createBucket(name, meta) — registers realistic IStratusBucket-shaped metadata so
   * `bucket(name).getDetails()` resolves instead of throwing BUCKET_NOT_FOUND, and marks
   * the bucket as existing for `headBucket()`/`listBuckets()`. Mirrors the live bucket
   * `ecogreen-pilot-evidence-dev` created via the console (docs/CATALYST_REFERENCES.md
   * "Stratus" row: protected, encryption on, versioning on, audit on, caching disabled) —
   * used as the default `meta` here.
   *
   * Note: `meta.protected` is stored for fake realism only. The real IStratusBucket /
   * IStratusBucketMeta typings (lib/utils/pojo/stratus.d.ts) have no 'protected'/'type'
   * field on getDetails()'s response, so `getDetails()` above does not surface it, and
   * stratus.js's verify() never reads it either.
   */
  function createBucket(name, meta = {}) {
    objectsFor(name); // ensure the bucket "exists" for headBucket()/listBuckets()
    bucketMetas.set(name, {
      protected: meta.protected ?? true,
      encryption: meta.encryption ?? true,
      versioning: meta.versioning ?? true,
      audit: meta.audit ?? true,
      caching: meta.caching ?? 'Disabled',
    });
  }

  return { app, createBucket };
}
