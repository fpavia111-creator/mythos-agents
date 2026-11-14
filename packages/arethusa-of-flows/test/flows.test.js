import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentRuntime, ApprovalStore, parseCsv } from 'mythos-agent-core';
import { manifest, normalise, audit, findSecrets, redact, proposals } from '../src/index.js';
const fixtures = fileURLToPath(new URL('../fixtures', import.meta.url));
const J = (f) => JSON.parse(readFileSync(join(fixtures, f), 'utf8'));
const tmpRoot = (p) => { const r = mkdtempSync(join(tmpdir(), p)); cpSync(fixtures, r, { recursive: true }); return r; };
const EXPORTS = ['n8n-orders.json', 'n8n-cleanup.json', 'zapier-export.json', 'make-blueprint.json'];
const all = () => audit(EXPORTS.flatMap((f) => normalise(J(f), f)), parseCsv(readFileSync(join(fixtures, 'run-history.csv'), 'utf8')), { as_of: '2026-11-14T12:00:00Z' });
const codes = (r, name) => r.items.find((i) => i.name === name).findings.map((f) => f.code);

test('normalises n8n, Zapier and Make exports', () => {
  const flows = EXPORTS.flatMap((f) => normalise(J(f), f));
  assert.deepEqual(flows.map((f) => `${f.platform}:${f.name}`), ['n8n:Order sync', 'n8n:CRM cleanup', 'zapier:New lead to Sheets', 'zapier:Welcome email', 'zapier:Weekly invoice reminders', 'make:Refund approvals']);
  assert.equal(flows[5].steps.length, 4, 'Make router routes are flattened');
  assert.throws(() => normalise({ hello: 1 }, 'x.json'), /not an n8n workflow/);
});
test('secret detection skips expressions and short or enum values', () => {
  assert.deepEqual(findSecrets({ api_key: 'FAKE_abcdefgh', token: '={{$env.T}}', auth: 'none', password: 'short' }), ['api_key']);
  assert.deepEqual(findSecrets({ headers: [{ name: 'Authorization', value: 'Bearer FAKE-0000-0000' }, { name: 'Accept', value: 'application/json' }] }), ['headers[0].Authorization']);
  assert.deepEqual(findSecrets({ note: 'sk_' + 'live_FAKE00000000' }), ['note'], 'secret-looking value under any key');
});
test('broken findings: no trigger, disconnected, disabled, failing, silent, not running', () => {
  const r = all();
  for (const c of ['failing_runs', 'disconnected_step', 'disabled_step', 'no_error_handler']) assert.ok(codes(r, 'Order sync').includes(c), c);
  assert.ok(codes(r, 'Welcome email').includes('no_trigger') && codes(r, 'Welcome email').includes('active_but_not_running'));
  assert.ok(codes(r, 'Refund approvals').includes('last_run_failed'));
  assert.ok(!codes(r, 'CRM cleanup').includes('no_error_handler'), 'errorWorkflow set');
  assert.ok(!codes(r, 'Weekly invoice reminders').includes('active_but_not_running'), 'off flows are not expected to run');
});
test('risky findings: webhook, secrets, http, deletes, money, code; ranking', () => {
  const r = all();
  assert.deepEqual(r.items.map((i) => i.name), ['Order sync', 'Refund approvals', 'CRM cleanup', 'Welcome email', 'Weekly invoice reminders', 'New lead to Sheets']);
  assert.equal(r.items[0].findings.find((f) => f.code === 'open_webhook').severity, 'high');
  assert.ok(codes(r, 'Order sync').includes('plain_http') && codes(r, 'Order sync').includes('money_moving'));
  assert.ok(codes(r, 'CRM cleanup').includes('destructive_without_filter') && codes(r, 'CRM cleanup').includes('destructive_step') && codes(r, 'CRM cleanup').includes('code_exec'));
  assert.equal(r.by_code.hardcoded_secret, 3);
  assert.ok(!JSON.stringify(r).includes('FAKE'), 'secret values never returned');
});
test('redacted copy and proposals; inputs untouched', () => {
  const red = JSON.stringify(redact(J('make-blueprint.json'))) + JSON.stringify(redact(J('n8n-orders.json'))) + JSON.stringify(redact(J('zapier-export.json')));
  assert.ok(!red.includes('FAKE')); assert.equal((red.match(/REDACTED/g) || []).length, 3);
  assert.ok(red.includes('{{1.amount}}'), 'expressions kept');
  const p = proposals(all().items[0]); assert.equal(p.status, 'proposal - not applied'); assert.ok(p.changes.some((c) => c.code === 'open_webhook'));
});
test('drafts on Auto; production change is one-click; platform edit and run blocked', async () => {
  const root = tmpRoot('are-');
  const f = { exports: EXPORTS, history: 'run-history.csv', as_of: '2026-11-14T12:00:00Z' };
  const rt = new AgentRuntime(manifest, { root, mode: 'auto', autoActions: ['arethusa_draft_changes'] });
  const d = await rt.call('arethusa_draft_changes', f); assert.equal(d.status, 'executed'); assert.equal(d.result.files.length, 10);
  assert.equal(readFileSync(join(root, 'n8n-orders.json'), 'utf8'), readFileSync(join(fixtures, 'n8n-orders.json'), 'utf8'));
  assert.throws(() => new AgentRuntime(manifest, { audit: false, mode: 'auto', autoActions: ['arethusa_request_flow_change'] }), /one-click/);
  const args = { flow: 'Order sync', change: 'disable', detail: 'pause' };
  const a = await rt.call('arethusa_request_flow_change', args); assert.equal(a.status, 'needs_approval');
  new ApprovalStore(join(root, '.mythos')).approve(a.approval_id, 'Ari');
  const b = await rt.call('arethusa_request_flow_change', args); assert.equal(b.status, 'executed'); assert.equal(b.approved_by, 'Ari');
  assert.equal(parseCsv(readFileSync(b.result.file, 'utf8'))[0].change, 'disable');
  assert.equal((await rt.call('arethusa_request_flow_change', args)).status, 'needs_approval');
  for (const t of ['automation_update_flow', 'automation_run_flow']) assert.equal((await rt.call(t, {})).status, 'blocked');
  const w = await new AgentRuntime(manifest, { root, audit: false }).call('arethusa_write_report', f);
  const rows = parseCsv(readFileSync(w.result.files[1], 'utf8')); assert.equal(rows.length, 25); assert.equal(rows[0].owner, '');
});
