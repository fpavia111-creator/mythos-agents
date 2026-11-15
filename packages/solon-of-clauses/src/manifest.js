import { defineManifest, toCsv, sha256 } from 'mythos-agent-core';
import { readFileSync, existsSync, appendFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { checkContract, readContract, issuesMemo, MARK, DISCLAIMER } from './clauses.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const str = { type: 'string' };
const props = {
  contract: { ...str, description: 'Contract as a .txt or .md file (export it as plain text first), relative to --root' },
  playbook: { ...str, description: 'Your own clause playbook as JSON: source, clauses [{id, title, required|prohibited, find, must_include, must_not_include, value, note, fallback}]' },
};
const rel = (ctx, f) => relative(ctx.root, f).split('\\').join('/');
function load(a, ctx) {
  if (!String(a.contract ?? '').trim()) throw new Error('contract is required');
  if (!String(a.playbook ?? '').trim()) throw new Error('playbook is required (your own clause checklist as JSON)');
  const cf = ctx.path(a.contract); if (!existsSync(cf)) throw new Error(`contract not found: ${a.contract}`);
  const pf = ctx.path(a.playbook); if (!existsSync(pf)) throw new Error(`playbook not found: ${a.playbook}`);
  let pb; try { pb = JSON.parse(readFileSync(pf, 'utf8')); } catch { throw new Error('playbook is not valid JSON'); }
  return checkContract(readContract(cf), pb, { file: a.contract });
}
const line = (r) => `${r.gaps} gap(s) against ${r.playbook_source}: ${r.counts.missing || 0} missing, ${r.counts.prohibited_present || 0} prohibited present, ${r.counts.needs_attention || 0} need attention, ${r.counts.present || 0} present; ${r.document_findings.length} document finding(s). Not legal advice.`;

export const manifest = defineManifest({
  name: 'solon-of-clauses',
  version: pkg.version,
  description: 'Checks a contract\'s text against your own clause playbook: which clauses are present, missing, prohibited or need attention (required words absent, forbidden words present, numbers outside your limits), each with section and line citations, plus open placeholders, broken cross-references and duplicate section numbers. Drafts an issues list for counsel using only your playbook\'s fallback language. Sending is one human click after a named reviewer; signing is blocked. Not legal advice, not a substitute for a lawyer, and never reviews the other side\'s interests.',
  model: { provider: 'anthropic', id: 'claude-sonnet-4-5-20250929', note: 'Declared host-model pin. The tools are deterministic and call no model.' },
  caps: { maxSteps: 60, maxSpendUsd: 0 },
  tools: [
    {
      name: 'solon_check', kind: 'read',
      description: 'Check the contract against the playbook. Every clause gets a status with citations (section, line, quote) and the playbook\'s own note. Text matching only; no interpretation and no network.',
      inputSchema: { type: 'object', required: ['contract', 'playbook'], properties: props },
      handler: async (a, ctx) => { const r = load(a, ctx); return { summary: line(r), ...r }; },
    },
    {
      name: 'solon_write_report', kind: 'report',
      description: 'Write clause-gaps.md and clause-gaps.csv (blank owner and status columns) into out_dir (default mythos-out/solon).',
      inputSchema: { type: 'object', required: ['contract', 'playbook'], properties: { ...props, out_dir: str } },
      handler: async (a, ctx) => {
        const r = load(a, ctx); const out = ctx.outDir(a.out_dir || 'mythos-out/solon');
        const L = [`# Clause check: ${r.file}`, '', DISCLAIMER, '', line(r), '', '| Status | Clause | Where | Issues |', '|---|---|---|---|', ...r.clauses.map((c) => `| ${c.status} | ${c.title} | ${c.citations.map((x) => `${x.section}, line ${x.line}`).join('; ')} | ${c.issues.join(' ').replace(/\|/g, '\\|')} |`), '', '## Document checks', '', ...(r.document_findings.length ? r.document_findings.map((d) => `- Line ${d.line} ${d.check}: ${d.detail}`) : ['- none']), ''];
        const csv = toCsv(r.clauses.map((c) => ({ clause: c.id, title: c.title, status: c.status, where: c.citations.map((x) => `${x.section} L${x.line}`).join('; '), issues: c.issues.join(' '), owner: '', status_note: '' })), ['clause', 'title', 'status', 'where', 'issues', 'owner', 'status_note']);
        return { summary: `Report written. ${line(r)}`, files: [ctx.writeFile(out, 'clause-gaps.md', L.join('\n')), ctx.writeFile(out, 'clause-gaps.csv', csv)] };
      },
    },
    {
      name: 'solon_draft_markup', kind: 'write',
      description: 'Write issues-for-counsel.md into out_dir: each gap with its citation, your playbook\'s position and its fallback language copied word for word (Solon writes no contract language of its own), every section marked [COUNSEL REVIEW]. Returns draft_sha256. Nothing is sent. Needs a human yes unless opted in to Auto.',
      inputSchema: { type: 'object', required: ['contract', 'playbook'], properties: { ...props, out_dir: str } },
      handler: async (a, ctx) => {
        const r = load(a, ctx); const out = ctx.outDir(a.out_dir || 'mythos-out/solon'); const text = issuesMemo(r);
        const f = ctx.writeFile(out, 'issues-for-counsel.md', text);
        return { summary: `Issues list drafted for ${r.gaps} gap(s) and ${r.document_findings.length} document finding(s), marked [COUNSEL REVIEW]. Nothing was sent. Not legal advice.`, draft: rel(ctx, f), draft_sha256: sha256(text), files: [f] };
      },
    },
    {
      name: 'solon_request_send', kind: 'action', category: 'binding_send',
      description: 'After one named human click (even in Auto), record in send-requests.csv that the reviewed issues list or markup may go to the named recipient. Tied to draft_sha256; refused until counsel has reviewed it (reviewed_by, and every [COUNSEL REVIEW] marker removed). A person sends it; Solon never sends or signs.',
      inputSchema: { type: 'object', required: ['draft', 'draft_sha256', 'to', 'reviewed_by'], properties: { draft: str, draft_sha256: str, to: { ...str, description: 'Who it goes to, e.g. "Kettle Labs legal"' }, reviewed_by: { ...str, description: 'The lawyer or authorised person who reviewed the draft' }, out_dir: str } },
      handler: async (a, ctx) => {
        const df = ctx.path(a.draft); if (!existsSync(df)) throw new Error(`draft not found: ${a.draft}`);
        const text = readFileSync(df, 'utf8'); if (sha256(text) !== a.draft_sha256) throw new Error('draft_sha256 does not match the draft; review the current file and ask again');
        if (!String(a.reviewed_by || '').trim()) throw new Error('reviewed_by is required: name the lawyer or authorised person who reviewed it');
        if (!String(a.to || '').trim()) throw new Error('to is required');
        const left = (text.match(new RegExp(MARK.source, 'g')) || []).length;
        if (left) throw new Error(`${left} [COUNSEL REVIEW] marker(s) are still in the draft; counsel removes each one after reviewing that section`);
        const dir = ctx.outDir(a.out_dir || 'mythos-out/solon'); const f = join(dir, 'send-requests.csv');
        const row = toCsv([{ requested_at: new Date().toISOString(), draft: a.draft, draft_sha256: a.draft_sha256, to: a.to, reviewed_by: a.reviewed_by, status: 'approved - a person sends it' }], ['requested_at', 'draft', 'draft_sha256', 'to', 'reviewed_by', 'status']);
        appendFileSync(f, existsSync(f) ? row.split('\n').slice(1).join('\n') : row);
        return { summary: `Send to ${a.to} approved and recorded (reviewed by ${a.reviewed_by}). Nothing was sent.`, file: f };
      },
    },
    { name: 'send_email', kind: 'action', category: 'binding_send', description: 'Listed so agents can see it is refused. Solon never sends anything to the other side.', inputSchema: { type: 'object', properties: {} } },
    { name: 'e_sign', kind: 'action', category: 'binding_send', description: 'Listed so agents can see it is refused. Solon never signs, accepts or e-signs a contract.', inputSchema: { type: 'object', properties: {} } },
  ],
  policy: { rules: [
    { tool: 'solon_check', decision: 'allow' },
    { tool: 'solon_write_report', decision: 'allow' },
    { tool: 'solon_draft_markup', decision: 'ask', reason: 'Drafting an issues list needs a human yes (or an Auto opt-in).' },
    { tool: 'send_email', decision: 'block', reason: 'Solon never sends. A person does, after counsel review.' },
    { tool: 'e_sign', decision: 'block', reason: 'Solon never signs or accepts a contract.' },
    { tool: 'solon_request_send', decision: 'ask', reason: 'Sending contract language is one named human click, even in Auto.' },
    { tool: '*', decision: 'block', reason: 'Not on the Solon allowlist.' },
  ] },
});
