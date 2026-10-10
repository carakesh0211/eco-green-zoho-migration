// Ledger push summary (#/branches/:code/ledger-summary): for the branch's current run, per
// source ledger, the debit and credit that will be sent to Zoho Books and what is still
// held back (and why). The operator checks these totals before a batch is approved and
// posted. Read-only: GET /api/branches/:code/ledger-summary (src/core/ledger_summary.js).
'use strict';

(function () {
  const { api, el, renderDataTable, showError, navigate, humanize } = window.App;

  const fmt = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const money = (s) => fmt.format(Number(s) || 0);
  const num = (s) => el('span', { class: 'num' }, money(s));
  const net = (d, c) => (Number(d) || 0) - (Number(c) || 0);

  const REASON_WORDS = {
    UNMAPPED_ENTITY: 'Account or party rule missing',
    UNMAPPED_MODULE: 'Voucher type not routed',
    PARTIAL_OR_AMBIGUOUS_OVERLAP: 'Possible Smart Pharma overlap',
    NO_VOUCHER: 'Line without a voucher',
  };
  const reasonText = (reasons) => Object.entries(reasons || {})
    .map(([k, v]) => `${REASON_WORDS[k] || humanize(k)} (${v})`).join('; ');

  const VIEWS = [
    { value: 'all', label: 'All ledgers' },
    { value: 'push', label: 'Ledgers being pushed' },
    { value: 'held', label: 'Ledgers with amounts held back' },
    { value: 'norule', label: 'Ledgers without a Books account' },
  ];

  function kpi(label, value, hint, tone) {
    return el('div', { class: `kpi${tone ? ` kpi-${tone}` : ''}` }, [
      el('div', { class: 'kpi-label' }, label),
      el('div', { class: 'kpi-value' }, value),
      hint ? el('div', { class: 'kpi-hint' }, hint) : null,
    ]);
  }

  function csvCell(v) {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  function downloadCsv(data) {
    const header = ['ledger_code', 'ledger_name', 'books_accounts', 'debit_to_push', 'credit_to_push', 'net_to_push', 'held_debit', 'held_credit', 'held_reasons', 'posted_debit', 'posted_credit'];
    const lines = [header.join(',')];
    for (const r of data.ledgers) {
      lines.push([
        r.ledger_code, r.ledger_name, r.books_accounts.join(' | '), r.push_debit, r.push_credit,
        net(r.push_debit, r.push_credit).toFixed(2), r.held_debit, r.held_credit, reasonText(r.held_reasons),
        r.posted_debit, r.posted_credit,
      ].map(csvCell).join(','));
    }
    const t = data.totals;
    lines.push(['TOTAL', '', '', t.push_debit, t.push_credit, net(t.push_debit, t.push_credit).toFixed(2), t.held_debit, t.held_credit, '', t.posted_debit, t.posted_credit].map(csvCell).join(','));
    const blob = new Blob([`${lines.join('\n')}\n`], { type: 'text/csv' });
    const a = el('a', { href: URL.createObjectURL(blob), download: `ledger-push-summary-${data.run.branch_code}-${data.run.id}.csv` });
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
  }

  async function renderLedgerSummaryPage(container, params) {
    const branch = params.code;
    window.App.setPageTitle?.(`Branch ${branch} — Ledger push summary`);
    const page = el('div', { class: 'page ledger-summary' });
    container.appendChild(page);

    const header = el('div', { class: 'page-header' });
    const kpis = el('div', { class: 'kpi-grid' });
    const note = el('div');
    const controls = el('div', { class: 'actions' });
    const tableHost = el('div');
    page.append(header, kpis, note, controls, tableHost);

    let data = null;
    let view = 'all';
    let q = '';

    async function load() {
      tableHost.innerHTML = '';
      tableHost.appendChild(el('p', { class: 'muted' }, 'Loading ledger totals… this reads every line of the run and can take a few seconds.'));
      try {
        data = await api(`/api/branches/${encodeURIComponent(branch)}/ledger-summary`);
      } catch (err) {
        if (err.status === 404) {
          tableHost.innerHTML = '';
          tableHost.appendChild(el('p', { class: 'muted' }, `No run has been imported for branch ${branch} yet.`));
          return;
        }
        showError(tableHost, err);
        return;
      }
      draw();
    }

    function draw() {
      const t = data.totals;
      header.innerHTML = '';
      header.append(
        el('div', {}, [
          el('h2', {}, `Branch ${branch} — Ledger push summary`),
          el('p', { class: 'muted' }, `Run ${data.run.id} · ${data.run.from_date} to ${data.run.to_date} · run status ${humanize(data.run.status)}. `
            + 'Amounts are the source ledger lines of the vouchers that are ready to post, grouped by ledger. Nothing is posted from this page.'),
        ]),
        el('div', { class: 'actions' }, [
          el('button', { type: 'button', class: 'linklike', onclick: () => navigate(`/branches/${encodeURIComponent(branch)}`) }, 'Back to branch'),
          el('button', { type: 'button', onclick: load }, 'Refresh'),
          el('button', { type: 'button', onclick: () => downloadCsv(data) }, 'Download CSV'),
        ]),
      );

      kpis.innerHTML = '';
      kpis.append(
        kpi('Debit to push', money(t.push_debit), `${t.push_vouchers} of ${t.vouchers} vouchers`),
        kpi('Credit to push', money(t.push_credit), `${t.ledgers_pushing} ledgers`),
        kpi('Debit = Credit?', t.push_balanced ? 'Yes' : 'No',
          t.push_balanced ? 'The amounts to push balance.' : `Difference ${money(net(t.push_debit, t.push_credit))} — do not post.`,
          t.push_balanced ? 'ok' : 'danger'),
        kpi('Held back', `${t.held_vouchers} vouchers`, `Dr ${money(t.held_debit)} / Cr ${money(t.held_credit)}`, t.held_vouchers ? 'warn' : 'ok'),
      );
      if (t.posted_vouchers) kpis.append(kpi('Already posted', `${t.posted_vouchers} vouchers`, `Dr ${money(t.posted_debit)} / Cr ${money(t.posted_credit)}`));

      note.innerHTML = '';
      if (t.push_vouchers === 0) {
        note.appendChild(el('div', { class: 'step-blocker' }, 'No voucher of this run is ready to post yet. Approve the missing mapping rules (Mapping screen); the mapping is then re-applied automatically.'));
      } else if (t.held_vouchers) {
        note.appendChild(el('p', { class: 'muted' }, `${t.held_vouchers} vouchers are held back and will not be posted until their reason (right-hand column) is fixed.`));
      }

      controls.innerHTML = '';
      const select = el('select', { onchange: (e) => { view = e.target.value; drawTable(); } },
        VIEWS.map((v) => el('option', { value: v.value, selected: v.value === view ? '' : null }, v.label)));
      const search = el('input', { value: q, placeholder: 'Ledger code or name', autocomplete: 'off' });
      search.addEventListener('input', () => { q = search.value.trim().toLowerCase(); drawTable(); });
      controls.append(el('label', {}, ['Show ', select]), el('label', {}, ['Search ', search]));
      drawTable();
    }

    function drawTable() {
      let rows = data.ledgers;
      if (view === 'push') rows = rows.filter((r) => r.push_lines > 0);
      if (view === 'held') rows = rows.filter((r) => r.held_lines > 0);
      if (view === 'norule') rows = rows.filter((r) => r.books_accounts.length === 0);
      if (q) rows = rows.filter((r) => `${r.ledger_code} ${r.ledger_name}`.toLowerCase().includes(q));

      const sum = (k) => rows.reduce((a, r) => a + (Number(r[k]) || 0), 0);
      const totalRow = {
        ledger_code: 'Total', ledger_name: rows.length === data.ledgers.length ? 'All ledgers' : `${rows.length} ledgers shown`,
        books_accounts: null, push_debit: sum('push_debit'), push_credit: sum('push_credit'),
        held_debit: sum('held_debit'), held_credit: sum('held_credit'), held_reasons: null, isTotal: true,
      };
      renderDataTable(tableHost, rows.length ? [...rows, totalRow] : [], [
        { key: 'ledger_code', label: 'Ledger', render: (r) => (r.isTotal ? el('strong', {}, r.ledger_code) : r.ledger_code) },
        { key: 'ledger_name', label: 'Name', render: (r) => (r.isTotal ? el('strong', {}, r.ledger_name) : r.ledger_name) },
        {
          key: 'books_accounts', label: 'Zoho Books account',
          render: (r) => (r.isTotal ? '' : r.books_accounts.length ? r.books_accounts.join(', ') : el('span', { class: 'error-text' }, 'No rule yet')),
        },
        { key: 'push_debit', label: 'Debit to push', render: (r) => num(r.push_debit) },
        { key: 'push_credit', label: 'Credit to push', render: (r) => num(r.push_credit) },
        { key: 'net', label: 'Net (Dr − Cr)', render: (r) => num(net(r.push_debit, r.push_credit)) },
        { key: 'held_debit', label: 'Held back Dr', render: (r) => num(r.held_debit) },
        { key: 'held_credit', label: 'Held back Cr', render: (r) => num(r.held_credit) },
        { key: 'held_reasons', label: 'Why held back', render: (r) => (r.isTotal ? '' : reasonText(r.held_reasons)) },
      ], { empty: 'No ledger matches this filter.' });
    }

    await load();
  }

  window.App.registerRoute('/branches/:code/ledger-summary', renderLedgerSummaryPage);
})();
