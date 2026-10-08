// Branch workspace (#/branches/:code) — one branch, one guided flow. A summary header
// (GET /api/branches/:code) sits above a 7-step stepper (Receive files -> Prove
// balances). Each step's state (done / blocked / to-do) is derived from the summary row;
// the first step that is not done is selected by default. The selected step renders ONE
// panel: a plain-language explanation, a blocker box when something stops the step, and
// the existing legacy stage section(s) (views/legacy.js) for that step, reused with the
// branch pre-filled and locked. Step bodies are rendered lazily, once, so opening a
// branch does not fire every section's API call at once. A right-hand rail holds two
// collapsed extras: this branch's exceptions and its activity (audit) log.
'use strict';

(function () {
  const { api, el, chip, showError, navigate, toast } = window.App;
  const legacy = window.Views.legacy;

  // ---------------------------------------------------------------- step state rules

  const n = (v) => Number(v) || 0;

  /**
   * computeSteps(row, { postingDisabled }) -> 7 step descriptors derived ONLY from the
   * branch summary row (GET /api/branches/:code). A missing row (summary API not
   * available) yields seven "to do" steps. Each descriptor:
   *   { id, no, title, state: 'done' | 'blocked' | 'todo', short, explain, blockers[], chips[] }
   * where blockers are `{ text, exceptions? }` (exceptions: true adds an "Open
   * exceptions" link) and chips are `{ status, label }` showing the raw status codes.
   *
   * Rules (state is 'blocked' only for a genuine failure; an unmet prerequisite keeps the
   * step 'todo' and is explained in a blocker box instead):
   *   1 Receive files     done: receipt RECEIVED | blocked: VALIDATION_FAILED | todo: NOT_RECEIVED, PARTIAL
   *   2 Reconcile source  done: layer_a PASS    | blocked: FAIL                | todo: NOT_RUN
   *   3 Scope & mapping   done: mapping APPROVED and overlap CLEAR | blocked: overlap OVERLAP_FOUND | todo: otherwise
   *   4 Review postings   done: a batch has been built (batch approval READY_FOR_APPROVAL or APPROVED) | todo: otherwise
   *   5 Approve           done: batch APPROVED  | blocked: REJECTED (rejected or invalidated) | todo: NONE, DRAFT, READY_FOR_APPROVAL
   *   6 Post to Books     done: total > 0 and migrated = total | todo: otherwise (never blocked; "disabled here" is shown, not an error)
   *   7 Prove balances    done: layer_c PASS and balance_bridge PASS | blocked: either FAIL | todo: otherwise
   */
  function computeSteps(row, { postingDisabled = true } = {}) {
    const r = row || {};
    const receipt = r.receipt_status || 'NOT_RECEIVED';
    const layerA = r.layer_a_status || 'NOT_RUN';
    const mapping = r.mapping_status || 'NOT_STARTED';
    const overlap = r.overlap_status || 'NOT_ASSESSED';
    const approval = r.batch_approval_status || 'NONE';
    const layerC = r.layer_c_status || 'NOT_RUN';
    const bridge = r.balance_bridge_status || 'NOT_RUN';
    const migrated = n(r.migrated_count);
    const total = n(r.total_count);
    const openExc = n(r.open_exception_count);
    const impact = r.open_exception_impact ?? '0.00';
    const excText = openExc > 0 ? `${openExc} open exception${openExc === 1 ? '' : 's'} (₹${impact})` : 'no open exceptions recorded';

    // ---- 1 Receive files
    const s1 = {
      id: 'files', no: 1, title: 'Receive files',
      explain: 'Upload the branch extract files and confirm they pass validation. Every later step works from these files.',
      blockers: [],
      chips: [{ status: receipt, label: `Files received: ${receipt}` }],
    };
    if (receipt === 'RECEIVED') { s1.state = 'done'; s1.short = 'All files received'; }
    else if (receipt === 'VALIDATION_FAILED') {
      s1.state = 'blocked'; s1.short = 'Validation failed';
      s1.blockers.push({ text: 'File validation failed. Fix the problem in the source file and upload it again.' });
    } else if (receipt === 'PARTIAL') {
      s1.state = 'todo'; s1.short = 'Some files missing';
      s1.blockers.push({ text: 'Only some of the expected files have been received and archived. Upload the rest.' });
    } else { s1.state = 'todo'; s1.short = 'No files yet'; }

    // ---- 2 Reconcile source
    const s2 = {
      id: 'reconcile', no: 2, title: 'Reconcile source',
      explain: 'Opening balance plus transactions must equal the closing trial balance of the source system. If they do not, the extract is incomplete or wrong and nothing downstream can be trusted.',
      blockers: [],
      chips: [{ status: layerA, label: `Source reconciliation: ${layerA}` }],
    };
    if (layerA === 'PASS') { s2.state = 'done'; s2.short = 'Reconciled'; }
    else if (layerA === 'FAIL') {
      s2.state = 'blocked'; s2.short = 'Differences found';
      s2.blockers.push({ text: `Source reconciliation failed: ${excText}. Review them in Exceptions, correct the source, and run again.`, exceptions: true });
    } else {
      s2.state = 'todo'; s2.short = 'Not run yet';
      if (receipt !== 'RECEIVED') s2.blockers.push({ text: 'Waiting for step 1: the files must be fully received before the source can be reconciled.' });
    }

    // ---- 3 Scope & mapping
    const mappingOk = mapping === 'APPROVED';
    const s3 = {
      id: 'scope', no: 3, title: 'Scope & mapping',
      explain: 'Confirm the migration window, that the mapping rules (ledgers, parties, payment modes, taxes) are approved, and that nothing overlaps what the old Smart Pharma system already posted.',
      blockers: [],
      chips: [
        { status: mapping, label: `Mapping: ${mapping}` },
        { status: overlap, label: `Overlap check: ${overlap}` },
      ],
    };
    if (overlap === 'OVERLAP_FOUND') {
      s3.state = 'blocked'; s3.short = 'Overlap found';
      s3.blockers.push({ text: 'Some vouchers overlap with transactions already posted in the live system. Decide what to exclude before continuing.', exceptions: true });
    } else if (mappingOk && overlap === 'CLEAR') {
      s3.state = 'done'; s3.short = 'Mapping approved, no overlap';
    } else {
      s3.state = 'todo';
      s3.short = !mappingOk ? 'Mapping not approved' : 'Overlap not checked';
    }
    if (s3.state === 'todo' && !mappingOk) {
      s3.blockers.push({ text: mapping === 'NOT_STARTED' ? 'No mapping rules exist yet.' : 'Mapping rules are still in draft and need approval.' });
    }
    if (s3.state === 'todo' && overlap === 'NOT_ASSESSED') {
      s3.blockers.push({ text: 'The overlap check against the live system has not run yet.' });
    }

    // ---- 4 Review postings
    const batchBuilt = approval === 'READY_FOR_APPROVAL' || approval === 'APPROVED';
    const s4 = {
      id: 'review', no: 4, title: 'Review postings',
      explain: 'Look at the vouchers that would be posted to Zoho Books: what gets migrated, what is excluded, and the debit and credit totals. Nothing is posted at this step.',
      blockers: [],
      chips: [{ status: approval, label: `Voucher batch: ${approval}` }],
    };
    if (batchBuilt) { s4.state = 'done'; s4.short = 'Batch built'; }
    else {
      s4.state = 'todo'; s4.short = layerA === 'PASS' && s3.state === 'done' ? 'Ready to review' : 'Waiting for steps 2-3';
      if (layerA !== 'PASS' || s3.state !== 'done') {
        s4.blockers.push({ text: 'Finish step 2 (source reconciliation) and step 3 (scope and mapping) before reviewing postings.' });
      }
    }

    // ---- 5 Approve
    const s5 = {
      id: 'approve', no: 5, title: 'Approve',
      explain: 'A second person, not the one who built the batch, approves the batch. Approval locks what will be posted.',
      blockers: [],
      chips: [{ status: approval, label: `Batch approval: ${approval}` }],
    };
    if (approval === 'APPROVED') { s5.state = 'done'; s5.short = 'Approved'; }
    else if (approval === 'REJECTED') {
      s5.state = 'blocked'; s5.short = 'Rejected';
      s5.blockers.push({ text: 'The batch was rejected, or its approval was invalidated because something changed. Rebuild the batch and submit it for approval again.' });
    } else {
      s5.state = 'todo';
      if (approval === 'READY_FOR_APPROVAL') {
        s5.short = 'Awaiting approver';
        s5.blockers.push({ text: `The batch is ready and waiting for the approver${r.assigned_approver ? ` (${r.assigned_approver})` : ''}.` });
      } else if (approval === 'DRAFT') {
        s5.short = 'Draft batch';
        s5.blockers.push({ text: 'The batch is still a draft. Submit it for approval once the postings look right.' });
      } else {
        s5.short = 'No batch yet';
        s5.blockers.push({ text: 'No batch exists yet. A batch is created from the postings reviewed in step 4.' });
      }
    }

    // A BLOCKED branch whose source reconciliation did not fail is held by a serious
    // (P0/P1) open exception, which must be cleared before a batch is approved.
    if (r.readiness_status === 'BLOCKED' && layerA !== 'FAIL' && openExc > 0) {
      const text = `The branch is held up by a serious open exception. Currently ${excText}. Resolve it before the batch is approved.`;
      if (s4.state !== 'done') s4.blockers.push({ text, exceptions: true });
      if (s5.state === 'todo') s5.blockers.push({ text, exceptions: true });
    }

    // ---- 6 Post to Books
    const postedAll = total > 0 && migrated >= total;
    const s6 = {
      id: 'post', no: 6, title: 'Post to Books',
      explain: 'Send the approved batch to Zoho Books through the posting queue. Failed items can be retried; the batch can be paused and resumed.',
      blockers: [],
      chips: [{ status: postedAll ? 'MIGRATED' : migrated > 0 ? 'IN_PROGRESS' : 'NOT_STARTED', label: `Posted: ${migrated}/${total}` }],
    };
    if (postedAll) { s6.state = 'done'; s6.short = 'All posted'; }
    else {
      s6.state = 'todo';
      s6.short = postingDisabled ? 'Posting disabled here' : migrated > 0 ? `${migrated} of ${total} posted` : 'Not posted';
      if (approval !== 'APPROVED') s6.blockers.push({ text: 'Waiting for step 5: the batch must be approved before anything can be posted.' });
    }
    if (postingDisabled) {
      s6.blockers.push({ text: 'Posting to Zoho Books is disabled in this environment. Nothing can be sent to Books from here; approved items stay in the queue.' });
    }

    // ---- 7 Prove balances
    const s7 = {
      id: 'prove', no: 7, title: 'Prove balances',
      explain: 'After posting, check that Zoho Books now shows the same balances as the source: the Books reconciliation compares posted vouchers, and the balance proof compares account balances to the source closing trial balance.',
      blockers: [],
      chips: [
        { status: layerC, label: `Books reconciliation: ${layerC}` },
        { status: bridge, label: `Balance proof: ${bridge}` },
      ],
    };
    if (layerC === 'PASS' && bridge === 'PASS') { s7.state = 'done'; s7.short = 'Balances proven'; }
    else if (layerC === 'FAIL' || bridge === 'FAIL') {
      s7.state = 'blocked'; s7.short = 'Balances do not match';
      const which = [layerC === 'FAIL' ? 'Books reconciliation' : null, bridge === 'FAIL' ? 'Balance proof' : null].filter(Boolean).join(' and ');
      s7.blockers.push({ text: `${which} failed: ${excText}. Review them in Exceptions.`, exceptions: true });
    } else {
      s7.state = 'todo'; s7.short = 'Not run yet';
      if (migrated === 0) s7.blockers.push({ text: 'Nothing has been posted to Books yet, so there is nothing to prove.' });
    }

    return [s1, s2, s3, s4, s5, s6, s7];
  }

  window.Views = window.Views || {};
  window.Views.branchSteps = { computeSteps };

  // ---------------------------------------------------------------- data helpers

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

  /** True unless /api/health positively says posting is enabled (fail safe, like the banner). */
  async function isPostingDisabled() {
    let health = window.App.getLastHealth?.() ?? null;
    if (!health) {
      try {
        health = await api('/api/health');
      } catch {
        health = null;
      }
    }
    return !(health && health.postingEnabled === true);
  }

  function readinessKpiClass(status) {
    if (status === 'READY' || status === 'MIGRATED') return 'kpi-ok';
    if (status === 'BLOCKED') return 'kpi-danger';
    if (status === 'IN_PROGRESS') return 'kpi-warn';
    return '';
  }

  // ---------------------------------------------------------------- page

  async function renderBranchWorkspace(container, params) {
    const branch = params.code;
    window.App.setPageTitle?.(`Branch ${branch}`);

    const page = el('div', { class: 'page' });
    container.appendChild(page);

    const headerHost = el('div');
    const kpiHost = el('div', { class: 'kpi-grid' });
    const stepperHost = el('div', { class: 'stepper' });
    const panel = el('section', { class: 'step-panel' });
    const rail = el('aside', { class: 'side-rail' });
    page.appendChild(headerHost);
    page.appendChild(kpiHost);
    page.appendChild(stepperHost);
    page.appendChild(el('div', { class: 'two-col' }, [panel, rail]));

    headerHost.appendChild(el('p', { class: 'muted' }, 'Loading branch…'));

    let branchRow = null;
    const [summaryResult, latestRunId, latestBatchId, postingDisabled] = await Promise.all([
      api(`/api/branches/${encodeURIComponent(branch)}`).then((row) => ({ row }), (err) => ({ err })),
      fetchLatestRunId(branch),
      fetchLatestBatchId(branch),
      isPostingDisabled(),
    ]);
    if (summaryResult.err) {
      const err = summaryResult.err;
      if (err.status === 404 || err.status === 501) {
        branchRow = null; // summary API not available: header says so, steps stay "to do"
      } else {
        headerHost.innerHTML = '';
        showError(headerHost, err);
        return;
      }
    } else {
      branchRow = summaryResult.row;
    }

    // Tracks the batch the operator wants shown in the posting step — starts as the
    // latest batch for the branch, but the Approve step's "View queue" can reassign it
    // before the Post step has ever been (lazily) rendered, so that render must read this
    // at render time rather than capturing `latestBatchId` up front.
    let selectedBatchId = latestBatchId || '';

    let queueHandle = null;
    let balanceHandle = null;
    let layerAHandle = null;
    let bridgeHandle = null;
    let previewHandle = null;
    let exceptionsDetails = null;
    let auditDetails = null;
    let exceptionsSummaryEl = null;

    function openRail(details) {
      if (!details) return;
      details.open = true;
      details.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' });
    }

    // ---- per-step lazy bodies (legacy sections, branch pre-filled and locked) ----
    const bodies = {
      files: (host) =>
        legacy.renderFilesSection(host, {
          branch,
          locked: true,
          onRunSelected: (runId) => {
            if (layerAHandle) layerAHandle.setRunId(runId);
            if (bridgeHandle) bridgeHandle.setRunId(runId);
            if (previewHandle) previewHandle.setRunId(runId);
          },
        }),
      reconcile: (host) => {
        const a = el('div');
        const b = el('div');
        host.appendChild(a);
        host.appendChild(b);
        layerAHandle = legacy.renderLayerASection(a, { runId: latestRunId || '', locked: true });
        bridgeHandle = legacy.renderBridgeSection(b, { runId: latestRunId || '', locked: true });
      },
      scope: (host) => legacy.renderCutoverSection(host, { branch, locked: true }),
      review: (host) => {
        previewHandle = legacy.renderPreviewSection(host, { runId: latestRunId || '', locked: true });
      },
      approve: (host) =>
        legacy.renderApprovalSection(host, {
          branch,
          locked: true,
          onBatchSelected: (batchId) => {
            selectedBatchId = batchId;
            if (queueHandle) queueHandle.setBatchId(batchId);
            // Jump straight to the posting step after picking a batch (this triggers its
            // first, lazy render when it has not been opened yet — that render reads
            // `selectedBatchId`, so nothing is lost either way).
            selectStep('post');
            if (balanceHandle) {
              const detail = queueHandle?.getDetail();
              if (detail) balanceHandle.showForBatchDetail(detail);
            }
          },
        }),
      post: (host) => {
        queueHandle = legacy.renderQueueSection(host, { batchId: selectedBatchId, locked: true });
      },
      prove: (host) => {
        balanceHandle = legacy.renderBalanceSection(host, { branch, locked: true });
        const detail = queueHandle?.getDetail();
        if (detail) {
          balanceHandle.showForBatchDetail(detail);
        } else if (selectedBatchId) {
          api(`/api/batches/${encodeURIComponent(selectedBatchId)}`)
            .then((data) => balanceHandle.showForBatchDetail(data))
            .catch(() => {});
        }
      },
    };

    // ---- state ----
    let steps = computeSteps(branchRow, { postingDisabled });
    const firstOpen = steps.find((s) => s.state !== 'done');
    let selectedId = (firstOpen || steps[steps.length - 1]).id;

    const hosts = new Map(); // step id -> { root, head, body }
    const rendered = new Set();
    for (const s of steps) {
      const root = el('div', { hidden: '' });
      const head = el('div');
      const body = el('div');
      root.appendChild(head);
      root.appendChild(body);
      panel.appendChild(root);
      hosts.set(s.id, { root, head, body });
    }

    // ---- header ----
    function renderHeader() {
      headerHost.innerHTML = '';
      const row = branchRow;
      const name = row?.branch_name ? ` — ${row.branch_name}` : '';
      const subtitle = el('div', { class: 'subtitle' });
      if (row) {
        subtitle.appendChild(
          document.createTextNode(
            `Books location: ${row.zoho_location_name || row.zoho_location_id || 'not mapped'}` +
              ` · Migration window: ${row.migration_from_date || 'not set'} to ${row.migration_to_date || 'not set'}` +
              ` · Operator: ${row.assigned_operator || 'unassigned'}` +
              ` · Approver: ${row.assigned_approver || 'unassigned'} `
          )
        );
        subtitle.appendChild(chip(row.readiness_status, `Readiness: ${row.readiness_status}`));
      } else {
        subtitle.appendChild(
          document.createTextNode('The branch summary is not available yet. Each step below still loads its own data from the branch code.')
        );
      }
      const refreshBtn = el('button', {
        type: 'button',
        onclick: async () => {
          try {
            branchRow = await api(`/api/branches/${encodeURIComponent(branch)}/refresh`, { method: 'POST', body: {} });
            refreshAll();
            toast('Branch summary refreshed.', 'success');
          } catch (err) {
            if (err.status === 404 || err.status === 501) toast('Refresh endpoint not available yet.', 'error');
            else toast(err.message, 'error');
          }
        },
      }, 'Refresh summary');
      headerHost.appendChild(
        el('div', { class: 'breadcrumb' }, [
          el('button', { type: 'button', class: 'linklike', onclick: () => navigate('/branches') }, 'Branches'),
          ` › ${branch}`,
        ])
      );
      headerHost.appendChild(
        el('div', { class: 'page-header' }, [
          el('div', {}, [
            el('h2', {}, [`Branch ${branch}${name}`, row?.is_synthetic ? el('span', { class: 'badge badge-warn ml8' }, 'SYNTHETIC') : null]),
            subtitle,
          ]),
          el('div', { class: 'actions' }, [
            refreshBtn,
            el('button', { type: 'button', onclick: () => navigate('/branches') }, 'Back to branches'),
          ]),
        ])
      );
    }

    function renderKpis() {
      kpiHost.innerHTML = '';
      const row = branchRow;
      if (!row) return;
      const openExc = n(row.open_exception_count);
      kpiHost.appendChild(
        el('div', { class: `kpi ${n(row.total_count) > 0 && n(row.migrated_count) >= n(row.total_count) ? 'kpi-ok' : ''}`, onclick: () => selectStep('post') }, [
          el('div', { class: 'kpi-label' }, 'Vouchers posted to Books'),
          el('div', { class: 'kpi-value' }, `${n(row.migrated_count)} / ${n(row.total_count)}`),
          el('div', { class: 'kpi-hint' }, `${n(row.migration_progress_pct)}% of vouchers in scope`),
        ])
      );
      kpiHost.appendChild(
        el('div', { class: `kpi ${openExc > 0 ? 'kpi-danger' : 'kpi-ok'}`, onclick: () => openRail(exceptionsDetails) }, [
          el('div', { class: 'kpi-label' }, 'Open exceptions'),
          el('div', { class: 'kpi-value' }, String(openExc)),
          el('div', { class: 'kpi-hint' }, `Financial impact ₹${row.open_exception_impact ?? '0.00'}`),
        ])
      );
      kpiHost.appendChild(
        el('div', { class: `kpi ${readinessKpiClass(row.readiness_status)}`, onclick: () => openRail(auditDetails) }, [
          el('div', { class: 'kpi-label' }, 'Last activity'),
          el('div', { class: 'kpi-value' }, row.last_activity_at ? String(row.last_activity_at).slice(0, 10) : '—'),
          el('div', { class: 'kpi-hint' }, row.last_activity_at ? String(row.last_activity_at).slice(11, 19) : 'No activity recorded yet'),
        ])
      );
    }

    // ---- stepper + panel heads ----
    function stepStateWord(s, isNext) {
      if (s.state === 'done') return 'Done';
      if (s.state === 'blocked') return 'Blocked';
      return isNext ? 'Next action' : 'To do';
    }

    function renderStepper() {
      stepperHost.innerHTML = '';
      const nextId = steps.find((s) => s.state !== 'done')?.id;
      for (const s of steps) {
        const selected = s.id === selectedId;
        const cls = ['step', `step-${s.state}`, selected ? 'step-current' : ''].filter(Boolean).join(' ');
        stepperHost.appendChild(
          el('button', {
            type: 'button',
            class: cls,
            'data-step': s.id,
            'aria-current': selected ? 'step' : null,
            onclick: () => selectStep(s.id),
          }, [
            el('div', {}, [el('span', { class: 'step-no' }, String(s.no)), el('span', { class: 'step-title' }, s.title)]),
            el('span', { class: 'step-state' }, stepStateWord(s, s.id === nextId)),
            el('span', { class: 'step-state' }, s.short),
          ])
        );
      }
    }

    function renderHead(s) {
      const { head } = hosts.get(s.id);
      head.innerHTML = '';
      head.appendChild(el('h3', {}, `Step ${s.no}: ${s.title}`));
      head.appendChild(el('p', { class: 'step-explain' }, s.explain));
      for (const b of s.blockers) {
        head.appendChild(
          el('div', { class: 'step-blocker' }, [
            b.text,
            b.exceptions ? ' ' : null,
            b.exceptions
              ? el('button', { type: 'button', class: 'linklike', onclick: () => openRail(exceptionsDetails) }, 'Open exceptions')
              : null,
          ])
        );
      }
      head.appendChild(
        el('div', { class: 'chips-row' }, [
          el('span', { class: 'muted' }, 'Technical status: '),
          ...s.chips.map((c) => chip(c.status, c.label)),
        ])
      );
    }

    function selectStep(id) {
      if (!hosts.has(id)) return;
      selectedId = id;
      for (const [sid, h] of hosts) h.root.hidden = sid !== id;
      if (!rendered.has(id)) {
        rendered.add(id);
        bodies[id](hosts.get(id).body);
      }
      renderStepper();
    }

    function refreshAll() {
      steps = computeSteps(branchRow, { postingDisabled });
      renderHeader();
      renderKpis();
      for (const s of steps) renderHead(s);
      renderStepper();
      if (exceptionsSummaryEl) exceptionsSummaryEl.textContent = exceptionsSummaryText();
    }

    // ---- side rail: exceptions + activity (collapsed, rendered on first open) ----
    function exceptionsSummaryText() {
      return `Exceptions for this branch (${n(branchRow?.open_exception_count)} open)`;
    }

    function lazyDetails(summaryNode, render) {
      const body = el('div');
      const details = el('details', { class: 'collapsible card' }, [summaryNode, body]);
      let done = false;
      details.addEventListener('toggle', () => {
        if (details.open && !done) {
          done = true;
          render(body);
        }
      });
      return details;
    }

    exceptionsSummaryEl = el('summary', {}, exceptionsSummaryText());
    exceptionsDetails = lazyDetails(exceptionsSummaryEl, (body) => legacy.renderExceptionsSection(body, { branch, locked: true }));
    auditDetails = lazyDetails(el('summary', {}, 'Activity'), (body) => legacy.renderAuditSection(body, { branch, locked: true }));
    rail.appendChild(exceptionsDetails);
    rail.appendChild(auditDetails);

    // ---- first paint ----
    refreshAll();
    selectStep(selectedId);
  }

  window.App.registerRoute('/branches/:code', renderBranchWorkspace);
})();
