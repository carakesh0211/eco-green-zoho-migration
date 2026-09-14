// Archive adapter dispatcher. See CONTRACTS.md §R.
export async function openArchive({ adapter = process.env.ARCHIVE_ADAPTER ?? 'local', ...opts } = {}) {
  switch (adapter) {
    case 'local': {
      const mod = await import('./local.js');
      return mod.openArchive(opts);
    }
    case 'stratus': {
      const mod = await import('./stratus.js');
      return mod.openArchive(opts);
    }
    case 'disabled': {
      const mod = await import('./disabled.js');
      return mod.openArchive(opts);
    }
    default: {
      const err = new Error(`Unknown archive adapter: ${adapter}`);
      err.code = 'UNKNOWN_ADAPTER';
      throw err;
    }
  }
}

export { ImmutableConflictError, ArchiveShaMismatchError, InvalidArchiveUriError } from './local.js';
