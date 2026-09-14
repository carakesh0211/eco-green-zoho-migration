import { randomUUID } from 'node:crypto';

export function nowIso() { return new Date().toISOString(); }
export function newId(prefix) { return prefix ? `${prefix}_${randomUUID()}` : randomUUID(); }
export function newCorrelationId() { return `corr_${randomUUID()}`; }

/** Indian FY: Apr-Mar. "2026-05-14" -> "2026-27" */
export function financialYearOf(isoDate) {
  const [y, m] = isoDate.split('-').map(Number);
  const startYear = m >= 4 ? y : y - 1;
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}

export function periodOf(isoDate) { return isoDate.slice(0, 7); }

export function isIsoDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** Date-only comparison helpers (ISO strings compare lexicographically). */
export function dateLt(a, b) { return a < b; }
export function dateLte(a, b) { return a <= b; }
export function addDays(isoDate, days) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Build the synthetic composite unique key used by every `uk` column. */
export function uk(...parts) { return parts.map(p => (p === null || p === undefined ? '' : String(p))).join('|'); }
