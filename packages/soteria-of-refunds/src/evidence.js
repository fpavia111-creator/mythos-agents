// Dispute evidence packs: reason-code checklist, what your exports already show,
// what a person must attach, and a citation for every source row used.
// Drafts for a person to review and submit; Soteria submits nothing.
import { sha256, htmlPage, escapeHtml, toIcs } from 'mythos-agent-core';
import { classifyDispute, CHECKLISTS } from './reasons.js';

const days = (a, b) => { const x = Date.parse(a), y = Date.parse(b); return Number.isFinite(x) && Number.isFinite(y) ? Math.floor((y - x) / 86400000) : null; };

/**
 * Build the evidence record for one chargeback.
 * src: { requestsFile, ordersFile, policyFile, policySha256 }
 */
// Built once per pair of files and reused for every dispute (the same lists, in file order).
const IDX = new WeakMap();
function indexes(orders, allRequests) {
  let byReq = IDX.get(orders); if (!byReq) { byReq = new WeakMap(); IDX.set(orders, byReq); }
  let x = byReq.get(allRequests);
  if (!x) {
    const byCustomer = new Map(); for (const o of orders.values()) { if (!byCustomer.has(o.customer)) byCustomer.set(o.customer, []); byCustomer.get(o.customer).push(o); }
    x = { disputed: new Set(allRequests.filter((q) => q.type === 'chargeback').map((q) => q.order_id)), byCustomer };
    byReq.set(allRequests, x);
  }
  return x;
}
export function disputeEvidence(item, orders, allRequests, policy, src) {
  const o = orders.get(item.order_id) || null;
  const cls = classifyDispute(item, policy.reason_code_overrides || {});
  const { disputed, byCustomer } = indexes(orders, allRequests);
  const prior = o && item.customer ? (byCustomer.get(item.customer) || []).filter((x) => x.order_id !== o.order_id && x.customer === item.customer && !disputed.has(x.order_id)).filter((x) => { const d = days(x.ordered, item.requested_at); return d !== null && d >= 120 && d <= 365; }) : [];
  const facts = {
    order: !!o, delivered: !!(o && o.delivered), tracking: !!(o && o.tracking), returned: !!item.returned, refunded: !!(o && o.refunded > 0), prior_undisputed: prior.length >= 2,
  };
  const factText = {
    order: o ? `order ${o.order_id} on file` : 'no order with this id', delivered: o?.delivered ? `delivered ${o.delivered}` : 'no delivery date on file', tracking: o?.tracking ? `tracking ${o.tracking}` : 'no tracking on file',
    returned: item.returned ? 'return marked received' : 'no return recorded', refunded: o?.refunded > 0 ? `refunded ${o.refunded} earlier` : 'no earlier refund recorded',
    prior_undisputed: `${prior.length} earlier undisputed order(s) 120-365 days before${prior.length ? `: ${prior.map((x) => x.order_id).join(', ')}` : ''}`,
  };
  const checklist = CHECKLISTS[cls.category].map((c) => (c.check ? { ...c, status: facts[c.check] ? 'on_file' : 'missing', detail: factText[c.check] } : { ...c, status: 'attach', detail: 'A person attaches this from your systems' }));
  const dataItems = checklist.filter((c) => c.check);
  const onFile = dataItems.filter((c) => c.status === 'on_file').length;
  const citations = [{ source: src.requestsFile, row: item.row, what: `dispute ${item.request_id}` }];
  if (o) citations.push({ source: src.ordersFile, row: o.row, what: `order ${o.order_id}` });
  for (const x of prior) citations.push({ source: src.ordersFile, row: x.row, what: `earlier undisputed order ${x.order_id} (${x.ordered})` });
  if (src.policyFile) citations.push({ source: src.policyFile, row: null, what: `policy (sha256 ${src.policySha256})` });
  return {
    request_id: item.request_id, order_id: item.order_id, amount: item.amount, opened: item.requested_at, respond_by: item.respond_by, suggestion: item.suggestion, flags: item.flags,
    classification: cls, checklist,
    readiness: { on_file: onFile, missing: dataItems.length - onFile, attach: checklist.length - dataItems.length, score: dataItems.length ? Math.round((100 * onFile) / dataItems.length) : null,
      explain: `${onFile} of ${dataItems.length} item(s) Soteria can check are on file in your exports; ${checklist.length - dataItems.length} more must be attached by a person. Not a prediction of the outcome.` },
    citations,
  };
}

export function evidenceIndex(list, meta) {
  const doc = { kind: 'soteria-dispute-evidence', version: 1, ...meta, disputes: list,
    limits: 'Reason-code mapping and checklists are a working guide, not the card networks\' rules; your processor\'s dispute guide and deadlines are the ones that count. Drafts for a person to review and submit.' };
  const json = JSON.stringify(doc, null, 2) + '\n';
  return { doc, json, output_sha256: sha256(json) };
}

export function evidencePackHtml(d) {
  const e = escapeHtml; const cls = d.classification;
  const mark = { on_file: '<span class="ok">on file</span>', missing: '<span class="bad">missing</span>', attach: '<span class="warn">attach</span>' };
  const body = [
    `<h1>Dispute evidence pack: ${e(d.request_id)}</h1>`,
    `<p class="mut">Draft for a person to review and submit through your processor. Soteria submits nothing.</p>`,
    `<p>Order ${e(d.order_id)} · disputed ${e(d.amount)} · opened ${e(d.opened)} · respond by <strong>${e(d.respond_by || 'check your processor')}</strong></p>`,
    `<p>Category <strong>${e(cls.category.replace(/_/g, ' '))}</strong> (${e(cls.network || 'network unknown')} ${e(cls.code || '')}: ${e(cls.label)}; from ${e(cls.source.replace(/_/g, ' '))})</p>`,
    `<h2>Evidence checklist</h2><p>Readiness: ${e(d.readiness.score ?? '-')}% · ${e(d.readiness.explain)}</p>`,
    `<table><thead><tr><th>Item</th><th>Status</th><th>Detail</th></tr></thead><tbody>${d.checklist.map((c) => `<tr><td>${e(c.label)}</td><td>${mark[c.status]}</td><td>${e(c.detail)}</td></tr>`).join('')}</tbody></table>`,
    d.flags.length ? `<h2>Triage flags</h2><ul>${d.flags.map((f) => `<li>${e(f)}</li>`).join('')}</ul>` : '',
    `<h2>Sources cited</h2><table><thead><tr><th>File</th><th>Row</th><th>What</th></tr></thead><tbody>${d.citations.map((c) => `<tr><td>${e(c.source)}</td><td>${e(c.row ?? '-')}</td><td>${e(c.what)}</td></tr>`).join('')}</tbody></table>`,
    '<p class="mut">The reason-code map is a working guide, not the card networks\' rules. Your processor\'s deadline is the one that counts. Not legal advice.</p>',
  ].join('\n');
  return htmlPage({ title: `Dispute evidence ${d.request_id}`, bodyHtml: body, footer: 'Generated by soteria-of-refunds.' });
}

export const disputeIcs = (list) => toIcs(list.filter((d) => d.respond_by).map((d) => ({ uid: `${d.request_id}-respond@soteria.local`, date: d.respond_by, summary: `Respond to dispute ${d.request_id} (${d.classification.category.replace(/_/g, ' ')})`, description: `Order ${d.order_id}, amount ${d.amount}. Readiness ${d.readiness.score ?? '-'}%. Check your processor's deadline.`, reminders: [3, 1] })), { prodId: '-//Mythos Machine//soteria-of-refunds//EN', calName: 'Dispute deadlines' });
