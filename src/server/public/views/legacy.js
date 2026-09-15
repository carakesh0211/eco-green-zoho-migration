// Legacy per-stage sections (Overview, Files/validation, Cutover, Layer A, Bridge,
// Exceptions, Preview, Approval, Queue/Layer C, Balance bridge, Audit). These used to be
// the entire console (one big stacked page with fixed DOM ids). They are now reusable
// render functions: each takes a container and an options object `{ branch, runId,
// batchId, locked, on... }` and returns a small handle `{ setBranch, setRunId,
// setBatchId, refresh }` (only the setters relevant to that section are present) so a
// parent view can wire sections together (e.g. "load run" in Files should refresh Layer
// A/Bridge/Preview for the same run) — see renderLegacyPage() below for the #/legacy
// route, and views/branch-workspace.js for the per-branch reuse with `locked: true`
// (branch pre-filled, its input hidden).
'use strict';

(function () {
  const { api, el, statusSpan, renderTable, renderJson, showError, toast } = window.App;

  function labelOrInput(labelText, { locked, value, placeholder }) {
    if (locked) {
      return el('span', { class: 'locked-field' }, [el('b', {}, `${labelText}: `), value || '(none)']);
    }
    const input = el('input', { placeholder: placeholder || '', value: value || '' });
    return { node: el('label', {}, [labelText, input]), input };
  }

  // ---------------------------------------------------------------- Overview

  function renderOverviewSection(container, { branch = '', locked = false } = {}) {
    const runsEl = el('div', { class: 'tablewrap' });
    const bridgeEl = el('div', { class: 'tablewrap' });
    const layersEl = el('div', { class: 'tablewrap' });
    const batchesEl = el('div', { class: 'tablewrap' });
    const queueEl = el('div', { class: 'tablewrap' });
    const excEl = el('div', { class: 'tablewrap' });
    const syntheticBadge = el('span', { class: 'badge badge-warn', hidden: '' }, 'SYNTHETIC DEMO DATA');
    const devSeedStatus = el('span', { class: 'muted' }, '');

    let branchValue = branch;
    const branchField = labelOrInput('Branch', { locked, value: branch, placeholder: 'PILOT01' });

    async function refresh() {
      const b = locked ? branchValue : branchField.input.value.trim();
      const q = b ? `?branch=${encodeURIComponent(b)}` : '';
      try {
        const summary = await api(`/api/dev/summary${q}`);
        renderTable(runsEl, summary.runs, [
          { key: 'id', label: 'Run id' },
          { key: 'branchCode', label: 'Branch' },
          { key: 'status', label: 'Status', status: true },
        ], { empty: 'No runs yet.' });

        const bridgeRows = Object.entries(summary.dispositionBridge?.byDisposition ?? {}).map(([disposition, g]) => ({
          disposition, count: g.count, debit: g.debit, credit: g.credit,
        }));
        renderTable(bridgeEl, bridgeRows, [
          { key: 'disposition', label: 'Disposition', status: true },
          { key: 'count', label: 'Count' },
          { key: 'debit', label: 'Debit' },
          { key: 'credit', label: 'Credit' },
        ], { empty: 'No dispositions yet.' });

        const layerRows = Object.entries(summary.layerStatus ?? {}).map(([layer, status]) => ({ layer, status }));
        renderTable(layersEl, layerRows, [
          { key: 'layer', label: 'Layer' },
          { key: 'status', label: 'Status', status: true },
        ]);

        const batchRows = Object.entries(summary.batches?.byStatus ?? {}).map(([status, count]) => ({ status, count }));
        renderTable(batchesEl, batchRows, [
          { key: 'status', label: 'Batch status', status: true },
          { key: 'count', label: 'Count' },
        ], { empty: 'No batches yet.' });

        const queueRows = Object.entries(summary.queueCounts ?? {}).map(([status, count]) => ({ status, count }));
        renderTable(queueEl, queueRows, [
          { key: 'status', label: 'Queue status', status: true },
          { key: 'count', label: 'Count' },
        ], { empty: 'No queue items yet.' });

        const excRows = Object.entries(summary.exceptionsByCategory ?? {}).map(([category, count]) => ({ category, count }));
        renderTable(excEl, excRows, [
          { key: 'category', label: 'Exception category' },
          { key: 'count', label: 'Count' },
        ], { empty: 'No exceptions.' });
      } catch (err) {
        showError(runsEl, err);
      }
    }

    async function runDevSeed() {
      devSeedStatus.textContent = 'starting…';
      try {
        const { jobId } = await api('/api/dev/seed', { method: 'POST', body: {} });
        devSeedStatus.textContent = `job ${jobId}: running…`;
        for (let i = 0; i < 200; i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 500));
          const status = await api(`/api/dev/seed/status?jobId=${encodeURIComponent(jobId)}`);
          devSeedStatus.textContent = `job ${jobId}: ${status.stage}${status.outcome ? ` — ${status.outcome}` : ''}`;
          if (status.outcome) {
            refresh();
            return;
          }
        }
      } catch (err) {
        devSeedStatus.textContent = `Error: ${err.message}`;
      }
    }

    const health = window.App.getLastHealth();
    const devSeedBtn = el('button', { onclick: runDevSeed, hidden: health?.environment === 'Development' ? null : '' }, 'Run synthetic demo seed (Development only)');

    const controls = el('div', { class: 'controls' }, [
      locked ? branchField : branchField.node,
      el('button', { onclick: refresh }, 'Refresh overview'),
      devSeedBtn,
      devSeedStatus,
    ]);

    container.appendChild(el('h3', {}, ['Overview', syntheticBadge]));
    container.appendChild(controls);
    container.appendChild(runsEl);
    container.appendChild(bridgeEl);
    container.appendChild(layersEl);
    container.appendChild(batchesEl);
    container.appendChild(queueEl);
    container.appendChild(excEl);

    refresh();
    return {
      refresh,
      setBranch(b) {
        branchValue = b;
        if (!locked) branchField.input.value = b;
        refresh();
      },
    };
  }

  // ---------------------------------------------------------------- 1. Files & validation

  function renderFilesSection(container, { branch = '', locked = false, onRunSelected } = {}) {
    const runsTable = el('div', { class: 'tablewrap' });
    const runDetail = el('div', { class: 'tablewrap' });
    let branchValue = branch;

    const branchField = labelOrInput('Branch', { locked, value: branch, placeholder: 'PILOT01' });
    const runIdInput = el('input', { placeholder: 'run-001' });

    async function loadRunDetail(id) {
      if (!id) return;
      try {
        const data = await api(`/api/runs/${encodeURIComponent(id)}`);
        runDetail.innerHTML = '';
        const p = el('p', {}, 'Status: ');
        p.appendChild(statusSpan(data.run.status));
        runDetail.appendChild(p);
        runDetail.appendChild(el('p', {}, `Vouchers: ${data.voucher_total} — ${JSON.stringify(data.voucher_counts)}`));
        const table = el('div');
        runDetail.appendChild(table);
        renderTable(table, data.files, [
          { key: 'file_name', label: 'File' },
          { key: 'file_role', label: 'Role' },
          { key: 'status', label: 'Status', status: true },
          { key: 'actual_row_count', label: 'Rows' },
          { key: 'sha256', label: 'sha256' },
        ]);
        if (onRunSelected) onRunSelected(id);
      } catch (err) {
        showError(runDetail, err);
      }
    }

    async function loadRuns() {
      const b = locked ? branchValue : branchField.input.value.trim();
      const q = b ? `?branch=${encodeURIComponent(b)}` : '';
      try {
        const { runs } = await api(`/api/runs${q}`);
        renderTable(runsTable, runs, [
          { key: 'id', label: 'Run id' },
          { key: 'branch_code', label: 'Branch' },
          { key: 'status', label: 'Status', status: true },
          { key: 'from_date', label: 'From' },
          { key: 'to_date', label: 'To' },
        ], {
          linkCols: {
            id: (row) => {
              runIdInput.value = row.id;
              loadRunDetail(row.id);
            },
          },
        });
        if (runs.length && !runIdInput.value) {
          runIdInput.value = runs[0].id;
          loadRunDetail(runs[0].id);
        }
      } catch (err) {
        showError(runsTable, err);
      }
    }

    const controls = el('div', { class: 'controls' }, [
      locked ? branchField : branchField.node,
      el('button', { onclick: loadRuns }, 'List runs'),
      el('label', {}, ['Run id', runIdInput]),
      el('button', { onclick: () => loadRunDetail(runIdInput.value.trim()) }, 'Load run'),
    ]);

    container.appendChild(el('h3', {}, 'Files & validation'));
    container.appendChild(controls);
    container.appendChild(runsTable);
    container.appendChild(runDetail);

    loadRuns();
    return {
      setBranch(b) {
        branchValue = b;
        if (!locked) branchField.input.value = b;
        runIdInput.value = '';
        loadRuns();
      },
      refresh: loadRuns,
    };
  }

  // ---------------------------------------------------------------- 2. Cutover matrix

  function renderCutoverSection(container, { branch = '', locked = false } = {}) {
    const table = el('div', { class: 'tablewrap' });
    let branchValue = branch;
    const branchField = labelOrInput('Branch', { locked, value: branch, placeholder: 'PILOT01 (blank = all in scope)' });

    async function load() {
      const b = locked ? branchValue : branchField.input.value.trim();
      const q = b ? `?branch=${encodeURIComponent(b)}` : '';
      try {
        const { cutover } = await api(`/api/cutover${q}`);
        renderTable(table, cutover, [
          { key: 'branch_code', label: 'Branch' },
          { key: 'transaction_class', label: 'Class' },
          { key: 'payment_method', label: 'Payment' },
          { key: 'smart_pharma_coverage_status', label: 'SP coverage' },
          { key: 'approval_status', label: 'Approval', status: true },
          { key: 'cutover_rule_version', label: 'Rule version' },
          { key: 'id', label: 'Approve' },
        ], {
          linkCols: {
            id: async (row) => {
              if (row.approval_status === 'APPROVED') return;
              const reason = prompt('Approval reason?') || '';
              try {
                await api(`/api/cutover/${row.id}/approve`, { method: 'POST', body: { reason } });
                load();
              } catch (err) {
                toast(err.message, 'error');
              }
            },
          },
        });
      } catch (err) {
        showError(table, err);
      }
    }

    const controls = el('div', { class: 'controls' }, [
      locked ? branchField : branchField.node,
      el('button', { onclick: load }, 'Load cutover matrix'),
    ]);
    container.appendChild(el('h3', {}, 'Cutover matrix'));
    container.appendChild(controls);
    container.appendChild(table);
    load();
    return {
      setBranch(b) {
        branchValue = b;
        if (!locked) branchField.input.value = b;
        load();
      },
      refresh: load,
    };
  }

  // ---------------------------------------------------------------- 3. Layer A

  function renderLayerASection(container, { runId = '', locked = false } = {}) {
    const table = el('div', { class: 'tablewrap' });
    let runIdValue = runId;
    const reconIdInput = el('input', { placeholder: 'recA_...' });
    const runIdField = labelOrInput('Run id', { locked, value: runId, placeholder: 'run-001' });

    async function loadReconA(id) {
      if (!id) return;
      try {
        const { recon_run, results } = await api(`/api/recon/${encodeURIComponent(id)}`);
        table.innerHTML = '';
        table.appendChild(el('p', {}, [`Layer ${recon_run.layer} — `, statusSpan(recon_run.status)]));
        const t = el('div');
        table.appendChild(t);
        renderTable(t, results, [
          { key: 'control_key', label: 'Control' },
          { key: 'expected', label: 'Expected' },
          { key: 'actual', label: 'Actual' },
          { key: 'difference', label: 'Diff' },
          { key: 'status', label: 'Status', status: true },
        ]);
      } catch (err) {
        showError(table, err);
      }
    }

    async function loadLatestForRun() {
      const rid = locked ? runIdValue : runIdField.input.value.trim();
      if (!rid) return;
      try {
        const { recon_run } = await api(`/api/runs/${encodeURIComponent(rid)}/recon-a`);
        if (!recon_run) {
          showError(table, new Error('No Layer A reconciliation has been run for ' + rid));
          return;
        }
        reconIdInput.value = recon_run.id;
        await loadReconA(recon_run.id);
      } catch (err) {
        showError(table, err);
      }
    }

    async function rerun() {
      const rid = locked ? runIdValue : runIdField.input.value.trim();
      if (!rid) return;
      try {
        const result = await api(`/api/runs/${encodeURIComponent(rid)}/rerun-recon`, { method: 'POST', body: {} });
        reconIdInput.value = result.reconRunId;
        loadReconA(result.reconRunId);
      } catch (err) {
        toast(err.message, 'error');
      }
    }

    const controls = el('div', { class: 'controls' }, [
      el('label', {}, ['Recon run id', reconIdInput]),
      el('button', { onclick: () => loadReconA(reconIdInput.value.trim()) }, 'Load recon run'),
      locked ? runIdField : runIdField.node,
      el('button', { onclick: loadLatestForRun }, 'Load latest Layer A for run'),
      el('button', { onclick: rerun }, 'Rerun Layer A (operator)'),
    ]);

    container.appendChild(el('h3', {}, 'Layer A — trial balance vs CSV'));
    container.appendChild(controls);
    container.appendChild(table);
    if (runId) loadLatestForRun();

    return {
      setRunId(id) {
        runIdValue = id;
        if (!locked) runIdField.input.value = id;
        loadLatestForRun();
      },
      refresh: loadLatestForRun,
    };
  }

  // ---------------------------------------------------------------- 4. Bridge (Layer B)

  function renderBridgeSection(container, { runId = '', locked = false } = {}) {
    const table = el('div', { class: 'tablewrap' });
    const vouchersEl = el('div', { class: 'tablewrap' });
    let runIdValue = runId;
    const runIdField = labelOrInput('Run id', { locked, value: runId, placeholder: 'run-001' });

    async function loadVouchers(rid, disposition) {
      try {
        const { vouchers } = await api(`/api/vouchers?run=${encodeURIComponent(rid)}&disposition=${encodeURIComponent(disposition)}`);
        renderTable(vouchersEl, vouchers, [
          { key: 'id', label: 'Voucher id' },
          { key: 'source_record_id', label: 'Source id' },
          { key: 'branch_code', label: 'Branch' },
          { key: 'debit_total', label: 'Debit' },
          { key: 'credit_total', label: 'Credit' },
          { key: 'disposition', label: 'Disposition', status: true },
        ]);
      } catch (err) {
        showError(vouchersEl, err);
      }
    }

    async function load() {
      const rid = locked ? runIdValue : runIdField.input.value.trim();
      if (!rid) return;
      try {
        const { recon_run, results } = await api(`/api/runs/${encodeURIComponent(rid)}/bridge`);
        table.innerHTML = '';
        if (!recon_run) {
          table.appendChild(el('p', { class: 'muted' }, 'No Layer B recon run yet for this run.'));
          return;
        }
        table.appendChild(el('p', {}, [`Layer B — `, statusSpan(recon_run.status)]));
        const t = el('div');
        table.appendChild(t);
        renderTable(t, results, [
          { key: 'control_key', label: 'Control' },
          { key: 'expected', label: 'Expected' },
          { key: 'actual', label: 'Actual' },
          { key: 'status', label: 'Status', status: true },
        ]);
        const linksWrap = el('p');
        for (const d of ['MIGRATE', 'SMART_PHARMA_EXCLUDED', 'OTHER_EXCLUDED', 'BLOCKED']) {
          linksWrap.appendChild(el('button', { class: 'linklike mr8', onclick: () => loadVouchers(rid, d) }, d));
        }
        table.appendChild(linksWrap);
      } catch (err) {
        showError(table, err);
      }
    }

    const controls = el('div', { class: 'controls' }, [
      locked ? runIdField : runIdField.node,
      el('button', { onclick: load }, 'Load bridge'),
    ]);
    container.appendChild(el('h3', {}, 'Bridge (Layer B)'));
    container.appendChild(controls);
    container.appendChild(table);
    container.appendChild(vouchersEl);
    if (runId) load();

    return {
      setRunId(id) {
        runIdValue = id;
        if (!locked) runIdField.input.value = id;
        load();
      },
      refresh: load,
    };
  }

  // ---------------------------------------------------------------- 5. Exceptions

  function renderExceptionsSection(container, { branch = '', locked = false } = {}) {
    const table = el('div', { class: 'tablewrap' });
    let branchValue = branch;
    const branchField = labelOrInput('Branch', { locked, value: branch });
    const categoryInput = el('input', { placeholder: 'SMART_PHARMA_OVERLAP' });
    const statusInput = el('input', { placeholder: 'OPEN' });

    async function load() {
      const b = locked ? branchValue : branchField.input.value.trim();
      const params = new URLSearchParams();
      if (b) params.set('branch', b);
      if (categoryInput.value.trim()) params.set('category', categoryInput.value.trim());
      if (statusInput.value.trim()) params.set('status', statusInput.value.trim());
      try {
        const { exceptions } = await api(`/api/exceptions?${params.toString()}`);
        renderTable(table, exceptions, [
          { key: 'id', label: 'id' },
          { key: 'category', label: 'Category' },
          { key: 'severity', label: 'Severity' },
          { key: 'status', label: 'Status', status: true },
          { key: 'branch_code', label: 'Branch' },
          { key: 'financial_impact', label: 'Impact' },
          { key: 'message', label: 'Message' },
          { key: 'id', label: 'Resolve' },
        ], {
          linkCols: {
            id: async (row) => {
              const status2 = prompt('Resolve as (RESOLVED / APPROVED_EXCEPTION / REJECTED)?', 'RESOLVED');
              if (!status2) return;
              const rootCause = prompt('Root cause?') || '';
              try {
                await api(`/api/exceptions/${row.id}/resolve`, { method: 'POST', body: { status: status2, rootCause } });
                load();
              } catch (err) {
                toast(err.message, 'error');
              }
            },
          },
        });
      } catch (err) {
        showError(table, err);
      }
    }

    const controls = el('div', { class: 'controls' }, [
      locked ? branchField : branchField.node,
      el('label', {}, ['Category', categoryInput]),
      el('label', {}, ['Status', statusInput]),
      el('button', { onclick: load }, 'Load exceptions'),
    ]);
    container.appendChild(el('h3', {}, 'Overlaps & Exceptions'));
    container.appendChild(controls);
    container.appendChild(table);
    load();
    return {
      setBranch(b) {
        branchValue = b;
        if (!locked) branchField.input.value = b;
        load();
      },
      refresh: load,
    };
  }

  // ---------------------------------------------------------------- 6. Preview

  function renderPreviewSection(container, { runId = '', locked = false } = {}) {
    const modulesEl = el('div', { class: 'tablewrap' });
    const vouchersEl = el('div', { class: 'tablewrap' });
    const payloadEl = el('div', { class: 'tablewrap' });
    let runIdValue = runId;
    const runIdField = labelOrInput('Run id', { locked, value: runId, placeholder: 'run-001' });

    async function loadPayload(voucherId) {
      try {
        const detail = await api(`/api/vouchers/${voucherId}`);
        payloadEl.innerHTML = '';
        for (const p of detail.preview_payloads) payloadEl.appendChild(el('p', {}, p.human_summary));
        renderJson(payloadEl, detail.preview_payloads);
      } catch (err) {
        showError(payloadEl, err);
      }
    }

    async function loadVouchersForModule(rid, targetModule) {
      try {
        const { vouchers } = await api(`/api/vouchers?run=${encodeURIComponent(rid)}&disposition=MIGRATE`);
        const filtered = targetModule ? vouchers.filter((v) => v.target_module === targetModule) : vouchers.filter((v) => !v.target_module);
        renderTable(vouchersEl, filtered, [
          { key: 'id', label: 'Voucher id' },
          { key: 'source_record_id', label: 'Source id' },
          { key: 'target_module', label: 'Module' },
          { key: 'id', label: 'Payload' },
        ], { linkCols: { id: (row) => loadPayload(row.id) } });
      } catch (err) {
        showError(vouchersEl, err);
      }
    }

    async function load() {
      const rid = locked ? runIdValue : runIdField.input.value.trim();
      vouchersEl.innerHTML = '';
      payloadEl.innerHTML = '';
      if (!rid) return;
      try {
        const { vouchers } = await api(`/api/vouchers?run=${encodeURIComponent(rid)}&disposition=MIGRATE`);
        const byModule = new Map();
        for (const v of vouchers) {
          const mod = v.target_module || '(unrouted)';
          byModule.set(mod, (byModule.get(mod) || 0) + 1);
        }
        const rows = [...byModule.entries()].map(([target_module, count]) => ({ target_module, count }));
        renderTable(modulesEl, rows, [
          { key: 'target_module', label: 'Module' },
          { key: 'count', label: 'Count' },
        ], { linkCols: { count: (row) => loadVouchersForModule(rid, row.target_module === '(unrouted)' ? null : row.target_module) } });
      } catch (err) {
        showError(modulesEl, err);
      }
    }

    const controls = el('div', { class: 'controls' }, [
      locked ? runIdField : runIdField.node,
      el('button', { onclick: load }, 'Load preview (MIGRATE by module)'),
    ]);
    container.appendChild(el('h3', {}, 'Preview'));
    container.appendChild(controls);
    container.appendChild(modulesEl);
    container.appendChild(vouchersEl);
    container.appendChild(payloadEl);
    if (runId) load();

    return {
      setRunId(id) {
        runIdValue = id;
        if (!locked) runIdField.input.value = id;
        load();
      },
      refresh: load,
    };
  }

  // ---------------------------------------------------------------- 7. Approval

  function renderApprovalSection(container, { branch = '', locked = false, onBatchSelected } = {}) {
    const cardsEl = el('div');
    let branchValue = branch;
    const branchField = labelOrInput('Branch', { locked, value: branch });

    async function load() {
      cardsEl.innerHTML = '';
      const b = locked ? branchValue : branchField.input.value.trim();
      const q = b ? `?branch=${encodeURIComponent(b)}` : '';
      try {
        const { batches } = await api(`/api/batches${q}`);
        if (batches.length === 0) {
          cardsEl.appendChild(el('p', { class: 'muted' }, 'No batches.'));
          return;
        }
        for (const bt of batches) {
          const card = el('div', { class: 'batchCard' });
          card.appendChild(el('div', {}, [`${bt.id} — `, statusSpan(bt.status)]));
          card.appendChild(
            el('div', { class: 'meta' }, `branch ${bt.branch_code} · period ${bt.period} · scope_hash ${bt.scope_hash} · mapping ${bt.mapping_version} · transform ${bt.transformation_version} · cutover ${bt.cutover_rule_version} · vouchers ${bt.voucher_count} · debit ${bt.debit_total} · credit ${bt.credit_total}`)
          );
          const actions = el('div', { class: 'actions' });
          actions.appendChild(
            el('button', {
              onclick: async () => {
                const reason = prompt('Approval reason (segregation of duties: you must not be the batch creator)?') || '';
                try {
                  await api(`/api/batches/${bt.id}/approve`, { method: 'POST', body: { reason } });
                  load();
                } catch (err) {
                  toast(err.message, 'error');
                }
              },
            }, 'Approve')
          );
          actions.appendChild(
            el('button', { onclick: () => onBatchSelected && onBatchSelected(bt.id) }, 'View queue/Layer C')
          );
          card.appendChild(actions);
          cardsEl.appendChild(card);
        }
      } catch (err) {
        showError(cardsEl, err);
      }
    }

    const controls = el('div', { class: 'controls' }, [
      locked ? branchField : branchField.node,
      el('button', { onclick: load }, 'Load batches'),
    ]);
    container.appendChild(el('h3', {}, 'Approval'));
    container.appendChild(controls);
    container.appendChild(cardsEl);
    load();
    return {
      setBranch(b) {
        branchValue = b;
        if (!locked) branchField.input.value = b;
        load();
      },
      refresh: load,
    };
  }

  // ---------------------------------------------------------------- 8. Queue & Layer C

  function renderQueueSection(container, { batchId = '', locked = false } = {}) {
    const summaryEl = el('div', { class: 'tablewrap' });
    const attemptsEl = el('div', { class: 'tablewrap' });
    let batchIdValue = batchId;
    let lastBatchDetail = null;
    const batchIdField = labelOrInput('Batch id', { locked, value: batchId, placeholder: 'batch_...' });
    const retryItemId = el('input', {});
    const retryReason = el('input', {});

    async function load() {
      const id = locked ? batchIdValue : batchIdField.input.value.trim();
      if (!id) return;
      try {
        const data = await api(`/api/batches/${encodeURIComponent(id)}`);
        lastBatchDetail = data;
        summaryEl.innerHTML = '';
        summaryEl.appendChild(el('p', {}, [`Batch ${data.batch.id} — `, statusSpan(data.batch.status)]));
        summaryEl.appendChild(el('p', {}, `Queue counts: ${Object.entries(data.queue_counts).map(([k, v]) => `${k}=${v}`).join(', ') || '(none)'}`));
        summaryEl.appendChild(
          el('div', {}, [
            el('button', { onclick: () => batchAction(id, 'pause') }, 'Pause'),
            ' ',
            el('button', { onclick: () => batchAction(id, 'resume') }, 'Resume'),
          ])
        );
        renderTable(attemptsEl, data.attempts, [
          { key: 'queue_item_id', label: 'Queue item' },
          { key: 'attempt_no', label: '#' },
          { key: 'response_class', label: 'Class' },
          { key: 'http_status', label: 'HTTP' },
          { key: 'zoho_record_id', label: 'Target id' },
          { key: 'error_code', label: 'Error' },
        ]);
      } catch (err) {
        showError(summaryEl, err);
      }
    }

    async function batchAction(id, action) {
      try {
        await api(`/api/batches/${id}/${action}`, { method: 'POST', body: {} });
        load();
      } catch (err) {
        toast(err.message, 'error');
      }
    }

    async function retryQueueItem() {
      const id = retryItemId.value.trim();
      const reason = retryReason.value.trim();
      if (!id) return;
      try {
        await api(`/api/queue/${id}/retry`, { method: 'POST', body: reason ? { reason } : {} });
        if (lastBatchDetail) load();
      } catch (err) {
        toast(err.message, 'error');
      }
    }

    const controls = el('div', { class: 'controls' }, [
      locked ? batchIdField : batchIdField.node,
      el('button', { onclick: load }, 'Load batch'),
    ]);
    const retryControls = el('div', { class: 'controls' }, [
      el('label', {}, ['Queue item id', retryItemId]),
      el('label', {}, ['Reason (required for DEAD_LETTER)', retryReason]),
      el('button', { onclick: retryQueueItem }, 'Retry'),
    ]);

    container.appendChild(el('h3', {}, 'Queue & Layer C'));
    container.appendChild(controls);
    container.appendChild(summaryEl);
    container.appendChild(attemptsEl);
    container.appendChild(retryControls);
    if (batchId) load();

    return {
      setBatchId(id) {
        batchIdValue = id;
        if (!locked) batchIdField.input.value = id;
        load();
      },
      refresh: load,
      getDetail: () => lastBatchDetail,
    };
  }

  // ---------------------------------------------------------------- 9. Balance bridge

  function renderBalanceSection(container, { branch = '', locked = false } = {}) {
    const table = el('div', { class: 'tablewrap' }, 'Load a batch in the Queue section to see its latest balance-bridge recon run.');
    let branchValue = branch;
    const branchField = labelOrInput('Branch', { locked, value: branch });
    const kindSelect = el('select', {}, [el('option', {}, 'BASELINE'), el('option', {}, 'POST_RUN')]);

    function showForBatchDetail(data) {
      table.innerHTML = '';
      table.appendChild(el('p', {}, ['Latest Layer C: ', data.latest_layer_c ? statusSpan(data.latest_layer_c.status) : document.createTextNode('(none)')]));
      const bb = data.latest_balance_bridge;
      table.appendChild(el('p', {}, ['Latest balance bridge: ', bb ? statusSpan(bb.status) : document.createTextNode('(none)')]));
    }

    async function takeSnapshot() {
      const b = locked ? branchValue : branchField.input.value.trim();
      if (!b) return;
      try {
        const result = await api('/api/snapshots', { method: 'POST', body: { branchCode: b, kind: kindSelect.value } });
        toast(`Snapshot taken: ${JSON.stringify(result)}`, 'success');
      } catch (err) {
        toast(err.message, 'error');
      }
    }

    const controls = el('div', { class: 'controls' }, [
      locked ? branchField : branchField.node,
      el('label', {}, ['Kind', kindSelect]),
      el('button', { onclick: takeSnapshot }, 'Take snapshot (operator, read-only against Books)'),
    ]);
    container.appendChild(el('h3', {}, 'Live Books balance bridge'));
    container.appendChild(table);
    container.appendChild(controls);

    return {
      setBranch(b) {
        branchValue = b;
        if (!locked) branchField.input.value = b;
      },
      showForBatchDetail,
    };
  }

  // ---------------------------------------------------------------- 10. Audit & worker health

  function renderAuditSection(container, { branch = '', locked = false } = {}) {
    const auditTable = el('div', { class: 'tablewrap' });
    const workerHealthEl = el('div', { class: 'tablewrap' });
    const entityInput = el('input', { placeholder: 'migration_batches' });
    const idInput = el('input', {});

    async function loadAudit() {
      const params = new URLSearchParams();
      if (entityInput.value.trim()) params.set('entity', entityInput.value.trim());
      if (idInput.value.trim()) params.set('id', idInput.value.trim());
      try {
        const { audit_events } = await api(`/api/audit?${params.toString()}`);
        const branchScoped = branch ? audit_events.filter((e) => !e.branch_code || e.branch_code === branch) : audit_events;
        renderTable(auditTable, branchScoped, [
          { key: 'created_at', label: 'When' },
          { key: 'actor', label: 'Actor' },
          { key: 'action', label: 'Action' },
          { key: 'entity_type', label: 'Entity' },
          { key: 'entity_id', label: 'Entity id' },
          { key: 'authorization_decision', label: 'Decision', status: true },
          { key: 'correlation_id', label: 'Correlation' },
        ]);
      } catch (err) {
        showError(auditTable, err);
      }
    }

    async function loadWorkerHealth() {
      try {
        const health = await api('/api/worker/health');
        renderJson(workerHealthEl, health);
      } catch (err) {
        showError(workerHealthEl, err);
      }
    }

    const controls = el('div', { class: 'controls' }, [
      locked ? null : el('label', {}, ['Entity type', entityInput]),
      locked ? null : el('label', {}, ['Entity id', idInput]),
      el('button', { onclick: loadAudit }, 'Load audit (admin/operator)'),
      el('button', { onclick: loadWorkerHealth }, 'Worker health'),
    ]);
    container.appendChild(el('h3', {}, 'Audit & worker health'));
    container.appendChild(controls);
    container.appendChild(auditTable);
    container.appendChild(workerHealthEl);
    loadAudit();

    return { refresh: loadAudit };
  }

  // ---------------------------------------------------------------- #/legacy page: every
  // section stacked exactly as the original single-page console did, fully interactive
  // (locked: false everywhere), sections wired together the way the original page's
  // shared-DOM-id fields used to (selecting a run feeds Layer A/Bridge/Preview; viewing a
  // batch's queue feeds the Balance section).

  function renderLegacyPage(container) {
    container.appendChild(el('p', { class: 'notice' }, 'Legacy single-page console — every stage as its own section, exactly as before. Prefer the Branches dashboard for day-to-day work.'));

    const secOverview = el('section', { class: 'card' });
    const secFiles = el('section', { class: 'card' });
    const secCutover = el('section', { class: 'card' });
    const secLayerA = el('section', { class: 'card' });
    const secBridge = el('section', { class: 'card' });
    const secExceptions = el('section', { class: 'card' });
    const secPreview = el('section', { class: 'card' });
    const secApproval = el('section', { class: 'card' });
    const secQueue = el('section', { class: 'card' });
    const secBalance = el('section', { class: 'card' });
    const secAudit = el('section', { class: 'card' });
    for (const s of [secOverview, secFiles, secCutover, secLayerA, secBridge, secExceptions, secPreview, secApproval, secQueue, secBalance, secAudit]) {
      container.appendChild(s);
    }

    renderOverviewSection(secOverview, {});
    const layerA = renderLayerASection(secLayerA, {});
    const bridge = renderBridgeSection(secBridge, {});
    const preview = renderPreviewSection(secPreview, {});
    renderFilesSection(secFiles, {
      onRunSelected: (runId) => {
        layerA.setRunId(runId);
        bridge.setRunId(runId);
        preview.setRunId(runId);
      },
    });
    renderCutoverSection(secCutover, {});
    renderExceptionsSection(secExceptions, {});
    const queue = renderQueueSection(secQueue, {});
    const balance = renderBalanceSection(secBalance, {});
    renderApprovalSection(secApproval, {
      onBatchSelected: (batchId) => {
        queue.setBatchId(batchId);
        const detail = queue.getDetail();
        if (detail) balance.showForBatchDetail(detail);
      },
    });
    renderAuditSection(secAudit, {});
  }

  window.App.registerRoute('/legacy', renderLegacyPage);

  window.Views = window.Views || {};
  window.Views.legacy = {
    renderOverviewSection,
    renderFilesSection,
    renderCutoverSection,
    renderLayerASection,
    renderBridgeSection,
    renderExceptionsSection,
    renderPreviewSection,
    renderApprovalSection,
    renderQueueSection,
    renderBalanceSection,
    renderAuditSection,
  };
})();
