// Zoho WorkDrive REST client (India DC by default): list a folder, download a file, upload a file
// over an existing one. OAuth refresh as for Books (src/books/oauth.js); tokens are never logged.
import { getAccessToken } from '../books/oauth.js';

export function workdriveConfig(env = process.env) {
  const need = (k, ...alt) => {
    const v = [k, ...alt].map((x) => env[x]).find(Boolean);
    if (!v) throw new Error(`${k} is not set`);
    return v;
  };
  return {
    apiBase: env.WORKDRIVE_API_BASE ?? 'https://www.zohoapis.in/workdrive/api/v1',
    accountsBase: env.WORKDRIVE_ACCOUNTS_BASE ?? env.BOOKS_ACCOUNTS_BASE ?? 'https://accounts.zoho.in',
    clientId: need('WORKDRIVE_CLIENT_ID', 'BOOKS_CLIENT_ID'),
    clientSecret: need('WORKDRIVE_CLIENT_SECRET', 'BOOKS_CLIENT_SECRET'),
    refreshToken: need('WORKDRIVE_REFRESH_TOKEN'),
    rootFolderId: need('WORKDRIVE_FOLDER_ID'),
    organizationId: 'workdrive', // token cache key only
    requestTimeoutMs: Number(env.WORKDRIVE_REQUEST_TIMEOUT_MS ?? 120_000),
  };
}

export function workdriveClient(config, { fetchImpl = fetch } = {}) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function request(url, init = {}, { binary = false } = {}) {
    for (let attempt = 1; ; attempt += 1) {
      const token = await getAccessToken(config, { fetchImpl });
      const res = await fetchImpl(url, {
        ...init,
        headers: { Authorization: `Zoho-oauthtoken ${token}`, Accept: 'application/vnd.api+json', ...(init.headers ?? {}) },
        signal: AbortSignal.timeout(config.requestTimeoutMs),
      });
      if ((res.status === 429 || res.status >= 500) && attempt < 5 && (init.method ?? 'GET') === 'GET') {
        await sleep(2000 * 2 ** attempt);
        continue;
      }
      if (!res.ok) {
        let msg = `http ${res.status}`;
        try { msg = (await res.json())?.errors?.[0]?.title ?? msg; } catch { /* not json */ }
        throw new Error(`WorkDrive ${init.method ?? 'GET'} ${new URL(url).pathname}: ${msg}`);
      }
      return binary ? Buffer.from(await res.arrayBuffer()) : res.json();
    }
  }
  return {
    /** Every item in a folder: { id, name, isFolder, modified, size, downloadUrl } */
    async list(folderId) {
      const out = [];
      for (let offset = 0; ; offset += 50) {
        const url = new URL(`${config.apiBase}/files/${folderId}/files`);
        url.searchParams.set('page[limit]', '50');
        url.searchParams.set('page[offset]', String(offset));
        const page = (await request(url)).data ?? [];
        for (const r of page) {
          const a = r.attributes ?? {};
          out.push({
            id: r.id, name: a.name, isFolder: Boolean(a.is_folder) || a.type === 'folder',
            modified: Number(a.modified_time_in_millisecond ?? 0), size: Number(a.storage_info?.size_in_bytes ?? 0),
            downloadUrl: a.download_url ?? null,
          });
        }
        if (page.length < 50) return out;
      }
    },
    async download(file) {
      return request(file.downloadUrl ?? `${config.apiBase}/download/${file.id}`, {}, { binary: true });
    },
    /** Upload (replacing a file of the same name) into a folder. */
    async upload(folderId, filename, content) {
      const url = new URL(`${config.apiBase}/upload`);
      url.searchParams.set('filename', filename);
      url.searchParams.set('parent_id', folderId);
      url.searchParams.set('override-name-exist', 'true');
      const form = new FormData();
      form.append('content', new Blob([content]), filename);
      return request(url, { method: 'POST', body: form });
    },
  };
}
