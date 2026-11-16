import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentRuntime, parseCsv, readAudit, validate } from 'mythos-agent-core';
import { manifest, POLICY_SCHEMA, normalizeAccess, normalizeRoster, reviewAccess, sheetCsv, campaignStatus, accessDiff, evidencePack } from '../src/index.js';

const fixtures = fileURLToPath(new URL('../fixtures', import.meta.url));
const csv = (f) => parseCsv(readFileSync(join(fixtures, f), 'utf8'));
const sandbox = () => { const root = mkdtempSync(join(tmpdir(), 'ladon-v02-')); cpSync(fixtures, root, { recursive: true }); return root; };

test('non-human identity without an owner or rotation date is flagged; stale rotation too', () => {
  const rows = normalizeAccess([
    { system: 'X', user: 'svc-a', account_type: 'service', role: 'Read', owner: '', last_login: '2026-11-13', last_rotated: '' },
    { system: 'X', user: 'svc-b', account_type: 'service', role: 'Read', owner: 'Pat (fictional)', last_login: '2026-11-13', last_rotated: '2026-01-01' },
    { system: 'X', user: 'svc-c', account_type: 'agent', role: 'Read', owner: 'Pat (fictional)', last_login: '2026-11-13', last_rotated: '2026-11-01' },
  ]);
  const r = reviewAccess(rows, null, { as_of: '2026-11-14' });
  const by = (u) => r.items.find((i) => i.user === u).flags;
  assert.deepEqual(by('svc-a'), ['non_human_without_owner', 'non_human_without_rotation_date']);
  assert.deepEqual(by('svc-b'), ['credential_not_rotated_317_days']);
  assert.deepEqual(by('svc-c'), []);
  assert.equal(r.rotation_checked, true);
  const r2 = reviewAccess(normalizeAccess([{ system: 'X', user: 'bot', account_type: 'agent', role: 'Read', owner: 'P', last_login: '2026-11-13' }]), null, { as_of: '2026-11-14' });
  assert.equal(r2.rotation_checked, false); assert.match(r2.note, /rotation was not checked/);
});

test('a delegated reviewer and due dates are recorded in the sheet', () => {
  const pol = JSON.parse(readFileSync(join(fixtures, 'ladon-policy.json'), 'utf8'));
  const r = reviewAccess(normalizeAccess(csv('access-export.csv')), normalizeRoster(csv('hr-roster.csv')), { ...pol, as_of: '2026-11-14' });
  const sheet = parseCsv(sheetCsv(r));
  const riley = sheet.find((s) => s.system === 'NetSuite' && s.user.startsWith('Riley'));
  assert.equal(riley.assigned_reviewer, 'Avery Stone (fictional)');
  assert.equal(riley.delegated_to, 'Kim Ortiz (fictional)');
  assert.match(riley.notes, /Delegated by Avery Stone.*on leave/);
  assert.equal(riley.due_date, '2026-11-21', 'high risk is due in half of due_days');
  assert.equal(sheet.find((s) => s.user === 'Sam Rivera (fictional)').due_date, '2026-11-28');
  assert.ok(sheet.every((s) => s.reviewer_decision === '' && s.reviewer_name === '' && s.review_date === ''));
});

test('segregation-of-duties conflict across systems is flagged on both lines', () => {
  const pol = JSON.parse(readFileSync(join(fixtures, 'ladon-policy.json'), 'utf8'));
  const r = reviewAccess(normalizeAccess(csv('access-export.csv')), null, { ...pol, as_of: '2026-11-14' });
  assert.equal(r.sod_conflicts.length, 1);
  assert.equal(r.sod_conflicts[0].person, 'casey.wong@example.com');
  assert.equal(r.items.filter((i) => i.flags.includes('sod_conflict:payments-vs-payables')).length, 2);
  assert.ok(r.items.every((i) => i.reasons.length === i.flags.length));
});

test('overdue recert lines are flagged; self-review, missing sign-off, invalid decision and late signing too', () => {
  const s = campaignStatus(csv('recertification-filled.csv'), { as_of: '2026-12-01' });
  assert.equal(s.lines, 10); assert.equal(s.overdue, 2); assert.equal(s.decided, 4);
  const issues = s.exceptions.flatMap((e) => e.issues).join('\n');
  assert.match(issues, /overdue by 10 day\(s\)/);
  assert.match(issues, /self-review/);
  assert.match(issues, /not the assigned reviewer/);
  assert.match(issues, /no reviewer_name/);
  assert.match(issues, /"maybe" is not keep/);
  assert.match(issues, /signed after the due date/);
  assert.equal(s.revocations_to_request.length, 2);
  assert.equal(s.chase_list[0].reviewer, 'Kim Ortiz (fictional)');
  // Before the due date nothing is overdue.
  assert.equal(campaignStatus(csv('recertification-filled.csv'), { as_of: '2026-11-20' }).overdue, 0);
});

