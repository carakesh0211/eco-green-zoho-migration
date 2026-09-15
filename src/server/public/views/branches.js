// Branch Control Dashboard (#/branches) — the default view. One row per branch, wide
// data table, server-side search/filter/sort/pagination against GET /api/branches.
// Filters/sort/page live in the URL hash query so reload and back/forward restore
// exactly what was on screen (see App.replaceQuery). Never fetches more than one page
// and never fetches transactional records here — this is a status roll-up only; drill
// into a branch via #/branches/:code (views/branch-workspace.js) for the underlying
// runs/vouchers/queue/etc.
'use strict';

(function () {
  const { api, el, chip, chipClass, progressBar, renderDataTable, showError, notAvailableNote, debounce, toast, downloadWithAuth, navigate, replaceQuery } = window.App;

  const READINESS_VALUES = ['NOT_STARTED', 'IN_PROGRESS', 'BLOCKED', 'READY', 'MIGRATED'];
  const RECEIPT_VALUES = ['NOT_RECEIVED', 'PARTIAL', 'RECEIVED', 'VALIDATION_FAILED'];
  const LAYER_A_VALUES = ['NOT_RUN', 'PASS', 'FAIL'];
  const MAPPING_VALUES = ['NOT_STARTED', 'DRAFT', 'APPROVED'];
  const OVERLAP_VALUES = ['NOT_ASSESSED', 'CLEAR', 'OVERLAP_FOUND'];
  const APPROVAL_VALUES = ['NONE', 'DRAFT', 'READY_FOR_APPROVAL', 'APPROVED', 'REJECTED'];
  const PAGE_SIZES = ['25', '50', '100', '200'];
  const OPEN_EXCEPTIONS_VALUES = [
    { value: '', label: '(any)' },
    { value: 'any', label: 'Any (> 0)' },
    { value: 'none', label: 'None (0)' },
    { value: 'min:1', label: '≥ 1' },
    { value: 'min:5', label: '≥ 5' },
    { value: 'min:10', label: '≥ 10' },
  ];

  function selectField(labelText, name, values, current) {
    const select = el(
      'select',
      { 'data-filter': name },
      [el('option', { value: '' }, '(any)'), ...values.map((v) => el('option', { value: v, selected: v === current ? '' : null }, v))]
    );
    select.value = current || '';
    return { node: el('label', {}, [labelText, select]), select };
  }

  function renderBranchesPage(container, params, initialQuery) {
    const filters = {
      search: initialQuery.search || '',
      readiness: initialQuery.readiness || '',
      receipt: initialQuery.receipt || '',
      layerA: initialQuery.layerA || '',
      mapping: initialQuery.mapping || '',
      overlap: initialQuery.overlap || '',
      approval: initialQuery.approval || '',
      layerC: initialQuery.layerC || '',
      bridge: initialQuery.bridge || '',
      operator: initialQuery.operator || '',
      approver: initialQuery.approver || '',
      liveFrom: initialQuery.liveFrom || '',
      liveTo: initialQuery.liveTo || '',
      activityFrom: initialQuery.activityFrom || '',
      activityTo: initialQuery.activityTo || '',
      migrationMonth: initialQuery.migrationMonth || '',
      liveMonth: initialQuery.liveMonth || '',
      openExceptions: initialQuery.openExceptions || '',
      impactMin: initialQuery.impactMin || '',
      sort: initialQuery.sort || 'branch_code',
      dir: initialQuery.dir === 'desc' ? 'desc' : 'asc',
      page: Number(initialQuery.page) > 0 ? Number(initialQuery.page) : 1,
      pageSize: PAGE_SIZES.includes(String(initialQuery.pageSize)) ? String(initialQuery.pageSize) : '50',
    };

    const header = el('div', { class: 'dashboard-header' });
    const chipsRow = el('div', { class: 'chips-row' });
    const operatorWorkloadRow = el('div', { class: 'chips-row' });
    const approverWorkloadRow = el('div', { class: 'chips-row' });
    const filterBar = el('div', { class: 'controls filter-bar' });
    const tableHost = el('div');
    const paginationBar = el('div', { class: 'pagination-bar' });

    container.appendChild(el('h2', {}, 'Branch Control Dashboard'));
    container.appendChild(header);
    container.appendChild(chipsRow);
    container.appendChild(el('p', { class: 'muted small-label' }, 'Workload — operator'));
    container.appendChild(operatorWorkloadRow);
    container.appendChild(el('p', { class: 'muted small-label' }, 'Workload — approver'));
    container.appendChild(approverWorkloadRow);
    container.appendChild(filterBar);
    container.appendChild(tableHost);
    container.appendChild(paginationBar);

    function persist() {
      replaceQuery('/branches', filters);
    }

    function onFilterChanged(resetPage = true) {
      if (resetPage) filters.page = 1;
      persist();
      load();
    }

    // ---- filter bar ----
    const searchInput = el('input', { placeholder: 'Search branch code or name…', value: filters.search });
    searchInput.addEventListener(
      'input',
      debounce(() => {
        filters.search = searchInput.value.trim();
        onFilterChanged();
      }, 300)
    );

    const readinessSel = selectField('Readiness', 'readiness', READINESS_VALUES, filters.readiness);
    const receiptSel = selectField('Receipt', 'receipt', RECEIPT_VALUES, filters.receipt);
    const layerASel = selectField('Layer A', 'layerA', LAYER_A_VALUES, filters.layerA);
    const mappingSel = selectField('Mapping', 'mapping', MAPPING_VALUES, filters.mapping);
    const overlapSel = selectField('Overlap', 'overlap', OVERLAP_VALUES, filters.overlap);
    const approvalSel = selectField('Batch approval', 'approval', APPROVAL_VALUES, filters.approval);
    // layer_c_status / balance_bridge_status share Layer A's NOT_RUN | PASS | FAIL enum
    // (src/core/branch_summary.js).
    const layerCSel = selectField('Layer C', 'layerC', ['NOT_RUN', 'PASS', 'FAIL'], filters.layerC);
    const bridgeSel = selectField('Balance bridge', 'bridge', ['NOT_RUN', 'PASS', 'FAIL'], filters.bridge);
    // Operator/approver start as free-text exact-match inputs; loadFacets() below swaps
    // each host's contents for a <select> populated from GET /api/branches/facets once
    // that responds, keeping the free-text fallback if it 404s (older backend).
    const operatorHost = el('span', { class: 'filter-control-host' });
    const approverHost = el('span', { class: 'filter-control-host' });
    let operatorInput = equalityTextInput('assigned operator', 'operator');
    let approverInput = equalityTextInput('assigned approver', 'approver');
    operatorHost.appendChild(operatorInput);
    approverHost.appendChild(approverInput);

    const liveFromInput = el('input', { type: 'date', value: filters.liveFrom });
    const liveToInput = el('input', { type: 'date', value: filters.liveTo });
    const activityFromInput = el('input', { type: 'date', value: filters.activityFrom });
    const activityToInput = el('input', { type: 'date', value: filters.activityTo });
    const migrationMonthInput = el('input', { type: 'month', value: filters.migrationMonth });
    const liveMonthInput = el('input', { type: 'month', value: filters.liveMonth });
    const impactMinInput = el('input', { type: 'number', step: '0.01', min: '0', placeholder: 'min impact (₹)', value: filters.impactMin });

    const openExceptionsSel = el(
      'select',
      {},
      OPEN_EXCEPTIONS_VALUES.map((o) => el('option', { value: o.value, selected: o.value === filters.openExceptions ? '' : null }, o.label))
    );
    openExceptionsSel.value = filters.openExceptions || '';
    openExceptionsSel.addEventListener('change', () => {
      filters.openExceptions = openExceptionsSel.value;
      onFilterChanged();
    });

    /** Builds a free-text input wired to exact-match filter `key`, debounced like the
     * date-range inputs below. Factored out so loadFacets() can build the same wiring
     * for the fallback path if the facets endpoint 404s. */
    function equalityTextInput(placeholder, key) {
      const input = el('input', { placeholder, value: filters[key] });
      const handler = debounce(() => {
        filters[key] = input.value.trim();
        onFilterChanged();
      }, 300);
      input.addEventListener('input', handler);
      input.addEventListener('change', handler);
      return input;
    }

    /** Builds an exact-match <select> for filter `key` from a facets list of
     * `{ id, count }`, appending the current value as an extra option if it isn't in
     * the list (e.g. a stale/typed-in value from a restored URL) so it isn't silently
     * dropped out from under the user. */
    function equalitySelect(list, key) {
      const current = filters[key] || '';
      const options = [el('option', { value: '' }, '(any)')];
      let hasCurrent = current === '';
      for (const { id, count } of list) {
        if (id === current) hasCurrent = true;
        options.push(el('option', { value: id }, `${id} (${count})`));
      }
      if (!hasCurrent) options.push(el('option', { value: current }, current));
      const select = el('select', {}, options);
      select.value = current;
      select.addEventListener('change', () => {
        filters[key] = select.value;
        onFilterChanged();
      });
      return select;
    }

    async function loadFacets() {
      let facets = null;
      try {
        facets = await window.App.apiOptional('/api/branches/facets');
      } catch {
        facets = null; // treat any facets failure as "fall back to free text", not a page error
      }
      if (!facets) return;
      operatorHost.innerHTML = '';
      operatorInput = equalitySelect(facets.operators ?? [], 'operator');
      operatorHost.appendChild(operatorInput);
      approverHost.innerHTML = '';
      approverInput = equalitySelect(facets.approvers ?? [], 'approver');
      approverHost.appendChild(approverInput);
    }
    loadFacets();

    for (const [sel, key] of [
      [readinessSel, 'readiness'], [receiptSel, 'receipt'], [layerASel, 'layerA'],
      [mappingSel, 'mapping'], [overlapSel, 'overlap'], [approvalSel, 'approval'],
      [layerCSel, 'layerC'], [bridgeSel, 'bridge'],
    ]) {
      sel.select.addEventListener('change', () => {
        filters[key] = sel.select.value;
        onFilterChanged();
      });
    }
    for (const [input, key] of [
      [liveFromInput, 'liveFrom'], [liveToInput, 'liveTo'], [activityFromInput, 'activityFrom'], [activityToInput, 'activityTo'],
      [migrationMonthInput, 'migrationMonth'], [liveMonthInput, 'liveMonth'], [impactMinInput, 'impactMin'],
    ]) {
      const handler = debounce(() => {
        filters[key] = input.value.trim();
        onFilterChanged();
      }, 300);
      input.addEventListener('input', handler);
      input.addEventListener('change', handler);
    }

    const exportBtn = el('button', {
      onclick: async () => {
        try {
          await downloadWithAuth(`/api/branches/export.csv?${window.App.buildQueryString(filters)}`, 'branches.csv');
        } catch (err) {
          if (err.status === 404 || err.status === 501) toast('CSV export is not available yet.', 'error');
          else toast(err.message, 'error');
        }
      },
    }, 'Export CSV');

    filterBar.appendChild(searchInput);
    filterBar.appendChild(readinessSel.node);
    filterBar.appendChild(receiptSel.node);
    filterBar.appendChild(layerASel.node);
    filterBar.appendChild(mappingSel.node);
    filterBar.appendChild(overlapSel.node);
    filterBar.appendChild(approvalSel.node);
    filterBar.appendChild(layerCSel.node);
    filterBar.appendChild(bridgeSel.node);
    filterBar.appendChild(el('label', {}, ['Operator', operatorHost]));
    filterBar.appendChild(el('label', {}, ['Approver', approverHost]));
    filterBar.appendChild(el('label', {}, ['Migration month', migrationMonthInput]));
    filterBar.appendChild(el('label', {}, ['Live month', liveMonthInput]));
    filterBar.appendChild(el('label', {}, ['Open exceptions', openExceptionsSel]));
    filterBar.appendChild(el('label', {}, ['Min exception impact', impactMinInput]));
    filterBar.appendChild(el('label', {}, ['Live start from', liveFromInput]));
    filterBar.appendChild(el('label', {}, ['Live start to', liveToInput]));
    filterBar.appendChild(el('label', {}, ['Activity from', activityFromInput]));
    filterBar.appendChild(el('label', {}, ['Activity to', activityToInput]));
    filterBar.appendChild(exportBtn);

    // ---- columns ----
    const columns = [
      { key: 'branch_code', label: 'Code', sortable: true, render: (r) => el('button', { class: 'linklike', onclick: () => navigate(`/branches/${encodeURIComponent(r.branch_code)}`) }, [r.branch_code, r.is_synthetic ? el('span', { class: 'badge badge-warn ml8' }, 'SYNTHETIC') : null]) },
      { key: 'branch_name', label: 'Name', sortable: true, render: (r) => r.branch_name || '' },
      { key: 'zoho_location_name', label: 'Books location', sortable: true, render: (r) => r.zoho_location_name || r.zoho_location_id || '' },
      { key: 'assigned_operator', label: 'Operator', sortable: true, render: (r) => r.assigned_operator || '—' },
      { key: 'assigned_approver', label: 'Approver', sortable: true, render: (r) => r.assigned_approver || '—' },
      { key: 'live_start_date', label: 'Live start', sortable: true, render: (r) => r.live_start_date || '—' },
      { key: 'migration_range', label: 'Migration range', render: (r) => `${r.migration_from_date || '—'} → ${r.migration_to_date || '—'}` },
      { key: 'receipt_status', label: 'Receipt', sortable: true, render: (r) => chip(r.receipt_status) },
      { key: 'layer_a_status', label: 'Layer A', sortable: true, render: (r) => chip(r.layer_a_status) },
      { key: 'mapping_status', label: 'Mapping', sortable: true, render: (r) => chip(r.mapping_status) },
      { key: 'overlap_status', label: 'Overlap', sortable: true, render: (r) => chip(r.overlap_status) },
      {
        key: 'open_exception_count',
        label: 'Open exceptions',
        sortable: true,
        render: (r) => el('span', {}, `${r.open_exception_count ?? 0} (₹${r.open_exception_impact ?? '0.00'})`),
      },
      { key: 'batch_approval_status', label: 'Batch approval', sortable: true, render: (r) => chip(r.batch_approval_status) },
      {
        key: 'migration_progress_pct',
        label: 'Migrated',
        sortable: true,
        render: (r) => el('div', {}, [progressBar(r.migration_progress_pct), el('span', { class: 'muted' }, ` ${r.migrated_count ?? 0}/${r.total_count ?? 0}`)]),
      },
      { key: 'layer_c_status', label: 'Layer C', sortable: true, render: (r) => chip(r.layer_c_status) },
      { key: 'balance_bridge_status', label: 'Balance bridge', sortable: true, render: (r) => chip(r.balance_bridge_status) },
      { key: 'last_activity_at', label: 'Last activity', sortable: true, render: (r) => r.last_activity_at || '—' },
      { key: 'readiness_status', label: 'Readiness', sortable: true, render: (r) => chip(r.readiness_status) },
    ];

    function headerCell(col) {
      if (!col.sortable) return el('th', {}, col.label);
      const active = filters.sort === col.key;
      const arrow = active ? (filters.dir === 'asc' ? ' ▲' : ' ▼') : '';
      return el(
        'th',
        {},
        el('button', {
          class: 'linklike th-sort',
          onclick: () => {
            if (filters.sort === col.key) filters.dir = filters.dir === 'asc' ? 'desc' : 'asc';
            else {
              filters.sort = col.key;
              filters.dir = 'asc';
            }
            onFilterChanged();
          },
        }, col.label + arrow)
      );
    }
    for (const c of columns) c.headerNode = headerCell(c);

    async function load() {
      // re-derive header nodes each render (sort arrow can change)
      for (const c of columns) c.headerNode = headerCell(c);
      const q = window.App.buildQueryString(filters);
      header.innerHTML = '';
      header.appendChild(el('p', { class: 'muted' }, 'Loading…'));
      let data;
      try {
        data = await api(`/api/branches?${q}`);
      } catch (err) {
        if (err.status === 404 || err.status === 501) {
          header.innerHTML = '';
          notAvailableNote(tableHost, 'Branch dashboard API (GET /api/branches) is not available yet.');
          chipsRow.innerHTML = '';
          operatorWorkloadRow.innerHTML = '';
          approverWorkloadRow.innerHTML = '';
          paginationBar.innerHTML = '';
          return;
        }
        header.innerHTML = '';
        showError(tableHost, err);
        return;
      }

      header.innerHTML = '';
      header.appendChild(el('p', { class: 'muted' }, `Expected branches: ${data.expectedBranchCount ?? '—'} · loaded page in ${data.meta?.queryMs ?? '—'} ms`));

      chipsRow.innerHTML = '';
      const counts = data.counts?.byReadiness ?? {};
      for (const r of READINESS_VALUES) {
        const active = filters.readiness === r;
        chipsRow.appendChild(
          el('button', {
            class: `chip-btn ${chipClass(r)}${active ? ' chip-btn-active' : ''}`,
            onclick: () => {
              filters.readiness = active ? '' : r;
              onFilterChanged();
            },
          }, `${r}: ${counts[r] ?? 0}`)
        );
      }

      renderWorkloadRow(operatorWorkloadRow, data.counts?.byOperator ?? {}, 'operator');
      renderWorkloadRow(approverWorkloadRow, data.counts?.byApprover ?? {}, 'approver');

      renderDataTable(tableHost, data.items, columns, {
        onRowClick: (row) => navigate(`/branches/${encodeURIComponent(row.branch_code)}`),
        empty: 'No branches match these filters.',
      });

      renderPagination(data);
    }

    /** Workload chip row: one chip per operator/approver id with their row count over
     * the current filtered+scoped set. Clicking a chip toggles that id as the
     * corresponding exact-match filter — same toggle behaviour as the readiness chips. */
    function renderWorkloadRow(rowEl, counts, key) {
      rowEl.innerHTML = '';
      const ids = Object.keys(counts).sort((a, b) => counts[b] - counts[a] || (a < b ? -1 : a > b ? 1 : 0));
      if (ids.length === 0) {
        rowEl.appendChild(el('span', { class: 'muted' }, 'No assignments in this view.'));
        return;
      }
      for (const id of ids) {
        const active = filters[key] === id;
        rowEl.appendChild(
          el('button', {
            class: `chip-btn chip-grey${active ? ' chip-btn-active' : ''}`,
            onclick: () => {
              filters[key] = active ? '' : id;
              onFilterChanged();
            },
          }, `${id}: ${counts[id]}`)
        );
      }
    }

    function renderPagination(data) {
      paginationBar.innerHTML = '';
      const page = data.page ?? filters.page;
      const pageSize = data.pageSize ?? Number(filters.pageSize);
      const total = data.total ?? 0;
      const totalPages = data.totalPages ?? Math.max(1, Math.ceil(total / pageSize));
      const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
      const to = Math.min(total, page * pageSize);

      const pageSizeSelect = el(
        'select',
        {},
        PAGE_SIZES.map((s) => el('option', { value: s }, s))
      );
      pageSizeSelect.value = String(pageSize);
      pageSizeSelect.addEventListener('change', () => {
        filters.pageSize = pageSizeSelect.value;
        onFilterChanged();
      });

      const goToPage = (p) => {
        filters.page = Math.max(1, Math.min(totalPages, p));
        onFilterChanged(false);
      };

      paginationBar.appendChild(el('button', { onclick: () => goToPage(1), disabled: page <= 1 ? '' : null }, 'First'));
      paginationBar.appendChild(el('button', { onclick: () => goToPage(page - 1), disabled: page <= 1 ? '' : null }, 'Prev'));
      paginationBar.appendChild(el('span', { class: 'muted' }, ` Page ${page} of ${totalPages} `));
      paginationBar.appendChild(el('button', { onclick: () => goToPage(page + 1), disabled: page >= totalPages ? '' : null }, 'Next'));
      paginationBar.appendChild(el('button', { onclick: () => goToPage(totalPages), disabled: page >= totalPages ? '' : null }, 'Last'));
      paginationBar.appendChild(el('label', { class: 'ml8' }, ['Page size', pageSizeSelect]));
      paginationBar.appendChild(el('span', { class: 'muted ml8' }, `Showing ${from}–${to} of ${total}`));
    }

    persist();
    load();
  }

  window.App.registerRoute('/branches', renderBranchesPage);
})();
