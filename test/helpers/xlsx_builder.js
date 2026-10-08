// Test-only .xlsx writer (no dependencies): a tiny ZIP writer (STORED or DEFLATE) plus a
// workbook builder that emits hand-written SpreadsheetML parts. Used by
// ecogreen_xlsx.test.js and ecogreen_ledger_table.test.js. All values are synthetic.
// (node --test also loads this file as a test file; it registers no tests.)
import { deflateRawSync } from 'node:zlib';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * entries: [{ name, data: string|Buffer, deflate?: boolean, method?: number, usize?: number }]
 * `method` / `usize` override what is written (to build deliberately corrupt archives).
 */
export function zip(entries) {
  const locals = []; const centrals = []; let offset = 0;
  for (const e of entries) {
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data, 'utf8');
    const name = Buffer.from(e.name, 'utf8');
    const method = e.method ?? (e.deflate ? 8 : 0);
    const stored = e.deflate ? deflateRawSync(raw) : raw;
    const crc = crc32(raw);
    const usize = e.usize ?? raw.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8); local.writeUInt32LE(0, 10); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(stored.length, 18); local.writeUInt32LE(usize, 22);
    local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8); central.writeUInt16LE(method, 10); central.writeUInt32LE(0, 12);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(stored.length, 20); central.writeUInt32LE(usize, 24);
    central.writeUInt16LE(name.length, 28); central.writeUInt16LE(0, 30); central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34); central.writeUInt16LE(0, 36); central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, stored);
    centrals.push(central, name);
    offset += 30 + name.length + stored.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, eocd]);
}

export const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
export const CONTENT_TYPES = `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/></Types>`;
export const ROOT_RELS = `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;

/**
 * styles.xml cellXfs: 0 general, 1 builtin 14 (date), 2 custom dd/mm/yy (date),
 * 3 custom #,##0.00 (number), 4 custom [$-409]d-mmm-yy;@ (date), 5 general (bold font),
 * 6 builtin 10 (0.00%, number), 7 custom 0.0" days" (number: quoted literal is ignored).
 */
export const STYLES = `${XML_HEAD}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="4"><numFmt numFmtId="164" formatCode="dd/mm/yy"/><numFmt numFmtId="165" formatCode="#,##0.00;[Red]-#,##0.00"/><numFmt numFmtId="166" formatCode="[$-409]d\\-mmm\\-yy;@"/><numFmt numFmtId="167" formatCode="0.0&quot; days&quot;"/></numFmts><cellStyleXfs count="1"><xf numFmtId="0"/></cellStyleXfs><cellXfs count="8"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0"/><xf numFmtId="10" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="167" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs></styleSheet>`;

export const STYLE_DATE = 1;

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const colName = (i) => { let n = i + 1; let s = ''; while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); } return s; };

/** Excel serial of an ISO date (the inverse of serialToIsoDate; 25569 = 1970-01-01). */
export function isoToSerial(iso) {
  return Date.parse(`${iso}T00:00:00Z`) / 86400000 + 25569;
}

/**
 * High-level workbook: sheets = [{ name, rows }] where a cell is a string (shared string),
 * a number, a boolean, null (omitted), or { date: 'YYYY-MM-DD' } / { serial } (a number
 * carrying the date style). Options: deflate (compress every entry), quote ("'" for the
 * single-quoted attributes Zoho's report writer emits).
 */
export function buildXlsx(sheets, { deflate = false, quote = '"' } = {}) {
  const q = quote;
  const strings = []; const index = new Map();
  const sst = (s) => { if (!index.has(s)) { index.set(s, strings.length); strings.push(s); } return index.get(s); };
  const sheetXml = sheets.map((sh) => {
    const rows = sh.rows.map((row, ri) => {
      const cells = row.map((v, ci) => {
        if (v === null || v === undefined) return '';
        const ref = `${colName(ci)}${ri + 1}`;
        if (typeof v === 'string') return `<c r=${q}${ref}${q} t=${q}s${q}><v>${sst(v)}</v></c>`;
        if (typeof v === 'boolean') return `<c r=${q}${ref}${q} t=${q}b${q}><v>${v ? 1 : 0}</v></c>`;
        if (typeof v === 'number') return `<c r=${q}${ref}${q}><v>${v}</v></c>`;
        const serial = v.serial ?? isoToSerial(v.date);
        return `<c r=${q}${ref}${q} s=${q}${STYLE_DATE}${q}><v>${serial}</v></c>`;
      }).join('');
      return `<row r=${q}${ri + 1}${q}>${cells}</row>`;
    }).join('');
    return `${XML_HEAD}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`;
  });
  const sstXml = `${XML_HEAD}<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.length}" uniqueCount="${strings.length}">${strings.map((s) => `<si><t xml:space="preserve">${esc(s)}</t></si>`).join('')}</sst>`;
  const wbXml = `${XML_HEAD}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((sh, i) => `<sheet name=${q}${esc(sh.name)}${q} sheetId=${q}${i + 1}${q} r:id=${q}rId${i + 1}${q}/>`).join('')}</sheets></workbook>`;
  const relsXml = `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id=${q}rId${i + 1}${q} Type=${q}http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet${q} Target=${q}worksheets/sheet${i + 1}.xml${q}/>`).join('')}<Relationship Id=${q}rId90${q} Type=${q}http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles${q} Target=${q}styles.xml${q}/><Relationship Id=${q}rId91${q} Type=${q}http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings${q} Target=${q}sharedStrings.xml${q}/></Relationships>`;
  return zip([
    { name: '[Content_Types].xml', data: CONTENT_TYPES, deflate },
    { name: '_rels/.rels', data: ROOT_RELS, deflate },
    { name: 'xl/workbook.xml', data: wbXml, deflate },
    { name: 'xl/_rels/workbook.xml.rels', data: relsXml, deflate },
    { name: 'xl/styles.xml', data: STYLES, deflate },
    { name: 'xl/sharedStrings.xml', data: sstXml, deflate },
    ...sheetXml.map((x, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: x, deflate })),
  ]);
}
