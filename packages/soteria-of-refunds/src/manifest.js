import { defineManifest, toCsv } from 'mythos-agent-core';
import { readFileSync, existsSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { normRequests, normOrders, triage, evidenceMarkdown, queueCsv } from './triage.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const str = { type: 'string' }, num = { type: 'number' };
const files = { requests: { ...str, description: 'Refund/chargeback requests CSV/JSON: request_id, type, order_id, customer, amount, reason, requested_at, returned' }, orders: { ...str, description: 'Orders CSV/JSON: order_id, customer, amount, refunded, order_date, delivered_date, tracking, status' }, policy: { ...str, description: 'Policy JSON: window_days, window_from (delivered|ordered), review_over, max_refunds_per_customer_90d, chargeback_response_days, return_required_over' } };
const run = (a, ctx) => { const orders = normOrders(ctx.records(a.orders)); return { orders, r: triage(normRequests(ctx.records(a.requests)), orders, a.policy ? JSON.parse(readFileSync(ctx.path(a.policy), 'utf8')) : {}) }; };

export const manifest = defineManifest({
  name: 'soteria-of-refunds',
  version: pkg.version,
  description: 'Triages refund requests and chargebacks from CSV/JSON exports against your written policy: window, refundable balance, duplicates, repeat requests, returns, review thresholds, dispute deadlines. Drafts dispute evidence packs. Issuing money is blocked; a refund request is one human click and only records a request.',
  model: { provider: 'anthropic', id: 'claude-sonnet-4-5-20250929', note: 'Declared host-model pin. The tools are deterministic and call no model.' },
  caps: { maxSteps: 60, maxSpendUsd: 0 },
  tools: [
    {
      name: 'soteria_triage', kind: 'read',
      description: 'Check each request against the policy and order data and suggest: eligible, needs review, deny per policy, hold duplicate, or prepare dispute evidence.',
      inputSchema: { type: 'object', required: ['requests', 'orders'], properties: files },
      handler: async (a, ctx) => { const { r } = run(a, ctx); return { summary: `${r.requests} request(s): ${r.eligible} eligible ($${r.eligible_amount}), ${r.needs_review} need review, ${r.deny_per_policy} outside policy, ${r.duplicates} duplicate(s), ${r.chargebacks} chargeback(s).`, ...r }; },
    },
    {
      name: 'soteria_explain', kind: 'read',
      description: 'Explain one request: each flag, the policy rule behind it, and the suggestion.',
      inputSchema: { type: 'object', required: ['requests', 'orders', 'request_id'], properties: { ...files, request_id: str } },
      handler: async (a, ctx) => {
        const { r } = run(a, ctx); const i = r.items.find((x) => x.request_id === a.request_id); if (!i) throw new Error(`request ${a.request_id} not found`);
        const why = { order_not_found: 'No order with this id in the orders export.', amount_missing: 'The request has no amount.', check_tracking: 'Not marked delivered; check the carrier.', no_tracking: 'Not marked delivered and no tracking on file.', return_not_received: `Policy asks for a return over ${r.policy.return_required_over}.` };
        const lines = i.flags.map((f) => ({ flag: f, meaning: why[f] || (f.startsWith('outside_window') ? `Requested after the ${r.policy.window_days}-day window (from ${r.policy.window_from}).` : f.startsWith('exceeds_refundable') ? 'More than the order total minus earlier refunds.' : f.startsWith('repeat_requests') ? `More than ${r.policy.max_refunds_per_customer_90d} requests from this customer in 90 days.` : f.startsWith('over_review') ? 'Above the amount your policy sends to a person.' : f.startsWith('duplicate') ? 'Same order already has a request of this type.' : '') }));
        return { summary: `${i.request_id}: ${i.suggestion.replace(/_/g, ' ')}${i.flags.length ? ` (${i.flags.join(', ')})` : ''}.`, request: i, explanations: lines };
      },
    },
    {
      name: 'soteria_write_queue', kind: 'report',
      description: 'Write refund-queue.csv (blank decision columns) and one dispute evidence draft per chargeback into out_dir (default mythos-out/soteria).',
      inputSchema: { type: 'object', required: ['requests', 'orders'], properties: { ...files, out_dir: str } },
      handler: async (a, ctx) => {
        const { orders, r } = run(a, ctx); const out = ctx.outDir(a.out_dir || 'mythos-out/soteria'); const at = new Date().toISOString();
        const fl = [ctx.writeFile(out, 'refund-queue.csv', queueCsv(r))];
        for (const i of r.items.filter((x) => x.type === 'chargeback' && x.suggestion !== 'hold_duplicate')) fl.push(ctx.writeFile(out, `dispute-${i.request_id.replace(/[^A-Za-z0-9_-]/g, '_')}.md`, evidenceMarkdown(i, orders.get(i.order_id), at)));
        return { summary: `Queue written with ${r.requests} request(s) and ${fl.length - 1} dispute draft(s).`, files: fl };
      },
    },
    {
      name: 'soteria_request_refund', kind: 'action', category: 'move_money',
      description: 'After one named human click (even in Auto), record an approved refund in refund-requests.csv for a person to issue in your payment system. Soteria never moves money.',
      inputSchema: { type: 'object', required: ['request_id', 'order_id', 'amount', 'reason'], properties: { request_id: str, order_id: str, amount: num, reason: str, out_dir: str } },
      handler: async (a, ctx) => {
        for (const k of ['request_id', 'order_id', 'reason']) if (!String(a[k] || '').trim()) throw new Error(`${k} is required`);
        if (!(Number(a.amount) > 0)) throw new Error('amount must be positive');
        const out = ctx.outDir(a.out_dir || 'mythos-out/soteria'); const f = join(out, 'refund-requests.csv');
        const csv = toCsv([{ requested_at: new Date().toISOString(), request_id: a.request_id, order_id: a.order_id, amount: a.amount, reason: a.reason, status: 'approved request - a person issues it in the payment system' }], ['requested_at', 'request_id', 'order_id', 'amount', 'reason', 'status']);
        appendFileSync(f, existsSync(f) ? csv.split('\n').slice(1).join('\n') : csv);
        return { summary: `Refund request recorded for ${a.request_id} (${a.amount}). No money moved.`, file: f };
      },
    },
    { name: 'payments_issue_refund', kind: 'action', category: 'move_money', description: 'Listed so agents can see it is refused. Soteria never issues refunds or touches a payment processor.', inputSchema: { type: 'object', properties: {} } },
    { name: 'payments_submit_dispute', kind: 'action', category: 'binding_send', description: 'Listed so agents can see it is refused. A person submits dispute evidence.', inputSchema: { type: 'object', properties: {} } },
  ],
  policy: { rules: [
    { tool: 'soteria_triage', decision: 'allow' },
    { tool: 'soteria_explain', decision: 'allow' },
    { tool: 'soteria_write_queue', decision: 'allow' },
    { tool: 'payments_issue_refund', decision: 'block', reason: 'Soteria never moves money.' },
    { tool: 'payments_submit_dispute', decision: 'block', reason: 'A person submits dispute evidence through the processor.' },
    { tool: 'soteria_request_refund', decision: 'ask', reason: 'Refunds move money: one named human click, even in Auto.' },
    { tool: '*', decision: 'block', reason: 'Not on the Soteria allowlist.' },
  ] },
});
