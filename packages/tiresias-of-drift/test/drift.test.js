import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentRuntime, ApprovalStore, parseCsv } from 'mythos-agent-core';
const fixtures = fileURLToPath(new URL('../fixtures', import.meta.url));
const tmpRoot = (p) => { const r = mkdtempSync(join(tmpdir(), p)); cpSync(fixtures, r, { recursive: true }); return r; };
async function oneClick(manifest, tool, args, root) {
  assert.throws(() => new AgentRuntime(manifest, { audit: false, mode: 'auto', autoActions: [tool] }), /one-click/);
  const rt = new AgentRuntime(manifest, { root, mode: 'auto' });
  const a = await rt.call(tool, args); assert.equal(a.status, 'needs_approval');
  new ApprovalStore(join(root, '.mythos')).approve(a.approval_id, 'Dana');
  const b = await rt.call(tool, args); assert.equal(b.status, 'executed'); assert.equal(b.approved_by, 'Dana');
  const again = await rt.call(tool, args); assert.equal(again.status, 'needs_approval', 'approval is single-use');
  return b;
}

import { manifest, loadSnapshot, flatten, diff, revertPlan } from '../src/index.js';

const snap = (data) => ({ kind: 'config', data: flatten(data) });
test('flatten nests and keeps scalar arrays as values', () => {
  assert.deepEqual(flatten({ a: { b: 1, c: [1, 2] }, d: [{ e: 1 }] }), { 'a.b': 1, 'a.c': '[1,2]', 'd[0].e': 1 });
});
test('risk rules: tls off, open cors, debug on, secret masked, removal, ignore', () => {
  const d = diff(snap({ tls: { verify: true }, cors: '[]', debug: false, db_password: 'p1', keep: 1, meta: { t: 1 } }), snap({ tls: { verify: false }, cors: '*', debug: true, db_password: 'p2', meta: { t: 2 } }), { ignore: ['meta.*'] });
  const by = Object.fromEntries(d.items.map((i) => [i.key, i]));
  assert.equal(by['tls.verify'].risk, 'high'); assert.equal(by.cors.risk, 'high'); assert.equal(by.debug.risk, 'high');
  assert.equal(by.db_password.risk, 'high'); assert.ok(!JSON.stringify(d).includes('p1') && !JSON.stringify(d).includes('p2'));
  assert.equal(by.keep.change, 'removed'); assert.ok(!by['meta.t']);
});
test('.env snapshots and schema CSV', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tir-'));
  writeFileSync(join(dir, 'a.env'), '# c\nPORT=80\nAPI_TOKEN="x1"\n'); writeFileSync(join(dir, 'b.env'), 'export PORT=8080\nAPI_TOKEN=x2\nNEW=1\n');
  const d = diff(loadSnapshot(join(dir, 'a.env')), loadSnapshot(join(dir, 'b.env')));
  assert.equal(d.changes, 3); assert.ok(!JSON.stringify(d).includes('x1'));
  assert.throws(() => diff(loadSnapshot(join(dir, 'a.env')), loadSnapshot(join(fixtures, 'schema-2026-10-01.csv'))), /cannot compare/);
});
test('revert plan restores before-values; secrets become placeholders', () => {
  const d = diff(snap({ a: 1, api_key: 'k' }), snap({ a: 2, api_key: 'z', extra: 1 }));
  const p = Object.fromEntries(revertPlan(d).map((s) => [s.key, s]));
  assert.equal(p.a.to, 1); assert.equal(p.extra.action, 'remove'); assert.match(p.api_key.to, /secret store/);
});
test('apply to production is one-click even in Auto; push blocked', async () => {
  const root = tmpRoot('tir-');
  const b = await oneClick(manifest, 'tiresias_apply_fix', { environment: 'production', keys: ['server.debug'], reason: 'revert', before: 'snapshots/2026-10-01.json', after: 'snapshots/2026-11-01.json' }, root);
  const body = JSON.parse(readFileSync(b.result.file, 'utf8')); assert.equal(body.steps[0].key, 'server.debug'); assert.equal(body.steps[0].to, false);
  assert.equal((await new AgentRuntime(manifest, { root, mode: 'auto' }).call('production_push_config', {})).status, 'blocked');
});
