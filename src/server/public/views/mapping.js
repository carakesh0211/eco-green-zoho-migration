// Mapping (#/mapping): the rules that say which Zoho Books account or contact each source
// ledger or party is posted to. Every signed-in role may look; approving / retiring rules is
// for approver/admin, uploading a rules file for operator/admin (the server re-checks every
// call). Filters live in the URL hash so reload and back restore what was on screen.
//   a. Summary        GET  /api/mappings/summary
//   b. Rules          GET  /api/mappings?rule_type=&status=&mapping_version=
//                     POST /api/mappings/approve, POST /api/mappings/:id/retire
//   c. Upload rules   POST /api/mappings  (rows from a JSON file, 500 per request)
//   d. Still unmapped GET  /api/exceptions?category=UNMAPPED_ENTITY&status=OPEN
'use strict';

(function () {
  const { api, el, chip, renderDataTable, showError, toast, hasRole, humanize, plain, replaceQuery } = window.App;

  const RULE_TYPES = ['LEDGER_ACCOUNT', 'PARTY', 'MODULE_ROUTE', 'PAYMENT_MODE', 'TAX'];
  const STATUSES = ['DRAFT', 'APPROVED', 'RETIRED'];
  const PAGE_SIZE = 100;
  const UPLOAD_CHUNK = 500;

  const canApprove = () => hasRole('approver', 'admin');
  const canUpload = () => hasRole('operator', 'admin');

  // ------------------------------------------------------------ small helpers

  function labelled(text, control) {
    return el('label', {}, [text, control]);
  }

  /** Confirm / form dialog, same markup as the other views' modals. */
  function openModal({ title, intro, fields = [], submitLabel, onSubmit }) {
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
      fields.length ? el('div', { class: 'form-stack' }, fields) : null,
      errorP,
      el('div', { class: 'controls' }, [submit, el('button', { type: 'button', onclick: close }, 'Cancel')]),
    ]);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    const first = box.querySelector('input,select,textarea');
    if (first) first.focus();
    else submit.focus();
  }

  function metaOf(rule) {
    return rule.target_meta && typeof rule.target_meta === 'object' ? rule.target_meta : {};
  }

  /** The Books-side name a rule points at (account / contact), falling back to target_value. */
  function targetName(rule) {
    const m = metaOf(rule);
    return plain(m.account_name) || plain(m.contact_name) || plain(rule.target_value);
  }

  function targetType(rule) {
    const m = metaOf(rule);
    return plain(m.account_type) || plain(m.contact_type);
  }

  function sourceName(rule) {
    return plain(metaOf(rule).match?.source_name);
  }

  function scoreWords(score) {
    const s = Number(score);
    if (!Number.isFinite(s)) return '';
    // Scores arrive either as 0..1 or already as a percentage.
    const pct = s <= 1 ? s * 100 : s;
    return `${Math.round(pct)}%`;
  }

  function fmtDate(iso) {
    return iso ? String(iso).replace('T', ' ').slice(0, 16) : '';
  }

  // ------------------------------------------------------------ page

  async function renderMappingPage(container, params, initialQuery) {
    window.App.setPageTitle('Mapping');
    const filters = {
      rule_type: RULE_TYPES.includes(initialQuery.rule_type) ? initialQuery.rule_type : '',
      status: STATUSES.includes(initialQuery.status) ? initialQuery.status : '',
      q: initialQuery.q || '',
      version: initialQuery.version || '',
    };
    let rules = [];
    let page = 1;

    const page_ = el('div', { class: 'page mapping-view' });
    container.appendChild(page_);

    const refreshBtn = el('button', { type: 'button', onclick: () => reloadAll() }, 'Refresh');
    page_.appendChild(
      el('div', { class: 'page-header' }, [
        el('div', {}, [
          el('h2', {}, 'Mapping'),
          el('div', { class: 'subtitle' }, 'A mapping rule matches a source ledger or party from the branch data to the Zoho Books account or contact it will be posted to. Rules must be approved before any postings can be built.'),
        ]),
        el('div', { class: 'actions' }, [refreshBtn]),
      ])
    );

    // ---- a. summary
    const summaryHost = el('div');
    page_.appendChild(el('section', { class: 'card' }, [el('h2', {}, 'Summary'), summaryHost]));

    // ---- b. rules
    const typeSel = el('select', {}, [
      el('option', { value: '' }, 'All types'),
      ...RULE_TYPES.map((t) => el('option', { value: t }, humanize(t))),
    ]);
    typeSel.value = filters.rule_type;
    const statusSel = el('select', {}, [
      el('option', { value: '' }, 'All statuses'),
      ...STATUSES.map((s) => el('option', { value: s }, humanize(s))),
    ]);
    statusSel.value = filters.status;
    const searchInput = el('input', { value: filters.q, placeholder: 'Source or target name', autocomplete: 'off' });
    const versionInput = el('input', { value: filters.version, placeholder: 'e.g. v1', autocomplete: 'off' });
    const clearBtn = el('button', { type: 'button', class: 'linklike', onclick: clearFilters }, 'Clear filters');

    const rulesSummary = el('div', { class: 'muted', role: 'status' }, '');
    const bulkHost = el('div', { class: 'actions' });
    const tableHost = el('div');
    const pager = el('div', { class: 'pagination-bar' });
    page_.appendChild(
      el('section', { class: 'card' }, [
        el('h2', {}, 'Rules'),
        el('div', { class: 'controls filter-bar' }, [
          labelled('Rule type', typeSel),
          labelled('Status', statusSel),
          labelled('Search', searchInput),
          labelled('Mapping version', versionInput),
          clearBtn,
        ]),
        rulesSummary,
        bulkHost,
        tableHost,
        pager,
      ])
    );

    // ---- c. upload (operator/admin only)
    if (canUpload()) page_.appendChild(buildUploadCard());

    // ---- d. still unmapped
    const unmappedHost = el('div');
    page_.appendChild(
      el('section', { class: 'card' }, [
        el('h2', {}, 'Still unmapped'),
        el('p', { class: 'muted' }, 'Sources that vouchers refer to but that have no approved rule yet. These vouchers stay blocked until a rule is approved.'),
        unmappedHost,
      ])
    );

    // ------------------------------------------------------------ filters

    function syncUrl() {
      replaceQuery('/mapping', { rule_type: filters.rule_type, status: filters.status, q: filters.q, version: filters.version });
    }

    function clearFilters() {
      filters.rule_type = '';
      filters.status = '';
      filters.q = '';
      filters.version = '';
      typeSel.value = '';
      statusSel.value = '';
      searchInput.value = '';
      versionInput.value = '';
      syncUrl();
      loadRules();
    }

    typeSel.addEventListener('change', () => { filters.rule_type = typeSel.value; syncUrl(); loadRules(); });
    statusSel.addEventListener('change', () => { filters.status = statusSel.value; syncUrl(); loadRules(); });
    const applyVersion = window.App.debounce(() => {
      filters.version = versionInput.value.trim();
      syncUrl();
      loadRules();
    }, 350);
    versionInput.addEventListener('input', applyVersion);
    const applySearch = window.App.debounce(() => {
      filters.q = searchInput.value.trim();
      syncUrl();
      page = 1;
      draw();
    }, 250);
    searchInput.addEventListener('input', applySearch);

    // ------------------------------------------------------------ a. summary

    async function loadSummary() {
      try {
        const data = await api('/api/mappings/summary');
        const byType = new Map();
        for (const r of data.summary ?? []) {
          if (!byType.has(r.rule_type)) byType.set(r.rule_type, {});
          byType.get(r.rule_type)[r.status] = Number(r.count) || 0;
        }
        summaryHost.innerHTML = '';
        if (byType.size === 0) {
          summaryHost.appendChild(el('p', { class: 'muted' }, 'No mapping rules exist yet. Upload a rules file below to add draft rules.'));
          return;
        }
        for (const [type, counts] of byType) {
          summaryHost.appendChild(
            el('div', { class: 'chips-row' }, [
              el('strong', {}, `${humanize(type)}: `),
              ...STATUSES.map((s) => chip(s, `${humanize(s)} ${counts[s] ?? 0}`)),
            ])
          );
        }
      } catch (err) {
        showError(summaryHost, err);
      }
    }

    // ------------------------------------------------------------ b. rules

    function visibleRules() {
      const q = filters.q.toLowerCase();
      if (!q) return rules;
      return rules.filter((r) => [r.source_key, sourceName(r), targetName(r), r.target_value]
        .some((v) => plain(v).toLowerCase().includes(q)));
    }

    async function loadRules() {
      tableHost.innerHTML = '';
      tableHost.appendChild(el('p', { class: 'empty' }, 'Loading...'));
      const qs = new URLSearchParams();
      if (filters.rule_type) qs.set('rule_type', filters.rule_type);
      if (filters.status) qs.set('status', filters.status);
      if (filters.version) qs.set('mapping_version', filters.version);
      try {
        const data = await api(`/api/mappings${qs.toString() ? `?${qs}` : ''}`);
        rules = data.mappings ?? [];
      } catch (err) {
        rulesSummary.textContent = '';
        bulkHost.innerHTML = '';
        pager.innerHTML = '';
        showError(tableHost, err);
        return;
      }
      page = 1;
      draw();
    }

    function matchedCell(rule) {
      const m = metaOf(rule).match;
      if (m && m.status) {
        const words = scoreWords(m.score);
        const cls = m.status === 'EXACT' ? 'chip-green' : 'chip-amber';
        return el('div', { class: 'stack' }, [
          el('span', { class: `chip ${cls}` }, words ? `${humanize(m.status)} ${words}` : humanize(m.status)),
          m.usage_count !== undefined && m.usage_count !== null
            ? el('span', { class: 'muted' }, `Used ${Number(m.usage_count) || 0} times`)
            : null,
        ]);
      }
      if (rule.rule_type === 'MODULE_ROUTE') {
        return el('span', { class: 'wrap-text muted' }, plain(rule.notes) || 'Set by hand');
      }
      return el('span', { class: 'muted' }, 'Set by hand');
    }

    function sourceCell(rule) {
      const name = sourceName(rule);
      return el('div', { class: 'stack' }, [
        el('span', {}, plain(rule.source_key)),
        name && name !== plain(rule.source_key) ? el('span', { class: 'muted' }, name) : null,
      ]);
    }

    function targetCell(rule) {
      const m = metaOf(rule);
      const detail = [targetType(rule) && humanize(targetType(rule)), plain(m.parent_account_name) && `under ${plain(m.parent_account_name)}`]
        .filter(Boolean)
        .join(' · ');
      return el('div', { class: 'stack' }, [
        el('span', {}, [
          targetName(rule) || '—',
          rule.rule_type === 'PARTY' && m.kind === 'account' ? ' ' : null,
          rule.rule_type === 'PARTY' && m.kind === 'account' ? el('span', { class: 'chip chip-grey' }, 'posted to GL account') : null,
        ]),
        detail ? el('span', { class: 'muted' }, detail) : null,
      ]);
    }

    function draw() {
      const shown = visibleRules();
      const total = shown.length;
      const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
      page = Math.min(page, pages);
      const start = (page - 1) * PAGE_SIZE;
      const slice = shown.slice(start, start + PAGE_SIZE);
      rulesSummary.textContent = total === 0 ? '' : `Showing ${start + 1}–${start + slice.length} of ${total}`;

      // Bulk approve (approver/admin): everything DRAFT among the rules currently shown.
      bulkHost.innerHTML = '';
      const drafts = shown.filter((r) => r.status === 'DRAFT');
      if (canApprove() && drafts.length > 0) {
        bulkHost.appendChild(
          el('button', { type: 'button', class: 'primary', onclick: () => approveAllModal(drafts) }, `Approve all DRAFT rules shown (${drafts.length})`)
        );
      }

      const columns = [
        { key: 'rule_type', label: 'Type', render: (r) => humanize(r.rule_type) },
        { key: 'source_key', label: 'Source', render: sourceCell },
        { key: 'target', label: 'Target', render: targetCell },
        { key: 'matched', label: 'How matched', render: matchedCell },
        { key: 'mapping_version', label: 'Version', render: (r) => plain(r.mapping_version) },
        { key: 'status', label: 'Status', render: (r) => chip(r.status, humanize(r.status)) },
        {
          key: 'approved_by',
          label: 'Approved by',
          render: (r) => (r.approved_by
            ? el('div', { class: 'stack' }, [plain(r.approved_by), el('span', { class: 'muted' }, fmtDate(r.approved_at))])
            : el('span', { class: 'muted' }, '—')),
        },
      ];
      if (canApprove()) {
        columns.push({
          key: 'actions',
          label: 'Actions',
          render: (r) => {
            const wrap = el('div', { class: 'actions' });
            if (r.status === 'DRAFT') wrap.appendChild(el('button', { type: 'button', onclick: () => approveOne(r) }, 'Approve'));
            if (r.status !== 'RETIRED') wrap.appendChild(el('button', { type: 'button', onclick: () => retireModal(r) }, 'Retire'));
            return wrap.childNodes.length ? wrap : el('span', { class: 'muted' }, '—');
          },
        });
      }
      const filtered = filters.rule_type || filters.status || filters.q || filters.version;
      renderDataTable(tableHost, slice, columns, {
        empty: filtered ? 'No mapping rules match these filters.' : 'No mapping rules yet. Upload a rules file below to add draft rules.',
      });
      if (total === 0 && tableHost.firstChild) tableHost.firstChild.className = 'empty';

      pager.innerHTML = '';
      if (pages > 1) {
        pager.appendChild(el('button', { type: 'button', disabled: page <= 1 ? '' : null, onclick: () => { page -= 1; draw(); } }, 'Previous'));
        pager.appendChild(el('span', {}, `Page ${page} of ${pages}`));
        pager.appendChild(el('button', { type: 'button', disabled: page >= pages ? '' : null, onclick: () => { page += 1; draw(); } }, 'Next'));
      }
    }

    async function approveOne(rule) {
      try {
        const out = await api('/api/mappings/approve', { method: 'POST', body: { ids: [rule.id] } });
        toast(out?.reapplyScheduled ? 'Rule approved. The mapping is being re-applied to blocked runs in the background.' : 'Rule approved.', 'success');
        reloadAll();
      } catch (err) {
        toast(err.status === 403 ? 'Your role is not allowed to approve mapping rules.' : err.message, 'error');
      }
    }

    function approveAllModal(drafts) {
      const n = drafts.length;
      // With no search text the shown set is fully described by the type/version filters (and
      // status DRAFT-or-All), so the server can resolve it itself. A search is client-side
      // only, so in that case the exact ids of the visible DRAFT rows are sent instead.
      const useFilter = !filters.q && (filters.status === '' || filters.status === 'DRAFT');
      const reason = el('textarea', { rows: '2', placeholder: 'Optional – why are these rules right?' });
      openModal({
        title: 'Approve draft rules',
        intro: `Approve ${n} draft ${n === 1 ? 'rule' : 'rules'}? Approved rules are used the next time mapping is applied to a branch run. This is recorded in the audit trail.`,
        fields: [labelled('Note', reason)],
        submitLabel: `Approve ${n}`,
        onSubmit: async (close, fail) => {
          const body = {};
          if (useFilter) {
            const filter = {};
            if (filters.rule_type) filter.rule_type = filters.rule_type;
            if (filters.version) filter.mapping_version = filters.version;
            body.filter = filter;
          } else {
            body.ids = drafts.map((r) => r.id);
          }
          if (reason.value.trim()) body.reason = reason.value.trim();
          try {
            const out = await api('/api/mappings/approve', { method: 'POST', body });
            toast(`${out?.approved ?? n} ${(out?.approved ?? n) === 1 ? 'rule' : 'rules'} approved.${out?.reapplyScheduled ? ' The mapping is being re-applied to blocked runs in the background.' : ''}`, 'success');
            close();
            reloadAll();
          } catch (err) {
            fail(err.status === 403 ? 'Your role is not allowed to approve mapping rules.' : err.message);
          }
        },
      });
    }

    function retireModal(rule) {
      const reason = el('textarea', { rows: '2', placeholder: 'Optional – why is this rule no longer right?' });
      openModal({
        title: 'Retire mapping rule',
        intro: `${humanize(rule.rule_type)} · ${plain(rule.source_key)} → ${targetName(rule) || 'no target'}. A retired rule is no longer used; it stays in the audit trail.`,
        fields: [labelled('Reason', reason)],
        submitLabel: 'Retire rule',
        onSubmit: async (close, fail) => {
          try {
            await api(`/api/mappings/${encodeURIComponent(rule.id)}/retire`, {
              method: 'POST',
              body: reason.value.trim() ? { reason: reason.value.trim() } : {},
            });
            toast('Rule retired.', 'success');
            close();
            reloadAll();
          } catch (err) {
            fail(err.status === 403 ? 'Your role is not allowed to retire mapping rules.' : err.message);
          }
        },
      });
    }

    // ------------------------------------------------------------ c. upload

    function buildUploadCard() {
      const fileInput = el('input', { type: 'file', accept: '.json,application/json' });
      const preview = el('p', { class: 'muted', role: 'status' }, 'Choose a rules file (.json) made by the mapping build script.');
      const uploadBtn = el('button', { type: 'button', class: 'primary', disabled: '' }, 'Upload as draft');
      let parsedRows = null;

      fileInput.addEventListener('change', async () => {
        parsedRows = null;
        uploadBtn.disabled = true;
        const file = fileInput.files && fileInput.files[0];
        if (!file) {
          preview.textContent = 'Choose a rules file (.json) made by the mapping build script.';
          return;
        }
        try {
          const parsed = JSON.parse(await file.text());
          if (!Array.isArray(parsed)) throw new Error('The file must contain a list (array) of rules.');
          if (parsed.length === 0) throw new Error('The file has no rules in it.');
          if (!parsed.every((r) => r && typeof r === 'object' && !Array.isArray(r))) {
            throw new Error('Every entry in the file must be a rule object.');
          }
          const counts = {};
          for (const r of parsed) {
            const t = typeof r.rule_type === 'string' && r.rule_type ? r.rule_type : 'UNKNOWN';
            counts[t] = (counts[t] || 0) + 1;
          }
          const parts = Object.entries(counts).map(([t, c]) => `${c} ${t}`);
          preview.textContent = `${parsed.length} ${parsed.length === 1 ? 'rule' : 'rules'}: ${parts.join(', ')}`;
          preview.className = 'muted';
          parsedRows = parsed;
          uploadBtn.disabled = false;
        } catch (err) {
          preview.textContent = `Cannot use this file: ${err.message}`;
          preview.className = 'muted error-text';
        }
      });

      uploadBtn.addEventListener('click', async () => {
        if (!parsedRows) return;
        uploadBtn.disabled = true;
        let upserted = 0;
        let unchanged = 0;
        try {
          for (let i = 0; i < parsedRows.length; i += UPLOAD_CHUNK) {
            preview.textContent = `Uploading ${Math.min(i + UPLOAD_CHUNK, parsedRows.length)} of ${parsedRows.length}…`;
            const out = await api('/api/mappings', { method: 'POST', body: { rows: parsedRows.slice(i, i + UPLOAD_CHUNK) } });
            upserted += Number(out?.upserted) || 0;
            unchanged += Number(out?.unchanged) || 0;
          }
          toast(`Rules uploaded as draft: ${upserted} added or changed, ${unchanged} unchanged.`, 'success');
          fileInput.value = '';
          parsedRows = null;
          preview.textContent = `Last upload: ${upserted} added or changed, ${unchanged} unchanged. Rules are drafts until an approver approves them.`;
          preview.className = 'muted';
          reloadAll();
        } catch (err) {
          const doneNote = upserted + unchanged > 0 ? ` (${upserted + unchanged} rules were already saved before the error)` : '';
          preview.textContent = `Upload stopped: ${err.status === 403 ? 'your role is not allowed to upload rules' : err.message}${doneNote}`;
          preview.className = 'muted error-text';
          toast('Upload failed.', 'error');
          uploadBtn.disabled = false;
          if (upserted + unchanged > 0) reloadAll();
        }
      });

      return el('section', { class: 'card' }, [
        el('h2', {}, 'Upload rules'),
        el('p', { class: 'muted' }, 'Rules are saved as drafts. They are not used until an approver approves them above.'),
        el('div', { class: 'controls' }, [labelled('Rules file', fileInput), uploadBtn]),
        preview,
      ]);
    }

    // ------------------------------------------------------------ d. still unmapped

    function parseUnmapped(message) {
      const text = plain(message);
      let m = /^No APPROVED mapping rule for ([A-Z_]+)\/(.+)$/.exec(text);
      if (m) return { type: m[1], key: m[2].trim() };
      m = /^No MODULE_ROUTE for (.+)$/.exec(text);
      if (m) return { type: 'MODULE_ROUTE', key: m[1].trim() };
      return null;
    }

    async function loadUnmapped() {
      try {
        const data = await api('/api/exceptions?category=UNMAPPED_ENTITY&status=OPEN');
        const groups = new Map();
        for (const ex of data.exceptions ?? []) {
          const parsed = parseUnmapped(ex.message);
          if (!parsed) continue;
          const id = `${parsed.type}\u0000${parsed.key}`;
          if (!groups.has(id)) groups.set(id, { ...parsed, vouchers: new Set(), exceptionCount: 0, branches: new Set() });
          const g = groups.get(id);
          g.exceptionCount += 1;
          if (ex.voucher_id) g.vouchers.add(ex.voucher_id);
          if (ex.branch_code) g.branches.add(ex.branch_code);
        }
        const rows = [...groups.values()]
          .map((g) => ({ ...g, blocked: g.vouchers.size || g.exceptionCount }))
          .sort((a, b) => b.blocked - a.blocked || a.type.localeCompare(b.type) || a.key.localeCompare(b.key));
        unmappedHost.innerHTML = '';
        if (rows.length === 0) {
          unmappedHost.appendChild(el('p', { class: 'empty' }, 'Nothing is waiting for a mapping rule.'));
          return;
        }
        renderDataTable(unmappedHost, rows, [
          { key: 'type', label: 'Type', render: (r) => humanize(r.type) },
          { key: 'key', label: 'Source key', render: (r) => r.key },
          { key: 'blocked', label: 'Blocked vouchers', render: (r) => String(r.blocked) },
          { key: 'branches', label: 'Branches', render: (r) => String(r.branches.size) },
        ]);
        unmappedHost.appendChild(
          el('p', { class: 'muted' }, 'Add a rule for this source and re-apply the mapping to the run (branch workspace, step 3).')
        );
      } catch (err) {
        showError(unmappedHost, err);
      }
    }

    function reloadAll() {
      loadSummary();
      loadRules();
      loadUnmapped();
    }

    reloadAll();
  }

  window.App.registerRoute('/mapping', renderMappingPage);
})();
