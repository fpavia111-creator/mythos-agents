import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentRuntime, parseCsv, ApprovalStore } from 'mythos-agent-core';
import { manifest, normalizeAccess, normalizeRoster, reviewAccess, sheetCsv, SHEET_COLUMNS } from '../src/index.js';

const fixtures = fileURLToPath(new URL('../fixtures', import.meta.url));

test('leaver in HR is a revoke candidate; disabled rows are skipped', () => {
  const rows = normalizeAccess([{ system: 'X', user: 'a', email: 'a@x.com', role: 'User', last_login: '2026-11-01', status: 'active' }, { system: 'X', user: 'b', email: 'b@x.com', role: 'User', status: 'disabled' }]);
  const r = reviewAccess(rows, normalizeRoster([{ email: 'a@x.com', status: 'Terminated' }]), { as_of: '2026-11-14' });
  assert.equal(r.accounts, 1); assert.equal(r.items[0].suggested_action, 'revoke candidate'); assert.equal(r.items[0].risk, 'high');
});

test('agents need an owner; humans are not checked against roster when absent', () => {
  const rows = normalizeAccess([{ system: 'X', user: 'bot', account_type: 'agent', role: 'Read', last_login: '2026-11-13' }]);
  const r = reviewAccess(rows, null, { as_of: '2026-11-14' });
  assert.deepEqual(r.items[0].flags, ['non_human_without_owner']);
});

test('custom privileged roles and stale days', () => {
  const rows = normalizeAccess([{ system: 'X', user: 'c', email: 'c@x.com', role: 'Controller', last_login: '2026-10-01' }]);
  const r = reviewAccess(rows, null, { as_of: '2026-11-14', stale_days: 30, privileged_roles: ['Controller'] });
  assert.ok(r.items[0].flags.includes('privileged_role'));
  assert.ok(r.items[0].flags.includes('stale_44_days'));
});

test('sheet has blank reviewer columns', () => {
  const rows = normalizeAccess(parseCsv(readFileSync(join(fixtures, 'access-export.csv'), 'utf8')));
  const out = parseCsv(sheetCsv(reviewAccess(rows, null, { as_of: '2026-11-14' })));
  assert.deepEqual(Object.keys(out[0]), SHEET_COLUMNS);
  assert.ok(out.every((r) => r.reviewer_decision === '' && r.reviewer_name === ''));
});

test('revocation request only after a named human approves; even Auto cannot opt in', async () => {
  assert.throws(() => new AgentRuntime(manifest, { audit: false, mode: 'auto', autoActions: ['ladon_request_revocation'] }), /one-click/);
  const root = mkdtempSync(join(tmpdir(), 'ladon-'));
  const rt = new AgentRuntime(manifest, { root, mode: 'auto' });
  const args = { system: 'NetSuite', user: 'Riley', reason: 'left' };
  const a = await rt.call('ladon_request_revocation', args);
  assert.equal(a.status, 'needs_approval');
  new ApprovalStore(join(root, '.mythos')).approve(a.approval_id, 'Dana Reviewer');
  const b = await rt.call('ladon_request_revocation', args);
  assert.equal(b.status, 'executed'); assert.equal(b.approved_by, 'Dana Reviewer');
  assert.match(readFileSync(b.result.file, 'utf8'), /Riley/);
});
