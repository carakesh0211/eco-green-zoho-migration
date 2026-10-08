// Settings (#/settings, admin only): the Zoho Books connection, the system status behind
// the top-bar pills, and a link to the raw per-run "legacy" console. Read-mostly: the only
// actions are the existing Books connection controls (rendered by views/admin-books.js).
'use strict';

(function () {
  const { api, el, chip, renderJson, showError, humanize } = window.App;

  // Plain-language labels for every key /api/health returns today. Unknown keys still show
  // (humanised) so a new field added server-side is never silently hidden.
  const LABELS = {
    ok: 'Server responding',
    environment: 'Environment',
    driver: 'Books driver',
    postingEnabled: 'Posting to Zoho Books',
    postingBlockedBy: 'Posting is blocked because',
    workerMode: 'Background worker',
    storeAdapter: 'Data store',
    claimSemantics: 'Protection against double posting',
    archiveAdapter: 'File archive method',
    archiveStatus: 'File archive',
    archiveBucket: 'Archive bucket',
    archiveCheckedAt: 'Archive last checked',
    archiveError: 'Archive problem',
    inboxAdapter: 'Where incoming files are read from',
    version: 'Console version',
    buildSha: 'Build',
  };
  const ORDER = [
    'ok', 'environment', 'driver', 'postingEnabled', 'postingBlockedBy', 'workerMode', 'storeAdapter',
    'claimSemantics', 'archiveAdapter', 'archiveStatus', 'archiveBucket', 'archiveCheckedAt', 'archiveError',
    'inboxAdapter', 'version', 'buildSha',
  ];
  const BLOCK_REASONS = {
    DRIVER_NOT_LIVE: 'the Books driver is not set to live',
    POSTING_ENABLED_FALSE: 'the posting switch is off',
    NO_AUTHORIZATION_REF: 'no authorisation reference is configured',
    ORG_NOT_ALLOWLISTED: 'the Books organisation is not on the allow-list',
    BEST_EFFORT_CLAIMS: 'the data store cannot guarantee a document is posted only once',
  };
  const WORKER_WORDS = { disabled: 'Off', singleton: 'Running' };

  function valueFor(key, v) {
    switch (key) {
      case 'ok': return v ? chip('OK', 'Yes') : chip('FAIL', 'No');
      case 'postingEnabled': return v ? chip('FAIL', 'ENABLED') : chip('OK', 'Disabled (safe)');
      case 'postingBlockedBy':
        return Array.isArray(v) && v.length
          ? el('ul', { class: 'plain-bullets' }, v.map((r) => el('li', {}, BLOCK_REASONS[r] || humanize(r))))
          : 'nothing – posting is not blocked';
      case 'workerMode': return WORKER_WORDS[v] ?? String(v);
      case 'claimSemantics': return v === 'ATOMIC' ? 'Full (atomic)' : v === 'BEST_EFFORT' ? 'Best effort only' : String(v);
      case 'archiveStatus': return window.App.archiveStateWords(v);
      case 'archiveBucket': return v && v.name ? v.name : '—';
      case 'archiveError': return v ? String(v) : 'none';
      default:
        if (v === null || v === undefined || v === '') return '—';
        if (typeof v === 'object') return JSON.stringify(v);
        return String(v);
    }
  }

  async function renderSystemStatus(card) {
    card.innerHTML = '';
    const refresh = el('button', { type: 'button', onclick: () => renderSystemStatus(card) }, 'Refresh');
    card.appendChild(el('div', { class: 'section-head' }, [el('h3', {}, 'System status'), refresh]));
    card.appendChild(el('p', { class: 'muted' }, 'What this console is connected to right now. The pills at the top of every page are a short version of this list.'));
    let health;
    try {
      health = await api('/api/health');
    } catch (err) {
      showError(card.appendChild(el('div')), err);
      return;
    }
    window.App.refreshHealth(); // keep the pills in step with what is shown here
    const keys = [...ORDER.filter((k) => k in health), ...Object.keys(health).filter((k) => !ORDER.includes(k))];
    const dl = el('dl', { class: 'kv-list' });
    for (const key of keys) {
      dl.appendChild(el('dt', {}, LABELS[key] || humanize(key.replace(/([A-Z])/g, '_$1'))));
      dl.appendChild(el('dd', {}, valueFor(key, health[key])));
    }
    card.appendChild(dl);
    const details = el('details', { class: 'collapsible' }, [el('summary', {}, 'Show the raw status data')]);
    const raw = el('div');
    renderJson(raw, health);
    details.appendChild(raw);
    card.appendChild(details);
  }

  async function renderSettingsPage(container, params, query) {
    window.App.setPageTitle('Settings');
    const page = el('div', { class: 'page' });
    container.appendChild(page);
    page.appendChild(
      el('div', { class: 'page-header' }, [
        el('div', {}, [el('h2', {}, 'Settings'), el('div', { class: 'subtitle' }, 'Connection to Zoho Books and the health of this console. Administrators only.')]),
      ])
    );

    // --- Zoho Books connection (the same content as #/admin/connections/books)
    const booksSection = el('section', { class: 'settings-section' });
    booksSection.appendChild(el('h3', { class: 'section-title' }, 'Zoho Books connection'));
    booksSection.appendChild(
      el('p', { class: 'muted' }, 'Connecting grants read-only access so we can compare what is in Zoho Books with what we send. It never turns posting on.')
    );
    page.appendChild(booksSection);

    // --- System status
    const statusCard = el('section', { class: 'card' });
    page.appendChild(statusCard);

    // --- Advanced
    page.appendChild(
      el('section', { class: 'card' }, [
        el('h3', {}, 'Advanced'),
        el('p', { class: 'muted' }, 'The legacy console is the original raw, per-run view: uploaded files, vouchers, queue items and audit events exactly as stored. Most people will not need it.'),
        el('a', { href: '#/legacy', class: 'button-link' }, 'Open the legacy console'),
      ])
    );

    // The Books card and status card load independently; a failure in one never blanks the other.
    await Promise.all([
      window.App.renderBooksConnection(booksSection, query, '/settings'),
      renderSystemStatus(statusCard),
    ]);
  }

  window.App.registerRoute('/settings', renderSettingsPage, { roles: ['admin'] });
})();
