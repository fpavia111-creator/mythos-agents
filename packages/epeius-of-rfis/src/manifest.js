import { defineManifest, toCsv, sha256, toIcs, safeMarkdown, safeFileName } from 'mythos-agent-core';
import { readFileSync, existsSync, appendFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { reviewLog, rfiCsv, subCsv, logMarkdown, draftRfi, MARKERS, ballInCourt, bicCsv, bicMarkdown, diffLogs, diffMarkdown, dueEvents, parseTitleBlock, indexFromTitleBlocks, INDEX_COLUMNS, draftTransmittal, PURPOSES } from './rfis.js';
import { prompts } from './prompts.js';
import { SOURCES } from './sources.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const str = { type: 'string' }; const num = { type: 'number' };
const logProps = {
  documents: { ...str, description: 'Drawing and spec index CSV/JSON: doc_id (A-201, 08 71 00), type (drawing|spec), title, revision, issued, status (current|superseded), file (optional text extract, relative to --root)' },
  rfis: { ...str, description: 'RFI log CSV/JSON: rfi_no, subject, question, references (; separated), status, sent_date, due_date, answered_date, ball_in_court, cost_impact, schedule_impact' },
  submittals: { ...str, description: 'Optional submittal log CSV/JSON: submittal_no, spec_section, description, status, required_by, submitted_date, returned_date, revision' },
  as_of: str, review_days: { ...num, description: 'Review period for submittals (default 14 days)' },
};
const date = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' };
const rel = (ctx, f) => relative(ctx.root, f).split('\\').join('/');
const filesHash = (files) => sha256(files.map((f) => `${f.split(/[\\/]/).pop()}:${sha256(readFileSync(f))}`).join('\n'));
function diffFor(a, ctx) {
  if (!String(a.rfis ?? '').trim()) throw new Error('rfis is required to compare with previous_rfis');
  return diffLogs(ctx.records(a.previous_rfis), ctx.records(a.rfis), a);
}
function nextTransmittalNo(dir) {
  const n = existsSync(dir) ? readdirSync(dir).map((f) => /^TR-(\d+)\.md$/.exec(f)).filter(Boolean).map((m) => Number(m[1])) : [];
  return `TR-${String(Math.max(0, ...n) + 1).padStart(3, '0')}`;
}
const run = (a, ctx) => {
  if (!String(a.documents ?? '').trim()) throw new Error('documents is required');
  return reviewLog(ctx.records(a.documents), a.rfis ? ctx.records(a.rfis) : [], a.submittals ? ctx.records(a.submittals) : [], a);
};
function appendRow(dir, file, row, cols) {
  const f = join(dir, file); const csv = toCsv([row], cols);
  appendFileSync(f, existsSync(f) ? csv.split('\n').slice(1).join('\n') : csv); return f;
}

export const manifest = defineManifest({
  sources: SOURCES,
  name: 'epeius-of-rfis',
  version: pkg.version,
  description: 'Reviews a construction RFI and submittal log against your drawing and spec index: overdue RFIs and submittals, reviews past their period, resubmittals pending, references that are missing, not in the index or on a superseded revision, unstated cost or schedule impact and possible duplicate questions. Shows ball-in-court aging with a chase list, compares log exports week over week, builds a drawing index from title-block text and writes a calendar of due dates. Drafts RFIs from your question and document transmittals that cite only the documents and text extracts you provide, with open items marked. Sending to the architect or GC is one human click. Not design or engineering advice.',
  model: { provider: 'anthropic', id: 'claude-sonnet-4-5-20250929', note: 'Declared host-model pin. The tools are deterministic and call no model.' },
  caps: { maxSteps: 60, maxSpendUsd: 0 },
  tools: [
    {
      name: 'epeius_review_log', kind: 'read', title: 'Review the RFI and submittal log',
      description: 'Flags per RFI (overdue, no_due_date, missing_references, unknown_reference, superseded_reference, unknown_revision, impact_unstated, possible_duplicate) and per submittal (overdue_submission, review_overdue, resubmit_pending, unknown_spec_section).',
      inputSchema: { type: 'object', required: ['documents'], properties: logProps },
      handler: async (a, ctx) => { const r = run(a, ctx); return { summary: `${r.rfis} RFI(s), ${r.open} open, ${r.overdue} overdue; ${r.superseded_reference} on a superseded revision, ${r.unknown_reference} citing a document not in the index, ${r.possible_duplicate} possible duplicate(s). ${r.submittals} submittal(s), ${r.submittal_issues} with issues.`, ...r }; },
    },
    {
      name: 'epeius_write_log_report', kind: 'report', title: 'Write the RFI and submittal log review',
      description: 'Write rfi-log-review.md (with ball-in-court aging and a chase list), rfi-log.csv and submittal-log.csv (blank next_action and owner columns), ball-in-court.csv and rfi-due-dates.ics (open RFI response dates and unsent submittals) into out_dir (default mythos-out/epeius). With previous_rfis (an earlier export of the log) it also writes rfi-log-diff.md. The output hash goes into the audit line.',
      inputSchema: { type: 'object', required: ['documents'], properties: { ...logProps, previous_rfis: { ...str, description: 'Optional earlier export of the RFI log (CSV/JSON) to compare with' }, previous_as_of: { ...date, description: 'Date of the earlier export (default as_of minus 7 days)' }, out_dir: str } },
      handler: async (a, ctx) => {
        const r = run(a, ctx); const b = ballInCourt(r); const out = ctx.outDir(a.out_dir || 'mythos-out/epeius');
        const files = [ctx.writeFile(out, 'rfi-log-review.md', logMarkdown(r) + '\n' + bicMarkdown(b)), ctx.writeFile(out, 'rfi-log.csv', rfiCsv(r)), ctx.writeFile(out, 'submittal-log.csv', subCsv(r)), ctx.writeFile(out, 'ball-in-court.csv', bicCsv(b)), ctx.writeFile(out, 'rfi-due-dates.ics', toIcs(dueEvents(r), { prodId: '-//Mythos Machine//epeius-of-rfis//EN', calName: 'RFI and submittal dates', stamp: `${r.as_of.replace(/-/g, '')}T000000Z` }))];
        let d = null; if (a.previous_rfis) { d = diffFor(a, ctx); files.push(ctx.writeFile(out, 'rfi-log-diff.md', diffMarkdown(d))); }
        return { summary: `Log review written: ${r.rfis} RFI(s), ${r.submittals} submittal(s), ${b.open_items} open item(s) across ${b.parties.length} part${b.parties.length === 1 ? 'y' : 'ies'}${d ? `; ${d.changes} change(s) since ${d.previous_as_of}` : ''}.`, files, output_sha256: filesHash(files) };
      },
    },
    {
      name: 'epeius_ball_in_court', kind: 'read', title: 'Ball-in-court aging and chase list',
      description: 'Who holds each open RFI and submittal and for how long: counts per party in 0-7, 8-14, 15-30 and 31+ day buckets, overdue counts, the oldest item, and a chase list ordered by days overdue then age, each with a one-line reason. Submittals use a ball_in_court column when present (otherwise the reviewer while submitted, the contractor while unsent or returned).',
      inputSchema: { type: 'object', required: ['documents'], properties: logProps },
      handler: async (a, ctx) => { const b = ballInCourt(run(a, ctx)); const top = b.chase_list[0]; return { summary: `${b.open_items} open item(s) across ${b.parties.length} part${b.parties.length === 1 ? 'y' : 'ies'}; ${b.chase_list.filter((c) => c.overdue).length} overdue.${top ? ` First to chase: ${top.reason}` : ''}`, ...b }; },
    },
    {
      name: 'epeius_diff_logs', kind: 'read', title: 'Compare two RFI log exports',
      description: 'Compare an earlier export of the RFI log with the current one (keyed by RFI number): new RFIs, closed or reopened ones, status, due-date and ball-in-court changes, RFIs that became overdue since the earlier export, and RFIs no longer in the log. For the weekly meeting.',
      inputSchema: { type: 'object', required: ['previous_rfis', 'rfis'], properties: { previous_rfis: { ...str, description: 'Earlier export of the RFI log (CSV/JSON)' }, rfis: logProps.rfis, as_of: date, previous_as_of: { ...date, description: 'Date of the earlier export (default as_of minus 7 days)' } } },
      handler: async (a, ctx) => { const d = diffFor(a, ctx); return { summary: `${d.changes} change(s) from ${d.previous_as_of} to ${d.as_of}: ${d.added.length} new, ${d.closed.length} closed, ${d.newly_overdue.length} became overdue, ${d.due_changed.length} due date(s) moved.`, ...d }; },
    },
    {
      name: 'epeius_index_title_blocks', kind: 'report', title: 'Build a drawing index from title-block text',
      description: 'Read sheet number, title, revision table and issue date from title-block text files (one per sheet, for example PDF text exports) in folder, compare them with the document index if given, and write documents.from-title-blocks.csv (proposed index, earlier revisions marked superseded) and title-block-index.md into out_dir. Flags new sheets, an index behind the title block, stale prints, title or revision conflicts and unreadable files. Your index is not changed.',
      inputSchema: { type: 'object', required: ['folder'], properties: { folder: { ...str, description: 'Folder of .txt title-block extracts, relative to --root' }, documents: { ...logProps.documents, description: 'Optional current document index to compare with' }, out_dir: str } },
      handler: async (a, ctx) => {
        const dir = ctx.path(a.folder); if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`folder not found: ${a.folder}`);
        const files = readdirSync(dir).filter((f) => /\.txt$/i.test(f)).sort(); if (!files.length) throw new Error(`no .txt title-block files in ${a.folder}`);
        const parsed = files.map((f) => parseTitleBlock(readFileSync(join(dir, f), 'utf8'), `${String(a.folder).replace(/\/+$/, '')}/${f}`));
        const r = indexFromTitleBlocks(parsed, a.documents ? ctx.records(a.documents) : []);
        const out = ctx.outDir(a.out_dir || 'mythos-out/epeius');
        const md = ['# Drawing index from title blocks', '', `${r.sheets_read} file(s) read; ${r.new_sheet} new sheet(s), ${r.index_behind} where the index is behind the title block, ${r.unreadable} unreadable.`, '', '> Read from the title-block text you provided. Check the proposed index against the drawings before you replace your index.', '', '## Sheets', '', '| File | Sheet | Rev | Issued | Title |', '|---|---|---|---|---|', ...parsed.map((p) => `| ${p.file} | ${p.doc_id || '?'} | ${p.revision || '?'} | ${p.issued || ''} | ${p.title || ''} |`), '', '## Findings', '', ...(r.findings.length ? r.findings.map((f) => `- **${f.check}** ${f.doc_id || f.file}: ${f.detail}`) : ['- none']), ''].join('\n');
        const fs = [ctx.writeFile(out, 'documents.from-title-blocks.csv', toCsv(r.rows, INDEX_COLUMNS)), ctx.writeFile(out, 'title-block-index.md', md)];
        return { summary: `${r.sheets_read} title block(s) read: ${r.new_sheet} new sheet(s), ${r.index_behind} newer than the index, ${r.unreadable} unreadable. Proposed index written; your index was not changed.`, sheets: parsed.map(({ file, doc_id, type, title, revision, issued, problems }) => ({ file, doc_id, type, title, revision, issued, problems })), ...r, files: fs, output_sha256: filesHash(fs) };
      },
    },
    {
      name: 'epeius_draft_rfi', kind: 'write', title: 'Draft an RFI',
      description: 'Write drafts/RFI-<no>.md (marked DRAFT, not sent) from your subject and question. References are resolved against the index; lines from text extracts that mention your search terms are quoted with file and line. Missing or superseded references, uncited terms and unstated impacts are marked [MISSING REFERENCE], [CHECK REVISION], [NO CITATION], [TO CONFIRM]. Needs a human yes unless opted in to Auto.',
      inputSchema: { type: 'object', required: ['documents', 'subject', 'question'], properties: { documents: logProps.documents, rfis: logProps.rfis, subject: str, question: str, references: { type: 'array', items: str }, search: { type: 'array', items: str, description: 'Terms to quote from text extracts, e.g. ["D3", "HW-4"]' }, rfi_no: str, project: str, to: str, from: str, needed_by: str, cost_impact: str, schedule_impact: str, suggested_solution: str, out_dir: str } },
      handler: async (a, ctx) => {
        if (!String(a.documents ?? '').trim()) throw new Error('documents is required');
        const d = draftRfi(a, ctx.records(a.documents), a.rfis ? ctx.records(a.rfis) : [], ctx.root);
        const dir = join(ctx.outDir(a.out_dir || 'mythos-out/epeius'), 'drafts'); mkdirSync(dir, { recursive: true });
        const f = ctx.writeFile(dir, `RFI-${safeFileName(d.rfi_no)}.md`, d.text);
        return { summary: `RFI ${d.rfi_no} drafted with ${d.open_markers} open marker(s)${d.markers.length ? ` (${d.markers.join(', ')})` : ''}. Nothing was sent.`, draft: relative(ctx.root, f).split('\\').join('/'), draft_sha256: sha256(safeMarkdown(d.text)), rfi_no: d.rfi_no, open_markers: d.open_markers, markers: d.markers, file: f };
      },
    },
    {
      name: 'epeius_draft_transmittal', kind: 'write', title: 'Draft a document transmittal',
      description: 'Write drafts/TR-<no>.md (marked DRAFT, not sent) listing the drawings and specs you name. Only documents in the index are listed, each on its current revision with its issue date and the hash of its text extract; anything not in the index is [MISSING REFERENCE], an old revision is [CHECK REVISION], missing header fields are [TO CONFIRM]. Sending goes through epeius_request_send (one click). Needs a human yes unless opted in to Auto.',
      inputSchema: { type: 'object', required: ['documents', 'items', 'subject'], properties: { documents: logProps.documents, items: { type: 'array', items: str, minItems: 1, description: 'References to transmit, e.g. ["A-201", "A-501", "08 71 00"]' }, subject: str, purpose: { type: 'string', enum: PURPOSES }, project: str, to: str, from: str, date, action_by: date, copies: { type: 'integer', minimum: 1 }, remarks: str, transmittal_no: { type: 'string', pattern: '^TR-[0-9]{1,5}$' }, out_dir: str } },
      handler: async (a, ctx) => {
        const dir = join(ctx.outDir(a.out_dir || 'mythos-out/epeius'), 'drafts'); mkdirSync(dir, { recursive: true });
        const d = draftTransmittal({ ...a, transmittal_no: a.transmittal_no || nextTransmittalNo(dir) }, ctx.records(a.documents), ctx.root, sha256);
        const f = ctx.writeFile(dir, `${safeFileName(d.transmittal_no)}.md`, d.text);
        return { summary: `Transmittal ${d.transmittal_no} drafted with ${d.documents.length} indexed document(s) and ${d.open_markers} open marker(s)${d.markers.length ? ` (${d.markers.join(', ')})` : ''}. Nothing was sent.`, draft: rel(ctx, f), draft_sha256: sha256(safeMarkdown(d.text)), transmittal_no: d.transmittal_no, documents: d.documents, open_markers: d.open_markers, markers: d.markers, file: f };
      },
    },
    {
      name: 'epeius_request_send', kind: 'action', category: 'binding_send', title: 'Approve an RFI or transmittal to send (one click)',
      description: 'After one named human click (even in Auto), record that the reviewed RFI or transmittal draft is approved to send in send-requests.csv (the rfi_no column holds the RFI or TR number). Tied to draft_sha256. Refuses while open markers remain unless accept_open_issues is true with a note. A person sends it; Epeius never sends.',
      inputSchema: { type: 'object', required: ['draft', 'draft_sha256', 'to'], properties: { draft: str, draft_sha256: str, to: str, accept_open_issues: { type: 'boolean' }, note: str, out_dir: str } },
      handler: async (a, ctx) => {
        if (!String(a.to ?? '').trim()) throw new Error('to is required');
        const f = ctx.path(a.draft); if (!existsSync(f)) throw new Error(`draft not found: ${a.draft}`);
        const text = readFileSync(f, 'utf8'); if (sha256(text) !== a.draft_sha256) throw new Error('draft_sha256 does not match the draft; review the current draft and ask again');
        const open = text.match(MARKERS) || [];
        if (open.length && !(a.accept_open_issues === true && String(a.note ?? '').trim())) throw new Error(`${open.length} open marker(s) in the draft (${[...new Set(open)].slice(0, 4).join(' ')}); resolve them or pass accept_open_issues with a note`);
        const to = ((/^To: (.*)$/m.exec(text) || [])[1] || '').trim();
        if (to && !/^\[TO CONFIRM/.test(to) && to !== String(a.to).trim()) throw new Error(`to ("${a.to}") differs from the draft's To line ("${to}")`);
        const hd = /^(RFI|Transmittal) (\S+):/m.exec(text) || []; const no = hd[2] || ''; const label = hd[1] || 'RFI';
        const file = appendRow(ctx.outDir(a.out_dir || 'mythos-out/epeius'), 'send-requests.csv', { approved_at: new Date().toISOString(), rfi_no: no, to: a.to, draft: a.draft, draft_sha256: a.draft_sha256, open_markers: open.length, note: a.note || '', status: 'approved - a person sends it' }, ['approved_at', 'rfi_no', 'to', 'draft', 'draft_sha256', 'open_markers', 'note', 'status']);
        return { summary: `${label} ${no} approved to send to ${a.to} and recorded${open.length ? ` with ${open.length} open marker(s) accepted` : ''}. Nothing was sent.`, file };
      },
    },
    { name: 'send_email', kind: 'action', category: 'binding_send', description: 'Listed so agents can see it is refused. Epeius never sends email.', inputSchema: { type: 'object', properties: {} } },
    { name: 'project_portal_submit', kind: 'action', category: 'binding_send', description: 'Listed so agents can see it is refused. Epeius never submits to Procore, ACC or any project portal.', inputSchema: { type: 'object', properties: {} } },
  ],
  prompts,
  policy: { rules: [
    { tool: 'epeius_review_log', decision: 'allow' },
    { tool: 'epeius_write_log_report', decision: 'allow' },
    { tool: 'epeius_ball_in_court', decision: 'allow' },
    { tool: 'epeius_diff_logs', decision: 'allow' },
    { tool: 'epeius_index_title_blocks', decision: 'allow' },
    { tool: 'epeius_draft_rfi', decision: 'ask', reason: 'Writing an RFI draft needs a human yes (or an Auto opt-in).' },
    { tool: 'epeius_draft_transmittal', decision: 'ask', reason: 'Writing a transmittal draft needs a human yes (or an Auto opt-in).' },
    { tool: 'send_email', decision: 'block', reason: 'Epeius never sends. A person sends the RFI.' },
    { tool: 'project_portal_submit', decision: 'block', reason: 'Epeius never submits to a project portal.' },
    { tool: 'epeius_request_send', decision: 'ask', reason: 'An RFI to the architect or GC is a binding send: one named human click, even in Auto.' },
    { tool: '*', decision: 'block', reason: 'Not on the Epeius allowlist.' },
  ] },
});
