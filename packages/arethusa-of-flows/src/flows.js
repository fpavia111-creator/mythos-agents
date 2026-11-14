import { toCsv } from 'mythos-agent-core';

const DAY = 86400000;
export const SECRET_KEY = /(api[_-]?key|apikey|access[_-]?token|auth[_-]?token|token|secret|password|passwd|authorization|bearer|private[_-]?key|client[_-]?secret)/i;
export const SECRET_VALUE = /(sk_live_[A-Za-z0-9]{8,}|rk_live_[A-Za-z0-9]{8,}|xox[abprs]-[A-Za-z0-9-]{8,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/;
const MONEY = /(stripe|paypal|braintree|adyen|square|wise|payoneer|refund|charge|payout|transfer|capture|create_?payment|send_?payment|pay_?bill|bill\.com)/i;
const SEND_OP = /(send|post_?message|tweet|sms|whatsapp|reply|create_?campaign)/i;
const SEND_APP = /(gmail|outlook|smtp|sendgrid|mailgun|postmark|twilio)/i;
const READISH = /(get|search|list|read|find|delete|remove)/i;
const DESTRUCTIVE = /(^|[^a-z])(delete|remove|purge|truncate|drop|destroy|erase|bulk_?delete|deleteall|archive_?all)([^a-z]|$)/i;
const FILTER = /(\bif\b|filter|switch|router|condition|paths?|n8n-nodes-base\.if|builtin:basicrouter|only_?continue)/i;
export const SEVERITY = { high: 0, medium: 1, low: 2 };
const isExpr = (v) => typeof v === 'string' && (v.startsWith('=') || v.includes('{{') || /^\$\w/.test(v));
const short = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

// ---- normalise exports --------------------------------------------------
function fromN8n(w, file) {
  const nodes = (w.nodes || []).map((n) => {
    const type = String(n.type || ''); const op = [n.parameters?.resource, n.parameters?.operation].filter(Boolean).join('.');
    const trigger = /trigger|webhook|cron|schedule|start|manualtrigger|formtrigger/i.test(type);
    return { name: n.name || n.id, kind: trigger ? 'trigger' : 'action', app: type.replace(/^n8n-nodes-base\./, ''), type, op, params: n.parameters || {}, disabled: !!n.disabled, continue_on_fail: !!(n.continueOnFail || n.onError === 'continueRegularOutput' || n.onError === 'continueErrorOutput') };
  });
  const edges = [];
  for (const [from, c] of Object.entries(w.connections || {})) for (const outs of Object.values(c || {})) for (const branch of outs || []) for (const e of branch || []) if (e && e.node) edges.push([from, e.node]);
  return { id: String(w.id || w.name), name: w.name || file, platform: 'n8n', file, active: w.active !== false, steps: nodes, edges, error_handler: !!(w.settings && w.settings.errorWorkflow) || nodes.some((n) => n.continue_on_fail) };
}
function fromZapier(z, file) {
  const steps = (z.steps || []).map((s, i) => ({ name: s.title || `${s.app} ${s.action}`, kind: i === 0 && (s.type_of === 'read' || /trigger|catch|new_|schedule|every/i.test(s.action || '')) ? 'trigger' : 'action', app: String(s.app || ''), type: String(s.app || ''), op: String(s.action || ''), params: s.params || {}, disabled: s.paused === true, continue_on_fail: false }));
  return { id: String(z.id ?? z.title), name: z.title || String(z.id), platform: 'zapier', file, active: String(z.status || 'on').toLowerCase() === 'on', steps, edges: null, error_handler: null };
}
function fromMake(b, file) {
  const flat = []; const walk = (mods) => { for (const m of mods || []) { flat.push(m); for (const r of m.routes || []) walk(r.flow); } };
  walk(b.flow);
  const steps = flat.map((m, i) => ({ name: m.metadata?.designer?.name || `${m.module} #${m.id ?? i + 1}`, kind: i === 0 ? 'trigger' : 'action', app: String(m.module || '').split(':')[0], type: String(m.module || ''), op: String(m.module || '').split(':')[1] || '', params: { ...(m.parameters || {}), ...(m.mapper || {}) }, disabled: m.disabled === true, continue_on_fail: Array.isArray(m.onerror) && m.onerror.length > 0 }));
  return { id: String(b.id ?? b.name), name: b.name || file, platform: 'make', file, active: b.active ?? b.scheduling?.active ?? true, steps, edges: null, error_handler: steps.some((s) => s.continue_on_fail) };
}
export function normalise(json, file = 'export') {
  const list = Array.isArray(json) ? json : [json];
  const out = [];
  for (const x of list) {
    if (x && Array.isArray(x.zaps)) for (const z of x.zaps) out.push(fromZapier(z, file));
    else if (x && Array.isArray(x.nodes)) out.push(fromN8n(x, file));
    else if (x && Array.isArray(x.flow)) out.push(fromMake(x, file));
    else if (x && Array.isArray(x.steps)) out.push(fromZapier(x, file));
    else throw new Error(`${file}: not an n8n workflow, Zapier export or Make blueprint`);
  }
  return out;
}

// ---- checks ---------------------------------------------------------------
export function findSecrets(params, path = '') {
  const hits = [];
  const visit = (v, p, keyHint) => {
    if (v === null || v === undefined) return;
    if (Array.isArray(v)) return v.forEach((x, i) => visit(x, `${p}[${i}]`, keyHint));
    if (typeof v === 'object') {
      const nameLike = v.name ?? v.key ?? v.header;
      if (typeof nameLike === 'string' && 'value' in v) return visit(v.value, `${p}.${nameLike}`, nameLike);
      for (const [k, x] of Object.entries(v)) visit(x, p ? `${p}.${k}` : k, k);
      return;
    }
    if (typeof v !== 'string' || isExpr(v)) return;
    if (SECRET_VALUE.test(v) || (SECRET_KEY.test(String(keyHint || '')) && v.trim().length >= 8 && !/^(none|true|false|header|query|body|bearer|basic)$/i.test(v.trim()))) hits.push(p);
  };
  visit(params, path, '');
  return hits;
}
const httpUrls = (params) => { const s = JSON.stringify(params || {}); return [...s.matchAll(/http:\/\/([^"\\/\s:]+)/g)].map((m) => m[1]).filter((h) => !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(h)); };

function reachable(flow) {
  if (!flow.edges) return null;
  const adj = new Map(); for (const [a, b] of flow.edges) { if (!adj.has(a)) adj.set(a, []); adj.get(a).push(b); }
  const seen = new Set(flow.steps.filter((s) => s.kind === 'trigger').map((s) => s.name)); const q = [...seen];
  while (q.length) for (const n of adj.get(q.shift()) || []) if (!seen.has(n)) { seen.add(n); q.push(n); }
  return seen;
}
function hasFilterBefore(flow, step) {
  const label = (s) => `${s.type} ${s.op} ${s.name}`;
  if (!flow.edges) { const i = flow.steps.indexOf(step); return flow.steps.slice(0, i).some((s) => FILTER.test(label(s))); }
  const back = new Map(); for (const [a, b] of flow.edges) { if (!back.has(b)) back.set(b, []); back.get(b).push(a); }
  const by = new Map(flow.steps.map((s) => [s.name, s])); const seen = new Set(); const q = [...(back.get(step.name) || [])];
  while (q.length) { const n = q.shift(); if (seen.has(n)) continue; seen.add(n); const s = by.get(n); if (s && FILTER.test(label(s))) return true; q.push(...(back.get(n) || [])); }
  return false;
}

export function auditFlow(flow, runs = [], a = {}) {
  const F = []; const add = (severity, category, code, step, detail) => F.push({ severity, category, code, step: step || '', detail });
  const live = flow.steps.filter((s) => !s.disabled);
  if (!flow.steps.some((s) => s.kind === 'trigger')) add('high', 'broken', 'no_trigger', '', 'No trigger step: this flow cannot start on its own.');
  const reach = reachable(flow);
  if (reach) for (const s of flow.steps) if (s.kind !== 'trigger' && !reach.has(s.name)) add('medium', 'broken', 'disconnected_step', s.name, `"${s.name}" is not connected to any trigger and never runs.`);
  for (const s of flow.steps) if (s.disabled) add('low', 'broken', 'disabled_step', s.name, `"${s.name}" is disabled.`);
  for (const s of flow.steps) {
    for (const p of findSecrets(s.params)) add('high', 'risky', 'hardcoded_secret', s.name, `A secret is typed into "${s.name}" at ${p} (value not shown). Move it to the platform's credential store and rotate it.`);
    for (const h of httpUrls(s.params)) add('medium', 'risky', 'plain_http', s.name, `"${s.name}" calls http://${h} without TLS.`);
    const label = `${s.type} ${s.op} ${s.name}`;
    if (s.kind === 'trigger' && /webhook|catch_?hook|customwebhook/i.test(label)) {
      const auth = String(s.params.authentication ?? s.params.auth ?? '').toLowerCase();
      if (flow.platform === 'n8n' ? !auth || auth === 'none' : true) add(flow.platform === 'n8n' ? 'high' : 'medium', 'risky', 'open_webhook', s.name, flow.platform === 'n8n' ? `Webhook "${s.name}" has no authentication: anyone with the URL can start this flow.` : `Webhook "${s.name}" is protected only by its URL. Check the sender and validate input.`);
    }
    if (s.kind !== 'trigger' && DESTRUCTIVE.test(`${s.op} ${s.name}`.replace(/[.:]/g, ' '))) {
      if (hasFilterBefore(flow, s)) add('medium', 'risky', 'destructive_step', s.name, `"${s.name}" deletes or removes data (a filter runs before it).`);
      else add('high', 'risky', 'destructive_without_filter', s.name, `"${s.name}" deletes or removes data with no filter or condition before it.`);
    }
    if (s.kind !== 'trigger' && MONEY.test(label)) add('high', 'risky', 'money_moving', s.name, `"${s.name}" can move money. Arethusa never runs it; any change to this flow is one human click.`);
    if (s.kind !== 'trigger' && !/^http|httprequest/i.test(`${s.app} ${s.type}`) && (SEND_OP.test(`${s.op} ${s.name}`) || (SEND_APP.test(s.app) && !READISH.test(s.op)))) add('medium', 'risky', 'sends_messages', s.name, `"${s.name}" sends messages (email, chat or SMS): check who receives them and how often.`);
    if (/executecommand|ssh/i.test(s.type)) add('high', 'risky', 'code_exec', s.name, `"${s.name}" runs shell commands on the automation host.`);
    else if (/(^|\W)(code|function|functionitem|javascript|python)(\W|$)/i.test(`${s.app} ${s.op}`)) add('medium', 'risky', 'custom_code', s.name, `"${s.name}" runs custom code; review it like any other code.`);
  }
  if (flow.error_handler === false) add('low', 'broken', 'no_error_handler', '', 'No error workflow or error route: failures are silent.');
  if (runs.length) {
    const sorted = [...runs].sort((x, y) => (x.t < y.t ? -1 : 1)); const fails = sorted.filter((r) => r.failed);
    const rate = fails.length / sorted.length;
    if (sorted.length >= 3 && rate >= (Number(a.fail_rate) || 0.2)) add('high', 'broken', 'failing_runs', '', `${fails.length} of ${sorted.length} recent runs failed${fails.length ? ` (last error: ${short(fails[fails.length - 1].error) || 'n/a'})` : ''}.`);
    else if (sorted[sorted.length - 1].failed) add('medium', 'broken', 'last_run_failed', '', `The last run failed: ${short(sorted[sorted.length - 1].error) || 'n/a'}.`);
    const last = sorted[sorted.length - 1].t; const now = a.now;
    if (flow.active && now !== undefined && (now - last) / DAY > (Number(a.stale_days) || 30)) add('medium', 'broken', 'active_but_not_running', '', `Active but no run in ${Math.round((now - last) / DAY)} days.`);
  } else if (a.history_given && flow.active) add('medium', 'broken', 'active_but_not_running', '', 'Active but no runs in the history you gave.');
  F.sort((x, y) => SEVERITY[x.severity] - SEVERITY[y.severity]);
  const score = F.reduce((t, f) => t + ({ high: 10, medium: 3, low: 1 })[f.severity], 0);
  return { id: flow.id, name: flow.name, platform: flow.platform, file: flow.file, active: flow.active, steps: flow.steps.length, live_steps: live.length, risk_score: score, high: F.filter((f) => f.severity === 'high').length, findings: F };
}

function parseTs(s) { const t = Date.parse(String(s || '').trim()); return Number.isNaN(t) ? null : t; }
export function audit(flows, history = [], a = {}) {
  const now = a.as_of ? parseTs(a.as_of) : Date.now();
  if (a.as_of && now === null) throw new Error(`as_of must be a date, got "${a.as_of}"`);
  const runs = new Map();
  for (const r of history) {
    const name = String(r.flow ?? r.workflow ?? r.zap ?? r.scenario ?? '').trim(); const t = parseTs(r.run_at ?? r.started_at ?? r.date);
    if (!name || t === null) continue;
    if (!runs.has(name)) runs.set(name, []);
    runs.get(name).push({ t, failed: /^(error|failed|failure|halted|crashed)$/i.test(String(r.status || '').trim()), error: r.error || r.message || '' });
  }
  const items = flows.map((f) => auditFlow(f, runs.get(f.name) || runs.get(f.id) || [], { ...a, now, history_given: history.length > 0 })).sort((x, y) => y.risk_score - x.risk_score);
  const codes = {}; for (const i of items) for (const f of i.findings) codes[f.code] = (codes[f.code] || 0) + 1;
  return { flows: items.length, active: items.filter((i) => i.active).length, findings: items.reduce((t, i) => t + i.findings.length, 0), high: items.reduce((t, i) => t + i.high, 0), by_code: codes, items };
}

export const FINDING_COLUMNS = ['flow', 'platform', 'active', 'severity', 'category', 'code', 'step', 'detail', 'owner', 'decision'];
export const findingsCsv = (r) => toCsv(r.items.flatMap((i) => i.findings.map((f) => ({ flow: i.name, platform: i.platform, active: i.active ? 'yes' : 'no', ...f, owner: '', decision: '' }))), FINDING_COLUMNS);

export function reportMarkdown(r) {
  const L = ['# Workflow audit', '', `${r.flows} flow(s), ${r.active} active · ${r.findings} finding(s), ${r.high} high.`, ''];
  for (const i of r.items) {
    L.push(`## ${i.name} (${i.platform}${i.active ? ', active' : ', off'}) — risk ${i.risk_score}`, '');
    if (!i.findings.length) L.push('No findings.', '');
    for (const f of i.findings) L.push(`- **${f.severity}** \`${f.code}\` ${f.detail}`);
    L.push('');
  }
  L.push('_Static review of exported definitions and the run history you gave. Arethusa does not run, enable or change any flow._', '');
  return L.join('\n');
}

const FIX = {
  hardcoded_secret: 'Move the value into the platform credential store, reference the credential, and rotate the exposed secret.',
  open_webhook: 'Add header or basic auth (or a signed-payload check) to the webhook trigger.',
  plain_http: 'Switch the URL to https://.',
  destructive_without_filter: 'Add a filter/IF step before the delete, and a dry-run branch that only lists what would be removed.',
  money_moving: 'Keep a human approval step before the money-moving action and cap amounts.',
  code_exec: 'Remove shell execution or move it to a reviewed, sandboxed job.',
  disconnected_step: 'Reconnect the step or delete it.',
  no_trigger: 'Add a trigger or archive the flow.',
  failing_runs: 'Fix the failing step before re-enabling; consider pausing the flow.',
  last_run_failed: 'Check the last error and re-run once fixed.',
  no_error_handler: 'Add an error workflow or error route that alerts an owner.',
  active_but_not_running: 'Confirm the trigger still fires, or turn the flow off.',
};
export function proposals(item) {
  return { flow: item.name, platform: item.platform, status: 'proposal - not applied', changes: item.findings.filter((f) => FIX[f.code]).map((f) => ({ code: f.code, step: f.step, severity: f.severity, proposed_change: FIX[f.code] })) };
}

/** Copy of an export with every hardcoded secret replaced by a placeholder. */
export function redact(json) {
  const walk = (v, keyHint) => {
    if (Array.isArray(v)) return v.map((x) => walk(x, keyHint));
    if (v && typeof v === 'object') {
      const nameLike = v.name ?? v.key ?? v.header;
      if (typeof nameLike === 'string' && 'value' in v && typeof v.value === 'string' && findSecrets({ [nameLike]: v.value }).length) return { ...v, value: '<<REDACTED: use a stored credential>>' };
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, typeof x === 'string' && findSecrets({ [k]: x }).length ? '<<REDACTED: use a stored credential>>' : walk(x, k)]));
    }
    return v;
  };
  return walk(json, '');
}
