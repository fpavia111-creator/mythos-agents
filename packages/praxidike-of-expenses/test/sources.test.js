// Real-export adapters: sample exports in fixtures/exports are recognised and
// mapped onto Praxidike's own columns.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentRuntime } from 'mythos-agent-core';
import { manifest } from '../src/index.js';

const fixtures = fileURLToPath(new URL('../fixtures', import.meta.url));
const POLICY = 'exports/policy-with-aliases.json';
const review = async (expenses, policy = POLICY, root = fixtures) => {
  const r = await new AgentRuntime(manifest, { root, audit: false }).call('praxidike_review', { expenses, policy });
  assert.equal(r.status, 'executed', r.reason);
  return r;
};
const line = (r, merchant) => r.result.items.find((i) => i.merchant === merchant);

test('native expense lines are read untouched', async () => { assert.equal((await review('expenses.csv', 'policy.json')).sources, undefined); });

test('Ramp transactions: grouped per cardholder, card categories looked up in the policy, attendees counted from names', async () => {
  const r = await review('exports/ramp-transactions.csv');
  const s = r.sources[0]; assert.equal(s.profile, 'ramp_transactions'); assert.equal(s.mapped.employee, 'User'); assert.deepEqual(s.warnings, []);
  assert.equal(r.result.reports, 3); assert.deepEqual(r.result.report_summaries.map((x) => x.report_id), ['Card: Ana Ortiz', 'Card: Dev Patel', 'Card: Ben Cho']);
  const dinner = line(r, 'Lakeside Grill'); assert.equal(dinner.category, 'meals'); assert.equal(dinner.attendees, 2); assert.equal(dinner.date, '2026-10-06'); assert.equal(dinner.allowed, 150);
  assert.equal(line(r, 'Harbor Inn').amount, 1480, 'thousands comma read');
  assert.ok(line(r, 'Metro Rideshare Inc').findings.some((f) => f.check === 'missing_receipt'), 'Has Receipt = false');
  assert.ok(!line(r, 'Diagram Tool').findings.some((f) => f.check === 'missing_receipt'), 'Has Receipt = true with no link still counts as a receipt on file');
  assert.equal(line(r, 'Skyline Lounge').decision, 'reject'); assert.equal(line(r, 'Skyline Lounge').category, 'alcohol');
  assert.match(s.note, /company card/);
});

test('without category_aliases the card categories are reported as unknown, not guessed', async () => {
  const r = await review('exports/ramp-transactions.csv', 'policy.json');
  assert.ok(line(r, 'Lakeside Grill').findings.some((f) => f.check === 'unknown_category'));
});

test('staging a reimbursement from a company card export is refused', async () => {
  const root = mkdtempSync(join(tmpdir(), 'prax-src-')); cpSync(fixtures, root, { recursive: true });
  const rt = new AgentRuntime(manifest, { root, mode: 'auto', autoActions: ['praxidike_stage_reimbursement'] });
  const r = await rt.call('praxidike_stage_reimbursement', { expenses: 'exports/ramp-transactions.csv', policy: POLICY });
  assert.equal(r.status, 'error'); assert.match(r.reason, /company card export .*nothing to reimburse/);
});

test('Expensify default CSV: non-reimbursable lines skipped; employee and report set per file in mythos-sources.json', async () => {
  const bare = await review('exports/expensify-default.csv');
  assert.equal(bare.sources[0].profile, 'expensify_default_csv'); assert.equal(bare.sources[0].rows, 2); assert.equal(bare.sources[0].skipped_rows, 1);
  assert.equal(bare.result.items[0].date, '2026-10-12'); assert.equal(line(bare, 'Lakeside Grill').category, 'meals'); assert.equal(bare.result.report_summaries[0].employee, '');
  const root = mkdtempSync(join(tmpdir(), 'prax-src-')); cpSync(fixtures, root, { recursive: true });
  writeFileSync(join(root, 'mythos-sources.json'), JSON.stringify({ files: { 'exports/expensify-default.csv': { set: { employee: 'Ben Cho', report_id: 'R-300', submitted_on: '2026-10-20' } } } }));
  const r = await review('exports/expensify-default.csv', POLICY, root);
  assert.deepEqual(r.result.report_summaries.map((x) => [x.report_id, x.employee]), [['R-300', 'Ben Cho']]);
});

test('a hand-made export with other column names maps by the "also called" list and finds duplicates against history', async () => {
  const root = mkdtempSync(join(tmpdir(), 'prax-src-')); cpSync(fixtures, root, { recursive: true });
  writeFileSync(join(root, 'claims.tsv'), 'Report\tSubmitter\tExpense Date\tExpense Type\tVendor\tTotal\tBusiness Purpose\tGuests\nR-400\tAna Ortiz\t06.10.2026\tmeals\tLakeside Grill\t210,00\tClient dinner\t3\n');
  const rt = new AgentRuntime(manifest, { root, audit: false });
  const r = await rt.call('praxidike_find_duplicates', { expenses: 'claims.tsv', history: 'history.csv' });
  assert.equal(r.status, 'executed', r.reason); assert.equal(r.sources[0].format, 'tsv'); assert.equal(r.sources[0].mapped.amount, 'Total');
  assert.equal(r.sources[0].dates_read_as, 'day/month/year'); assert.match(r.warnings[0], /read as day\/month\/year because the file writes dates with dots/);
  assert.equal(r.result.cross_period, 1, 'same dinner as H-090 in history');
});
