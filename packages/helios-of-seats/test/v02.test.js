import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentRuntime, ApprovalStore, parseCsv, validate, validateIcs, readAudit, createMcpHandler } from 'mythos-agent-core';
import { manifest, normalizeSeats, findWaste, savingWindow, proRated12, contractTerms, applyContracts, compareReviews, confirmationDrafts, renewalIcs } from '../src/index.js';

const fixtures = fileURLToPath(new URL('../fixtures', import.meta.url));
const tmpRoot = (p) => { const r = mkdtempSync(join(tmpdir(), p)); cpSync(fixtures, r, { recursive: true }); return r; };
const policy = JSON.parse(readFileSync(join(fixtures, 'helios-policy.json'), 'utf8'));
const seat = (o) => ({ app: 'X', user: 'u', email: 'u@x.example', tier: 'Standard', monthly_cost: '10', last_active: 'never', premium_features_used: 'yes', status: 'active', ...o });
const review = (rows, terms, asOf = '2026-11-14') => applyContracts(findWaste(normalizeSeats(rows), { as_of: asOf }), contractTerms({ apps: terms }));

test('renewal: an annual saving is pro-rated to the renewal date', () => {
  // 120/month seat, renewal 2027-05-14 (181 days after as_of), notice 30: 184 of 365 days remain -> 1440 * 184/365
  const r = review([seat({ app: 'CRM', monthly_cost: '120' })], { CRM: { billing: 'annual', renewal_date: '2027-05-14', notice_days: 30 } });
  assert.equal(r.items[0].est_monthly_saving, 120);
  assert.equal(r.items[0].act_by, '2027-04-14');
  assert.equal(r.items[0].est_saving_next_12m, Math.round(1440 * 184 / 365 * 100) / 100);
  assert.equal(r.est_saving_next_12m, 725.92);
  const m = review([seat({ app: 'Draw', monthly_cost: '15' })], { Draw: { billing: 'monthly' } });
  assert.equal(m.items[0].est_saving_next_12m, 180);
  const unknown = review([seat({ app: 'Other', monthly_cost: '5' })], {});
  assert.match(unknown.items[0].assumption, /assumed/);
});
test('renewal: passed notice window moves the saving to the next renewal; past renewal dates roll forward', () => {
  const w = savingWindow({ billing: 'annual', renewal_date: '2026-12-01', notice_days: 30 }, '2026-11-14');
  assert.deepEqual([w.notice_passed, w.renewal_date, w.act_by], [true, '2027-12-01', '2027-11-01']);
  assert.equal(proRated12(100, w, '2026-11-14'), 0);
  const roll = savingWindow({ billing: 'annual', renewal_date: '2024-02-01', notice_days: 0 }, '2026-11-14');
  assert.equal(roll.renewal_date, '2027-02-01');
  assert.equal(savingWindow({ billing: 'annual' }, '2026-11-14').effective, null);
});
test('contract minimum caps the countable removals', () => {
  const rows = [seat({ app: 'AI', email: 'a@x.example' }), seat({ app: 'AI', email: 'b@x.example' }), seat({ app: 'AI', email: 'c@x.example', last_active: '2026-11-10' })];
  const r = review(rows, { AI: { billing: 'monthly', min_seats: 2 } });
  assert.equal(r.est_monthly_saving, 10);
  assert.equal(r.items.filter((i) => i.flags.includes('contract_minimum_2')).length, 1);
  assert.equal(r.by_app[0].recommended_seats, 2);
});
test('per-app idle days and downgrade ratio from the policy', () => {
  const rows = normalizeSeats([seat({ app: 'Slow', last_active: '2026-10-01' }), seat({ app: 'Fast', email: 'f@x.example', last_active: '2026-10-01' })]);
  const r = findWaste(rows, { as_of: '2026-11-14', idle_days: 60, perApp: new Map([['fast', { idle_days: 30 }]]) });
  assert.equal(r.items.find((i) => i.app === 'Fast').suggested_action, 'revoke candidate');
  assert.equal(r.items.find((i) => i.app === 'Slow').suggested_action, 'keep');
});
test('fixture review: act-first order, notice passed, minimums', async () => {
  const rt = new AgentRuntime(manifest, { root: tmpRoot('helios2-'), audit: false });
  const r = (await rt.call('helios_find_waste', { seats: 'seats.csv', roster: 'hr-roster.csv', policy: 'helios-policy.json', as_of: '2026-11-14' })).result;
  assert.deepEqual(r.actions.map((a) => a.app), ['Salesforce', 'ChatGPT', 'Zoom', 'Figma']);
  assert.equal(r.actions[0].est_saving_next_12m, 1399.56);
  assert.ok(r.items.find((i) => i.app === 'Zoom').flags.includes('notice_window_passed'));
  assert.equal(r.est_monthly_saving, 209.5);
});

