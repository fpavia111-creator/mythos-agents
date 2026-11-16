import { toCsv } from 'mythos-agent-core';
import { scanSecretsRaw, publicHits, redactValue, SECRET_KEY, SECRET_VALUE } from './secrets.js';
export { SECRET_KEY, SECRET_VALUE };

const DAY = 86400000;
const MONEY = /(stripe|paypal|braintree|adyen|square|wise|payoneer|refund|charge|payout|transfer|capture|create_?payment|send_?payment|pay_?bill|bill\.com)/i;
const SEND_OP = /(send|post_?message|tweet|sms|whatsapp|reply|create_?campaign)/i;
const SEND_APP = /(gmail|outlook|smtp|sendgrid|mailgun|postmark|twilio)/i;
const READISH = /(get|search|list|read|find|delete|remove)/i;
const DESTRUCTIVE = /(^|[^a-z])(delete|remove|purge|truncate|drop|destroy|erase|bulk_?delete|deleteall|archive_?all)([^a-z]|$)/i;
const FILTER = /(\bif\b|filter|switch|router|condition|paths?|n8n-nodes-base\.if|builtin:basicrouter|only_?continue)/i;
export const SEVERITY = { high: 0, medium: 1, low: 2 };
const short = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

// ---- normalise exports --------------------------------------------------
function fromN8n(w, file) {
  const nodes = (w.nodes || []).map((n) => {
    const type = String(n.type || ''); const op = [n.parameters?.resource, n.parameters?.operation].filter(Boolean).join('.');
    const trigger = /trigger|webhook|cron|schedule|start|manualtrigger|formtrigger/i.test(type);
    return { name: n.name || n.id, kind: trigger ? 'trigger' : 'action', app: type.replace(/^n8n-nodes-base\./, ''), type, op, params: n.parameters || {}, disabled: !!n.disabled, continue_on_fail: !!(n.continueOnFail || n.onError === 'continueRegularOutput' || n.onError === 'continueErrorOutput'), creds: Object.entries(n.credentials || {}).map(([t, c]) => `n8n ${t}: ${c?.name || c?.id || ''}`) };
  });
  const edges = [];
  for (const [from, c] of Object.entries(w.connections || {})) for (const outs of Object.values(c || {})) for (const branch of outs || []) for (const e of branch || []) if (e && e.node) edges.push([from, e.node]);
  return { id: String(w.id || w.name), name: w.name || file, platform: 'n8n', file, active: w.active !== false, steps: nodes, edges, error_handler: !!(w.settings && w.settings.errorWorkflow) || nodes.some((n) => n.continue_on_fail) };
}
function fromZapier(z, file) {
  const steps = (z.steps || []).map((s, i) => ({ name: s.title || `${s.app} ${s.action}`, kind: i === 0 && (s.type_of === 'read' || /trigger|catch|new_|schedule|every/i.test(s.action || '')) ? 'trigger' : 'action', app: String(s.app || ''), type: String(s.app || ''), op: String(s.action || ''), params: s.params || {}, disabled: s.paused === true, continue_on_fail: false, creds: s.authentication_id || s.auth_id ? [`zapier ${s.app}: #${s.authentication_id || s.auth_id}`] : [] }));
  return { id: String(z.id ?? z.title), name: z.title || String(z.id), platform: 'zapier', file, active: String(z.status || 'on').toLowerCase() === 'on', steps, edges: null, error_handler: null };
}
function fromMake(b, file) {
  const flat = []; const walk = (mods) => { for (const m of mods || []) { flat.push(m); for (const r of m.routes || []) walk(r.flow); } };
  walk(b.flow);
  const steps = flat.map((m, i) => ({ name: m.metadata?.designer?.name || `${m.module} #${m.id ?? i + 1}`, kind: i === 0 ? 'trigger' : 'action', app: String(m.module || '').split(':')[0], type: String(m.module || ''), op: String(m.module || '').split(':')[1] || '', params: { ...(m.parameters || {}), ...(m.mapper || {}) }, disabled: m.disabled === true, continue_on_fail: Array.isArray(m.onerror) && m.onerror.length > 0, creds: m.parameters?.__IMTCONN__ ? [`make connection #${m.parameters.__IMTCONN__}`] : [] }));
  return { id: String(b.id ?? b.name), name: b.name || file, platform: 'make', file, active: b.active ?? b.scheduling?.active ?? true, steps, edges: null, error_handler: steps.some((s) => s.continue_on_fail) };
}
// Power Automate / Logic Apps definition: { properties: { displayName, state, definition: { triggers, actions } } }
const paApi = (inputs) => String(inputs?.host?.apiId || inputs?.host?.connectionName || inputs?.host?.connection?.name || '').split('/').pop().replace(/^shared_/, '');
function fromPowerAutomate(x, file) {
  const props = x.properties || x; const def = props.definition || x.definition || x;
  const steps = []; const edges = []; let errorRoute = false;
  for (const [name, t] of Object.entries(def.triggers || {})) {
    const http = /^request$/i.test(t.type || '') || /^http$/i.test(t.kind || '');
    const authType = String(t.inputs?.triggerAuthenticationType || '').toLowerCase();
    steps.push({ name, kind: 'trigger', app: http ? 'webhook' : paApi(t.inputs) || String(t.type || ''), type: http ? `Request webhook ${t.kind || ''}`.trim() : String(t.type || ''), op: String(t.inputs?.host?.operationId || t.kind || ''), params: t.inputs || {}, disabled: false, continue_on_fail: false, ...(http ? { webhook_auth: authType && authType !== 'all' && authType !== 'anyone' ? authType : null } : {}) });
  }
  const triggers = steps.map((s) => s.name);
  const walk = (actions, parents) => {
    for (const [name, a] of Object.entries(actions || {})) {
      const after = Object.entries(a.runAfter || {});
      if (!after.length) for (const p of parents) edges.push([p, name]);
      for (const [dep, states] of after) { edges.push([dep, name]); if ((states || []).some((st) => /failed|timedout/i.test(st))) errorRoute = true; }
      const type = String(a.type || '');
      steps.push({ name, kind: 'action', app: /^http$/i.test(type) ? 'http' : paApi(a.inputs) || type.toLowerCase(), type, op: String(a.inputs?.host?.operationId || a.inputs?.method || ''), params: a.inputs || {}, disabled: false, continue_on_fail: false, creds: a.inputs?.host?.connectionName || a.inputs?.host?.connectionReferenceName ? [`power_automate connection: ${a.inputs.host.connectionName || a.inputs.host.connectionReferenceName}`] : [] });
      if (a.actions) walk(a.actions, [name]);
      if (a.else?.actions) walk(a.else.actions, [name]);
      for (const c of Object.values(a.cases || {})) walk(c.actions, [name]);
      if (a.default?.actions) walk(a.default.actions, [name]);
    }
  };
  walk(def.actions, triggers);
  const state = String(props.state || 'Started').toLowerCase();
  return { id: String(x.name || x.id || props.displayName || file), name: props.displayName || x.name || file, platform: 'power_automate', file, active: state === 'started' || state === 'on', steps, edges, error_handler: errorRoute };
}

