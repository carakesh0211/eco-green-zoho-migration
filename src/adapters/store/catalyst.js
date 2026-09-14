// Catalyst Data Store adapter — documented stub. See CONTRACTS.md §S.
//
// Not implemented in this pilot. When wiring a real Catalyst Data Store adapter,
// port the shape used by the Tally tool's `server/src/data/catalyst/*` modules:
// a thin wrapper around the Catalyst Node SDK's `datastore()` service that
// translates the same Store interface (insert/insertMany/update/get/findOne/
// find/count/raw/transaction/claim/releaseClaim/close) onto ZCQL + row APIs.
//
// The important structural difference from sqlite.js: Catalyst Data Store has
// no composite/multi-column UNIQUE index. Every table in schema.sql that needs
// a composite uniqueness guarantee therefore also carries a synthetic single
// column `uk` (pipe-joined parts) with its own single-column UNIQUE — the
// Catalyst adapter would enforce uniqueness through `uk` alone (mirroring the
// sqlite adapter's UniqueViolationError shape, parsed from the Data Store
// duplicate-value error instead of a SQLite message). `store.claim()` is the
// other structurally interesting piece to port: Catalyst Data Store has no
// `UPDATE ... RETURNING`, so a real implementation needs either a stored
// procedure / function equivalent or an update-then-verify-by-re-read pattern
// guarded by a per-row optimistic-lock column, since a naive read-then-write
// reintroduces the race this contract explicitly forbids.
export async function openStore() {
  throw new NotImplementedError(
    'Catalyst Data Store adapter is not implemented in this pilot. ' +
      'Use STORE_ADAPTER=sqlite (default) or STORE_ADAPTER=memory in tests. ' +
      'See src/adapters/store/catalyst.js for the porting notes (Tally tool ' +
      'server/src/data/catalyst/* pattern; no composite unique index, hence uk columns).'
  );
}

export class NotImplementedError extends Error {
  constructor(message) {
    super(message);
    this.code = 'NOT_IMPLEMENTED';
  }
}
