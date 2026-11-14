import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyse } from '../src/index.js';

test('1.0 detection by nlapi calls, ignoring comments', () => {
  const r = analyse('// nlapiDeleteRecord in a comment\nvar r = nlapiLoadRecord("invoice", 1);\nnlapiSubmitRecord(r);\n');
  assert.equal(r.version, '1.0');
  assert.deepEqual(Object.keys(r.calls).sort(), ['nlapiLoadRecord', 'nlapiSubmitRecord']);
  assert.ok(r.writes.includes('nlapiSubmitRecord'));
  assert.equal(r.hits[0].line, 2);
});

test('2.1 file is low risk with zero score', () => {
  const r = analyse('/**\n * @NApiVersion 2.1\n * @NScriptType UserEventScript\n */\ndefine([], () => ({}));');
  assert.equal(r.version, '2.1'); assert.equal(r.script_type, 'UserEventScript'); assert.equal(r.score, 0); assert.equal(r.risk, 'low');
});

test('2.0 and 2.x are flagged', () => {
  assert.equal(analyse('/** @NApiVersion 2.0 */').version, '2.0');
  assert.equal(analyse('/** @NApiVersion 2.x */').version, '2.x');
  assert.ok(analyse('/** @NApiVersion 2.0 */').score > analyse('/** @NApiVersion 2.x */').score);
});

test('unknown file is flagged for a manual check', () => {
  const r = analyse('console.log(1)');
  assert.equal(r.version, 'unknown');
  assert.match(r.reasons[0], /check manually/);
});

test('external calls and yields raise risk', () => {
  const a = analyse('nlapiLogExecution("DEBUG","x")');
  const b = analyse('nlapiRequestURL("https://x"); nlapiYieldScript();');
  assert.ok(b.score > a.score);
  assert.equal(b.risk, 'high');
});
