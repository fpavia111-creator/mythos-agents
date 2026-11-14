import { toCsv, toNumber, round2 } from 'mythos-agent-core';

const s = (v) => String(v ?? '').trim();
function col(row, names) {
  const keys = Object.keys(row);
  for (const want of names) { const k = keys.find((x) => x.toLowerCase().replace(/[^a-z0-9]/g, '') === want); if (k !== undefined) return row[k]; }
  return '';
}
export const DEFAULT_POLICY = Object.freeze({ window_days: 30, window_from: 'delivered', review_over: 200, max_refunds_per_customer_90d: 2, chargeback_response_days: 7, no_refund_reasons: ['change_of_mind_after_window'], return_required_over: 50 });

export const normRequests = (rows) => rows.map((r, i) => ({ row: i + 2, request_id: s(col(r, ['requestid', 'id', 'caseid', 'disputeid'])) || `R${i + 2}`, order_id: s(col(r, ['orderid', 'order', 'ordernumber'])), customer: s(col(r, ['customer', 'customeremail', 'email', 'customerid'])).toLowerCase(), amount: toNumber(col(r, ['amount', 'requestedamount', 'refundamount', 'disputeamount'])), reason: s(col(r, ['reason', 'reasoncode', 'category'])).toLowerCase(), type: /charge ?back|dispute/i.test(s(col(r, ['type', 'channel', 'kind']))) ? 'chargeback' : 'refund', requested_at: s(col(r, ['requestedat', 'date', 'createdat', 'opened', 'disputedate'])), returned: /^(yes|true|1|received)$/i.test(s(col(r, ['returned', 'returnreceived', 'itemreturned']))) }));
export const normOrders = (rows) => new Map(rows.map((r) => [s(col(r, ['orderid', 'order', 'ordernumber'])), { order_id: s(col(r, ['orderid', 'order', 'ordernumber'])), amount: toNumber(col(r, ['amount', 'total', 'ordertotal'])), refunded: toNumber(col(r, ['refunded', 'refundedamount', 'amountrefunded'])) || 0, ordered: s(col(r, ['orderdate', 'date', 'createdat'])), delivered: s(col(r, ['delivereddate', 'deliveredat', 'delivered'])), status: s(col(r, ['status', 'fulfillmentstatus'])).toLowerCase(), tracking: s(col(r, ['tracking', 'trackingnumber'])), customer: s(col(r, ['customer', 'customeremail', 'email', 'customerid'])).toLowerCase() }]));
const days = (a, b) => { const x = Date.parse(a), y = Date.parse(b); return Number.isFinite(x) && Number.isFinite(y) ? Math.floor((y - x) / 86400000) : null; };
const addDays = (d, n) => { const t = Date.parse(d); return Number.isFinite(t) ? new Date(t + n * 86400000).toISOString().slice(0, 10) : null; };

