#!/usr/bin/env node
// One-time: turn a Zoho Self Client grant code (scopes WorkDrive.files.READ,WorkDrive.files.CREATE)
// into a refresh token and store it in .env.workdrive. The token is written, never printed.
//
//   node scripts/workdrive-token.js <grant code> [--env .env.workdrive]
// Client id / secret: WORKDRIVE_CLIENT_ID / _SECRET, else BOOKS_CLIENT_ID / _SECRET (from the env
// file named, then .env.opening). Accounts server: WORKDRIVE_ACCOUNTS_BASE (https://accounts.zoho.in).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const [code, flag, envArg] = process.argv.slice(2);
const envPath = flag === '--env' && envArg ? envArg : '.env.workdrive';
if (!code) { console.error('usage: workdrive-token.js <grant code> [--env .env.workdrive]'); process.exit(64); }
const read = (p) => (existsSync(p) ? Object.fromEntries(readFileSync(p, 'utf8').split(/\r?\n/)
  .map((l) => /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(l)).filter(Boolean).map((m) => [m[1], m[2].replace(/^["']|["']$/g, '')])) : {});
const env = { ...read('.env.opening'), ...read(envPath), ...process.env };
const clientId = env.WORKDRIVE_CLIENT_ID ?? env.BOOKS_CLIENT_ID;
const clientSecret = env.WORKDRIVE_CLIENT_SECRET ?? env.BOOKS_CLIENT_SECRET;
if (!clientId || !clientSecret) { console.error('no client id / secret found (WORKDRIVE_* or BOOKS_*)'); process.exit(1); }
const res = await fetch(`${env.WORKDRIVE_ACCOUNTS_BASE ?? 'https://accounts.zoho.in'}/oauth/v2/token`, {
  method: 'POST',
  body: new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, client_secret: clientSecret, code }),
});
const json = await res.json().catch(() => ({}));
if (!json.refresh_token) { console.error(`no refresh token returned: ${json.error ?? `http ${res.status}`} (grant codes expire within minutes and work once)`); process.exit(1); }
const lines = existsSync(envPath) ? readFileSync(envPath, 'utf8').split(/\r?\n/).filter((l) => l && !/^WORKDRIVE_REFRESH_TOKEN=/.test(l)) : [];
writeFileSync(envPath, [...lines, `WORKDRIVE_REFRESH_TOKEN=${json.refresh_token}`, ''].join('\n'));
console.log(`refresh token stored in ${envPath} (scope: ${json.scope ?? 'as granted'})`);
