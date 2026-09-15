// Branch workspace (#/branches/:code) — everything about one branch on one page: a
// summary header (from GET /api/branches/:code) plus every legacy stage section
// (views/legacy.js), reused with the branch pre-filled and its input locked. Sections
// are lazily rendered behind a tab strip so opening a branch does not fire every
// section's API call at once.
'use strict';

(function () {
  const { api, el, chip, progressBar, showError, navigate, toast } = window.App;
  const legacy = window.Views.legacy;

  async function fetchLatestRunId(branch) {
    try {
      const { runs } = await api(`/api/runs?branch=${encodeURIComponent(branch)}`);
      return runs?.[0]?.id ?? null; // /api/runs already orders by created_at DESC
    } catch {
      return null;
    }
  }

  async function fetchLatestBatchId(branch) {
    try {
      const { batches } = await api(`/api/batches?branch=${encodeURIComponent(branch)}`);
      return batches?.[0]?.id ?? null;
    } catch {
      return null;
    }
  }

  function renderHeaderCard(container, branch, row) {
    container.innerHTML = '';
    const backLink = el('button', { class: 'linklike', onclick: () => navigate('/branches') }, '← Back to Branch Control Dashboard');
    container.appendChild(backLink);
    const title = el('h2', {}, [branch, row?.is_synthetic ? el('span', { class: 'badge badge-warn ml8' }, 'SYNTHETIC') : null]);
    container.appendChild(title);

    if (!row) {
      container.appendChild(el('p', { class: 'muted' }, 'Branch summary (GET /api/branches/:code) is not available yet — showing raw stage data below from the branch code alone.'));
      return;
    }

    const kv = el('div', { class: 'kv' }, [
      el('span', {}, [el('b', {}, 'Name: '), row.branch_name || '—']),
      el('span', {}, [el('b', {}, 'Books location: '), row.zoho_location_name || row.zoho_location_id || '—']),
      el('span', {}, [el('b', {}, 'Operator: '), row.assigned_operator || '—']),
      el('span', {}, [el('b', {}, 'Approver: '), row.assigned_approver || '—']),
      el('span', {}, [el('b', {}, 'Live start: '), row.live_start_date || '—']),
      el('span', {}, [el('b', {}, 'Migration range: '), `${row.migration_from_date || '—'} → ${row.migration_to_date || '—'}`]),
      el('span', {}, [el('b', {}, 'Last activity: '), row.last_activity_at || '—']),
    ]);
    container.appendChild(kv);

    const chipsRow = el('div', { class: 'chips-row' }, [
      chip(row.readiness_status, `Readiness: ${row.readiness_status}`),
      chip(row.receipt_status, `Receipt: ${row.receipt_status}`),
      chip(row.layer_a_status, `Layer A: ${row.layer_a_status}`),
      chip(row.mapping_status, `Mapping: ${row.mapping_status}`),
      chip(row.overlap_status, `Overlap: ${row.overlap_status}`),
      chip(row.batch_approval_status, `Batch approval: ${row.batch_approval_status}`),
      chip(row.layer_c_status, `Layer C: ${row.layer_c_status}`),
      chip(row.balance_bridge_status, `Balance bridge: ${row.balance_bridge_status}`),
    ]);
    container.appendChild(chipsRow);

    const progressRow = el('div', { class: 'controls' }, [
      progressBar(row.migration_progress_pct),
      el('span', { class: 'muted' }, `${row.migrated_count ?? 0} of ${row.total_count ?? 0} vouchers migrated`),
      el('span', { class: 'muted' }, `Open exceptions: ${row.open_exception_count ?? 0} (₹${row.open_exception_impact ?? '0.00'})`),
    ]);
    container.appendChild(progressRow);
  }

  async function renderBranchWorkspace(container, params) {
    const branch = params.code;
    const headerCard = el('section', { class: 'card' });
    const tabStrip = el('div', { class: 'tab-strip' });
    const tabBody = el('div', { class: 'card' });
    container.appendChild(headerCard);
    container.appendChild(tabStrip);
    container.appendChild(tabBody);

    let branchRow = null;
    async function loadHeader() {
      headerCard.innerHTML = '';
      headerCard.appendChild(el('p', { class: 'muted' }, 'Loading branch summary…'));
      try {
        branchRow = await api(`/api/branches/${encodeURIComponent(branch)}`);
      } catch (err) {
        if (err.status === 404 || err.status === 501) {
          branchRow = null;
        } else {
          headerCard.innerHTML = '';
          return showError(headerCard, err);
        }
      }
      renderHeaderCard(headerCard, branch, branchRow);
      headerCard.appendChild(
        el('div', { class: 'controls' }, [
          el('button', {
            onclick: async () => {
              try {
                branchRow = await api(`/api/branches/${encodeURIComponent(branch)}/refresh`, { method: 'POST', body: {} });
                renderHeaderCard(headerCard, branch, branchRow);
                toast('Branch summary refreshed.', 'success');
              } catch (err) {
                if (err.status === 404 || err.status === 501) toast('Refresh endpoint not available yet.', 'error');
                else toast(err.message, 'error');
              }
            },
          }, 'Refresh summary'),
        ])
      );
    }
    await loadHeader();

    const latestRunId = await fetchLatestRunId(branch);
    const latestBatchId = await fetchLatestBatchId(branch);
    // Tracks the batch the operator actually wants shown in the Queue tab — starts as
    // the latest batch for the branch, but Approval's "View queue/Layer C" can reassign
    // it before the Queue tab has ever been (lazily) rendered, so its own render() must
    // read this at render time rather than capturing `latestBatchId` up front.
    let selectedBatchId = latestBatchId || '';

    let queueHandle = null;
    let balanceHandle = null;
    let layerAHandle = null;
    let bridgeHandle = null;
    let previewHandle = null;

    const tabs = [
      {
        id: 'files',
        label: 'Files & runs',
        render: (host) => {
          legacy.renderFilesSection(host, {
            branch,
            locked: true,
            onRunSelected: (runId) => {
              if (layerAHandle) layerAHandle.setRunId(runId);
              if (bridgeHandle) bridgeHandle.setRunId(runId);
              if (previewHandle) previewHandle.setRunId(runId);
            },
          });
        },
      },
      { id: 'cutover', label: 'Cutover', render: (host) => legacy.renderCutoverSection(host, { branch, locked: true }) },
      {
        id: 'layerA',
        label: 'Layer A / Bridge',
        render: (host) => {
          const a = el('div');
          const b = el('div');
          host.appendChild(a);
          host.appendChild(b);
          layerAHandle = legacy.renderLayerASection(a, { runId: latestRunId || '', locked: true });
          bridgeHandle = legacy.renderBridgeSection(b, { runId: latestRunId || '', locked: true });
        },
      },
      { id: 'exceptions', label: 'Exceptions', render: (host) => legacy.renderExceptionsSection(host, { branch, locked: true }) },
      {
        id: 'preview',
        label: 'Preview',
        render: (host) => {
          previewHandle = legacy.renderPreviewSection(host, { runId: latestRunId || '', locked: true });
        },
      },
      {
        id: 'approval',
        label: 'Approval / Batches',
        render: (host) => {
          legacy.renderApprovalSection(host, {
            branch,
            locked: true,
            onBatchSelected: (batchId) => {
              selectedBatchId = batchId;
              if (queueHandle) queueHandle.setBatchId(batchId);
              // Jump the operator straight to the Queue tab after picking a batch (this
              // triggers the Queue tab's first, lazy render when it hasn't been opened
              // yet — that render reads `selectedBatchId`, so nothing is lost either way).
              activateTab('queue');
              if (balanceHandle) {
                const detail = queueHandle?.getDetail();
                if (detail) balanceHandle.showForBatchDetail(detail);
              }
            },
          });
        },
      },
      {
        id: 'queue',
        label: 'Queue',
        render: (host) => {
          queueHandle = legacy.renderQueueSection(host, { batchId: selectedBatchId, locked: true });
        },
      },
      {
        id: 'balance',
        label: 'Balance',
        render: (host) => {
          balanceHandle = legacy.renderBalanceSection(host, { branch, locked: true });
          const detail = queueHandle?.getDetail();
          if (detail) balanceHandle.showForBatchDetail(detail);
        },
      },
      { id: 'audit', label: 'Audit', render: (host) => legacy.renderAuditSection(host, { branch, locked: true }) },
    ];

    const rendered = new Set();
    const hosts = new Map();
    for (const t of tabs) {
      const host = el('div', { hidden: '' });
      hosts.set(t.id, host);
      tabBody.appendChild(host);
    }

    function activateTab(id) {
      for (const t of tabs) {
        const host = hosts.get(t.id);
        host.hidden = t.id !== id;
      }
      const tab = tabs.find((t) => t.id === id);
      if (!rendered.has(id)) {
        rendered.add(id);
        tab.render(hosts.get(id));
      }
      for (const btn of tabStrip.querySelectorAll('button')) {
        btn.classList.toggle('navlink-active', btn.dataset.tab === id);
      }
    }

    for (const t of tabs) {
      tabStrip.appendChild(
        el('button', { class: 'navlink', 'data-tab': t.id, onclick: () => activateTab(t.id) }, t.label)
      );
    }
    activateTab('files');
  }

  window.App.registerRoute('/branches/:code', renderBranchWorkspace);
})();
