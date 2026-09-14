// In-memory Store for tests: identical to sqlite.js, forced to ':memory:'.
// See CONTRACTS.md §S.
import { openStore as openSqliteStore } from './sqlite.js';

export async function openStore(opts = {}) {
  return openSqliteStore({ ...opts, path: ':memory:' });
}

export { UniqueViolationError, TableNotAllowedError, ColumnNotAllowedError, RawSqlNotReadOnlyError, RowNotFoundError } from './sqlite.js';
