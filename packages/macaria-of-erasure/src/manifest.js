import { defineManifest, toCsv, sha256, safeFileName } from 'mythos-agent-core';
import { readFileSync, readdirSync, statSync, existsSync, appendFileSync } from 'node:fs';
import { join, posix, extname, relative } from 'node:path';
import { mapData, findSubject, checklist, checklistCsv, requestMarkdown, dueDate, maskEmail } from './erasure.js';
import { RETENTION_RULES_SCHEMA, applyRetention, trackDeadlines, deadlinesCsv, deadlinesIcs } from './retention.js';
import { evidencePack, evidenceHtml } from './evidence.js';
import { PROMPTS } from './prompts.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const str = { type: 'string' };
const src = { dir: { ...str, description: 'Folder of exports (CSV/JSON/JSONL), not recursive' }, files: { type: 'array', items: { type: 'string' } } };
const subj = { email: str, phone: str, ids: { type: 'array', items: { type: 'string' } } };
const req = { received: { ...str, description: 'Date the request was received (YYYY-MM-DD)' }, regime: { type: 'string', enum: ['gdpr', 'uk_gdpr', 'ccpa', 'cpra', 'other'] } };
const rulesArg = { rules: { ...str, description: 'Your retention rules JSON (retention_rules, legal_holds, response_periods); validated against the retention_rules schema' } };
const asOf = { as_of: { ...str, format: 'date', description: 'Date to evaluate against (YYYY-MM-DD, default today)' } };
const loadRules = (a, ctx) => (a.rules ? ctx.readJson(a.rules, 'retention_rules') : null);
const today = () => new Date().toISOString().slice(0, 10);
const logPath = (a) => a.log || join(a.out_dir || 'mythos-out/macaria', 'requests.csv');
function load(a, ctx) {
  let list = a.files || [];
  if (a.dir) { const d = ctx.path(a.dir); list = list.concat(readdirSync(d).filter((f) => ['.csv', '.json', '.jsonl'].includes(extname(f).toLowerCase()) && statSync(join(d, f)).isFile()).sort().map((f) => posix.join(String(a.dir).replace(/\\/g, '/'), f))); }
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
  configSchemas: { retention_rules: RETENTION_RULES_SCHEMA },
  prompts: PROMPTS,
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
      inputSchema: { type: 'object', properties: { ...src, ...subj, ...req, ...rulesArg, ...asOf, out_dir: str } },
      handler: async (a, ctx) => {
        const rules = loadRules(a, ctx); const fl = load(a, ctx); const r = findSubject(fl, a);
        const periods = rules?.response_periods || {}; const ret = rules ? applyRetention(fl, r, rules, a.as_of || today()) : null;
        const steps = checklist(r, { ...a, periods }, ret); const out = ctx.outDir(a.out_dir || 'mythos-out/macaria');
        return { summary: `Checklist written: ${steps.length} step(s) across ${r.files_with_data} file(s)${ret ? `; ${ret.on_hold} row(s) on hold, ${ret.retain_until} retained by your rules` : ''}.`, files: [ctx.writeFile(out, 'erasure-checklist.csv', checklistCsv(steps)), ctx.writeFile(out, 'erasure-request.md', requestMarkdown(r, { ...a, periods }, new Date().toISOString()))], due: dueDate(a.received, a.regime, periods) };
      },
    },
    {
      name: 'macaria_retention_check', kind: 'read', title: 'Apply your retention rules and holds',
      description: 'Apply your own retention rules and legal holds (a JSON file) to the subject\'s matched rows. Holds win over rules. Each row gets on_hold, retain_until, period_ended, date_missing or no_rule, with the rule or hold id cited. Identifiers are not echoed. Not legal advice.',
      inputSchema: { type: 'object', required: ['rules'], properties: { ...src, ...subj, ...rulesArg, ...asOf } },
      handler: async (a, ctx) => {
        const rules = loadRules(a, ctx); const fl = load(a, ctx); const f = findSubject(fl, a); const r = applyRetention(fl, f, rules, a.as_of || today());
        return { summary: `${r.rows.length} matched row(s): ${r.on_hold} on hold, ${r.retain_until} retained, ${r.period_ended} period ended, ${r.date_missing} need a date, ${r.no_rule} without a rule.`, subject: f.subject, ...r };
      },
    },
    {
      name: 'macaria_deadlines', kind: 'report', title: 'Request deadline tracker',
      description: 'Read the request log (requests.csv) and compute each request\'s due date from the configured response period (rules file response_periods, else 30 days GDPR / 45 days CCPA). Flags overdue and due-soon requests, writes request-deadlines.csv and, with ics:true, request-deadlines.ics with reminders 7 and 2 days before.',
      inputSchema: { type: 'object', properties: { log: { ...str, description: 'Request log CSV (default <out_dir>/requests.csv)' }, ...rulesArg, ...asOf, due_soon_days: { type: 'integer', minimum: 0, maximum: 120 }, ics: { type: 'boolean' }, out_dir: str } },
      handler: async (a, ctx) => {
        const rules = loadRules(a, ctx); const lp = logPath(a);
        if (!ctx.exists(lp)) throw new Error(`no request log at ${lp}; log a request with macaria_log_request first`);
        const t = trackDeadlines(ctx.records(lp), { periods: rules?.response_periods || {}, dueSoonDays: a.due_soon_days ?? rules?.due_soon_days ?? 7, asOf: a.as_of || today() });
        const out = ctx.outDir(a.out_dir || 'mythos-out/macaria'); const files = [ctx.writeFile(out, 'request-deadlines.csv', deadlinesCsv(t))];
        if (a.ics) files.push(ctx.writeFile(out, 'request-deadlines.ics', deadlinesIcs(t)));
        return { summary: `${t.requests} request(s): ${t.overdue} overdue, ${t.due_soon} due soon, ${t.on_track} on track, ${t.closed} closed.`, ...t, files };
      },
    },
    {
      name: 'macaria_evidence_pack', kind: 'report', title: 'Erasure evidence pack',
      description: 'Write evidence-<request_key>.json and .html for one request: exports searched with SHA-256 hashes, rows found per file and how they matched (never the values), retention decisions with rule ids, approved deletion requests recorded, and open items. The JSON hash is recorded in the audit log (output_sha256). Evidence, not certification.',
      inputSchema: { type: 'object', properties: { ...src, ...subj, ...rulesArg, ...asOf, request_key: { ...str, description: 'Defaults to the key derived from the identifiers given (same as macaria_log_request)' }, log: str, out_dir: str } },
      handler: async (a, ctx) => {
        const rules = loadRules(a, ctx); const fl = load(a, ctx); const f = findSubject(fl, a); const at = a.as_of || today();
        const key = a.request_key || subjectKey(a); const out = a.out_dir || 'mythos-out/macaria';
        const rows = (p) => (ctx.exists(p) ? ctx.records(p) : []);
        const log = rows(logPath(a)).filter((r) => r.request_key === key).pop() || null;
        const deletions = rows(join(out, 'deletion-requests.csv')).filter((r) => r.request_key === key);
        const hashes = Object.fromEntries(fl.map((x) => [x.name, ctx.hashFile(x.name)]));
        const p = evidencePack({ requestKey: key, found: f, retention: rules ? applyRetention(fl, f, rules, at) : null, deletions, log, asOf: at, sourceHashes: hashes });
        const d = ctx.outDir(out);
        return { summary: `Evidence pack for ${key}: ${f.rows_found} row(s) in ${f.files_with_data} file(s), ${deletions.length} approved deletion request(s), ${p.pack.kept.length} kept under rules or holds, ${p.pack.open_items.length} open item(s).`, request_key: key, kept: p.pack.kept, open_items: p.pack.open_items, output_sha256: p.output_sha256,
          files: [ctx.writeFile(d, `evidence-${safeFileName(key)}.json`, p.json), ctx.writeFile(d, `evidence-${safeFileName(key)}.html`, evidenceHtml(p.pack, p.output_sha256))] };
      },
    },
    {
      name: 'macaria_log_request', kind: 'write',
      description: 'Add the request to requests.csv (masked identifier, a hash key, received date, target date). Needs a human yes unless opted in to Auto.',
      inputSchema: { type: 'object', required: ['received'], properties: { ...subj, ...req, ...rulesArg, out_dir: str } },
      handler: async (a, ctx) => {
        if (!a.email && !a.phone && !(a.ids || []).length) throw new Error('give at least one identifier');
        const key = subjectKey(a); const due = dueDate(a.received, a.regime, loadRules(a, ctx)?.response_periods || {});
        return { summary: `Request ${key} logged${due ? `, target ${due}` : ''}.`, request_key: key, file: append(ctx, a, 'requests.csv', { logged_at: new Date().toISOString(), request_key: key, subject: a.email ? maskEmail(a.email) : 'phone/id only', received: a.received, regime: a.regime || '', target_date: due || '', status: 'open' }, ['logged_at', 'request_key', 'subject', 'received', 'regime', 'target_date', 'status']) };
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
    { tool: 'macaria_retention_check', decision: 'allow' },
    { tool: 'macaria_deadlines', decision: 'allow' },
    { tool: 'macaria_evidence_pack', decision: 'allow' },
    { tool: 'macaria_log_request', decision: 'ask', reason: 'Logging a request needs a human yes (or an Auto opt-in).' },
    { tool: 'macaria_delete_records', decision: 'block', reason: 'Macaria never deletes data.' },
    { tool: 'macaria_request_deletion', decision: 'ask', reason: 'Deleting personal data is one named human click, even in Auto.' },
    { tool: '*', decision: 'block', reason: 'Not on the Macaria allowlist.' },
  ] },
});