// Workato recipe export: { name, code: { keyword: 'trigger', provider, name, input, block: [...] }, config: [...] }
function fromWorkato(x, file) {
  const steps = []; let errorRoute = false;
  const accounts = (x.config || []).filter((c) => c && c.account_id).map((c) => ({ provider: String(c.provider || c.name || ''), key: `workato ${c.provider || c.name}: ${c.account_id.name || c.account_id.zip_name || c.account_id.id || ''}` }));
  const walk = (b) => {
    if (!b) return;
    const kw = String(b.keyword || 'action').toLowerCase();
    if (kw === 'catch' || b.on_error || b.error_handler) errorRoute = true;
    const control = ['if', 'elsif', 'else', 'foreach', 'repeat', 'while', 'try', 'catch', 'stop'].includes(kw);
    const nm = b.as || b.name || kw;
    steps.push({ name: b.title || `${b.provider ? b.provider + ' ' : ''}${nm} #${b.number ?? steps.length}`, kind: kw === 'trigger' ? 'trigger' : 'action', app: String(b.provider || (control ? 'workato_control' : '')), type: control ? `${kw} condition` : `${b.provider || ''}`, op: String(b.name || kw), params: b.input || {}, disabled: b.skip === true, continue_on_fail: false, creds: accounts.filter((a) => a.provider && a.provider === b.provider).map((a) => a.key) });
    for (const c of b.block || []) walk(c);
  };
  walk(x.code);
  return { id: String(x.id ?? x.name ?? file), name: x.name || file, platform: 'workato', file, active: x.running !== false && x.active !== false, steps, edges: null, error_handler: errorRoute };
}

