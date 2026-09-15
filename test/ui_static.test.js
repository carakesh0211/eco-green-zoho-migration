// Static-asset smoke test for the console UI (src/server/public/*). Guards the two
// things that would otherwise only be caught by opening a browser: every script the
// page loads actually exists and is served, and the page never violates its own strict
// CSP (script-src 'self', style-src 'self' — see src/server/app.js's helmet config):
// no inline <script> bodies, no `style=` attributes anywhere in index.html.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openStore } from '../src/adapters/store/memory.js';
import { createAudit } from '../src/core/audit.js';
import { createApp } from '../src/server/app.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', 'src', 'server', 'public');

const EXTRA_SCRIPTS = [
  '/boot.js',
  '/views/legacy.js',
  '/views/branches.js',
  '/views/branch-workspace.js',
  '/views/team.js',
  '/views/admin-books.js',
];

async function startApp() {
  const store = await openStore();
  const audit = createAudit(store);
  const app = createApp({ store, audit, users: [], deps: {}, environment: 'local' });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      await store.close();
    },
  };
}

describe('console UI static assets', () => {
  test('/, /app.js, /styles.css and every extra script return 200', async () => {
    const t = await startApp();
    try {
      for (const path of ['/', '/app.js', '/styles.css', ...EXTRA_SCRIPTS]) {
        const res = await fetch(`${t.base}${path}`);
        assert.equal(res.status, 200, `expected 200 for ${path}, got ${res.status}`);
      }
    } finally {
      await t.close();
    }
  });

  test('index.html references every script it needs, and nothing else on disk is orphaned', () => {
    const html = readFileSync(join(PUBLIC_DIR, 'index.html'), 'utf8');
    for (const path of ['/app.js', ...EXTRA_SCRIPTS]) {
      assert.match(html, new RegExp(`<script src="${path.replace(/\//g, '\\/')}">`), `index.html should reference ${path}`);
    }
  });

  test('CSP guard: no inline <script> content and no style= attributes in index.html', () => {
    const html = readFileSync(join(PUBLIC_DIR, 'index.html'), 'utf8');

    // Every <script ...> tag must be a self-closed external reference (src="...") with
    // no body — i.e. immediately followed by </script> with nothing but whitespace.
    const scriptTagRe = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
    let match;
    let scriptCount = 0;
    while ((match = scriptTagRe.exec(html))) {
      scriptCount += 1;
      const [, attrs, body] = match;
      assert.match(attrs, /\bsrc=/, `<script${attrs}> has no src= — inline scripts are forbidden by CSP (script-src 'self')`);
      assert.equal(body.trim(), '', `<script${attrs}> has inline body content, forbidden by CSP`);
    }
    assert.ok(scriptCount >= 1 + EXTRA_SCRIPTS.length, 'expected at least app.js + every extra script tag in index.html');

    assert.doesNotMatch(html, /\sstyle\s*=/i, 'index.html must not use inline style= attributes (CSP style-src \'self\')');
  });
});
