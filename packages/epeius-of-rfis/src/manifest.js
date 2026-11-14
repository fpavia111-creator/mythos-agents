import { defineManifest, toCsv, sha256 } from 'mythos-agent-core';
import { readFileSync, existsSync, appendFileSync, mkdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { reviewLog, rfiCsv, subCsv, logMarkdown, draftRfi, MARKERS } from './rfis.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const str = { type: 'string' }; const num = { type: 'number' };
const logProps = {
  documents: { ...str, description: 'Drawing and spec index CSV/JSON: doc_id (A-201, 08 71 00), type (drawing|spec), title, revision, issued, status (current|superseded), file (optional text extract, relative to --root)' },
  rfis: { ...str, description: 'RFI log CSV/JSON: rfi_no, subject, question, references (; separated), status, sent_date, due_date, answered_date, ball_in_court, cost_impact, schedule_impact' },
  submittals: { ...str, description: 'Optional submittal log CSV/JSON: submittal_no, spec_section, description, status, required_by, submitted_date, returned_date, revision' },
  as_of: str, review_days: { ...num, description: 'Review period for submittals (default 14 days)' },
};
const run = (a, ctx) => {
  if (!String(a.documents ?? '').trim()) throw new Error('documents is required');
  return reviewLog(ctx.records(a.documents), a.rfis ? ctx.records(a.rfis) : [], a.submittals ? ctx.records(a.submittals) : [], a);
};
function appendRow(dir, file, row, cols) {
  const f = join(dir, file); const csv = toCsv([row], cols);
  appendFileSync(f, existsSync(f) ? csv.split('\n').slice(1).join('\n') : csv); return f;
}

export const manifest = defineManifest({
  name: 'epeius-of-rfis',
  version: pkg.version,
  description: 'Reviews a construction RFI and submittal log against your drawing and spec index: overdue RFIs and submittals, reviews past their period, resubmittals pending, references that are missing, not in the index or on a superseded revision, unstated cost or schedule impact and possible duplicate questions. Drafts RFIs from your question that cite only the documents and text extracts you provide, with open items marked. Sending to the architect or GC is one human click. Not design or engineering advice.',
  model: { provider: 'anthropic', id: 'claude-sonnet-4-5-20250929', note: 'Declared host-model pin. The tools are deterministic and call no model.' },
  caps: { maxSteps: 60, maxSpendUsd: 0 },
  tools: [
    {
      name: 'epeius_review_log', kind: 'read',
      description: 'Flags per RFI (overdue, no_due_date, missing_references, unknown_reference, superseded_reference, unknown_revision, impact_unstated, possible_duplicate) and per submittal (overdue_submission, review_overdue, resubmit_pending, unknown_spec_section).',
      inputSchema: { type: 'object', required: ['documents'], properties: logProps },
      handler: async (a, ctx) => { const r = run(a, ctx); return { summary: `${r.rfis} RFI(s), ${r.open} open, ${r.overdue} overdue; ${r.superseded_reference} on a superseded revision, ${r.unknown_reference} citing a document not in the index, ${r.possible_duplicate} possible duplicate(s). ${r.submittals} submittal(s), ${r.submittal_issues} with issues.`, ...r }; },
    },
    {
      name: 'epeius_write_log_report', kind: 'report',
      description: 'Write rfi-log-review.md, rfi-log.csv and submittal-log.csv (blank next_action and owner columns) into out_dir (default mythos-out/epeius).',
      inputSchema: { type: 'object', required: ['documents'], properties: { ...logProps, out_dir: str } },
      handler: async (a, ctx) => { const r = run(a, ctx); const out = ctx.outDir(a.out_dir || 'mythos-out/epeius'); return { summary: `Log review written: ${r.rfis} RFI(s), ${r.submittals} submittal(s).`, files: [ctx.writeFile(out, 'rfi-log-review.md', logMarkdown(r)), ctx.writeFile(out, 'rfi-log.csv', rfiCsv(r)), ctx.writeFile(out, 'submittal-log.csv', subCsv(r))] }; },
    },
    {
      name: 'epeius_draft_rfi', kind: 'write',
      description: 'Write drafts/RFI-<no>.md (marked DRAFT, not sent) from your subject and question. References are resolved against the index; lines from text extracts that mention your search terms are quoted with file and line. Missing or superseded references, uncited terms and unstated impacts are marked [MISSING REFERENCE], [CHECK REVISION], [NO CITATION], [TO CONFIRM]. Needs a human yes unless opted in to Auto.',
      inputSchema: { type: 'object', required: ['documents', 'subject', 'question'], properties: { documents: logProps.documents, rfis: logProps.rfis, subject: str, question: str, references: { type: 'array', items: str }, search: { type: 'array', items: str, description: 'Terms to quote from text extracts, e.g. ["D3", "HW-4"]' }, rfi_no: str, project: str, to: str, from: str, needed_by: str, cost_impact: str, schedule_impact: str, suggested_solution: str, out_dir: str } },
      handler: async (a, ctx) => {
        if (!String(a.documents ?? '').trim()) throw new Error('documents is required');
        const d = draftRfi(a, ctx.records(a.documents), a.rfis ? ctx.records(a.rfis) : [], ctx.root);
        const dir = join(ctx.outDir(a.out_dir || 'mythos-out/epeius'), 'drafts'); mkdirSync(dir, { recursive: true });
        const f = ctx.writeFile(dir, `RFI-${d.rfi_no}.md`, d.text);
        return { summary: `RFI ${d.rfi_no} drafted with ${d.open_markers} open marker(s)${d.markers.length ? ` (${d.markers.join(', ')})` : ''}. Nothing was sent.`, draft: relative(ctx.root, f).split('\\').join('/'), draft_sha256: sha256(d.text), rfi_no: d.rfi_no, open_markers: d.open_markers, markers: d.markers, file: f };
      },
    },
    {
      name: 'epeius_request_send', kind: 'action', category: 'binding_send',
      description: 'After one named human click (even in Auto), record that the reviewed RFI draft is approved to send in send-requests.csv. Tied to draft_sha256. Refuses while open markers remain unless accept_open_issues is true with a note. A person sends it; Epeius never sends.',
      inputSchema: { type: 'object', required: ['draft', 'draft_sha256', 'to'], properties: { draft: str, draft_sha256: str, to: str, accept_open_issues: { type: 'boolean' }, note: str, out_dir: str } },
      handler: async (a, ctx) => {
        if (!String(a.to ?? '').trim()) throw new Error('to is required');
        const f = ctx.path(a.draft); if (!existsSync(f)) throw new Error(`draft not found: ${a.draft}`);
        const text = readFileSync(f, 'utf8'); if (sha256(text) !== a.draft_sha256) throw new Error('draft_sha256 does not match the draft; review the current draft and ask again');
        const open = text.match(MARKERS) || [];
        if (open.length && !(a.accept_open_issues === true && String(a.note ?? '').trim())) throw new Error(`${open.length} open marker(s) in the draft (${[...new Set(open)].slice(0, 4).join(' ')}); resolve them or pass accept_open_issues with a note`);
        const to = ((/^To: (.*)$/m.exec(text) || [])[1] || '').trim();
        if (to && !/^\[TO CONFIRM/.test(to) && to !== String(a.to).trim()) throw new Error(`to ("${a.to}") differs from the draft's To line ("${to}")`);
        const no = (/^RFI (\S+):/m.exec(text) || [])[1] || '';
        const file = appendRow(ctx.outDir(a.out_dir || 'mythos-out/epeius'), 'send-requests.csv', { approved_at: new Date().toISOString(), rfi_no: no, to: a.to, draft: a.draft, draft_sha256: a.draft_sha256, open_markers: open.length, note: a.note || '', status: 'approved - a person sends it' }, ['approved_at', 'rfi_no', 'to', 'draft', 'draft_sha256', 'open_markers', 'note', 'status']);
        return { summary: `RFI ${no} approved to send to ${a.to} and recorded${open.length ? ` with ${open.length} open marker(s) accepted` : ''}. Nothing was sent.`, file };
      },
    },
    { name: 'send_email', kind: 'action', category: 'binding_send', description: 'Listed so agents can see it is refused. Epeius never sends email.', inputSchema: { type: 'object', properties: {} } },
    { name: 'project_portal_submit', kind: 'action', category: 'binding_send', description: 'Listed so agents can see it is refused. Epeius never submits to Procore, ACC or any project portal.', inputSchema: { type: 'object', properties: {} } },
  ],
  policy: { rules: [
    { tool: 'epeius_review_log', decision: 'allow' },
    { tool: 'epeius_write_log_report', decision: 'allow' },
    { tool: 'epeius_draft_rfi', decision: 'ask', reason: 'Writing an RFI draft needs a human yes (or an Auto opt-in).' },
    { tool: 'send_email', decision: 'block', reason: 'Epeius never sends. A person sends the RFI.' },
    { tool: 'project_portal_submit', decision: 'block', reason: 'Epeius never submits to a project portal.' },
    { tool: 'epeius_request_send', decision: 'ask', reason: 'An RFI to the architect or GC is a binding send: one named human click, even in Auto.' },
    { tool: '*', decision: 'block', reason: 'Not on the Epeius allowlist.' },
  ] },
});
