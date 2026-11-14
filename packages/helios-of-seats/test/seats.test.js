import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentRuntime, ApprovalStore, parseCsv } from 'mythos-agent-core';
const fixtures = fileURLToPath(new URL('../fixtures', import.meta.url));
const tmpRoot = (p) => { const r = mkdtempSync(join(tmpdir(), p)); cpSync(fixtures, r, { recursive: true }); return r; };

import { manifest, normalizeSeats, findWaste, sheetCsv, SHEET_COLUMNS } from '../src/index.js';

const seat = (o) => ({ app: 'X', user: 'u', email: 'u@x.example', tier: 'Standard', monthly_cost: '10', last_active: '2026-11-10', premium_features_used: 'yes', status: 'active', ...o });
test('idle threshold and never-used', () => {
  const r = findWaste(normalizeSeats([seat({ last_active: '2026-09-01' }), seat({ email: 'b@x.example', last_active: 'never' }), seat({ email: 'c@x.example' })]), { as_of: '2026-11-14', idle_days: 60 });
  assert.equal(r.revoke_candidates, 2); assert.equal(r.est_monthly_saving, 20); assert.equal(r.est_annual_saving, 240);
});
test('over-tiered saves the downgrade ratio; unknown cost is not counted as saving', () => {
  const r = findWaste(normalizeSeats([seat({ tier: 'Enterprise', premium_features_used: 'no', monthly_cost: '100' }), seat({ email: 'z@x.example', last_active: 'never', monthly_cost: '' })]), { as_of: '2026-11-14', downgrade_ratio: 0.4 });
  assert.equal(r.downgrade_candidates, 1); assert.equal(r.est_monthly_saving, 40); assert.equal(r.seats_with_unknown_cost, 1);
});
test('header aliases and deactivated rows', () => {
  const rows = normalizeSeats([{ Application: 'Y', 'User Email': 'a@x.example', Plan: 'Pro', 'Cost per month': '$12.50', 'Last Login': '2026-01-01', Status: 'active' }, { Application: 'Y', 'User Email': 'b@x.example', Status: 'Suspended' }]);
  const r = findWaste(rows, { as_of: '2026-11-14' });
  assert.equal(r.seats, 1); assert.equal(r.skipped_inactive, 1); assert.equal(r.items[0].monthly_cost, 12.5);
});
test('roster: leaver and not-in-roster', () => {
  const roster = new Map([['u@x.example', 'terminated']]);
  const r = findWaste(normalizeSeats([seat({}), seat({ email: 'ghost@x.example' })]), { as_of: '2026-11-14', roster });
  assert.ok(r.items.find((i) => i.email === 'u@x.example').flags.includes('leaver'));
  assert.equal(r.items.find((i) => i.email === 'ghost@x.example').suggested_action, 'check owner');
});
test('sheet has blank reviewer columns', () => {
  const r = findWaste(normalizeSeats(parseCsv(readFileSync(join(fixtures, 'seats.csv'), 'utf8'))), { as_of: '2026-11-14' });
  const out = parseCsv(sheetCsv(r));
  assert.deepEqual(Object.keys(out[0]), SHEET_COLUMNS); assert.ok(out.every((x) => x.reviewer_decision === ''));
});
test('revoke is one-click even in Auto; downgrade can be opted in', async () => {
  assert.throws(() => new AgentRuntime(manifest, { audit: false, mode: 'auto', autoActions: ['helios_request_revoke'] }), /one-click/);
  const root = tmpRoot('helios-');
  const rt = new AgentRuntime(manifest, { root, mode: 'auto', autoActions: ['helios_request_downgrade'] });
  assert.equal((await rt.call('helios_request_downgrade', { app: 'Figma', user: 'Sam', reason: 'r' })).status, 'executed');
  const args = { app: 'Salesforce', user: 'Riley', reason: 'left' };
  const a = await rt.call('helios_request_revoke', args); assert.equal(a.status, 'needs_approval');
  new ApprovalStore(join(root, '.mythos')).approve(a.approval_id, 'Dana');
  const b = await rt.call('helios_request_revoke', args); assert.equal(b.status, 'executed');
  const csv = parseCsv(readFileSync(b.result.file, 'utf8')); assert.equal(csv.length, 2); assert.equal(csv[1].change, 'revoke');
});
