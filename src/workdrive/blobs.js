// Where the WorkDrive sync keeps what it pulled and its state: a local folder (CLI, tests) or
// the deployment's Stratus bucket under "workdrive/" (AppSail). Keys are relative paths such as
// var/raw461/txn/ledger_v2.xlsx; unlike the evidence archive these objects are overwritten when
// a branch re-uploads a file.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function localBlobs(root = '.') {
  return {
    kind: 'local',
    async get(key) {
      const p = join(root, key);
      return existsSync(p) ? readFileSync(p) : null;
    },
    async put(key, bytes) {
      const p = join(root, key);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, bytes);
    },
  };
}

async function streamToBuffer(stream) {
  if (Buffer.isBuffer(stream)) return stream;
  const chunks = [];
  for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks);
}

/** Stratus: `currentApp` resolves the Catalyst app (request-less inside AppSail). */
export function stratusBlobs({ currentApp, bucketName, prefix = 'workdrive/' }) {
  const bucket = async () => (await currentApp()).stratus().bucket(bucketName);
  return {
    kind: 'stratus',
    async get(key) {
      const b = await bucket();
      if (!(await b.headObject(prefix + key))) return null;
      return streamToBuffer(await b.getObject(prefix + key));
    },
    async put(key, bytes) {
      await (await bucket()).putObject(prefix + key, bytes, { overwrite: true, contentType: 'application/octet-stream' });
    },
  };
}
