import { defineManifest } from 'mythos-agent-core';
import { readFileSync, statSync } from 'node:fs';
import { scanSource, scanConfig, sarif, reportMarkdown } from './rules.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const str = { type: 'string' };
const dirOf = (ctx, d) => { const p = ctx.path(d || '.'); if (!statSync(p).isDirectory()) throw new Error(`${d} is not a folder`); return p; };
const run = (a, ctx) => {
  if (!a.dir && !a.config) throw new Error('pass "dir" (a server source folder) and/or "config" (an MCP client config JSON)');
  const src = a.dir ? scanSource(dirOf(ctx, a.dir)) : null;
  const cfg = a.config ? scanConfig(JSON.parse(readFileSync(ctx.path(a.config), 'utf8'))) : null;
  return { src, cfg };
};

export const manifest = defineManifest({
  name: 'nemesis-of-servers',
  version: pkg.version,
  description: 'Reviews one MCP or Code Mode server folder, or an MCP client config, for risky patterns: shell exec without an allowlist, eval and unsandboxed Code Mode, open egress, env dumps, credential paths, inline secrets, prompt-injection text, unpinned packages. Static and pattern-based; never installs or runs the server.',
  model: { provider: 'anthropic', id: 'claude-sonnet-4-5-20250929', note: 'Declared host-model pin. The tools are deterministic and call no model.' },
  caps: { maxSteps: 40, maxSpendUsd: 0 },
  tools: [
    {
      name: 'nemesis_scan_server', kind: 'read',
      description: 'Scan a server source folder (JS/TS/Python, package.json, tool docs) and list findings with file, line and why it matters. Secret values are masked.',
      inputSchema: { type: 'object', required: ['dir'], properties: { dir: str, min_severity: { type: 'string', enum: ['low', 'medium', 'high'] } } },
      handler: async (a, ctx) => {
        const r = scanSource(dirOf(ctx, a.dir));
        if (a.min_severity) { const keep = { low: ['low', 'medium', 'high'], medium: ['medium', 'high'], high: ['high'] }[a.min_severity]; r.items = r.items.filter((i) => keep.includes(i.severity)); }
        return { summary: `${r.scanned} file(s): high ${r.by_severity.high}, medium ${r.by_severity.medium}, low ${r.by_severity.low} (${r.verdict.replace(/_/g, ' ')}).`, ...r };
      },
    },
    {
      name: 'nemesis_scan_config', kind: 'read',
      description: 'Review an MCP client config (mcpServers): unpinned npx packages, @latest, curl|sh, sudo, broad Docker flags, home or root folders, inline secrets and tokens (values never shown), plain-http remotes.',
      inputSchema: { type: 'object', required: ['config'], properties: { config: str } },
      handler: async (a, ctx) => {
        const r = scanConfig(JSON.parse(readFileSync(ctx.path(a.config), 'utf8')));
        return { summary: `${r.servers} server(s): high ${r.by_severity.high}, medium ${r.by_severity.medium}, low ${r.by_severity.low}.`, ...r };
      },
    },
    {
      name: 'nemesis_write_report', kind: 'report',
      description: 'Write nemesis-report.md, findings.json and nemesis.sarif (SARIF 2.1.0, for code scanning) into out_dir (default mythos-out/nemesis).',
      inputSchema: { type: 'object', properties: { dir: str, config: str, out_dir: str, title: str } },
      handler: async (a, ctx) => {
        const { src, cfg } = run(a, ctx);
        const items = [...(src?.items || []), ...(cfg?.items || [])];
        const by = { high: 0, medium: 0, low: 0 }; for (const i of items) by[i.severity]++;
        const merged = { findings: items.length, by_severity: by, verdict: by.high ? 'review_before_use' : by.medium ? 'review_recommended' : 'no_pattern_findings', items };
        const out = ctx.outDir(a.out_dir || 'mythos-out/nemesis');
        const files = [
          ctx.writeFile(out, 'nemesis-report.md', reportMarkdown(merged, a.title || 'MCP server review', new Date().toISOString())),
          ctx.writeFile(out, 'findings.json', JSON.stringify({ source: src, config: cfg }, null, 2)),
          ctx.writeFile(out, 'nemesis.sarif', JSON.stringify(sarif(merged, pkg.version), null, 2)),
        ];
        return { summary: `Report written: ${merged.findings} finding(s), verdict ${merged.verdict.replace(/_/g, ' ')}.`, files, verdict: merged.verdict, by_severity: by };
      },
    },
    {
      name: 'nemesis_run_server', kind: 'action', category: 'production_deploy',
      description: 'Listed so agents can see it is refused. Nemesis never installs, starts or deploys the server it reviews.',
      inputSchema: { type: 'object', properties: {} },
    },
  ],
  policy: { rules: [
    { tool: 'nemesis_scan_server', decision: 'allow' },
    { tool: 'nemesis_scan_config', decision: 'allow' },
    { tool: 'nemesis_write_report', decision: 'allow' },
    { tool: 'nemesis_run_server', decision: 'block', reason: 'Nemesis reviews code; it never installs, starts or deploys it.' },
    { tool: '*', decision: 'block', reason: 'Not on the Nemesis allowlist.' },
  ] },
});