test('owner confirmation drafts: drafts only, grouped by owner, managers in Cc; revoke stays one-click', async () => {
  const root = tmpRoot('helios2-d-');
  const rt = new AgentRuntime(manifest, { root, mode: 'auto', autoActions: ['helios_request_downgrade'] });
  const d = await rt.call('helios_draft_confirmations', { seats: 'seats.csv', roster: 'hr-roster.csv', policy: 'helios-policy.json', as_of: '2026-11-14' });
  assert.equal(d.status, 'executed'); assert.equal(d.result.sent, 0);
  assert.deepEqual(d.result.drafts.map((x) => x.to), ['ai-tools@example.com', 'design-lead@example.com', 'it-admin@example.com', 'sales-ops@example.com']);
  const sales = readFileSync(d.result.files.find((f) => f.endsWith('confirm-sales-ops-example-com.md')), 'utf8');
  assert.match(sales, /^<!-- DRAFT ONLY/); assert.match(sales, /Cc: sales-manager@example\.com/); assert.match(sales, /Riley Park/);
  const idx = parseCsv(readFileSync(d.result.files.at(-1), 'utf8'));
  assert.ok(idx.every((x) => x.status === 'draft - not sent'));
  assert.ok(!manifest.tools.some((t) => /send|email|notify/.test(t.name)), 'no send tool exists');
  assert.equal((await rt.call('helios_send_confirmations', {})).status, 'blocked');
  const args = { app: 'Zoom', user: 'Jordan Lee (fictional)', reason: 'Owner confirmed in draft reply' };
  const a = await rt.call('helios_request_revoke', args);
  assert.equal(a.status, 'needs_approval'); assert.equal(a.decision, 'ask');
  new ApprovalStore(join(root, '.mythos')).approve(a.approval_id, 'Dana (fictional)');
  assert.equal((await rt.call('helios_request_revoke', args)).status, 'executed');
});

test('renewal calendar: valid .ics, act-by and renewal events, deterministic', async () => {
  const root = tmpRoot('helios2-c-');
  const rt = new AgentRuntime(manifest, { root });
  const c = await rt.call('helios_renewal_calendar', { seats: 'seats.csv', policy: 'helios-policy.json', as_of: '2026-11-14' });
  const text = readFileSync(c.result.file, 'utf8');
  const v = validateIcs(text); assert.ok(v.ok, v.errors.join('; ')); assert.equal(v.events, 6);
  assert.match(text, /DTSTART;VALUE=DATE:20261231\r\nDTEND;VALUE=DATE:20270101\r\nSUMMARY:Seat true-down notice due: Salesforce/);
  assert.match(text, /DTSTAMP:20261114T000000Z/);
  const again = await rt.call('helios_renewal_calendar', { seats: 'seats.csv', policy: 'helios-policy.json', as_of: '2026-11-14', out_dir: 'cal2' });
  assert.equal(again.result.output_sha256, c.result.output_sha256);
  const log = readAudit(join(root, '.mythos', 'audit.jsonl'));
  assert.equal(log.find((e) => e.tool === 'helios_renewal_calendar').output_sha256, c.result.output_sha256);
  const none = renewalIcs(review([seat({})], {}));
  assert.equal(none.events, 0);
});

test('compare two exports: resolved, new waste, still flagged, removed, cost changes', async () => {
  const rt = new AgentRuntime(manifest, { root: tmpRoot('helios2-cmp-'), audit: false });
  const c = (await rt.call('helios_compare_reviews', { previous: 'seats-previous.csv', previous_as_of: '2026-10-14', seats: 'seats.csv', as_of: '2026-11-14', roster: 'hr-roster.csv' })).result;
  assert.deepEqual(c.removed.map((x) => x.app), ['Miro', 'Slack']);
  assert.deepEqual(c.added.map((x) => `${x.app}/${x.user}`), ['ChatGPT/Avery Stone (fictional)', 'Notion/Sam Rivera (fictional)']);
  assert.ok(c.still_flagged.some((x) => x.app === 'Figma' && x.user.startsWith('Casey')));
  assert.deepEqual(c.cost_changes, [{ app: 'Zoom', user: 'Jordan Lee (fictional)', before: 20, after: 22 }]);
  assert.ok(c.new_waste.some((x) => x.app === 'ChatGPT'));
  assert.equal(c.monthly_spend_after, 442); assert.equal(c.monthly_spend_before, 435);
  const self = compareReviews(findWaste(normalizeSeats([seat({})]), { as_of: '2026-11-14' }), findWaste(normalizeSeats([seat({ last_active: '2026-11-13' })]), { as_of: '2026-11-14' }));
  assert.equal(self.resolved.length, 1); assert.equal(self.waste_change, -10);
});

