import { defineManifest, toCsv, sha256 } from 'mythos-agent-core';
import { readFileSync, readdirSync, statSync, existsSync, appendFileSync } from 'node:fs';
import { join, extname, relative } from 'node:path';
import { mapData, findSubject, checklist, checklistCsv, requestMarkdown, dueDate, maskEmail } from './erasure.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const str = { type: 'string' };
const src = { dir: { ...str, description: 'Folder of exports (CSV/JSON/JSONL), not recursive' }, files: { type: 'array', items: { type: 'string' } } };
const subj = { email: str, phone: str, ids: { type: 'array', items: { type: 'string' } } };
const req = { received: { ...str, description: 'Date the request was received (YYYY-MM-DD)' }, regime: { type: 'string', enum: ['gdpr', 'uk_gdpr', 'ccpa', 'cpra', 'other'] } };
function load(a, ctx) {
  let list = a.files || [];
  if (a.dir) { const d = ctx.path(a.dir); list = list.concat(readdirSync(d).filter((f) => ['.csv', '.json', '.jsonl'].includes(extname(f).toLowerCase()) && statSync(join(d, f)).isFile()).sort().map((f) => join(a.dir, f))); }
  if (!list.length) throw new Error('give "dir" or "files"');
  return list.map((f) => ({ name: f, rows: ctx.records(f) }));
}
function append(ctx, a, file, row, cols) {
  const out = ctx.outDir(a.out_dir || 'mythos-out/macaria'); const f = join(out, file);
  const csv = toCsv([row], cols); appendFileSync(f, existsSync(f) ? csv.split('\n').slice(1).join('\n') : csv); return f;
}
const subjectKey = (a) => sha256([String(a.email || '').trim().toLowerCase(), String(a.phone || '').replace(/\D/g, '').slice(-10), ...[].concat(a.ids || [])].join('|')).slice(0, 16);

export const manifest = defineManifest({
  name: 'macaria-of-erasure',
  version: pkg.version,
  description: 'Data-subject erasure (deletion) request workflow over your exports: maps which files and columns hold personal data, finds the subject\'s rows, flags records you may have to keep, and builds a checklist with owners. Deleting personal data is always one human click and only records a request; Macaria never deletes anything.',
  model: { provider: 'anthropic', id: 'claude-sonnet-4-5-20250929', note: 'Declared host-model pin. The tools are deterministic and call no model.' },
  caps: { maxSteps: 60, maxSpendUsd: 0 },
  tools: [
    {
      name: 'macaria_map_data', kind: 'read',
      description: 'Inventory: which columns in each export look like personal data (email, phone, name, address, birth date, IP, government id, payment, customer id) and which files look like records you may have to retain.',
      inputSchema: { type: 'object', properties: src },
      handler: async (a, ctx) => { const m = mapData(load(a, ctx)); return { summary: `${m.length} file(s); ${m.filter((f) => f.personal_data_columns.length).length} hold personal data; ${m.filter((f) => f.retention_flag).length} flagged for retention check.`, files: m }; },
    },
    {
      name: 'macaria_find_subject', kind: 'read',
      description: 'Find the data subject\'s rows across the exports by email, phone or id. Identifiers are masked in the output.',
      inputSchema: { type: 'object', properties: { ...src, ...subj } },
      handler: async (a, ctx) => { const r = findSubject(load(a, ctx), a); return { summary: `Found ${r.rows_found} row(s) in ${r.files_with_data} of ${r.files_scanned} file(s).`, ...r }; },
    },
    {
      name: 'macaria_build_checklist', kind: 'report',
      description: 'Write erasure-checklist.csv (owner and evidence columns blank) and erasure-request.md (identifiers masked) into out_dir (default mythos-out/macaria).',
      inputSchema: { type: 'object', properties: { ...src, ...subj, ...req, out_dir: str } },
      handler: async (a, ctx) => {
        const r = findSubject(load(a, ctx), a); const steps = checklist(r, a); const out = ctx.outDir(a.out_dir || 'mythos-out/macaria');
        return { summary: `Checklist written: ${steps.length} step(s) across ${r.files_with_data} file(s).`, files: [ctx.writeFile(out, 'erasure-checklist.csv', checklistCsv(steps)), ctx.writeFile(out, 'erasure-request.md', requestMarkdown(r, a, new Date().toISOString()))], due: dueDate(a.received, a.regime) };
      },
    },
    {
      name: 'macaria_log_request', kind: 'write',
      description: 'Add the request to requests.csv (masked identifier, a hash key, received date, target date). Needs a human yes unless opted in to Auto.',
      inputSchema: { type: 'object', required: ['received'], properties: { ...subj, ...req, out_dir: str } },
      handler: async (a, ctx) => {
        if (!a.email && !a.phone && !(a.ids || []).length) throw new Error('give at least one identifier');
        const key = subjectKey(a);
        return { summary: `Request ${key} logged${dueDate(a.received, a.regime) ? `, target ${dueDate(a.received, a.regime)}` : ''}.`, request_key: key, file: append(ctx, a, 'requests.csv', { logged_at: new Date().toISOString(), request_key: key, subject: a.email ? maskEmail(a.email) : 'phone/id only', received: a.received, regime: a.regime || '', target_date: dueDate(a.received, a.regime) || '', status: 'open' }, ['logged_at', 'request_key', 'subject', 'received', 'regime', 'target_date', 'status']) };
      },
    },
    {
      name: 'macaria_request_deletion', kind: 'action', category: 'delete_personal_data',
      description: 'After one named human click (even in Auto), record an approved deletion for one system or file in deletion-requests.csv for its owner. Macaria never deletes data.',
      inputSchema: { type: 'object', required: ['system', 'reason'], properties: { system: str, rows: str, reason: str, ...subj, out_dir: str } },
      handler: async (a, ctx) => {
        for (const k of ['system', 'reason']) if (!String(a[k] || '').trim()) throw new Error(`${k} is required`);
        return { summary: `Deletion request recorded for ${a.system}. Nothing was deleted; the system owner acts on it.`, file: append(ctx, a, 'deletion-requests.csv', { requested_at: new Date().toISOString(), request_key: subjectKey(a), system: a.system, rows: a.rows || '', reason: a.reason, status: 'approved request - owner deletes in the source system' }, ['requested_at', 'request_key', 'system', 'rows', 'reason', 'status']) };
      },
    },
    { name: 'macaria_delete_records', kind: 'action', category: 'delete_personal_data', description: 'Listed so agents can see it is refused. Macaria never deletes or edits any data.', inputSchema: { type: 'object', properties: {} } },
  ],
  policy: { rules: [
    { tool: 'macaria_map_data', decision: 'allow' },
    { tool: 'macaria_find_subject', decision: 'allow' },
    { tool: 'macaria_build_checklist', decision: 'allow' },
    { tool: 'macaria_log_request', decision: 'ask', reason: 'Logging a request needs a human yes (or an Auto opt-in).' },
    { tool: 'macaria_delete_records', decision: 'block', reason: 'Macaria never deletes data.' },
    { tool: 'macaria_request_deletion', decision: 'ask', reason: 'Deleting personal data is one named human click, even in Auto.' },
    { tool: '*', decision: 'block', reason: 'Not on the Macaria allowlist.' },
  ] },
});
