import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkSecrets } from '../scripts/check-secrets.js';

function withTempDir(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), 'check-secrets-test-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// NOTE: the planted values below are deliberately built by concatenating short fragments
// instead of appearing as one contiguous literal. This is not obfuscation of a real secret —
// it is fake, synthetic, fixture-only data — it just keeps this repo's own `check-secrets.js`
// run clean, since that scanner (correctly) also scans test/ and would otherwise flag its own
// planted-fake-secret fixtures sitting in committed source.
const PLANTED_GSTIN = '29ABCDE1234F' + '1Z5'; // structurally-valid-looking GSTIN shape
const PLANTED_ZOHO_TOKEN = '1000.abcdefghij1234567890.' + 'klmnopqrstuvwxyz1234'; // Zoho OAuth token shape

test('check-secrets flags a planted GSTIN and a Zoho-token-looking string, and masks the output', () => {
  withTempDir((dir) => {
    writeFileSync(
      path.join(dir, 'leaked.json'),
      JSON.stringify({ gstin: PLANTED_GSTIN, zoho_token: PLANTED_ZOHO_TOKEN }, null, 2),
      'utf8',
    );

    const findings = checkSecrets(dir);
    assert.ok(findings.length >= 2, 'expected at least a GSTIN finding and a Zoho token finding');

    const kinds = findings.map((f) => f.kind);
    assert.ok(kinds.includes('GSTIN'), 'must detect the planted GSTIN');
    assert.ok(kinds.includes('ZOHO_OAUTH_TOKEN'), 'must detect the planted Zoho-token-looking string');

    for (const f of findings) {
      assert.ok(f.relPath, 'finding must carry a relative file path');
      assert.ok(Number.isInteger(f.lineNo) && f.lineNo > 0, 'finding must carry a 1-based line number');
      // The masked value must never be the full raw secret string.
      assert.notEqual(f.masked, PLANTED_GSTIN);
      assert.notEqual(f.masked, PLANTED_ZOHO_TOKEN);
      assert.ok(f.masked.includes('*'), 'masked output must actually be masked');
    }
  });
});

test('check-secrets exits clean on a directory with no secret-shaped content', () => {
  withTempDir((dir) => {
    writeFileSync(path.join(dir, 'readme.md'), 'This is a totally synthetic fixture repo. See PILOT01.\n', 'utf8');
    writeFileSync(
      path.join(dir, 'config.example.json'),
      JSON.stringify({ client_secret: '', refresh_token: '<REPLACE_ME>', password: 'changeme' }, null, 2),
      'utf8',
    );
    mkdirSync(path.join(dir, 'node_modules', 'whatever'), { recursive: true });
    // Same note as PLANTED_GSTIN/PLANTED_ZOHO_TOKEN above: built at runtime so this line doesn't
    // itself look like a leaked key to a repo-wide check-secrets run.
    const fakeKeyThatLivesInNodeModules = 'sk-' + 'shouldnotbescanned1234567890';
    writeFileSync(path.join(dir, 'node_modules', 'whatever', 'index.js'), `module.exports = ${JSON.stringify(fakeKeyThatLivesInNodeModules)};\n`, 'utf8');

    const findings = checkSecrets(dir);
    assert.deepEqual(findings, [], 'a clean tree (placeholders + node_modules only) must report zero findings');
  });
});

test('check-secrets ignores empty/placeholder secret-shaped values and .example.json files', () => {
  withTempDir((dir) => {
    // A real (non-placeholder) value in an .example.json file is still exempt from the
    // SECRET_CONFIG_VALUE rule specifically (documented templates), per DATA_CONTRACT/CONTRACTS
    // task split — but other rules (e.g. GSTIN) must still fire on such files.
    writeFileSync(
      path.join(dir, 'users.example.json'),
      JSON.stringify({ client_secret: 'not-actually-empty-but-in-an-example-file' }, null, 2),
      'utf8',
    );
    const findings = checkSecrets(dir);
    assert.deepEqual(findings.filter((f) => f.kind === 'SECRET_CONFIG_VALUE'), []);
  });
});
