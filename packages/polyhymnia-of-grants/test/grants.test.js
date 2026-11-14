import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentRuntime, ApprovalStore, parseCsv } from 'mythos-agent-core';
import { manifest, review, deadlines, deadlineStatus, budgetReview, outcomeReview } from '../src/index.js';
const fixtures = fileURLToPath(new URL('../fixtures', import.meta.url));
const rd = (f) => parseCsv(readFileSync(join(fixtures, f), 'utf8'));
const tmpRoot = (p) => { const r = mkdtempSync(join(tmpdir(), p)); cpSync(fixtures, r, { recursive: true }); return r; };
const as_of = '2026-11-14';
const full = () => review({ grants: rd('grants.csv'), budget: rd('budget.csv'), outcomes: rd('outcomes.csv'), exists: (p) => existsSync(join(fixtures, p)), as_of });

test('deadline statuses and order', () => {
  assert.equal(deadlineStatus(-1, false), 'overdue'); assert.equal(deadlineStatus(30, false), 'due_soon'); assert.equal(deadlineStatus(31, false), 'upcoming');
  assert.equal(deadlineStatus(200, false), 'later'); assert.equal(deadlineStatus(-5, true), 'submitted'); assert.equal(deadlineStatus(null, false), 'no_due_date');
  assert.deepEqual(deadlines(rd('grants.csv'), { as_of }).map((g) => `${g.grant_id}:${g.status}`), ['G2:overdue', 'G1:due_soon', 'G3:later', 'G4:submitted']);
});
test('budget pace against time elapsed', () => {
  const g = { period_start: '2026-01-01', period_end: '2026-12-31', award_amount: 1000 };
  const b = budgetReview(g, [{ line: 'A', budgeted: 100, spent: 120 }, { line: 'B', budgeted: 500, spent: 50 }, { line: 'C', budgeted: 400, spent: 350 }], { as_of });
  assert.deepEqual(b.lines.map((l) => l.flags), [['over_budget'], ['behind_pace'], []]);
  assert.deepEqual(b.flags, []);
  assert.deepEqual(budgetReview({ ...g, award_amount: 5 }, [{ line: 'A', budgeted: 1, spent: 0 }], { as_of }).flags, ['budget_total_differs_from_award']);
  assert.deepEqual(budgetReview(g, [{ line: 'X', budgeted: 100, spent: 99 }], { as_of: '2026-03-01' }).lines[0].flags, ['ahead_of_pace']);
});
test('outcomes: missing actual, missing or unfound evidence, below target', () => {
  const o = outcomeReview([{ metric: 'a', target: 10, actual: 12, evidence: 'x' }, { metric: 'b', target: 10, actual: '', evidence: '' }, { metric: 'c', target: 10, actual: 5, evidence: 'nope' }], (p) => p === 'x');
  assert.deepEqual(o.map((x) => x.flags), [[], ['missing_actual', 'missing_evidence'], ['below_target', 'evidence_not_found']]);
});
test('full review gaps; submitted grants have none', () => {
  const r = full(); const by = Object.fromEntries(r.items.map((g) => [g.grant_id, g]));
  assert.equal(r.overdue, 1); assert.equal(r.due_soon, 1); assert.equal(by.G4.open_items, 0);
  assert.ok(by.G2.gaps.some((x) => /award is 20,000.00/.test(x)));
  assert.ok(by.G1.gaps.some((x) => /Books and materials": over budget/.test(x)));
  assert.ok(by.G3.gaps.some((x) => /evidence not found \(evidence\/g3-signups.csv\)/.test(x)));
  assert.equal(r.open_items, 13);
});
test('packets on Auto leave the narrative to a person; submission is one-click; portal blocked', async () => {
  const root = tmpRoot('poly-');
  const f = { grants: 'grants.csv', budget: 'budget.csv', outcomes: 'outcomes.csv', as_of };
  const rt = new AgentRuntime(manifest, { root, mode: 'auto', autoActions: ['polyhymnia_build_packet'] });
  const p = await rt.call('polyhymnia_build_packet', f); assert.equal(p.status, 'executed'); assert.equal(p.result.files.length, 9, 'three packets, submitted G4 skipped');
  const draft = readFileSync(join(root, 'mythos-out/polyhymnia/packets/G1/report-draft.md'), 'utf8');
  assert.match(draft, /DRAFT packet — not submitted/); assert.match(draft, /\[TO WRITE — a person writes this/); assert.match(draft, /\[EXPLAIN — over budget\]/); assert.match(draft, /\[MISSING EVIDENCE\]/);
  assert.ok(!/compliant/i.test(draft));
  const idx = parseCsv(readFileSync(join(root, 'mythos-out/polyhymnia/packets/G1/evidence-index.csv'), 'utf8'));
  assert.deepEqual(idx.map((x) => x.found), ['yes', 'yes', 'no']); assert.equal(idx[0].sha256.length, 16);
  assert.throws(() => new AgentRuntime(manifest, { audit: false, mode: 'auto', autoActions: ['polyhymnia_request_submission'] }), /one-click/);
  const args = { grant_id: 'G1', packet: 'mythos-out/polyhymnia/packets/G1/report-draft.md' };
  const a = await rt.call('polyhymnia_request_submission', args); assert.equal(a.status, 'needs_approval');
  new ApprovalStore(join(root, '.mythos')).approve(a.approval_id, 'Morgan');
  const b = await rt.call('polyhymnia_request_submission', args); assert.equal(b.status, 'executed'); assert.equal(b.approved_by, 'Morgan');
  assert.ok(b.result.open_markers >= 3); assert.match(b.result.summary, /Nothing was submitted/);
  assert.equal((await rt.call('polyhymnia_request_submission', args)).status, 'needs_approval', 'single-use');
  assert.equal((await rt.call('funder_portal_submit', {})).status, 'blocked');
  assert.equal((await rt.call('polyhymnia_build_packet', { ...f, grant_id: 'G9' })).status, 'error');
});
