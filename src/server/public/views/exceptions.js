// Exceptions queue (#/exceptions): every exception across all branches the signed-in user
// may see, newest first. Filters live in the URL hash so a link such as
// #/exceptions?branch=461 works and reload restores the screen. Row actions follow the
// server's role rules (the server re-checks everything): Assign for operator/approver/admin,
// Resolve for approver/admin. Nothing is ever deleted; resolving writes an audit event.
'use strict';

(function () {
  const { api, el, renderDataTable, showError, toast, hasRole, humanize, severityChip, plain, chip, replaceQuery } = window.App;

  // Mirrors src/core/exceptions.js (CATEGORIES) and the status enum in schema.sql.
  const CATEGORIES = [
    'SCHEMA_FAILURE', 'MISSING_KEY', 'ORPHAN_RELATIONSHIP', 'DUPLICATE_SOURCE', 'DUPLICATE_FILE',
    'UNMAPPED_ENTITY', 'UNMAPPED_MODULE', 'AMBIGUOUS_MAPPING', 'UNBALANCED_VOUCHER', 'INVALID_TARGET_TYPE',
    'SMART_PHARMA_OVERLAP', 'CUTOVER_RULE_MISSING', 'LATE_OR_BACK_POSTED', 'API_VALIDATION_ERROR',
    'AUTHENTICATION_ERROR', 'RATE_LIMIT', 'TRANSIENT_FAILURE', 'UNKNOWN_API_OUTCOME', 'TARGET_MISMATCH',
    'RECONCILIATION_DIFFERENCE', 'POSTING_DISABLED',
  ];
  const STATUS_OPTIONS = [
    { value: '', label: 'Open and assigned (needs work)' },
    { value: 'OPEN', label: 'Open (nobody has picked it up)' },
    { value: 'ASSIGNED', label: 'Assigned' },
    { value: 'RESOLVED', label: 'Resolved' },
    { value: 'APPROVED_EXCEPTION', label: 'Accepted as an exception' },
    { value: 'REJECTED', label: 'Rejected' },
    { value: 'ALL', label: 'All' },
  ];
  const STATUS_WORDS = {
    OPEN: 'Open',
    ASSIGNED: 'Assigned',
    RESOLVED: 'Resolved',
    APPROVED_EXCEPTION: 'Accepted exception',
    REJECTED: 'Rejected',
  };
  const RESOLVE_OUTCOMES = [
    { value: 'RESOLVED', label: 'Resolved – the problem is fixed' },
    { value: 'APPROVED_EXCEPTION', label: 'Accepted as an exception – no fix needed' },
    { value: 'REJECTED', label: 'Rejected – not accepted' },
  ];
  const PAGE_SIZE = 50;
  const WORKING = new Set(['OPEN', 'ASSIGNED']);

  const canAssign = () => hasRole('operator', 'approver', 'admin');
  const canResolve = () => hasRole('approver', 'admin');

  // ------------------------------------------------------------ modal

  function openModal({ title, intro, fields, submitLabel, onSubmit }) {
    const previouslyFocused = document.activeElement;
    const overlay = el('div', { class: 'modal-overlay' });
    const errorP = el('p', { class: 'muted error-text', role: 'alert' }, '');
    const submit = el('button', { type: 'button', class: 'primary' }, submitLabel);
    const close = () => {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      if (previouslyFocused && previouslyFocused.focus) previouslyFocused.focus();
    };
    function onKey(e) {
      if (e.key === 'Escape') close();
    }
    document.addEventListener('keydown', onKey);
    submit.addEventListener('click', async () => {
      errorP.textContent = '';
      submit.disabled = true;
      try {
        await onSubmit(close, (msg) => { errorP.textContent = msg; });
      } finally {
        submit.disabled = false;
      }
    });
    const box = el('div', { class: 'modal-box', role: 'dialog', 'aria-modal': 'true', 'aria-label': title }, [
      el('h3', {}, title),
      intro ? el('p', { class: 'muted' }, intro) : null,
      el('div', { class: 'form-stack' }, fields),
      errorP,
      el('div', { class: 'controls' }, [submit, el('button', { type: 'button', onclick: close }, 'Cancel')]),
    ]);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    const first = box.querySelector('input,select,textarea');
    if (first) first.focus();
  }

  function labelled(text, control) {
    return el('label', {}, [text, control]);
  }

  function describe(row) {
    return `${humanize(row.category)} · branch ${row.branch_code || 'n/a'}`;
  }

  function assignModal(row, onDone) {
    const me = window.App.state.user;
    const owner = el('input', { value: row.owner || me?.id || '', autocomplete: 'off' });
    const reason = el('textarea', { rows: '2', placeholder: 'Optional – why this person?' });
    openModal({
      title: 'Assign exception',
      intro: describe(row),
      fields: [labelled('Assign to (user id)', owner), labelled('Note', reason)],
      submitLabel: 'Assign',
      onSubmit: async (close, fail) => {
        const who = owner.value.trim();
        if (!who) return fail('Enter the user id of the person who should handle this.');
        try {
          await api(`/api/exceptions/${row.id}/assign`, { method: 'POST', body: { owner: who, reason: reason.value.trim() || undefined } });
          toast(`Assigned to ${who}.`, 'success');
          close();
          onDone();
        } catch (err) {
          fail(err.message);
        }
      },
    });
  }

  function resolveModal(row, onDone) {
    const outcome = el('select', {}, RESOLVE_OUTCOMES.map((o) => el('option', { value: o.value }, o.label)));
    const rootCause = el('textarea', { rows: '2', placeholder: 'What caused this?' });
    const disposition = el('textarea', { rows: '2', placeholder: 'What was done about it?' });
    openModal({
      title: 'Resolve exception',
      intro: `${describe(row)}. This is recorded in the audit trail and cannot be deleted.`,
      fields: [labelled('Outcome', outcome), labelled('Cause (note)', rootCause), labelled('What was done', disposition)],
      submitLabel: 'Save outcome',
      onSubmit: async (close, fail) => {
        if (!rootCause.value.trim() || !disposition.value.trim()) return fail('Please fill in both the cause and what was done.');
        try {
          await api(`/api/exceptions/${row.id}/resolve`, {
            method: 'POST',
            body: { status: outcome.value, rootCause: rootCause.value.trim(), disposition: disposition.value.trim() },
          });
          toast('Exception updated.', 'success');
          close();
          onDone();
        } catch (err) {
          fail(err.status === 403 ? 'Your role is not allowed to record that outcome.' : err.message);
        }
      },
    });
  }

  // ------------------------------------------------------------ page

  function fmtDate(iso) {
    return iso ? String(iso).replace('T', ' ').slice(0, 16) : '—';
  }

  async function renderExceptionsPage(container, params, initialQuery) {
    window.App.setPageTitle('Exceptions');
    const filters = {
      branch: initialQuery.branch || '',
      status: initialQuery.status || '',
      category: initialQuery.category || '',
    };
    let rows = [];
    let page = 1;

    const page_ = el('div', { class: 'page' });
    container.appendChild(page_);

    const refreshBtn = el('button', { type: 'button', onclick: () => load() }, 'Refresh');
    page_.appendChild(
      el('div', { class: 'page-header' }, [
        el('div', {}, [
          el('h2', {}, 'Exceptions'),
          el('div', { class: 'subtitle' }, 'Problems found while checking branch data. Each one needs a person to fix it or accept it before the branch can move on.'),
        ]),
        el('div', { class: 'actions' }, [refreshBtn]),
      ])
    );

    const branchInput = el('input', { value: filters.branch, placeholder: 'e.g. 461', autocomplete: 'off' });
    const statusSel = el('select', {}, STATUS_OPTIONS.map((o) => el('option', { value: o.value }, o.label)));
    statusSel.value = filters.status;
    const categorySel = el('select', {}, [
      el('option', { value: '' }, 'All kinds'),
      ...CATEGORIES.map((c) => el('option', { value: c }, humanize(c))),
    ]);
    categorySel.value = filters.category;
    page_.appendChild(
      el('div', { class: 'card' }, [
        el('div', { class: 'controls filter-bar' }, [
          labelled('Branch code', branchInput),
          labelled('Status', statusSel),
          labelled('Kind', categorySel),
          el('button', { type: 'button', class: 'linklike', onclick: clearFilters }, 'Clear filters'),
        ]),
      ])
    );

    const summary = el('div', { class: 'muted', role: 'status' }, '');
    const tableHost = el('div', { class: 'card' });
    const pager = el('div', { class: 'pagination-bar' });
    page_.appendChild(summary);
    page_.appendChild(tableHost);
    page_.appendChild(pager);

    function syncUrl() {
      replaceQuery('/exceptions', { branch: filters.branch, status: filters.status, category: filters.category });
    }

    function clearFilters() {
      filters.branch = '';
      filters.status = '';
      filters.category = '';
      branchInput.value = '';
      statusSel.value = '';
      categorySel.value = '';
      syncUrl();
      load();
    }

    async function load() {
      tableHost.innerHTML = '';
      tableHost.appendChild(el('p', { class: 'empty' }, 'Loading...'));
      const qs = new URLSearchParams();
      if (filters.branch) qs.set('branch', filters.branch);
      if (filters.category) qs.set('category', filters.category);
      // '' = the default "needs work" view (open + assigned) is filtered here, because the
      // API only accepts one exact status. 'ALL' sends no status at all.
      if (filters.status && filters.status !== 'ALL') qs.set('status', filters.status);
      try {
        const data = await api(`/api/exceptions${qs.toString() ? `?${qs}` : ''}`);
        rows = data.exceptions ?? [];
      } catch (err) {
        summary.textContent = '';
        pager.innerHTML = '';
        if (err.status === 403) {
          tableHost.innerHTML = '';
          tableHost.appendChild(el('p', { class: 'empty error-text' }, filters.branch ? `You do not have access to branch ${filters.branch}.` : 'You do not have access to these exceptions.'));
        } else {
          showError(tableHost, err);
        }
        return;
      }
      if (!filters.status) rows = rows.filter((r) => WORKING.has(r.status));
      // Keep the sidebar badge honest whenever we have the full open list in hand.
      if (!filters.branch && !filters.category && (!filters.status || filters.status === 'OPEN')) {
        window.App.setOpenExceptionCount(rows.filter((r) => r.status === 'OPEN').length);
      } else {
        window.App.refreshOpenExceptionCount(true);
      }
      page = 1;
      draw();
    }

    function draw() {
      const total = rows.length;
      const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
      page = Math.min(page, pages);
      const start = (page - 1) * PAGE_SIZE;
      const slice = rows.slice(start, start + PAGE_SIZE);
      summary.textContent = total === 0 ? '' : `Showing ${start + 1}–${start + slice.length} of ${total}`;

      const columns = [
        { key: 'created_at', label: 'Raised', render: (r) => fmtDate(r.created_at) },
        {
          key: 'branch_code',
          label: 'Branch',
          render: (r) => (r.branch_code ? el('a', { href: `#/branches/${encodeURIComponent(r.branch_code)}` }, r.branch_code) : '—'),
        },
        { key: 'category', label: 'Kind', render: (r) => humanize(r.category) },
        { key: 'severity', label: 'How serious', render: (r) => severityChip(r.severity) },
        {
          key: 'message',
          label: 'What happened',
          render: (r) => {
            const kids = [el('span', { class: 'wrap-text' }, plain(r.message) || '—')];
            if (r.root_cause || r.disposition) {
              kids.push(el('span', { class: 'wrap-text muted' }, [plain(r.root_cause) && `Cause: ${plain(r.root_cause)}`, plain(r.disposition) && ` Action: ${plain(r.disposition)}`].filter(Boolean).join(' · ')));
            }
            return el('div', { class: 'stack' }, kids);
          },
        },
        { key: 'owner', label: 'Assigned to', render: (r) => r.owner || el('span', { class: 'muted' }, 'Nobody yet') },
        { key: 'status', label: 'Status', render: (r) => chip(r.status, STATUS_WORDS[r.status] || humanize(r.status)) },
      ];
      if (canAssign() || canResolve()) {
        columns.push({
          key: 'actions',
          label: 'Actions',
          render: (r) => {
            if (!WORKING.has(r.status)) return el('span', { class: 'muted' }, '—');
            const wrap = el('div', { class: 'actions' });
            if (canAssign()) wrap.appendChild(el('button', { type: 'button', onclick: () => assignModal(r, load) }, r.owner ? 'Reassign' : 'Assign'));
            if (canResolve()) wrap.appendChild(el('button', { type: 'button', onclick: () => resolveModal(r, load) }, 'Resolve'));
            return wrap;
          },
        });
      }
      const emptyMsg = filters.status === '' && !filters.branch && !filters.category
        ? 'No exceptions need work right now.'
        : 'No exceptions match these filters.';
      renderDataTable(tableHost, slice, columns, { empty: emptyMsg });
      if (total === 0) {
        tableHost.firstChild.className = 'empty';
      }

      pager.innerHTML = '';
      if (pages > 1) {
        pager.appendChild(el('button', { type: 'button', disabled: page <= 1 ? '' : null, onclick: () => { page -= 1; draw(); } }, 'Previous'));
        pager.appendChild(el('span', {}, `Page ${page} of ${pages}`));
        pager.appendChild(el('button', { type: 'button', disabled: page >= pages ? '' : null, onclick: () => { page += 1; draw(); } }, 'Next'));
      }
    }

    const applyBranch = window.App.debounce(() => {
      filters.branch = branchInput.value.trim();
      syncUrl();
      load();
    }, 350);
    branchInput.addEventListener('input', applyBranch);
    statusSel.addEventListener('change', () => { filters.status = statusSel.value; syncUrl(); load(); });
    categorySel.addEventListener('change', () => { filters.category = categorySel.value; syncUrl(); load(); });

    await load();
  }

  window.App.registerRoute('/exceptions', renderExceptionsPage);
})();
