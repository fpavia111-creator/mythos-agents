import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentRuntime, ApprovalStore, parseCsv, validate, validateIcs, readAudit, sha256, createMcpHandler } from 'mythos-agent-core';
import { manifest, status, offboarding, ownerActions, readiness, checklistFor, validateTemplate, TEMPLATE_SCHEMA } from '../src/index.js';

const fixtures = fileURLToPath(new URL('../fixtures', import.meta.url));
const rd = (f) => parseCsv(readFileSync(join(fixtures, f), 'utf8'));
const js = (f) => JSON.parse(readFileSync(join(fixtures, f), 'utf8'));
const tpl = js('template.json'); const roles = js('template-roles.json');
const tmpRoot = (p) => { const r = mkdtempSync(join(tmpdir(), p)); cpSync(fixtures, r, { recursive: true }); return r; };
const as_of = '2026-11-14';
const F = { people: 'people.csv', template: 'template.json', status: 'status.csv', as_of };
const person = (r, id) => r.items.find((p) => p.person_id === id);

test('per-role templates: the role selects the checklist, unknown roles are flagged', () => {
  const r = status(rd('people.csv'), roles, rd('status.csv'), { as_of });
  assert.equal(person(r, 'C1').role_template, 'Front-end developer'); assert.ok(person(r, 'C1').tasks.some((t) => t.task_id === 'ci'));
  assert.deepEqual(person(r, 'C1').tasks.find((t) => t.task_id === 'ci').waiting_on, ['sow']);
  const c2 = person(r, 'C2'); assert.ok(!c2.tasks.some((t) => t.task_id === 'repo'), 'copywriter role removes repo'); assert.ok(c2.tasks.some((t) => t.task_id === 'cms'));
  assert.ok(c2.flags.includes('access_outside_role')); assert.match(c2.notes[0], /GitHub access is marked granted, but the Copywriter role does not include it/);
  assert.ok(person(r, 'E1').tasks.some((t) => t.task_id === 'quota'));
  assert.deepEqual(person(r, 'C3').flags, ['unknown_role', 'access_after_end']); assert.match(person(r, 'C3').notes[0], /Role "Designer" has no role template/);
  assert.equal(person(r, 'K1').flags.length, 0);
  assert.deepEqual(r.unknown_status_rows, ['C3/slack']);
  assert.equal(checklistFor(roles, 'employee', 'copywriter').role_known, false, 'a contractor role does not apply to an employee');
  assert.equal(checklistFor(roles, 'contractor', '  front-END developer ').role_template, 'Front-end developer', 'case and spacing do not matter');
  assert.equal(checklistFor(tpl, 'contractor', 'anything').role_known, true, 'no roles section: nothing flagged');
  assert.throws(() => validateTemplate({ ...roles, roles: { X: { type: 'contractor', remove: ['nope'] } } }), /remove names unknown task "nope"/);
  assert.throws(() => validateTemplate({ ...roles, roles: { X: { type: 'robot' } } }), /"robot" is not a type/);
  assert.throws(() => validateTemplate({ ...roles, roles: { X: { type: 'customer', add: [{ id: 'z', title: 'Z', requires: ['nda'] }] } } }), /requires unknown task "nda"/);
});

test('offboarding mirror: the end date drives removal and return tasks', () => {
  const r = offboarding(rd('people.csv'), tpl, rd('status.csv'), { as_of });
  assert.equal(r.people, 1); const c3 = r.items[0]; assert.equal(c3.person_id, 'C3'); assert.equal(c3.days_to_end, -14);
  assert.deepEqual(c3.tasks.map((t) => [t.task_id, t.state, t.due]), [['return-laptop', 'done', '2026-10-31'], ['remove-email', 'overdue', '2026-10-31'], ['remove-repo', 'overdue', '2026-10-31'], ['exit-call', 'overdue', '2026-10-31'], ['final-invoice', 'due_soon', '2026-11-14']]);
  assert.deepEqual(c3.flags, ['access_removal_overdue']); assert.equal(r.removals_overdue, 2);
  // An upcoming end date inside the window: removals are open, not overdue, and only for what was granted.
  const people = [{ person_id: 'E9', name: 'Avery Test', type: 'employee', role: 'Analyst', manager: 'Ana Wu', start_date: '2026-01-05', end_date: '2026-11-20' }];
  const rows = ['offer', 'nda', 'payroll', 'laptop', 'email', 'training'].map((t) => ({ person_id: 'E9', task_id: t, status: 'done' }));
  const up = offboarding(people, tpl, rows, { as_of });
  assert.deepEqual(up.items[0].tasks.map((t) => [t.task_id, t.state]), [['return-laptop', 'open'], ['remove-email', 'open'], ['final-pay', 'open'], ['exit-interview', 'open']]);
  assert.equal(offboarding(people, tpl, rows, { as_of, window_days: 3 }).people, 0, 'outside the window');
  assert.equal(offboarding(people, { ...tpl, offboarding_access_offset_days: -1 }, rows, { as_of }).items[0].tasks.find((t) => t.task_id === 'remove-email').due, '2026-11-19');
  const closed = offboarding(rd('people.csv'), tpl, [...rd('status.csv'), ...['remove-email', 'remove-repo', 'exit-call', 'final-invoice'].map((t) => ({ person_id: 'C3', task_id: t, status: 'done' }))], { as_of });
  assert.equal(closed.people, 0, 'a past end date drops out once everything is done');
});

