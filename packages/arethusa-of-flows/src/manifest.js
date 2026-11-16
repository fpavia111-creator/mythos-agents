import { defineManifest, toCsv, sha256, canonical, safeMarkdown, slugify, uniqueNames } from 'mythos-agent-core';
import { readFileSync, existsSync, appendFileSync, mkdirSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import { normalise, audit, findingsCsv, reportMarkdown, proposals, redact, compareBaseline } from './flows.js';
import { dependencyMap, dependencyMarkdown, dependencyCsv, findingsSarif } from './depmap.js';
import { POLICY_SCHEMA } from './schemas.js';
import { PROMPTS } from './prompts.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const str = { type: 'string' }; const num = { type: 'number' };
const props = {
  exports: { type: 'array', items: str, minItems: 1, description: 'Workflow export files: n8n workflow JSON, Zapier-style export ({zaps:[{steps:[…]}]}), Make blueprint JSON, Power Automate / Logic Apps flow definition JSON, or Workato recipe JSON (one recipe or an array)' },
  history: { ...str, description: 'Optional run history CSV/JSON: flow, run_at, status (success|error), error' },
  as_of: { ...str, description: 'Date/time for staleness (default now)' }, stale_days: num, fail_rate: num,
  policy: { ...str, description: 'Optional policy JSON (schema "policy"): allow_http_hosts, fail_rate, stale_days, entropy thresholds, and ignore rules that each need a reason' },
};
const loadPolicy = (a, ctx) => {
  if (!a.policy) return a;
  if (!ctx.exists(a.policy)) throw new Error(`file not found: ${a.policy}`);
  const p = ctx.readJson(a.policy, 'policy');
  return { ...p, ...Object.fromEntries(Object.entries(a).filter(([, v]) => v !== undefined)) };
};
const readJson = (ctx, p) => { const f = ctx.path(p); if (!existsSync(f)) throw new Error(`file not found: ${p}`); try { return JSON.parse(readFileSync(f, 'utf8')); } catch { throw new Error(`${p}: not valid JSON`); } };
const run = (a, ctx) => {
  if (!Array.isArray(a.exports) || !a.exports.length) throw new Error('exports must list at least one export file');
  const r = audit(flowsOf(a, ctx), a.history ? ctx.records(a.history) : [], loadPolicy(a, ctx));
  if (a.baseline) { if (!ctx.exists(a.baseline)) throw new Error(`file not found: ${a.baseline}`); r.baseline = compareBaseline(r, ctx.records(a.baseline)); }
  return r;
};
const flowsOf = (a, ctx) => a.exports.flatMap((p) => normalise(readJson(ctx, p), p));
const slug = (s) => slugify(s, 'flow');

export const manifest = defineManifest({
  name: 'arethusa-of-flows',
  version: pkg.version,
  description: 'Static audit of workflow automation exports (n8n, Zapier, Make, Power Automate, Workato) and run history for broken and risky flows: no trigger, disconnected or disabled steps, failing or silent runs, hardcoded secrets by known format, secret-named field or entropy (never shown), shared credentials and flow-to-flow calls, open webhooks, plain HTTP, deletes without a filter, money-moving and outbound-send steps, shell or custom code. Writes a report, proposals and redacted copies. Enabling or changing a production flow is always one human click; it never runs, enables or edits a flow.',
  model: { provider: 'anthropic', id: 'claude-sonnet-4-5-20250929', note: 'Declared host-model pin. The tools are deterministic and call no model.' },
  caps: { maxSteps: 60, maxSpendUsd: 0 },
  tools: [
    {
      name: 'arethusa_audit', kind: 'read',
      description: 'Audit each flow and rank by risk score, with findings (severity, broken or risky, step, plain reason). Secret values are never returned.',
      inputSchema: { type: 'object', required: ['exports'], properties: { ...props, baseline: { ...str, description: 'Optional findings.csv from an earlier run: marks each finding new or existing and lists resolved ones' } } },
      handler: async (a, ctx) => { const r = run(a, ctx); return { summary: `${r.flows} flow(s), ${r.active} active: ${r.findings} finding(s), ${r.high} high${r.suppressed.length ? `, ${r.suppressed.length} suppressed by policy` : ''}${r.baseline ? `; vs baseline ${r.baseline.new} new, ${r.baseline.resolved} resolved` : ''}.`, ...r }; },
    },
    {
      name: 'arethusa_write_report', kind: 'report',
      description: 'Write flow-audit.md, findings.csv (blank owner and decision columns) and findings.sarif (SARIF 2.1.0 for code-scanning dashboards) into out_dir (default mythos-out/arethusa). With a baseline, findings are marked new or existing and resolved ones are listed.',
      inputSchema: { type: 'object', required: ['exports'], properties: { ...props, out_dir: str, baseline: { ...str, description: 'Optional earlier findings.csv' } } },
      handler: async (a, ctx) => {
        const r = run(a, ctx); const out = ctx.outDir(a.out_dir || 'mythos-out/arethusa');
        const md = safeMarkdown(reportMarkdown(r)); const csv = findingsCsv(r); const sarif = JSON.stringify(findingsSarif(r, pkg.version), null, 2) + '\n';
        return { summary: `Report written: ${r.findings} finding(s) across ${r.flows} flow(s).`, files: [ctx.writeFile(out, 'flow-audit.md', md), ctx.writeFile(out, 'findings.csv', csv), ctx.writeFile(out, 'findings.sarif', sarif)], output_sha256: sha256(md + csv + sarif) };
      },
    },
    {
      name: 'arethusa_dependency_map', kind: 'report', title: 'Flow dependency map',
      description: 'Map what flows share: stored credentials, hardcoded secrets (labelled secret#1, secret#2 …; values never shown), webhooks and hosts, and which flows call another flow\'s webhook. Writes dependency-map.md (with a Mermaid graph) and dependency-map.csv, and returns a prioritised secret rotation plan.',
      inputSchema: { type: 'object', required: ['exports'], properties: { exports: props.exports, policy: props.policy, out_dir: str } },
      handler: async (a, ctx) => {
        const p = loadPolicy(a, ctx); const m = dependencyMap(flowsOf(a, ctx), { entropy: p.entropy });
        const out = ctx.outDir(a.out_dir || 'mythos-out/arethusa'); const md = safeMarkdown(dependencyMarkdown(m)); const csv = dependencyCsv(m);
        return { summary: `${m.flows} flow(s): ${m.shared} shared resource(s), ${m.calls.length} flow-to-flow call(s), ${m.rotation_plan.length} secret(s) to rotate.`, ...m, files: [ctx.writeFile(out, 'dependency-map.md', md), ctx.writeFile(out, 'dependency-map.csv', csv)], output_sha256: sha256(canonical(m)) };
      },
    },
    {
      name: 'arethusa_draft_changes', kind: 'write',
      description: 'Write proposals/<flow>.json (proposed fixes, marked not applied) and a redacted copy of each export with hardcoded secrets replaced by placeholders, into out_dir. Inputs are never changed. Needs a human yes unless opted in to Auto.',
      inputSchema: { type: 'object', required: ['exports'], properties: { ...props, out_dir: str } },
      handler: async (a, ctx) => {
        const r = run(a, ctx); const pol = loadPolicy(a, ctx); const out = ctx.outDir(a.out_dir || 'mythos-out/arethusa'); const pdir = join(out, 'proposals'); mkdirSync(pdir, { recursive: true });
        const unique = uniqueNames();
        const files = r.items.filter((i) => i.findings.length).map((i) => ctx.writeFile(pdir, unique(`${slug(i.name)}.json`), JSON.stringify(proposals(i), null, 2) + '\n'));
        for (const p of a.exports) files.push(ctx.writeFile(out, `${basename(p, extname(p))}.redacted.json`, JSON.stringify(redact(readJson(ctx, p), { entropy: pol.entropy }), null, 2) + '\n'));
        return { summary: `${files.length} file(s) written: proposals and redacted copies. Nothing was applied to any platform.`, files };
      },
    },
    {
      name: 'arethusa_request_flow_change', kind: 'action', category: 'production_deploy',
      description: 'After one named human click (even in Auto), record an approved change to a production flow (enable, disable or modify) in change-requests.csv for the flow owner. Arethusa never touches the automation platform.',
      inputSchema: { type: 'object', required: ['flow', 'change', 'detail'], properties: { flow: str, change: { type: 'string', enum: ['enable', 'disable', 'modify'] }, detail: str, out_dir: str } },
      handler: async (a, ctx) => {
        if (!['enable', 'disable', 'modify'].includes(a.change)) throw new Error('change must be enable, disable or modify');
        for (const k of ['flow', 'detail']) if (!String(a[k] ?? '').trim()) throw new Error(`${k} is required`);
        const f = join(ctx.outDir(a.out_dir || 'mythos-out/arethusa'), 'change-requests.csv');
        const csv = toCsv([{ requested_at: new Date().toISOString(), flow: a.flow, change: a.change, detail: a.detail, status: 'approved request - the flow owner applies it' }], ['requested_at', 'flow', 'change', 'detail', 'status']);
        appendFileSync(f, existsSync(f) ? csv.split('\n').slice(1).join('\n') : csv);
        return { summary: `Change request (${a.change}) recorded for "${a.flow}". No flow was changed.`, file: f };
      },
    },
    { name: 'automation_update_flow', kind: 'action', category: 'production_deploy', description: 'Listed so agents can see it is refused. Arethusa never enables, disables or edits flows on a platform.', inputSchema: { type: 'object', properties: {} } },
    { name: 'automation_run_flow', kind: 'action', category: 'move_money', description: 'Listed so agents can see it is refused. Arethusa never runs a flow, so it never places an order, sends a message or moves money.', inputSchema: { type: 'object', properties: {} } },
  ],
  prompts: PROMPTS,
  configSchemas: { policy: POLICY_SCHEMA },
  policy: { rules: [
    { tool: 'arethusa_audit', decision: 'allow' },
    { tool: 'arethusa_write_report', decision: 'allow' },
    { tool: 'arethusa_dependency_map', decision: 'allow' },
    { tool: 'arethusa_draft_changes', decision: 'ask', reason: 'Writing proposals and redacted copies needs a human yes (or an Auto opt-in).' },
    { tool: 'automation_update_flow', decision: 'block', reason: 'Arethusa never changes flows on a platform.' },
    { tool: 'automation_run_flow', decision: 'block', reason: 'Arethusa never runs flows.' },
    { tool: 'arethusa_request_flow_change', decision: 'ask', reason: 'Enabling or changing a production flow is one named human click, even in Auto.' },
    { tool: '*', decision: 'block', reason: 'Not on the Arethusa allowlist.' },
  ] },
});
