import { defineManifest, toCsv, toSarif, validateSarif, sha256, safeMarkdown } from 'mythos-agent-core';
import { readFileSync, statSync } from 'node:fs';
import { inventory, analyse, estimateEffort, dependencyGraph, progress, sarifFindings, testPlanMarkdown, API_MAP, SARIF_RULES, DEFAULT_WEIGHTS } from './scan.js';
import { estimateConfigSchema } from './schemas.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const str = { type: 'string' };
const dirArg = { ...str, description: 'Folder to scan, relative to --root (default: root)' };
const estimateArg = { ...str, description: 'Optional estimate_config JSON with your own effort weights (hours)' };
const dirOf = (ctx, d) => { const p = ctx.path(d || '.'); if (!statSync(p).isDirectory()) throw new Error(`${d} is not a folder`); return p; };
const weightsOf = (a, ctx) => (a.estimate_config ? ctx.readJson(a.estimate_config, 'estimate_config') : DEFAULT_WEIGHTS);

export const manifest = defineManifest({
  name: 'epimetheus-of-scripts',
  version: pkg.version,
  description: 'Inventories SuiteScript files from a local folder (e.g. an SDF project or FileCabinet export), finds SuiteScript 1.0/2.0 usage, risk-ranks and estimates what must move to 2.1, and orders the work by dependency. Never deploys code.',
  model: { provider: 'anthropic', id: 'claude-sonnet-4-5-20250929', note: 'Declared host-model pin. The tools are deterministic and call no model.' },
  caps: { maxSteps: 40, maxSpendUsd: 0 },
  configSchemas: { estimate_config: estimateConfigSchema },
  tools: [
    {
      name: 'epimetheus_inventory', kind: 'read', title: 'Inventory SuiteScript files',
      description: 'Scan a folder for SuiteScript files and return each file\'s version (1.0/2.0/2.x/2.1), script type, 1.0 API calls (code only, not comments or strings), N/ modules, a risk score and a rough effort estimate in hours, highest risk first.',
      inputSchema: { type: 'object', properties: { dir: dirArg, limit: { type: 'integer', minimum: 1 }, estimate_config: estimateArg } },
      handler: async (a, ctx) => {
        const inv = inventory(dirOf(ctx, a.dir), { weights: weightsOf(a, ctx) });
        const items = inv.items.slice(0, a.limit || 200).map(({ hits, ...rest }) => rest);
        return { summary: `${inv.files} file(s); ${inv.needs_2_1} not on 2.1; risk high ${inv.by_risk.high} / medium ${inv.by_risk.medium} / low ${inv.by_risk.low}; rough effort ${inv.effort_hours} h.`, ...inv, items };
      },
    },
    {
      name: 'epimetheus_explain_file', kind: 'read', title: 'Explain one script',
      description: 'Explain one script: every 1.0 call with its line number and a SuiteScript 2.1 module hint, its define() modules and aliases, and the effort estimate with the signals behind it.',
      inputSchema: { type: 'object', required: ['file'], properties: { file: str, estimate_config: estimateArg } },
      handler: async (a, ctx) => {
        const r = analyse(readFileSync(ctx.path(a.file), 'utf8'), a.file);
        const effort = estimateEffort(r, weightsOf(a, ctx));
        return { summary: `${a.file}: ${r.version}, ${r.risk} risk (${r.score}), ${r.call_count} 1.0 call(s), rough effort ${effort.hours} h.`, ...r, effort, hints: r.hits.map((h) => ({ ...h, suggest: API_MAP[h.api] || 'look up in Oracle docs' })) };
      },
    },
    {
      name: 'epimetheus_dependency_graph', kind: 'read', title: 'Dependency graph and conversion order',
      description: 'Build the custom-module dependency graph from define()/require() lists (relative and /SuiteScripts/ paths), report cycles and unresolved modules, and give a stable conversion order (libraries first). Includes a Mermaid diagram.',
      inputSchema: { type: 'object', properties: { dir: dirArg } },
      handler: async (a, ctx) => {
        const g = dependencyGraph(inventory(dirOf(ctx, a.dir)));
        return { summary: `${g.nodes.length} file(s), ${g.edges.length} custom dependenc${g.edges.length === 1 ? 'y' : 'ies'}, ${g.cycles.length} cycle(s), ${g.unresolved.length} unresolved.`, ...g };
      },
    },
    {
      name: 'epimetheus_progress', kind: 'read', title: 'Progress since a baseline',
      description: 'Compare a previous inventory.csv (from epimetheus_write_plan) with the folder now: files converted to 2.1, improved, regressed, added and removed, and remaining effort.',
      inputSchema: { type: 'object', required: ['baseline'], properties: { baseline: { ...str, description: 'inventory.csv from an earlier run' }, dir: dirArg, estimate_config: estimateArg } },
      handler: async (a, ctx) => {
        const r = progress(ctx.records(a.baseline), inventory(dirOf(ctx, a.dir), { weights: weightsOf(a, ctx) }));
        return { summary: `${r.converted.length} converted, ${r.regressed.length} regressed, ${r.added.length} added, ${r.removed.length} removed; ${r.current.needs_2_1} still need 2.1 (was ${r.previous.needs_2_1}); ${r.percent_on_2_1}% on 2.1.`, ...r };
      },
    },
    {
      name: 'epimetheus_write_plan', kind: 'report', title: 'Write inventory and test plan',
      description: 'Write inventory.csv (with effort and dependency order) and conversion-test-plan.md into an output folder (default mythos-out/epimetheus). Does not modify any script.',
      inputSchema: { type: 'object', properties: { dir: dirArg, out_dir: str, estimate_config: estimateArg } },
      handler: async (a, ctx) => {
        const inv = inventory(dirOf(ctx, a.dir), { weights: weightsOf(a, ctx) });
        const graph = dependencyGraph(inv);
        const orderOf = new Map(graph.order.map((o) => [o.file, o.n]));
        const out = ctx.outDir(a.out_dir || 'mythos-out/epimetheus');
        const rows = inv.items.map((i) => ({ file: i.file, version: i.version, script_type: i.script_type || '', risk: i.risk, score: i.score, loc: i.loc, api_calls: i.call_count, effort_hours: i.effort.hours, conversion_order: orderOf.get(i.file), depends_on: i.custom_dependencies.join(' '), writes: i.writes.join(' '), external: i.external.join(' '), reasons: i.reasons.join('; '), owner: '', reviewer: '', target_release: '' }));
        const csv = toCsv(rows); const md = safeMarkdown(testPlanMarkdown(inv, new Date().toISOString(), graph));
        const f1 = ctx.writeFile(out, 'inventory.csv', csv);
        const f2 = ctx.writeFile(out, 'conversion-test-plan.md', md);
        return { summary: `Wrote inventory (${inv.files} files, ${inv.effort_hours} h rough effort) and a draft test plan.`, files: [f1, f2], output_sha256: sha256(csv + '\n' + md) };
      },
    },
    {
      name: 'epimetheus_write_sarif', kind: 'report', title: 'Write SARIF for code scanning',
      description: 'Write epimetheus.sarif (SARIF 2.1.0): one result per 1.0 call with file and line, plus 2.0/2.x/unknown version notes, for GitHub code scanning or any SARIF viewer. Does not modify any script.',
      inputSchema: { type: 'object', properties: { dir: dirArg, out_dir: str, path_prefix: { ...str, description: 'Prefix for file paths in results so they match your repository layout (default: dir)' } } },
      handler: async (a, ctx) => {
        const inv = inventory(dirOf(ctx, a.dir));
        const doc = toSarif({ tool: 'epimetheus-of-scripts', version: pkg.version, informationUri: 'https://github.com/fpavia111-creator/mythos-agents/tree/main/packages/epimetheus-of-scripts', rules: SARIF_RULES, findings: sarifFindings(inv, a.path_prefix ?? a.dir ?? '') });
        const v = validateSarif(doc);
        if (!v.ok) throw new Error(`internal SARIF error: ${v.errors.join('; ')}`);
        const text = JSON.stringify(doc, null, 2);
        const f = ctx.writeFile(ctx.outDir(a.out_dir || 'mythos-out/epimetheus'), 'epimetheus.sarif', text);
        return { summary: `Wrote SARIF with ${doc.runs[0].results.length} result(s).`, files: [f], results: doc.runs[0].results.length, output_sha256: sha256(text) };
      },
    },
    {
      name: 'epimetheus_deploy_conversion', kind: 'action', category: 'production_deploy', title: 'Deploy converted script (refused)',
      description: 'Listed so agents can see it is refused. Epimetheus never deploys scripts; converted code goes through your own review and SDF/release process.',
      inputSchema: { type: 'object', properties: {} },
    },
  ],
  prompts: [
    {
      name: 'epimetheus_conversion_plan', title: 'SuiteScript 2.1 conversion plan',
      description: 'Walk through planning a SuiteScript 2.1 migration: inventory, explain the riskiest files, dependency order, effort, progress since the last baseline, and the written plan. Deploys stay with a human.',
      arguments: [
        { name: 'dir', description: 'Folder of scripts under --root (SDF project or FileCabinet download)', required: true },
        { name: 'baseline', description: 'inventory.csv from an earlier run, to show progress', required: false },
        { name: 'estimate_config', description: 'estimate_config JSON with your team\'s effort weights', required: false },
      ],
      text: [
        'You are helping a NetSuite team plan the move of custom scripts to SuiteScript 2.1. Use the epimetheus-of-scripts tools only; they read local files and never change or deploy code.',
        '',
        '1. Call epimetheus_inventory with dir={{dir}} (and estimate_config={{estimate_config}} if given). Report counts by version and risk and the total rough effort. Say clearly that effort is a planning estimate from counted signals, not a quote.',
        '2. For the three highest-risk files, call epimetheus_explain_file and summarise each 1.0 call with its line and 2.1 hint. Flag APIs with no mapping hint and scheduling/yield logic (a redesign, not a port).',
        '3. Call epimetheus_dependency_graph with dir={{dir}}. Present the conversion order (libraries first). Call out every cycle (convert and test those files together) and every unresolved module path.',
        '4. If a baseline is given ({{baseline}}), call epimetheus_progress and report files converted, regressed, added and removed since then.',
        '5. Call epimetheus_write_plan with dir={{dir}} and give the user the file paths. Offer epimetheus_write_sarif if they use GitHub code scanning.',
        '6. Suggest owners and reviewers be filled in inventory.csv; do not invent names.',
        '',
        'Human step: converted code is reviewed and deployed by a named person through the team\'s own SDF/release process. epimetheus_deploy_conversion is blocked in every mode; do not call it. Mapping hints must be verified against Oracle\'s documentation and tested in a sandbox.',
      ].join('\n'),
    },
  ],
  policy: { rules: [
    { tool: 'epimetheus_inventory', decision: 'allow' },
    { tool: 'epimetheus_explain_file', decision: 'allow' },
    { tool: 'epimetheus_dependency_graph', decision: 'allow' },
    { tool: 'epimetheus_progress', decision: 'allow' },
    { tool: 'epimetheus_write_plan', decision: 'allow' },
    { tool: 'epimetheus_write_sarif', decision: 'allow' },
    { tool: 'epimetheus_deploy_conversion', decision: 'block', reason: 'Epimetheus never deploys code. A named human deploys through the normal release process.' },
    { tool: '*', decision: 'block', reason: 'Not on the Epimetheus allowlist.' },
  ] },
});