test('offboarding drafts on Auto; removal stays one-click and is recorded only after a named click', async () => {
  const root = tmpRoot('eos-off-'); const rt = new AgentRuntime(manifest, { root, mode: 'auto', autoActions: ['eos_draft_offboarding'] });
  const d = await rt.call('eos_draft_offboarding', F); assert.equal(d.status, 'executed', d.reason);
  assert.deepEqual(readdirSync(join(root, 'mythos-out/eos/offboarding')).sort(), ['C3-email-remove.md', 'C3-offboarding.md', 'C3-repo-remove.md']);
  const draft = readFileSync(join(root, 'mythos-out/eos/offboarding/C3-repo-remove.md'), 'utf8');
  assert.match(draft, /^DRAFT — not submitted\. Eos does not remove access\./); assert.match(draft, /Engagement ended: 2026-10-31/);
  assert.throws(() => new AgentRuntime(manifest, { audit: false, mode: 'auto', autoActions: ['eos_request_access_removal'] }), /one-click/);
  const args = { ...F, person_id: 'C3', task_id: 'email', reason: 'Offboarding: engagement ended 2026-10-31' };
  const a = await rt.call('eos_request_access_removal', args); assert.equal(a.status, 'needs_approval'); assert.match(a.reason, /one-click/);
  new ApprovalStore(join(root, '.mythos')).approve(a.approval_id, 'Sam');
  const b = await rt.call('eos_request_access_removal', args); assert.equal(b.status, 'executed'); assert.equal(b.approved_by, 'Sam');
  assert.equal(parseCsv(readFileSync(b.result.file, 'utf8'))[0].status, 'approved - a person removes it');
  assert.equal((await rt.call('idp_remove_access', {})).status, 'blocked');
  // An upcoming end date says "ends" and when.
  writeFileSync(join(root, 'people2.csv'), 'person_id,name,type,role,manager,start_date,end_date\nE9,Avery Test,employee,Analyst,Ana Wu,2026-01-05,2026-11-20\n');
  writeFileSync(join(root, 'status2.csv'), 'person_id,task_id,status\nE9,nda,done\nE9,email,done\n');
  const d2 = await rt.call('eos_draft_offboarding', { people: 'people2.csv', template: 'template.json', status: 'status2.csv', as_of, out_dir: 'mythos-out/e2' });
  assert.match(readFileSync(join(root, 'mythos-out/e2/offboarding/E9-email-remove.md'), 'utf8'), /Engagement ends: 2026-11-20 \(remove access on that date, not before\)/);
  assert.equal(d2.status, 'executed');
});

test('owner action list: removals first, every item has a reason', () => {
  const st = status(rd('people.csv'), tpl, rd('status.csv'), { as_of });
  const r = ownerActions(st, offboarding(rd('people.csv'), tpl, rd('status.csv'), { as_of }));
  assert.deepEqual(r.items.slice(0, 3).map((x) => `${x.person_id}/${x.task_id}`), ['C3/remove-email', 'C3/remove-repo', 'C2/sow']);
  assert.match(r.items[0].reason, /access still granted overdue by 14 day\(s\)/);
  const it = r.owners.find((o) => o.owner === 'IT'); assert.deepEqual([it.open, it.overdue], [6, 2]);
  assert.ok(r.items.some((x) => x.task_id === 'laptop' && /needed before Jordan Lee starts on 2026-11-16/.test(x.reason)));
  assert.ok(r.items.every((x) => x.reason && x.owner));
  assert.equal(r.actions, 14);
});

