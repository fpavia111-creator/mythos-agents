import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentRuntime, ApprovalStore, parseCsv } from 'mythos-agent-core';
const fixtures = fileURLToPath(new URL('../fixtures', import.meta.url));
const tmpRoot = (p) => { const r = mkdtempSync(join(tmpdir(), p)); cpSync(fixtures, r, { recursive: true }); return r; };
async function oneClick(manifest, tool, args, root) {
  assert.throws(() => new AgentRuntime(manifest, { audit: false, mode: 'auto', autoActions: [tool] }), /one-click/);
  const rt = new AgentRuntime(manifest, { root, mode: 'auto' });
  const a = await rt.call(tool, args); assert.equal(a.status, 'needs_approval');
  new ApprovalStore(join(root, '.mythos')).approve(a.approval_id, 'Dana');
  const b = await rt.call(tool, args); assert.equal(b.status, 'executed'); assert.equal(b.approved_by, 'Dana');
  const again = await rt.call(tool, args); assert.equal(again.status, 'needs_approval', 'approval is single-use');
  return b;
}

import { manifest, normRequests, normOrders, triage, queueCsv, QUEUE_COLUMNS } from '../src/index.js';

const orders = normOrders([{ order_id: 'O1', customer: 'a@x', amount: '100', refunded: '0', order_date: '2026-10-01', delivered_date: '2026-10-05', tracking: 'T' }]);
const req = (o) => normRequests([{ request_id: 'R1', type: 'refund', order_id: 'O1', customer: 'a@x', amount: '40', reason: 'damaged', requested_at: '2026-10-20', returned: 'no', ...o }]);
test('eligible inside window; window counted from delivery or order date', () => {
  assert.equal(triage(req({}), orders).items[0].suggestion, 'eligible_per_policy');
  assert.equal(triage(req({ requested_at: '2026-11-03' }), orders).items[0].suggestion, 'eligible_per_policy');
  assert.match(triage(req({ requested_at: '2026-11-03' }), orders, { window_from: 'ordered' }).items[0].flags.join(), /outside_window_33/);
});
test('return required over threshold, review over amount, refundable balance', () => {
  assert.ok(triage(req({ reason: 'wrong size', amount: '60' }), orders).items[0].flags.includes('return_not_received'));
  assert.equal(triage(req({ amount: '90' }), orders, { review_over: 80 }).items[0].suggestion, 'needs_review');
  assert.match(triage(req({ amount: '120' }), orders).items[0].flags.join(), /exceeds_refundable_100/);
});
test('repeat requests within 90 days', () => {
  const rows = [1, 2, 3].map((n) => ({ request_id: `R${n}`, type: 'refund', order_id: 'O1', customer: 'a@x', amount: '1', reason: 'damaged', requested_at: `2026-10-${10 + n}` }));
  rows[1].type = 'chargeback';
  const r = triage(normRequests(rows), orders, { max_refunds_per_customer_90d: 2 });
  assert.ok(r.items[2].flags.some((f) => f.startsWith('repeat_requests_2')));
});
test('chargeback gets a respond-by date and evidence suggestion; queue columns', () => {
  const r = triage(req({ type: 'chargeback' }), orders, { chargeback_response_days: 10 });
  assert.equal(r.items[0].respond_by, '2026-10-30'); assert.equal(r.items[0].suggestion, 'prepare_dispute_evidence');
  assert.deepEqual(Object.keys(parseCsv(queueCsv(r))[0]), QUEUE_COLUMNS);
});
test('refund request is one-click even in Auto; issuing money is blocked', async () => {
  const root = tmpRoot('sot-');
  const b = await oneClick(manifest, 'soteria_request_refund', { request_id: 'R-1001', order_id: 'O-501', amount: 45, reason: 'ok' }, root);
  assert.match(b.result.summary, /No money moved/);
  const rt = new AgentRuntime(manifest, { root, mode: 'auto' });
  assert.equal((await rt.call('payments_issue_refund', {})).status, 'blocked');
  const w = await rt.call('soteria_write_queue', { requests: 'requests.csv', orders: 'orders.csv', policy: 'policy.json' });
  assert.equal(w.result.files.length, 2); assert.match(readFileSync(w.result.files[1], 'utf8'), /1Z999EXAMPLE06/);
});
