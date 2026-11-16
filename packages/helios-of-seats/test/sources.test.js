// Real-export adapters: sample exports in fixtures/exports are recognised and
// mapped onto Helios's own columns.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentRuntime } from 'mythos-agent-core';
import { manifest } from '../src/index.js';

const fixtures = fileURLToPath(new URL('../fixtures', import.meta.url));
const find = async (seats, extra = {}, root = fixtures) => {
  const r = await new AgentRuntime(manifest, { root, audit: false }).call('helios_find_waste', { seats, as_of: '2026-11-14', ...extra });
  assert.equal(r.status, 'executed', r.reason);
  return r;
};
const item = (r, re) => r.result.items.find((i) => re.test(`${i.user} ${i.email}`));

test('native seat file is read untouched', async () => { assert.equal((await find('seats.csv')).sources, undefined); });

test('Microsoft 365 active user detail: latest activity across products, deleted users skipped', async () => {
  const r = await find('exports/m365-active-user-detail.csv');
  assert.equal(r.sources[0].profile, 'm365_active_user_detail');
  assert.equal(r.result.items.length, 4);
  assert.equal(item(r, /avery/).last_active, '2026-11-12'); assert.equal(item(r, /avery/).suggested_action, 'keep');
  assert.ok(item(r, /jordan/).flags.some((f) => /^idle_\d+_days$/.test(f)));
  assert.ok(item(r, /spare/).flags.includes('never_used'));
  assert.equal(item(r, /jordan/).cost_known, false, 'no price in the export: the saving is unknown, not zero');
  assert.match(r.sources[0].note, /Seat prices are not in/);
});

test('a seat price set in mythos-sources.json turns unknown savings into estimates', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'helios-src-'));
  copyFileSync(join(fixtures, 'exports/m365-active-user-detail.csv'), join(dir, 'm365.csv'));
  writeFileSync(join(dir, 'mythos-sources.json'), JSON.stringify({ files: { 'm365.csv': { set: { monthly_cost: 22 } } } }));
  const r = await find('m365.csv', {}, dir);
  assert.equal(item(r, /jordan/).est_monthly_saving, 22); assert.equal(item(r, /jordan/).cost_known, true);
  assert.match(r.sources[0].mapped.monthly_cost, /set to "22"/);
});

test('Google Workspace, Copilot seats JSON and Atlassian users', async () => {
  const g = await find('exports/google-workspace-users.csv');
  assert.equal(g.sources[0].profile, 'google_workspace_users'); assert.equal(g.result.items.length, 4, 'suspended user skipped');
  assert.ok(item(g, /shared@/).flags.includes('never_used'));
  const c = await find('exports/github-copilot-seats.json');
  assert.equal(c.sources[0].profile, 'github_copilot_seats'); assert.equal(c.result.items.length, 3);
  assert.ok(item(c, /rileypark/).flags.includes('never_used')); assert.ok(item(c, /jordanlee/).flags.some((f) => /^idle_/.test(f)));
  assert.equal(item(c, /averystone/).app, 'GitHub Copilot');
  const a = await find('exports/atlassian-users.csv');
  assert.equal(a.sources[0].profile, 'atlassian_users'); assert.equal(item(a, /riley/).last_active, '2026-10-29');
});

test('BambooHR roster marks the leaver; a seat file with no activity column says so', async () => {
  const r = await find('exports/m365-active-user-detail.csv', { roster: 'exports/bamboohr-employees.csv' });
  assert.deepEqual(r.sources.map((s) => s.profile), ['bamboohr_employees', 'm365_active_user_detail']);
  assert.ok(item(r, /riley/).flags.includes('leaver')); assert.equal(item(r, /riley/).suggested_action, 'revoke candidate');
  const dir = mkdtempSync(join(tmpdir(), 'helios-na-'));
  writeFileSync(join(dir, 'seats.csv'), 'app,user,email,tier,monthly_cost\nDesignTool,Avery Stone (fictional),avery.stone@example.com,Pro,20\n');
  const n = await find('seats.csv', {}, dir);
  assert.deepEqual(n.result.items[0].flags, ['last_active_not_in_export']); assert.equal(n.result.items[0].suggested_action, 'keep');
});