export function normalise(json, file = 'export') {
  const list = Array.isArray(json) ? json : [json];
  const out = [];
  for (const x of list) {
    if (x && Array.isArray(x.zaps)) for (const z of x.zaps) out.push(fromZapier(z, file));
    else if (x && Array.isArray(x.nodes)) out.push(fromN8n(x, file));
    else if (x && Array.isArray(x.flow)) out.push(fromMake(x, file));
    else if (x && Array.isArray(x.steps)) out.push(fromZapier(x, file));
    else if (x && (x.properties?.definition?.triggers || x.definition?.triggers || (x.triggers && x.actions))) out.push(fromPowerAutomate(x, file));
    else if (x && x.code && typeof x.code === 'object' && x.code.keyword) out.push(fromWorkato(x, file));
    else throw new Error(`${file}: not an n8n workflow, Zapier export, Make blueprint, Power Automate flow or Workato recipe`);
  }
  return out;
}

// ---- checks ---------------------------------------------------------------
/** Paths of detected secrets (known formats, secret-named fields and high-entropy strings). Values are never returned. */
export function findSecrets(params, path = '', opts = {}) { return scanSecretsRaw(params, { ...opts, path }).map((h) => h.path); }
/** Detected secrets with rule and confidence, values removed. */
export function scanSecrets(params, opts = {}) { return publicHits(scanSecretsRaw(params, opts)); }
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
    for (const h of scanSecrets(s.params, { entropy: a.entropy })) {
      if (h.confidence === 'high') add('high', 'risky', 'hardcoded_secret', s.name, `A secret (${h.label}) is typed into "${s.name}" at ${h.path} (value not shown). Move it to the platform's credential store and rotate it.`);
      else add('medium', 'risky', 'possible_secret', s.name, `"${s.name}" has a ${h.label} at ${h.path} (value not shown). If it is a key or token, move it to the credential store and rotate it.`);
    }
    for (const h of httpUrls(s.params)) if (!(a.allow_http_hosts || []).includes(h)) add('medium', 'risky', 'plain_http', s.name, `"${s.name}" calls http://${h} without TLS.`);
    const label = `${s.type} ${s.op} ${s.name}`;
    if (s.kind === 'trigger' && /webhook|catch_?hook|customwebhook/i.test(label)) {
      const auth = String(s.params.authentication ?? s.params.auth ?? '').toLowerCase();
      if (s.webhook_auth) { /* platform-level caller restriction (e.g. Power Automate tenant/user) */ }
      else if (flow.platform === 'n8n' ? !auth || auth === 'none' : true) add(flow.platform === 'n8n' ? 'high' : 'medium', 'risky', 'open_webhook', s.name, flow.platform === 'n8n' ? `Webhook "${s.name}" has no authentication: anyone with the URL can start this flow.` : `Webhook "${s.name}" is protected only by its URL. Check the sender and validate input.`);
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
  const score = F.reduce((t, f) => t + WEIGHT[f.severity], 0);
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
  const suppressed = [];
  const items = flows.map((f) => {
    const it = auditFlow(f, runs.get(f.name) || runs.get(f.id) || [], { ...a, now, history_given: history.length > 0 });
    if (!(a.ignore || []).length) return it;
    const keep = [];
    for (const x of it.findings) {
      const rule = a.ignore.find((g) => (!g.flow || g.flow === it.name) && (!g.code || g.code === x.code) && (g.step === undefined || g.step === x.step));
      const expired = rule && rule.until && now !== null && Date.parse(rule.until + 'T23:59:59Z') < now;
      if (rule && !expired) suppressed.push({ flow: it.name, ...x, reason: rule.reason, until: rule.until || '' });
      else keep.push(expired ? { ...x, detail: `${x.detail} (suppression expired ${rule.until})` } : x);
    }
    return rescore({ ...it, findings: keep });
  }).sort((x, y) => y.risk_score - x.risk_score);
  const codes = {}; for (const i of items) for (const f of i.findings) codes[f.code] = (codes[f.code] || 0) + 1;
  return { flows: items.length, active: items.filter((i) => i.active).length, findings: items.reduce((t, i) => t + i.findings.length, 0), high: items.reduce((t, i) => t + i.high, 0), by_code: codes, suppressed, items };
}
const WEIGHT = { high: 10, medium: 3, low: 1 };
function rescore(it) { return { ...it, risk_score: it.findings.reduce((t, f) => t + WEIGHT[f.severity], 0), high: it.findings.filter((f) => f.severity === 'high').length }; }

