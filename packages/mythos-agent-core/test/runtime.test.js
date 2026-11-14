import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { AgentRuntime, readAudit, verifyChain, ApprovalStore } from '../src/index.js';
import { sampleManifest, tmp } from './helpers.js';

test('allow runs, unknown tool blocks', async () => {
  const rt = new AgentRuntime(sampleManifest(), { audit: false });
  assert.equal((await rt.call('read_thing', { x: 1 })).status, 'executed');
  const r = await rt.call('rm_rf', {});
  assert.equal(r.status, 'blocked');
  assert.match(r.reason, /allowlist/);
});

test('assist: ask returns approval id, approval runs it once', async () => {
  const dir = tmp();
  const rt = new AgentRuntime(sampleManifest(), { root: dir });
  const r1 = await rt.call('write_thing', { a: 1 });
  assert.equal(r1.status, 'needs_approval');
  assert.match(r1.approval_id, /^[a-f0-9]{16}$/);
  new ApprovalStore(join(dir, '.mythos')).approve(r1.approval_id, 'Kurt Francisco');
  const r2 = await rt.call('write_thing', { a: 1 });
  assert.equal(r2.status, 'executed');
  assert.equal(r2.approved_by, 'Kurt Francisco');
  assert.equal((await rt.call('write_thing', { a: 1 })).status, 'needs_approval', 'approval is single-use');
  assert.equal((await rt.call('write_thing', { a: 2 })).status, 'needs_approval', 'approval is bound to args');
});

test('approval needs a named human', () => {
  assert.throws(() => new ApprovalStore(null).approve('0123456789abcdef', ''), /named human/);
});

test('review mode blocks writes', async () => {
  const rt = new AgentRuntime(sampleManifest(), { audit: false, mode: 'review' });
  assert.equal((await rt.call('write_thing', {})).status, 'blocked');
  assert.equal((await rt.call('read_thing', {})).status, 'executed');
});

test('auto is off by default and opt-in per action', async () => {
  const off = new AgentRuntime(sampleManifest(), { audit: false, mode: 'auto' });
  assert.equal((await off.call('write_thing', {})).status, 'needs_approval');
  const on = new AgentRuntime(sampleManifest(), { audit: false, mode: 'auto', autoActions: ['write_thing'] });
  const r = await on.call('write_thing', {});
  assert.equal(r.status, 'executed');
  assert.equal(r.auto, true);
});

test('auto never upgrades one-click or block', async () => {
  assert.throws(() => new AgentRuntime(sampleManifest(), { audit: false, mode: 'auto', autoActions: ['revoke'] }), /one-click/);
  assert.throws(() => new AgentRuntime(sampleManifest(), { audit: false, mode: 'auto', autoActions: ['go_live'] }), /one-click/);
  const rt = new AgentRuntime(sampleManifest(), { audit: false, mode: 'auto', autoActions: ['write_thing'] });
  assert.equal((await rt.call('revoke', {})).status, 'needs_approval');
  assert.equal((await rt.call('go_live', {})).status, 'blocked');
  assert.equal((await rt.call('post_tweet', {})).status, 'blocked');
});

test('step and spend caps stop the run', async () => {
  const rt = new AgentRuntime(sampleManifest(), { audit: false, caps: { maxSteps: 2, maxSpendUsd: 100 } });
  await rt.call('read_thing'); await rt.call('read_thing');
  const r = await rt.call('read_thing');
  assert.equal(r.status, 'blocked'); assert.match(r.reason, /step cap/);
  const rt2 = new AgentRuntime(sampleManifest(), { audit: false, caps: { maxSpendUsd: 3 } });
  assert.equal((await rt2.call('pricey')).status, 'executed');
  assert.match((await rt2.call('pricey')).reason, /spend cap/);
});

test('kill switch: method, file and env', async () => {
  const rt = new AgentRuntime(sampleManifest(), { audit: false });
  rt.kill();
  assert.equal((await rt.call('read_thing')).status, 'blocked');
  const dir = tmp();
  mkdirSync(join(dir, '.mythos'), { recursive: true });
  writeFileSync(join(dir, '.mythos', 'KILL'), 'x');
  const rt2 = new AgentRuntime(sampleManifest(), { root: dir });
  assert.match((await rt2.call('read_thing')).reason, /Kill switch/);
  process.env.MYTHOS_KILL = '1';
  try { assert.equal((await new AgentRuntime(sampleManifest(), { audit: false }).call('read_thing')).status, 'blocked'); }
  finally { delete process.env.MYTHOS_KILL; }
});

test('audit log is JSONL with a verifiable hash chain', async () => {
  const dir = tmp();
  const rt = new AgentRuntime(sampleManifest(), { root: dir });
  await rt.call('read_thing', { x: 'secret-value' });
  await rt.call('go_live', {});
  await rt.call('write_thing', {});
  const file = join(dir, '.mythos', 'audit.jsonl');
  const entries = readAudit(file);
  assert.equal(entries.length, 3);
  assert.deepEqual(entries.map((e) => e.status), ['executed', 'blocked', 'needs_approval']);
  assert.equal(entries[0].type, 'agent-action');
  assert.ok(!JSON.stringify(entries).includes('secret-value'), 'args are hashed, not stored');
  assert.equal(verifyChain(entries).ok, true);
  entries[1].decision = 'allow';
  assert.equal(verifyChain(entries).ok, false);
  assert.equal(verifyChain([entries[0], entries[2]]).ok, false);
});

test('paths outside root are refused', async () => {
  const m = sampleManifest();
  const rt = new AgentRuntime(m, { audit: false, root: tmp() });
  assert.throws(() => rt.context().path('../../etc/passwd'), /outside/);
});