test('readiness report: blocking items listed, JSON hash in the audit log', async () => {
  const st = status(rd('people.csv'), tpl, rd('status.csv'), { as_of });
  const r = readiness(st, {}); assert.deepEqual([r.people, r.ready], [1, 0]);
  assert.match(r.items[0].blocking.join(' '), /Statement of work signed: overdue, owner Ops/);
  const k1 = readiness(st, { person_ids: ['K1', 'E1'] }); assert.equal(k1.people, 2);
  const root = tmpRoot('eos-ready-'); const rt = new AgentRuntime(manifest, { root });
  const out = await rt.call('eos_readiness_report', F); assert.equal(out.status, 'executed', out.reason);
  const json = readFileSync(join(root, 'mythos-out/eos/readiness/readiness.json'), 'utf8');
  assert.equal(sha256(json), out.result.output_sha256);
  assert.equal(readAudit(join(root, '.mythos/audit.jsonl')).find((e) => e.tool === 'eos_readiness_report').output_sha256, out.result.output_sha256);
  const html = readFileSync(out.result.files[0], 'utf8'); assert.match(html, /not ready/); assert.ok(!/<script/i.test(html)); assert.match(html, /Not HR, employment or legal advice/);
  const again = await rt.call('eos_readiness_report', { ...F, out_dir: 'mythos-out/r2' }); assert.equal(again.result.output_sha256, out.result.output_sha256, 'deterministic');
});

test('tracker also writes owner actions and a valid calendar', async () => {
  const root = tmpRoot('eos-trk-');
  const r = await new AgentRuntime(manifest, { root, audit: false }).call('eos_write_tracker', F);
  assert.equal(r.result.files.length, 4);
  const acts = parseCsv(readFileSync(r.result.files[2], 'utf8')); assert.equal(acts[0].task_id, 'remove-email'); assert.equal(acts[0].done_by, '');
  const v = validateIcs(readFileSync(r.result.files[3], 'utf8')); assert.ok(v.ok, v.errors.join('; ')); assert.equal(v.events, 14);
});

test('template config schema: unknown key, wrong type and missing types fail with JSON pointers', async () => {
  assert.ok(validate(TEMPLATE_SCHEMA, tpl).ok); assert.ok(validate(TEMPLATE_SCHEMA, roles).ok);
  const root = tmpRoot('eos-cfg-'); const rt = new AgentRuntime(manifest, { root, audit: false });
  const bad = {
    't1.json': [{ ...tpl, types: { ...tpl.types, contractor: [{ ...tpl.types.contractor[0], requries: ['w9'] }] } }, /\/types\/contractor\/0\/requries is not an allowed property/],
    't2.json': [{ ...tpl, types: { ...tpl.types, contractor: [{ ...tpl.types.contractor[0], due_offset_days: '-3' }] } }, /\/types\/contractor\/0\/due_offset_days expected integer, got string/],
    't3.json': [{ name: 'x', roles: {} }, /\/types is required/],
  };
  for (const [f, [cfg, re]] of Object.entries(bad)) {
    writeFileSync(join(root, f), JSON.stringify(cfg));
    const r = await rt.call('eos_status', { ...F, template: f });
    assert.equal(r.status, 'error', f); assert.match(r.reason, re); assert.match(r.reason, /is not a valid template/);
  }
  writeFileSync(join(root, 'kind.json'), JSON.stringify({ types: { x: [{ id: 'a', title: 'A', kind: 'acess' }] } }));
  assert.match((await rt.call('eos_status', { ...F, template: 'kind.json' })).reason, /\/types\/x\/0\/kind must be one of/);
});

test('MCP prompt walks onboarding and offboarding and leaves access changes to a person', async () => {
  const p = manifest.prompts.find((x) => x.name === 'run_onboarding'); assert.ok(p);
  for (const t of ['eos_status', 'eos_readiness_report', 'eos_owner_actions', 'eos_offboarding', 'eos_draft_offboarding', 'eos_request_access_grant', 'eos_request_access_removal']) assert.ok(p.text.includes(t), t);
  assert.match(p.text, /Never approve on their behalf/);
  const tools = Object.fromEntries(new AgentRuntime(manifest, { root: fixtures, audit: false }).listTools().map((t) => [t.name, t]));
  assert.equal(tools.eos_draft_offboarding.decision, 'ask'); assert.equal(tools.eos_draft_offboarding.kind, 'write');
  for (const t of ['eos_offboarding', 'eos_owner_actions', 'eos_readiness_report']) assert.equal(tools[t].decision, 'allow');
  const h = createMcpHandler(new AgentRuntime(manifest, { root: fixtures, audit: false }));
  const got = await h({ jsonrpc: '2.0', id: 1, method: 'prompts/get', params: { name: 'run_onboarding', arguments: { people: 'p.csv', template: 't.json' } } });
  assert.match(got.result.messages[0].content.text, /people "p\.csv", template "t\.json"/);
});
