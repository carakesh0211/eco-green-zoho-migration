import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, detectEncoding, decode, CsvParseError } from '../src/core/csv.js';

test('parses a simple CSV with header and rows', () => {
  const { header, rows } = parseCsv('a,b,c\n1,2,3\n4,5,6\n');
  assert.deepEqual(header, ['a', 'b', 'c']);
  assert.deepEqual(rows, [['1', '2', '3'], ['4', '5', '6']]);
});

test('tolerates a missing trailing newline', () => {
  const { header, rows } = parseCsv('a,b\n1,2');
  assert.deepEqual(header, ['a', 'b']);
  assert.deepEqual(rows, [['1', '2']]);
});

test('tolerates a trailing newline without adding a spurious empty row', () => {
  const { rows } = parseCsv('a,b\n1,2\n');
  assert.equal(rows.length, 1);
});

test('handles quoted fields with embedded commas', () => {
  const { rows } = parseCsv('a,b\n"1,2",3\n');
  assert.deepEqual(rows, [['1,2', '3']]);
});

test('handles doubled quotes as an escaped literal quote', () => {
  const { rows } = parseCsv('a\n"she said ""hi"""\n');
  assert.deepEqual(rows, [['she said "hi"']]);
});

test('handles embedded newlines inside quoted fields (LF)', () => {
  const { rows } = parseCsv('a,b\n"line1\nline2",x\n');
  assert.deepEqual(rows, [['line1\nline2', 'x']]);
});

test('handles CRLF line endings', () => {
  const { header, rows } = parseCsv('a,b\r\n1,2\r\n3,4\r\n');
  assert.deepEqual(header, ['a', 'b']);
  assert.deepEqual(rows, [['1', '2'], ['3', '4']]);
});

test('handles bare CR line endings', () => {
  const { header, rows } = parseCsv('a,b\r1,2\r3,4\r');
  assert.deepEqual(header, ['a', 'b']);
  assert.deepEqual(rows, [['1', '2'], ['3', '4']]);
});

test('handles embedded CRLF inside a quoted field, normalised to \\n', () => {
  const { rows } = parseCsv('a\n"line1\r\nline2"\n');
  assert.deepEqual(rows, [['line1\nline2']]);
});

test('supports a configurable delimiter', () => {
  const { header, rows } = parseCsv('a;b;c\n1;2;3\n', { delimiter: ';' });
  assert.deepEqual(header, ['a', 'b', 'c']);
  assert.deepEqual(rows, [['1', '2', '3']]);
});

test('strips a leading BOM character defensively', () => {
  const { header } = parseCsv('﻿a,b\n1,2\n');
  assert.deepEqual(header, ['a', 'b']);
});

test('throws CsvParseError with the correct line number for a ragged (short) row', () => {
  // header = line 1, row1 = line 2 (ok), row2 = line 3 (ragged: 2 fields vs 3)
  assert.throws(
    () => parseCsv('a,b,c\n1,2,3\n4,5\n'),
    (err) => {
      assert.ok(err instanceof CsvParseError);
      assert.equal(err.code, 'CSV_PARSE');
      assert.equal(err.line, 3);
      return true;
    },
  );
});

test('throws CsvParseError with the correct line number for a ragged (long) row', () => {
  assert.throws(
    () => parseCsv('a,b\n1,2\n3,4,5\n'),
    (err) => {
      assert.equal(err.code, 'CSV_PARSE');
      assert.equal(err.line, 3);
      return true;
    },
  );
});

test('reports the row-start line for a ragged row that follows an embedded-newline field', () => {
  // header line 1; row starting at line 2 spans to line 3 via the embedded newline
  // (fields: "l1\nl2", "x" -> ok, 2 fields); next row at line 4 is ragged (1 field).
  assert.throws(
    () => parseCsv('a,b\n"l1\nl2",x\nonly-one-field\n'),
    (err) => {
      assert.equal(err.code, 'CSV_PARSE');
      assert.equal(err.line, 4);
      return true;
    },
  );
});

test('throws CsvParseError for an unterminated quoted field', () => {
  assert.throws(
    () => parseCsv('a,b\n"unterminated,x\n'),
    (err) => {
      assert.ok(err instanceof CsvParseError);
      assert.equal(err.code, 'CSV_PARSE');
      return true;
    },
  );
});

test('returns empty header/rows for an empty file', () => {
  assert.deepEqual(parseCsv(''), { header: [], rows: [] });
});

// --- detectEncoding ---

test('detectEncoding recognises a UTF-8 BOM', () => {
  const buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('a,b\n1,2\n', 'utf8')]);
  assert.equal(detectEncoding(buf), 'utf-8-bom');
});

test('detectEncoding recognises a UTF-16LE BOM', () => {
  const buf = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('a,b\n', 'utf16le')]);
  assert.equal(detectEncoding(buf), 'utf-16le');
});

test('detectEncoding recognises plain valid UTF-8 with no BOM', () => {
  const buf = Buffer.from('branch_code,ledger_code\nPILOT01,LEDG-1001\n', 'utf8');
  assert.equal(detectEncoding(buf), 'utf-8');
});

test('detectEncoding returns unknown for invalid UTF-8 byte sequences', () => {
  const buf = Buffer.from([0x61, 0xff, 0xfe + 1, 0x62, 0x80, 0x81]); // not a BOM, not valid UTF-8/UTF-16LE-BOM
  // craft bytes that are definitely invalid UTF-8: a lone continuation byte at the start
  const invalid = Buffer.from([0x80, 0x81, 0x82, 0xff]);
  assert.equal(detectEncoding(invalid), 'unknown');
});

test('decode strips a UTF-8 BOM and returns clean text', () => {
  const buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('a,b\n1,2\n', 'utf8')]);
  const text = decode(buf, 'utf-8-bom');
  assert.equal(text, 'a,b\n1,2\n');
  assert.notEqual(text.charCodeAt(0), 0xfeff);
});

test('decode handles utf-16le', () => {
  const buf = Buffer.from('hello', 'utf16le');
  assert.equal(decode(buf, 'utf-16le'), 'hello');
});

test('decode handles plain utf-8', () => {
  const buf = Buffer.from('hello,world\n', 'utf8');
  assert.equal(decode(buf, 'utf-8'), 'hello,world\n');
});

test('decode throws for an unsupported encoding', () => {
  assert.throws(() => decode(Buffer.from('x'), 'unknown'));
});
