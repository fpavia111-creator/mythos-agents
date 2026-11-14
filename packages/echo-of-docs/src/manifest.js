import { defineManifest, toCsv, sha256 } from 'mythos-agent-core';
import { readFileSync, existsSync, appendFileSync, mkdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { check, applyFixes } from './docs.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const str = { type: 'string' };
const props = {
  pack: { ...str, description: 'Package folder with package.json and README.md (docs/, skills/ and SKILL.md are read too), relative to --root' },
  tools: { ...str, description: 'Tool list as JSON: an MCP tools/list result, mythos_info output, or a plain array. Without it only package.json and link checks run' },
  ignore: { type: 'array', items: str, description: 'Check ids to leave out, e.g. ["count_mismatch"]' },
};
const rel = (ctx, f) => relative(ctx.root, f).split('\\').join('/');
function load(a, ctx) {
  if (!String(a.pack ?? '').trim()) throw new Error('pack is required');
  const dir = ctx.path(a.pack); if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`pack folder not found: ${a.pack}`);
  let tools = null;
  if (a.tools) { const f = ctx.path(a.tools); if (!existsSync(f)) throw new Error(`tools file not found: ${a.tools}`); try { tools = JSON.parse(readFileSync(f, 'utf8')); } catch { throw new Error('tools file is not valid JSON'); } }
  return { dir, r: check(dir, tools, a) };
}
const line = (r) => `${r.package}@${r.version}: ${r.issues} drift finding(s) (${r.by_severity.error || 0} error, ${r.by_severity.warning || 0} warning, ${r.by_severity.advisory || 0} advisory) across ${r.docs.length} doc(s); ${r.tools_documented} of ${r.tools} tool(s) documented; ${r.fixes.length} mechanical fix(es) available.`;

