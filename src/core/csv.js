// Hand-written RFC 4180 CSV parser. No dependencies.
// Handles: quoted fields (with doubled-quote escaping), embedded newlines inside
// quoted fields, CR / LF / CRLF line endings, a configurable delimiter, a
// tolerated trailing newline, and reports ragged rows with a 1-based line number
// (header row is line 1).

export class CsvParseError extends Error {
  constructor(message, line) {
    super(message);
    this.name = 'CsvParseError';
    this.code = 'CSV_PARSE';
    this.line = line;
  }
}

/**
 * Parse CSV text into { header, rows }. `rows` are the data rows (header excluded),
 * each an array of raw string values (untyped — callers coerce as needed).
 * Throws CsvParseError{code:'CSV_PARSE', line} on an unterminated quote or a row
 * whose field count does not match the header.
 */
export function parseCsv(text, { delimiter = ',' } = {}) {
  if (typeof text !== 'string') throw new TypeError('parseCsv expects a string');
  // Defensive BOM strip in case a caller passes raw decoded text that still has one.
  if (text.length && text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const allRows = []; // { cells: string[], line: number }
  let field = '';
  let row = [];
  let inQuotes = false;
  let line = 1;
  let rowStartLine = 1;
  let i = 0;
  const n = text.length;

  const endField = () => { row.push(field); field = ''; };
  const endRow = () => { endField(); allRows.push({ cells: row, line: rowStartLine }); row = []; };

  while (i < n) {
    const c = text[i];

    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i += 1; continue;
      }
      if (c === '\r') {
        field += '\n';
        i += (text[i + 1] === '\n') ? 2 : 1;
        line += 1;
        continue;
      }
      if (c === '\n') { field += '\n'; i += 1; line += 1; continue; }
      field += c; i += 1; continue;
    }

    // Not inside a quoted field.
    if (c === '"' && field === '') { inQuotes = true; i += 1; continue; }
    if (c === delimiter) { endField(); i += 1; continue; }
    if (c === '\r') {
      endRow();
      i += (text[i + 1] === '\n') ? 2 : 1;
      line += 1;
      rowStartLine = line;
      continue;
    }
    if (c === '\n') { endRow(); i += 1; line += 1; rowStartLine = line; continue; }
    field += c; i += 1; continue;
  }

  if (inQuotes) throw new CsvParseError('Unterminated quoted field', rowStartLine);
  // Trailing-newline tolerant: only emit a final row if there is unflushed content
  // (a file that ends exactly on a newline must not produce a spurious empty row).
  if (field !== '' || row.length > 0) endRow();

  if (allRows.length === 0) return { header: [], rows: [] };

  const header = allRows[0].cells;
  const rows = [];
  for (let r = 1; r < allRows.length; r += 1) {
    const { cells, line: rLine } = allRows[r];
    if (cells.length !== header.length) {
      throw new CsvParseError(
        `Ragged row at line ${rLine}: expected ${header.length} fields, got ${cells.length}`,
        rLine,
      );
    }
    rows.push(cells);
  }
  return { header, rows };
}

/**
 * Sniff the byte-level encoding of a buffer.
 * -> 'utf-8-bom' | 'utf-16le' | 'utf-8' | 'unknown'
 * Callers should reject 'unknown' upstream rather than guessing further.
 */
export function detectEncoding(buf) {
  if (!(buf instanceof Uint8Array)) throw new TypeError('detectEncoding expects a Buffer/Uint8Array');
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return 'utf-8-bom';
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return 'utf-16le';
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return 'utf-8';
  } catch {
    return 'unknown';
  }
}

/** Decode a buffer to text for a previously-detected encoding, stripping any BOM. */
export function decode(buf, encoding) {
  if (!(buf instanceof Uint8Array)) throw new TypeError('decode expects a Buffer/Uint8Array');
  let text;
  switch (encoding) {
    case 'utf-8-bom':
      text = new TextDecoder('utf-8').decode(buf.subarray(3));
      break;
    case 'utf-8':
      text = new TextDecoder('utf-8').decode(buf);
      break;
    case 'utf-16le':
      text = new TextDecoder('utf-16le').decode(buf);
      break;
    default:
      throw new Error(`Unsupported encoding: ${encoding}`);
  }
  if (text.length && text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text;
}
