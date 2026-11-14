import { defineManifest } from 'mythos-agent-core';
import { readFileSync } from 'node:fs';
import { compareExports, tieOutBalances, reportMarkdown } from './checks.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const str = { type: 'string' };

export const manifest = defineManifest({
  name: 'olympus-of-migration',
  version: pkg.version,
  description: 'Checks NetSuite (or other ERP) migration export files before go-live and writes a readiness report. Read-only on your data; never approves go-live.',
  model: { provider: 'anthropic', id: 'claude-sonnet-4-5-20250929', note: 'Declared host-model pin. The tools are deterministic and call no model.' },
  caps: { maxSteps: 40, maxSpendUsd: 0 },
  tools: [
    {
      name: 'olympus_compare_exports', kind: 'read',
      description: 'Compare a source-system export with a target (e.g. NetSuite sandbox) export (CSV/JSON): missing and extra records, duplicate keys, field differences and amount totals.',
      inputSchema: { type: 'object', required: ['source', 'target'], properties: { source: str, target: str, key: { ...str, description: 'Key column, e.g. externalid' }, target_key: str, amount_column: str, compare_columns: { type: 'array', items: str } } },
      handler: async (a, ctx) => {
        const r = compareExports(ctx.records(a.source), ctx.records(a.target), a);
        return { summary: `${r.status}: ${r.counts.missing_in_target} missing, ${r.counts.extra_in_target} extra, ${r.counts.field_mismatches} field differences${r.totals.difference !== null ? `, totals differ by ${r.totals.difference}` : ''}. Go-live not approved.`, ...r };
      },
    },
    {
      name: 'olympus_tie_out_balances', kind: 'read',
      description: 'Tie out two trial-balance exports by account. Unknown or blank balances are reported, never guessed.',
      inputSchema: { type: 'object', required: ['source', 'target'], properties: { source: str, target: str, account_column: str, balance_column: str, tolerance: { type: 'number' } } },
      handler: async (a, ctx) => {
        const r = tieOutBalances(ctx.records(a.source), ctx.records(a.target), a);
        return { summary: `${r.tied}/${r.accounts} accounts tie (${r.status}).`, ...r };
      },
    },
    {
      name: 'olympus_readiness_report', kind: 'report',
      description: 'Write readiness-report.md and findings.json into an output folder (default mythos-out/olympus). Does not change any input file.',
      inputSchema: { type: 'object', required: ['source', 'target'], properties: { source: str, target: str, key: str, amount_column: str, source_tb: str, target_tb: str, out_dir: str, title: str } },
      handler: async (a, ctx) => {
        const cmp = compareExports(ctx.records(a.source), ctx.records(a.target), a);
        const tb = a.source_tb && a.target_tb ? tieOutBalances(ctx.records(a.source_tb), ctx.records(a.target_tb), {}) : null;
        const dir = ctx.outDir(a.out_dir || 'mythos-out/olympus');
        const generatedAt = new Date().toISOString();
        const md = ctx.writeFile(dir, 'readiness-report.md', reportMarkdown({ title: a.title, cmp, tb, generatedAt }));
        const js = ctx.writeFile(dir, 'findings.json', JSON.stringify({ generatedAt, compare: cmp, trial_balance: tb }, null, 2));
        return { summary: `Report written (${cmp.status}${tb ? ', TB ' + tb.status : ''}). Go-live not approved.`, status: cmp.status, go_live: 'not_approved', files: [md, js] };
      },
    },
    {
      name: 'olympus_approve_go_live', kind: 'action', category: 'go_live',
      description: 'Listed so agents can see it is refused. Olympus never approves go-live; a named human signs off outside the agent.',
      inputSchema: { type: 'object', properties: {} },
    },
  ],
  policy: { rules: [
    { tool: 'olympus_compare_exports', decision: 'allow' },
    { tool: 'olympus_tie_out_balances', decision: 'allow' },
    { tool: 'olympus_readiness_report', decision: 'allow' },
    { tool: 'olympus_approve_go_live', decision: 'block', reason: 'Olympus never approves go-live. A named human signs off after reading the report.' },
    { tool: '*', decision: 'block', reason: 'Not on the Olympus allowlist.' },
  ] },
});
