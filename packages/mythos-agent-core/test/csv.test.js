import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, toCsv, toNumber } from '../src/index.js';

test('csv round trip with quotes, commas and newlines', () => {
  const rows = [{ a: 'x, y', b: 'say "hi"', c: 'line1\nline2' }, { a: '1', b: '', c: 'z' }];
  assert.deepEqual(parseCsv(toCsv(rows)), rows);
});

test('csv strips BOM and CRLF', () => {
  assert.deepEqual(parseCsv('\ufeffid,name\r\n1,Acme\r\n'), [{ id: '1', name: 'Acme' }]);
});

test('toNumber handles money formats', () => {
  assert.equal(toNumber('$1,500.25'), 1500.25);
  assert.equal(toNumber('(200)'), -200);
  assert.equal(toNumber(''), null);
  assert.equal(toNumber('n/a'), null);
});