/** Compare with a previous findings.csv (from arethusa_write_report): new, resolved and unchanged findings. */
export function compareBaseline(r, rows) {
  const key = (flow, code, step) => `${flow}|${code}|${step || ''}`;
  const before = new Set(rows.map((x) => key(x.flow, x.code, x.step)));
  const now = new Set(); let unchanged = 0; const added = [];
  for (const i of r.items) for (const f of i.findings) {
    const k = key(i.name, f.code, f.step); now.add(k);
    if (before.has(k)) { f.baseline = 'existing'; unchanged++; } else { f.baseline = 'new'; added.push({ flow: i.name, severity: f.severity, code: f.code, step: f.step }); }
  }
  const resolved = rows.filter((x) => !now.has(key(x.flow, x.code, x.step))).map((x) => ({ flow: x.flow, severity: x.severity, code: x.code, step: x.step || '' }));
  return { new: added.length, resolved: resolved.length, unchanged, new_findings: added, resolved_findings: resolved };
}

export const FINDING_COLUMNS = ['flow', 'platform', 'active', 'severity', 'category', 'code', 'step', 'detail', 'owner', 'decision'];
export const FINDING_COLUMNS_WITH_BASELINE = [...FINDING_COLUMNS.slice(0, 8), 'baseline', 'owner', 'decision'];
export const findingsCsv = (r) => toCsv(r.items.flatMap((i) => i.findings.map((f) => ({ flow: i.name, platform: i.platform, active: i.active ? 'yes' : 'no', ...f, owner: '', decision: '' }))), r.baseline ? FINDING_COLUMNS_WITH_BASELINE : FINDING_COLUMNS);

export function reportMarkdown(r) {
  const L = ['# Workflow audit', '', `${r.flows} flow(s), ${r.active} active · ${r.findings} finding(s), ${r.high} high.`, ''];
  if (r.baseline) L.push(`Against the baseline: ${r.baseline.new} new, ${r.baseline.resolved} resolved, ${r.baseline.unchanged} unchanged.`, '');
  for (const i of r.items) {
    L.push(`## ${i.name} (${i.platform}${i.active ? ', active' : ', off'}) — risk ${i.risk_score}`, '');
    if (!i.findings.length) L.push('No findings.', '');
    for (const f of i.findings) L.push(`- **${f.severity}** \`${f.code}\`${f.baseline === 'new' ? ' _(new)_' : ''} ${f.detail}`);
    L.push('');
  }
  if (r.baseline && r.baseline.resolved_findings.length) { L.push('## Resolved since the baseline', ''); for (const x of r.baseline.resolved_findings) L.push(`- ${x.flow}: \`${x.code}\`${x.step ? ` (${x.step})` : ''}`); L.push(''); }
  if (r.suppressed && r.suppressed.length) { L.push('## Suppressed by policy', ''); for (const x of r.suppressed) L.push(`- ${x.flow}: \`${x.code}\`${x.step ? ` (${x.step})` : ''}: ${x.reason}${x.until ? ` (until ${x.until})` : ''}`); L.push(''); }
  L.push('_Static review of exported definitions and the run history you gave. Arethusa does not run, enable or change any flow._', '');
  return L.join('\n');
}

const FIX = {
  possible_secret: 'If this is a key or token, move it into the platform credential store and rotate it; if not, add a suppression with a reason in the policy file.',
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
export function redact(json, opts = {}) {
  const walk = (v, keyHint) => {
    if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? redactValue(x, keyHint, opts) : walk(x, keyHint)));
    if (v && typeof v === 'object') {
      const nameLike = v.name ?? v.key ?? v.header;
      if (typeof nameLike === 'string' && 'value' in v && typeof v.value === 'string') return { ...v, value: redactValue(v.value, nameLike, opts) };
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, typeof x === 'string' ? redactValue(x, k, opts) : walk(x, k)]));
    }
    return v;
  };
  return walk(json, '');
}
