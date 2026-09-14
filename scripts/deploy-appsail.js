#!/usr/bin/env node
// Deploy the AppSail service to Catalyst DEVELOPMENT with environment variables that
// are never committed.
//
// Why this exists: AppSail environment variables are supplied either in the console or
// via `env_variables` inside app-config.json, and app-config.json is a tracked file.
// This script merges the gitignored `var/appsail-env.local.json` (an array of
// {key, value}) into a TEMPORARY app-config.json, runs `catalyst deploy appsail`, and
// restores the tracked file byte-for-byte — whether the deploy succeeds or fails.
//
//   node scripts/deploy-appsail.js            # deploy
//   node scripts/deploy-appsail.js --dry-run  # print the merged config (values masked)
//
// The env file must never contain plaintext bearer tokens: USERS_CONFIG_JSON carries
// sha256 hashes only. `catalyst deploy` only ever targets the Development environment.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = path.join(ROOT, 'app-config.json');
const ENV_FILE = path.join(ROOT, 'var', 'appsail-env.local.json');
const APP_NAME = process.env.APPSAIL_NAME || 'EcoGreenMigrationConsole';
const dryRun = process.argv.includes('--dry-run');

if (!existsSync(ENV_FILE)) {
  console.error(`Missing ${path.relative(ROOT, ENV_FILE)} (gitignored). Create it as [{"key":"...","value":"..."}].`);
  process.exit(2);
}
const original = readFileSync(CONFIG, 'utf8');
const base = JSON.parse(original);
const envVars = JSON.parse(readFileSync(ENV_FILE, 'utf8'));
if (!Array.isArray(envVars) || envVars.some((e) => !e.key || typeof e.value !== 'string')) {
  console.error('appsail-env.local.json must be an array of {key, value:string}');
  process.exit(2);
}
for (const e of envVars) {
  if (/^egdev/i.test(e.value) || /"token"\s*:/.test(e.value)) {
    console.error(`Refusing: env var ${e.key} looks like it contains a plaintext token.`);
    process.exit(2);
  }
}
if (envVars.some((e) => e.key === 'POSTING_ENABLED' && e.value !== 'false')) {
  console.error('Refusing: POSTING_ENABLED must be "false" for any deployment made by this script.');
  process.exit(2);
}

const merged = { ...base, env_variables: Object.fromEntries(envVars.map((e) => [e.key, e.value])) };
if (dryRun) {
  const masked = { ...merged, env_variables: Object.fromEntries(Object.entries(merged.env_variables).map(([k, v]) => [k, k === 'USERS_CONFIG_JSON' ? `<${v.length} chars, hashes only>` : v])) };
  console.log(JSON.stringify(masked, null, 2));
  process.exit(0);
}

writeFileSync(CONFIG, JSON.stringify(merged, null, 2) + '\n');
let status = 1;
try {
  // On Windows the CLI is a .cmd shim, so a shell is required; quote the startup
  // command explicitly or the shell splits "npm start" into two arguments.
  const useShell = process.platform === 'win32';
  const cmd = String(base.command || 'npm start');
  const args = ['deploy', 'appsail', '--name', APP_NAME, '--build-path', '.', '--stack', String(base.stack || 'node24'), '--command', useShell ? `"${cmd}"` : cmd, '--non-interactive'];
  const r = spawnSync('catalyst', args, { cwd: ROOT, stdio: 'inherit', shell: useShell, timeout: 15 * 60 * 1000 });
  status = r.status ?? 1;
} finally {
  writeFileSync(CONFIG, original);
  console.log(`restored ${path.relative(ROOT, CONFIG)} (env values were never written to git)`);
}
process.exit(status);
