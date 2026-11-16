import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { AgentRuntime, ApprovalStore, validateIcs, readAudit, createMcpHandler, parseCsv } from 'mythos-agent-core';
import { manifest, classifyDispute, detectNetwork, CHECKLISTS, normRequests, normOrders, triage, queueCsv, QUEUE_COLUMNS, disputeEvidence } from '../src/index.js';

const fixtures = fileURLToPath(new URL('../fixtures', import.meta.url));
const tmpRoot = (p) => { const r = mkdtempSync(join(tmpdir(), p)); cpSync(fixtures, r, { recursive: true }); return r; };
const D = { requests: 'disputes.csv', orders: 'orders.csv', policy: 'policy.json' };

test('reason codes map to categories for each network; text fallback; policy overrides win', () => {
  const c = (code, network, reason) => classifyDispute({ reason_code: code, network, reason });
  assert.equal(c('13.1').category, 'not_received'); assert.equal(c('13.1').network, 'visa');
  assert.equal(c('10.4').category, 'fraud'); assert.equal(c('12.6.1').category, 'duplicate');
  assert.equal(c('4853').category, 'not_as_described'); assert.equal(c('4853').network, 'mastercard');
  assert.equal(c('4837').category, 'fraud'); assert.equal(c('C08').category, 'not_received'); assert.equal(c('C08').network, 'amex');
  assert.equal(c('UA02').category, 'fraud'); assert.equal(c('rg', 'Discover').category, 'not_received');
  assert.equal(c('', '', 'Charged twice for one order').category, 'duplicate');
  assert.equal(c('', '', 'item never arrived').source, 'reason_text');
  assert.equal(c('9999', '', 'hello').category, 'general');
  assert.equal(classifyDispute({ reason_code: '4853' }, { 4853: 'credit_not_processed' }).category, 'credit_not_processed');
  assert.equal(detectNetwork('', 'MC'), 'mastercard');
});

test('evidence checklist differs per reason code', () => {
  const ids = (cat) => CHECKLISTS[cat].map((x) => x.id).join();
  const cats = ['fraud', 'not_received', 'not_as_described', 'duplicate', 'credit_not_processed', 'cancelled_recurring'];
  assert.equal(new Set(cats.map(ids)).size, cats.length);
  assert.ok(CHECKLISTS.fraud.some((x) => x.id === 'avs_cvv')); assert.ok(!CHECKLISTS.not_received.some((x) => x.id === 'avs_cvv'));
  assert.ok(CHECKLISTS.not_received.some((x) => x.id === 'tracking'));
});

test('readiness marks what exports show; prior undisputed orders found 120-365 days back', () => {
  const orders = normOrders([
    { order_id: 'O1', customer: 'a@x.example', amount: '50', order_date: '2026-10-01', delivered_date: '', tracking: '' },
    { order_id: 'P1', customer: 'a@x.example', amount: '10', order_date: '2026-03-01' },
    { order_id: 'P2', customer: 'a@x.example', amount: '10', order_date: '2026-05-01' },
    { order_id: 'P3', customer: 'a@x.example', amount: '10', order_date: '2026-10-20' },
  ]);
  const reqs = normRequests([{ request_id: 'X1', type: 'chargeback', order_id: 'O1', customer: 'a@x.example', amount: '50', reason: 'fraud', reason_code: '10.4', requested_at: '2026-11-10' }]);
  const r = triage(reqs, orders);
  const d = disputeEvidence(r.items[0], orders, reqs, r.policy, { requestsFile: 'd.csv', ordersFile: 'o.csv' });
  assert.equal(d.classification.category, 'fraud');
  assert.equal(d.checklist.find((c) => c.id === 'prior_undisputed').status, 'on_file');
  assert.equal(d.checklist.find((c) => c.id === 'tracking').status, 'missing');
  assert.equal(d.readiness.score, 33); assert.match(d.readiness.explain, /Not a prediction/);
  assert.deepEqual(d.citations.map((c) => `${c.source}:${c.row}`), ['d.csv:2', 'o.csv:2', 'o.csv:3', 'o.csv:4']);
  // a disputed earlier order does not count
  const reqs2 = normRequests([...[{ request_id: 'X0', type: 'chargeback', order_id: 'P1', customer: 'a@x.example', amount: '10', reason: 'fraud', requested_at: '2026-04-01' }], { request_id: 'X1', type: 'chargeback', order_id: 'O1', customer: 'a@x.example', amount: '50', reason: 'fraud', reason_code: '10.4', requested_at: '2026-11-10' }]);
  const r2 = triage(reqs2, orders);
  assert.equal(disputeEvidence(r2.items[1], orders, reqs2, r2.policy, { requestsFile: 'd.csv', ordersFile: 'o.csv' }).checklist.find((c) => c.id === 'prior_undisputed').status, 'missing');
});

