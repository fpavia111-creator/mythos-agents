import { defineManifest, toCsv, sha256, unifiedDiff, safeMarkdown } from 'mythos-agent-core';
import { readFileSync, existsSync, appendFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { checkContract, readContractFile, issuesMemo, compareDrafts, compareMarkdown, MARK, DISCLAIMER } from './clauses.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const str = { type: 'string' };
const props = {
  contract: { ...str, description: 'Contract as a .docx, .txt or .md file, relative to --root (export a PDF as plain text first)' },
  playbook: { ...str, description: 'Your own clause playbook as JSON: source, version, clauses [{id, title, required|prohibited, find, must_include, must_not_include, value, note, fallback}]; checked against the playbook schema' },
};
const prevProp = { ...str, description: 'An earlier draft of the same contract (.docx, .txt or .md), to compare clause by clause' };
const clause = { type: 'object', additionalProperties: false, required: ['id', 'title', 'find'], properties: {
  id: { type: 'string', pattern: '^[a-z0-9_]{1,64}$' }, title: { type: 'string', minLength: 1, maxLength: 120 },
  required: { type: 'boolean' }, prohibited: { type: 'boolean' },
  find: { type: 'array', minItems: 1, items: { type: 'string', minLength: 2 } },
  must_include: { type: 'array', items: { type: 'string', minLength: 1 } }, must_not_include: { type: 'array', items: { type: 'string', minLength: 1 } },
  value: { type: 'object', additionalProperties: false, required: ['pattern'], properties: { label: { type: 'string' }, pattern: { type: 'string', minLength: 1, maxLength: 200 }, unit: { type: 'string' }, min: { type: 'number' }, max: { type: 'number' } } },
  note: { type: 'string' }, fallback: { type: 'string' },
} };
export const PLAYBOOK_SCHEMA = { type: 'object', additionalProperties: false, required: ['source', 'clauses'], properties: {
  source: { type: 'string', minLength: 1, description: 'Whose playbook it is' },
  version: { type: 'string', minLength: 1, maxLength: 40, description: 'Playbook version, cited in every memo' },
  updated: { type: 'string', format: 'date' }, owner: { type: 'string' }, contract_type: { type: 'string' },
  ignore_terms: { type: 'array', items: { type: 'string' }, description: 'Capitalised words the defined-terms check should not report, such as names' },
  clauses: { type: 'array', minItems: 1, items: clause },
} };
function readPlaybook(path, ctx) {
  if (!ctx.exists(path)) throw new Error(`playbook not found: ${path}`);
  try { return ctx.readJson(path, 'playbook'); } catch (e) { if (e instanceof SyntaxError) throw new Error('playbook is not valid JSON'); throw e; }
}
function checkFile(path, pb, pbSha, ctx) {
  const f = ctx.path(path); if (!existsSync(f)) throw new Error(`contract not found: ${path}`);
  const { text, source } = readContractFile(f);
  return { text, r: checkContract(text, pb, { file: path, source, playbookSha256: pbSha }) };
}
const rel = (ctx, f) => relative(ctx.root, f).split('\\').join('/');
function loadAll(a, ctx) {
  if (!String(a.contract ?? '').trim()) throw new Error('contract is required');
  if (!String(a.playbook ?? '').trim()) throw new Error('playbook is required (your own clause checklist as JSON)');
  const cf = ctx.path(a.contract); if (!existsSync(cf)) throw new Error(`contract not found: ${a.contract}`);
  const pb = readPlaybook(a.playbook, ctx); const pbSha = ctx.hashFile(a.playbook);
  const cur = checkFile(a.contract, pb, pbSha, ctx);
  const prev = a.previous_contract ? checkFile(a.previous_contract, pb, pbSha, ctx) : null;
  return { r: cur.r, text: cur.text, compare: prev ? compareDrafts(prev.r, cur.r, prev.text, cur.text) : null };
}
const load = (a, ctx) => loadAll(a, ctx).r;
const loadText = (p, ctx) => readContractFile(ctx.path(p)).text;
const termLines = (r) => { const t = r.defined_terms; const L = [...t.undefined.map((x) => `- Used but not defined: "${x.term}" (line ${x.lines.join(', ')})`), ...t.unused.map((x) => `- Defined but not used: "${x.term}" (line ${x.line})`), ...t.duplicates.map((x) => `- Defined more than once: "${x.term}" (lines ${x.lines.join(', ')})`)]; return L.length ? L : ['- none found']; };
const line = (r) => `${r.gaps} gap(s) against ${r.playbook_source}: ${r.counts.missing || 0} missing, ${r.counts.prohibited_present || 0} prohibited present, ${r.counts.needs_attention || 0} need attention, ${r.counts.present || 0} present; ${r.document_findings.length} document finding(s); defined terms: ${r.defined_terms.undefined.length} used but not defined, ${r.defined_terms.unused.length} defined but unused. Playbook version ${r.playbook_version || 'not stated'}. Not legal advice.`;

export const manifest = defineManifest({
  name: 'solon-of-clauses',
  version: pkg.version,
  description: 'Checks a contract (.docx, .txt or .md) against your own clause playbook: which clauses are present, missing, prohibited or need attention (required words absent, forbidden words present, numbers outside your limits), each with section and line citations, plus open placeholders, broken cross-references, duplicate section numbers and defined terms (used but not defined, defined but unused). Compares two drafts clause by clause. Drafts an issues list for counsel using only your playbook\'s fallback language, citing the playbook version, with an optional redline against the previous memo. Sending is one human click after a named reviewer; signing is blocked. Not legal advice, not a substitute for a lawyer, and never reviews the other side\'s interests.',
  model: { provider: 'anthropic', id: 'claude-sonnet-4-5-20250929', note: 'Declared host-model pin. The tools are deterministic and call no model.' },
  caps: { maxSteps: 60, maxSpendUsd: 0 },
  tools: [
    {
      name: 'solon_check', kind: 'read',
      description: 'Check the contract (.docx, .txt or .md) against the playbook. Every clause gets a status with citations (section, line, quote) and the playbook\'s own note; plus document checks and defined terms (capitalised terms used but not defined, defined but unused, defined twice, with lines). For a .docx, lines are paragraph numbers, tracked changes are read as accepted and flagged, and comments are counted but not read. Text matching only; no interpretation and no network.',
      inputSchema: { type: 'object', required: ['contract', 'playbook'], properties: props },
      handler: async (a, ctx) => { const r = load(a, ctx); return { summary: line(r), ...r }; },
    },
    {
      name: 'solon_write_report', kind: 'report',
      description: 'Write clause-gaps.md and clause-gaps.csv (blank owner and status columns) into out_dir (default mythos-out/solon). With previous_contract, also draft-changes.md (clause status before and after) and contract.diff (a unified diff of the two texts). Returns output_sha256 of clause-gaps.md, which is written into the audit log.',
      inputSchema: { type: 'object', required: ['contract', 'playbook'], properties: { ...props, previous_contract: prevProp, out_dir: str } },
      handler: async (a, ctx) => {
        const { r, compare } = loadAll(a, ctx); const out = ctx.outDir(a.out_dir || 'mythos-out/solon');
        const L = [`# Clause check: ${r.file}`, '', DISCLAIMER, '', line(r), '', '| Status | Clause | Where | Issues |', '|---|---|---|---|', ...r.clauses.map((c) => `| ${c.status} | ${c.title} | ${c.citations.map((x) => `${x.section}, line ${x.line}`).join('; ')} | ${c.issues.join(' ').replace(/\|/g, '\\|')} |`), '', '## Document checks', '', ...(r.document_findings.length ? r.document_findings.map((d) => `- Line ${d.line} ${d.check}: ${d.detail}`) : ['- none']), '', '## Defined terms', '', `Playbook version: ${r.playbook_version || 'not stated'}.`, '', ...termLines(r), ''];
        const csv = toCsv(r.clauses.map((c) => ({ clause: c.id, title: c.title, status: c.status, where: c.citations.map((x) => `${x.section} L${x.line}`).join('; '), issues: c.issues.join(' '), owner: '', status_note: '' })), ['clause', 'title', 'status', 'where', 'issues', 'owner', 'status_note']);
        const md = safeMarkdown(L.join('\n')); const files = [ctx.writeFile(out, 'clause-gaps.md', md), ctx.writeFile(out, 'clause-gaps.csv', csv)];
        if (compare) {
          const prevText = loadText(a.previous_contract, ctx); const curText = loadText(a.contract, ctx);
          files.push(ctx.writeFile(out, 'draft-changes.md', compareMarkdown(compare)), ctx.writeFile(out, 'contract.diff', unifiedDiff(prevText, curText, { oldPath: `a/${a.previous_contract}`, newPath: `b/${a.contract}` })));
        }
        return { summary: `Report written. ${line(r)}${compare ? ` Against the previous draft: ${compare.counts.better || 0} better, ${compare.counts.worse || 0} worse, ${compare.counts.changed || 0} changed.` : ''}`, files, output_sha256: sha256(md) };
      },
    },
    {
      name: 'solon_compare_drafts', kind: 'read', title: 'Compare two contract drafts',
      description: 'Check two drafts of the same contract (.docx, .txt or .md) against the playbook and show, clause by clause, whether each status got better, worse or stayed the same (with the numbers before and after), which document and defined-term findings are new or resolved, and which sections changed. Text matching only; not legal advice.',
      inputSchema: { type: 'object', required: ['contract', 'previous_contract', 'playbook'], additionalProperties: false, properties: { ...props, previous_contract: prevProp } },
      handler: async (a, ctx) => { const { compare: c } = loadAll(a, ctx); return { summary: `${c.before_file} → ${c.after_file}: ${c.counts.better || 0} clause(s) better, ${c.counts.worse || 0} worse, ${c.counts.changed || 0} changed, ${c.counts.unchanged || 0} unchanged; gaps ${c.gaps_before} → ${c.gaps_after}; ${c.sections.changed.length} section(s) changed. Not legal advice.`, ...c }; },
    },
    {
      name: 'solon_draft_markup', kind: 'write',
      description: 'Write issues-for-counsel.md into out_dir: each gap with its citation, your playbook\'s position and its fallback language copied word for word (Solon writes no contract language of its own), defined-term problems, and the playbook version and file hash it was checked against; every section marked [COUNSEL REVIEW]. With previous_contract, adds a section on what changed since that draft. With previous_draft (an earlier issues list), also writes issues-for-counsel.diff, a redline of the memo. Returns draft_sha256. Nothing is sent. Needs a human yes unless opted in to Auto.',
      inputSchema: { type: 'object', required: ['contract', 'playbook'], properties: { ...props, previous_contract: prevProp, previous_draft: { ...str, description: 'An earlier issues-for-counsel.md, to redline the new memo against' }, out_dir: str } },
      handler: async (a, ctx) => {
        const { r, compare } = loadAll(a, ctx); const out = ctx.outDir(a.out_dir || 'mythos-out/solon');
        let old = null; if (a.previous_draft) { if (!ctx.exists(a.previous_draft)) throw new Error(`previous_draft not found: ${a.previous_draft}`); old = ctx.readText(a.previous_draft); }
        const text = safeMarkdown(issuesMemo(r, { compare }));
        const f = ctx.writeFile(out, 'issues-for-counsel.md', text); const files = [f]; let redline = null;
        if (old !== null) { const d = unifiedDiff(old, text, { oldPath: `a/${a.previous_draft}`, newPath: 'b/issues-for-counsel.md' }); files.push(ctx.writeFile(out, 'issues-for-counsel.diff', d)); redline = { added: (d.match(/^\+(?!\+\+)/gm) || []).length, removed: (d.match(/^-(?!--)/gm) || []).length }; }
        return { summary: `Issues list drafted for ${r.gaps} gap(s) and ${r.document_findings.length} document finding(s), marked [COUNSEL REVIEW], citing playbook version ${r.playbook_version || 'not stated'}.${redline ? ` Redline against the previous memo: ${redline.added} line(s) added, ${redline.removed} removed.` : ''} Nothing was sent. Not legal advice.`, draft: rel(ctx, f), draft_sha256: sha256(text), playbook_version: r.playbook_version, playbook_sha256: r.playbook_sha256, ...(redline ? { redline } : {}), files };
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
  configSchemas: { playbook: PLAYBOOK_SCHEMA },
  prompts: [{
    name: 'contract_playbook_review', title: 'Check a contract against your playbook',
    description: 'Walks through checking a contract draft against your own playbook, comparing drafts, drafting the issues list for counsel, and the one-click send after a named reviewer. Not legal advice.',
    arguments: [
      { name: 'contract', description: 'Contract under --root (.docx, .txt or .md)', required: true },
      { name: 'playbook', description: 'Your playbook JSON under --root', required: true },
      { name: 'previous_contract', description: 'An earlier draft to compare with (optional)', required: false },
    ],
    text: `Check {{contract}} against the playbook {{playbook}} with the Solon tools. Solon is not legal advice and does not replace a lawyer: say so to the person, and never tell anyone whether to sign.

1. Run solon-of-clauses validate-config playbook {{playbook}} if the playbook is new, or call solon_check and fix any "not a valid playbook" error it reports.
2. Call solon_check with contract {{contract}} and playbook {{playbook}}. List missing, prohibited_present and needs_attention clauses first, each with its section and line citation and the playbook's own note. Then the document checks and the defined-terms findings. Do not interpret clauses beyond what the findings say.
3. If there is an earlier draft ({{previous_contract}}), call solon_compare_drafts and say which clauses got better or worse.
4. Call solon_write_report for the gap report files.
5. Ask the person before calling solon_draft_markup (it needs their yes). It copies only the playbook's own fallback language and marks every section [COUNSEL REVIEW]. Pass previous_draft to get a redline of the memo.
6. A lawyer or authorised person reviews the memo and removes each [COUNSEL REVIEW] marker. Only then can solon_request_send record the send, with reviewed_by set to that reviewer: it is a binding send, so a named person approves it with one click, even in Auto. A person sends it; Solon never sends. Signing (e_sign) is always blocked.`,
  }],
  policy: { rules: [
    { tool: 'solon_check', decision: 'allow' },
    { tool: 'solon_write_report', decision: 'allow' },
    { tool: 'solon_compare_drafts', decision: 'allow' },
    { tool: 'solon_draft_markup', decision: 'ask', reason: 'Drafting an issues list needs a human yes (or an Auto opt-in).' },
    { tool: 'send_email', decision: 'block', reason: 'Solon never sends. A person does, after counsel review.' },
    { tool: 'e_sign', decision: 'block', reason: 'Solon never signs or accepts a contract.' },
    { tool: 'solon_request_send', decision: 'ask', reason: 'Sending contract language is one named human click, even in Auto.' },
    { tool: '*', decision: 'block', reason: 'Not on the Solon allowlist.' },
  ] },
});
