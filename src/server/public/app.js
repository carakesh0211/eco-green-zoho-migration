// Vanilla-JS console. No framework, no build step. The token lives ONLY in
// sessionStorage, and only after the user pastes it into the login box — never
// persisted, never sent anywhere but this origin's own API. The UI is not a security
// boundary: every check here is cosmetic convenience, the server re-checks everything.
'use strict';

const TOKEN_KEY = 'egzb_token';

function getToken() {
  try {
    return sessionStorage.getItem(TOKEN_KEY) || '';
  } catch {
    return '';
  }
}
function setToken(t) {
  try {
    if (t) sessionStorage.setItem(TOKEN_KEY, t);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* sessionStorage may be unavailable (private mode); login just won't persist */
  }
}

function newCorrelationId() {
  return 'ui_' + Math.random().toString(16).slice(2) + Date.now().toString(16);
}

async function api(path, { method = 'GET', body } = {}) {
  const headers = { 'X-Correlation-Id': newCorrelationId() };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    const err = new Error((data && (data.message || data.error)) || `HTTP ${res.status}`);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'text') node.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c === null || c === undefined) continue;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

function statusSpan(status) {
  return el('span', { class: `status-${status}` }, String(status ?? ''));
}

/** Render an array of plain objects as a table. `linkCols` maps a column name to a
 *  click handler(row) so a dashboard number can drill down to the data behind it. */
