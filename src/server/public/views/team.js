// Team & Assignments (#/team). Full user management + assignment creation for admin;
// approvers/viewers/operators get a read-only assignments list and workload card
// (per task spec — the nav item itself is admin-only, see app.js renderNav(), but a
// direct link should still degrade gracefully rather than 403 the whole page).
'use strict';

(function () {
  const { api, el, chip, renderDataTable, showError, notAvailableNote, toast } = window.App;

  const ROLES = ['viewer', 'operator', 'approver', 'admin'];
  const PRINCIPAL_TYPES = ['human', 'bot'];
  const PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'];
  // The assignment status enum/transition table is not spelled out in the task contract
  // (only the POST .../status {status, version} shape is) — these are the plausible
  // lifecycle states offered in the UI; the server is the sole source of truth and any
  // rejected transition surfaces as a toast rather than being silently disallowed here.
  // Mirrors src/core/assignments.js ASSIGNMENT_TRANSITIONS (the server is authoritative;
  // ON_HOLD resumes to the state it was paused from, so every forward state is offered).
  const ASSIGNMENT_TRANSITIONS = {
    UNASSIGNED: ['ASSIGNED', 'ON_HOLD'],
    ASSIGNED: ['IN_PROGRESS', 'ON_HOLD'],
    IN_PROGRESS: ['READY_FOR_APPROVAL', 'ON_HOLD'],
    READY_FOR_APPROVAL: ['APPROVED', 'ON_HOLD'],
    APPROVED: ['DONE', 'ON_HOLD'],
    ON_HOLD: ['ASSIGNED', 'IN_PROGRESS', 'READY_FOR_APPROVAL', 'APPROVED'],
    DONE: [],
  };
  const nextStatesFor = (status) => ASSIGNMENT_TRANSITIONS[status] ?? [];

  function branchesToText(branches) {
    return Array.isArray(branches) ? branches.join(', ') : '';
  }
  function textToBranches(text) {
    const t = text.trim();
    if (t === '*') return ['*'];
    return t.split(',').map((s) => s.trim()).filter(Boolean);
  }

  function showTokenModal(title, token) {
    const overlay = el('div', { class: 'modal-overlay' });
    const box = el('div', { class: 'modal-box' }, [
      el('h3', {}, title),
      el('p', { class: 'muted' }, 'This token is shown once and cannot be retrieved again. Store it now.'),
      el('pre', { class: 'json token-reveal' }, token),
      el('div', { class: 'controls' }, [
        el('button', {
          onclick: async () => {
            try {
              await navigator.clipboard.writeText(token);
              toast('Token copied to clipboard.', 'success');
            } catch {
              toast('Could not copy automatically — select and copy the text manually.', 'error');
            }
          },
        }, 'Copy'),
        el('button', { onclick: () => overlay.remove() }, 'Close'),
      ]),
    ]);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
  }

  // ---------------------------------------------------------------- workload

  async function renderWorkloadCard(container) {
    container.innerHTML = '';
    container.appendChild(el('h3', {}, 'Workload'));
    const host = el('div', { class: 'tablewrap' });
    container.appendChild(host);
    let data;
    try {
      data = await api('/api/admin/workload');
    } catch (err) {
      if (err.status === 404 || err.status === 501) return notAvailableNote(host, 'Workload API is not available yet.');
      return showError(host, err);
    }
    renderDataTable(host, data.workload, [
      { key: 'id', label: 'User', render: (r) => r.id },
      { key: 'role', label: 'Role', render: (r) => chip(r.role, r.role) },
      { key: 'operator', label: 'As operator', render: (r) => Object.entries(r.assignedAsOperator?.byStatus ?? {}).map(([k, v]) => `${k}=${v}`).join(', ') || '—' },
      { key: 'approver', label: 'As approver', render: (r) => Object.entries(r.assignedAsApprover?.byStatus ?? {}).map(([k, v]) => `${k}=${v}`).join(', ') || '—' },
      { key: 'openTotal', label: 'Open total', render: (r) => String(r.openTotal ?? 0) },
    ], { empty: 'No workload data.' });
  }

  // ---------------------------------------------------------------- users (admin only)

  async function renderUsersCard(container, onUsersChanged) {
    container.innerHTML = '';
    container.appendChild(el('h3', {}, 'Users'));
    const host = el('div', { class: 'tablewrap' });
    const inviteForm = el('div', { class: 'controls' });
    container.appendChild(inviteForm);
    container.appendChild(host);

    let users = [];

    async function load() {
      try {
        const data = await api('/api/admin/users');
        users = data.users ?? [];
      } catch (err) {
        if (err.status === 404 || err.status === 501) {
          notAvailableNote(host, 'User admin API is not available yet.');
          return;
        }
        return showError(host, err);
      }
      renderDataTable(host, users, [
        { key: 'id', label: 'Id', render: (r) => r.id },
        { key: 'email', label: 'Email', render: (r) => r.email || '—' },
        { key: 'display_name', label: 'Name', render: (r) => r.display_name || '—' },
        {
          key: 'role',
          label: 'Role',
          render: (r) => {
            if (r.source === 'config') return chip(r.role, r.role);
            const sel = el('select', {}, ROLES.map((ro) => el('option', { value: ro, selected: ro === r.role ? '' : null }, ro)));
            sel.value = r.role;
            sel.addEventListener('change', () => patchUser(r, { role: sel.value }));
            return sel;
          },
        },
        { key: 'principal_type', label: 'Type', render: (r) => r.principal_type },
        {
          key: 'branches',
          label: 'Branches',
          render: (r) => {
            if (r.source === 'config') return branchesToText(r.branches);
            const input = el('input', { value: branchesToText(r.branches) });
            input.addEventListener('change', () => patchUser(r, { branches: textToBranches(input.value) }));
            return input;
          },
        },
        { key: 'status', label: 'Status', render: (r) => chip(r.status, r.status) },
        { key: 'source', label: 'Source', render: (r) => r.source },
        { key: 'last_login_at', label: 'Last login', render: (r) => r.last_login_at || '—' },
        {
          key: 'actions',
          label: 'Actions',
          render: (r) => {
            if (r.source === 'config') return el('span', { class: 'muted' }, 'read-only (config)');
            const wrap = el('div', { class: 'actions' });
            wrap.appendChild(
              el('button', {
                onclick: () => patchUser(r, { status: r.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE' }),
              }, r.status === 'ACTIVE' ? 'Deactivate' : 'Activate')
            );
            if (r.principal_type === 'bot') {
              wrap.appendChild(
                el('button', {
                  onclick: async () => {
                    try {
                      const result = await api(`/api/admin/users/${encodeURIComponent(r.id)}/rotate-token`, { method: 'POST', body: {} });
                      showTokenModal(`New token for ${r.id}`, result.token);
                    } catch (err) {
                      toast(err.message, 'error');
                    }
                  },
                }, 'Rotate token')
              );
            }
            return wrap;
          },
        },
      ], { empty: 'No users.' });
    }

    async function patchUser(row, patch) {
      try {
        await api(`/api/admin/users/${encodeURIComponent(row.id)}`, { method: 'PATCH', body: { ...patch, version: row.version } });
        toast(`${row.id} updated.`, 'success');
        await load();
        if (onUsersChanged) onUsersChanged(users);
      } catch (err) {
        if (err.status === 409 && err.body?.error === 'VERSION_CONFLICT') {
          toast(`${row.id} was changed by someone else — reloading.`, 'error');
        } else if (err.status === 409 && err.body?.error === 'CONFIG_USER_READONLY') {
          toast(`${row.id} is defined in config and cannot be edited here.`, 'error');
        } else {
          toast(err.message, 'error');
        }
        await load();
      }
    }

    const emailInput = el('input', { placeholder: 'email' });
    const nameInput = el('input', { placeholder: 'display name' });
    const roleSelect = el('select', {}, ROLES.map((r) => el('option', {}, r)));
    const typeSelect = el('select', {}, PRINCIPAL_TYPES.map((t) => el('option', {}, t)));
    const branchesInput = el('input', { placeholder: 'PILOT01, PILOT02 or *' });
    inviteForm.appendChild(el('label', {}, ['Email', emailInput]));
    inviteForm.appendChild(el('label', {}, ['Name', nameInput]));
    inviteForm.appendChild(el('label', {}, ['Role', roleSelect]));
    inviteForm.appendChild(el('label', {}, ['Type', typeSelect]));
    inviteForm.appendChild(el('label', {}, ['Branches', branchesInput]));
    inviteForm.appendChild(
      el('button', {
        onclick: async () => {
          try {
            const result = await api('/api/admin/users', {
              method: 'POST',
              body: {
                email: emailInput.value.trim(),
                display_name: nameInput.value.trim(),
                role: roleSelect.value,
                principal_type: typeSelect.value,
                branches: textToBranches(branchesInput.value),
              },
            });
            if (result.token) showTokenModal(`Token for ${result.user?.id ?? emailInput.value}`, result.token);
            emailInput.value = '';
            nameInput.value = '';
            branchesInput.value = '';
            await load();
            if (onUsersChanged) onUsersChanged(users);
          } catch (err) {
            toast(err.message, 'error');
          }
        },
      }, 'Add / invite user')
    );

    await load();
    return { getUsers: () => users, reload: load };
  }

  // ---------------------------------------------------------------- assignments

  function historyDrawer(assignmentId) {
    const overlay = el('div', { class: 'modal-overlay' });
    const body = el('div', { class: 'tablewrap' }, 'Loading…');
    const box = el('div', { class: 'modal-box modal-wide' }, [
      el('h3', {}, `History — assignment ${assignmentId}`),
      body,
      el('div', { class: 'controls' }, [el('button', { onclick: () => overlay.remove() }, 'Close')]),
    ]);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    (async () => {
      try {
        const { history } = await api(`/api/assignments/${encodeURIComponent(assignmentId)}/history`);
        renderDataTable(body, history, [
          { key: 'created_at', label: 'When', render: (r) => r.created_at },
          { key: 'actor', label: 'Actor', render: (r) => r.actor },
          { key: 'action', label: 'Action', render: (r) => r.action },
          { key: 'reason', label: 'Reason', render: (r) => (typeof r.reason === 'object' ? r.reason?.value : r.reason) || '—' },
        ], { empty: 'No history yet.' });
      } catch (err) {
        if (err.status === 404 || err.status === 501) notAvailableNote(body, 'History API is not available yet.');
        else showError(body, err);
      }
    })();
  }

  function reassignModal(row, onDone) {
    const overlay = el('div', { class: 'modal-overlay' });
    const operatorInput = el('input', { value: row.assigned_operator || '' });
    const approverInput = el('input', { value: row.assigned_approver || '' });
    const reasonInput = el('input', { placeholder: 'required' });
    const errorP = el('p', { class: 'muted error-text' }, '');
    const box = el('div', { class: 'modal-box' }, [
      el('h3', {}, `Reassign — ${row.branch_code} / ${row.period}`),
      el('div', { class: 'controls' }, [
        el('label', {}, ['Operator', operatorInput]),
        el('label', {}, ['Approver', approverInput]),
        el('label', {}, ['Reason (required)', reasonInput]),
      ]),
      errorP,
      el('div', { class: 'controls' }, [
        el('button', {
          onclick: async () => {
            if (!reasonInput.value.trim()) {
              errorP.textContent = 'A reason is required.';
              return;
            }
            try {
              await api(`/api/assignments/${row.id}/reassign`, {
                method: 'POST',
                body: {
                  assigned_operator: operatorInput.value.trim() || undefined,
                  assigned_approver: approverInput.value.trim() || undefined,
                  reason: reasonInput.value.trim(),
                  version: row.version,
                },
              });
              overlay.remove();
              onDone();
            } catch (err) {
              errorP.textContent = err.message;
            }
          },
        }, 'Reassign'),
        el('button', { onclick: () => overlay.remove() }, 'Cancel'),
      ]),
    ]);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
  }

  async function renderAssignmentsCard(container, { isAdmin, users }) {
    container.innerHTML = '';
    container.appendChild(el('h3', {}, 'Assignments'));

    const filters = { branch: '', period: '', operator: '', approver: '', status: '' };
    const branchInput = el('input', { placeholder: 'branch code' });
    const periodInput = el('input', { placeholder: 'YYYY-MM' });
    const operatorInput = el('input', { placeholder: 'operator' });
    const approverInput = el('input', { placeholder: 'approver' });
    const statusInput = el('input', { placeholder: 'status' });
    const host = el('div', { class: 'tablewrap' });

    async function load() {
      const params = new URLSearchParams();
      if (branchInput.value.trim()) params.set('branch', branchInput.value.trim());
      if (periodInput.value.trim()) params.set('period', periodInput.value.trim());
      if (operatorInput.value.trim()) params.set('operator', operatorInput.value.trim());
      if (approverInput.value.trim()) params.set('approver', approverInput.value.trim());
      if (statusInput.value.trim()) params.set('status', statusInput.value.trim());
      let data;
      try {
        data = await api(`/api/assignments?${params.toString()}`);
      } catch (err) {
        if (err.status === 404 || err.status === 501) return notAvailableNote(host, 'Assignments API is not available yet.');
        return showError(host, err);
      }
      const columns = [
        { key: 'branch_code', label: 'Branch', render: (r) => r.branch_code },
        { key: 'period', label: 'Period', render: (r) => r.period },
        { key: 'transaction_class', label: 'Class', render: (r) => r.transaction_class || '*' },
        { key: 'assigned_operator', label: 'Operator', render: (r) => r.assigned_operator },
        { key: 'assigned_approver', label: 'Approver', render: (r) => r.assigned_approver },
        { key: 'status', label: 'Status', render: (r) => chip(r.status, r.status) },
        { key: 'priority', label: 'Priority', render: (r) => r.priority },
        { key: 'due_at', label: 'Due', render: (r) => r.due_at || '—' },
        { key: 'assigned_by', label: 'Assigned by', render: (r) => r.assigned_by || '—' },
        {
          key: 'history',
          label: 'History',
          render: (r) => el('button', { class: 'linklike', onclick: () => historyDrawer(r.id) }, 'View'),
        },
      ];
      if (isAdmin) {
        columns.push({
          key: 'actions',
          label: 'Actions',
          render: (r) => {
            const wrap = el('div', { class: 'actions' });
            wrap.appendChild(el('button', { onclick: () => reassignModal(r, load) }, 'Reassign'));
            const nextStates = nextStatesFor(r.status);
            const statusSelect = el('select', { disabled: nextStates.length ? undefined : 'disabled' }, nextStates.map((s) => el('option', {}, s)));
            wrap.appendChild(statusSelect);
            wrap.appendChild(
              el('button', {
                onclick: async () => {
                  try {
                    await api(`/api/assignments/${r.id}/status`, { method: 'POST', body: { status: statusSelect.value, version: r.version } });
                    toast('Status updated.', 'success');
                    load();
                  } catch (err) {
                    toast(err.message, 'error');
                  }
                },
              }, 'Set status')
            );
            return wrap;
          },
        });
      }
      renderDataTable(host, data.assignments, columns, { empty: 'No assignments match these filters.' });
    }

    const filterBar = el('div', { class: 'controls' }, [
      el('label', {}, ['Branch', branchInput]),
      el('label', {}, ['Period', periodInput]),
      el('label', {}, ['Operator', operatorInput]),
      el('label', {}, ['Approver', approverInput]),
      el('label', {}, ['Status', statusInput]),
      el('button', { onclick: load }, 'Filter'),
    ]);
    container.appendChild(filterBar);

    if (isAdmin) {
      const newBranch = el('input', { placeholder: 'branch code' });
      const newPeriod = el('input', { placeholder: 'YYYY-MM' });
      const newClass = el('input', { placeholder: '*', value: '*' });
      const operatorOptions = () => (users ?? []).filter((u) => ['operator', 'admin'].includes(u.role)).map((u) => el('option', {}, u.id));
      const approverOptions = () => (users ?? []).filter((u) => ['approver', 'admin'].includes(u.role)).map((u) => el('option', {}, u.id));
      const newOperator = el('select', {}, operatorOptions());
      const newApprover = el('select', {}, approverOptions());
      const newPriority = el('select', {}, PRIORITIES.map((p) => el('option', { selected: p === 'NORMAL' ? '' : null }, p)));
      newPriority.value = 'NORMAL';
      const newDue = el('input', { type: 'date' });
      const newForm = el('div', { class: 'controls' }, [
        el('label', {}, ['Branch', newBranch]),
        el('label', {}, ['Period', newPeriod]),
        el('label', {}, ['Class', newClass]),
        el('label', {}, ['Operator', newOperator]),
        el('label', {}, ['Approver', newApprover]),
        el('label', {}, ['Priority', newPriority]),
        el('label', {}, ['Due', newDue]),
        el('button', {
          onclick: async () => {
            try {
              await api('/api/assignments', {
                method: 'POST',
                body: {
                  branch_code: newBranch.value.trim(),
                  period: newPeriod.value.trim(),
                  transaction_class: newClass.value.trim() || '*',
                  assigned_operator: newOperator.value,
                  assigned_approver: newApprover.value,
                  priority: newPriority.value,
                  due_at: newDue.value || undefined,
                },
              });
              toast('Assignment created.', 'success');
              newBranch.value = '';
              newPeriod.value = '';
              load();
            } catch (err) {
              if (err.status === 409 && err.body?.error === 'SOD_VIOLATION') toast('Operator and approver must differ (segregation of duties).', 'error');
              else if (err.status === 409 && err.body?.error === 'UNIQUE_VIOLATION') toast('An assignment already exists for that branch/period/class.', 'error');
              else toast(err.message, 'error');
            }
          },
        }, 'New assignment'),
      ]);
      container.appendChild(newForm);
    }

    container.appendChild(host);
    await load();
  }

  // ---------------------------------------------------------------- page

  async function renderTeamPage(container) {
    const isAdmin = window.App.isAdmin();
    container.appendChild(el('h2', {}, 'Team & Assignments'));
    if (!isAdmin) {
      container.appendChild(el('p', { class: 'notice' }, 'Read-only view — user management and assignment changes require the admin role.'));
    }

    const workloadCard = el('section', { class: 'card' });
    container.appendChild(workloadCard);
    renderWorkloadCard(workloadCard);

    let users = [];
    if (isAdmin) {
      const usersCard = el('section', { class: 'card' });
      container.appendChild(usersCard);
      const handle = await renderUsersCard(usersCard, (u) => {
        users = u;
      });
      users = handle.getUsers();
    }

    const assignmentsCard = el('section', { class: 'card' });
    container.appendChild(assignmentsCard);
    await renderAssignmentsCard(assignmentsCard, { isAdmin, users });
  }

  window.App.registerRoute('/team', renderTeamPage);
})();
