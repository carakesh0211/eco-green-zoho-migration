// scripts/opening-balance.js against a fake Books server: a rate block or a spent daily
// allowance stops the run with a clear message instead of a silent hour-long wait.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function fakeBooks(handler) {
  const seen = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    seen.push(url.pathname);
    if (url.pathname === '/oauth/v2/token') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ access_token: 'synthetic', expires_in: 3600 }));
    }
    return handler(url, res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen, base: `http://127.0.0.1:${server.address().port}` })));
}

function preflight(base) {
  const out = mkdtempSync(join(tmpdir(), 'opening-cli-'));
  writeFileSync(join(out, 'plan.json'), JSON.stringify({
    branch: '999', asOf: '2026-03-31', locationId: 'LOC-1', checks: [], warnings: [], documents: [], totals: {},
    gl: [{ zohoCode: 'AL0077', net: '100', sources: [] }, { zohoCode: 'AL0078', net: '-100', sources: [] }],
  }));
  const env = {
    PATH: process.env.PATH, BOOKS_DRIVER: 'live', BOOKS_API_BASE: `${base}/books/v3`, BOOKS_ACCOUNTS_BASE: base,
    BOOKS_CLIENT_ID: 'c', BOOKS_CLIENT_SECRET: 's', BOOKS_REFRESH_TOKEN: 'r',
    BOOKS_ORGANIZATION_ID: '60091274394', BOOKS_ORG_ALLOWLIST: '60091274394', BOOKS_REQUEST_TIMEOUT_MS: '5000',
  };
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['scripts/opening-balance.js', 'preflight', '--out', out], { env });
    let text = '';
    child.stdout.on('data', (b) => { text += b; });
    child.stderr.on('data', (b) => { text += b; });
    const timer = setTimeout(() => child.kill(), 20_000);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, text }); });
  });
}

test('preflight: a Books rate block (code 43, Retry-After 3600) stops the run at once', async () => {
  const { server, seen, base } = await fakeBooks((url, res) => {
    res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '3600' });
    res.end(JSON.stringify({ code: 43, message: 'You have exceeded the maximum number of requests per minute.' }));
  });
  try {
    const started = Date.now();
    const { code, text } = await preflight(base);
    assert.notEqual(code, 0);
    assert.ok(Date.now() - started < 15_000, 'stopped promptly');
    assert.match(text, /blocked this organisation for 60 min/);
    assert.equal(seen.filter((p) => p.startsWith('/books/')).length, 1, 'no further calls after the block');
  } finally {
    server.close();
  }
});

test('preflight: stops before sending once the daily allowance is nearly spent', async () => {
  const { server, seen, base } = await fakeBooks((url, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'x-rate-limit-limit': '1000', 'x-rate-limit-remaining': '10' });
    res.end(JSON.stringify({ code: 0, locations: [{ location_id: 'LOC-1', location_name: 'Branch' }], page_context: { has_more_page: false } }));
  });
  try {
    const { code, text } = await preflight(base);
    assert.notEqual(code, 0);
    assert.match(text, /only 10 of today's 1000 Books API calls left/);
    assert.equal(seen.filter((p) => p.startsWith('/books/')).length, 1);
  } finally {
    server.close();
  }
});
