import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentRuntime, parseCsv } from 'mythos-agent-core';
import { manifest, normName, dice, findDuplicates, applyMerge } from '../src/index.js';

const fixtures = fileURLToPath(new URL('../fixtures', import.meta.url));

test('name normalization strips suffixes and punctuation', () => {
  assert.equal(normName('Acme, Inc.'), normName('ACME LLC'));
  assert.equal(normName('Café & Co'), 'cafe');
  assert.ok(dice('blue harbor logistics', 'blue harbour logistics') > 0.9);
});

test('different tax ids are not clustered even with the same name', () => {
  const r = findDuplicates([{ id: '1', name: 'Juniper Labs', taxid: '55-1112222' }, { id: '2', name: 'Juniper Labs', taxid: '55-9998888' }], { kind: 'vendor' });
  assert.equal(r.clusters, 0);
  assert.equal(r.weak_pairs.length, 1);
});

test('survivor prefers the active, fuller record', () => {
  const r = findDuplicates([{ id: 'A', name: 'Blue Harbor', taxid: '', isinactive: 'T' }, { id: 'B', name: 'Blue Harbor', taxid: '11-2223333', isinactive: 'F' }], { kind: 'vendor' });
  assert.equal(r.proposals[0].survivor, 'B');
});

test('applyMerge validates ids and never merges the survivor', () => {
  const rows = [{ id: 'A' }, { id: 'B' }];
  assert.throws(() => applyMerge(rows, { survivor: 'A', merge: ['A'] }), /survivor/);
  assert.throws(() => applyMerge(rows, { survivor: 'A', merge: ['Z'] }), /not found/);
  const r = applyMerge(rows, { survivor: 'A', merge: ['B'] });
  assert.equal(r.rows[1].merged_into, 'A'); assert.equal(rows[1].merged_into, undefined);
});

test('auto merges chain into one copy; input untouched; caps stop runaway merges', async () => {
  const root = mkdtempSync(join(tmpdir(), 'augeas-'));
  cpSync(fixtures, root, { recursive: true });
  const before = readFileSync(join(root, 'vendors.csv'), 'utf8');
  const rt = new AgentRuntime(manifest, { root, mode: 'auto', autoActions: ['augeas_apply_merge'], caps: { maxSteps: 2 } });
  assert.equal((await rt.call('augeas_apply_merge', { path: 'vendors.csv', survivor: 'V100', merge: ['V101'] })).status, 'executed');
  const second = await rt.call('augeas_apply_merge', { path: 'vendors.csv', survivor: 'V102', merge: ['V103'] });
  assert.equal(second.auto, true);
  const merged = parseCsv(readFileSync(second.result.file, 'utf8'));
  assert.equal(merged.find((r) => r.internalid === 'V101').merged_into, 'V100');
  assert.equal(merged.find((r) => r.internalid === 'V103').merged_into, 'V102');
  assert.equal(readFileSync(join(root, 'vendors.csv'), 'utf8'), before);
  const third = await rt.call('augeas_apply_merge', { path: 'vendors.csv', survivor: 'V104', merge: ['V105'] });
  assert.equal(third.status, 'blocked'); assert.match(third.reason, /step cap/);
});

test('a phone shared by thousands of rows is reported, not paired, and does not exhaust memory', () => {
  const rows = [];
  for (let i = 0; i < 2000; i++) rows.push({ internalid: `V${i}`, companyname: `Vendor ${i} ${'abcdefghij'[i % 10]}${'klmnopqrst'[Math.floor(i / 10) % 10]}${'uvwxyzabcd'[Math.floor(i / 100) % 10]} (fictional)`, taxid: '', email: `ap@v${i}.example`, phone: '000-000-0000', address: `${i} Example Way` });
  const r = findDuplicates(rows, { kind: 'vendor' });
  assert.ok(r.compared_pairs < 1000000);
  assert.ok(Array.isArray(r.not_compared) && /2000 records share one phone/.test(r.not_compared[0]));
});
