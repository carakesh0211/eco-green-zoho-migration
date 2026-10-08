// Dependency-free .xlsx reader (src/sources/ecogreen/xlsx.js).
// Inputs are built in-test with a tiny zip writer (test/helpers/xlsx_builder.js) and
// hand-written SpreadsheetML parts; every value is synthetic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readXlsx, sheetToObjects, serialToIsoDate, XlsxError } from '../src/sources/ecogreen/xlsx.js';
import {
  zip, crc32, buildXlsx, isoToSerial, XML_HEAD, CONTENT_TYPES, ROOT_RELS, STYLES,
} from './helpers/xlsx_builder.js';

const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';

const WORKBOOK = `${XML_HEAD}<workbook ${NS} xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name='Report' sheetId='1' r:id='rId1'/></sheets></workbook>`;
const WORKBOOK_RELS = `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id='rId1' Type='http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet' Target='worksheets/sheet1.xml'/><Relationship Id='rId2' Type='http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles' Target='styles.xml'/><Relationship Id='rId3' Type='http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings' Target='sharedStrings.xml'/></Relationships>`;

const SHARED = `${XML_HEAD}<sst ${NS} count="6" uniqueCount="6">`
  + '<si><t>Plain</t></si>'
  + '<si><r><rPr><b/></rPr><t xml:space="preserve">Rich </t></r><r><rPr><i/></rPr><t>text</t></r></si>'
  + '<si><t>A &amp; B &lt;ok&gt; &#65;&#x42; &quot;q&quot; &apos;a&apos;</t></si>'
  + '<si/>'
  + '<si><t xml:space="preserve">  padded  </t></si>'
  + '<si><t></t></si>'
  + '</sst>';

// Single-quoted attributes throughout, as Zoho's report writer emits them.
const SHEET1 = `${XML_HEAD}<worksheet ${NS}><sheetData>`
  // row 1: shared strings (plain, rich, entities, padded) with a style index
  + "<row r='1' spans='1:4'><c r='A1' t='s' s='5'><v>0</v></c><c r='B1' t='s' s='5'><v>1</v></c><c r='C1' t='s'><v>2</v></c><c r='D1' t='s'><v>4</v></c></row>"
  // row 2: inline string, a gap at B, number, booleans
  + "<row r='2'><c r='A2' t='inlineStr'><is><t>inline &amp; text</t></is></c><c r='C2'><v>12.5</v></c><c r='D2' t='b'><v>1</v></c><c r='E2' t='b'><v>0</v></c></row>"
  // row 3: date-styled numbers (builtin 14, custom dd/mm/yy, custom with [$-409]) vs non-date numbers
  + "<row r='3'><c r='A3' s='1'><v>46113</v></c><c r='B3' s='2'><v>46113</v></c><c r='C3' s='3'><v>1234.5</v></c><c r='D3' s='4'><v>46113</v></c><c r='E3' s='6'><v>0.25</v></c></row>"
  // row 4: only column A (padded to the sheet width); formula string result
  + "<row r='4'><c r='A4' t='str'><f>A1&amp;&quot;x&quot;</f><v>Plain&amp;x</v></c></row>"
  // row 5: empty self-closed styled cell, empty shared strings, cached formula number, non-date custom format with quoted literal
  + "<row r='5'><c r='A5' s='1'/><c r='B5' t='s'><v>3</v></c><c r='C5' t='s'><v>5</v></c><c r='D5'><f>1+1</f><v>2</v></c><c r='E5' s='7'><v>46113</v></c></row>"
  // row 6: no r attributes (cells are sequential); then a far column AA (index 26)
  + "<row><c t='s'><v>0</v></c><c t='n'><v>7</v></c><c r='AA6'><v>9</v></c></row>"
  + '</sheetData></worksheet>';

function mainParts({ deflate = false } = {}) {
  return [
    { name: '[Content_Types].xml', data: CONTENT_TYPES, deflate },
    { name: '_rels/.rels', data: ROOT_RELS, deflate },
    { name: 'xl/workbook.xml', data: WORKBOOK, deflate },
    { name: 'xl/_rels/workbook.xml.rels', data: WORKBOOK_RELS, deflate },
    { name: 'xl/styles.xml', data: STYLES, deflate },
    { name: 'xl/sharedStrings.xml', data: SHARED, deflate },
    { name: 'xl/worksheets/sheet1.xml', data: SHEET1, deflate },
  ];
}

