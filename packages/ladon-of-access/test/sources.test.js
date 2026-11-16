// Real-export adapters: each sample export in fixtures/exports is recognised,
// mapped onto Ladon's own columns, and reviewed like a native file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, copyFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentRuntime, writeXlsx, parseCsvRows } from 'mythos-agent-core';
import { manifest } from '../src/index.js';

const fixtures = fileURLToPath(new URL('../fixtures', import.meta.url));
const rt = (root = fixtures) => new AgentRuntime(manifest, { root, audit: false });
const review = async (file, extra = {}, root) => {
  const r = await rt(root).call('ladon_review_access', { access: file, as_of: '2026-11-14', ...extra });
  assert.equal(r.status, 'executed', r.reason);
  return r;
};
const item = (r, re) => r.result.items.find((i) => re.test(`${i.user} ${i.email}`));

test('a file in Ladon\'s own columns is read untouched (no sources entry)', async () => {
  const r = await review('access-export.csv');
  assert.equal(r.sources, undefined);
});

test('Okta users API JSON: nested profile, status words, never logged in', async () => {
  const r = await review('exports/okta-users.json');
  assert.equal(r.sources[0].profile, 'okta_users_api'); assert.equal(r.sources[0].system, 'Okta');
  assert.equal(r.result.accounts, 4, 'the deprovisioned user is not an active account');
  assert.ok(item(r, /jordan/).flags.some((f) => /^stale_\d+_days$/.test(f)));
  assert.ok(item(r, /shared@/).flags.includes('never_logged_in'));
  assert.equal(item(r, /avery/).system, 'Okta');
  assert.ok(!JSON.stringify(r.result).includes('mobilePhone'), 'unmapped nested objects are not passed through');
});

test('Google Workspace users download: split names, 2-step flag, suspended, last sign-in', async () => {
  const r = await review('exports/google-workspace-users.csv');
  assert.equal(r.sources[0].profile, 'google_workspace_users');
  assert.equal(r.result.accounts, 4);
  assert.equal(item(r, /avery/).user, 'Avery Stone (fictional)');
  assert.ok(item(r, /shared@/).flags.includes('never_logged_in'));
  assert.ok(item(r, /shared@/).flags.includes('privileged_without_mfa'));
  assert.ok(!item(r, /avery/).flags.includes('privileged_without_mfa'));
  assert.ok(item(r, /jordan/).flags.some((f) => /^stale_/.test(f)));
});

test('AWS IAM credential report: root, service account keys, N/A dates', async () => {
  const r = await review('exports/aws-iam-credential-report.csv');
  assert.equal(r.sources[0].profile, 'aws_iam_credential_report');
  const root = item(r, /root_account/); assert.ok(root.flags.includes('privileged_role')); assert.ok(root.flags.includes('privileged_without_mfa'));
  const svc = item(r, /integration-sync/); assert.equal(svc.account_type, 'service'); assert.ok(svc.flags.includes('non_human_without_owner'));
  assert.ok(svc.flags.some((f) => /^credential_not_rotated_\d+_days$/.test(f)));
  assert.ok(item(r, /old-reporting/).flags.includes('never_logged_in'));
});

test('exports with no last-login column say so instead of calling every account unused', async () => {
  for (const [file, profile] of [['exports/entra-users.csv', 'entra_users'], ['exports/m365-active-users.csv', 'm365_active_users'], ['exports/slack-members.csv', 'slack_members']]) {
    const r = await review(file);
    assert.equal(r.sources[0].profile, profile);
    assert.ok(r.result.items.every((i) => i.flags.includes('last_login_not_in_export') && !i.flags.includes('never_logged_in')), file);
    assert.match(r.sources[0].note, /no last/i, 'the result carries the note');
  }
  const slack = await review('exports/slack-members.csv');
  assert.equal(slack.result.accounts, 4, 'the deactivated member is skipped');
  assert.equal(item(slack, /deploybot/).account_type, 'bot');
  assert.ok(item(slack, /jordan/).flags.includes('privileged_without_mfa'));
  const entra = await review('exports/entra-users.csv');
  assert.equal(entra.result.accounts, 3); assert.ok(item(entra, /jordan/).email.includes('#ext#'));
});

test('GitHub members and Atlassian users', async () => {
  const gh = await review('exports/github-org-members.csv');
  assert.equal(gh.sources[0].profile, 'github_org_members');
  assert.ok(item(gh, /jordan/).flags.includes('privileged_without_mfa')); assert.equal(item(gh, /riley/).email, 'riley.park@example.com');
  const at = await review('exports/atlassian-users.csv');
  assert.equal(at.sources[0].profile, 'atlassian_users'); assert.equal(at.result.accounts, 3);
  assert.equal(item(at, /avery/).last_login, '2026-11-10', 'latest of the per-product last-seen columns, as an ISO date');
});

