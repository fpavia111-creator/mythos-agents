// Table readers: delimiters, Excel workbooks, JSON envelopes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseCsvRows, rowsToRecords, sniffDelimiter, readTable, readRecords, readXlsx, writeXlsx, xlsxSheets, excelSerialToIso, isDateFormat, writeZip } from '../src/index.js';
import { tmp } from './helpers.js';

test('delimiter sniffing: comma unless tab, semicolon or pipe splits the lines consistently', () => {
  assert.equal(sniffDelimiter('a,b\n1,2\n'), ',');
  assert.equal(sniffDelimiter('a;b;c\n1;2;3\n4;5;6\n'), ';');
  assert.equal(sniffDelimiter('a\tb\n1\t2\n'), '\t');
  assert.equal(sniffDelimiter('a|b\n1|2\n'), '|');
  assert.equal(sniffDelimiter('name,note\n"x","a;b;c"\n'), ',', 'a semicolon inside a quoted comma file is not a delimiter');
  assert.equal(sniffDelimiter('one column\nvalue; with; semicolons\n'), ',', 'an inconsistent split is not a delimiter');
});

test('matrix parsing keeps ragged rows and rowsToRecords can start below a title block', () => {
  const m = parseCsvRows('Report title\n\nname,qty\n"Lee, A",3\n');
  assert.deepEqual(m, [['Report title'], ['name', 'qty'], ['Lee, A', '3']]);
  assert.deepEqual(rowsToRecords(m, 1), [{ name: 'Lee, A', qty: '3' }]);
  assert.deepEqual(rowsToRecords(m, 9), []);
});

test('readTable by extension: csv, tsv, semicolon, jsonl and JSON envelopes', () => {
  const d = tmp(); const w = (n, t) => { writeFileSync(join(d, n), t); return join(d, n); };
  assert.equal(readTable(w('a.csv', 'x,y\n1,2\n')).format, 'csv');
  assert.equal(readTable(w('a.tsv', 'x\ty\n1\t2\n')).format, 'tsv');
  assert.equal(readTable(w('b.csv', 'x;y\n1;2\n')).format, 'semicolon-delimited');
  assert.deepEqual(readTable(w('a.jsonl', '{"x":1}\n{"x":2}\n')).records, [{ x: 1 }, { x: 2 }]);
  for (const k of ['records', 'rows', 'data', 'items', 'CertificateSummaryList']) assert.deepEqual(readTable(w(`${k}.json`, JSON.stringify({ [k]: [{ x: 1 }], next: null }))).records, [{ x: 1 }], k);
  assert.deepEqual(readTable(w('arr.json', '[{"x":1}]')).records, [{ x: 1 }]);
  assert.throws(() => readTable(w('old.xls', 'x')), /\.xls/);
  assert.throws(() => readTable(w('a.pdf', 'x')), /use \.csv, \.tsv, \.xlsx, \.json or \.jsonl/);
  assert.deepEqual(readRecords(w('c.csv', 'x;y\n1;2\n')), [{ x: '1', y: '2' }], 'readRecords follows the sniffed delimiter');
});

test('Excel: text, numbers, booleans and dates round-trip; text is never written as a formula', () => {
  const buf = writeXlsx({ People: [['name', 'joined', 'rate', 'active', 'note'], ['Ana', new Date(Date.UTC(2026, 10, 3)), 12.5, true, '=1+1'], ['Ben', '', 0.1 + 0.2, false, '  spaced  ']] });
  assert.deepEqual(xlsxSheets(buf), ['People']);
  const r = readXlsx(buf);
  assert.equal(r.sheet, 'People');
  assert.deepEqual(r.rows, [['name', 'joined', 'rate', 'active', 'note'], ['Ana', '2026-11-03', '12.5', 'TRUE', '=1+1'], ['Ben', '', '0.3', 'FALSE', '  spaced  ']]);
  assert.doesNotMatch(buf.toString('latin1'), /<f>/, 'no formula cell is written');
});

test('Excel: sheet choice, missing sheet, date formats and serials', () => {
  const buf = writeXlsx({ Summary: [['total'], [3]], Detail: [['id'], ['a'], [''], ['b']] });
  assert.deepEqual(readXlsx(buf).rows, [['total'], ['3']]);
  assert.deepEqual(readXlsx(buf, { sheet: 'Detail' }).rows, [['id'], ['a'], ['b']], 'blank rows are dropped');
  assert.deepEqual(readXlsx(buf, { sheet: 'detail' }).sheets, ['Summary', 'Detail']);
  assert.throws(() => readXlsx(buf, { sheet: 'Nope' }), /Summary, Detail/);
  assert.equal(excelSerialToIso(46329), '2026-11-03'); assert.equal(excelSerialToIso(46329.5), '2026-11-03T12:00:00');
  assert.equal(excelSerialToIso(1, { date1904: true }), '1904-01-02');
  assert.ok(isDateFormat('yyyy-mm-dd')); assert.ok(isDateFormat('d/m/yy h:mm')); assert.ok(!isDateFormat('0.00')); assert.ok(!isDateFormat('#,##0.00 "days"'));
});

test('Excel: a file that is not a workbook fails with a plain message', () => {
  const d = tmp(); writeFileSync(join(d, 'bad.xlsx'), 'this is not a zip');
  assert.throws(() => readTable(join(d, 'bad.xlsx')), /not a zip file|not an Excel workbook/);
  writeFileSync(join(d, 'empty.xlsx'), writeZip({ 'readme.txt': 'no workbook here' }));
  assert.throws(() => readTable(join(d, 'empty.xlsx')), /workbook/i);
});
