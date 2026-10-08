// Branches (#/branches) — one row per branch, server-side search/filter/sort/pagination
// against GET /api/branches. Primary filters (search, readiness, operator, approver) sit
// in the filter bar; every other filter is tucked under "More filters" (auto-opened when
// one is active in the URL). Workload cards live in a collapsed section under the table.
// Filters/sort/page live in the URL hash query so reload and back/forward restore
// exactly what was on screen (see App.replaceQuery). Never fetches more than one page
// and never fetches transactional records here — this is a status roll-up only; drill
// into a branch via #/branches/:code (views/branch-workspace.js) for the underlying
// runs/vouchers/queue/etc.
'use strict';

(function () {
  const { api, el, chip, progressBar, renderDataTable, showError, notAvailableNote, debounce, toast, downloadWithAuth, navigate, replaceQuery } = window.App;

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
  // Every filter that lives under "More filters" (query-param names unchanged).
  const SECONDARY_KEYS = [
    'receipt', 'layerA', 'mapping', 'overlap', 'approval', 'layerC', 'bridge',
    'liveFrom', 'liveTo', 'activityFrom', 'activityTo', 'migrationMonth', 'liveMonth',
    'openExceptions', 'impactMin',
  ];
  const KPI_LABELS = { NOT_STARTED: 'Not started', IN_PROGRESS: 'In progress', BLOCKED: 'Blocked', READY: 'Ready', MIGRATED: 'Migrated' };
  const KPI_CLASS = { BLOCKED: 'kpi-danger', READY: 'kpi-ok', MIGRATED: 'kpi-ok', IN_PROGRESS: 'kpi-warn' };

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

    window.App.setPageTitle?.('Branches');
    const page = el('div', { class: 'page' });
    container.appendChild(page);

    const subtitle = el('div', { class: 'subtitle' }, 'Loading…');
    const kpiRow = el('div', { class: 'kpi-grid' });
    const operatorWorkloadRow = el('div', { class: 'chips-row' });
    const approverWorkloadRow = el('div', { class: 'chips-row' });
    const filterBar = el('div', { class: 'controls filter-bar' });
    const moreFilters = el('div', { class: 'controls filter-bar' });
    const tableHost = el('div');
    const paginationBar = el('div', { class: 'pagination-bar' });

    function persist() {
      replaceQuery('/branches', filters);
    }

    function onFilterChanged(resetPage = true) {
      if (resetPage) filters.page = 1;
      persist();
      load();
    }

    // ---- filter controls ----
    const searchInput = el('input', { placeholder: 'Search branch code or name…', value: filters.search });
    searchInput.addEventListener(
      'input',
      debounce(() => {
        filters.search = searchInput.value.trim();
        onFilterChanged();
      }, 300)
    );

    const readinessSel = selectField('Readiness', 'readiness', READINESS_VALUES, filters.readiness);
    const receiptSel = selectField('Files received', 'receipt', RECEIPT_VALUES, filters.receipt);
    const layerASel = selectField('Source reconciliation', 'layerA', LAYER_A_VALUES, filters.layerA);
    const mappingSel = selectField('Mapping', 'mapping', MAPPING_VALUES, filters.mapping);
    const overlapSel = selectField('Overlap check', 'overlap', OVERLAP_VALUES, filters.overlap);
    const approvalSel = selectField('Approval', 'approval', APPROVAL_VALUES, filters.approval);
    // layer_c_status / balance_bridge_status share Layer A's NOT_RUN | PASS | FAIL enum
    // (src/core/branch_summary.js).
    const layerCSel = selectField('Books reconciliation', 'layerC', ['NOT_RUN', 'PASS', 'FAIL'], filters.layerC);
    const bridgeSel = selectField('Balance proof', 'bridge', ['NOT_RUN', 'PASS', 'FAIL'], filters.bridge);
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
      type: 'button',
      onclick: async () => {
        try {
          await downloadWithAuth(`/api/branches/export.csv?${window.App.buildQueryString(filters)}`, 'branches.csv');
        } catch (err) {
          if (err.status === 404 || err.status === 501) toast('CSV export is not available yet.', 'error');
          else toast(err.message, 'error');
        }
      },
    }, 'Export CSV');

    // Primary filters stay in the bar; everything else goes under "More filters".
    filterBar.appendChild(searchInput);
    filterBar.appendChild(readinessSel.node);
    filterBar.appendChild(el('label', {}, ['Operator', operatorHost]));
    filterBar.appendChild(el('label', {}, ['Approver', approverHost]));

    for (const node of [
      receiptSel.node, layerASel.node, mappingSel.node, overlapSel.node, approvalSel.node, layerCSel.node, bridgeSel.node,
      el('label', {}, ['Open exceptions', openExceptionsSel]),
      el('label', {}, ['Min exception impact', impactMinInput]),
      el('label', {}, ['Migration month', migrationMonthInput]),
      el('label', {}, ['Live month', liveMonthInput]),
      el('label', {}, ['Live start from', liveFromInput]),
      el('label', {}, ['Live start to', liveToInput]),
      el('label', {}, ['Activity from', activityFromInput]),
      el('label', {}, ['Activity to', activityToInput]),
    ]) {
      moreFilters.appendChild(node);
    }

    // ---- page skeleton ----
    const moreDetails = el('details', { class: 'collapsible', open: SECONDARY_KEYS.some((k) => filters[k]) ? '' : null }, [
      el('summary', {}, 'More filters'),
      moreFilters,
    ]);
    page.appendChild(
      el('div', { class: 'page-header' }, [
        el('div', {}, [el('h2', {}, 'Branches'), subtitle]),
        el('div', { class: 'actions' }, [exportBtn]),
      ])
    );
    page.appendChild(kpiRow);
    page.appendChild(el('div', { class: 'card' }, [filterBar, moreDetails]));
    page.appendChild(tableHost);
    page.appendChild(paginationBar);
    page.appendChild(
      el('details', { class: 'collapsible' }, [
        el('summary', {}, 'Workload by operator and approver'),
        el('p', { class: 'muted small-label' }, 'Operator'),
        operatorWorkloadRow,
        el('p', { class: 'muted small-label' }, 'Approver'),
        approverWorkloadRow,
      ])
    );

    // ---- columns ----
    const columns = [
      { key: 'branch_code', label: 'Code', sortable: true, render: (r) => el('button', { type: 'button', class: 'linklike', onclick: () => navigate(`/branches/${encodeURIComponent(r.branch_code)}`) }, [r.branch_code, r.is_synthetic ? el('span', { class: 'badge badge-warn ml8' }, 'SYNTHETIC') : null]) },
      { key: 'branch_name', label: 'Name', sortable: true, render: (r) => r.branch_name || '' },
      { key: 'readiness_status', label: 'Readiness', sortable: true, render: (r) => chip(r.readiness_status) },
      { key: 'receipt_status', label: 'Files', sortable: true, render: (r) => chip(r.receipt_status) },
      { key: 'layer_a_status', label: 'Source recon', sortable: true, render: (r) => chip(r.layer_a_status) },
      { key: 'mapping_status', label: 'Mapping', sortable: true, render: (r) => chip(r.mapping_status) },
      { key: 'batch_approval_status', label: 'Approval', sortable: true, render: (r) => chip(r.batch_approval_status) },
      {
        key: 'migration_progress_pct',
        label: 'Progress',
        sortable: true,
        render: (r) => el('div', {}, [progressBar(r.migration_progress_pct), el('span', { class: 'muted' }, ` ${r.migrated_count ?? 0}/${r.total_count ?? 0}`)]),
      },
      {
        key: 'open_exception_count',
        label: 'Open exceptions',
        sortable: true,
        render: (r) => el('span', {}, `${r.open_exception_count ?? 0} (₹${r.open_exception_impact ?? '0.00'})`),
      },
      { key: 'assigned_operator', label: 'Operator', sortable: true, render: (r) => r.assigned_operator || '—' },
      { key: 'assigned_approver', label: 'Approver', sortable: true, render: (r) => r.assigned_approver || '—' },
      { key: 'last_activity_at', label: 'Last activity', sortable: true, render: (r) => r.last_activity_at || '—' },
    ];

    function headerCell(col) {
      if (!col.sortable) return el('th', {}, col.label);
      const active = filters.sort === col.key;
      const arrow = active ? (filters.dir === 'asc' ? ' ▲' : ' ▼') : '';
      return el(
        'th',
        {},
        el('button', {
          type: 'button',
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

    /** Keeps the visible controls in step with `filters`: a KPI tile or workload chip may
     * have changed a value the control itself did not set. */
    function syncControls() {
      readinessSel.select.value = filters.readiness || '';
      if (operatorInput.value !== filters.operator) operatorInput.value = filters.operator || '';
      if (approverInput.value !== filters.approver) approverInput.value = filters.approver || '';
    }

    async function load() {
      // re-derive header nodes each render (sort arrow can change)
      for (const c of columns) c.headerNode = headerCell(c);
      const q = window.App.buildQueryString(filters);
      let data;
      try {
        data = await api(`/api/branches?${q}`);
      } catch (err) {
        if (err.status === 404 || err.status === 501) {
          subtitle.textContent = 'The branch list is not available yet.';
          notAvailableNote(tableHost, 'Branch dashboard API (GET /api/branches) is not available yet.');
          kpiRow.innerHTML = '';
          operatorWorkloadRow.innerHTML = '';
          approverWorkloadRow.innerHTML = '';
          paginationBar.innerHTML = '';
          return;
        }
        showError(tableHost, err);
        return;
      }

      subtitle.textContent = `Expected ${data.expectedBranchCount ?? '—'} branches`;

      kpiRow.innerHTML = '';
      const counts = data.counts?.byReadiness ?? {};
      for (const r of READINESS_VALUES) {
        const active = filters.readiness === r;
        const toggleReadiness = () => {
          filters.readiness = active ? '' : r;
          onFilterChanged();
        };
        kpiRow.appendChild(
          el('div', {
            class: `kpi ${KPI_CLASS[r] || ''}`.trim(),
            role: 'button',
            tabindex: '0',
            'data-readiness': r,
            onclick: toggleReadiness,
            onkeydown: (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                toggleReadiness();
              }
            },
          }, [
            el('div', { class: 'kpi-label' }, KPI_LABELS[r]),
            el('div', { class: 'kpi-value' }, String(counts[r] ?? 0)),
            el('div', { class: 'kpi-hint' }, active ? 'Filtering by this. Click to clear.' : 'Click to filter'),
          ])
        );
      }

      renderWorkloadRow(operatorWorkloadRow, data.counts?.byOperator ?? {}, 'operator');
      renderWorkloadRow(approverWorkloadRow, data.counts?.byApprover ?? {}, 'approver');

      renderDataTable(tableHost, data.items, columns, {
        onRowClick: (row) => navigate(`/branches/${encodeURIComponent(row.branch_code)}`),
        empty: 'No branches match these filters.',
      });

      renderPagination(data);
      syncControls();
    }

    /** Workload chip row: one chip per operator/approver id with their row count over
     * the current filtered+scoped set. Clicking a chip toggles that id as the
     * corresponding exact-match filter, same toggle behaviour as the readiness tiles. */
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
            type: 'button',
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

      paginationBar.appendChild(el('button', { type: 'button', onclick: () => goToPage(1), disabled: page <= 1 ? '' : null }, 'First'));
      paginationBar.appendChild(el('button', { type: 'button', onclick: () => goToPage(page - 1), disabled: page <= 1 ? '' : null }, 'Prev'));
      paginationBar.appendChild(el('span', { class: 'muted' }, ` Page ${page} of ${totalPages} `));
      paginationBar.appendChild(el('button', { type: 'button', onclick: () => goToPage(page + 1), disabled: page >= totalPages ? '' : null }, 'Next'));
      paginationBar.appendChild(el('button', { type: 'button', onclick: () => goToPage(totalPages), disabled: page >= totalPages ? '' : null }, 'Last'));
      paginationBar.appendChild(el('label', { class: 'ml8' }, ['Page size', pageSizeSelect]));
      paginationBar.appendChild(el('span', { class: 'muted ml8' }, `Showing ${from}–${to} of ${total}`));
    }

    persist();
    load();
  }

  window.App.registerRoute('/branches', renderBranchesPage);
})();
