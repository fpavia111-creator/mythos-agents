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

import { manifest, normContacts, audit, canonical, cleanupCsv, CLEANUP_COLUMNS } from '../src/index.js';

const c = (o) => ({ id: 'X', email: 'pat@example.com', name: 'Pat', last_activity: '2026-11-01', consent: 'yes', consent_date: '2026-01-01', unsubscribed: 'no', status: 'subscribed', ...o });
const one = (o, opts) => audit(normContacts([c(o)]), { as_of: '2026-11-14', ...opts }).items[0];
test('canonical: case, +tags, gmail dots', () => {
  assert.equal(canonical('J.Doe+x@GMail.com'), 'jdoe@gmail.com'); assert.equal(canonical('J.Doe+x@example.com'), 'j.doe@example.com');
});
test('clean contact is kept', () => { assert.equal(one({}).suggested_action, 'keep'); });
test('each rule', () => {
  assert.equal(one({ email: 'sales@example.com' }).suggested_action, 'review');
  assert.equal(one({ email: 'x@gmial.com' }).suggested_action, 'fix');
  assert.equal(one({ bounce: 'hard' }).suggested_action, 'suppress');
  assert.equal(one({ bounce: 'hard', last_activity: '2024-01-01' }).suggested_action, 'delete_candidate');
  assert.equal(one({ consent: '' }).suggested_action, 're_permission');
  assert.equal(one({ consent: 'no' }).suggested_action, 'suppress');
  assert.equal(one({ unsubscribed: 'yes' }).suggested_action, 'suppress');
  assert.equal(one({ email: 'bad@@x' }).suggested_action, 'suppress');
  assert.equal(one({}, { suppression: ['example.com'] }).suggested_action, 'suppress');
  assert.ok(one({ last_activity: '2025-01-01' }, { stale_days: 300 }).flags.some((f) => f.startsWith('stale_')));
});
test('duplicates merge to the first; review sheet excludes keeps', () => {
  const r = audit(normContacts([c({ id: 'A' }), c({ id: 'B', email: 'PAT+x@example.com' })]), { as_of: '2026-11-14' });
  assert.equal(r.items[1].suggested_action, 'merge'); assert.ok(r.items[1].flags.includes('duplicate_of_A'));
  const rows = parseCsv(cleanupCsv(r)); assert.equal(rows.length, 1); assert.deepEqual(Object.keys(rows[0]), CLEANUP_COLUMNS);
});
test('clean copy keeps every row; bulk delete is one-click even in Auto', async () => {
  const root = tmpRoot('nau-');
  const rt = new AgentRuntime(manifest, { root, mode: 'auto', autoActions: ['nausicaa_write_clean_copy'] });
  const w = await rt.call('nausicaa_write_clean_copy', { contacts: 'contacts.csv', as_of: '2026-11-14' });
  assert.equal(parseCsv(readFileSync(w.result.file, 'utf8')).length, 10);
  assert.equal(readFileSync(join(root, 'contacts.csv'), 'utf8'), readFileSync(join(fixtures, 'contacts.csv'), 'utf8'));
  const b = await oneClick(manifest, 'nausicaa_request_bulk_delete', { ids: ['C4'], reason: 'bounced' }, root);
  assert.equal(parseCsv(readFileSync(b.result.file, 'utf8'))[0].id, 'C4');
  assert.equal((await rt.call('crm_delete_contacts', {})).status, 'blocked');
});