const nulls = (n) => Array.from({ length: n }, () => null);

// ---------------------------------------------------------------- serial -> date

test('serialToIsoDate: 25569 is 1970-01-01, and the serial for 1 April 2026 is 46113 (45748 is a year earlier)', () => {
  assert.equal(serialToIsoDate(25569), '1970-01-01');
  assert.equal(serialToIsoDate(46113), '2026-04-01');
  assert.equal(serialToIsoDate(45748), '2025-04-01', '45748 is 1 April 2025, not 2026');
  assert.equal(isoToSerial('2026-04-01'), 46113);
  // fractional serials (times of day) keep the calendar day
  assert.equal(serialToIsoDate(46113.75), '2026-04-01');
  assert.equal(serialToIsoDate('46114'), '2026-04-02', 'numeric strings are accepted');
  // leap day and year ends
  assert.equal(serialToIsoDate(isoToSerial('2028-02-29')), '2028-02-29');
  assert.equal(serialToIsoDate(isoToSerial('2026-12-31')), '2026-12-31');
  // 1900 date system: serial 61 is 1 March 1900 (Excel's phantom 29 Feb 1900 is serial 60)
  assert.equal(serialToIsoDate(61), '1900-03-01');
});

// ---------------------------------------------------------------- cell types

test('readXlsx: strings, rich text, entities, inline strings, numbers, booleans, gaps and padding', () => {
  const { sheets } = readXlsx(zip(mainParts()));
  assert.equal(sheets.length, 1);
  assert.equal(sheets[0].name, 'Report');
  const rows = sheets[0].rows;
  assert.equal(rows.length, 6);
  const width = 27; // column AA
  for (const r of rows) assert.equal(r.length, width, 'every row is padded to the widest row');

  assert.deepEqual(rows[0].slice(0, 5), ['Plain', 'Rich text', 'A & B <ok> AB "q" \'a\'', '  padded  ', null]);
  assert.deepEqual(rows[1].slice(0, 6), ['inline & text', null, 12.5, true, false, null]);
  assert.deepEqual(rows[2].slice(0, 5), [{ date: '2026-04-01' }, { date: '2026-04-01' }, 1234.5, { date: '2026-04-01' }, 0.25]);
  assert.deepEqual(rows[3].slice(0, 3), ['Plain&x', null, null]);
  assert.deepEqual(rows[4].slice(0, 5), [null, '', '', 2, 46113], 'empty cell, empty shared strings, cached formula value, quoted-literal format is a number');
  assert.deepEqual(rows[5].slice(0, 4), ['Plain', 7, null, null]);
  assert.equal(rows[5][26], 9, 'column AA is index 26');
  assert.deepEqual(rows[5].slice(3, 26), nulls(23));
});

test('readXlsx: a custom number format keeps a number a number; only date formats produce { date }', () => {
  const { sheets } = readXlsx(zip(mainParts()));
  const r = sheets[0].rows[2];
  assert.equal(typeof r[2], 'number', '#,##0.00;[Red]-#,##0.00 is not a date');
  assert.equal(typeof r[4], 'number', 'builtin 10 (0.00%) is not a date');
  assert.equal(r[2], 1234.5);
  assert.deepEqual(r[1], { date: '2026-04-01' }, 'custom dd/mm/yy is a date');
  assert.deepEqual(r[3], { date: '2026-04-01' }, 'custom [$-409]d-mmm-yy;@ is a date');
});

test('readXlsx: a workbook without styles.xml / sharedStrings.xml still reads numbers and inline strings', () => {
  const wb = zip([
    { name: 'xl/workbook.xml', data: WORKBOOK },
    { name: 'xl/_rels/workbook.xml.rels', data: WORKBOOK_RELS },
    { name: 'xl/worksheets/sheet1.xml', data: `${XML_HEAD}<worksheet ${NS}><sheetData><row r="1"><c r="A1"><v>46113</v></c><c r="B1" t="inlineStr"><is><t>x</t></is></c></row></sheetData></worksheet>` },
  ]);
  assert.deepEqual(readXlsx(wb).sheets[0].rows, [[46113, 'x']], 'no styles means no dates');
});

