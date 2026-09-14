// Decimal-safe money for INR-style 2dp amounts.
// Representation: BigInt paise. Wire/storage representation: "1234.50" strings.
// Never use Number for money anywhere in this codebase.

const SCALE = 100n;

/** Parse "1234.5", "1,234.50", "-12", "(12.00)", "" -> BigInt paise. Throws on garbage. */
export function parseMoney(input) {
  if (input === null || input === undefined) return 0n;
  let s = String(input).trim();
  if (s === '') return 0n;
  let negative = false;
  if (s.startsWith('(') && s.endsWith(')')) { negative = true; s = s.slice(1, -1); }
  s = s.replace(/,/g, '').replace(/^\+/, '');
  if (s.startsWith('-')) { negative = !negative; s = s.slice(1); }
  if (!/^\d*(\.\d*)?$/.test(s) || s === '.' ) throw new MoneyParseError(input);
  const [whole = '0', frac = ''] = s.split('.');
  if (frac.length > 2) {
    // Reject silent precision loss: source must be 2dp. Trailing zeros beyond 2dp are tolerated.
    if (!/^0*$/.test(frac.slice(2))) throw new MoneyPrecisionError(input);
  }
  const paise = BigInt(whole || '0') * SCALE + BigInt((frac + '00').slice(0, 2));
  return negative ? -paise : paise;
}

/** BigInt paise -> "1234.50" (always 2dp, minus sign for negatives, no thousands separators). */
export function formatMoney(paise) {
  if (typeof paise !== 'bigint') throw new TypeError('formatMoney expects BigInt paise');
  const neg = paise < 0n;
  const abs = neg ? -paise : paise;
  const whole = abs / SCALE;
  const frac = (abs % SCALE).toString().padStart(2, '0');
  return `${neg ? '-' : ''}${whole}.${frac}`;
}

export const ZERO = 0n;
export function add(a, b) { return a + b; }
export function sub(a, b) { return a - b; }
export function neg(a) { return -a; }
export function abs(a) { return a < 0n ? -a : a; }
export function eq(a, b) { return a === b; }
export function isZero(a) { return a === 0n; }
export function sum(iterable) { let t = 0n; for (const v of iterable) t += v; return t; }
export function max(a, b) { return a > b ? a : b; }

/** |a-b| <= tolerance (all BigInt paise). */
export function withinTolerance(a, b, tolerance = 0n) {
  return abs(a - b) <= tolerance;
}

export class MoneyParseError extends Error {
  constructor(input) { super(`Invalid money value: ${JSON.stringify(String(input))}`); this.code = 'MONEY_PARSE'; }
}
export class MoneyPrecisionError extends Error {
  constructor(input) { super(`Money value exceeds 2dp precision: ${JSON.stringify(String(input))}`); this.code = 'MONEY_PRECISION'; }
}
