import { defineManifest, sha256 } from 'mythos-agent-core';
import { readFileSync, statSync } from 'node:fs';
import { loadSnapshot, diff, timeline, revertPlan, reportMarkdown } from './drift.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const str = { type: 'string' };
const ignore = { type: 'array', items: { type: 'string' }, description: 'Keys or prefixes to ignore (e.g. "meta.updated_at", "build.*")' };
const pair = (a, ctx) => diff(loadSnapshot(ctx.path(a.before)), loadSnapshot(ctx.path(a.after)), { ignore: a.ignore || [] });

export const manifest = defineManifest({
  name: 'tiresias-of-drift',
  version: pkg.version,
  description: 'Compares config and schema snapshots over time (JSON, .env/.properties, schema CSV), explains each drift with a risk level, and drafts a revert plan. Secret values are never shown. Applying a fix to production is always one human click and only records a request.',
  model: { provider: 'anthropic', id: 'claude-sonnet-4-5-20250929', note: 'Declared host-model pin. The tools are deterministic and call no model.' },
  caps: { maxSteps: 60, maxSpendUsd: 0 },
  tools: [
    {
      name: 'tiresias_diff', kind: 'read',
      description: 'Compare two snapshots (before, after) and explain every change, highest risk first.',
      inputSchema: { type: 'object', required: ['before', 'after'], properties: { before: str, after: str, ignore } },
      handler: async (a, ctx) => { const d = pair(a, ctx); return { summary: `${d.changes} change(s): high ${d.by_risk.high}, medium ${d.by_risk.medium}, low ${d.by_risk.low}.`, ...d }; },
    },
    {
      name: 'tiresias_timeline', kind: 'read',
      description: 'Walk a folder of dated snapshots (sorted by file name): changes per step, when each key first drifted, and net drift from the first to the latest.',
      inputSchema: { type: 'object', required: ['dir'], properties: { dir: str, ignore } },
      handler: async (a, ctx) => {
        const p = ctx.path(a.dir); if (!statSync(p).isDirectory()) throw new Error(`${a.dir} is not a folder`);
        const t = timeline(p, { ignore: a.ignore || [] });
        return { summary: `${t.snapshots.length} snapshots; net drift ${t.baseline} → ${t.latest}: ${t.net_drift.changes} change(s), ${t.net_drift.by_risk.high} high.`, ...t };
      },
    },
    {
      name: 'tiresias_write_report', kind: 'report',
      description: 'Write drift-report.md, drift.json and revert-plan.json (a proposal back to "before") into out_dir (default mythos-out/tiresias).',
      inputSchema: { type: 'object', required: ['before', 'after'], properties: { before: str, after: str, ignore, out_dir: str, title: str } },
      handler: async (a, ctx) => {
        const d = pair(a, ctx); const plan = revertPlan(d, a.before); const out = ctx.outDir(a.out_dir || 'mythos-out/tiresias');
        const files = [ctx.writeFile(out, 'drift-report.md', reportMarkdown(d, a.title || `Drift: ${a.before} → ${a.after}`, new Date().toISOString())), ctx.writeFile(out, 'drift.json', JSON.stringify(d, null, 2)), ctx.writeFile(out, 'revert-plan.json', JSON.stringify({ proposal: true, back_to: a.before, steps: plan }, null, 2))];
        return { summary: `Drift report written: ${d.changes} change(s), revert plan with ${plan.length} step(s) (proposal only).`, files, plan_sha256: sha256(JSON.stringify(plan)) };
      },
    },
    {
      name: 'tiresias_apply_fix', kind: 'action', category: 'production_deploy',
      description: 'After one named human click (even in Auto), record an approved fix (keys and target values) in apply-request.json for your change process. Tiresias never touches production.',
      inputSchema: { type: 'object', required: ['environment', 'keys', 'reason'], properties: { environment: str, keys: { type: 'array', items: { type: 'string' } }, reason: str, before: str, after: str, out_dir: str } },
      handler: async (a, ctx) => {
        if (!Array.isArray(a.keys) || !a.keys.length) throw new Error('keys must list at least one key');
        let steps = [];
        if (a.before && a.after) { const plan = revertPlan(pair(a, ctx), a.before); steps = plan.filter((s) => a.keys.includes(s.key)); }
        const out = ctx.outDir(a.out_dir || 'mythos-out/tiresias');
        const body = { requested_at: new Date().toISOString(), environment: a.environment, keys: a.keys, reason: a.reason, steps, status: 'approved request - apply through your own change process' };
        return { summary: `Fix request recorded for ${a.keys.length} key(s) in ${a.environment}. Nothing was changed.`, file: ctx.writeFile(out, `apply-request-${Date.now()}.json`, JSON.stringify(body, null, 2)) };
      },
    },
    { name: 'production_push_config', kind: 'action', category: 'production_deploy', description: 'Listed so agents can see it is refused. Tiresias never writes to a live system.', inputSchema: { type: 'object', properties: {} } },
  ],
  policy: { rules: [
    { tool: 'tiresias_diff', decision: 'allow' },
    { tool: 'tiresias_timeline', decision: 'allow' },
    { tool: 'tiresias_write_report', decision: 'allow' },
    { tool: 'production_push_config', decision: 'block', reason: 'Tiresias never writes to a live system.' },
    { tool: 'tiresias_apply_fix', decision: 'ask', reason: 'Changing production is one named human click, even in Auto.' },
    { tool: '*', decision: 'block', reason: 'Not on the Tiresias allowlist.' },
  ] },
});