test('evidence pack cites every source row, hashes the index into the audit line, writes a valid .ics', async () => {
  const root = tmpRoot('sot2-');
  const rt = new AgentRuntime(manifest, { root });
  const e = await rt.call('soteria_evidence_pack', D);
  assert.equal(e.status, 'executed', e.reason);
  const idxFile = e.result.files.find((f) => f.endsWith('evidence-index.json'));
  const json = readFileSync(idxFile, 'utf8'); const idx = JSON.parse(json);
  assert.equal(createHash('sha256').update(json).digest('hex'), e.result.output_sha256);
  assert.equal(idx.disputes.length, 6);
  const disputesCsv = parseCsv(readFileSync(join(root, 'disputes.csv'), 'utf8'));
  const ordersCsv = parseCsv(readFileSync(join(root, 'orders.csv'), 'utf8'));
  for (const d of idx.disputes) {
    const html = readFileSync(e.result.files.find((f) => f.endsWith(`evidence-${d.request_id}.html`)), 'utf8');
    const dRow = disputesCsv.findIndex((x) => x.request_id === d.request_id) + 2;
    const oRow = ordersCsv.findIndex((x) => x.order_id === d.order_id) + 2;
    assert.ok(d.citations.some((c) => c.source === 'disputes.csv' && c.row === dRow), d.request_id);
    assert.ok(d.citations.some((c) => c.source === 'orders.csv' && c.row === oRow), d.request_id);
    assert.ok(d.citations.some((c) => c.source === 'policy.json'), d.request_id);
    for (const c of d.citations) if (c.row) assert.ok(html.includes(`<td>${c.source}</td><td>${c.row}</td>`), `${d.request_id} cites ${c.source}:${c.row}`);
    assert.match(html, /default-src 'none'/); assert.ok(!/<script/i.test(html));
  }
  const gil = idx.disputes.find((d) => d.request_id === 'D-2002');
  assert.ok(gil.citations.some((c) => /O-480/.test(c.what)) && gil.citations.some((c) => /O-481/.test(c.what)));
  assert.notDeepEqual(idx.disputes[0].checklist.map((c) => c.id), gil.checklist.map((c) => c.id));
  const ics = readFileSync(e.result.files.find((f) => f.endsWith('.ics')), 'utf8'); const v = validateIcs(ics);
  assert.ok(v.ok, v.errors.join()); assert.equal(v.events, 6);
  assert.equal(readAudit(join(root, '.mythos', 'audit.jsonl')).filter((l) => l.tool === 'soteria_evidence_pack').pop().output_sha256, e.result.output_sha256);
  const one = await rt.call('soteria_evidence_pack', { ...D, request_id: 'D-2003' }); assert.equal(one.result.disputes.length, 1);
  const bad = await rt.call('soteria_evidence_pack', { requests: 'requests.csv', orders: 'orders.csv', request_id: 'R-1001' }); assert.equal(bad.status, 'error'); assert.match(bad.reason, /not a chargeback/);
});

test('policy file is validated: unknown key, wrong type and missing required fail with JSON pointers', async () => {
  const root = tmpRoot('sot3-'); const base = JSON.parse(readFileSync(join(fixtures, 'policy.json'), 'utf8'));
  const rt = new AgentRuntime(manifest, { root, audit: false });
  const bad = { unknown: { ...base, window_dayz: 30 }, wrongType: { ...base, review_over: 'two hundred' }, missing: { review_over: 100 }, badOverride: { ...base, reason_code_overrides: { 4853: 'bogus' } } };
  const ptr = { unknown: /window_dayz/, wrongType: /\/review_over/, missing: /window_days/, badOverride: /\/reason_code_overrides\/4853/ };
  for (const [name, body] of Object.entries(bad)) {
    writeFileSync(join(root, `${name}.json`), JSON.stringify(body));
    const r = await rt.call('soteria_triage', { requests: 'requests.csv', orders: 'orders.csv', policy: `${name}.json` });
    assert.equal(r.status, 'error', name); assert.match(r.reason, /not a valid refund_policy/, name); assert.match(JSON.stringify(r.errors), ptr[name], name);
  }
  assert.equal((await rt.call('soteria_triage', { requests: 'requests.csv', orders: 'orders.csv', policy: 'policy.json' })).status, 'executed');
});

test('queue carries the dispute category; refunds stay one-click; prompt renders', async () => {
  const orders = normOrders([{ order_id: 'O1', amount: '10', delivered_date: '2026-10-01' }]);
  const r = triage(normRequests([{ request_id: 'C1', type: 'chargeback', order_id: 'O1', amount: '10', reason: 'x', reason_code: 'C31', requested_at: '2026-10-05' }]), orders);
  assert.equal(parseCsv(queueCsv(r))[0].dispute_category, 'not_as_described'); assert.ok(QUEUE_COLUMNS.includes('dispute_category'));
  const root = tmpRoot('sot4-');
  assert.throws(() => new AgentRuntime(manifest, { audit: false, mode: 'auto', autoActions: ['soteria_request_refund'] }), /one-click/);
  const rt = new AgentRuntime(manifest, { root, mode: 'auto' });
  const args = { request_id: 'D-2004', order_id: 'O-509', amount: 12.5, reason: 'v020 one-click test' };
  const a = await rt.call('soteria_request_refund', args); assert.equal(a.status, 'needs_approval');
  new ApprovalStore(join(root, '.mythos')).approve(a.approval_id, 'Robin (fictional)');
  assert.equal((await rt.call('soteria_request_refund', args)).status, 'executed');
  assert.equal((await rt.call('soteria_request_refund', args)).status, 'needs_approval');
  const review = new AgentRuntime(manifest, { root, mode: 'review', audit: false });
  assert.equal((await review.call('soteria_evidence_pack', D)).status, 'executed');
  assert.equal((await review.call('soteria_reason_code', { code: '13.3' })).result.category, 'not_as_described');
  const handle = createMcpHandler(new AgentRuntime(manifest, { root, audit: false }));
  const got = await handle({ jsonrpc: '2.0', id: 1, method: 'prompts/get', params: { name: 'refund_and_dispute_workflow', arguments: { requests: 'disputes.csv', orders: 'orders.csv' } } });
  const text = got.result.messages[0].content.text;
  assert.match(text, /disputes\.csv/); assert.match(text, /soteria_evidence_pack/); assert.match(text, /one click/); assert.match(text, /\[policy\]/);
});
