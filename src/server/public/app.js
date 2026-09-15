// Vanilla-JS console core. No framework, no build step. The token lives ONLY in
// sessionStorage, and only after the user pastes it into the login view — never
// persisted, never sent anywhere but this origin's own API. The UI is not a security
// boundary: every check here is cosmetic convenience, the server re-checks everything.
//
// This file defines the shared `App` namespace (auth, fetch helpers, DOM helpers, hash
// router, nav, health banner, toasts) that every view script (loaded after this one via
// <script src> tags, in DOM order — see index.html) attaches to. There is no bundler and
// no ES module graph: views read/write `window.App` directly.
'use strict';

const TOKEN_KEY = 'egzb_token';

function getToken() {
  try {
    return sessionStorage.getItem(TOKEN_KEY) || '';
  } catch {
    return '';
  }
}
function setToken(t) {
  try {
    if (t) sessionStorage.setItem(TOKEN_KEY, t);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* sessionStorage may be unavailable (private mode); login just won't persist */
  }
}

function newCorrelationId() {
  return 'ui_' + Math.random().toString(16).slice(2) + Date.now().toString(16);
}

/** Core fetch wrapper. Sends the bearer token when we have one (bots / break-glass /
 * legacy human login) AND `credentials: 'same-origin'` so a Catalyst session cookie
 * rides along too — the server accepts either (CONTRACTS: GET /api/auth/me). */
async function api(path, { method = 'GET', body } = {}) {
  const headers = { 'X-Correlation-Id': newCorrelationId() };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(path, {
    method,
    headers,
    credentials: 'same-origin',
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    const err = new Error((data && (data.message || data.error)) || `HTTP ${res.status}`);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

/** Like api(), but resolves to `null` instead of throwing on 404/501 ("endpoint not
 * built yet by the concurrent backend workstream") so a view can render an
 * "not available yet" note instead of breaking the whole page. Any other error still
 * throws so real failures (401/403/500) are handled explicitly by the caller. */
async function apiOptional(path, opts) {
  try {
    return await api(path, opts);
  } catch (err) {
    if (err.status === 404 || err.status === 501) return null;
    throw err;
  }
}

/** Fetch a binary/blob response with the auth header a plain <a href> can't carry
 * (e.g. CSV export), and trigger a save via a transient object URL. */
async function downloadWithAuth(path, suggestedName) {
  const headers = { 'X-Correlation-Id': newCorrelationId() };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(path, { method: 'GET', headers, credentials: 'same-origin' });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const data = await res.json();
      msg = data?.message || data?.error || msg;
    } catch {
      /* body wasn't JSON (or was empty) — the HTTP-status message is the best we have */
    }
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: suggestedName });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'text') node.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c === null || c === undefined) continue;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

function statusSpan(status) {
  return el('span', { class: `status-${status}` }, String(status ?? ''));
}

/** Classifies an arbitrary status string into one of the four chip colours the task
 * spec calls for: PASS/READY/MIGRATED-shaped -> green, FAIL/BLOCKED-shaped -> red,
 * IN_PROGRESS/DRAFT-shaped -> amber, NOT_*-shaped (and anything unrecognised) -> grey. */
function chipClass(status) {
  const s = String(status ?? '').toUpperCase();
  if (!s) return 'chip-grey';
  if (s.startsWith('NOT_')) return 'chip-grey';
  if (['PASS', 'READY', 'MIGRATED', 'APPROVED', 'CLEAR', 'RECEIVED', 'CONNECTED', 'ACTIVE', 'OK', 'POSTED', 'RESOLVED'].includes(s)) return 'chip-green';
  if (['FAIL', 'BLOCKED', 'REJECTED', 'VALIDATION_FAILED', 'DEAD_LETTER', 'ERROR', 'OVERLAP_FOUND', 'DISCONNECTED', 'FAILED_FINAL', 'FAILED_RETRYABLE'].includes(s)) return 'chip-red';
  if (['IN_PROGRESS', 'DRAFT', 'PARTIAL', 'PENDING_AUTH', 'PAUSED', 'QUEUED', 'OPEN', 'ASSIGNED', 'INVITED'].includes(s)) return 'chip-amber';
  return 'chip-grey';
}
function chip(status, label) {
  return el('span', { class: `chip ${chipClass(status)}` }, String(label ?? status ?? '—'));
}

/** A 10-segment bar built entirely from <div>s (CSP forbids inline style, so width
 * cannot be set with a percentage style rule) — see task note "progress bar built from
 * divs". Each segment is a fixed-width block; `filled` of them get the "filled" class. */
