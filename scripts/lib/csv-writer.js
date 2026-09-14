// Tiny RFC4180 CSV writer. Deliberately independent of src/core/csv.js (owned by another
// module/agent) so the fixture generator has no cross-dependency on in-progress work.
//
// Rules implemented (RFC4180 §2):
//  - Fields are separated by "," and records by "\n" (LF; the contract's reader tolerates
//    both CRLF and LF, so LF keeps generated fixtures byte-stable and diff-friendly).
//  - A field is quoted with double-quotes when it contains a comma, a double-quote, a
//    newline (\n or \r), or leading/trailing whitespace.
//  - A literal double-quote inside a quoted field is escaped by doubling it ("" ).
//  - Every row is written with the same number of fields as the header.

/** Quote a single field per RFC4180 if needed. Non-string values are stringified first. */
export function csvField(value) {
  const s = value === null || value === undefined ? '' : String(value);
  const needsQuoting = /[",\n\r]/.test(s) || s !== s.trim();
  if (!needsQuoting) return s;
  return `"${s.replace(/"/g, '""')}"`;
}

/** Render one CSV row (array of raw values) as a single line, no trailing newline. */
export function csvRow(values) {
  return values.map(csvField).join(',');
}

/**
 * Render a full CSV document.
 * @param {string[]} header - column names, written in order.
 * @param {Array<Array<string|number>>} rows - each row must have header.length values, in order.
 * @returns {string} CSV text terminated by a single trailing newline.
 */
export function toCsv(header, rows) {
  const lines = [csvRow(header)];
  for (const row of rows) {
    if (row.length !== header.length) {
      throw new Error(`csv row has ${row.length} fields, expected ${header.length}`);
    }
    lines.push(csvRow(row));
  }
  return lines.join('\n') + '\n';
}
