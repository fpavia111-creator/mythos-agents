import { defineManifest, toCsv } from 'mythos-agent-core';
import { readFileSync, statSync } from 'node:fs';
import { inventory, analyse, testPlanMarkdown, API_MAP } from './scan.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const str = { type: 'string' };
const dirOf = (ctx, d) => { const p = ctx.path(d || '.'); if (!statSync(p).isDirectory()) throw new Error(`${d} is not a folder`); return p; };

export const manifest = defineManifest({
  name: 'epimetheus-of-scripts',
  version: pkg.version,
  description: 'Inventories SuiteScript files from a local folder (e.g. an SDF project or FileCabinet export), finds SuiteScript 1.0/2.0 usage and risk-ranks what must move to 2.1. Never deploys code.',
  model: { provider: 'anthropic', id: 'claude-sonnet-4-5-20250929', note: 'Declared host-model pin. The tools are deterministic and call no model.' },
  caps: { maxSteps: 40, maxSpendUsd: 0 },
  tools: [
    {
      name: 'epimetheus_inventory', kind: 'read',
      description: 'Scan a folder for SuiteScript files and return each file\'s version (1.0/2.0/2.x/2.1), script type, 1.0 API calls and a risk score, highest risk first.',
      inputSchema: { type: 'object', properties: { dir: { ...str, description: 'Folder to scan (default: root)' }, limit: { type: 'number' } } },
      handler: async (a, ctx) => {
        const inv = inventory(dirOf(ctx, a.dir));
        const items = inv.items.slice(0, a.limit || 200).map(({ hits, ...rest }) => rest);
        return { summary: `${inv.files} file(s); ${inv.needs_2_1} not on 2.1; risk high ${inv.by_risk.high} / medium ${inv.by_risk.medium} / low ${inv.by_risk.low}.`, ...inv, items };
      },
    },
    {
      name: 'epimetheus_explain_file', kind: 'read',
      description: 'Explain one script: every 1.0 call with its line number and a SuiteScript 2.1 module hint.',
      inputSchema: { type: 'object', required: ['file'], properties: { file: str } },
      handler: async (a, ctx) => {
        const r = analyse(readFileSync(ctx.path(a.file), 'utf8'), a.file);
        return { summary: `${a.file}: ${r.version}, ${r.risk} risk (${r.score}), ${r.call_count} 1.0 call(s).`, ...r, hints: r.hits.map((h) => ({ ...h, suggest: API_MAP[h.api] || 'look up in Oracle docs' })) };
      },
    },
    {
      name: 'epimetheus_write_plan', kind: 'report',
      description: 'Write inventory.csv and conversion-test-plan.md into an output folder (default mythos-out/epimetheus). Does not modify any script.',
      inputSchema: { type: 'object', properties: { dir: str, out_dir: str } },
      handler: async (a, ctx) => {
        const inv = inventory(dirOf(ctx, a.dir));
        const out = ctx.outDir(a.out_dir || 'mythos-out/epimetheus');
        const rows = inv.items.map((i) => ({ file: i.file, version: i.version, script_type: i.script_type || '', risk: i.risk, score: i.score, loc: i.loc, api_calls: i.call_count, writes: i.writes.join(' '), external: i.external.join(' '), reasons: i.reasons.join('; '), owner: '', reviewer: '', target_release: '' }));
        const f1 = ctx.writeFile(out, 'inventory.csv', toCsv(rows));
        const f2 = ctx.writeFile(out, 'conversion-test-plan.md', testPlanMarkdown(inv, new Date().toISOString()));
        return { summary: `Wrote inventory (${inv.files} files) and a draft test plan.`, files: [f1, f2] };
      },
    },
    {
      name: 'epimetheus_deploy_conversion', kind: 'action', category: 'production_deploy',
      description: 'Listed so agents can see it is refused. Epimetheus never deploys scripts; converted code goes through your own review and SDF/release process.',
      inputSchema: { type: 'object', properties: {} },
    },
  ],
  policy: { rules: [
    { tool: 'epimetheus_inventory', decision: 'allow' },
    { tool: 'epimetheus_explain_file', decision: 'allow' },
    { tool: 'epimetheus_write_plan', decision: 'allow' },
    { tool: 'epimetheus_deploy_conversion', decision: 'block', reason: 'Epimetheus never deploys code. A named human deploys through the normal release process.' },
    { tool: '*', decision: 'block', reason: 'Not on the Epimetheus allowlist.' },
  ] },
});
