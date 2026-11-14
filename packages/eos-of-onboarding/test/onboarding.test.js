import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentRuntime, ApprovalStore, parseCsv } from 'mythos-agent-core';
import { manifest, status, validateTemplate } from '../src/index.js';
const fixtures = fileURLToPath(new URL('../fixtures', import.meta.url));
const rd = (f) => parseCsv(readFileSync(join(fixtures, f), 'utf8'));
const tpl = JSON.parse(readFileSync(join(fixtures, 'template.json'), 'utf8'));
const tmpRoot = (p) => { const r = mkdtempSync(join(tmpdir(), p)); cpSync(fixtures, r, { recursive: true }); return r; };
const as_of = '2026-11-14';
const run = (a = {}) => status(rd('people.csv'), tpl, rd('status.csv'), { as_of, ...a });
const task = (r, pid, tid) => r.items.find((p) => p.person_id === pid).tasks.find((t) => t.task_id === tid);
const person = (r, pid) => r.items.find((p) => p.person_id === pid);

test('template validation', () => {
  assert.throws(() => validateTemplate({}), /"types" object/);
  assert.throws(() => validateTemplate({ types: { x: [{ id: 'a', title: 'A', requires: ['zz'] }] } }), /unknown task "zz"/);
});
test('due dates from start date and task states', () => {
  const r = run();
  assert.equal(task(r, 'C1', 'sow').due, '2026-11-13'); assert.equal(task(r, 'C1', 'sow').state, 'overdue');
  assert.equal(task(r, 'C1', 'laptop').state, 'due_soon'); assert.equal(task(r, 'C1', 'repo').state, 'waiting'); assert.deepEqual(task(r, 'C1', 'repo').waiting_on, ['sow']);
  assert.equal(task(r, 'E1', 'crm').state, 'waiting'); assert.equal(task(r, 'E1', 'training').state, 'overdue');
  assert.equal(task(r, 'K1', 'data').state, 'open');
  assert.deepEqual([r.people, r.tasks, r.done, r.overdue, r.waiting], [5, 32, 22, 4, 2]);
  assert.deepEqual(r.unknown_status_rows, ['C3/slack']);
});
test('access risk flags', () => {
  const r = run();
  assert.deepEqual(person(r, 'C2').flags, ['access_before_prereqs', 'contractor_no_end_date']); assert.match(task(r, 'C2', 'repo').risk, /before sow/);
  assert.deepEqual(person(r, 'C3').flags, ['access_after_end']); assert.ok(task(r, 'C3', 'repo').revoke_due && task(r, 'C3', 'email').revoke_due);
  assert.deepEqual(person(r, 'C1').flags, ['not_ready_for_start']);
  assert.equal(run({ as_of: '2026-11-01' }).items.find((p) => p.person_id === 'C1').flags.length, 0, 'not flagged two weeks out');
  assert.equal(status([{ person_id: 'X', name: 'X', type: 'intern' }], tpl, [], { as_of }).items[0].flags[0], 'unknown_type');
});
test('drafts on Auto; grant and removal are one-click and re-checked; IdP blocked', async () => {
  const root = tmpRoot('eos-'); const f = { people: 'people.csv', template: 'template.json', status: 'status.csv', as_of };
  const rt = new AgentRuntime(manifest, { root, mode: 'auto', autoActions: ['eos_draft_access_requests'] });
  assert.equal((await rt.call('eos_draft_access_requests', f)).status, 'executed');
  assert.deepEqual(readdirSync(join(root, 'mythos-out/eos/access-requests')).sort(), ['C1-email-grant.md', 'C3-email-remove.md', 'C3-repo-remove.md', 'K1-portal-grant.md']);
  const g = readFileSync(join(root, 'mythos-out/eos/access-requests/C1-email-grant.md'), 'utf8');
  assert.match(g, /^DRAFT — not submitted/); assert.match(g, /Prerequisites done: nda\n/); assert.match(g, /Access end date: 2027-02-28/);
  for (const t of ['eos_request_access_grant', 'eos_request_access_removal']) assert.throws(() => new AgentRuntime(manifest, { audit: false, mode: 'auto', autoActions: [t] }), /one-click/);
  const store = new ApprovalStore(join(root, '.mythos'));
  const args = { ...f, person_id: 'C1', task_id: 'email' };
  const a = await rt.call('eos_request_access_grant', args); assert.equal(a.status, 'needs_approval'); store.approve(a.approval_id, 'Sam');
  const b = await rt.call('eos_request_access_grant', args); assert.equal(b.status, 'executed');
  assert.equal(parseCsv(readFileSync(b.result.file, 'utf8'))[0].status, 'approved - a person grants it');
  const w = { ...f, person_id: 'C1', task_id: 'repo' }; store.approve((await rt.call('eos_request_access_grant', w)).approval_id, 'Sam');
  assert.match((await rt.call('eos_request_access_grant', w)).reason, /prerequisites not done: sow/);
  const c3 = { ...f, person_id: 'C3', task_id: 'email' }; store.approve((await rt.call('eos_request_access_grant', c3)).approval_id, 'Sam');
  assert.match((await rt.call('eos_request_access_grant', c3)).reason, /already marked done/);
  const rm = { ...f, person_id: 'C3', task_id: 'repo', reason: 'Engagement ended' };
  store.approve((await rt.call('eos_request_access_removal', rm)).approval_id, 'Sam');
  const rr = await rt.call('eos_request_access_removal', rm); assert.equal(rr.status, 'executed');
  assert.equal(parseCsv(readFileSync(rr.result.file, 'utf8'))[1].action, 'remove');
  for (const t of ['idp_grant_access', 'idp_remove_access', 'send_email']) assert.equal((await rt.call(t, {})).status, 'blocked');
});
test('tracker and summary', async () => {
  const root = tmpRoot('eos-t-');
  const r = await new AgentRuntime(manifest, { root, audit: false }).call('eos_write_tracker', { people: 'people.csv', template: 'template.json', status: 'status.csv', as_of });
  const rows = parseCsv(readFileSync(r.result.files[0], 'utf8')); assert.equal(rows.length, 32); assert.equal(rows[0].checked_by, '');
  assert.match(readFileSync(r.result.files[1], 'utf8'), /not HR, employment or legal advice/);
});
