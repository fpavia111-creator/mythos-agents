import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentRuntime } from 'mythos-agent-core';
import { manifest } from '../src/index.js';

const ACCESS = `system,user,email,account_type,role,owner,last_login,status,mfa
ERP,Jordan Lee (fictional),jordan.lee@example.com,human,Controller,Kim Ortiz (fictional),2026-11-01,active,no
ERP,Jordan Lee (fictional),jordan.lee@example.com,human,Vendor Master,Kim Ortiz (fictional),2026-11-01,active,no
ERP,Casey Wong (fictional),casey.wong@example.com,human,A/P Clerk,Ana Ruiz (fictional),2026-11-03,active,yes
`;
const PREV = `system,user,email,account_type,role,owner,last_login,status,mfa
ERP,Casey Wong (fictional),casey.wong@example.com,human,Viewer,Ana Ruiz (fictional),2026-08-03,active,yes
ERP,Jordan Lee (fictional),jordan.lee@example.com,human,Controller,Kim Ortiz (fictional),2026-08-01,active,no
`;
const CUR = `system,user,email,account_type,role,owner,last_login,status,mfa
ERP,Casey Wong (fictional),casey.wong@example.com,human,Vault Keeper,Ana Ruiz (fictional),2026-11-03,active,yes
ERP,Jordan Lee (fictional),jordan.lee@example.com,human,Controller,Kim Ortiz (fictional),2026-11-01,active,no
`;

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'ladon-mem-'));
  writeFileSync(join(dir, 'access.csv'), ACCESS);
  writeFileSync(join(dir, 'prev.csv'), PREV);
  writeFileSync(join(dir, 'cur.csv'), CUR);
  return { dir, rt: new AgentRuntime(manifest, { root: dir }) };
}

async function learnAndAccept(rt, kind, value, who = 'Kim Ortiz (fictional)') {
  const l = await rt.call('ladon_learn', { kind, value });
  assert.equal(l.status, 'executed', JSON.stringify(l));
  const id = l.result.fact.id;
  const a1 = await rt.call('ladon_accept_learning', { id, decision: 'accept' });
  assert.equal(a1.status, 'needs_approval');
  rt.approvals.approve(a1.approval_id, who);
  const a2 = await rt.call('ladon_accept_learning', { id, decision: 'accept' });
  assert.equal(a2.status, 'executed', JSON.stringify(a2));
  return id;
}

const item = (r, role) => r.result.items.find((i) => i.role === role);

