import { defineManifest, sha256 } from 'mythos-agent-core';
import { readFileSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { scanSource, scanConfig, summarize, countBy, verdictOf, sortFindings } from './rules.js';
import { sarif } from './sarif.js';
import { reportMarkdown, actionPlan } from './report.js';
import { normalizeToolDump, scanTools, pinTools, diffPins, PINS_SCHEMA } from './tools.js';
import { POLICY_SCHEMA } from './policy.js';
import { ADVISORIES_SCHEMA, bundledAdvisories } from './advisories.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const str = { type: 'string' };
const sev = { type: 'string', enum: ['low', 'medium', 'high'] };
const P = {
  dir: { type: 'string', description: 'Server source folder under --root' },
  config: { type: 'string', description: 'MCP client config JSON (mcpServers / servers)' },
  tools: { type: 'string', description: 'Saved tools/list result JSON: {tools:[...]}, a JSON-RPC response, or {servers:{name:{tools:[...]}}}' },
  server: { type: 'string', description: 'Server name for a single-server tools dump (default: file name)' },
  pins: { type: 'string', description: 'Pin file written by nemesis_pin_tools' },
  policy: { type: 'string', description: 'Reviewer policy JSON (schema nemesis-policy): suppressions with reasons, severity overrides, egress allowlist, ignored paths' },
  advisories: { type: 'string', description: 'Extra offline advisory list JSON (schema nemesis-advisories); the bundled snapshot is always used too' },
};
const dirOf = (ctx, d) => { const p = ctx.path(d || '.'); if (!statSync(p).isDirectory()) throw new Error(`${d} is not a folder`); return p; };

function load(a, ctx) {
  const policy = a.policy ? ctx.readJson(a.policy, 'nemesis-policy') : null;
  // A policy's advisories path is relative to the policy file.
  const extra = a.advisories || (policy?.advisories ? join(dirname(a.policy), policy.advisories).split('\\').join('/') : null);
  const bundled = bundledAdvisories();
  const advisories = [...bundled.advisories, ...(extra ? ctx.readJson(extra, 'nemesis-advisories').advisories : [])];
  return { policy, advisories, advisory_snapshot: bundled.snapshot };
}
function readTools(a, ctx) {
  const text = ctx.readText(a.tools);
  const dumps = normalizeToolDump(JSON.parse(text), a.server || basename(a.tools).replace(/\.json$/i, ''));
  // A single-server dump compared with a single-server pin file takes the pinned server name.
  if (a.pins && !a.server && dumps.length === 1) {
    const pinned = Object.keys(ctx.readJson(a.pins, 'nemesis-tool-pins').servers);
    if (pinned.length === 1) dumps[0].server = pinned[0];
  }
  return { text, dumps };
}
const toolsScan = (a, ctx, policy) => { const { text, dumps } = readTools(a, ctx); return { dumps, ...summarize(scanTools(dumps, { file: a.tools, text }), { servers: dumps.length, tools: dumps.reduce((s, d) => s + d.tools.length, 0) }, policy) }; };
const pinCheck = (a, ctx, policy) => {
  const { text, dumps } = readTools(a, ctx);
  const pins = ctx.readJson(a.pins, 'nemesis-tool-pins');
  const d = diffPins(pins, dumps, { file: a.tools, text, pinsFile: a.pins });
  return { pin_verdict: d.verdict, changes: d.changes, ...summarize(d.findings, {}, policy) };
};
const filterSev = (r, min) => {
  if (!min) return r;
  const keep = { low: ['low', 'medium', 'high'], medium: ['medium', 'high'], high: ['high'] }[min];
  return { ...r, items: r.items.filter((i) => keep.includes(i.severity)) };
};
const GATE = { high: ['high'], medium: ['high', 'medium'], low: ['high', 'medium', 'low'], none: [] };

const PROMPT = `You are reviewing an MCP server with Nemesis of Servers before anyone installs or ships it. Nemesis is static: it never installs, starts or connects to the server. Work only with files under its --root.

1. Client config (if given): call nemesis_scan_config with config "{{config}}". If a reviewer policy file is named ("{{policy}}"), pass it as policy to every Nemesis call. Report unpinned or @latest packages, inline secrets (values are never shown), auto-approved tools, permission-bypass flags and advisory matches.
2. Source: call nemesis_scan_server with dir "{{dir}}". For every NEM-FLOW-* finding read the flow (source -> sink, with line numbers) and say whether the input is really model-controlled. Treat NEM-TOKEN-PASSTHROUGH, NEM-FLOW-INPUT-TO-EXEC and NEM-HARDCODED-SECRET as blockers.
3. Tool definitions: if the user saved the server's tools/list output (for example with the MCP Inspector CLI; a person runs that, not you), call nemesis_scan_tools with tools "{{tools}}". Quote the exact suspicious text for NEM-TOOL-INJECTION, NEM-TOOL-SHADOWING, NEM-TOOL-SENSITIVE-PATH and NEM-TOOL-CONTEXT-EXFIL findings.
4. Rug pulls: if a pin file exists, call nemesis_check_pins with the new tools dump and the pins; show the diff for every changed tool. If not, and a person has reviewed the definitions, call nemesis_pin_tools to record them.
5. Call nemesis_write_report with the same inputs (and fail_on "high") to write Markdown, JSON and SARIF. Give the user the "Fix first" list in priority order.
6. Stop there. Do not try to run, install or deploy the server (nemesis_run_server is blocked). A human decides whether to accept each finding; accepted findings go in the policy file's "suppress" list with a reason, never silently.

Say plainly that a clean result means no pattern matched, not that the server is safe.`;

export const manifest = defineManifest({
  name: 'nemesis-of-servers',
  version: pkg.version,
  description: 'Reviews one MCP or Code Mode server folder, its saved tool definitions, or an MCP client config for risky patterns: shell exec, eval, source-to-sink data flows (env to network, input to exec/path, token passthrough), tool poisoning and shadowing text, rug pulls against pinned definitions, inline secrets, unpinned or advisory-listed packages and missing lockfiles. Writes Markdown, JSON and SARIF. Static and offline; never installs or runs the server.',
  model: { provider: 'anthropic', id: 'claude-sonnet-4-5-20250929', note: 'Declared host-model pin. The tools are deterministic and call no model.' },
  caps: { maxSteps: 40, maxSpendUsd: 0 },
  configSchemas: { 'nemesis-policy': POLICY_SCHEMA, 'nemesis-advisories': ADVISORIES_SCHEMA, 'nemesis-tool-pins': PINS_SCHEMA },
  prompts: [{
    name: 'nemesis_review_server', title: 'Review an MCP server before install',
    description: 'Walks the host model through a full Nemesis review: config, source and data flows, tool definitions, rug-pull pins, then a SARIF report. Never runs the server.',
    arguments: [
      { name: 'dir', description: 'Server source folder under --root', required: true },
      { name: 'config', description: 'MCP client config JSON under --root (optional)', required: false },
      { name: 'tools', description: 'Saved tools/list JSON under --root (optional)', required: false },
      { name: 'policy', description: 'Reviewer policy JSON under --root (optional)', required: false },
    ],
    text: PROMPT,
  }],
  tools: [
    {
      name: 'nemesis_scan_server', kind: 'read', title: 'Scan server source',
      description: 'Scan a server source folder (JS/TS/Python, package.json, lockfile, requirements.txt, tool docs): risky patterns, source-to-sink data flows with line-by-line paths, missing lockfile and offline advisory matches. Secret values are masked.',
      inputSchema: { type: 'object', required: ['dir'], additionalProperties: false, properties: { dir: P.dir, min_severity: sev, policy: P.policy, advisories: P.advisories } },
      handler: async (a, ctx) => {
        const { policy, advisories } = load(a, ctx);
        const r = filterSev(scanSource(dirOf(ctx, a.dir), { policy, advisories }), a.min_severity);
        return { summary: `${r.scanned} file(s): high ${r.by_severity.high}, medium ${r.by_severity.medium}, low ${r.by_severity.low} (${r.verdict.replace(/_/g, ' ')})${r.suppressed.length ? `; ${r.suppressed.length} suppressed by policy` : ''}.`, ...r };
      },
    },
    {
      name: 'nemesis_scan_config', kind: 'read', title: 'Review MCP client config',
      description: 'Review an MCP client config (mcpServers): unpinned npx/uvx packages, @latest, advisory matches, curl|sh, sudo, broad Docker flags, home or root folders, permission-bypass flags, auto-approved tools (alwaysAllow/autoApprove/trust), duplicate servers, inline secrets and tokens (values never shown), plain-http remotes.',
      inputSchema: { type: 'object', required: ['config'], additionalProperties: false, properties: { config: P.config, policy: P.policy, advisories: P.advisories } },
      handler: async (a, ctx) => {
        const { policy, advisories } = load(a, ctx); const text = ctx.readText(a.config);
        const r = scanConfig(JSON.parse(text), { text, file: a.config, advisories, policy });
        return { summary: `${r.servers} server(s): high ${r.by_severity.high}, medium ${r.by_severity.medium}, low ${r.by_severity.low}.`, ...r };
      },
    },
    {
      name: 'nemesis_scan_tools', kind: 'read', title: 'Check tool definitions for poisoning',
      description: 'Check a saved tools/list result (one or several servers) for tool poisoning: hidden instructions, invisible Unicode, whitespace padding, credential-file lures, requests for chat history or file contents, shadowing of other servers\' tools, name collisions and look-alike names, free-form command/code parameters, and read-only annotations on destructive tools. Never connects to a server.',
      inputSchema: { type: 'object', required: ['tools'], additionalProperties: false, properties: { tools: P.tools, server: P.server, policy: P.policy, min_severity: sev } },
      handler: async (a, ctx) => {
        const { policy } = load(a, ctx);
        const { dumps, ...r0 } = toolsScan(a, ctx, policy); const r = filterSev(r0, a.min_severity);
        return { summary: `${r.tools} tool(s) on ${r.servers} server(s): high ${r.by_severity.high}, medium ${r.by_severity.medium}, low ${r.by_severity.low} (${r.verdict.replace(/_/g, ' ')}).`, ...r };
      },
    },
    {
      name: 'nemesis_pin_tools', kind: 'report', title: 'Pin reviewed tool definitions',
      description: 'Write tool-pins.json (a sha256 per tool plus the reviewed text) into out_dir (default mythos-out/nemesis), so later changes to descriptions or schemas (rug pulls) show up in nemesis_check_pins. Pin only definitions a person has reviewed.',
      inputSchema: { type: 'object', required: ['tools'], additionalProperties: false, properties: { tools: P.tools, server: P.server, out_dir: str } },
      handler: async (a, ctx) => {
        const { dumps } = readTools(a, ctx);
        const text = JSON.stringify(pinTools(dumps), null, 2) + '\n';
        const file = ctx.writeFile(ctx.outDir(a.out_dir || 'mythos-out/nemesis'), 'tool-pins.json', text);
        const n = dumps.reduce((s, d) => s + d.tools.length, 0);
        return { summary: `Pinned ${n} tool(s) on ${dumps.length} server(s).`, file, tools: n, output_sha256: sha256(text) };
      },
    },
    {
      name: 'nemesis_check_pins', kind: 'read', title: 'Detect rug pulls against pins',
      description: 'Compare a new tools/list dump with a pin file: added, removed and changed tools, with a unified diff of each changed description, schema or annotation. A change that adds poisoning text is high (rug pull suspected).',
      inputSchema: { type: 'object', required: ['tools', 'pins'], additionalProperties: false, properties: { tools: P.tools, pins: P.pins, server: P.server, policy: P.policy } },
      handler: async (a, ctx) => {
        const { policy } = load(a, ctx);
        const r = pinCheck(a, ctx, policy);
        return { summary: `${r.pin_verdict.replace(/_/g, ' ')}: ${r.changes.length} change(s) since the pin.`, ...r };
      },
    },
    {
      name: 'nemesis_write_report', kind: 'report', title: 'Write Markdown, JSON and SARIF',
      description: 'Write nemesis-report.md (with a prioritised "fix first" list and an OWASP MCP Top 10 view), findings.json and nemesis.sarif (SARIF 2.1.0 with rule help, CWE tags, security-severity, data-flow paths and policy suppressions) into out_dir (default mythos-out/nemesis). Optional fail_on returns a pass/fail gate for CI. The SARIF hash is recorded in the audit log.',
      inputSchema: { type: 'object', additionalProperties: false, properties: { dir: P.dir, config: P.config, tools: P.tools, server: P.server, pins: P.pins, policy: P.policy, advisories: P.advisories, out_dir: str, title: str, uri_prefix: { type: 'string', description: 'Prefix for SARIF paths so they are repository-relative, e.g. "servers/notes/"' }, fail_on: { type: 'string', enum: ['high', 'medium', 'low', 'none'] } } },
      handler: async (a, ctx) => {
        if (!a.dir && !a.config && !a.tools) throw new Error('pass "dir" (a server source folder), "config" (an MCP client config JSON) and/or "tools" (a saved tools/list result)');
        if (a.pins && !a.tools) throw new Error('"pins" needs "tools" (the current tools/list dump to compare)');
        const { policy, advisories, advisory_snapshot } = load(a, ctx);
        const src = a.dir ? scanSource(dirOf(ctx, a.dir), { policy, advisories }) : null;
        // Report paths relative to --root, like the config and tools paths.
        if (src) { const base = a.dir.replace(/\\/g, '/').replace(/^\.\/?/, '').replace(/\/$/, ''); for (const i of [...src.items, ...src.suppressed]) if (base) i.file = `${base}/${i.file}`; }
        let cfg = null;
        if (a.config) { const text = ctx.readText(a.config); cfg = scanConfig(JSON.parse(text), { text, file: a.config, advisories, policy }); }
        let tl = null; if (a.tools) { const { dumps, ...r } = toolsScan(a, ctx, policy); tl = r; }
        const pc = a.pins ? pinCheck(a, ctx, policy) : null;
        const items = sortFindings([...(src?.items || []), ...(cfg?.items || []), ...(tl?.items || []), ...(pc?.items || [])]);
        const suppressed = [...(src?.suppressed || []), ...(cfg?.suppressed || []), ...(tl?.suppressed || []), ...(pc?.suppressed || [])];
        const by = countBy(items);
        const failOn = a.fail_on || policy?.fail_on || null;
        const gate = failOn ? { fail_on: failOn, result: items.some((i) => GATE[failOn].includes(i.severity)) ? 'fail' : 'pass' } : null;
        const merged = { findings: items.length, by_severity: by, verdict: verdictOf(by), items, suppressed, gate, tool_changes: pc?.changes || [] };
        const out = ctx.outDir(a.out_dir || 'mythos-out/nemesis');
        const sarifText = JSON.stringify(sarif(merged, pkg.version, { uriPrefix: a.uri_prefix, configUri: a.config }), null, 2) + '\n';
        const json = JSON.stringify({ tool: 'nemesis-of-servers', version: pkg.version, advisory_snapshot, verdict: merged.verdict, by_severity: by, gate, fix_first: actionPlan(items), source: src, config: cfg, tools: tl, pins: pc }, null, 2) + '\n';
        const files = [
          ctx.writeFile(out, 'nemesis-report.md', reportMarkdown(merged, a.title || 'MCP server review', new Date().toISOString())),
          ctx.writeFile(out, 'findings.json', json),
          ctx.writeFile(out, 'nemesis.sarif', sarifText),
        ];
        return { summary: `Report written: ${merged.findings} finding(s), verdict ${merged.verdict.replace(/_/g, ' ')}${gate ? `, gate ${gate.result}` : ''}.`, files, verdict: merged.verdict, by_severity: by, gate, suppressed: suppressed.length, sarif_sha256: sha256(sarifText), output_sha256: sha256(sarifText + json) };
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
    { tool: 'nemesis_scan_tools', decision: 'allow' },
    { tool: 'nemesis_pin_tools', decision: 'allow' },
    { tool: 'nemesis_check_pins', decision: 'allow' },
    { tool: 'nemesis_write_report', decision: 'allow' },
    { tool: 'nemesis_run_server', decision: 'block', reason: 'Nemesis reviews code; it never installs, starts or deploys it.' },
    { tool: '*', decision: 'block', reason: 'Not on the Nemesis allowlist.' },
  ] },
});
