// Versioned mapping rules (CONTRACTS.md §T). rule_type in
// {MODULE_ROUTE, LEDGER_ACCOUNT, PARTY, PAYMENT_MODE, TAX}.

import { uk } from './ids.js';

export class AmbiguousMappingError extends Error {
  constructor({ ruleType, sourceKey, onDate, matches }) {
    super(`Ambiguous APPROVED mapping for ${ruleType}/${sourceKey} on ${onDate} (${matches} candidate rules)`);
    this.code = 'AMBIGUOUS_MAPPING';
    this.ruleType = ruleType;
    this.sourceKey = sourceKey;
    this.onDate = onDate;
  }
}

function datePart(v) {
  if (v === null || v === undefined) return null;
  const s = String(v);
  return s.length >= 10 ? s.slice(0, 10) : s;
}

/**
 * Resolve the single APPROVED mapping rule of `ruleType` for `sourceKey` whose
 * effective window [effective_from, effective_to] (inclusive; open-ended when
 * effective_to is null) contains `onDate`. ISO string comparison only.
 *
 * -> the rule, or null when none apply.
 * Throws AmbiguousMappingError when more than one APPROVED rule applies.
 */
export function resolveRule(rules, ruleType, sourceKey, onDate) {
  const target = datePart(onDate);
  const matches = (rules ?? []).filter(r => {
    if (r.rule_type !== ruleType || r.source_key !== sourceKey || r.status !== 'APPROVED') return false;
    const from = datePart(r.effective_from);
    const to = datePart(r.effective_to);
    if (from && target < from) return false;
    if (to && target > to) return false;
    return true;
  });

  if (matches.length === 0) return null;
  if (matches.length > 1) {
    throw new AmbiguousMappingError({ ruleType, sourceKey, onDate: target, matches: matches.length });
  }
  return matches[0];
}

/** Upsert mapping_rules by uk (rule_type|source_key|mapping_version). */
export async function loadMappingRules(ctx, rows) {
  const { store } = ctx;
  const now = ctx.now ? ctx.now() : new Date().toISOString();
  const out = [];
  for (const row of rows) {
    const rowUk = uk(row.rule_type, row.source_key, row.mapping_version);
    const existing = await store.findOne('mapping_rules', { uk: rowUk });
    const patch = {
      rule_type: row.rule_type,
      source_key: row.source_key,
      target_value: row.target_value,
      target_meta: row.target_meta ? JSON.stringify(row.target_meta) : null,
      mapping_version: row.mapping_version,
      effective_from: row.effective_from,
      effective_to: row.effective_to ?? null,
      status: row.status === 'APPROVED' ? 'APPROVED' : (row.status ?? 'DRAFT'),
      approved_by: row.approved_by ?? null,
      approved_at: row.approved_at ?? null,
      notes: row.notes ?? null,
      uk: rowUk,
      updated_at: now,
    };
    if (existing) {
      out.push(await store.update('mapping_rules', existing.id, patch));
    } else {
      out.push(await store.insert('mapping_rules', { ...patch, created_at: now }));
    }
  }
  return out;
}