/** Triage each request against your policy. Suggestions only; nothing is refunded or disputed. */
export function triage(requests, orders, policy = {}) {
  const p = { ...DEFAULT_POLICY, ...policy };
  const seen = new Map(); const perCustomer = new Map();
  const items = requests.map((q) => {
    const o = orders.get(q.order_id); const flags = []; let suggestion; let due = null;
    const key = `${q.order_id}|${q.type}`;
    if (seen.has(key)) flags.push(`duplicate_of_${seen.get(key)}`); else seen.set(key, q.request_id);
    const prior = (perCustomer.get(q.customer) || []).filter((d) => { const n = days(d, q.requested_at); return n !== null && n <= 90 && n >= 0; });
    perCustomer.set(q.customer, [...(perCustomer.get(q.customer) || []), q.requested_at]);
    if (!o) flags.push('order_not_found');
    const remaining = o && o.amount !== null ? round2(o.amount - o.refunded) : null;
    if (o && q.amount !== null && remaining !== null && q.amount > remaining + 0.005) flags.push(`exceeds_refundable_${remaining}`);
    if (q.amount === null) flags.push('amount_missing');
    const start = o ? (p.window_from === 'ordered' ? o.ordered : o.delivered || o.ordered) : null;
    const age = start ? days(start, q.requested_at) : null;
    if (q.type === 'refund' && age !== null && age > p.window_days) flags.push(`outside_window_${age}_days`);
    if (o && !o.delivered && /not.?received|never.?arrived|missing/i.test(q.reason)) flags.push(o.tracking ? 'check_tracking' : 'no_tracking');
    if (prior.length >= p.max_refunds_per_customer_90d) flags.push(`repeat_requests_${prior.length}_in_90d`);
    if (q.amount !== null && q.amount > p.review_over) flags.push(`over_review_threshold_${p.review_over}`);
    if (q.type === 'refund' && q.amount !== null && q.amount > p.return_required_over && !q.returned && !/not.?received|never.?arrived|missing|damaged/i.test(q.reason)) flags.push('return_not_received');
    if (q.type === 'chargeback') {
      due = addDays(q.requested_at, p.chargeback_response_days);
      suggestion = flags.some((f) => f.startsWith('duplicate')) ? 'hold_duplicate' : o && o.delivered ? 'prepare_dispute_evidence' : 'review_accept_or_dispute';
    } else if (flags.some((f) => f.startsWith('duplicate'))) suggestion = 'hold_duplicate';
    else if (flags.includes('order_not_found') || flags.includes('amount_missing') || flags.some((f) => f.startsWith('exceeds_refundable'))) suggestion = 'needs_review';
    else if (flags.some((f) => f.startsWith('outside_window'))) suggestion = 'deny_per_policy_or_review';
    else if (flags.length) suggestion = 'needs_review';
    else suggestion = 'eligible_per_policy';
    return { ...q, order_found: !!o, refundable_remaining: remaining, flags, suggestion, respond_by: due };
  });
  const sum = (f) => round2(items.filter(f).reduce((t, i) => t + (i.amount || 0), 0));
  return { requests: items.length, eligible: items.filter((i) => i.suggestion === 'eligible_per_policy').length, needs_review: items.filter((i) => i.suggestion === 'needs_review' || i.suggestion === 'review_accept_or_dispute').length,
    deny_per_policy: items.filter((i) => i.suggestion === 'deny_per_policy_or_review').length, chargebacks: items.filter((i) => i.type === 'chargeback').length, duplicates: items.filter((i) => i.suggestion === 'hold_duplicate').length,
    eligible_amount: sum((i) => i.suggestion === 'eligible_per_policy'), disputed_amount: sum((i) => i.type === 'chargeback'), policy: p, items,
    note: 'Suggestions against the policy you supplied. A person decides each case; Soteria never issues refunds or answers disputes.' };
}

export function evidenceMarkdown(item, order, at) {
  const L = [`# Dispute evidence pack: ${item.request_id}`, '', `Generated ${at} by soteria-of-refunds. Draft for a person to review and submit through your processor.`, '',
    `- Order: ${item.order_id} · amount ${order?.amount ?? 'unknown'} · ordered ${order?.ordered || 'unknown'} · delivered ${order?.delivered || 'not recorded'}`,
    `- Tracking: ${order?.tracking || 'none on file'}`, `- Disputed: ${item.amount} · reason "${item.reason}" · opened ${item.requested_at} · respond by ${item.respond_by || 'check your processor'}`, `- Refunded so far: ${order?.refunded ?? 0}`, '',
    '## Attach before submitting', '', '- Proof of delivery (carrier record for the tracking number)', '- The order confirmation and the terms or refund policy shown at checkout', '- Customer messages about this order', '- Any prior refund or credit on this order', '',
    'The respond-by date uses your policy setting. Your processor\'s deadline is the one that counts.', ''];
  return L.join('\n');
}
export const QUEUE_COLUMNS = ['request_id', 'type', 'order_id', 'customer', 'amount', 'reason', 'requested_at', 'flags', 'suggestion', 'respond_by', 'decision', 'decided_by', 'decided_date'];
export const queueCsv = (r) => toCsv(r.items.map((i) => ({ ...i, flags: i.flags.join('; '), respond_by: i.respond_by || '', decision: '', decided_by: '', decided_date: '' })), QUEUE_COLUMNS);
