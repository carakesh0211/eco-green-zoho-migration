// Bulk mapping (#/branches/:code/bulk-mapping): map every ledger and party of a branch that
// still has no approved rule in one go.
//   1. Zoho Books lists  GET/POST /api/books-reference (Chart of Accounts, Vendors, Customers exports)
//   2. Suggestions       GET  /api/branches/:code/mapping-proposals
//                        POST /api/branches/:code/mapping-auto      (rules for confident matches)
//                        GET  /api/branches/:code/mapping-sheet.csv (sheet to fill in Excel)
//                        POST /api/branches/:code/mapping-sheet     (filled sheet -> rules)
//   3. Approve           POST /api/mappings/approve { ids }          (re-applies the mapping)
// Rules are created as DRAFT; only an approver/admin can approve them.
'use strict';

(function () {
  const { api, el, renderDataTable, showError, navigate, toast, hasRole, downloadWithAuth } = window.App;

  const fmt = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const money = (s) => el('span', { class: 'num' }, fmt.format(Number(s) || 0));
  const MATCH_WORDS = {
    EXACT: 'Exact match', FUZZY: 'Close match', ACCOUNT: 'Party is a Books account',
    REVIEW: 'Possible match – choose', AMBIGUOUS: 'Several matches – choose', NONE: 'No match – fill in',
  };
  const OUTCOME_WORDS = {
    RULE: 'Rule created', BLANK: 'Skipped (blank)', ALREADY_APPROVED: 'Already approved', UNKNOWN_SOURCE: 'Code not in this branch',
    NOT_FOUND: 'Name not found in Books', AMBIGUOUS: 'Name not unique in Books', BAD_TYPE: 'Type not Ledger/Party', DUPLICATE_ROW: 'Repeated row',
  };

  function readBase64(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
      r.onerror = () => reject(r.error);
      r.readAsDataURL(file);
    });
  }

  function card(title, children) {
    return el('section', { class: 'card bulk-card' }, [el('h3', {}, title), ...children]);
  }

  async function renderBulkMappingPage(container, params) {
    const branch = params.code;
    window.App.setPageTitle?.(`Branch ${branch} — Bulk mapping`);
    const page = el('div', { class: 'page bulk-mapping' });
    container.appendChild(page);

    const canUploadRef = hasRole('operator', 'approver', 'admin');
    const canCreate = hasRole('operator', 'admin');
    const canApprove = hasRole('approver', 'admin');

    const refStatus = el('p', { class: 'muted' }, 'Loading…');
    const proposalsInfo = el('div');
    const proposalsTable = el('div');
    const resultHost = el('div');
    let pendingIds = [];

    page.append(
      el('div', { class: 'page-header' }, [
        el('div', {}, [
          el('h2', {}, `Branch ${branch} — Bulk mapping`),
          el('p', { class: 'muted' }, 'Match every ledger and party that still has no approved rule to a Zoho Books account or contact, '
            + 'in one go. Rules are created as drafts; an approver approves them, then the mapping is re-applied automatically. Nothing is posted to Zoho Books.'),
        ]),
        el('div', { class: 'actions' }, [
          el('button', { type: 'button', class: 'linklike', onclick: () => navigate(`/branches/${encodeURIComponent(branch)}`) }, 'Back to branch'),
          el('button', { type: 'button', class: 'linklike', onclick: () => navigate(`/branches/${encodeURIComponent(branch)}/ledger-summary`) }, 'Ledger push summary'),
        ]),
      ]),
    );

    // ---- 1. Zoho Books lists ----
    const inputs = {
      accounts: el('input', { type: 'file', accept: '.csv,.xlsx' }),
      vendors: el('input', { type: 'file', accept: '.csv,.xlsx' }),
      customers: el('input', { type: 'file', accept: '.csv,.xlsx' }),
    };
    const uploadRefBtn = el('button', { type: 'button', onclick: uploadReference }, 'Upload Books lists');
    page.append(card('1. Zoho Books lists', [
      el('p', { class: 'muted' }, 'Export these from the Zoho Books test company (each list has an Export option) and upload them unchanged. '
        + 'You only need to do this again when accounts or contacts change in Books. You can upload one list at a time.'),
      refStatus,
      canUploadRef ? el('div', { class: 'actions' }, [
        el('label', {}, ['Chart of Accounts ', inputs.accounts]),
        el('label', {}, ['Vendors ', inputs.vendors]),
        el('label', {}, ['Customers ', inputs.customers]),
        uploadRefBtn,
      ]) : el('p', { class: 'muted' }, 'Your role cannot upload Books lists.'),
    ]));

    // ---- 2. Suggestions ----
    const sheetInput = el('input', { type: 'file', accept: '.csv,.xlsx' });
    page.append(card('2. Match ledgers and parties', [
      proposalsInfo,
      canCreate ? el('div', { class: 'actions' }, [
        el('button', { type: 'button', onclick: autoMap }, 'Create rules for all confident matches'),
        el('button', { type: 'button', onclick: () => downloadWithAuth(`/api/branches/${encodeURIComponent(branch)}/mapping-sheet.csv`, `mapping-sheet-${branch}.csv`).catch((e) => toast(e.message, 'error')) }, 'Download mapping sheet'),
        el('label', {}, ['Filled sheet ', sheetInput]),
        el('button', { type: 'button', onclick: uploadSheet }, 'Upload filled sheet'),
      ]) : el('p', { class: 'muted' }, 'Your role can look at the suggestions; an operator creates the rules.'),
      el('p', { class: 'muted' }, 'In the sheet, fill in or correct the books_name column with the exact Zoho Books account or contact name '
        + '(for parties, set books_kind to account or contact if needed). Leave a row blank to skip it. Codes may lose leading zeros in Excel; that is fine.'),
      proposalsTable,
    ]));

    // ---- 3. Approve ----
    page.append(card('3. Approve the new rules', [resultHost]));

    async function loadReference() {
      try {
        const out = await api('/api/books-reference');
        const r = out.reference;
        refStatus.textContent = !out.archive ? 'Books lists cannot be stored: no archive is configured.'
          : !r ? 'No Books lists uploaded yet.'
            : `Loaded ${r.uploaded_at.slice(0, 16).replace('T', ' ')} by ${r.uploaded_by}: ${r.active_accounts} active accounts, ${r.vendors} vendors, ${r.customers} customers.`;
      } catch (err) {
        refStatus.textContent = `Could not read the Books lists: ${err.message}`;
      }
    }

    async function uploadReference() {
      const files = [];
      for (const [kind, input] of Object.entries(inputs)) {
        const f = input.files && input.files[0];
        if (f) files.push({ name: f.name, kind, content: await readBase64(f) });
      }
      if (!files.length) { toast('Choose at least one exported file.', 'error'); return; }
      uploadRefBtn.disabled = true;
      try {
        const out = await api('/api/books-reference', { method: 'POST', body: { files } });
        toast(`Books lists loaded: ${out.reference.active_accounts} accounts, ${out.reference.vendors} vendors, ${out.reference.customers} customers.`, 'success');
        for (const input of Object.values(inputs)) input.value = '';
        await loadReference();
        await loadProposals();
      } catch (err) {
        toast(err.message, 'error');
      } finally {
        uploadRefBtn.disabled = false;
      }
    }

    async function loadProposals() {
      proposalsTable.innerHTML = '';
      proposalsTable.appendChild(el('p', { class: 'muted' }, 'Loading…'));
      let data;
      try {
        data = await api(`/api/branches/${encodeURIComponent(branch)}/mapping-proposals`);
      } catch (err) {
        showError(proposalsTable, err);
        return;
      }
      const c = data.counts;
      proposalsInfo.innerHTML = '';
      proposalsInfo.appendChild(el('p', {}, data.rows.length === 0
        ? 'Every ledger and party of this branch already has an approved rule.'
        : `${data.rows.length} ledgers and parties need a rule: ${data.confident} have a confident suggestion `
          + `(${c.EXACT ?? 0} exact, ${c.FUZZY ?? 0} close, ${c.ACCOUNT ?? 0} parties that are Books accounts); `
          + `${(c.REVIEW ?? 0) + (c.AMBIGUOUS ?? 0) + (c.NONE ?? 0)} need you to choose.`
          + (data.reference ? '' : ' Upload the Books lists first to get suggestions.')));
      renderDataTable(proposalsTable, data.rows, [
        { key: 'rule_type', label: 'Type', render: (r) => (r.rule_type === 'PARTY' ? 'Party' : 'Ledger') },
        { key: 'source_code', label: 'Code' },
        { key: 'source_name', label: 'Name' },
        { key: 'entries', label: 'Entries', render: (r) => el('span', { class: 'num' }, String(r.entries)) },
        { key: 'amount', label: 'Amount', render: (r) => money(r.amount) },
        { key: 'match', label: 'Suggestion', render: (r) => MATCH_WORDS[r.match] ?? r.match },
        { key: 'books_name', label: 'Zoho Books', render: (r) => r.books_name || (r.alternatives.length ? `Options: ${r.alternatives.join(', ')}` : '') },
      ], { empty: 'Nothing to map.' });
    }

    function showCreated(out, title) {
      pendingIds = out.ids ?? [];
      resultHost.innerHTML = '';
      resultHost.appendChild(el('p', {}, `${title}: ${pendingIds.length} draft ${pendingIds.length === 1 ? 'rule' : 'rules'} ready for approval.`));
      if (out.results) {
        const problems = out.results.filter((r) => r.outcome !== 'RULE');
        const table = el('div');
        resultHost.appendChild(table);
        renderDataTable(table, out.results, [
          { key: 'line', label: 'Sheet row' },
          { key: 'source_code', label: 'Code' },
          { key: 'source_name', label: 'Name' },
          { key: 'books_name', label: 'Books name in sheet' },
          { key: 'outcome', label: 'Result', render: (r) => (r.outcome === 'RULE' ? `→ ${r.books_target}` : el('span', { class: r.outcome === 'BLANK' || r.outcome === 'ALREADY_APPROVED' ? 'muted' : 'error-text' }, OUTCOME_WORDS[r.outcome] ?? r.outcome)) },
          { key: 'message', label: 'Note', render: (r) => r.message ?? '' },
        ]);
        if (problems.some((r) => !['BLANK', 'ALREADY_APPROVED'].includes(r.outcome))) {
          resultHost.appendChild(el('p', { class: 'muted' }, 'Fix the rows marked in red in the sheet and upload it again; rules already created stay as drafts.'));
        }
      }
      if (pendingIds.length) {
        resultHost.appendChild(canApprove
          ? el('button', { type: 'button', onclick: approvePending }, `Approve these ${pendingIds.length} rules`)
          : el('p', { class: 'muted' }, 'Ask an approver to open this page (or the Mapping screen) and approve the draft rules.'));
      }
    }

    async function autoMap() {
      try {
        const out = await api(`/api/branches/${encodeURIComponent(branch)}/mapping-auto`, { method: 'POST', body: {} });
        toast(`${out.created} draft rules created from confident matches.`, 'success');
        showCreated(out, 'Confident matches');
      } catch (err) {
        toast(err.message, 'error');
      }
    }

    async function uploadSheet() {
      const f = sheetInput.files && sheetInput.files[0];
      if (!f) { toast('Choose the filled mapping sheet first.', 'error'); return; }
      try {
        const out = await api(`/api/branches/${encodeURIComponent(branch)}/mapping-sheet`, { method: 'POST', body: { name: f.name, content: await readBase64(f) } });
        toast(`${out.created} draft rules created from the sheet.`, 'success');
        sheetInput.value = '';
        showCreated(out, 'Mapping sheet');
      } catch (err) {
        toast(err.message, 'error');
      }
    }

    async function approvePending() {
      if (!pendingIds.length) return;
      try {
        const out = await api('/api/mappings/approve', { method: 'POST', body: { ids: pendingIds, reason: `Bulk mapping, branch ${branch}` } });
        toast(`${out.approved} rules approved.${out.reapplyScheduled ? ' The mapping is being re-applied in the background; check the Ledger push summary in a few minutes.' : ''}`, 'success');
        pendingIds = [];
        resultHost.innerHTML = '';
        resultHost.appendChild(el('p', {}, 'Approved. The branch run is being re-applied in the background.'));
        await loadProposals();
      } catch (err) {
        toast(err.status === 403 ? 'Your role is not allowed to approve mapping rules.' : err.message, 'error');
      }
    }

    resultHost.appendChild(el('p', { class: 'muted' }, 'Rules you create above appear here for approval.'));
    await loadReference();
    await loadProposals();
  }

  window.App.registerRoute('/branches/:code/bulk-mapping', renderBulkMappingPage);
})();