function progressBar(pct) {
  const p = Math.max(0, Math.min(100, Number(pct) || 0));
  const filled = Math.round(p / 10);
  const segs = [];
  for (let i = 0; i < 10; i += 1) {
    segs.push(el('div', { class: `seg${i < filled ? ' filled' : ''}` }));
  }
  return el('div', { class: 'progressbar-wrap' }, [
    el('div', { class: 'progressbar' }, segs),
    el('span', { class: 'progressbar-label' }, `${p.toFixed(0)}%`),
  ]);
}

/** Render an array of plain objects as a table. `linkCols` maps a column name to a
 *  click handler(row) so a dashboard number can drill down to the data behind it. */
function renderTable(container, rows, columns, { linkCols = {}, empty = 'No rows.' } = {}) {
  container.innerHTML = '';
  if (!rows || rows.length === 0) {
    container.appendChild(el('p', { class: 'muted' }, empty));
    return;
  }
  const table = el('table');
  const thead = el('tr', {}, columns.map((c) => el('th', {}, c.label ?? c.key)));
  table.appendChild(el('thead', {}, thead));
  const tbody = el('tbody');
  for (const row of rows) {
    const tr = el('tr');
    for (const c of columns) {
      const raw = c.get ? c.get(row) : row[c.key];
      let cell;
      if (c.status) {
        cell = statusSpan(raw);
      } else if (linkCols[c.key]) {
        cell = el('button', { class: 'linklike', onclick: () => linkCols[c.key](row) }, String(raw ?? ''));
      } else {
        cell = document.createTextNode(raw === null || raw === undefined ? '' : String(raw));
      }
      tr.appendChild(el('td', {}, cell));
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  container.appendChild(table);
}

/** A denser table renderer for the new data-heavy views: columns provide `render(row)`
 * returning a DOM node/string directly (progress bars, chips, links, whatever), the
 * wrapper gets sticky-header/zebra/horizontal-scroll styling, and rows are clickable. */
function renderDataTable(container, rows, columns, { onRowClick, empty = 'No rows.' } = {}) {
  container.innerHTML = '';
  if (!rows || rows.length === 0) {
    container.appendChild(el('p', { class: 'muted' }, empty));
    return;
  }
  const wrap = el('div', { class: 'data-table-wrap' });
  const table = el('table', { class: 'data-table' });
  table.appendChild(el('thead', {}, el('tr', {}, columns.map((c) => c.headerNode ?? el('th', {}, c.label ?? c.key)))));
  const tbody = el('tbody');
  for (const row of rows) {
    const tr = el('tr', onRowClick ? { class: 'clickable-row', onclick: (evt) => { if (!evt.target.closest('button,a,input,select')) onRowClick(row); } } : {});
    for (const c of columns) {
      const content = c.render ? c.render(row) : row[c.key];
      tr.appendChild(el('td', {}, content === null || content === undefined ? '' : content));
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  container.appendChild(wrap);
}

function renderJson(container, obj) {
  container.innerHTML = '';
  container.appendChild(el('pre', { class: 'json' }, JSON.stringify(obj, null, 2)));
}

function showError(container, err) {
  container.innerHTML = '';
  container.appendChild(el('p', { class: 'muted error-text' }, `Error: ${err.message}`));
}

/** Renders the standard "backend endpoint not built yet" placeholder for a route that
 * answered 404/501, so a partially-built backend never breaks the page. */
function notAvailableNote(container, note) {
  container.innerHTML = '';
  container.appendChild(el('p', { class: 'muted' }, note || 'Not available yet — this API is still being built.'));
}

function debounce(fn, wait) {
  let t = null;
  return (...args) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
}

/** Builds a query string, dropping empty/undefined/null values so hash URLs stay tidy. */
function buildQueryString(params = {}) {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    usp.set(k, v);
  }
  const s = usp.toString();
  return s;
}

// ---------------------------------------------------------------- toasts

function toast(message, type = 'info') {
  const host = document.getElementById('toasts');
  if (!host) return;
  const node = el('div', { class: `toast toast-${type}` }, message);
  host.appendChild(node);
  setTimeout(() => node.remove(), 6000);
}

// ---------------------------------------------------------------- health / posting banner

let lastHealth = null;

async function refreshHealth() {
  const banner = document.getElementById('postingBanner');
  const archiveNotice = document.getElementById('archiveDisabledNotice');
  try {
    const health = await api('/api/health');
    lastHealth = health;
    banner.textContent =
      `${health.postingEnabled ? 'POSTING IS ENABLED!' : 'POSTING DISABLED'} — WORKER ${String(health.workerMode || 'disabled').toUpperCase()} — ` +
      `driver=${health.driver} — store=${health.storeAdapter} (${health.claimSemantics}) — ` +
      `archive=${health.archiveStatus}${health.archiveBucket?.name ? ' (' + health.archiveBucket.name + ')' : ''} — env=${health.environment}`;
    archiveNotice.hidden = health.archiveStatus !== 'DISABLED_DEVELOPMENT';
  } catch (err) {
    banner.textContent = `POSTING DISABLED — health check failed: ${err.message}`;
  }
}

// ---------------------------------------------------------------- auth (token + Catalyst)

const state = {
  authConfig: null, // { modes, catalystLoginUrl, catalystLogoutUrl }
  user: null, // { id, role, principal_type, branches, authMode, email? }
};

function hasRole(...roles) {
  return Boolean(state.user) && roles.includes(state.user.role);
}
function isAdmin() {
  return hasRole('admin');
}

async function loadAuthConfig() {
  try {
    state.authConfig = await api('/api/auth/config');
  } catch {
    state.authConfig = { modes: ['token'], catalystLoginUrl: null, catalystLogoutUrl: null };
  }
  return state.authConfig;
}

/** Resolves true/false; never throws. A missing/invalid session is simply "not signed
 * in" — every route decides for itself whether that means "show #/login". */
async function tryLoadMe() {
  try {
    state.user = await api('/api/auth/me');
    return true;
  } catch {
    state.user = null;
    return false;
  }
}

function signOut() {
  const wasCatalyst = state.user?.authMode === 'catalyst';
  const logoutUrl = state.authConfig?.catalystLogoutUrl;
  setToken('');
  state.user = null;
  renderNav();
  if (wasCatalyst && logoutUrl) {
    window.location.href = logoutUrl;
  } else {
    navigate('/login');
  }
}

// ---------------------------------------------------------------- hash router

const routeTable = [];

/** pattern: '/branches/:code' style. opts.public === true skips the sign-in gate
 * (only /login needs this). opts.roles restricts the route to those roles once
 * signed in (a role mismatch redirects to /branches rather than 403ing silently). */
function registerRoute(pattern, handler, opts = {}) {
  const segments = pattern.split('/').filter(Boolean);
  routeTable.push({ segments, handler, opts });
}

function matchRoute(pathSegments) {
  for (const r of routeTable) {
    if (r.segments.length !== pathSegments.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < r.segments.length; i += 1) {
      const seg = r.segments[i];
      if (seg.startsWith(':')) params[seg.slice(1)] = decodeURIComponent(pathSegments[i]);
      else if (seg !== pathSegments[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return { handler: r.handler, params, opts: r.opts };
  }
  return null;
}

function parseHash() {
  const raw = location.hash.startsWith('#') ? location.hash.slice(1) : location.hash;
  const qIdx = raw.indexOf('?');
  const path = (qIdx === -1 ? raw : raw.slice(0, qIdx)) || '/';
  const queryPart = qIdx === -1 ? '' : raw.slice(qIdx + 1);
  const query = Object.fromEntries(new URLSearchParams(queryPart));
  return { path, query };
}

function navigate(path, query) {
  const q = query ? buildQueryString(query) : '';
  location.hash = `#${path}${q ? `?${q}` : ''}`;
}

/** Replaces the current filter/sort/page state in the URL WITHOUT pushing a new
 * history entry or re-triggering dispatch (views call this as filters change so
 * reload/back restores exactly what was on screen). */
function replaceQuery(path, query) {
  const q = buildQueryString(query);
  const newHash = `#${path}${q ? `?${q}` : ''}`;
  history.replaceState(null, '', newHash);
}

function navItem(label, path, activePath) {
  const active = activePath === path || activePath.startsWith(`${path}/`);
  return el('button', { class: `navlink${active ? ' navlink-active' : ''}`, onclick: () => navigate(path) }, label);
}

function renderNav() {
  const nav = document.getElementById('mainNav');
  const loginBox = document.getElementById('loginBox');
  if (!nav || !loginBox) return;
  nav.innerHTML = '';
  loginBox.innerHTML = '';
  if (state.user) {
    const { path } = parseHash();
    nav.appendChild(navItem('Branches', '/branches', path));
    nav.appendChild(navItem('Legacy console', '/legacy', path));
    if (isAdmin()) {
      nav.appendChild(navItem('Team', '/team', path));
      nav.appendChild(navItem('Administration', '/admin/connections/books', path));
    } else if (hasRole('approver', 'viewer', 'operator')) {
      nav.appendChild(navItem('Team', '/team', path));
    }
    const label =
      `${state.user.id} (${state.user.role}` +
      `${state.user.principal_type === 'bot' ? ', bot' : ''}` +
      `${state.user.email ? `, ${state.user.email}` : ''})`;
    loginBox.appendChild(el('span', { class: 'whoami' }, label));
    loginBox.appendChild(el('button', { onclick: signOut }, 'Sign out'));
  } else {
    loginBox.appendChild(el('span', { class: 'whoami' }, 'Not signed in'));
  }
}

async function dispatch() {
  const { path, query } = parseHash();
  if (path === '/' || path === '') {
    navigate(state.user ? '/branches' : '/login');
    return;
  }
  const match = matchRoute(path.split('/').filter(Boolean));
  const viewEl = document.getElementById('view');
  if (!match) {
    viewEl.innerHTML = '';
    viewEl.appendChild(el('p', { class: 'muted' }, `No such view: ${path}`));
    renderNav();
    return;
  }
  if (!match.opts.public && !state.user) {
    const ok = await tryLoadMe();
    if (!ok) {
      if (path !== '/login') navigate('/login');
      renderNav();
      return;
    }
  }
  if (match.opts.roles && state.user && !match.opts.roles.includes(state.user.role)) {
    // Not an outright 403 page: send them somewhere they can actually use.
    navigate('/branches');
    return;
  }
  renderNav();
  viewEl.innerHTML = '';
  try {
    await match.handler(viewEl, match.params, query);
  } catch (err) {
    if (err.status === 401) {
      state.user = null;
      navigate('/login');
      return;
    }
    showError(viewEl, err);
  }
}

// ---------------------------------------------------------------- login view (core; not
// split into views/*.js since it is tightly coupled to the auth state above)

function renderLoginView(container) {
  const card = el('section', { class: 'card' }, [el('h2', {}, 'Sign in')]);
  const errorP = el('p', { class: 'muted error-text' }, '');

  if (state.authConfig?.catalystLoginUrl) {
    card.appendChild(
      el('div', { class: 'controls' }, [
        el(
          'button',
          {
            class: 'primary',
            onclick: () => {
              window.location.href = state.authConfig.catalystLoginUrl;
            },
          },
          'Sign in with Zoho (Catalyst)'
        ),
      ])
    );
    card.appendChild(el('p', { class: 'muted' }, 'or use a bearer token below:'));
  }

  const tokenInput = el('input', { id: 'tokenInput', type: 'password', autocomplete: 'off', placeholder: 'paste token' });
  async function onTokenLogin() {
    const t = tokenInput.value.trim();
    if (!t) return;
    setToken(t);
    tokenInput.value = '';
    const ok = await tryLoadMe();
    if (!ok) {
      setToken('');
      errorP.textContent = 'That token was not accepted.';
      return;
    }
    navigate('/branches');
  }
  tokenInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') onTokenLogin();
  });

  card.appendChild(
    el('div', { class: 'controls' }, [
      el('label', {}, ['Bearer token (bots / break-glass)', tokenInput]),
      el('button', { onclick: onTokenLogin }, 'Sign in'),
    ])
  );
  card.appendChild(errorP);
  container.appendChild(card);
}

registerRoute('/login', renderLoginView, { public: true });

// ---------------------------------------------------------------- public namespace

window.App = {
  // fetch helpers
  api,
  apiOptional,
  downloadWithAuth,
  // dom helpers
  el,
  statusSpan,
  chip,
  chipClass,
  progressBar,
  renderTable,
  renderDataTable,
  renderJson,
  showError,
  notAvailableNote,
  debounce,
  buildQueryString,
  toast,
  // auth / state
  state,
  hasRole,
  isAdmin,
  getToken,
  setToken,
  loadAuthConfig,
  tryLoadMe,
  signOut,
  // router
  registerRoute,
  navigate,
  replaceQuery,
  parseHash,
  renderNav,
  dispatch,
  // health
  refreshHealth,
  getLastHealth: () => lastHealth,
};

/** Called once, by boot.js, after every view script has registered its routes. */
async function start() {
  window.addEventListener('hashchange', dispatch);
  await Promise.all([refreshHealth(), loadAuthConfig()]);
  if (getToken()) await tryLoadMe();
  await dispatch();
}
window.App.start = start;