export const manifest = defineManifest({
  name: 'echo-of-docs',
  version: pkg.version,
  description: 'Compares a package\'s README, docs and SKILL.md files with its tool list, input schemas and package.json, and reports drift: tools that are undocumented or no longer exist, wrong allow/ask/block labels, CLI examples with parameters the schema does not have, version, Node, script and license mismatches, broken links and anchors, bad skill frontmatter. Drafts low-risk fixes (version pins, unambiguous tool-name typos) as copies within caps. Publishing docs is one human click. Never overwrites docs.',
  model: { provider: 'anthropic', id: 'claude-sonnet-4-5-20250929', note: 'Declared host-model pin. The tools are deterministic and call no model.' },
  caps: { maxSteps: 60, maxSpendUsd: 0 },
  tools: [
    {
      name: 'echo_check', kind: 'read',
      description: 'Compare the docs with the tool list and package.json. Every finding has a severity, file and line. Reads files only; does not run the package.',
      inputSchema: { type: 'object', required: ['pack'], properties: props },
      handler: async (a, ctx) => { const { r } = load(a, ctx); return { summary: `${line(r)} No drift found is not the same as complete docs.`, ...r }; },
    },
    {
      name: 'echo_write_report', kind: 'report',
      description: 'Write docs-drift.md and drift.csv (blank owner and status columns) into out_dir (default mythos-out/echo).',
      inputSchema: { type: 'object', required: ['pack'], properties: { ...props, out_dir: str } },
      handler: async (a, ctx) => {
        const { r } = load(a, ctx); const out = ctx.outDir(a.out_dir || 'mythos-out/echo');
        const L = [`# Docs drift: ${r.package}@${r.version}`, '', line(r), '', '| Severity | Check | Where | Detail |', '|---|---|---|---|', ...r.findings.map((f) => `| ${f.severity} | ${f.check} | ${f.file}${f.line ? ':' + f.line : ''} | ${f.detail.replace(/\|/g, '\\|')} |`), ...(r.findings.length ? [] : ['| | none | | |']), '', '## Limits', '', r.limits, ''];
        const csv = toCsv(r.findings.map((f) => ({ severity: f.severity, check: f.check, file: f.file, line: f.line ?? '', detail: f.detail, owner: '', status: '' })), ['severity', 'check', 'file', 'line', 'detail', 'owner', 'status']);
        return { summary: `Report written. ${line(r)}`, files: [ctx.writeFile(out, 'docs-drift.md', L.join('\n')), ctx.writeFile(out, 'drift.csv', csv)] };
      },
    },
    {
      name: 'echo_draft_fixes', kind: 'write',
      description: 'Write fixed copies of docs into out_dir/proposed for mechanical fixes only: version pins that differ from package.json and tool names one or two letters off a single real tool. Capped by max_fixes (default 20) and max_per_file (default 10). Writes changes.md and proposal.json with before/after hashes; your docs are not touched, so there is nothing to roll back. Everything else is listed for a person. Needs a human yes unless opted in to Auto.',
      inputSchema: { type: 'object', required: ['pack'], properties: { ...props, max_fixes: { type: 'integer', minimum: 1, maximum: 100 }, max_per_file: { type: 'integer', minimum: 1, maximum: 50 }, out_dir: str } },
      handler: async (a, ctx) => {
        const { dir, r } = load(a, ctx); const out = ctx.outDir(a.out_dir || 'mythos-out/echo');
        const fx = applyFixes(dir, r.fixes, { maxFixes: a.max_fixes || 20, maxPerFile: a.max_per_file || 10 });
        const files = [];
        for (const f of fx.files) { const dest = join(out, 'proposed', f.file); mkdirSync(dirname(dest), { recursive: true }); ctx.writeFile(dirname(dest), f.file.split('/').pop(), f.after); files.push({ file: f.file, proposed: `proposed/${f.file}`, applied: f.applied, sha256_before: sha256(f.before), sha256_after: sha256(f.after) }); }
        const fixedKeys = new Set(fx.files.flatMap((f) => f.applied.map((x) => `${f.file}:${x.line}:${x.check}`)));
        const person = r.findings.filter((f) => !fixedKeys.has(`${f.file}:${f.line}:${f.check}`));
        const L = ['# Proposed docs changes (not published)', '', `Pack: ${r.package}@${r.version}`, '', '## Mechanical fixes in proposed/', '', ...(files.length ? files.flatMap((f) => f.applied.map((x) => `- ${f.file}:${x.line} ${x.check}: \`${x.from}\` → \`${x.to}\``)) : ['- none']), '', `## Skipped by the caps (${fx.skipped.length})`, '', ...fx.skipped.map((s) => `- ${s.file}:${s.line} ${s.check}: ${s.why}`), '', `## Needs a person (${person.length})`, '', 'Echo does not rewrite prose, tables or examples.', '', ...person.map((f) => `- [ ] ${f.file}${f.line ? ':' + f.line : ''} ${f.check}: ${f.detail}`), ''];
        const proposal = { pack: a.pack, package: `${r.package}@${r.version}`, created_at: new Date().toISOString(), files, skipped: fx.skipped.length, needs_person: person.length, note: 'Proposal only. A person publishes it.' };
        const pText = JSON.stringify(proposal, null, 2) + '\n'; const pf = ctx.writeFile(out, 'proposal.json', pText);
        return { summary: `${files.reduce((n, f) => n + f.applied.length, 0)} mechanical fix(es) in ${files.length} file(s) written to proposed/; ${fx.skipped.length} skipped by the caps; ${person.length} finding(s) need a person. Your docs were not changed.`, proposal: rel(ctx, pf), proposal_sha256: sha256(pText), files: [...files.map((f) => join(out, f.proposed)), ctx.writeFile(out, 'changes.md', L.join('\n')), pf] };
      },
    },
    {
      name: 'echo_request_publish', kind: 'action', category: 'production_deploy',
      description: 'After one named human click (even in Auto), record in publish-requests.csv that the reviewed docs proposal is approved to publish. Tied to proposal_sha256; every proposed file is re-hashed, and the original docs must be unchanged since the proposal. A person publishes; Echo never overwrites docs or pushes.',
      inputSchema: { type: 'object', required: ['proposal', 'proposal_sha256'], properties: { proposal: str, proposal_sha256: str, out_dir: str } },
      handler: async (a, ctx) => {
        const pf = ctx.path(a.proposal); if (!existsSync(pf)) throw new Error(`proposal not found: ${a.proposal}`);
        const text = readFileSync(pf, 'utf8'); if (sha256(text) !== a.proposal_sha256) throw new Error('proposal_sha256 does not match the proposal file; review the current proposal and ask again');
        const p = JSON.parse(text); if (!p.files?.length) throw new Error('the proposal has no file changes');
        const packDir = ctx.path(p.pack);
        for (const f of p.files) {
          const fp = join(dirname(pf), f.proposed); if (!existsSync(fp) || sha256(readFileSync(fp, 'utf8')) !== f.sha256_after) throw new Error(`${f.proposed} changed after the proposal was written`);
          const orig = join(packDir, f.file); if (!existsSync(orig) || sha256(readFileSync(orig, 'utf8')) !== f.sha256_before) throw new Error(`${f.file} changed since the proposal; draft the fixes again`);
        }
        const dir = ctx.outDir(a.out_dir || 'mythos-out/echo'); const f = join(dir, 'publish-requests.csv');
        const row = toCsv([{ requested_at: new Date().toISOString(), package: p.package, proposal: a.proposal, proposal_sha256: a.proposal_sha256, files: p.files.map((x) => x.file).join('; '), status: 'approved - a person publishes it' }], ['requested_at', 'package', 'proposal', 'proposal_sha256', 'files', 'status']);
        appendFileSync(f, existsSync(f) ? row.split('\n').slice(1).join('\n') : row);
        return { summary: `Docs publish approved and recorded for ${p.files.length} file(s). Nothing was overwritten or pushed.`, file: f };
      },
    },
    { name: 'write_docs', kind: 'action', category: 'production_deploy', description: 'Listed so agents can see it is refused. Echo never overwrites docs in place.', inputSchema: { type: 'object', properties: {} } },
    { name: 'git_push', kind: 'action', category: 'production_deploy', description: 'Listed so agents can see it is refused. Echo never commits, pushes or publishes docs.', inputSchema: { type: 'object', properties: {} } },
  ],
  policy: { rules: [
    { tool: 'echo_check', decision: 'allow' },
    { tool: 'echo_write_report', decision: 'allow' },
    { tool: 'echo_draft_fixes', decision: 'ask', reason: 'Writing proposed doc copies needs a human yes (or an Auto opt-in).' },
    { tool: 'write_docs', decision: 'block', reason: 'Echo never overwrites docs. A person publishes.' },
    { tool: 'git_push', decision: 'block', reason: 'Echo never pushes or publishes.' },
    { tool: 'echo_request_publish', decision: 'ask', reason: 'Publishing docs is one named human click, even in Auto.' },
    { tool: '*', decision: 'block', reason: 'Not on the Echo allowlist.' },
  ] },
});