test('readXlsx: double-quoted attributes read the same as single-quoted ones', () => {
  const rows = [['id', 'when', 'amount', 'flag'], ['R1', { date: '2026-04-09' }, 1234.5, true], [null, null, 7, null]];
  const dq = readXlsx(buildXlsx([{ name: 'Data', rows }])).sheets[0].rows;
  const sq = readXlsx(buildXlsx([{ name: 'Data', rows }], { quote: "'" })).sheets[0].rows;
  assert.deepEqual(dq, sq);
  assert.deepEqual(dq, [['id', 'when', 'amount', 'flag'], ['R1', { date: '2026-04-09' }, 1234.5, true], [null, null, 7, null]]);
});

// ---------------------------------------------------------------- sheets

test('readXlsx: two sheets come back in workbook order, whatever the part numbering; entities in names decode', () => {
  const wb = `${XML_HEAD}<workbook ${NS} xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name='Second &amp; last' sheetId='9' r:id='rId7'/><sheet name='First' sheetId='3' r:id='rId2'/></sheets></workbook>`;
  const rels = `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id='rId2' Type='x/worksheet' Target='/xl/worksheets/sheet1.xml'/><Relationship Id='rId7' Type='x/worksheet' Target='worksheets/sheet2.xml'/></Relationships>`;
  const sheet = (v) => `${XML_HEAD}<worksheet ${NS}><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>${v}</t></is></c></row></sheetData></worksheet>`;
  const out = readXlsx(zip([
    { name: 'xl/workbook.xml', data: wb },
    { name: 'xl/_rels/workbook.xml.rels', data: rels },
    { name: 'xl/worksheets/sheet1.xml', data: sheet('from sheet1') },
    { name: 'xl/worksheets/sheet2.xml', data: sheet('from sheet2') },
  ]));
  assert.deepEqual(out.sheets.map((s) => s.name), ['Second & last', 'First']);
  assert.deepEqual(out.sheets.map((s) => s.rows[0][0]), ['from sheet2', 'from sheet1']);
});

test('readXlsx: the builder round-trips two sheets with their own widths', () => {
  const out = readXlsx(buildXlsx([
    { name: 'A', rows: [['x', 'y', 'z'], [1, 2, 3]] },
    { name: 'B', rows: [['only'], [{ date: '2026-07-05' }]] },
  ]));
  assert.deepEqual(out.sheets.map((s) => s.name), ['A', 'B']);
  assert.deepEqual(out.sheets[0].rows, [['x', 'y', 'z'], [1, 2, 3]]);
  assert.deepEqual(out.sheets[1].rows, [['only'], [{ date: '2026-07-05' }]]);
});

test('readXlsx: an empty sheet and self-closing rows are tolerated', () => {
  const wb = zip([
    { name: 'xl/workbook.xml', data: WORKBOOK },
    { name: 'xl/_rels/workbook.xml.rels', data: WORKBOOK_RELS },
    { name: 'xl/worksheets/sheet1.xml', data: `${XML_HEAD}<worksheet ${NS}><sheetData><row r="1"/><row r="2"><c r="B2"><v>5</v></c></row></sheetData></worksheet>` },
  ]);
  assert.deepEqual(readXlsx(wb).sheets[0].rows, [[null, null], [null, 5]]);
  const empty = zip([
    { name: 'xl/workbook.xml', data: WORKBOOK },
    { name: 'xl/_rels/workbook.xml.rels', data: WORKBOOK_RELS },
    { name: 'xl/worksheets/sheet1.xml', data: `${XML_HEAD}<worksheet ${NS}><sheetData/></worksheet>` },
  ]);
  assert.deepEqual(readXlsx(empty).sheets, [{ name: 'Report', rows: [] }]);
});

// ---------------------------------------------------------------- compression

test('readXlsx: deflate-compressed entries (method 8) read identically to stored ones', () => {
  const stored = readXlsx(zip(mainParts()));
  const deflated = zip(mainParts({ deflate: true }));
  const raw = mainParts().reduce((n, p) => n + Buffer.byteLength(p.data), 0);
  assert.ok(deflated.length < raw, 'the archive really is compressed');
  assert.deepEqual(readXlsx(deflated), stored);
  // mixed: only the worksheet is deflated
  const parts = mainParts(); parts[6].deflate = true;
  assert.deepEqual(readXlsx(zip(parts)), stored);
});

test('zip writer self-check: CRC-32 of a known string', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  assert.equal(crc32(Buffer.alloc(0)), 0);
});

// ---------------------------------------------------------------- errors

