import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentRuntime } from 'mythos-agent-core';
import { compareExports, tieOutBalances, manifest } from '../src/index.js';

test('clean books are clean but go-live still not approved', () => {
  const rows = [{ externalid: 'A', amount: '10' }, { externalid: 'B', amount: '5' }];
  const r = compareExports(rows, rows.map((x) => ({ ...x })), {});
  assert.equal(r.status, 'clean');
  assert.equal(r.go_live, 'not_approved');
});

test('detects missing, extra, duplicate keys and total differences', () => {
  const s = [{ id: '1', amount: '100' }, { id: '2', amount: '50' }];
  const t = [{ id: '1', amount: '100' }, { id: '3', amount: '50' }, { id: '3', amount: '50' }];
  const r = compareExports(s, t, { amount_column: 'amount' });
  assert.deepEqual(r.missing_in_target, ['2']);
  assert.deepEqual(r.extra_in_target, ['3']);
  assert.ok(r.findings.some((f) => f.code === 'duplicate_keys_target' && f.severity === 'blocking'));
  assert.equal(r.totals.difference, -50);
});

test('numeric formats compare by value, not text', () => {
  const r = compareExports([{ id: '1', amount: '$1,200.00' }], [{ id: '1', amount: '1200' }], {});
  assert.equal(r.counts.field_mismatches, 0);
});

test('missing key column is an error, not a guess', () => {
  assert.throws(() => compareExports([{ foo: 1 }], [{ foo: 1 }], {}), /key column/);
});

test('trial balance never invents a missing balance', () => {
  const r = tieOutBalances([{ account: '1000', balance: '25' }], [{ account: '1000', balance: '' }]);
  assert.equal(r.status, 'blocking');
  assert.equal(r.not_tied[0].target, null);
  assert.equal(r.not_tied[0].state, 'missing_or_unknown');
});

test('report tool writes files and blocks go-live in every mode', async () => {
  const root = mkdtempSync(join(tmpdir(), 'olympus-'));
  cpSync(fileURLToPath(new URL('../fixtures', import.meta.url)), root, { recursive: true });
  const rt = new AgentRuntime(manifest, { root });
  const r = await rt.call('olympus_readiness_report', { source: 'source-open-invoices.csv', target: 'netsuite-sandbox-open-invoices.csv', key: 'externalid', amount_column: 'amount' });
  assert.equal(r.status, 'executed');
  const md = readFileSync(r.result.files[0], 'utf8');
  assert.match(md, /Go-live: \*\*not approved/);
  assert.match(md, /INV-1041/);
  for (const mode of ['review', 'assist', 'auto']) {
    const x = new AgentRuntime(manifest, { root, audit: false, mode });
    assert.equal((await x.call('olympus_approve_go_live', {})).status, 'blocked');
  }
});
