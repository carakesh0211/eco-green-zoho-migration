// Zoho WorkDrive inbox adapter — documented stub. See CONTRACTS.md §I.
// Real implementation needs (document here until WORKDRIVE_INGESTION.md is written):
//   - OAuth refresh-token flow against WORKDRIVE_CLIENT_ID/SECRET/REFRESH_TOKEN
//     (same shape as src/books/live.js's Books OAuth flow).
//   - `GET /workdrive/api/v1/files/<WORKDRIVE_FOLDER_ID>/files` to list branch/run
//     subfolders, recursively, to find complete runs (manifest.json + listed files).
//   - `GET /workdrive/api/v1/download/<file_id>` to stream file bytes for readFile().
//   - A durable "picked" marker: WorkDrive has no atomic rename primitive exposed the
//     way a local filesystem does, so markPicked() would need either a small marker
//     file uploaded into the run folder (accepting a race window) or an external
//     durable claim (e.g. the extraction_runs.inbox_ref + status in the Store, which
//     is already idempotent via UNIQUE(manifest_sha256)).

const REQUIRED_ENV_VARS = ['WORKDRIVE_FOLDER_ID', 'WORKDRIVE_CLIENT_ID', 'WORKDRIVE_CLIENT_SECRET', 'WORKDRIVE_REFRESH_TOKEN'];

export class NotConfiguredError extends Error {
  constructor(missing) {
    super(`WorkDrive inbox adapter is not configured; missing env vars: ${missing.join(', ')}`);
    this.code = 'NOT_CONFIGURED';
    this.missing = missing;
  }
}

export class NotImplementedError extends Error {
  constructor(message) {
    super(message);
    this.code = 'NOT_IMPLEMENTED';
  }
}

export async function openInbox(opts = {}) {
  const env = opts.env ?? process.env;
  const missing = REQUIRED_ENV_VARS.filter((key) => !env[key]);
  if (missing.length > 0) throw new NotConfiguredError(missing);

  const stub = () => {
    throw new NotImplementedError(
      'WorkDrive inbox adapter is configured but not implemented in this pilot. ' +
        'See src/adapters/inbox/workdrive.js for the required Zoho WorkDrive API calls.'
    );
  };

  return {
    async listRuns() {
      return stub();
    },
    async readFile() {
      return stub();
    },
    async markPicked() {
      return stub();
    },
  };
}
