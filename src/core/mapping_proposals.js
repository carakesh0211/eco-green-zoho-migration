// Propose a Zoho Books mapping for a normalised Eco Green run (docs/ECOGREEN_SOURCE.md
// §Building the Books mapping). Pure functions: no store, no I/O.
//
//   - normaliseName / similarity: name matching tuned to how Books names drift from source
//     names (case, punctuation, abbreviations, bank account numbers).
//   - proposeAccountMappings: source ledger -> Books account, by NAME only (Books
//     account_code is a different numbering from the source ledger code).
//   - proposeContactMappings: source party -> Books contact, or -> Books account when the
//     party is itself a GL account in Books (payment clearing accounts).
//   - buildRuleRows: DRAFT mapping_rules rows (POST /api/mappings) from the proposals.
//   - reviewCsv: the sheet a reviewer fills in.
//
// Nothing here approves anything: every proposal is a suggestion, rules leave as DRAFT.

const ABBREVIATIONS = [
  [/\bCGSTTDS\b/g, 'CGST TDS'],
  [/\bSGSTTDS\b/g, 'SGST TDS'],
  [/\bIGSTTDS\b/g, 'IGST TDS'],
  // FY-2025-2026 / FY 2025-2026 / FY-25-26 / FY 25-26 -> FY 25 26
  [/\bFY[\s\-_.]*(?:20)?(\d{2})[\s\-_./]*(?:20)?(\d{2})\b/g, 'FY $1 $2'],
  [/\bRECD\b/g, 'RECEIVED'],
  [/\bCHQ\b/g, 'CHEQUE'],
  [/\b(?:AGST|AGT)\b/g, 'AGAINST'],
  [/\bR\s*&\s*M\b/g, 'REPAIRS MAINTENANCE'],
  [/\bP\s*&\s*S\b/g, 'PRINTING STATIONERY'],
  [/\bS\s*&\s*D\b/g, 'SALES DISTRIBUTION'],
  [/\bR\s*&\s*T\b/g, 'RATES TAXES'],
  [/\bHO\b/g, 'HEAD OFFICE'],
  [/\bA\s*\/\s*C\b/g, 'ACCOUNT'],
];