test('Ladon: a learned privileged role is not used until a person accepts it, then it flags the account', async () => {
  const { rt } = setup();
  const base = await rt.call('ladon_review_access', { access: 'access.csv', as_of: '2026-11-14' });
  assert.ok(!item(base, 'Controller').flags.includes('privileged_role'));
  assert.equal(base.result.memory, undefined);

  const l = await rt.call('ladon_learn', { kind: 'privileged_role', value: { role: 'Controller' }, note: 'Controllers can post journals and approve payments here.' });
  assert.equal(l.result.fact.status, 'pending');
  const waiting = await rt.call('ladon_review_access', { access: 'access.csv', as_of: '2026-11-14' });
  assert.ok(!item(waiting, 'Controller').flags.includes('privileged_role'), 'a waiting fact changes nothing');

  await learnAndAccept(rt, 'privileged_role', { role: 'Controller' });
  const r = await rt.call('ladon_review_access', { access: 'access.csv', as_of: '2026-11-14' });
  const c = item(r, 'Controller');
  assert.ok(c.flags.includes('privileged_role'));
  assert.ok(c.flags.includes('privileged_without_mfa'), 'MFA is now checked for the learned role');
  assert.equal(c.privileged_by, 'learned role (Ladon memory)');
  assert.match(c.reasons.join(' '), /accepted in Ladon's memory/);
  assert.equal(r.result.memory.used.length, 1);
  assert.equal(r.result.memory.used[0].accepted_by, 'Kim Ortiz (fictional)');
  assert.equal(r.memory_applied[0].kind, 'privileged_role');
  assert.match(r.result.summary, /1 learned fact\(s\) used/);
  assert.ok(!item(r, 'Vendor Master').flags.includes('privileged_role'), 'only the learned role was added');
});

test('Ladon: a learned role adds to a policy or argument list instead of replacing it', async () => {
  const { rt } = setup();
  await learnAndAccept(rt, 'privileged_role', { role: 'Vendor Master' });
  const r = await rt.call('ladon_review_access', { access: 'access.csv', as_of: '2026-11-14', privileged_roles: ['Controller'] });
  assert.ok(item(r, 'Controller').flags.includes('privileged_role'));
  assert.equal(item(r, 'Controller').privileged_by, undefined, 'matched by the argument list, not memory');
  assert.ok(item(r, 'Vendor Master').flags.includes('privileged_role'));
  assert.equal(item(r, 'Vendor Master').privileged_by, 'learned role (Ladon memory)');
});

test('Ladon: a learned SoD rule and a standing delegation apply; a policy rule with the same name wins', async () => {
  const { dir, rt } = setup();
  await learnAndAccept(rt, 'sod_rule', { name: 'controller-vs-vendor', roles_a: ['Controller'], roles_b: ['Vendor Master'] });
  await learnAndAccept(rt, 'delegation', { from: 'Kim Ortiz (fictional)', to: 'Ben Ode (fictional)', reason: 'Kim is on leave' });
  const r = await rt.call('ladon_review_access', { access: 'access.csv', as_of: '2026-11-14' });
  assert.equal(r.result.sod_conflicts.length, 1);
  assert.equal(r.result.sod_conflicts[0].rule, 'controller-vs-vendor');
  assert.ok(item(r, 'Controller').flags.includes('sod_conflict:controller-vs-vendor'));
  assert.equal(item(r, 'Controller').delegated_to, 'Ben Ode (fictional)');
  assert.equal(item(r, 'A/P Clerk').delegated_to, '');
  assert.equal(r.result.memory.used.length, 2);

  writeFileSync(join(dir, 'policy.json'), JSON.stringify({ sod_rules: [{ name: 'controller-vs-vendor', roles_a: ['Treasury'], roles_b: ['A/P Clerk'] }], delegations: [{ from: 'Kim Ortiz (fictional)', to: 'Lee Park (fictional)' }] }));
  const p = await rt.call('ladon_review_access', { access: 'access.csv', as_of: '2026-11-14', policy: 'policy.json' });
  assert.equal(p.result.sod_conflicts.length, 0, 'the policy rule of that name replaced the learned one');
  assert.equal(item(p, 'Controller').delegated_to, 'Lee Park (fictional)', 'the policy delegation wins');
  assert.equal(p.result.memory.skipped.length, 2);
  assert.match(p.result.memory.skipped.map((s) => s.why).join(' '), /policy file has a rule named/);
});

test('Ladon: the diff counts a move into a learned privileged role as privilege gained', async () => {
  const { rt } = setup();
  const before = await rt.call('ladon_access_diff', { previous: 'prev.csv', current: 'cur.csv' });
  assert.equal(before.result.counts.privilege_gained, 0);
  await learnAndAccept(rt, 'privileged_role', { role: 'Vault Keeper' });
  const after = await rt.call('ladon_access_diff', { previous: 'prev.csv', current: 'cur.csv' });
  assert.equal(after.result.counts.privilege_gained, 1);
  assert.match(after.result.review_first[0], /Casey Wong.*Vault Keeper/);
  assert.equal(after.result.memory.used[0].value.role, 'Vault Keeper');
});

test('Ladon: the recertification summary lists the learned facts it used', async () => {
  const { dir, rt } = setup();
  await learnAndAccept(rt, 'privileged_role', { role: 'Controller' });
  const r = await rt.call('ladon_recert_sheet', { access: 'access.csv', as_of: '2026-11-14' });
  assert.equal(r.status, 'executed');
  const md = readFileSync(join(dir, 'mythos-out/ladon/recertification-summary.md'), 'utf8');
  assert.match(md, /## Learned facts used/);
  assert.match(md, /"Controller" is privileged \(accepted by Kim Ortiz \(fictional\)\)/);
});

test('Ladon: memory cannot loosen a check, and --no-memory runs without it', async () => {
  const { dir, rt } = setup();
  for (const [kind, value] of [['stale_days', { days: 9999 }], ['privileged_roles', { roles: [] }], ['policy', { default: 'allow' }]]) {
    const r = await rt.call('ladon_learn', { kind, value });
    assert.equal(r.status, 'error', kind);
  }
  await learnAndAccept(rt, 'privileged_role', { role: 'Controller' });
  const off = new AgentRuntime(manifest, { root: dir, memory: false });
  const r = await off.call('ladon_review_access', { access: 'access.csv', as_of: '2026-11-14' });
  assert.ok(!item(r, 'Controller').flags.includes('privileged_role'));
  assert.equal(r.result.memory, undefined);
});

test('Ladon: accepting a fact is one-click and cannot go on Auto', () => {
  assert.throws(() => new AgentRuntime(manifest, { audit: false, mode: 'auto', autoActions: ['ladon_accept_learning'] }), /one-click/);
  const t = new AgentRuntime(manifest, { audit: false, mode: 'auto' }).listTools();
  assert.equal(t.find((x) => x.name === 'ladon_accept_learning').decision, 'ask');
  assert.equal(t.find((x) => x.name === 'ladon_retire_memory').decision, 'ask');
  assert.equal(t.find((x) => x.name === 'ladon_learn').decision, 'allow');
  assert.equal(t.find((x) => x.name === 'ladon_recall').decision, 'allow');
});