function renderTable(container, rows, columns, { linkCols = {}, empty = 'No rows.' } = {}) {
  container.innerHTML = '';
  if (!rows || rows.length === 0) {
    container.appendChild(el('p', { class: 'muted' }, empty));
    return;
  }
  const table = el('table');
  const thead = el('tr', {}, columns.map((c) => el('th', {}, c.label ?? c.key)));
  table.appendChild(el('thead', {}, thead));
  const tbody = el('tbody');
  for (const row of rows) {
    const tr = el('tr');
    for (const c of columns) {
      const raw = c.get ? c.get(row) : row[c.key];
      let cell;
      if (c.status) {
        cell = statusSpan(raw);
      } else if (linkCols[c.key]) {
        cell = el('button', { class: 'linklike', onclick: () => linkCols[c.key](row) }, String(raw ?? ''));
      } else {
        cell = document.createTextNode(raw === null || raw === undefined ? '' : String(raw));
      }
      tr.appendChild(el('td', {}, cell));
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  container.appendChild(table);
}

function renderJson(container, obj) {
  container.innerHTML = '';
  container.appendChild(el('pre', { class: 'json' }, JSON.stringify(obj, null, 2)));
}

function showError(container, err) {
  container.innerHTML = '';
  container.appendChild(el('p', { class: 'muted' }, `Error: ${err.message}`));
}

function val(id) {
  const node = document.getElementById(id);
  return node ? node.value.trim() : '';
}

// ---------------------------------------------------------------- auth / health

let lastHealth = null;

async function refreshHealth() {
  const banner = document.getElementById('postingBanner');
  const archiveNotice = document.getElementById('archiveDisabledNotice');
  const syntheticBadge = document.getElementById('syntheticBadge');
  const devSeedBtn = document.getElementById('devSeedBtn');
  try {
    const health = await api('/api/health');
    lastHealth = health;
    banner.textContent =
      `POSTING DISABLED — driver=${health.driver} — store=${health.storeAdapter} (${health.claimSemantics}) — ` +
      `archive=${health.archiveStatus} — env=${health.environment}` +
      (health.postingEnabled ? ' (POSTING IS ENABLED!)' : '');
    archiveNotice.hidden = health.archiveStatus !== 'DISABLED_DEVELOPMENT';
    syntheticBadge.hidden = health.environment === 'Production';
    devSeedBtn.hidden = health.environment !== 'Development';
  } catch (err) {
    banner.textContent = `POSTING DISABLED — health check failed: ${err.message}`;
  }
}

function updateAuthUi() {
  const token = getToken();
  document.getElementById('logoutBtn').hidden = !token;
  document.getElementById('whoami').textContent = token ? 'signed in' : '';
  document.getElementById('authNotice').hidden = Boolean(token);
}

document.getElementById('loginBtn').addEventListener('click', () => {
  const t = document.getElementById('tokenInput').value.trim();
  if (!t) return;
  setToken(t);
  document.getElementById('tokenInput').value = '';
  updateAuthUi();
  loadOverview();
});
document.getElementById('logoutBtn').addEventListener('click', () => {
  setToken('');
  updateAuthUi();
});

// ---------------------------------------------------------------- Overview (dev/summary)

async function loadOverview() {
  const branch = val('overviewBranch');
  const q = branch ? `?branch=${encodeURIComponent(branch)}` : '';
  try {
    const summary = await api(`/api/dev/summary${q}`);

    renderTable(document.getElementById('overviewRuns'), summary.runs, [
      { key: 'id', label: 'Run id' },
      { key: 'branchCode', label: 'Branch' },
      { key: 'status', label: 'Status', status: true },
    ], { empty: 'No runs yet.' });

    const bridgeRows = Object.entries(summary.dispositionBridge?.byDisposition ?? {}).map(([disposition, g]) => ({
      disposition, count: g.count, debit: g.debit, credit: g.credit,
    }));
    renderTable(document.getElementById('overviewBridge'), bridgeRows, [
      { key: 'disposition', label: 'Disposition', status: true },
      { key: 'count', label: 'Count' },
      { key: 'debit', label: 'Debit' },
      { key: 'credit', label: 'Credit' },
    ], { empty: 'No dispositions yet.' });

    const layerRows = Object.entries(summary.layerStatus ?? {}).map(([layer, status]) => ({ layer, status }));
    renderTable(document.getElementById('overviewLayers'), layerRows, [
      { key: 'layer', label: 'Layer' },
      { key: 'status', label: 'Status', status: true },
    ]);

    const batchRows = Object.entries(summary.batches?.byStatus ?? {}).map(([status, count]) => ({ status, count }));
    renderTable(document.getElementById('overviewBatches'), batchRows, [
      { key: 'status', label: 'Batch status', status: true },
      { key: 'count', label: 'Count' },
    ], { empty: 'No batches yet.' });

    const queueRows = Object.entries(summary.queueCounts ?? {}).map(([status, count]) => ({ status, count }));
    renderTable(document.getElementById('overviewQueue'), queueRows, [
      { key: 'status', label: 'Queue status', status: true },
      { key: 'count', label: 'Count' },
    ], { empty: 'No queue items yet.' });

    const excRows = Object.entries(summary.exceptionsByCategory ?? {}).map(([category, count]) => ({ category, count }));
    renderTable(document.getElementById('overviewExceptions'), excRows, [
      { key: 'category', label: 'Exception category' },
      { key: 'count', label: 'Count' },
    ], { empty: 'No exceptions.' });
  } catch (err) {
    showError(document.getElementById('overviewRuns'), err);
  }
}

async function runDevSeed() {
  const statusEl = document.getElementById('devSeedStatus');
  statusEl.textContent = 'starting…';
  try {
    const { jobId } = await api('/api/dev/seed', { method: 'POST', body: {} });
    statusEl.textContent = `job ${jobId}: running…`;
    for (let i = 0; i < 200; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const status = await api(`/api/dev/seed/status?jobId=${encodeURIComponent(jobId)}`);
      statusEl.textContent = `job ${jobId}: ${status.stage}${status.outcome ? ` — ${status.outcome}` : ''}`;
      if (status.outcome) {
        loadOverview();
        return;
      }
    }
  } catch (err) {
    statusEl.textContent = `Error: ${err.message}`;
  }
}

// ---------------------------------------------------------------- 1. Files & validation

async function loadRuns() {
  const container = document.getElementById('runsTable');
  try {
    const branch = val('filesBranch');
    const q = branch ? `?branch=${encodeURIComponent(branch)}` : '';
    const { runs } = await api(`/api/runs${q}`);
    renderTable(
      container,
      runs,
      [
        { key: 'id', label: 'Run id' },
        { key: 'branch_code', label: 'Branch' },
        { key: 'status', label: 'Status', status: true },
        { key: 'from_date', label: 'From' },
        { key: 'to_date', label: 'To' },
      ],
      { linkCols: { id: (row) => { document.getElementById('filesRunId').value = row.id; loadRunDetail(); } } }
    );
  } catch (err) {
    showError(container, err);
  }
}

async function loadRunDetail() {
  const container = document.getElementById('runDetail');
  const id = val('filesRunId');
  if (!id) return;
  try {
    const data = await api(`/api/runs/${encodeURIComponent(id)}`);
    container.innerHTML = '';
    container.appendChild(
      el('p', {}, `Status: `),
    );
    container.lastChild.appendChild(statusSpan(data.run.status));
    container.appendChild(el('p', {}, `Vouchers: ${data.voucher_total} — ${JSON.stringify(data.voucher_counts)}`));
    const table = el('div');
    container.appendChild(table);
    renderTable(table, data.files, [
      { key: 'file_name', label: 'File' },
      { key: 'file_role', label: 'Role' },
      { key: 'status', label: 'Status', status: true },
      { key: 'actual_row_count', label: 'Rows' },
      { key: 'sha256', label: 'sha256' },
    ]);
  } catch (err) {
    showError(container, err);
  }
}

// ---------------------------------------------------------------- 2. Cutover matrix

async function loadCutover() {
  const container = document.getElementById('cutoverTable');
  try {
    const branch = val('cutoverBranch');
    const q = branch ? `?branch=${encodeURIComponent(branch)}` : '';
    const { cutover } = await api(`/api/cutover${q}`);
    renderTable(
      container,
      cutover,
      [
        { key: 'branch_code', label: 'Branch' },
        { key: 'transaction_class', label: 'Class' },
        { key: 'payment_method', label: 'Payment' },
        { key: 'smart_pharma_coverage_status', label: 'SP coverage' },
        { key: 'approval_status', label: 'Approval', status: true },
        { key: 'cutover_rule_version', label: 'Rule version' },
        { key: 'id', label: 'Approve' },
      ],
      {
        linkCols: {
          id: async (row) => {
            if (row.approval_status === 'APPROVED') return;
            const reason = prompt('Approval reason?') || '';
            try {
              await api(`/api/cutover/${row.id}/approve`, { method: 'POST', body: { reason } });
              loadCutover();
            } catch (err) {
              alert(err.message);
            }
          },
        },
      }
    );
  } catch (err) {
    showError(container, err);
  }
}

// ---------------------------------------------------------------- 3. Layer A

async function loadReconA() {
  const container = document.getElementById('reconATable');
  const id = val('reconAId');
  if (!id) return;
  try {
    const { recon_run, results } = await api(`/api/recon/${encodeURIComponent(id)}`);
    container.innerHTML = '';
    container.appendChild(el('p', {}, [`Layer ${recon_run.layer} — `, statusSpan(recon_run.status)]));
    const table = el('div');
    container.appendChild(table);
    renderTable(table, results, [
      { key: 'control_key', label: 'Control' },
      { key: 'expected', label: 'Expected' },
      { key: 'actual', label: 'Actual' },
      { key: 'difference', label: 'Diff' },
      { key: 'status', label: 'Status', status: true },
    ]);
  } catch (err) {
    showError(container, err);
  }
}

/** Loads the newest Layer A recon run for a run id, so the card is reachable without
 * already knowing a recA_... id. */
async function loadLatestReconA() {
  const container = document.getElementById('reconATable');
  const runId = val('rerunReconRunId');
  if (!runId) return;
  try {
    const { recon_run } = await api(`/api/runs/${encodeURIComponent(runId)}/recon-a`);
    if (!recon_run) { showError(container, new Error('No Layer A reconciliation has been run for ' + runId)); return; }
    document.getElementById('reconAId').value = recon_run.id;
    await loadReconA();
  } catch (err) {
    showError(container, err);
  }
}

async function rerunRecon() {
  const runId = val('rerunReconRunId');
  if (!runId) return;
  try {
    const result = await api(`/api/runs/${encodeURIComponent(runId)}/rerun-recon`, { method: 'POST', body: {} });
    document.getElementById('reconAId').value = result.reconRunId;
    loadReconA();
  } catch (err) {
    alert(err.message);
  }
}

// ---------------------------------------------------------------- 4. Bridge (Layer B)

async function loadBridge() {
  const container = document.getElementById('bridgeTable');
  const runId = val('bridgeRunId');
  if (!runId) return;
  try {
    const { recon_run, results } = await api(`/api/runs/${encodeURIComponent(runId)}/bridge`);
    container.innerHTML = '';
    if (!recon_run) {
      container.appendChild(el('p', { class: 'muted' }, 'No Layer B recon run yet for this run.'));
      return;
    }
    container.appendChild(el('p', {}, [`Layer B — `, statusSpan(recon_run.status)]));
    const table = el('div');
    container.appendChild(table);
    renderTable(
      table,
      results,
      [
        { key: 'control_key', label: 'Control' },
        { key: 'expected', label: 'Expected' },
        { key: 'actual', label: 'Actual' },
        { key: 'status', label: 'Status', status: true },
        { key: 'control_key', label: 'Drilldown' },
      ],
      {
        linkCols: {
          // Second "control_key" column is dedicated to the drilldown link.
        },
      }
    );
    // Drilldown row: click a disposition control to list the vouchers behind it.
    const dispositions = ['MIGRATE', 'SMART_PHARMA_EXCLUDED', 'OTHER_EXCLUDED', 'BLOCKED'];
    const linksWrap = el('p');
    for (const d of dispositions) {
      linksWrap.appendChild(
        el('button', { class: 'linklike mr8', onclick: () => loadBridgeVouchers(runId, d) }, d)
      );
    }
    container.appendChild(linksWrap);
  } catch (err) {
    showError(container, err);
  }
}

async function loadBridgeVouchers(runId, disposition) {
  const container = document.getElementById('bridgeVouchers');
  try {
    const { vouchers } = await api(`/api/vouchers?run=${encodeURIComponent(runId)}&disposition=${encodeURIComponent(disposition)}`);
    renderTable(container, vouchers, [
      { key: 'id', label: 'Voucher id' },
      { key: 'source_record_id', label: 'Source id' },
      { key: 'branch_code', label: 'Branch' },
      { key: 'debit_total', label: 'Debit' },
      { key: 'credit_total', label: 'Credit' },
      { key: 'disposition', label: 'Disposition', status: true },
    ]);
  } catch (err) {
    showError(container, err);
  }
}

// ---------------------------------------------------------------- 5. Exceptions

async function loadExceptions() {
  const container = document.getElementById('exceptionsTable');
  try {
    const params = new URLSearchParams();
    const branch = val('excBranch');
    const category = val('excCategory');
    const status = val('excStatus');
    if (branch) params.set('branch', branch);
    if (category) params.set('category', category);
    if (status) params.set('status', status);
    const { exceptions } = await api(`/api/exceptions?${params.toString()}`);
    renderTable(
      container,
      exceptions,
      [
        { key: 'id', label: 'id' },
        { key: 'category', label: 'Category' },
        { key: 'severity', label: 'Severity' },
        { key: 'status', label: 'Status', status: true },
        { key: 'branch_code', label: 'Branch' },
        { key: 'financial_impact', label: 'Impact' },
        { key: 'message', label: 'Message' },
        { key: 'id', label: 'Resolve' },
      ],
      {
        linkCols: {
          id: async (row) => {
            const status2 = prompt('Resolve as (RESOLVED / APPROVED_EXCEPTION / REJECTED)?', 'RESOLVED');
            if (!status2) return;
            const rootCause = prompt('Root cause?') || '';
            try {
              await api(`/api/exceptions/${row.id}/resolve`, { method: 'POST', body: { status: status2, rootCause } });
              loadExceptions();
            } catch (err) {
              alert(err.message);
            }
          },
        },
      }
    );
  } catch (err) {
    showError(container, err);
  }
}

// ---------------------------------------------------------------- 6. Preview

async function loadPreview() {
  const container = document.getElementById('previewModules');
  document.getElementById('previewVouchers').innerHTML = '';
  document.getElementById('previewPayload').innerHTML = '';
  const runId = val('previewRunId');
  if (!runId) return;
  try {
    const { vouchers } = await api(`/api/vouchers?run=${encodeURIComponent(runId)}&disposition=MIGRATE`);
    const byModule = new Map();
    for (const v of vouchers) {
      const mod = v.target_module || '(unrouted)';
      byModule.set(mod, (byModule.get(mod) || 0) + 1);
    }
    const rows = [...byModule.entries()].map(([target_module, count]) => ({ target_module, count }));
    renderTable(container, rows, [
      { key: 'target_module', label: 'Module' },
      { key: 'count', label: 'Count' },
    ], {
      linkCols: {
        count: (row) => loadPreviewVouchers(runId, row.target_module === '(unrouted)' ? null : row.target_module),
      },
    });
  } catch (err) {
    showError(container, err);
  }
}

async function loadPreviewVouchers(runId, targetModule) {
  const container = document.getElementById('previewVouchers');
  try {
    const { vouchers } = await api(`/api/vouchers?run=${encodeURIComponent(runId)}&disposition=MIGRATE`);
    const filtered = targetModule ? vouchers.filter((v) => v.target_module === targetModule) : vouchers.filter((v) => !v.target_module);
    renderTable(container, filtered, [
      { key: 'id', label: 'Voucher id' },
      { key: 'source_record_id', label: 'Source id' },
      { key: 'target_module', label: 'Module' },
      { key: 'id', label: 'Payload' },
    ], {
      linkCols: { id: (row) => loadPreviewPayload(row.id) },
    });
  } catch (err) {
    showError(container, err);
  }
}

async function loadPreviewPayload(voucherId) {
  const container = document.getElementById('previewPayload');
  try {
    const detail = await api(`/api/vouchers/${voucherId}`);
    container.innerHTML = '';
    for (const p of detail.preview_payloads) {
      container.appendChild(el('p', {}, p.human_summary));
    }
    renderJson(container, detail.preview_payloads);
  } catch (err) {
    showError(container, err);
  }
}

// ---------------------------------------------------------------- 7. Approval

async function loadBatches() {
  const container = document.getElementById('batchesCards');
  container.innerHTML = '';
  try {
    const branch = val('batchesBranch');
    const q = branch ? `?branch=${encodeURIComponent(branch)}` : '';
    const { batches } = await api(`/api/batches${q}`);
    if (batches.length === 0) {
      container.appendChild(el('p', { class: 'muted' }, 'No batches.'));
      return;
    }
    for (const b of batches) {
      const card = el('div', { class: 'batchCard' });
      card.appendChild(el('div', {}, [`${b.id} — `, statusSpan(b.status)]));
      card.appendChild(
        el('div', { class: 'meta' }, `branch ${b.branch_code} · period ${b.period} · scope_hash ${b.scope_hash} · mapping ${b.mapping_version} · transform ${b.transformation_version} · cutover ${b.cutover_rule_version} · vouchers ${b.voucher_count} · debit ${b.debit_total} · credit ${b.credit_total}`)
      );
      const actions = el('div', { class: 'actions' });
      actions.appendChild(
        el('button', {
          onclick: async () => {
            const reason = prompt('Approval reason (segregation of duties: you must not be the batch creator)?') || '';
            try {
              await api(`/api/batches/${b.id}/approve`, { method: 'POST', body: { reason } });
              loadBatches();
            } catch (err) {
              alert(err.message);
            }
          },
        }, 'Approve')
      );
      actions.appendChild(
        el('button', {
          onclick: () => {
            document.getElementById('queueBatchId').value = b.id;
            loadBatchQueue();
          },
        }, 'View queue/Layer C')
      );
      card.appendChild(actions);
      container.appendChild(card);
    }
  } catch (err) {
    showError(container, err);
  }
}

// ---------------------------------------------------------------- 8. Queue & Layer C

let lastBatchDetail = null;

async function loadBatchQueue() {
  const summary = document.getElementById('queueSummary');
  const attemptsEl = document.getElementById('attemptsTable');
  const id = val('queueBatchId');
  if (!id) return;
  try {
    const data = await api(`/api/batches/${encodeURIComponent(id)}`);
    lastBatchDetail = data;
    summary.innerHTML = '';
    summary.appendChild(el('p', {}, [`Batch ${data.batch.id} — `, statusSpan(data.batch.status)]));
    summary.appendChild(
      el('p', {}, `Queue counts: ${Object.entries(data.queue_counts).map(([k, v]) => `${k}=${v}`).join(', ') || '(none)'}`)
    );
    summary.appendChild(
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
    renderBalanceBridge(data);
  } catch (err) {
    showError(summary, err);
  }
}

async function batchAction(id, action) {
  try {
    await api(`/api/batches/${id}/${action}`, { method: 'POST', body: {} });
    loadBatchQueue();
  } catch (err) {
    alert(err.message);
  }
}

async function retryQueueItem() {
  const id = val('retryItemId');
  const reason = val('retryReason');
  if (!id) return;
  try {
    await api(`/api/queue/${id}/retry`, { method: 'POST', body: reason ? { reason } : {} });
    if (lastBatchDetail) loadBatchQueue();
  } catch (err) {
    alert(err.message);
  }
}

// ---------------------------------------------------------------- 9. Balance bridge

function renderBalanceBridge(data) {
  const container = document.getElementById('balanceTable');
  container.innerHTML = '';
  container.appendChild(
    el('p', {}, [
      'Latest Layer C: ',
      data.latest_layer_c ? statusSpan(data.latest_layer_c.status) : document.createTextNode('(none)'),
    ])
  );
  const bb = data.latest_balance_bridge;
  container.appendChild(
    el('p', {}, [
      'Latest balance bridge: ',
      bb ? statusSpan(bb.status) : document.createTextNode('(none)'),
      bb ? el('button', { class: 'linklike ml8', onclick: () => { document.getElementById('reconAId').value = bb.id; loadReconA(); } }, 'view controls') : null,
    ])
  );
}

async function takeSnapshot() {
  const branchCode = val('snapBranch');
  const kind = document.getElementById('snapKind').value;
  if (!branchCode) return;
  try {
    const result = await api('/api/snapshots', { method: 'POST', body: { branchCode, kind } });
    alert(`Snapshot taken: ${JSON.stringify(result)}`);
  } catch (err) {
    alert(err.message);
  }
}

// ---------------------------------------------------------------- 10. Audit & worker health

async function loadAudit() {
  const container = document.getElementById('auditTable');
  try {
    const params = new URLSearchParams();
    const entity = val('auditEntity');
    const id = val('auditId');
    if (entity) params.set('entity', entity);
    if (id) params.set('id', id);
    const { audit_events } = await api(`/api/audit?${params.toString()}`);
    renderTable(container, audit_events, [
      { key: 'created_at', label: 'When' },
      { key: 'actor', label: 'Actor' },
      { key: 'action', label: 'Action' },
      { key: 'entity_type', label: 'Entity' },
      { key: 'entity_id', label: 'Entity id' },
      { key: 'authorization_decision', label: 'Decision', status: true },
      { key: 'correlation_id', label: 'Correlation' },
    ]);
  } catch (err) {
    showError(container, err);
  }
}

async function loadWorkerHealth() {
  const container = document.getElementById('workerHealth');
  try {
    const health = await api('/api/worker/health');
    renderJson(container, health);
  } catch (err) {
    showError(container, err);
  }
}

// ---------------------------------------------------------------- wiring

const ACTIONS = {
  loadOverview,
  runDevSeed,
  loadRuns,
  loadRunDetail,
  loadCutover,
  loadReconA,
  loadLatestReconA,
  rerunRecon,
  loadBridge,
  loadExceptions,
  loadPreview,
  loadBatches,
  loadBatchQueue,
  retryQueueItem,
  takeSnapshot,
  loadAudit,
  loadWorkerHealth,
};

document.querySelectorAll('[data-action]').forEach((btn) => {
  const fn = ACTIONS[btn.getAttribute('data-action')];
  if (fn) btn.addEventListener('click', fn);
});

updateAuthUi();
refreshHealth();
if (getToken()) loadOverview();
