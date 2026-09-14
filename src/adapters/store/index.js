// Store adapter dispatcher. See CONTRACTS.md §S.
export async function openStore({ adapter = process.env.STORE_ADAPTER ?? 'sqlite', ...opts } = {}) {
  switch (adapter) {
    case 'sqlite': {
      const mod = await import('./sqlite.js');
      return mod.openStore(opts);
    }
    case 'memory': {
      const mod = await import('./memory.js');
      return mod.openStore(opts);
    }
    case 'catalyst': {
      const mod = await import('./catalyst.js');
      return mod.openStore(opts);
    }
    default: {
      const err = new Error(`Unknown store adapter: ${adapter}`);
      err.code = 'UNKNOWN_ADAPTER';
      throw err;
    }
  }
}

export {
  UniqueViolationError,
  TableNotAllowedError,
  ColumnNotAllowedError,
  RawSqlNotReadOnlyError,
  RowNotFoundError,
} from './sqlite.js';
