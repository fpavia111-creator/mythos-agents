import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentRuntime, ApprovalStore, parseCsv } from 'mythos-agent-core';
const fixtures = fileURLToPath(new URL('../fixtures', import.meta.url));

import { manifest } from '../src/index.js';
import { checkDraft, checkBatch, inWindow, nextWindow, suppressionSet, words, DEFAULTS } from '../src/gate.js';

const cfg = JSON.parse(readFileSync(join(fixtures, 'eucleia.json'), 'utf8'));
const good = { to: 'a@b.example', subject: 'Quick idea', body: 'Hi there.', send_at: '2026-11-17T15:00:00Z' };

test('defaults are the stated limits', () => {
  assert.equal(DEFAULTS.max_subject_chars, 30); assert.equal(DEFAULTS.max_body_words, 100); assert.deepEqual(DEFAULTS.days, ['Tue', 'Wed']);
});
test('send window is Tue/Wed in America/Chicago, across DST', () => {
  assert.equal(inWindow('2026-11-17T15:00:00Z').ok, true);   // Tue 9:00 CST
  assert.equal(inWindow('2026-11-17T13:00:00Z').ok, false);  // Tue 7:00 CST
  assert.equal(inWindow('2026-11-20T16:00:00Z').ok, false);  // Fri
  assert.equal(inWindow('2026-07-14T13:00:00Z').ok, true);   // Tue 8:00 CDT
  assert.equal(nextWindow('2026-11-20T16:00:00Z'), '2026-11-24T14:00:00.000Z');
});
test('boundaries: 29 chars ok, 30 holds; 99 words ok, 100 holds', () => {
  assert.equal(checkDraft({ ...good, subject: 'x'.repeat(29) }, { config: cfg }).ok, true);
  assert.equal(checkDraft({ ...good, subject: 'x'.repeat(30) }, { config: cfg }).ok, false);
  assert.equal(checkDraft({ ...good, body: 'w '.repeat(99) }, { config: cfg }).ok, true);
  assert.equal(checkDraft({ ...good, body: 'w '.repeat(100) }, { config: cfg }).ok, false);
  assert.equal(words('  a  b\nc '), 3);
});
test('suppression by email and by domain; missing footer holds', () => {
  const s = suppressionSet([{ email: 'x@y.example' }, { domain: 'blocked.example' }]);
  assert.match(checkDraft({ ...good, to: 'X@Y.example' }, { suppression: s, config: cfg }).fails.join(), /suppressed/);
  assert.match(checkDraft({ ...good, to: 'z@blocked.example' }, { suppression: s, config: cfg }).fails.join(), /suppressed/);
  const r = checkDraft(good, {});
  assert.equal(r.ok, false); assert.ok(r.fails.some((f) => /postal/.test(f))); assert.ok(r.fails.some((f) => /unsubscribe/i.test(f)));
});
test('fake RE: on a cold email holds; batch holds duplicates', () => {
  assert.equal(checkDraft({ ...good, subject: 'RE: hi' }, { config: cfg }).ok, false);
  assert.equal(checkDraft({ ...good, subject: 'RE: hi', is_reply: true }, { config: cfg }).ok, true);
  const b = checkBatch([good, good], { config: cfg });
  assert.equal(b.ready, 1); assert.equal(b.held, 1);
});
test('send stays blocked and release stays one-click even in Auto', async () => {
  assert.throws(() => new AgentRuntime(manifest, { audit: false, mode: 'auto', autoActions: ['eucleia_release_batch'] }), /one-click/);
  const root = mkdtempSync(join(tmpdir(), 'eucleia-'));
  for (const f of ['drafts.csv', 'eucleia.json', 'suppression.csv']) writeFileSync(join(root, f), readFileSync(join(fixtures, f)));
  const rt = new AgentRuntime(manifest, { root, mode: 'auto', autoActions: ['eucleia_add_suppression'] });
  assert.equal((await rt.call('eucleia_send_email', {})).status, 'blocked');
  const args = { drafts: 'drafts.csv', config: 'eucleia.json', suppression: 'suppression.csv' };
  const a = await rt.call('eucleia_release_batch', args);
  assert.equal(a.status, 'needs_approval');
  new ApprovalStore(join(root, '.mythos')).approve(a.approval_id, 'Dana');
  const b = await rt.call('eucleia_release_batch', args);
  assert.equal(b.status, 'executed'); assert.equal(b.approved_by, 'Dana');
  assert.match(JSON.stringify(b.result), /sent nothing|Nothing was sent/i);
  const s = await rt.call('eucleia_add_suppression', { suppression: 'suppression.csv', email: 'new@x.example' });
  assert.equal(s.status, 'executed'); assert.match(readFileSync(join(root, 'suppression.csv'), 'utf8'), /new@x\.example/);
});
