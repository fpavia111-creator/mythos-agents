import { defineManifest, toCsv } from 'mythos-agent-core';
import { readFileSync, existsSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { normRequests, normOrders, triage, evidenceMarkdown, queueCsv } from './triage.js';
import { classifyDispute, CHECKLISTS } from './reasons.js';
import { disputeEvidence, evidenceIndex, evidencePackHtml, disputeIcs } from './evidence.js';
import { REFUND_POLICY_SCHEMA } from './schemas.js';
import { PROMPTS } from './prompts.js';
import { SOURCES } from './sources.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const str = { type: 'string' }, num = { type: 'number' };
const files = { requests: { ...str, description: 'Refund/chargeback requests CSV/JSON: request_id, type, order_id, customer, amount, reason, requested_at, returned' }, orders: { ...str, description: 'Orders CSV/JSON: order_id, customer, amount, refunded, order_date, delivered_date, tracking, status' }, policy: { ...str, description: 'Policy JSON: window_days, window_from (delivered|ordered), review_over, max_refunds_per_customer_90d, chargeback_response_days, return_required_over, no_refund_reasons, reason_code_overrides (validated against the refund_policy schema)' } };
const run = (a, ctx) => { const orders = normOrders(ctx.records(a.orders, 'orders')); const requests = normRequests(ctx.records(a.requests, 'requests')); const policy = a.policy ? ctx.readJson(a.policy, 'refund_policy') : {}; return { orders, requests, policy, r: triage(requests, orders, policy) }; };

export const manifest = defineManifest({
  sources: SOURCES,
  name: 'soteria-of-refunds',
  version: pkg.version,
  description: 'Triages refund requests and chargebacks from CSV/JSON exports against your written policy: window, refundable balance, duplicates, repeat requests, returns, review thresholds, dispute deadlines. Drafts dispute evidence packs. Issuing money is blocked; a refund request is one human click and only records a request.',
  model: { provider: 'anthropic', id: 'claude-sonnet-4-5-20250929', note: 'Declared host-model pin. The tools are deterministic and call no model.' },
  caps: { maxSteps: 60, maxSpendUsd: 0 },
  configSchemas: { refund_policy: REFUND_POLICY_SCHEMA },
  prompts: PROMPTS,
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
      name: 'soteria_reason_code', kind: 'read', title: 'Look up a dispute reason code',
      description: 'Map a card-network dispute reason code (Visa, Mastercard, Amex, Discover) or reason text to a dispute category and its evidence checklist. A working guide, not the networks\' rules.',
      inputSchema: { type: 'object', properties: { code: { ...str, description: 'e.g. 13.1, 4853, C08, UA02' }, network: { type: 'string', enum: ['visa', 'mastercard', 'amex', 'discover', 'jcb', 'unionpay'] }, reason: { ...str, description: 'Free-text reason, used when there is no known code' } } },
      handler: async (a) => {
        if (!a.code && !a.reason) throw new Error('give a code or a reason');
        const c = classifyDispute({ reason_code: a.code, network: a.network, reason: a.reason });
        return { summary: `${c.code || 'no code'} (${c.network || 'network unknown'}): ${c.category} — ${c.label}.`, ...c, checklist: CHECKLISTS[c.category].map(({ id, label, check }) => ({ id, label, checkable_from_exports: !!check })) };
      },
    },
    {
      name: 'soteria_evidence_pack', kind: 'report', title: 'Dispute evidence packs',
      description: 'For each chargeback (or one request_id): map the reason code to a category, build the evidence checklist, mark what your exports already show and what a person must attach, give a readiness score with its explanation, and cite every source row used. Writes evidence-<id>.html per dispute, evidence-index.json (hash recorded in the audit log) and dispute-deadlines.ics into out_dir (default mythos-out/soteria).',
      inputSchema: { type: 'object', required: ['requests', 'orders'], properties: { ...files, request_id: str, out_dir: str } },
      handler: async (a, ctx) => {
        const { orders, requests, policy, r } = run(a, ctx);
        let items = r.items.filter((x) => x.type === 'chargeback' && x.suggestion !== 'hold_duplicate');
        if (a.request_id) { items = r.items.filter((x) => x.request_id === a.request_id); if (!items.length) throw new Error(`request ${a.request_id} not found`); if (items[0].type !== 'chargeback') throw new Error(`${a.request_id} is a refund request, not a chargeback`); }
        const src = { requestsFile: a.requests, ordersFile: a.orders, policyFile: a.policy || null, policySha256: a.policy ? ctx.hashFile(a.policy) : null };
        const list = items.map((i) => disputeEvidence(i, orders, requests, { ...r.policy, ...policy }, src));
        const idx = evidenceIndex(list, { sources: { requests: { file: a.requests, sha256: ctx.hashFile(a.requests) }, orders: { file: a.orders, sha256: ctx.hashFile(a.orders) }, policy: a.policy ? { file: a.policy, sha256: src.policySha256 } : null } });
        const out = ctx.outDir(a.out_dir || 'mythos-out/soteria');
        const fl = list.map((d) => ctx.writeFile(out, `evidence-${d.request_id.replace(/[^A-Za-z0-9_-]/g, '_')}.html`, evidencePackHtml(d)));
        fl.push(ctx.writeFile(out, 'evidence-index.json', idx.json), ctx.writeFile(out, 'dispute-deadlines.ics', disputeIcs(list)));
        return { summary: `${list.length} evidence pack(s): ${list.map((d) => `${d.request_id} ${d.classification.category} ${d.readiness.score ?? '-'}%`).join(', ') || 'no chargebacks'}.`, output_sha256: idx.output_sha256, disputes: list.map((d) => ({ request_id: d.request_id, category: d.classification.category, code: d.classification.code, respond_by: d.respond_by, readiness: d.readiness, missing: d.checklist.filter((c) => c.status === 'missing').map((c) => c.id), attach: d.checklist.filter((c) => c.status === 'attach').map((c) => c.id) })), files: fl };
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
    { tool: 'soteria_reason_code', decision: 'allow' },
    { tool: 'soteria_evidence_pack', decision: 'allow' },
    { tool: 'payments_issue_refund', decision: 'block', reason: 'Soteria never moves money.' },
    { tool: 'payments_submit_dispute', decision: 'block', reason: 'A person submits dispute evidence through the processor.' },
    { tool: 'soteria_request_refund', decision: 'ask', reason: 'Refunds move money: one named human click, even in Auto.' },
    { tool: '*', decision: 'block', reason: 'Not on the Soteria allowlist.' },
  ] },
});
