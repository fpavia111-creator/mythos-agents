import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentRuntime, ApprovalStore, parseCsv } from 'mythos-agent-core';
import { manifest, review, readReceipt, maskNumbers, validatePolicy } from '../src/index.js';
const fixtures = fileURLToPath(new URL('../fixtures', import.meta.url));
const lines = parseCsv(readFileSync(join(fixtures, 'expenses.csv'), 'utf8'));
const policy = JSON.parse(readFileSync(join(fixtures, 'policy.json'), 'utf8'));
const tmpRoot = (p) => { const r = mkdtempSync(join(tmpdir(), p)); cpSync(fixtures, r, { recursive: true }); return r; };
const run = () => review(lines, policy, { receiptsDir: join(fixtures, 'receipts') });
const line = (r, rep, id) => r.items.find((l) => l.report_id === rep && l.line_id === id);

test('receipt reading and masking', () => {
  assert.deepEqual(readReceipt('Lunch\n2026-10-06\nSubtotal 10.00\nTotal: $1,210.50').amounts, [1210.5]);
  assert.equal(readReceipt('09/02/2026 Total 64.00').dates[0], Date.UTC(2026, 8, 2));
  assert.equal(maskNumbers('card 4111 1111 1111 1111 ok'), 'card •••• 1111 ok');
  assert.throws(() => validatePolicy({ currency: 'USD' }), /policy.source is required/);
});
test('line findings cite the policy section', () => {
  const r = run();
  const din = line(r, 'R-101', '2'); assert.equal(din.decision, 'approve_capped'); assert.equal(din.allowed, 150); assert.equal(din.findings[0].policy_section, '§3.1 Meals');
  assert.equal(line(r, 'R-101', '3').decision, 'approve', 'mileage 140 × 0.70 = 98.00');
  const fl = line(r, 'R-103', '1'); assert.deepEqual(fl.findings.map((f) => f.check), ['preapproval_missing', 'receipt_amount_mismatch', 'late_submission']);
  assert.equal(line(r, 'R-103', '2').decision, 'reject'); assert.equal(line(r, 'R-103', '2').findings[0].policy_section, '§4.1');
  assert.deepEqual(line(r, 'R-104', '3').findings.map((f) => f.check), ['possible_duplicate', 'receipt_reused']); assert.equal(line(r, 'R-104', '4').findings[0].check, 'missing_receipt');
  assert.match(line(r, 'R-104', '3').findings[0].detail, /not a finding of wrongdoing/);
  assert.equal(line(r, 'R-104', '1').findings[0].check, 'attendees_missing');
  for (const l of r.items) for (const f of l.findings) assert.ok(f.policy_section, `${l.report_id}/${l.line_id} ${f.check} has a section`);
});
test('report recommendations and totals', () => {
  const r = run(); const by = Object.fromEntries(r.report_summaries.map((s) => [s.report_id, s]));
  assert.deepEqual([by['R-101'].recommendation, by['R-102'].recommendation, by['R-103'].recommendation, by['R-104'].recommendation, by['R-105'].recommendation], ['approve_with_changes', 'approve', 'needs_info', 'needs_info', 'reject']);
  assert.equal(by['R-101'].recommended, 728); assert.equal(r.recommended, 799); assert.equal(r.claimed, 1732.9);
  const missing = review([{ report_id: 'X', line_id: '1', employee: 'Z', date: '2026-11-01', category: 'ground', merchant: 'Cab', amount: '40', purpose: 'Trip' }], policy);
  assert.equal(missing.items[0].findings[0].check, 'missing_receipt');
  assert.equal(review([{ report_id: 'X', category: 'yacht', amount: '1', purpose: 'p' }], policy).items[0].findings[0].check, 'unknown_category');
});
test('no receipt text or card number leaks into results', () => {
  const out = JSON.stringify(run());
  for (const s of ['Room 214', 'card ending 0000', 'Table 7', '4111 1111 1111 1111', 'MSP-DEN']) assert.ok(!out.includes(s), `${s} leaked`);
});
test('stage on Auto; reimbursement is one-click, hash-bound, tamper-checked; paying blocked', async () => {
  const root = tmpRoot('prax-'); const f = { expenses: 'expenses.csv', policy: 'policy.json', receipts: 'receipts' };
  const rt = new AgentRuntime(manifest, { root, mode: 'auto', autoActions: ['praxidike_stage_reimbursement'] });
  const s = await rt.call('praxidike_stage_reimbursement', f); assert.equal(s.status, 'executed'); assert.equal(s.result.total, 799);
  const staged = parseCsv(readFileSync(join(root, 'mythos-out/praxidike/staged-reimbursements.csv'), 'utf8'));
  assert.deepEqual(staged.map((x) => [x.report_id, x.amount, x.status]), [['R-101', '728.00', 'staged - not paid'], ['R-102', '71.00', 'staged - not paid']]);
  assert.throws(() => new AgentRuntime(manifest, { audit: false, mode: 'auto', autoActions: ['praxidike_request_reimbursement'] }), /one-click/);
  const args = { batch: s.result.batch, batch_sha256: s.result.batch_sha256 };
  const a = await rt.call('praxidike_request_reimbursement', args); assert.equal(a.status, 'needs_approval');
  new ApprovalStore(join(root, '.mythos')).approve(a.approval_id, 'Kim');
  writeFileSync(join(root, 'mythos-out/praxidike/staged-reimbursements.csv'), 'report_id,amount\nR-101,9999\n');
  const t = await rt.call('praxidike_request_reimbursement', args); assert.equal(t.status, 'error'); assert.match(t.reason, /changed after the batch was staged/);
  const s2 = await rt.call('praxidike_stage_reimbursement', { ...f, out_dir: 'mythos-out/p2' });
  const args2 = { batch: s2.result.batch, batch_sha256: s2.result.batch_sha256 };
  new ApprovalStore(join(root, '.mythos')).approve((await rt.call('praxidike_request_reimbursement', args2)).approval_id, 'Kim');
  const b = await rt.call('praxidike_request_reimbursement', args2); assert.equal(b.status, 'executed'); assert.equal(b.approved_by, 'Kim');
  assert.equal(parseCsv(readFileSync(b.result.file, 'utf8'))[0].status, 'approved - a person pays it');
  assert.equal((await rt.call('praxidike_request_reimbursement', args2)).status, 'needs_approval', 'approval is single-use');
  assert.equal((await rt.call('pay_reimbursement', {})).status, 'blocked'); assert.equal((await rt.call('ledger_post_expense', {})).status, 'blocked');
});
test('report files', async () => {
  const root = tmpRoot('prax-r-');
  const r = await new AgentRuntime(manifest, { root, audit: false }).call('praxidike_write_report', { expenses: 'expenses.csv', policy: 'policy.json', receipts: 'receipts' });
  const rows = parseCsv(readFileSync(r.result.files[1], 'utf8')); assert.equal(rows.length, 16); assert.equal(rows[0].reviewer, '');
  assert.match(readFileSync(r.result.files[0], 'utf8'), /Not fraud detection/);
});
