import { toCsv, toSarif } from 'mythos-agent-core';
import { scanSecretsRaw } from './secrets.js';

// Cross-flow dependency map: which credentials, hardcoded secrets, webhooks and hosts are
// shared between flows, and which flows call another flow's webhook. Secret values are
// grouped in memory only and reported as secret#1, secret#2 … in order of first appearance.

const urlsIn = (params) => [...JSON.stringify(params || {}).matchAll(/https?:\/\/[^"\\\s]+/g)].map((m) => m[0]);
const hostOf = (u) => { try { return new URL(u).hostname.toLowerCase(); } catch { return ''; } };
const MONEY = /(stripe|paypal|braintree|adyen|square|refund|charge|payout|transfer|payment)/i;

function webhookIds(flow) {
  const out = [];
  for (const s of flow.steps.filter((x) => x.kind === 'trigger')) {
    if (flow.platform === 'n8n' && /webhook/i.test(s.type) && s.params.path) out.push({ key: `n8n webhook /${String(s.params.path).replace(/^\//, '')}`, path: String(s.params.path).replace(/^\//, ''), step: s.name });
    if (flow.platform === 'make' && /webhook/i.test(s.type) && s.params.hook !== undefined) out.push({ key: `make hook #${s.params.hook}`, step: s.name });
    if (flow.platform === 'workato' && /webhook/i.test(s.type) && s.params.webhook_name) out.push({ key: `workato webhook ${s.params.webhook_name}`, step: s.name });
  }
  return out;
}

export function dependencyMap(flows, { entropy } = {}) {
  const res = new Map(); const add = (type, key, flow, step, extra = {}) => {
    const k = `${type}|${key}`;
    if (!res.has(k)) res.set(k, { type, key, flows: [], uses: [], ...extra });
    const r = res.get(k); if (!r.flows.includes(flow.name)) r.flows.push(flow.name); r.uses.push(`${flow.name} › ${step}`);
  };
  const secretLabels = new Map(); // raw value -> label (never leaves this function)
  const hooks = flows.flatMap((f) => webhookIds(f).map((h) => ({ ...h, flow: f })));
  const calls = [];
  for (const f of flows) {
    for (const h of webhookIds(f)) add('webhook', h.key, f, h.step);
    for (const s of f.steps) {
      for (const c of s.creds || []) add('credential', c, f, s.name);
      for (const h of scanSecretsRaw(s.params, { entropy })) {
        if (!secretLabels.has(h.value)) secretLabels.set(h.value, `secret#${secretLabels.size + 1}`);
        add('secret', secretLabels.get(h.value), f, s.name, { rule: h.rule, kind: h.label, confidence: h.confidence });
      }
      for (const u of urlsIn(s.params)) {
        const host = hostOf(u); if (host) add('host', host, f, s.name);
        for (const h of hooks) if (h.path && h.flow !== f && new RegExp(`/webhook(?:-test)?/${h.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:[/?#]|$)`).test(u)) calls.push({ from: f.name, to: h.flow.name, via: h.key, step: s.name });
      }
    }
  }
  const resources = [...res.values()].map((r) => ({ ...r, shared: r.flows.length > 1 })).sort((a, b) => Number(b.shared) - Number(a.shared) || a.type.localeCompare(b.type) || a.key.localeCompare(b.key));
  for (const c of calls) { const w = resources.find((r) => r.type === 'webhook' && r.key === c.via); if (w && !w.flows.includes(c.from)) { w.flows.push(c.from); w.uses.push(`${c.from} › ${c.step} (calls it)`); w.shared = true; } }
  const byName = new Map(flows.map((f) => [f.name, f]));
  const rotation = resources.filter((r) => r.type === 'secret').map((r) => {
    const active = r.flows.filter((n) => byName.get(n)?.active);
    const money = r.flows.some((n) => byName.get(n)?.steps.some((s) => MONEY.test(`${s.type} ${s.op} ${s.name}`)));
    const reasons = [];
    if (r.flows.length > 1) reasons.push(`used in ${r.flows.length} flows: rotate once, update every flow the same day`);
    if (active.length) reasons.push(`${active.length} active flow(s) depend on it`);
    if (money) reasons.push('a flow using it can move money');
    if (r.confidence === 'high') reasons.push(`known format: ${r.kind}`); else reasons.push(`${r.kind}; confirm it is a secret first`);
    const priority = (r.confidence === 'high' ? 2 : 0) + (r.flows.length > 1 ? 2 : 0) + (active.length ? 1 : 0) + (money ? 1 : 0);
    return { secret: r.key, priority: priority >= 4 ? 'P1' : priority >= 2 ? 'P2' : 'P3', score: priority, used_in: r.uses, action: 'Create a stored credential, point every listed step at it, rotate the old value at the provider, then re-export and re-run arethusa_audit.', reasons };
  }).sort((a, b) => b.score - a.score || a.secret.localeCompare(b.secret));
  return { flows: flows.length, shared: resources.filter((r) => r.shared).length, resources, calls, rotation_plan: rotation };
}

const mm = (s) => String(s).replace(/["[\]{}()<>|]/g, ' ').trim();
export function dependencyMarkdown(m) {
  const L = ['# Flow dependency map', '', `${m.flows} flow(s); ${m.shared} shared resource(s); ${m.calls.length} flow-to-flow call(s). Secret values are never shown; equal values share a label.`, ''];
  const shared = m.resources.filter((r) => r.shared);
  L.push('## Shared resources', '');
  if (!shared.length) L.push('None.', '');
  for (const r of shared) L.push(`- **${r.type}** \`${r.key}\`${r.kind ? ` (${r.kind})` : ''}: ${r.uses.join('; ')}`);
  L.push('', '## Flow-to-flow calls', '');
  if (!m.calls.length) L.push('None found.', '');
  for (const c of m.calls) L.push(`- ${c.from} › ${c.step} calls ${c.to} via ${c.via}`);
  L.push('', '## Secret rotation plan', '');
  if (!m.rotation_plan.length) L.push('No hardcoded secrets found.', '');
  for (const r of m.rotation_plan) L.push(`- **${r.priority}** ${r.secret}: ${r.reasons.join('; ')}. Used in: ${r.used_in.join('; ')}.`);
  const ids = new Map(); const id = (n) => { if (!ids.has(n)) ids.set(n, `f${ids.size + 1}`); return ids.get(n); };
  L.push('', '## Graph (Mermaid)', '', '```mermaid', 'flowchart LR');
  for (const r of shared) { const rid = `r${shared.indexOf(r) + 1}`; L.push(`  ${rid}{{"${mm(r.type)}: ${mm(r.key)}"}}`); for (const n of r.flows) L.push(`  ${id(n)}["${mm(n)}"] --- ${rid}`); }
  for (const c of m.calls) L.push(`  ${id(c.from)}["${mm(c.from)}"] -->|calls| ${id(c.to)}["${mm(c.to)}"]`);
  L.push('```', '');
  return L.join('\n');
}
export const dependencyCsv = (m) => toCsv(m.resources.map((r) => ({ type: r.type, key: r.key, shared: r.shared ? 'yes' : 'no', flows: r.flows.join(' | '), uses: r.uses.join(' | ') })), ['type', 'key', 'shared', 'flows', 'uses']);

const RULE_HELP = {
  hardcoded_secret: 'Move the value into the platform credential store and rotate it.',
  possible_secret: 'Confirm whether the high-entropy value is a secret; if so, store and rotate it.',
  open_webhook: 'Add authentication or a signed-payload check to the webhook trigger.',
  destructive_without_filter: 'Add a filter before the delete and a dry-run branch.',
  money_moving: 'Keep a human approval step before the money-moving action.',
  code_exec: 'Remove shell execution or sandbox it.',
};
/** SARIF 2.1.0 for code-scanning dashboards. Each result points at the export file and names the flow and step. */
export function findingsSarif(r, version) {
  const findings = r.items.flatMap((i) => i.findings.map((f) => ({ ruleId: f.code, severity: f.severity, file: i.file, message: `[${i.name}${f.step ? ` › ${f.step}` : ''}] ${f.detail}`, fingerprint: `${i.platform}|${i.id}|${f.code}|${f.step}` })));
  const rules = [...new Set(findings.map((f) => f.ruleId))].map((id) => ({ id, description: id.replace(/_/g, ' '), help: RULE_HELP[id], severity: findings.find((f) => f.ruleId === id).severity }));
  return toSarif({ tool: 'arethusa-of-flows', version, informationUri: 'https://github.com/fpavia111-creator/mythos-agents/tree/main/packages/arethusa-of-flows', rules, findings });
}
