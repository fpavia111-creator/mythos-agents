import { defineManifest, toCsv } from 'mythos-agent-core';
import { readFileSync, existsSync, appendFileSync, mkdirSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import { normalise, audit, findingsCsv, reportMarkdown, proposals, redact } from './flows.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const str = { type: 'string' }; const num = { type: 'number' };
const props = {
  exports: { type: 'array', items: str, description: 'Workflow export files: n8n workflow JSON, Zapier-style export ({zaps:[{steps:[…]}]}) or Make blueprint JSON' },
  history: { ...str, description: 'Optional run history CSV/JSON: flow, run_at, status (success|error), error' },
  as_of: { ...str, description: 'Date/time for staleness (default now)' }, stale_days: num, fail_rate: num,
};
const readJson = (ctx, p) => { const f = ctx.path(p); if (!existsSync(f)) throw new Error(`file not found: ${p}`); try { return JSON.parse(readFileSync(f, 'utf8')); } catch { throw new Error(`${p}: not valid JSON`); } };
const run = (a, ctx) => {
  if (!Array.isArray(a.exports) || !a.exports.length) throw new Error('exports must list at least one export file');
  return audit(a.exports.flatMap((p) => normalise(readJson(ctx, p), p)), a.history ? ctx.records(a.history) : [], a);
};
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'flow';

export const manifest = defineManifest({
  name: 'arethusa-of-flows',
  version: pkg.version,
  description: 'Static audit of workflow automation exports (n8n, Zapier, Make) and run history for broken and risky flows: no trigger, disconnected or disabled steps, failing or silent runs, hardcoded secrets (never shown), open webhooks, plain HTTP, deletes without a filter, money-moving and outbound-send steps, shell or custom code. Writes a report, proposals and redacted copies. Enabling or changing a production flow is always one human click; it never runs, enables or edits a flow.',
  model: { provider: 'anthropic', id: 'claude-sonnet-4-5-20250929', note: 'Declared host-model pin. The tools are deterministic and call no model.' },
  caps: { maxSteps: 60, maxSpendUsd: 0 },
  tools: [
    {
      name: 'arethusa_audit', kind: 'read',
      description: 'Audit each flow and rank by risk score, with findings (severity, broken or risky, step, plain reason). Secret values are never returned.',
      inputSchema: { type: 'object', required: ['exports'], properties: props },
      handler: async (a, ctx) => { const r = run(a, ctx); return { summary: `${r.flows} flow(s), ${r.active} active: ${r.findings} finding(s), ${r.high} high.`, ...r }; },
    },
    {
      name: 'arethusa_write_report', kind: 'report',
      description: 'Write flow-audit.md and findings.csv (blank owner and decision columns) into out_dir (default mythos-out/arethusa).',
      inputSchema: { type: 'object', required: ['exports'], properties: { ...props, out_dir: str } },
      handler: async (a, ctx) => { const r = run(a, ctx); const out = ctx.outDir(a.out_dir || 'mythos-out/arethusa'); return { summary: `Report written: ${r.findings} finding(s) across ${r.flows} flow(s).`, files: [ctx.writeFile(out, 'flow-audit.md', reportMarkdown(r)), ctx.writeFile(out, 'findings.csv', findingsCsv(r))] }; },
    },
    {
      name: 'arethusa_draft_changes', kind: 'write',
      description: 'Write proposals/<flow>.json (proposed fixes, marked not applied) and a redacted copy of each export with hardcoded secrets replaced by placeholders, into out_dir. Inputs are never changed. Needs a human yes unless opted in to Auto.',
      inputSchema: { type: 'object', required: ['exports'], properties: { ...props, out_dir: str } },
      handler: async (a, ctx) => {
        const r = run(a, ctx); const out = ctx.outDir(a.out_dir || 'mythos-out/arethusa'); const pdir = join(out, 'proposals'); mkdirSync(pdir, { recursive: true });
        const files = r.items.filter((i) => i.findings.length).map((i) => ctx.writeFile(pdir, `${slug(i.name)}.json`, JSON.stringify(proposals(i), null, 2) + '\n'));
        for (const p of a.exports) files.push(ctx.writeFile(out, `${basename(p, extname(p))}.redacted.json`, JSON.stringify(redact(readJson(ctx, p)), null, 2) + '\n'));
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
  policy: { rules: [
    { tool: 'arethusa_audit', decision: 'allow' },
    { tool: 'arethusa_write_report', decision: 'allow' },
    { tool: 'arethusa_draft_changes', decision: 'ask', reason: 'Writing proposals and redacted copies needs a human yes (or an Auto opt-in).' },
    { tool: 'automation_update_flow', decision: 'block', reason: 'Arethusa never changes flows on a platform.' },
    { tool: 'automation_run_flow', decision: 'block', reason: 'Arethusa never runs flows.' },
    { tool: 'arethusa_request_flow_change', decision: 'ask', reason: 'Enabling or changing a production flow is one named human click, even in Auto.' },
    { tool: '*', decision: 'block', reason: 'Not on the Arethusa allowlist.' },
  ] },
});