test('readXlsx: garbage and truncated bytes raise XlsxError with code XLSX_PARSE', () => {
  const bad = [
    Buffer.alloc(0),
    Buffer.from('not a zip file at all'),
    Buffer.from('id,amount\n1,2\n'),
    Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]),
    zip(mainParts()).subarray(0, 100),
  ];
  for (const b of bad) {
    assert.throws(() => readXlsx(b), (e) => e instanceof XlsxError && e.code === 'XLSX_PARSE', `${b.length} bytes`);
  }
  assert.throws(() => readXlsx(Buffer.from('plain text')), /not a zip\/xlsx file/);
});

test('readXlsx: a zip without xl/workbook.xml, or pointing at a missing worksheet, is an XlsxError', () => {
  assert.throws(() => readXlsx(zip([{ name: '[Content_Types].xml', data: CONTENT_TYPES }])), (e) => e instanceof XlsxError && /workbook\.xml missing/.test(e.message));
  const parts = mainParts().filter((p) => p.name !== 'xl/worksheets/sheet1.xml');
  assert.throws(() => readXlsx(zip(parts)), (e) => e instanceof XlsxError && /worksheet xl\/worksheets\/sheet1\.xml missing/.test(e.message));
});

test('readXlsx: an unsupported compression method and a size mismatch are XlsxErrors', () => {
  const parts = mainParts(); parts[6] = { ...parts[6], method: 12 };
  assert.throws(() => readXlsx(zip(parts)), (e) => e instanceof XlsxError && /unsupported zip compression method 12/.test(e.message));
  const sized = mainParts({ deflate: true }); sized[6] = { ...sized[6], usize: 5 };
  assert.throws(() => readXlsx(zip(sized)), (e) => e instanceof XlsxError && /size mismatch inflating xl\/worksheets\/sheet1\.xml/.test(e.message));
});

test('readXlsx: a damaged central directory is an XlsxError', () => {
  const buf = Buffer.from(zip(mainParts()));
  const eocd = buf.length - 22;
  const cdStart = buf.readUInt32LE(eocd + 16);
  buf.writeUInt32LE(0xdeadbeef, cdStart); // clobber the first central-directory signature
  assert.throws(() => readXlsx(buf), (e) => e instanceof XlsxError && /corrupt central directory/.test(e.message));
  const buf2 = Buffer.from(zip(mainParts()));
  const cd2 = buf2.readUInt32LE(buf2.length - 22 + 16);
  buf2.writeUInt32LE(7, cd2 + 42); // first entry's local-header offset -> junk
  assert.throws(() => readXlsx(buf2), (e) => e instanceof XlsxError && /corrupt local header/.test(e.message));
});

// ---------------------------------------------------------------- sheetToObjects

test('sheetToObjects: header row at an offset, trimmed headers, blank headers and blank rows dropped', () => {
  const sheet = {
    name: 'T',
    rows: [
      ['Eco Pharma Report', null, null, null],
      ['As on 05/07/2026', null, null, null],
      ['  Code ', 'Name', '   ', 'Amount'],
      ['C1', 'First', 'ignored', 10.5],
      [null, null, null, null],
      ['', '', '', ''],
      ['C2', null, 'ignored', 0],
      [null, 'only name', null, null],
    ],
  };
  assert.deepEqual(sheetToObjects(sheet, { headerRow: 2 }), [
    { Code: 'C1', Name: 'First', Amount: 10.5 },
    { Code: 'C2', Name: null, Amount: 0 },
    { Code: null, Name: 'only name', Amount: null },
  ]);
  // default headerRow is 0; the title row becomes the (single) header
  assert.deepEqual(sheetToObjects({ rows: [['id', 'v'], [1, 'a'], [2, 'b']] }), [{ id: 1, v: 'a' }, { id: 2, v: 'b' }]);
  assert.deepEqual(sheetToObjects(sheet, { headerRow: 99 }), []);
  assert.deepEqual(sheetToObjects({ rows: [] }), []);
});

test('sheetToObjects: works on a sheet read from a workbook, keeping { date } cells', () => {
  const book = readXlsx(buildXlsx([{ name: 'Ledger', rows: [['Title'], ['d_date', 'n_amount', 'ok'], [{ date: '2026-04-09' }, 100.25, false], [{ date: '2026-04-10' }, 5, true]] }]));
  assert.deepEqual(sheetToObjects(book.sheets[0], { headerRow: 1 }), [
    { d_date: { date: '2026-04-09' }, n_amount: 100.25, ok: false },
    { d_date: { date: '2026-04-10' }, n_amount: 5, ok: true },
  ]);
});
