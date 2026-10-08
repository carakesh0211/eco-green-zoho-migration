// Static guards for the v2 console shell (sidebar layout + Overview / Exceptions / Settings).
// No browser here: these pin the DOM ids app.js relies on, the CSP rules the new view files
// must obey (no inline handlers / style attributes / external hosts), and that no view
// renders an email address.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'server', 'public');
const read = (rel) => readFileSync(join(PUBLIC_DIR, rel), 'utf8');

const NEW_VIEWS = ['views/overview.js', 'views/exceptions.js', 'views/settings.js'];

describe('console UI v2 shell', () => {
  test('index.html has the sidebar shell ids app.js depends on', () => {
    const html = read('index.html');
    for (const id of ['shell', 'sidebar', 'mainNav', 'loginBox', 'menuBtn', 'pageTitle', 'envPills', 'postingBanner', 'archiveDisabledNotice', 'toasts', 'app', 'view']) {
      assert.match(html, new RegExp(`id="${id}"`), `index.html should contain id="${id}"`);
    }
    assert.match(html, /<aside id="sidebar" class="sidebar"/);
    assert.match(html, /class="topbar-v2"/);
  });

  test('index.html uses no inline style and no inline event handlers', () => {
    const html = read('index.html');
    assert.doesNotMatch(html, /\sstyle\s*=/i);
    assert.doesNotMatch(html, /\son[a-z]+\s*=/i);
  });

  test('new view scripts are loaded by index.html, after app.js and before boot.js', () => {
    const html = read('index.html');
    const idx = (p) => html.indexOf(`<script src="${p}">`);
    for (const v of NEW_VIEWS) {
      assert.ok(idx(`/${v}`) > idx('/app.js'), `${v} must load after app.js`);
      assert.ok(idx(`/${v}`) < idx('/boot.js'), `${v} must load before boot.js`);
    }
  });

  test('nav exposes Overview, Branches, Exceptions, Team, Settings and drops the legacy entry', () => {
    const js = read('app.js');
    for (const p of ['/overview', '/branches', '/exceptions', '/team', '/settings']) {
      assert.match(js, new RegExp(`navItem\\('[A-Za-z ]+', '${p}'`), `nav should link ${p}`);
    }
    assert.doesNotMatch(js, /navItem\('Legacy console'/);
    assert.match(js, /navigate\(state\.user \? '\/overview' : '\/login'\)/);
  });

  test('new views stay CSP-safe: no inline styles/handlers, no innerHTML from data, no external hosts', () => {
    for (const v of NEW_VIEWS) {
      const src = read(v);
      assert.doesNotMatch(src, /\.style\b|setAttribute\(\s*['"]style/, `${v} must not set inline styles`);
      assert.doesNotMatch(src, /\bonclick\s*=\s*["']|innerHTML\s*[+]?=\s*[^'"\s]/, `${v} must not build markup from strings`);
      assert.doesNotMatch(src, /https?:\/\//, `${v} must not reference external hosts`);
    }
  });

  test('no view renders the signed-in email', () => {
    for (const rel of ['app.js', ...NEW_VIEWS]) {
      assert.doesNotMatch(read(rel), /user\??\.email|\.email\b/, `${rel} must not read an email field`);
    }
  });

  test('Settings reuses the Books connection view through a shared render function', () => {
    assert.match(read('views/admin-books.js'), /window\.App\.renderBooksConnection\s*=/);
    assert.match(read('views/admin-books.js'), /registerRoute\('\/admin\/connections\/books'/);
    assert.match(read('views/settings.js'), /renderBooksConnection\(/);
  });
});