test('access diff finds privilege gained, reactivation-free removals, new agents and owner changes', () => {
  const d = accessDiff(normalizeAccess(csv('access-export-2026q3.csv')), normalizeAccess(csv('access-export.csv')), {});
  assert.deepEqual(d.removed.map((x) => x.user), ['Morgan Diaz (fictional)']);
  assert.ok(d.added.some((x) => x.user === 'olympus-agent' && x.non_human));
  assert.ok(d.privilege_gained.some((x) => x.user === 'shared mailbox' && x.to === 'Super Admin'));
  assert.ok(d.role_changed.some((x) => x.user === 'Jordan Lee (fictional)' && x.from === 'A/P Clerk' && x.to === 'Controller'));
  assert.ok(d.deactivated.some((x) => x.user === 'Old Contractor (fictional)'));
  assert.ok(d.owner_changed.some((x) => x.user === 'integration-sync' && x.to === ''));
  assert.match(d.review_first[0], /shared mailbox gained Super Admin/);
});

test('evidence pack is deterministic and its hash is written to the audit line', async () => {
  const s = campaignStatus(csv('recertification-filled.csv'), { as_of: '2026-12-01' });
  const a = evidencePack(s, { sheet_sha256: 'x', sheet_path: 'p' }), b = evidencePack(s, { sheet_sha256: 'x', sheet_path: 'p' });
  assert.equal(a.record_sha256, b.record_sha256); assert.equal(a.html, b.html);
  assert.equal(a.record.complete, false);
  assert.match(a.html, /Content-Security-Policy/); assert.doesNotMatch(a.html, /<script/i);
  const root = sandbox();
  const rt = new AgentRuntime(manifest, { root });
  const out = await rt.call('ladon_evidence_pack', { sheet: 'recertification-filled.csv', as_of: '2026-12-01', campaign: 'Q4 2026 access review (fictional)' });
  assert.equal(out.status, 'executed', out.reason);
  const json = JSON.parse(readFileSync(out.result.files[0], 'utf8'));
  assert.equal(json.sheet.sha256, rt.context().hashFile('recertification-filled.csv'));
  assert.match(json.note, /does not prove/);
  const line = readAudit(join(root, '.mythos', 'audit.jsonl')).find((e) => e.tool === 'ladon_evidence_pack');
  assert.equal(line.output_sha256, out.result.output_sha256);
});

test('policy config: three mutated files fail with JSON-pointer errors; the fixture passes', async () => {
  const good = JSON.parse(readFileSync(join(fixtures, 'ladon-policy.json'), 'utf8'));
  assert.equal(validate(POLICY_SCHEMA, good).ok, true);
  const root = sandbox();
  const rt = new AgentRuntime(manifest, { root, audit: false });
  const bad = {
    unknown: { ...good, stale_dayz: 30 },
    wrongType: { ...good, due_days: '14' },
    missingRequired: { ...good, delegations: [{ from: 'Avery Stone (fictional)' }] },
  };
  const want = { unknown: /\/stale_dayz/, wrongType: /\/due_days.*integer/, missingRequired: /\/delegations\/0.*to/ };
  for (const [k, cfg] of Object.entries(bad)) {
    writeFileSync(join(root, `${k}.json`), JSON.stringify(cfg));
    const r = await rt.call('ladon_review_access', { access: 'access-export.csv', policy: `${k}.json`, as_of: '2026-11-14' });
    assert.equal(r.status, 'error', k);
    assert.match(r.reason + JSON.stringify(r.errors || []), want[k], k);
  }
});

test('tool inputs are validated before running; the prompt walks the whole workflow', async () => {
  const rt = new AgentRuntime(manifest, { root: fixtures, audit: false });
  const r = await rt.call('ladon_review_access', { access: 'access-export.csv', stale_days: 'ninety' });
  assert.equal(r.status, 'error'); assert.match(r.reason, /invalid arguments: \/stale_days/);
  const p = manifest.prompts.find((x) => x.name === 'ladon_recertification_campaign');
  for (const t of ['ladon_review_access', 'ladon_access_diff', 'ladon_recert_sheet', 'ladon_campaign_status', 'ladon_evidence_pack', 'ladon_request_revocation', '{{access}}', '{{as_of}}', 'one click']) assert.ok(p.text.includes(t), t);
});

test('revoke stays one-click in Auto for a revoke decision from the campaign', async () => {
  const root = sandbox();
  const rt = new AgentRuntime(manifest, { root, mode: 'auto' });
  const s = await rt.call('ladon_campaign_status', { sheet: 'recertification-filled.csv', as_of: '2026-12-01' });
  const first = s.result.revocations_to_request[0];
  const r = await rt.call('ladon_request_revocation', { system: first.system, user: first.user, reason: `Reviewer decision on line ${first.line}` });
  assert.equal(r.status, 'needs_approval'); assert.match(r.reason, /one-click/);
  assert.equal((await rt.call('ladon_evidence_pack', { sheet: 'recertification-filled.csv', as_of: '2026-12-01' })).status, 'executed');
  const review = new AgentRuntime(manifest, { root, mode: 'review', audit: false });
  assert.equal((await review.call('ladon_evidence_pack', { sheet: 'recertification-filled.csv', as_of: '2026-12-01' })).status, 'executed');
  assert.equal((await review.call('ladon_request_revocation', { system: 'Slack', user: 'z', reason: 'q' })).status, 'blocked');
});
