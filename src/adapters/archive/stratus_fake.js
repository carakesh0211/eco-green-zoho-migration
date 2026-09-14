// In-memory, Catalyst-shaped fake of the Stratus SDK surface the archive adapter uses:
// `app.stratus().bucket(name)` -> putObject/getObject/headObject/listPagedObjects. Used
// only in tests (offline, no network) — see test/archive_stratus.test.js. Mirrors
// src/adapters/archive/stratus.js's documented assumptions (bucket.d.ts / index.d.ts,
// zcatalyst-sdk-node 3.4.0) plus versioning, since Stratus buckets keep object versions.
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

function makeBucketApi(name, objects) {
  let versionCounter = 0;
  return {
    getName() {
      return name;
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
    async listPagedObjects({ prefix = '', maxKeys = 1000, nextToken } = {}) {
      const allKeys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
      const start = nextToken ? Number(nextToken) : 0;
      const max = Number(maxKeys) || 1000;
      const page = allKeys.slice(start, start + max);
      const more = start + max < allKeys.length;
      const result = { objects: page.map((k) => ({ object_key: k })), more_records: more };
      if (more) result.next_token = String(start + max);
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
          return makeBucketApi(bucketName, objectsFor(bucketName));
        },
        async listBuckets() {
          return [...buckets.keys()].map((name) => makeBucketApi(name, objectsFor(name)));
        },
      };
    },
  };

  return { app };
}
