// Minimal .xlsx reader (no dependencies): enough for the flat report workbooks the Eco
// Green team delivers (one or more plain sheets, shared strings, inline strings, numbers,
// booleans, date-formatted numbers). Not a general spreadsheet engine: formulas are read
// by their cached value, merged cells / styles / drawings are ignored.
//
// readXlsx(buffer) -> { sheets: [{ name, rows: Array<Array<cell>> }] }
//   cell is a string, a number, a boolean, { date: 'YYYY-MM-DD' } for date-formatted
//   numbers, or null for an empty cell. Rows are padded to the widest row of the sheet.
import { inflateRawSync } from 'node:zlib';

export class XlsxError extends Error {
  constructor(message) { super(message); this.code = 'XLSX_PARSE'; }
}

/** Parse the ZIP container via its central directory. -> Map<name, Buffer> */
function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new XlsxError('not a zip/xlsx file (no end-of-central-directory record)');
  const entries = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let n = 0; n < entries; n += 1) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new XlsxError('corrupt central directory');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (buf.readUInt32LE(localOff) !== 0x04034b50) throw new XlsxError(`corrupt local header for ${name}`);
    const dataStart = localOff + 30 + buf.readUInt16LE(localOff + 26) + buf.readUInt16LE(localOff + 28);
    const raw = buf.subarray(dataStart, dataStart + csize);
    let data;
    if (method === 0) data = raw;
    else if (method === 8) data = inflateRawSync(raw);
    else throw new XlsxError(`unsupported zip compression method ${method} for ${name}`);
    if (data.length !== usize) throw new XlsxError(`size mismatch inflating ${name}`);
    files.set(name, data);
  }
  return files;
}

const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
function decodeXml(s) {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|lt|gt|amp|quot|apos);/g, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENTITIES[e];
  });
}

/** attribute value regardless of quote style; null when absent */
function attr(tag, name) {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(tag);
  return m ? (m[1] ?? m[2]) : null;
}

function textOf(xml) {
  // concatenate every <t> run (rich text splits a string across runs)
  let out = '';
  const re = /<t(?:\s[^>]*)?>([^<]*)<\/t>|<t(?:\s[^>]*)?\/>/g;
  let m;
  while ((m = re.exec(xml)) !== null) out += decodeXml(m[1] ?? '');
  return out;
}

function sharedStrings(files) {
  const xml = files.get('xl/sharedStrings.xml');
  if (!xml) return [];
  const out = [];
  const re = /<si>([\s\S]*?)<\/si>|<si\/>/g;
  let m;
  while ((m = re.exec(xml.toString('utf8'))) !== null) out.push(textOf(m[1] ?? ''));
  return out;
}

const BUILTIN_DATE_FMTS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);

/** style index -> is a date/time number format */
function dateStyles(files) {
  const xml = files.get('xl/styles.xml')?.toString('utf8') ?? '';
  const custom = new Map();
  for (const tag of xml.match(/<numFmt\s[^>]*\/?>/g) ?? []) {
    const id = Number(attr(tag, 'numFmtId'));
    const code = decodeXml(attr(tag, 'formatCode') ?? '');
    // strip quoted literals and [colour]/[$-locale] blocks, then look for day/month/year/hour tokens
    const bare = code.replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '').replace(/\\./g, '');
    custom.set(id, /[dmyhs]/i.test(bare) && !/[#0?]/.test(bare));
  }
  const xfs = /<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml)?.[1] ?? '';
  const result = [];
  for (const tag of xfs.match(/<xf\s[^>]*\/?>/g) ?? []) {
    const id = Number(attr(tag, 'numFmtId') ?? 0);
    result.push(BUILTIN_DATE_FMTS.has(id) || custom.get(id) === true);
  }
  return result;
}

/** Excel serial (1900 date system) -> 'YYYY-MM-DD' */
export function serialToIsoDate(serial) {
  const days = Math.floor(Number(serial));
  // 25569 = serial of 1970-01-01; Excel's phantom 1900-02-29 is already inside that offset
  const ms = (days - 25569) * 86400000;
  return new Date(ms).toISOString().slice(0, 10);
}

function colIndex(ref) {
  let n = 0;
  for (const ch of ref) {
    if (ch < 'A' || ch > 'Z') break;
    n = n * 26 + (ch.charCodeAt(0) - 64);
  }
  return n - 1;
}

function sheetList(files) {
  const wb = files.get('xl/workbook.xml')?.toString('utf8');
  if (!wb) throw new XlsxError('xl/workbook.xml missing');
  const rels = files.get('xl/_rels/workbook.xml.rels')?.toString('utf8') ?? '';
  const targets = new Map();
  for (const tag of rels.match(/<Relationship\s[^>]*\/?>/g) ?? []) {
    const id = attr(tag, 'Id');
    let target = attr(tag, 'Target') ?? '';
    if (target.startsWith('/')) target = target.slice(1);
    else if (!target.startsWith('xl/')) target = `xl/${target}`;
    targets.set(id, target);
  }
  const sheets = [];
  for (const tag of wb.match(/<sheet\s[^>]*\/?>/g) ?? []) {
    const rid = attr(tag, 'r:id');
    sheets.push({ name: decodeXml(attr(tag, 'name') ?? ''), path: targets.get(rid) });
  }
  return sheets;
}

export function readXlsx(buffer) {
  const files = unzip(buffer);
  const strings = sharedStrings(files);
  const isDate = dateStyles(files);
  const sheets = [];
  for (const { name, path } of sheetList(files)) {
    const xml = files.get(path)?.toString('utf8');
    if (xml === undefined) throw new XlsxError(`worksheet ${path} missing`);
    const rows = [];
    let width = 0;
    const rowRe = /<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g;
    let rm;
    while ((rm = rowRe.exec(xml)) !== null) {
      const cells = [];
      const cellRe = /<c\s([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
      let cm;
      while ((cm = cellRe.exec(rm[1] ?? '')) !== null) {
        const head = ` ${cm[1]}`;
        const inner = cm[2] ?? '';
        const ref = attr(head, 'r') ?? '';
        const idx = ref ? colIndex(ref) : cells.length;
        const type = attr(head, 't');
        const style = Number(attr(head, 's') ?? 0);
        const v = /<v>([^<]*)<\/v>/.exec(inner)?.[1];
        let value = null;
        if (type === 's') value = v === undefined ? null : (strings[Number(v)] ?? '');
        else if (type === 'inlineStr') value = textOf(inner);
        else if (type === 'str') value = v === undefined ? '' : decodeXml(v);
        else if (type === 'b') value = v === '1';
        else if (v !== undefined && v !== '') {
          const num = Number(v);
          value = Number.isFinite(num) ? (isDate[style] ? { date: serialToIsoDate(num) } : num) : decodeXml(v);
        }
        while (cells.length < idx) cells.push(null);
        cells[idx] = value;
      }
      width = Math.max(width, cells.length);
      rows.push(cells);
    }
    for (const r of rows) while (r.length < width) r.push(null);
    sheets.push({ name, rows });
  }
  return { sheets };
}

/** Convenience: first sheet as objects keyed by the header row (trimmed strings). */
export function sheetToObjects(sheet, { headerRow = 0 } = {}) {
  const header = (sheet.rows[headerRow] ?? []).map((h) => String(h ?? '').trim());
  return sheet.rows.slice(headerRow + 1)
    .filter((r) => r.some((c) => c !== null && c !== ''))
    .map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? null]).filter(([h]) => h !== '')));
}
