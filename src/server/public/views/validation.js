// Data validation (#/branches/:code/validation): upload the Opening TB, Closing TB and the
// transactional ledger; every account is reconciled on
//     Opening balance + (total debit - total credit) = calculated closing  ==  Closing TB
// with exception lists, a per-account drill-down and confirmed manual mappings that are kept
// for later runs. Read-only for migration data: a run never changes vouchers or rules.
//   GET  /api/branches/:code/validation/runs[/:id[/lines|/report.csv]]
//   POST /api/branches/:code/validation/runs, /runs/:id/rerun
//   GET/POST /api/validation/mappings, POST /api/validation/mappings/remove
'use strict';

(function () {
  const { api, el, renderDataTable, showError, navigate, toast, hasRole, downloadWithAuth, chip } = window.App;

  const fmt = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const money = (s) => fmt.format(Number(s) || 0);
  const num = (s) => el('span', { class: 'num' }, money(s));

  const VIEWS = [
    { value: 'all', label: 'All accounts' },
    { value: 'differences', label: 'Difference found' },
    { value: 'missing_opening', label: 'Missing from Opening TB' },
    { value: 'missing_closing', label: 'Missing from Closing TB' },
    { value: 'not_in_ledger', label: 'Not in ledger' },
    { value: 'unmapped', label: 'Unmapped accounts' },
    { value: 'name_differs', label: 'Name differs' },
    { value: 'duplicates', label: 'Duplicate mappings' },
    { value: 'inconsistencies', label: 'Debit/credit inconsistencies' },
  ];
  const FLAG_WORDS = {
    MISSING_OPENING: 'Not in Opening TB',
    MISSING_CLOSING: 'Not in Closing TB',
    NOT_IN_LEDGER: 'No ledger transactions',
    UNMAPPED: 'Only in one file',
    NAME_DIFFERS: 'Name differs between files',
    OPENING_MISMATCH: 'Opening differs from the Closing TB opening (year-end close?)',
    MOVEMENT_MISMATCH: 'Ledger movement differs from the Closing TB transaction columns',
  };
  const TYPE_WORDS = {
    BOTH_SIDES: 'Debit and credit both filled',
    NEGATIVE_DEBIT: 'Negative debit',
    TB_NOT_BALANCED: 'Trial balance does not balance',
    LEDGER_NOT_BALANCED: 'Ledger does not balance',
    VOUCHER_NOT_BALANCED: 'Voucher does not balance',
    OPENING_MISMATCH: 'Opening TB vs Closing TB opening',
  };
  const BASIS_WORDS = {
    balance_sheet_only: 'Opening TB file — balance sheet items only (P&L closed to Reserve & Surplus)',
    closing_columns: 'Opening TB file — all accounts (closing balance columns)',
    opening_columns: 'Opening TB file (opening balance columns)',
    debit_credit: 'Opening TB file (debit/credit columns)',
    balance: 'Opening TB file (balance column)',
    closing_tb_opening_columns: 'Opening columns of the Closing TB',
    none: 'No opening balances',
  };
  const ROLE_WORDS = { opening: 'Opening TB', closing: 'Closing TB', ledger: 'Ledger' };

  function readBase64(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
      r.onerror = () => reject(r.error);
      r.readAsDataURL(file);
    });
  }

  function kpi(label, value, hint, tone) {
    return el('div', { class: `kpi${tone ? ` kpi-${tone}` : ''}` }, [
      el('div', { class: 'kpi-label' }, label),
      el('div', { class: 'kpi-value' }, value),
      hint ? el('div', { class: 'kpi-hint' }, hint) : null,
    ]);
  }

  /** Code accounts show "CODE — Name"; name-only accounts just their name. */
  const keyLabel = (k, name) => (k.startsWith('C:') ? `${k.slice(2)}${name ? ` — ${name}` : ''}` : name || k.slice(2));
  const statusChip = (s) => (s === 'RECONCILED' ? chip('PASS', 'Reconciled') : chip('FAIL', 'Difference Found'));
  const flagText = (flags) => (flags || []).map((f) => FLAG_WORDS[f] || f).join('; ');

  async function renderValidationPage(container, params) {
    const branch = params.code;
    const enc = encodeURIComponent(branch);
    window.App.setPageTitle?.(`Branch ${branch} — Data validation`);
    const page = el('div', { class: 'page validation-page' });
    container.appendChild(page);
    const canRun = hasRole('operator', 'approver', 'admin');

    let run = null; // current report
    let view = 'all';
    let q = '';
    let mappings = [];

    const runsHost = el('div');
    const reportHost = el('div');
    const drillHost = el('div');
    const mappingsHost = el('div');

    page.append(el('div', { class: 'page-header' }, [
      el('div', {}, [
        el('h2', {}, `Branch ${branch} — Data validation`),
        el('p', { class: 'muted' }, 'Checks, account by account, that Opening TB + ledger transactions = Closing TB, and lists every account '
          + 'missing from a file, unmapped, duplicated or inconsistent. Running a validation does not change any migration data.'),
      ]),
      el('div', { class: 'actions' }, [
        el('button', { type: 'button', class: 'linklike', onclick: () => navigate(`/branches/${enc}`) }, 'Back to branch'),
        el('button', { type: 'button', class: 'linklike', onclick: () => navigate(`/branches/${enc}/ledger-summary`) }, 'Ledger push summary'),
      ]),
    ]));

    // ---- upload ----
    const inputs = {
      opening: el('input', { type: 'file', accept: '.csv,.xlsx' }),
      closing: el('input', { type: 'file', accept: '.csv,.xlsx' }),
      ledger: el('input', { type: 'file', accept: '.csv,.xlsx' }),
    };
    const basis = el('select', {}, [
      el('option', { value: 'auto' }, 'Opening TB file — balance sheet items only (recommended)'),
      el('option', { value: 'closing_columns' }, 'Opening TB file — all accounts, P&L included'),
      el('option', { value: 'opening_columns' }, 'Opening TB file — its opening (Op.) columns'),
      el('option', { value: 'closing_tb_opening' }, 'Opening (Op.) columns of the Closing TB'),
    ]);
    const tolerance = el('input', { type: 'text', value: '0.00', size: '8', inputmode: 'decimal' });
    const runBtn = el('button', { type: 'button', onclick: startRun }, 'Run validation');
    const runStatus = el('p', { class: 'muted' });
    if (canRun) {
      page.append(el('section', { class: 'card validation-card' }, [
        el('h3', {}, 'Run a validation'),
        el('p', { class: 'muted' }, 'Upload the three files exactly as exported (Excel or CSV, up to 8 MB each). The Eco Green reports '
          + '(Act Code, Op./Tran./Cl. Debit and Credit; c_act_code, Debit, Credit) and plain exports (Account Code, Account Name, Debit, Credit or Balance) are both read.'),
        el('div', { class: 'validation-form' }, [
          el('label', {}, 'Opening TB'), el('div', {}, [inputs.opening, el('span', { class: 'muted' }, ' optional when the Closing TB has opening columns')]),
          el('label', {}, 'Closing TB'), el('div', {}, [inputs.closing]),
          el('label', {}, 'Ledger (transactions)'), el('div', {}, [inputs.ledger]),
          el('label', {}, 'Opening balances from'), el('div', {}, [basis]),
          el('label', {}, 'Tolerance (₹)'), el('div', {}, [tolerance]),
        ]),
        el('div', { class: 'actions' }, [runBtn]),
        runStatus,
      ]));
    }
    page.append(el('section', { class: 'card validation-card' }, [el('h3', {}, 'Past runs'), runsHost]));
    page.append(reportHost, drillHost);
    page.append(el('section', { class: 'card validation-card' }, [
      el('h3', {}, 'Confirmed account mappings'),
      el('p', { class: 'muted' }, 'Used by every later run, for every branch. Add them from the "Unmapped accounts" view of a report.'),
      mappingsHost,
    ]));

    async function startRun() {
      if (!inputs.closing.files[0] || !inputs.ledger.files[0]) { toast('Choose at least the Closing TB and the Ledger file.', 'error'); return; }
      runBtn.disabled = true;
      runStatus.textContent = 'Reading and reconciling the files… a large ledger takes up to a minute.';
      try {
        const files = {};
        for (const role of ['opening', 'closing', 'ledger']) {
          const f = inputs[role].files[0];
          if (f) files[role] = { name: f.name, content: await readBase64(f) };
        }
        run = await api(`/api/branches/${enc}/validation/runs`, { method: 'POST', body: { files, opening_basis: basis.value, tolerance: tolerance.value.trim() } });
        runStatus.textContent = '';
        view = run.summary.differences ? 'differences' : 'all';
        toast(run.summary.equation_holds ? 'Validation complete: every account reconciles.' : `Validation complete: ${run.summary.differences} account(s) with a difference.`, run.summary.equation_holds ? 'success' : 'info');
        drawReport();
        await loadRuns();
      } catch (err) {
        runStatus.textContent = '';
        toast(err.message, 'error');
      } finally {
        runBtn.disabled = false;
      }
    }

    async function rerun(extra = {}) {
      if (!run) return;
      try {
        run = await api(`/api/branches/${enc}/validation/runs/${encodeURIComponent(run.id)}/rerun`, { method: 'POST', body: extra });
        toast('Re-run complete.', 'success');
        drawReport();
        await loadRuns();
      } catch (err) { toast(err.message, 'error'); }
    }

    async function loadRuns() {
      try {
        const out = await api(`/api/branches/${enc}/validation/runs`);
        if (!out.archive) { runsHost.replaceChildren(el('p', { class: 'muted' }, 'Validation runs cannot be stored: no archive is configured.')); return; }
        renderDataTable(runsHost, out.runs, [
          { key: 'created_at', label: 'When', render: (r) => new Date(r.created_at).toLocaleString('en-IN') },
          { key: 'created_by', label: 'By' },
          { key: 'files', label: 'Files', render: (r) => Object.entries(r.inputs || {}).map(([k, v]) => `${ROLE_WORDS[k]}: ${v.name}`).join(' · ') },
          { key: 'result', label: 'Result', render: (r) => (r.summary?.equation_holds ? chip('PASS', 'Reconciled') : chip('FAIL', `${r.summary?.differences ?? '?'} differences`)) },
          { key: 'open', label: '', render: (r) => el('button', { type: 'button', class: 'linklike', onclick: () => openRun(r.id) }, run?.id === r.id ? 'Shown below' : 'Open') },
        ], { empty: 'No validation has been run for this branch yet.' });
      } catch (err) { showError(runsHost, err); }
    }

    async function openRun(id) {
      try {
        run = await api(`/api/branches/${enc}/validation/runs/${encodeURIComponent(id)}`);
        view = run.summary.differences ? 'differences' : 'all';
        drawReport();
        await loadRuns();
      } catch (err) { toast(err.message, 'error'); }
    }

    async function loadMappings() {
      try {
        mappings = (await api('/api/validation/mappings')).mappings;
        renderDataTable(mappingsHost, mappings, [
          { key: 'role', label: 'File', render: (m) => ROLE_WORDS[m.role] },
          { key: 'from', label: 'Account in that file', render: (m) => keyLabel(m.from_key, m.from_name) },
          { key: 'to', label: 'Treated as', render: (m) => keyLabel(m.to_key, m.to_name) },
          { key: 'by', label: 'Confirmed by', render: (m) => `${m.by} · ${new Date(m.at).toLocaleDateString('en-IN')}` },
          {
            key: 'x', label: '',
            render: (m) => (canRun ? el('button', { type: 'button', class: 'linklike', onclick: () => removeMapping(m) }, 'Remove') : ''),
          },
        ], { empty: 'No mappings confirmed yet.' });
      } catch (err) { showError(mappingsHost, err); }
    }

    async function saveMapping(row, target) {
      try {
        await api('/api/validation/mappings', {
          method: 'POST',
          body: { role: row.source_role, from_key: row.source_key, from_name: row.name, to_key: target.key, to_name: `${target.name}` },
        });
        toast(`Saved: ${row.name} is treated as ${target.name}. Re-run to apply it.`, 'success');
        await loadMappings();
        drawReport();
      } catch (err) { toast(err.message, 'error'); }
    }

    async function removeMapping(m) {
      try {
        await api('/api/validation/mappings/remove', { method: 'POST', body: { role: m.role, from_key: m.from_key } });
        toast('Mapping removed. Re-run to apply it.', 'success');
        await loadMappings();
      } catch (err) { toast(err.message, 'error'); }
    }

    function drawReport() {
      drillHost.replaceChildren();
      if (!run) { reportHost.replaceChildren(); return; }
      const s = run.summary;
      const byKey = new Map(run.accounts.map((a) => [a.key, a]));
      const head = el('section', { class: 'card validation-card' });
      const eq = s.equation_holds;
      head.append(
        el('h3', {}, `Report — ${new Date(run.created_at).toLocaleString('en-IN')}`),
        el('p', { class: 'muted' }, [
          `Run ${run.id} by ${run.created_by}${run.rerun_of ? ` (re-run of ${run.rerun_of})` : ''}. Opening balances from: ${BASIS_WORDS[run.opening_basis] || run.opening_basis}. `
          + `Tolerance ₹${run.tolerance}. ${run.mappings_used} confirmed mapping(s) applied.`,
        ]),
        el('div', { class: eq ? 'banner banner-ok' : 'banner banner-danger' },
          eq ? 'Opening TB + Transactions = Closing TB: Yes — every account reconciles.'
            : `Opening TB + Transactions = Closing TB: No — ${s.differences} account(s) differ, total ₹${money(s.total_difference)}.`),
        el('div', { class: 'kpi-grid' }, [
          kpi('Accounts', String(s.accounts)),
          kpi('Reconciled', String(s.reconciled), null, 'ok'),
          kpi('Difference found', String(s.differences), `₹${money(s.total_difference)}`, s.differences ? 'warn' : 'ok'),
          kpi('Ledger debit = credit', s.totals.debit === s.totals.credit ? 'Yes' : 'No', `Dr ₹${money(s.totals.debit)} / Cr ₹${money(s.totals.credit)}`, s.totals.debit === s.totals.credit ? 'ok' : 'warn'),
          kpi('Exceptions', String(s.counts.missing_opening + s.counts.missing_closing + s.counts.unmapped + s.counts.duplicates + s.counts.inconsistencies),
            'missing, unmapped, duplicate, inconsistent'),
        ]),
      );
      const yc = run.year_end_close;
      if (yc) {
        const lines = [
          `${yc.pl_accounts} income and expense account(s) were left out of the opening: P&L balances do not carry forward.`,
          yc.opening_stock ? `${yc.opening_stock.name} opens at last year's closing stock ₹${money(yc.opening_stock.carried)} (${yc.opening_stock.source}; the Opening TB showed ₹${money(yc.opening_stock.before)}).` : null,
          yc.reserve ? `Year's ${yc.result === 'LOSS' ? 'loss' : 'profit'} ₹${money(yc.result_amount)} moved to ${yc.reserve.name}${yc.reserve.code ? ` (${yc.reserve.code})` : ''}: ₹${money(yc.reserve.before)} → ₹${money(yc.reserve.after)}.`
            + (yc.reserve.agrees === true ? ' This agrees with the opening in the Closing TB.' : yc.reserve.agrees === false ? ` The Closing TB opening shows ₹${money(yc.reserve.closing_tb_opening)} — check.` : '')
            : 'No Reserve & Surplus account was found to take the year\'s result.',
          yc.unclassified ? `${yc.unclassified} row(s) sat above the first section heading and were kept as balance sheet items.` : null,
        ].filter(Boolean);
        head.append(el('div', { class: yc.reserve && yc.reserve.agrees !== false ? 'banner banner-ok' : 'step-blocker' }, [
          el('strong', {}, 'Year-end close applied. '), lines.join(' '),
        ]));
      }
      const yearEnd = (run.exceptions.inconsistencies || []).filter((i) => i.type === 'OPENING_MISMATCH').length;
      if (yearEnd && !['closing_tb_opening_columns', 'balance_sheet_only'].includes(run.opening_basis)) {
        head.append(el('div', { class: 'step-blocker' }, [
          `${yearEnd} account(s) have an Opening TB balance different from the opening in the Closing TB. This is usually the year-end close `
          + '(income and expense accounts carried to Reserve & Surplus), so those accounts show a difference here. ',
          canRun ? el('button', { type: 'button', class: 'linklike', onclick: () => rerun({ opening_basis: 'balance_sheet_only' }) }, 'Re-run with balance sheet items only') : null,
          canRun ? ' · ' : null,
          canRun ? el('button', { type: 'button', class: 'linklike', onclick: () => rerun({ opening_basis: 'closing_tb_opening' }) }, 'Re-run using the Closing TB opening columns') : null,
        ]));
      }
      const checks = el('div');
      renderDataTable(checks, s.file_checks, [
        { key: 'file', label: 'File' },
        { key: 'check', label: 'Check' },
        { key: 'debit', label: 'Debit', render: (r) => (/^-?\d/.test(r.debit) && !/vouchers/.test(r.debit) ? num(r.debit) : r.debit) },
        { key: 'credit', label: 'Credit', render: (r) => (/^-?\d/.test(r.credit) && !/balanced/.test(r.credit) ? num(r.credit) : r.credit) },
        { key: 'ok', label: 'Result', render: (r) => (r.ok ? chip('PASS', 'OK') : chip('FAIL', 'Not OK')) },
      ]);
      const files = el('p', { class: 'muted' }, Object.entries(run.inputs || {}).filter(([, v]) => v).map(([k, v]) => `${ROLE_WORDS[k]}: ${v.name} (${v.rows} rows)`).join(' · '));
      head.append(el('h4', {}, 'File checks'), checks, files);

      // view tabs
      const count = (v) => {
        if (v === 'all') return run.accounts.length;
        if (v === 'duplicates') return run.exceptions.duplicates.length;
        if (v === 'inconsistencies') return run.exceptions.inconsistencies.length;
        return (run.exceptions[v] || []).length;
      };
      const tabs = el('div', { class: 'tab-strip' }, VIEWS.map((v) => el('button', {
        type: 'button', class: `chip-btn${view === v.value ? ' chip-btn-active' : ''}`,
        onclick: () => { view = v.value; drawReport(); },
      }, `${v.label} (${count(v.value)})`)));
      const search = el('input', { type: 'search', placeholder: 'Search code or name', value: q, oninput: (e) => { q = e.target.value.toLowerCase(); drawTable(); } });
      const dl = el('button', {
        type: 'button',
        onclick: () => downloadWithAuth(`/api/branches/${enc}/validation/runs/${encodeURIComponent(run.id)}/report.csv?view=${view}`, `validation-${branch}-${view}.csv`).catch((e) => toast(e.message, 'error')),
      }, 'Download CSV');
      const actions = el('div', { class: 'actions' }, [search, dl, canRun ? el('button', { type: 'button', class: 'linklike', onclick: () => rerun() }, 'Re-run with saved mappings') : null]);
      const tableHost = el('div');
      head.append(el('h4', {}, 'Account-wise reconciliation'), tabs, actions, tableHost);
      reportHost.replaceChildren(head);

      function drawTable() {
        const match = (code, name) => !q || `${code} ${name}`.toLowerCase().includes(q);
        if (view === 'duplicates') {
          renderDataTable(tableHost, run.exceptions.duplicates.filter((d) => match(d.account_code, d.account_name)), [
            { key: 'file', label: 'File' },
            { key: 'account_code', label: 'Code' },
            { key: 'account_name', label: 'Account' },
            { key: 'sources', label: 'Rows / names involved', render: (d) => d.sources.join(' | ') },
            { key: 'reason', label: 'Reason' },
          ], { empty: 'No duplicate mappings.' });
          return;
        }
        if (view === 'inconsistencies') {
          renderDataTable(tableHost, run.exceptions.inconsistencies.filter((d) => match(d.account_code, d.account_name)), [
            { key: 'type', label: 'Type', render: (d) => TYPE_WORDS[d.type] || d.type },
            { key: 'file', label: 'File' },
            { key: 'line', label: 'Row', render: (d) => (d.line === null || d.line === undefined ? '' : String(d.line)) },
            { key: 'account_code', label: 'Code' },
            { key: 'account_name', label: 'Account' },
            { key: 'detail', label: 'Detail', render: (d) => el('span', { class: 'wrap-text' }, d.detail) },
          ], { empty: 'No debit/credit or balance inconsistencies.' });
          return;
        }
        const keys = view === 'all' ? null : new Set(run.exceptions[view] || []);
        const rows = run.accounts.filter((a) => (!keys || keys.has(a.key)) && match(a.code, a.name));
        const columns = [
          { key: 'code', label: 'Code' },
          { key: 'name', label: 'Account Name' },
          { key: 'opening', label: 'Opening Balance', render: (r) => num(r.opening) },
          { key: 'debit', label: 'Total Debit', render: (r) => num(r.debit) },
          { key: 'credit', label: 'Total Credit', render: (r) => num(r.credit) },
          { key: 'net', label: 'Net Transaction', render: (r) => num(r.net) },
          { key: 'calculated_closing', label: 'Calculated Closing', render: (r) => num(r.calculated_closing) },
          { key: 'closing_tb', label: 'Closing TB Balance', render: (r) => num(r.closing_tb) },
          { key: 'difference', label: 'Difference', render: (r) => (Number(r.difference) ? el('strong', { class: 'error-text' }, num(r.difference)) : num(r.difference)) },
          { key: 'status', label: 'Status', render: (r) => statusChip(r.status) },
          { key: 'flags', label: 'Notes', render: (r) => el('span', { class: 'wrap-text' }, flagText(r.flags)) },
        ];
        if (view === 'unmapped' && canRun) {
          columns.push({
            key: 'map', label: 'Map to',
            render: (r) => {
              const already = mappings.find((m) => m.role === r.source_role && m.from_key === r.source_key);
              if (already) return el('span', { class: 'muted' }, `Saved → ${keyLabel(already.to_key, already.to_name)} (re-run to apply)`);
              const pool = run.accounts.filter((a) => a.key !== r.key && !a[`in_${r.source_role}`]);
              const sel = el('select', {}, [
                el('option', { value: '' }, `Choose (${ROLE_WORDS[r.source_role]} only)…`),
                ...(r.suggestions || []).map((sug) => el('option', { value: sug.key }, `★ ${sug.code ? `${sug.code} — ` : ''}${sug.name} (${Math.round(sug.score * 100)}%)`)),
                ...pool.filter((a) => !(r.suggestions || []).some((sug) => sug.key === a.key)).map((a) => el('option', { value: a.key }, `${a.code ? `${a.code} — ` : ''}${a.name}`)),
              ]);
              return el('div', { class: 'actions' }, [sel, el('button', {
                type: 'button',
                onclick: () => { const t = byKey.get(sel.value); if (!t) { toast('Choose an account first.', 'error'); return; } saveMapping(r, t); },
              }, 'Save')]);
            },
          });
        }
        if (view === 'not_in_ledger') {
          columns.splice(10, 1, { key: 'movement_expected', label: 'Notes', render: (r) => (r.movement_expected ? el('strong', { class: 'error-text' }, 'Balance changed but no transactions') : el('span', { class: 'muted' }, 'No movement — OK')) });
        }
        renderDataTable(tableHost, rows, columns, { onRowClick: (r) => openAccount(r), empty: 'No account in this view.' });
      }
      drawTable();
    }

    async function openAccount(row) {
      drillHost.replaceChildren(el('section', { class: 'card validation-card' }, [el('p', { class: 'muted' }, `Loading ${row.name}…`)]));
      try {
        const out = await api(`/api/branches/${enc}/validation/runs/${encodeURIComponent(run.id)}/lines?account=${encodeURIComponent(row.key)}`);
        const a = out.account;
        const card = el('section', { class: 'card validation-card' }, [
          el('div', { class: 'section-head' }, [
            el('h3', {}, `${a.code ? `${a.code} — ` : ''}${a.name}`),
            el('button', { type: 'button', class: 'linklike', onclick: () => drillHost.replaceChildren() }, 'Close'),
          ]),
          el('dl', { class: 'kv-list' }, [
            el('dt', {}, 'Opening balance'), el('dd', {}, money(a.opening)),
            el('dt', {}, '+ Total debit'), el('dd', {}, money(a.debit)),
            el('dt', {}, '− Total credit'), el('dd', {}, money(a.credit)),
            el('dt', {}, '= Calculated closing'), el('dd', {}, money(a.calculated_closing)),
            el('dt', {}, 'Closing TB balance'), el('dd', {}, money(a.closing_tb)),
            el('dt', {}, 'Difference'), el('dd', {}, el('strong', { class: Number(a.difference) ? 'error-text' : '' }, money(a.difference))),
            el('dt', {}, 'Status'), el('dd', {}, statusChip(a.status)),
            el('dt', {}, 'Found in'), el('dd', {}, ['opening', 'closing', 'ledger'].filter((k) => a[`in_${k}`]).map((k) => ROLE_WORDS[k]).join(', ') || '—'),
            el('dt', {}, 'Names in the files'), el('dd', {}, Object.entries(a.names || {}).map(([k, v]) => `${ROLE_WORDS[k]}: ${v.join(' / ')}`).join(' · ') || '—'),
          ]),
          el('p', { class: 'muted' }, `${out.total_lines} ledger line(s)${a.party_lines ? `, of which ${a.party_lines} are party lines posted through this control account` : ''}`
            + `${out.truncated ? `; the first ${out.lines.length} are shown` : ''}. Dates are shown as written in the ledger file.`),
        ]);
        const linesHost = el('div');
        renderDataTable(linesHost, out.lines, [
          { key: 'line', label: 'Row', render: (l) => String(l.line) },
          { key: 'date', label: 'Date' },
          { key: 'voucher', label: 'Voucher' },
          { key: 'party', label: 'Party' },
          { key: 'debit', label: 'Debit', render: (l) => num(l.debit) },
          { key: 'credit', label: 'Credit', render: (l) => num(l.credit) },
          { key: 'narration', label: 'Narration', render: (l) => el('span', { class: 'wrap-text' }, l.narration) },
        ], { empty: 'This account has no ledger transactions.' });
        card.append(linesHost);
        drillHost.replaceChildren(card);
        card.scrollIntoView({ behavior: 'smooth', block: 'start' });
      } catch (err) { showError(drillHost, err); }
    }

    await Promise.all([loadRuns(), loadMappings()]);
  }

  window.App.registerRoute('/branches/:code/validation', renderValidationPage);
})();