test('BambooHR roster: US dates, leaver from the termination date', async () => {
  const r = await review('exports/okta-users.json', { roster: 'exports/bamboohr-employees.csv' });
  assert.deepEqual(r.sources.map((s) => s.profile), ['okta_users_api', 'bamboohr_employees']);
  assert.equal(r.sources[1].dates_read_as, 'month/day/year');
  assert.ok(item(r, /riley/).flags.includes('terminated_in_hr')); assert.equal(item(r, /riley/).suggested_action, 'revoke candidate');
  assert.ok(item(r, /shared@/).flags.includes('not_in_hr_roster'));
});

test('the same export as Excel, TSV and semicolon text gives the same review', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ladon-src-'));
  const rows = parseCsvRows(readFileSync(join(fixtures, 'exports/google-workspace-users.csv'), 'utf8'));
  writeFileSync(join(dir, 'users.xlsx'), writeXlsx({ Users: rows }));
  writeFileSync(join(dir, 'users.tsv'), rows.map((r) => r.join('\t')).join('\n'));
  writeFileSync(join(dir, 'users-semicolon.csv'), rows.map((r) => r.join(';')).join('\n'));
  copyFileSync(join(fixtures, 'exports/google-workspace-users.csv'), join(dir, 'users.csv'));
  const base = await review('users.csv', {}, dir);
  for (const [f, fmt] of [['users.xlsx', 'xlsx'], ['users.tsv', 'tsv'], ['users-semicolon.csv', 'semicolon-delimited']]) {
    const r = await review(f, {}, dir);
    assert.equal(r.sources[0].format, fmt);
    assert.deepEqual(r.result.items, base.result.items, f);
  }
});

test('mythos-sources.json names columns by hand and sets the date order', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ladon-ovr-'));
  writeFileSync(join(dir, 'accounts.csv'), 'Tool,Person,Mailbox,Niveau,Derniere connexion,Etat\nERP,Avery Stone (fictional),avery.stone@example.com,Administrator,03/11/2026,active\nERP,Jordan Lee (fictional),jordan.lee@example.com,Clerk,01/06/2026,active\n');
  const before = await review('accounts.csv', {}, dir);
  assert.ok(before.result.items.every((i) => !i.email), 'without a mapping the unknown headers are not guessed');
  writeFileSync(join(dir, 'mythos-sources.json'), JSON.stringify({ sources: { access: { columns: { user: 'Person', email: 'Mailbox', role: 'Niveau', last_login: 'Derniere connexion', status: 'Etat' }, date_order: 'dmy' } } }));
  const r = await review('accounts.csv', {}, dir);
  assert.equal(r.sources[0].mapped.last_login, 'Derniere connexion'); assert.equal(r.sources[0].dates_read_as, 'day/month/year');
  assert.equal(item(r, /avery/).last_login, '2026-11-03'); assert.ok(item(r, /jordan/).flags.some((f) => /^stale_/.test(f)));
  writeFileSync(join(dir, 'mythos-sources.json'), JSON.stringify({ sources: { access: { columns: { user: 'Nobody' } } } }));
  const bad = await rt(dir).call('ladon_review_access', { access: 'accounts.csv' });
  assert.equal(bad.status, 'error'); assert.match(bad.reason, /does not have/);
  writeFileSync(join(dir, 'mythos-sources.json'), JSON.stringify({ sources: { access: { date_order: 'ymd' } } }));
  assert.match((await rt(dir).call('ladon_review_access', { access: 'accounts.csv' })).reason, /mythos-sources\.json is not valid/);
});

test('inspect describes a file without returning any cell value', async () => {
  const r = rt().inspect({ path: 'exports/google-workspace-users.csv' });
  assert.equal(r.status, 'executed');
  assert.equal(r.result.readings[0].profile, 'google_workspace_users');
  assert.equal(r.result.columns.find((c) => c.name === 'Email Address [Required]').looks_like, 'email addresses');
  const text = JSON.stringify(r.result);
  assert.ok(!/avery|riley|example\.com/i.test(text), 'no cell values in the inspection');
  assert.equal(rt().inspect({ path: '../outside.csv' }).status, 'error');
  assert.equal(rt().inspect({ path: 'exports/okta-users.json', as: 'nope' }).status, 'error');
});

test('the diff tool maps both periods', async () => {
  const r = await rt().call('ladon_access_diff', { previous: 'access-export-2026q3.csv', current: 'exports/google-workspace-users.csv' });
  assert.equal(r.status, 'executed', r.reason);
  assert.equal(r.sources.length, 1); assert.equal(r.sources[0].arg, 'current');
});
