// Administration -> Connections -> Zoho Books (#/admin/connections/books, admin only).
// Never renders anything token-like — only status, org metadata, redacted errors and
// counts ever reach the DOM here.
'use strict';

(function () {
  const { api, el, notAvailableNote, showError, toast, replaceQuery } = window.App;

  // Zoho's exact regional data-center list is not part of this task's contract (only
  // `POST /api/admin/books/connect { region }` is specified) — this is the commonly
  // documented Books DC set; the server is authoritative and rejects an unknown region.
  const REGIONS = ['US', 'EU', 'IN', 'AU', 'JP', 'CA', 'UK', 'SA', 'CN'];

  const CONTROL_LABELS = {
    booksConnected: 'Books connected',
    organizationVerified: 'Organisation verified',
    locationsSynchronized: 'Locations synchronised',
    readOnlyAccessApproved: 'Read-only access approved',
    batchFinanciallyApproved: 'Batch financially approved',
    productionPostingEnabled: 'Production posting enabled',
};

  function controlRow(key, entry) {
    const ok = Boolean(entry?.ok);
    let mark;
    let extraClass = '';
    if (key === 'productionPostingEnabled' && !ok) {
      mark = el('span', { class: 'chip chip-red' }, 'DISABLED (expected)');
    } else {
      mark = el('span', { class: `chip ${ok ? 'chip-green' : 'chip-red'}` }, ok ? '✓' : '✗');
      extraClass = ok ? '' : ' control-row-bad';
    }
    return el('div', { class: `control-row${extraClass}` }, [
      mark,
      el('span', { class: 'control-label' }, CONTROL_LABELS[key] || key),
      el('span', { class: 'muted' }, entry?.detail || ''),
    ]);
  }

  function statusBadgeClass(status) {
    if (status === 'CONNECTED') return 'chip-green';
    if (status === 'ERROR' || status === 'DISCONNECTED') return 'chip-red';
    if (status === 'PENDING_AUTH') return 'chip-amber';
    return 'chip-grey'; // NOT_CONNECTED
  }

  async function renderConnectionCard(container, refreshAll) {
    container.innerHTML = '';
    let data;
    try {
      data = await api('/api/admin/books/connection');
    } catch (err) {
      if (err.status === 404 || err.status === 501) {
        notAvailableNote(container, 'Zoho Books connection API is not available yet.');
        return null;
      }
      showError(container, err);
      return null;
    }

    container.appendChild(
      el('div', { class: 'controls' }, [
        el('span', { class: `chip ${statusBadgeClass(data.status)} chip-big` }, data.status),
        el('span', {}, data.org ? `${data.org.name} (${data.org.region}, ${data.org.apiDomain})` : 'No organisation connected'),
      ])
    );

    const kv = el('div', { class: 'kv' }, [
      el('span', {}, [el('b', {}, 'Connected by: '), data.connectedBy || '—']),
      el('span', {}, [el('b', {}, 'Connected at: '), data.connectedAt || '—']),
      el('span', {}, [el('b', {}, 'Last successful call: '), data.lastSuccessAt || '—']),
      el('span', {}, [el('b', {}, 'Locations synced at: '), data.locationsSyncedAt || '—']),
      el('span', {}, [el('b', {}, 'Read authorized: '), data.readAuthorized ? 'yes' : 'no']),
      el('span', {}, [el('b', {}, 'Driver: '), data.driver || '—']),
      el('span', {}, [el('b', {}, 'Token refresh status: '), data.tokenRefreshStatus || '—']),
      el('span', {}, [el('b', {}, 'Token expires at: '), data.tokenExpiresAt || '—']),
      el('span', {}, [
        el('b', {}, 'API limit: '),
        data.apiLimit ? `${data.apiLimit.remaining}/${data.apiLimit.limit} (resets ${data.apiLimit.resetAt})` : '—',
      ]),
    ]);
    container.appendChild(kv);

    if (data.lastErrorRedacted) {
      container.appendChild(el('p', { class: 'muted error-text' }, `Last error: ${data.lastErrorRedacted}`));
    }

    if (data.secretsConfigured) {
      container.appendChild(
        el('div', { class: 'controls' }, [
          el('span', { class: 'muted' }, 'Secrets configured: '),
          el('span', { class: `chip ${data.secretsConfigured.clientId ? 'chip-green' : 'chip-red'}` }, `client id ${data.secretsConfigured.clientId ? 'ok' : 'missing'}`),
          el('span', { class: `chip ${data.secretsConfigured.clientSecret ? 'chip-green' : 'chip-red'}` }, `client secret ${data.secretsConfigured.clientSecret ? 'ok' : 'missing'}`),
          el('span', { class: `chip ${data.secretsConfigured.secretKey ? 'chip-green' : 'chip-red'}` }, `secret key ${data.secretsConfigured.secretKey ? 'ok' : 'missing'}`),
        ])
      );
    }

    const controlsWrap = el('div', { class: 'controls-checklist' });
    for (const key of Object.keys(CONTROL_LABELS)) {
      controlsWrap.appendChild(controlRow(key, data.controls?.[key]));
    }
    container.appendChild(controlsWrap);

    const regionSelect = el('select', {}, REGIONS.map((r) => el('option', {}, r)));
    const actions = el('div', { class: 'controls' }, [
      el('label', {}, ['Region', regionSelect]),
      el('button', {
        onclick: async () => {
          try {
            const result = await api('/api/admin/books/connect', { method: 'POST', body: { region: regionSelect.value } });
            if (result.authorizeUrl) window.location.href = result.authorizeUrl;
          } catch (err) {
            toast(err.message, 'error');
          }
        },
      }, 'Connect Zoho Books'),
      el('button', {
        onclick: async () => {
          try {
            await api('/api/admin/books/test', { method: 'POST', body: {} });
            toast('Connection test passed (read-only).', 'success');
          } catch (err) {
            toast(`Connection test failed: ${err.message}`, 'error');
          }
          refreshAll();
        },
      }, 'Test connection (read-only)'),
      el('button', {
        onclick: async () => {
          try {
            await api('/api/admin/books/sync-locations', { method: 'POST', body: {} });
            toast('Locations synced.', 'success');
          } catch (err) {
            toast(err.message, 'error');
          }
          refreshAll();
        },
      }, 'Sync locations'),
      el('button', {
        onclick: async () => {
          const reason = prompt('Reason for disconnecting / re-authorizing?') || '';
          try {
            await api('/api/admin/books/disconnect', { method: 'POST', body: { reason } });
            toast('Disconnected.', 'success');
          } catch (err) {
            toast(err.message, 'error');
          }
          refreshAll();
        },
      }, 'Disconnect / Re-authorize'),
    ]);
    container.appendChild(actions);
    return data;
  }

  async function renderLocationsCard(container) {
    container.innerHTML = '';
    container.appendChild(el('h3', {}, 'Books locations'));
    const host = el('div', { class: 'tablewrap' });
    container.appendChild(host);
    let locations;
    try {
      ({ locations } = await api('/api/admin/books/locations'));
    } catch (err) {
      if (err.status === 404 || err.status === 501) return notAvailableNote(host, 'Locations API is not available yet.');
      return showError(host, err);
    }

    const mappingInputs = new Map();
    window.App.renderDataTable(host, locations, [
      { key: 'location_id', label: 'Location id', render: (r) => r.location_id },
      { key: 'location_name', label: 'Location name', render: (r) => r.location_name },
      { key: 'status', label: 'Status', render: (r) => window.App.chip(r.status) },
      { key: 'is_synthetic', label: 'Synthetic', render: (r) => (r.is_synthetic ? el('span', { class: 'badge badge-warn' }, 'SYNTHETIC') : '') },
      {
        key: 'branch_code',
        label: 'Branch code mapping',
        render: (r) => {
          const input = el('input', { value: r.branch_code || '', placeholder: 'branch code' });
          mappingInputs.set(r.location_id, input);
          return input;
        },
      },
    ], { empty: 'No locations found. Try "Sync locations" above.' });

    container.appendChild(
      el('div', { class: 'controls' }, [
        el('button', {
          onclick: async () => {
            const mappings = [...mappingInputs.entries()]
              .map(([location_id, input]) => ({ location_id, branch_code: input.value.trim() }))
              .filter((m) => m.branch_code);
            try {
              await api('/api/admin/books/location-mapping', { method: 'PUT', body: { mappings } });
              toast('Mapping saved.', 'success');
            } catch (err) {
              toast(err.message, 'error');
            }
          },
        }, 'Save mapping'),
      ])
    );
  }

  async function renderAdminBooksPage(container, params, query) {
    container.appendChild(el('h2', {}, 'Administration — Connections — Zoho Books'));

    if (query.connected === '1') toast('Zoho Books connected.', 'success');
    if (query.error) toast(`Connection error: ${query.error}`, 'error');
    if (query.connected || query.error) {
      // Don't leave the one-shot toast params in the URL.
      const { connected, error, ...rest } = query;
      replaceQuery('/admin/connections/books', rest);
    }

    const connectionCard = el('section', { class: 'card' });
    const locationsCard = el('section', { class: 'card' });
    container.appendChild(connectionCard);
    container.appendChild(locationsCard);

    const refreshAll = () => {
      renderConnectionCard(connectionCard, refreshAll);
      renderLocationsCard(locationsCard);
    };
    await renderConnectionCard(connectionCard, refreshAll);
    await renderLocationsCard(locationsCard);
  }

  window.App.registerRoute('/admin/connections/books', renderAdminBooksPage, { roles: ['admin'] });
})();
