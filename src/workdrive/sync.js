// WorkDrive branch inbox: which uploaded files are a branch's extract, what is new since the last
// pull, and the tracker row each branch gets. Pure functions; the REST calls are in client.js.
//
// Folder layout watched (any depth under the root): a folder named by its branch code (e.g.
// "461") holds that branch's files as delivered:
//   Ledger_<from>_to_<to> V2.xlsx          (the highest version wins: V2 over V1 over none)
//   supplier_payment_details_act.csv
//   invoice_receipt_det_act_<br>.csv / .zip
//   Closing_tb_report_<to>.xlsx, opening_tb_report_<date>.xlsx
//   Customer and vendor_bill& invoice_TB-<...>.xlsx   (the opening open items)

export const BRANCH_FOLDER = /^\d{3,4}$/;

/** Kind of a branch file, or null for anything else (rule books, exception lists, notes). */
export function fileKind(name) {
  const n = String(name).toLowerCase();
  if (/^ledger.*\.xlsx$/.test(n)) return 'ledger';
  if (/^supplier_payment.*\.csv$/.test(n)) return 'supplier';
  if (/^invoice_receipt.*\.(csv|zip)$/.test(n)) return 'customer';
  if (/^closing_tb.*\.xlsx$/.test(n)) return 'closingTb';
  if (/^opening_tb.*\.xlsx$/.test(n)) return 'openingTb';
  if (/bill.*invoice.*\.xlsx$|invoice.*bill.*\.xlsx$/.test(n)) return 'openingItems';
  return null;
}

const version = (name) => Number(/\bv(\d+)\b/i.exec(name)?.[1] ?? 0);

/**
 * The file used for each kind in a branch folder: the ledger with the highest version, a .csv
 * over a .zip of the same settlements, otherwise the most recently modified.
 */
export function pickFiles(files) {
  const out = {};
  for (const f of files) {
    const kind = fileKind(f.name);
    if (!kind || f.isFolder) continue;
    const cur = out[kind];
    const better = !cur
      || (kind === 'ledger' && version(f.name) !== version(cur.name) ? version(f.name) > version(cur.name)
        : kind === 'customer' && /\.csv$/i.test(f.name) !== /\.csv$/i.test(cur.name) ? /\.csv$/i.test(f.name)
          : f.modified > cur.modified);
    if (better) out[kind] = f;
  }
  return out;
}

/** Where a pulled file lands locally (names branch-ready.js and txn-plan.js expect). */
export function localName(branch, kind) {
  return {
    ledger: `var/raw${branch}/txn/ledger_v2.xlsx`,
    supplier: `var/raw${branch}/txn/supplier_payment_details_act.csv`,
    customer: `var/raw${branch}/txn/invoice_receipt_det_act_${branch}.csv`, // a .zip is unpacked to it
    closingTb: `var/raw${branch}/txn/closing_tb.xlsx`,
    openingTb: `var/raw${branch}/txn/opening_tb.xlsx`,
    openingItems: `var/raw${branch}/opening/opening_items.xlsx`,
  }[kind];
}

/** Files to download: new resources, or ones changed (modified time or size) since the last pull. */
export function toPull(branches, state) {
  const out = [];
  for (const b of branches) {
    for (const [kind, f] of Object.entries(b.picked)) {
      const seen = state.files?.[f.id];
      if (!seen || seen.modified !== f.modified || seen.size !== f.size || seen.kind !== kind) {
        out.push({ branch: b.branch, kind, file: f, path: localName(b.branch, kind) });
      }
    }
  }
  return out;
}

export const REQUIRED = ['ledger', 'supplier', 'customer', 'closingTb'];

// The migration window when a branch's ledger name does not carry one (Tripura's cut-off).
export const DEFAULT_WINDOW = { from: '2026-04-01', to: '2026-07-05' };

/**
 * The migration window a ledger covers, from its name as Eco Green delivers it
 * ("Ledger_01042026_to_05082026 V1.xlsx": 2026-04-01 to 2026-08-05), or null. Branches cut over
 * on different dates (Tripura 05-07-2026, Bengaluru 05-08-2026), so each is planned on its own.
 */
export function ledgerWindow(name) {
  const m = /(\d{2})(\d{2})(\d{4})_to_(\d{2})(\d{2})(\d{4})/i.exec(String(name ?? ''));
  if (!m) return null;
  const from = `${m[3]}-${m[2]}-${m[1]}`, to = `${m[6]}-${m[5]}-${m[4]}`;
  return from <= to ? { from, to } : null;
}

/** One tracker row per branch folder. */
export function trackerRow(b, readiness, state, now) {
  const p = b.picked;
  const missing = [...REQUIRED, 'openingItems'].filter((k) => !p[k]);
  const r = readiness ?? {};
  const lastUpload = Math.max(0, ...Object.values(p).map((f) => f.modified));
  const w = p.ledger ? ledgerWindow(p.ledger.name) ?? DEFAULT_WINDOW : null;
  return {
    region: b.region, branch: b.branch,
    ledger: p.ledger?.name ?? '', window: w ? `${w.from} to ${w.to}` : '', files_received: Object.keys(p).length, missing_files: missing.join('; '),
    last_upload: lastUpload ? new Date(lastUpload).toISOString().replace('T', ' ').slice(0, 16) : '',
    pulled_at: state.branches?.[b.branch]?.pulledAt ?? '',
    status: !p.ledger ? 'WAITING FOR FILES'
      : r.status === 'WAITING FOR OPENING' && p.openingItems ? 'OPENING FILE RECEIVED' : r.status ?? 'NOT PLANNED',
    our_vouchers: r.ours ?? '', smart_pharma_vouchers: r.smartPharma ?? '',
    waiting_documents: r.waiting ?? '', problems: r.problems ?? '',
    checked_at: now,
  };
}
