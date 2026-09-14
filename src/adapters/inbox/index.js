// Inbox adapter dispatcher. See CONTRACTS.md §I.
export async function openInbox({ adapter = process.env.INBOX_ADAPTER ?? 'local', ...opts } = {}) {
  switch (adapter) {
    case 'local': {
      const mod = await import('./local.js');
      return mod.openInbox(opts);
    }
    case 'workdrive': {
      const mod = await import('./workdrive.js');
      return mod.openInbox(opts);
    }
    default: {
      const err = new Error(`Unknown inbox adapter: ${adapter}`);
      err.code = 'UNKNOWN_ADAPTER';
      throw err;
    }
  }
}