/** Canonical form used for every name comparison. Digit runs (bank account numbers) survive. */
export function normaliseName(s) {
  let t = String(s ?? '').toUpperCase();
  for (const [re, to] of ABBREVIATIONS) t = t.replace(re, to);
  return t.replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

// ---- similarity -------------------------------------------------------------------------

function prepare(name) {
  const norm = normaliseName(name);
  const tokens = new Set(norm.split(' ').filter(Boolean));
  const compact = norm.replace(/ /g, '');
  const bigrams = new Map();
  for (let i = 0; i < compact.length - 1; i += 1) {
    const g = compact.slice(i, i + 2);
    bigrams.set(g, (bigrams.get(g) ?? 0) + 1);
  }
  return { norm, tokens, compact, bigrams, bigramTotal: Math.max(compact.length - 1, 0) };
}

function score(a, b) {
  if (!a.norm || !b.norm) return 0;
  if (a.norm === b.norm) return 1;
  let dice = 0;
  if (a.bigramTotal > 0 && b.bigramTotal > 0) {
    let overlap = 0;
    for (const [g, n] of a.bigrams) overlap += Math.min(n, b.bigrams.get(g) ?? 0);
    dice = (2 * overlap) / (a.bigramTotal + b.bigramTotal);
  }
  let inter = 0;
  for (const t of a.tokens) if (b.tokens.has(t)) inter += 1;
  const union = a.tokens.size + b.tokens.size - inter;
  const jaccard = union === 0 ? 0 : inter / union;
  return 0.6 * dice + 0.4 * jaccard;
}

/** 0.6 * Dice over character bigrams (spaces removed) + 0.4 * token Jaccard, on normalised names. */
export function similarity(a, b) {
  return score(prepare(a), prepare(b));
}

// ---- shared matching --------------------------------------------------------------------

const PLACEHOLDER_RE = /DO[ _]?NOT[ _]?USE/i;
const round4 = (x) => Math.round(x * 10000) / 10000;
const text = (v) => (v === null || v === undefined ? '' : String(v));

function isTrue(v) {
  return v === true || v === 1 || v === '1' || (typeof v === 'string' && ['true', 'active'].includes(v.trim().toLowerCase()));
}

/** Rank `pool` entries ({ prep, ... }) against a source name; stable, best first. */
function rank(srcPrep, pool) {
  return pool
    .map((p) => ({ p, s: score(srcPrep, p.prep) }))
    .sort((x, y) => (y.s - x.s) || x.p.name.localeCompare(y.p.name) || x.p.id.localeCompare(y.p.id));
}

const candidateOf = (p, s) => ({ id: p.id, name: p.name, type: p.type, parent: p.parent, score: round4(s) });

/**
 * The shared EXACT / AMBIGUOUS / FUZZY / REVIEW / NONE decision over a prepared pool.
 * -> { status, target (pool entry|null), score, candidates, exact (pool entries) }
 */
function decide(srcName, pool, { threshold, reviewFloor }) {
  const src = prepare(srcName);
  const exact = src.norm ? pool.filter((p) => p.prep.norm === src.norm) : [];
  const ranked = rank(src, pool);
  const top3 = ranked.slice(0, 3).map(({ p, s }) => candidateOf(p, s));
  if (exact.length === 1) return { status: 'EXACT', target: exact[0], score: 1, candidates: top3, exact };
  if (exact.length > 1) {
    return { status: 'AMBIGUOUS', target: null, score: 1, candidates: exact.map((p) => candidateOf(p, 1)), exact };
  }
  const best = ranked[0];
  if (!best) return { status: 'NONE', target: null, score: 0, candidates: [], exact };
  const second = ranked[1]?.s ?? 0;
  if (best.s >= threshold && best.s - second >= 0.05) {
    return { status: 'FUZZY', target: best.p, score: best.s, candidates: top3, exact };
  }
  if (best.s >= reviewFloor) return { status: 'REVIEW', target: null, score: best.s, candidates: top3, exact };
  return { status: 'NONE', target: null, score: best.s, candidates: top3, exact };
}

const HEADER_NOTE = 'Books account is a group header; choose a sub-account';

function buildAccountPool(accounts) {
  const list = Array.isArray(accounts) ? accounts : [];
  const parentIds = new Set(list.map((a) => text(a.parent_account_id)).filter(Boolean));
  const pool = list
    .filter((a) => isTrue(a.is_active) && !PLACEHOLDER_RE.test(text(a.account_name)))
    .map((a) => ({
      id: text(a.account_id),
      name: text(a.account_name),
      type: text(a.account_type),
      parent: text(a.parent_account_name) || null,
      code: text(a.account_code).trim(),
      hasChildren: parentIds.has(text(a.account_id)),
      prep: prepare(a.account_name),
    }));
  return pool;
}

function emptyRow(source_key, source_name, usage_count) {
  return {
    source_key, source_name, usage_count: usage_count ?? 0,
    status: 'NONE', target_id: null, target_name: null, target_type: null, target_parent: null,
    score: 0, candidates: [], note: '',
  };
}

// ---- accounts ---------------------------------------------------------------------------

/**
 * ledgers = [{ ledger_code, ledger_name, usage_count }]; accounts = Books accounts.json.
 * Account names are the only key: Books account_code is not the source ledger code.
 */
export function proposeAccountMappings({ ledgers, accounts, threshold = 0.8, reviewFloor = 0.5 }) {
  const pool = buildAccountPool(accounts);
  return (ledgers ?? []).map((l) => {
    const row = emptyRow(text(l.ledger_code), text(l.ledger_name), l.usage_count);
    const d = decide(row.source_name, pool, { threshold, reviewFloor });
    row.status = d.status;
    row.score = round4(d.score);
    row.candidates = d.candidates;
    if (d.status === 'AMBIGUOUS') row.note = `${d.exact.length} active Books accounts have this name`;
    if (d.target) {
      if (d.target.hasChildren) {
        row.status = 'REVIEW';
        row.note = HEADER_NOTE;
      } else {
        Object.assign(row, {
          target_id: d.target.id, target_name: d.target.name,
          target_type: d.target.type, target_parent: d.target.parent,
        });
      }
    }
    return row;
  });
}

// ---- contacts (and parties that are GL accounts) ------------------------------------------

/**
 * parties = [{ party_code, party_name, usage_count, ledger_codes: [] }].
 * A party whose code equals a Books account_code, or whose name equals a Books account name,
 * is mapped to that ACCOUNT (kind 'account'); otherwise to an active Books contact.
 */
export function proposeContactMappings({ parties, contacts, accounts, threshold = 0.8, reviewFloor = 0.5 }) {
  const accountPool = buildAccountPool(accounts);
  const contactPool = (Array.isArray(contacts) ? contacts : [])
    .filter((c) => text(c.status).trim().toLowerCase() === 'active')
    .map((c) => ({
      id: text(c.contact_id), name: text(c.contact_name), type: text(c.contact_type),
      parent: null, prep: prepare(c.contact_name),
    }));

  return (parties ?? []).map((p) => {
    const row = {
      ...emptyRow(text(p.party_code), text(p.party_name), p.usage_count),
      kind: 'contact', contact_type: null, ledger_codes: [...(p.ledger_codes ?? [])],
    };
    const code = row.source_key.trim().toLowerCase();
    const nameNorm = normaliseName(row.source_name);
    const asAccounts = accountPool.filter((a) => (code && a.code.toLowerCase() === code) || (nameNorm && a.prep.norm === nameNorm));

    if (asAccounts.length > 1) {
      return {
        ...row, kind: 'account', status: 'AMBIGUOUS', score: 1,
        candidates: asAccounts.map((a) => candidateOf(a, 1)),
        note: `${asAccounts.length} active Books accounts match this party`,
      };
    }
    if (asAccounts.length === 1) {
      const a = asAccounts[0];
      const out = { ...row, kind: 'account', score: 1, candidates: [candidateOf(a, 1)] };
      if (a.hasChildren) return { ...out, status: 'REVIEW', note: HEADER_NOTE };
      return {
        ...out, status: 'ACCOUNT', target_id: a.id, target_name: a.name, target_type: a.type, target_parent: a.parent,
        note: 'Party is a GL account in Books',
      };
    }

    const d = decide(row.source_name, contactPool, { threshold, reviewFloor });
    row.status = d.status;
    row.score = round4(d.score);
    row.candidates = d.candidates;
    if (d.status === 'AMBIGUOUS') row.note = `${d.exact.length} active Books contacts have this name`;
    if (d.target) {
      Object.assign(row, {
        target_id: d.target.id, target_name: d.target.name, target_type: d.target.type,
        contact_type: d.target.type,
      });
    }
    return row;
  });
}

// ---- rule rows ----------------------------------------------------------------------------

const AUTO_STATUSES = new Set(['EXACT', 'FUZZY']);

/** DRAFT mapping_rules rows (target_meta as an object) ready for POST /api/mappings. */
export function buildRuleRows({ accountProposals, contactProposals, voucherTypes, mappingVersion, effectiveFrom, booksOrgId, decidedOn }) {
  if (!mappingVersion) throw new Error('buildRuleRows: mappingVersion is required');
  if (!effectiveFrom) throw new Error('buildRuleRows: effectiveFrom is required');
  const base = { mapping_version: mappingVersion, effective_from: effectiveFrom, effective_to: null, status: 'DRAFT', approved_by: null, approved_at: null };
  const rules = [];

  const types = [...new Set((voucherTypes ?? []).map((t) => text(t).trim()).filter(Boolean))].sort();
  for (const type of types) {
    if (type !== 'JOURNAL' && !decidedOn) throw new Error('buildRuleRows: decidedOn is required to route non-JOURNAL voucher types');
    rules.push({
      rule_type: 'MODULE_ROUTE', source_key: type, target_value: 'journal', target_meta: {}, ...base,
      notes: type === 'JOURNAL' ? ''
        : `Owner decision ${decidedOn}: Eco Green ${type} vouchers in the ledger-table extract are posted to Books as journals, with the party carried on the receivable/payable sub-account line.`,
    });
  }

  for (const p of accountProposals ?? []) {
    if (!AUTO_STATUSES.has(p.status) || !p.target_id) continue;
    rules.push({
      rule_type: 'LEDGER_ACCOUNT', source_key: p.source_key, target_value: p.target_id,
      target_meta: {
        account_name: p.target_name, account_type: p.target_type, parent_account_name: p.target_parent,
        books_org_id: booksOrgId,
        match: { status: p.status, score: p.score, source_name: p.source_name, usage_count: p.usage_count },
      },
      ...base, notes: `Proposed by name match (${p.status}, score ${p.score}); pending review`,
    });
  }

  for (const p of contactProposals ?? []) {
    if (!(AUTO_STATUSES.has(p.status) || p.status === 'ACCOUNT') || !p.target_id) continue;
    const match = { status: p.status, score: p.score, source_name: p.source_name, usage_count: p.usage_count };
    const meta = p.kind === 'account'
      ? { kind: 'account', account_name: p.target_name, account_type: p.target_type, parent_account_name: p.target_parent, books_org_id: booksOrgId, match }
      : { kind: 'contact', contact_name: p.target_name, contact_type: p.contact_type, books_org_id: booksOrgId, match };
    rules.push({
      rule_type: 'PARTY', source_key: p.source_key, target_value: p.target_id, target_meta: meta,
      ...base, notes: `Proposed by name match (${p.status}, score ${p.score}); pending review`,
    });
  }
  return rules;
}

// ---- review sheet -------------------------------------------------------------------------

function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const candidateCell = (c) => (c ? `${c.name} [${c.id}] ${Number(c.score).toFixed(2)}` : '');

/**
 * Review sheet (RFC 4180, CRLF). Where a row has no proposed target (REVIEW / AMBIGUOUS / NONE)
 * the proposed_target_* columns show the best candidate so the reviewer sees it; the status
 * says it was NOT proposed. candidate_2 / candidate_3 are the next candidates.
 */
export function reviewCsv(rows, kind) {
  const contacts = kind === 'contacts' || kind === 'contact';
  const header = [
    'source_key', 'source_name', 'usage_count', 'status', ...(contacts ? ['kind', 'contact_type'] : []),
    'proposed_target_id', 'proposed_target_name', 'target_type', 'target_parent', 'score',
    'candidate_2', 'candidate_3', 'note', 'reviewer_decision', 'reviewer_target_id',
  ];
  const lines = [header.map(csvCell).join(',')];
  for (const r of rows ?? []) {
    const shown = r.target_id
      ? { id: r.target_id, name: r.target_name, type: r.target_type, parent: r.target_parent, score: r.score }
      : (r.candidates?.[0] ?? null);
    const rest = r.target_id ? (r.candidates ?? []).filter((c) => c.id !== r.target_id) : (r.candidates ?? []).slice(1);
    const cells = [
      r.source_key, r.source_name, r.usage_count, r.status, ...(contacts ? [r.kind, r.contact_type] : []),
      shown?.id, shown?.name, shown?.type, shown?.parent, shown?.score ?? r.score,
      candidateCell(rest[0]), candidateCell(rest[1]), r.note, '', '',
    ];
    lines.push(cells.map(csvCell).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}