test('write_review adds act-by columns and renewal actions; hash in audit', async () => {
  const root = tmpRoot('helios2-w-');
  const rt = new AgentRuntime(manifest, { root });
  const w = await rt.call('helios_write_review', { seats: 'seats.csv', roster: 'hr-roster.csv', policy: 'helios-policy.json', as_of: '2026-11-14' });
  assert.equal(w.result.files.length, 3);
  const sheet = parseCsv(readFileSync(w.result.files[0], 'utf8'));
  assert.equal(sheet.find((x) => x.app === 'Salesforce' && x.flags === 'leaver').act_by, '2026-12-31');
  assert.match(readFileSync(w.result.files[1], 'utf8'), /## Act first/);
  assert.equal(parseCsv(readFileSync(w.result.files[2], 'utf8'))[0].app, 'Salesforce');
  assert.equal(readAudit(join(root, '.mythos', 'audit.jsonl')).find((e) => e.tool === 'helios_write_review').output_sha256, w.result.output_sha256);
});

test('config schema: fixture validates; 3 mutated policies fail with JSON pointers before any work', async () => {
  const s = manifest.configSchemas['helios-policy'];
  assert.deepEqual(validate(s, policy).errors, []);
  const root = tmpRoot('helios2-cfg-');
  const rt = new AgentRuntime(manifest, { root, audit: false });
  const mutants = {
    'unknown.json': [{ ...policy, apps: { ...policy.apps, Zoom: { ...policy.apps.Zoom, renewal: '2027-01-01' } } }, '/apps/Zoom/renewal'],
    'type.json': [{ ...policy, idle_days: '60' }, '/idle_days'],
    'enum.json': [{ ...policy, apps: { Zoom: { billing: 'quarterly' } } }, '/apps/Zoom/billing'],
  };
  for (const [f, [cfg, ptr]] of Object.entries(mutants)) {
    writeFileSync(join(root, f), JSON.stringify(cfg));
    const v = validate(s, cfg); assert.equal(v.ok, false); assert.ok(v.errors.some((e) => e.path === ptr), `${f} ${JSON.stringify(v.errors)}`);
    const r = await rt.call('helios_find_waste', { seats: 'seats.csv', policy: f });
    assert.equal(r.status, 'error'); assert.ok(JSON.stringify(r).includes(ptr), f);
  }
  // missing required argument and a wrong-typed argument are refused by the input schema
  assert.equal((await rt.call('helios_compare_reviews', { seats: 'seats.csv' })).status, 'error');
  assert.equal((await rt.call('helios_find_waste', { seats: 'seats.csv', as_of: '14/11/2026' })).status, 'error');
});

test('contracts CSV overrides the policy', () => {
  const t = contractTerms(policy, [{ app: 'zoom', billing: 'Monthly', min_seats: '0' }]);
  assert.equal(t.get('zoom').billing, 'monthly'); assert.equal(t.get('zoom').min_seats, 0); assert.equal(t.get('zoom').owner, 'it-admin@example.com');
});

test('MCP prompt covers the workflow', async () => {
  const p = manifest.prompts[0];
  for (const t of ['helios_find_waste', 'helios_compare_reviews', 'helios_write_review', 'helios_renewal_calendar', 'helios_draft_confirmations', 'helios_request_revoke', 'one human click']) assert.ok(p.text.includes(t), t);
  const h = createMcpHandler(new AgentRuntime(manifest, { root: tmpRoot('helios2-p-'), audit: false }));
  const r = await h({ jsonrpc: '2.0', id: 1, method: 'prompts/get', params: { name: 'helios_seat_review', arguments: { seats: 'seats.csv' } } });
  assert.match(r.result.messages[0].content.text, /seats "seats\.csv"/);
});
