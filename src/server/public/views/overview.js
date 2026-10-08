// Overview (#/overview) — the landing page after sign-in. Answers three questions in plain
// words: where does the migration stand (readiness tiles), what needs attention (open
// exceptions) and what is on my plate (my assignments). Every number on the page links to
// the list behind it. Read-only: nothing here changes data.
'use strict';

(function () {
  const { api, el, chip, renderDataTable, navigate, humanize, severityChip, plain } = window.App;

  // Tile order mirrors how a branch moves through the migration. `tone` picks the KPI colour
  // class that already exists in styles.css.
  const READINESS_TILES = [
    { key: 'NOT_STARTED', label: 'Not started', tone: '', hint: 'Nothing received yet' },
    { key: 'IN_PROGRESS', label: 'In progress', tone: 'kpi-warn', hint: 'Work has begun' },
    { key: 'BLOCKED', label: 'Blocked', tone: 'kpi-danger', hint: 'Needs a decision or a fix' },
    { key: 'READY', label: 'Ready', tone: 'kpi-ok', hint: 'All checks passed, waiting to post' },
    { key: 'MIGRATED', label: 'Migrated', tone: 'kpi-ok', hint: 'Finished' },
  ];

  const WORKER_WORDS = { disabled: 'Off', singleton: 'Running' };

  function sectionHeading(text, link) {
    const kids = [el('h3', {}, text)];
    if (link) kids.push(el('a', { href: link.href, class: 'section-link' }, link.label));
    return el('div', { class: 'section-head' }, kids);
  }

  // ------------------------------------------------------------ readiness tiles

  async function renderTiles(host, subtitleEl) {
    host.innerHTML = '';
    let facets;
    try {
      facets = await api('/api/branches/facets');
    } catch (err) {
      host.appendChild(el('p', { class: 'empty error-text' }, `Could not load branch counts: ${err.message}`));
      return;
    }
    const counts = facets.readiness ?? {};
    const total = Object.values(counts).reduce((a, b) => a + Number(b || 0), 0);
    if (total === 0) {
      host.appendChild(el('p', { class: 'empty' }, 'No branches are loaded yet. Once branch data is imported, the counts appear here.'));
      return;
    }
    for (const tile of READINESS_TILES) {
      const n = Number(counts[tile.key] ?? 0);
      host.appendChild(
        el(
          'button',
          {
            type: 'button',
            class: `kpi${tile.tone ? ` ${tile.tone}` : ''}`,
            'aria-label': `${n} branches ${tile.label.toLowerCase()}. Show them.`,
            onclick: () => navigate('/branches', { readiness: tile.key }),
          },
          [
            el('div', { class: 'kpi-label' }, tile.label),
            el('div', { class: 'kpi-value' }, String(n)),
            el('div', { class: 'kpi-hint' }, tile.hint),
          ]
        )
      );
    }
    if (subtitleEl) {
      // The expected total is only known from the list endpoint; a failure here is cosmetic.
      try {
        const list = await api('/api/branches?pageSize=1');
        subtitleEl.textContent = `${total} of ${list.expectedBranchCount ?? total} branches are loaded. Select a tile to see those branches.`;
      } catch {
        subtitleEl.textContent = `${total} branches are loaded. Select a tile to see those branches.`;
      }
    }
  }

  // ------------------------------------------------------------ needs attention

  async function renderAttention(card) {
    card.innerHTML = '';
    const head = sectionHeading('Needs attention', { href: '#/exceptions?status=OPEN', label: 'See all open exceptions' });
    card.appendChild(head);
    const host = el('div', { class: 'tablewrap' }, 'Loading...');
    card.appendChild(host);
    let rows;
    try {
      rows = (await api('/api/exceptions?status=OPEN')).exceptions ?? [];
    } catch (err) {
      host.innerHTML = '';
      host.appendChild(el('p', { class: 'empty error-text' }, `Could not load exceptions: ${err.message}`));
      return;
    }
    window.App.setOpenExceptionCount(rows.length);
    if (rows.length === 0) {
      host.innerHTML = '';
      host.appendChild(el('p', { class: 'empty' }, 'Nothing needs attention right now. There are no open exceptions.'));
      return;
    }
    head.querySelector('h3').textContent = `Needs attention (${rows.length} open)`;
    renderDataTable(
      host,
      rows.slice(0, 10),
      [
        {
          key: 'branch',
          label: 'Branch',
          render: (r) => (r.branch_code ? el('a', { href: `#/branches/${encodeURIComponent(r.branch_code)}` }, r.branch_code) : '—'),
        },
        { key: 'category', label: 'What kind', render: (r) => humanize(r.category) },
        { key: 'severity', label: 'How serious', render: (r) => severityChip(r.severity) },
        { key: 'message', label: 'What happened', render: (r) => el('span', { class: 'wrap-text' }, plain(r.message) || '—') },
      ],
      { empty: 'No open exceptions.' }
    );
    if (rows.length > 10) {
      card.appendChild(el('p', { class: 'muted' }, `Showing the 10 newest of ${rows.length}.`));
    }
  }

  // ------------------------------------------------------------ my work

  async function renderMyWork(card) {
    card.innerHTML = '';
    card.appendChild(sectionHeading('My work', { href: '#/team', label: 'Team' }));
    const me = window.App.state.user;
    const host = el('div');
    card.appendChild(host);
    if (!me) return;
    let asOperator = [];
    let asApprover = [];
    try {
      const [op, ap] = await Promise.all([
        api(`/api/assignments?operator=${encodeURIComponent(me.id)}`),
        api(`/api/assignments?approver=${encodeURIComponent(me.id)}`),
      ]);
      asOperator = op.assignments ?? [];
      asApprover = ap.assignments ?? [];
    } catch (err) {
      const msg = err.status === 403 ? 'Assignments are not available for this account.' : `Could not load your assignments: ${err.message}`;
      host.appendChild(el('p', { class: 'empty' }, msg));
      return;
    }
    const items = [
      ...asOperator.map((a) => ({ a, role: 'You prepare this' })),
      ...asApprover.map((a) => ({ a, role: 'You approve this' })),
    ].filter((x) => x.a.status !== 'DONE');
    if (items.length === 0) {
      host.appendChild(el('p', { class: 'empty' }, 'Nothing is assigned to you right now.'));
      return;
    }
    const ul = el('ul', { class: 'list-plain' });
    for (const { a, role } of items.slice(0, 8)) {
      ul.appendChild(
        el('li', {}, [
          el('span', {}, [
            el('a', { href: `#/branches/${encodeURIComponent(a.branch_code)}` }, `Branch ${a.branch_code}`),
            el('span', { class: 'muted' }, ` · ${a.period} · ${role}`),
          ]),
          chip(a.status, humanize(a.status)),
        ])
      );
    }
    host.appendChild(ul);
    if (items.length > 8) host.appendChild(el('p', { class: 'muted' }, `Showing 8 of ${items.length}. The rest are on the Team page.`));
  }

  // ------------------------------------------------------------ system status

  function statusRow(label, value) {
    return el('li', {}, [el('span', {}, label), value]);
  }

  function readinessChipClass(item) {
    const state = String(item?.state || '');
    if (item?.key === 'connection') {
      if (state === 'CONNECTED') return 'chip-green';
      if (state === 'ERROR' || state === 'DISCONNECTED') return 'chip-red';
      if (state === 'PENDING_AUTH') return 'chip-amber';
      return 'chip-grey';
    }
    if (item?.key === 'posting') return state === 'DISABLED' ? 'chip-green' : 'chip-red';
    if (/^(MISSING|NOT_|DISABLED|INCOMPLETE)/.test(state)) return 'chip-red';
    if (/^(CONFIGURED|VERIFIED|SYNCHRONIZED|COMPLETE)/.test(state)) return 'chip-green';
    return 'chip-grey';
  }

  async function renderSystemStatus(card) {
    card.innerHTML = '';
    card.appendChild(sectionHeading('System status', window.App.isAdmin() ? { href: '#/settings', label: 'Settings' } : null));
    const ul = el('ul', { class: 'list-plain' });
    card.appendChild(ul);
    let health;
    try {
      health = await api('/api/health');
    } catch (err) {
      ul.appendChild(el('li', {}, `Could not reach the server health check: ${err.message}`));
      return;
    }
    ul.appendChild(statusRow('Posting to Zoho Books', health.postingEnabled ? chip('FAIL', 'ENABLED') : chip('OK', 'Off (safe)')));
    ul.appendChild(statusRow('Environment', el('span', { class: 'muted' }, `${health.environment}, ${health.driver} Books driver`)));
    ul.appendChild(statusRow('File archive', el('span', { class: 'muted' }, window.App.archiveStateWords(health.archiveStatus))));
    ul.appendChild(statusRow('Background worker', el('span', { class: 'muted' }, WORKER_WORDS[health.workerMode] ?? String(health.workerMode ?? 'unknown'))));

    if (!window.App.isAdmin()) return;
    const booksHead = el('h4', { class: 'sub-head' }, 'Zoho Books connection');
    const booksHost = el('ul', { class: 'list-plain' });
    card.appendChild(booksHead);
    card.appendChild(booksHost);
    try {
      const data = await api('/api/admin/books/connection');
      booksHost.appendChild(
        statusRow(data.org ? `${data.org.name}` : 'Organisation', chip(data.status, humanize(data.status)))
      );
      for (const item of data.readiness ?? []) {
        booksHost.appendChild(
          statusRow(item.label || item.key, el('span', { class: `chip ${readinessChipClass(item)}` }, humanize(item.state)))
        );
      }
    } catch (err) {
      booksHost.appendChild(el('li', {}, err.status === 404 || err.status === 501 ? 'The Books connection check is not available yet.' : `Could not load the Books connection: ${err.message}`));
    }
  }

  // ------------------------------------------------------------ page

  async function renderOverviewPage(container) {
    window.App.setPageTitle('Overview');
    const page = el('div', { class: 'page' });
    container.appendChild(page);

    const subtitle = el('div', { class: 'subtitle' }, 'Where the migration stands today.');
    page.appendChild(el('div', { class: 'page-header' }, [el('div', {}, [el('h2', {}, 'Overview'), subtitle])]));

    const tiles = el('div', { class: 'kpi-grid' });
    page.appendChild(tiles);

    const attentionCard = el('section', { class: 'card' });
    const side = el('div', { class: 'side-rail' });
    const workCard = el('section', { class: 'card' });
    const statusCard = el('section', { class: 'card' });
    side.appendChild(workCard);
    side.appendChild(statusCard);
    page.appendChild(el('div', { class: 'two-col' }, [attentionCard, side]));

    page.appendChild(
      el('details', { class: 'collapsible card' }, [
        el('summary', {}, 'How a branch gets to Migrated'),
        el('ol', { class: 'plain-steps' }, [
          el('li', {}, 'Receive the branch files and check they are complete.'),
          el('li', {}, 'Source reconciliation: confirm the data we received adds up to the branch’s own ledger totals.'),
          el('li', {}, 'Map the branch’s accounts and parties to Zoho Books, and check for overlap with other branches.'),
          el('li', {}, 'Approve the batch.'),
          el('li', {}, 'Books reconciliation: confirm what is in Zoho Books agrees with what was sent.'),
          el('li', {}, 'Balance proof: confirm opening balance plus movements equals the closing balance.'),
        ]),
      ])
    );

    // Independent sections: one failing never blanks the others.
    await Promise.all([renderTiles(tiles, subtitle), renderAttention(attentionCard), renderMyWork(workCard), renderSystemStatus(statusCard)]);
  }

  window.App.registerRoute('/overview', renderOverviewPage);
})();
